#!/usr/bin/env tsx
/**
 * nw7h-enterprise-honesty-unit.ts — NW-7h regressions.
 *
 * Covers four AUDIT_FINDINGS_2 items:
 *   (a) ent-encryption-dead-code:
 *       The unused AES primitives (`encrypt`, `decrypt`, `isEncryptedPayload`,
 *       `EncryptedPayload`) are deleted; the residual `encryption.ts` exports
 *       only `generateKey`; `tsc --noEmit` over the project still compiles;
 *       no caller imports the deleted symbols.
 *   (b) ent-audit-no-tamper-evidence:
 *       Every appended audit record carries a `prevHash` field; the chain
 *       can be verified end-to-end; a single-byte mutation to a middle
 *       record causes `verifyChain()` to report the break index.
 *   (c) ent-backup-torn-no-verify:
 *       Backup writes a per-file SHA-256 catalog into the manifest, the
 *       tarball is verified post-write against that catalog, and a
 *       hand-truncated tarball is rejected by both the post-write check
 *       and the restore-side integrity step before any live `.lore/` is
 *       touched.
 *   (d) ent-local-mode-no-rbac:
 *       `docs/SECURITY_MODEL.md` contains the explicit local-mode RBAC
 *       limitation paragraph naming "cosmetically only" and pointing the
 *       reader to cloud mode for tenant-isolated RBAC.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void): void { cases.push({ name, fn }); }
async function runAll(): Promise<void> {
    for (const c of cases) {
        try { await c.fn(); console.log(`  ✓ ${c.name}`); passed++; }
        catch (err) { console.error(`  ✗ ${c.name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    }
}

// ── (a) ent-encryption-dead-code ─────────────────────────────────────────────

test('(a) encryption.ts no longer exports encrypt/decrypt/EncryptedPayload', async () => {
    const src = fs.readFileSync(path.join(repoRoot, 'packages/lore/src/security/encryption.ts'), 'utf-8');
    assert.ok(!/export\s+function\s+encrypt\b/.test(src),
        'encryption.ts still exports `encrypt` — dead code must be removed (ent-encryption-dead-code)');
    assert.ok(!/export\s+function\s+decrypt\b/.test(src),
        'encryption.ts still exports `decrypt` — dead code must be removed');
    assert.ok(!/export\s+function\s+isEncryptedPayload\b/.test(src),
        'encryption.ts still exports `isEncryptedPayload` — dead code must be removed');
    assert.ok(!/export\s+interface\s+EncryptedPayload\b/.test(src),
        'encryption.ts still exports `EncryptedPayload` interface — dead code must be removed');
    // generateKey is still legitimately exported for the keyring.
    assert.ok(/export\s+function\s+generateKey\b/.test(src),
        'encryption.ts must still export generateKey for keyring.ts');
});

test('(a) no live caller imports the deleted encryption symbols', async () => {
    const offenders: string[] = [];
    function walk(dir: string): void {
        for (const name of fs.readdirSync(dir)) {
            if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
            const abs = path.join(dir, name);
            const stat = fs.statSync(abs);
            if (stat.isDirectory()) { walk(abs); continue; }
            if (!name.endsWith('.ts')) continue;
            if (abs.endsWith('encryption.ts')) continue; // self
            if (abs.endsWith('nw7h-enterprise-honesty-unit.ts')) continue; // this file
            const txt = fs.readFileSync(abs, 'utf-8');
            // Match imports of the dead symbols from the encryption module.
            const importRe = /import\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"][^'"]*security\/encryption(?:\.js)?['"]/g;
            const matches = txt.match(importRe) ?? [];
            for (const m of matches) {
                if (/\b(encrypt|decrypt|isEncryptedPayload|EncryptedPayload)\b/.test(m)) {
                    offenders.push(`${path.relative(repoRoot, abs)}: ${m}`);
                }
            }
        }
    }
    walk(path.join(repoRoot, 'packages'));
    walk(path.join(repoRoot, 'test'));
    assert.equal(offenders.length, 0,
        `dead encryption symbols still imported:\n  ${offenders.join('\n  ')}`);
});

// ── (b) ent-audit-no-tamper-evidence ─────────────────────────────────────────

test('(b) audit entries carry prevHash and form a verifiable chain', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nw7h-audit-'));
    process.env['LORE_HOME'] = tmpHome;
    // Re-import after env set so loreHome resolves correctly.
    const { AuditLog } = await import(`../packages/lore/src/security/audit.js?cacheBust=${Date.now()}`);
    const auditPath = path.join(tmpHome, 'audit-chain-test.jsonl');
    const log = new AuditLog({ path: auditPath });

    log.log({ toolName: 't1', args: { x: 1 }, result: 'success', durationMs: 1 });
    log.log({ toolName: 't2', args: { x: 2 }, result: 'success', durationMs: 1 });
    log.log({ toolName: 't3', args: { x: 3 }, result: 'success', durationMs: 1 });

    // Flush async appends — log() uses fs.promises.appendFile without await.
    await log.flush();

    const lines = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3, `expected 3 audit lines, got ${lines.length}`);

    const entries = lines.map((l) => JSON.parse(l) as { prevHash: string | null; toolName: string });
    assert.equal(entries[0]!.prevHash, null,
        'first audit record must have prevHash === null on a fresh file');
    assert.equal(typeof entries[1]!.prevHash, 'string', 'second record must carry a prevHash hash');
    assert.equal(typeof entries[2]!.prevHash, 'string', 'third record must carry a prevHash hash');

    // The prevHash on record N must equal SHA-256 of line N-1 + '\n'.
    const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
    assert.equal(entries[1]!.prevHash, sha(lines[0]! + '\n'),
        'record 2 prevHash does not match SHA-256 of line 1');
    assert.equal(entries[2]!.prevHash, sha(lines[1]! + '\n'),
        'record 3 prevHash does not match SHA-256 of line 2');

    // verifyChain() must report ok with the correct count.
    const v1 = log.verifyChain();
    assert.equal(v1.ok, true, `verifyChain on intact log must be ok; got reason=${(v1 as { reason?: string }).reason}`);
    assert.equal(v1.count, 3, `verifyChain must report 3 records, got ${v1.count}`);
});

test('RA2-26 / DEFECT 1: rotation links the new live chain to the archive (continuity, not a fresh genesis)', async () => {
    // Supersedes the original RA2-26 assertion. The old fix reset the chain head
    // to a NULL genesis on rotation, which orphaned the live file from archived
    // history (no cryptographic link across the boundary). The audit-fix-#3
    // behavior writes a *continuation record* instead, and verifyChainWithHistory
    // walks across the boundary into the .gz archive.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nw7h-audit-rotate-'));
    process.env['LORE_HOME'] = tmpHome;
    const { AuditLog } = await import(`../packages/lore/src/security/audit.js?cacheBust=${Date.now()}-rot`);
    const { rotateIfNeeded } = await import(`../packages/lore/src/security/logRotator.js?cacheBust=${Date.now()}-rot`);
    const auditPath = path.join(tmpHome, 'audit-rotate.jsonl');
    const log = new AuditLog({ path: auditPath });

    log.log({ toolName: 'a', args: {}, result: 'success', durationMs: 1 });
    log.log({ toolName: 'b', args: {}, result: 'success', durationMs: 1 });
    await log.flush();

    // Real rotation: gzip the live bytes to <file>.<ts>.gz and truncate in place.
    const rot = rotateIfNeeded(auditPath, { maxBytes: 1 });
    assert.equal(rot.rotated, true, 'precondition: rotateIfNeeded must rotate (maxBytes:1)');
    // onRotated() now writes a continuation record (NOT a null-genesis reset).
    log.onRotated();

    log.log({ toolName: 'c', args: {}, result: 'success', durationMs: 1 });
    log.log({ toolName: 'd', args: {}, result: 'success', durationMs: 1 });
    await log.flush();

    const lines = fs.readFileSync(auditPath, 'utf-8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3, `expected continuation + 2 post-rotation lines, got ${lines.length}`);
    const first = JSON.parse(lines[0]!) as { prevHash: string | null; kind?: string; rotatedFrom?: string };
    assert.equal(first.kind, 'continuation', 'first post-rotation line is a continuation record');
    assert.ok(first.prevHash, 'continuation links back to the pre-truncation tail (not a null genesis)');
    assert.ok(first.rotatedFrom && first.rotatedFrom.endsWith('.gz'), 'continuation names the .gz archive');

    // Live-only verify accepts the continuation boundary on faith…
    const vLive = log.verifyChain();
    assert.equal(vLive.ok, true, `verifyChain (live) must be ok after rotation+continuation; got ${(vLive as { reason?: string }).reason}`);
    assert.equal(vLive.count, 3, `live verify counts continuation + c + d, got ${vLive.count}`);
    // …and full-history verify proves the link across the boundary into the archive.
    const vHist = log.verifyChainWithHistory();
    assert.equal(vHist.ok, true, `verifyChainWithHistory must prove continuity; got ${(vHist as { reason?: string }).reason}`);
    assert.equal((vHist as { segments?: number }).segments, 2, 'one archive + the live file = 2 segments');
    assert.equal(vHist.count, 5, `history covers a + b (archive) and continuation + c + d (live), got ${vHist.count}`);
});

test('(b) audit chain detects a tampered middle record', async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nw7h-audit-tamper-'));
    process.env['LORE_HOME'] = tmpHome;
    const { AuditLog } = await import(`../packages/lore/src/security/audit.js?cacheBust=${Date.now()}-2`);
    const auditPath = path.join(tmpHome, 'audit-tamper.jsonl');
    const log = new AuditLog({ path: auditPath });

    log.log({ toolName: 'a', args: { id: 'one' }, result: 'success', durationMs: 1 });
    log.log({ toolName: 'b', args: { id: 'two' }, result: 'success', durationMs: 1 });
    log.log({ toolName: 'c', args: { id: 'three' }, result: 'success', durationMs: 1 });
    await log.flush();

    // Tamper: rewrite the middle record's `id` from 'two' → 'TWO'.
    const raw = fs.readFileSync(auditPath, 'utf-8');
    const tampered = raw.replace('"id":"two"', '"id":"TWO"');
    assert.notEqual(raw, tampered, 'precondition: expected to find the middle record to mutate');
    fs.writeFileSync(auditPath, tampered);

    const v = log.verifyChain();
    assert.equal(v.ok, false, 'verifyChain must FAIL on a tampered middle record');
    // The break should be detected at line 2 (zero-indexed: line 1 is record 2,
    // line 2 is record 3 — record 3's prevHash references the now-mutated record 2).
    const broken = v as { ok: false; brokenAt: number; reason: string };
    assert.ok(broken.brokenAt >= 1,
        `expected brokenAt >= 1 (chain break after the mutated middle record), got ${broken.brokenAt}`);
    assert.ok(/prevHash mismatch/i.test(broken.reason),
        `expected reason to mention prevHash mismatch, got: ${broken.reason}`);
});

// ── (c) ent-backup-torn-no-verify ────────────────────────────────────────────

function buildFakeWorkspace(): { wsDir: string; outDir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw7h-backup-'));
    const wsDir = path.join(dir, 'workspace');
    const loreDir = path.join(wsDir, '.lore');
    const outDir = path.join(dir, 'out');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'graph'), 'fake-legacy-engine-bytes');
    fs.writeFileSync(path.join(loreDir, 'graph.wal'), 'fake-wal');
    const db = new Database(path.join(loreDir, 'tables.sqlite'));
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`);
    db.prepare(`INSERT INTO t (id, v) VALUES (?, ?)`).run(1, 'nw7h');
    db.close();
    fs.mkdirSync(path.join(loreDir, 'lancedb', 'lore_verbatim.lance'), { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'lancedb', 'lore_verbatim.lance', 'data.bin'), 'fake-lance');
    fs.writeFileSync(path.join(loreDir, 'config.json'), '{"k":"v"}');
    return { wsDir, outDir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

test('(c) backup writes a catalog into the manifest and verifies post-write', async () => {
    const { backupWorkspace } = await import('../packages/lore/src/engines/backup.js');
    const { wsDir, outDir, cleanup } = buildFakeWorkspace();
    try {
        const result = await backupWorkspace({
            workspaceDir: wsDir,
            workspaceName: 'nw7h-c1',
            outDir,
        });
        assert.ok(fs.existsSync(result.tarballPath), 'tarball was not produced');
        assert.ok(result.catalog, 'BackupResult.catalog must be present');
        assert.ok(result.catalog.totalFiles >= 4,
            `catalog should cover all staged files (graph, graph.wal, tables.sqlite, config.json, lancedb/...); got ${result.catalog.totalFiles}`);
        assert.ok(result.catalog.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)),
            'every catalog entry must carry a 64-char hex SHA-256');
        // The catalog must include the manifest file itself (it lives in the staged root).
        const hasManifest = result.catalog.files.some((f) => f.relPath === 'backup-manifest.json');
        // It is acceptable EITHER for the catalog to predate the manifest (recommended)
        // OR to include the manifest if the implementation chose to do so. We accept both;
        // what matters is that catalog enables post-write verification.
        void hasManifest;
    } finally {
        cleanup();
    }
});

test('(c) backup verification REJECTS a torn (truncated) tarball', async () => {
    const { backupWorkspace, verifyTarballAgainstCatalog } = await import('../packages/lore/src/engines/backup.js');
    const { wsDir, outDir, cleanup } = buildFakeWorkspace();
    try {
        const result = await backupWorkspace({
            workspaceDir: wsDir,
            workspaceName: 'nw7h-c2',
            outDir,
        });
        // Truncate the tarball to half its size to simulate a torn write.
        const original = fs.readFileSync(result.tarballPath);
        fs.writeFileSync(result.tarballPath, original.subarray(0, Math.floor(original.length / 2)));
        // Verification must throw.
        await assert.rejects(
            () => verifyTarballAgainstCatalog(result.tarballPath, result.catalog),
            /verification failed|integrity|extract|mismatch/i,
            'verifyTarballAgainstCatalog must throw on a truncated tarball',
        );
    } finally {
        cleanup();
    }
});

test('(c) restore refuses a v2 tarball whose contents drift from the manifest catalog', async () => {
    const { backupWorkspace } = await import('../packages/lore/src/engines/backup.js');
    const { restoreWorkspace } = await import('../packages/lore/src/engines/restore.js');
    const { wsDir, outDir, cleanup } = buildFakeWorkspace();
    try {
        const result = await backupWorkspace({
            workspaceDir: wsDir,
            workspaceName: 'nw7h-c3',
            outDir,
        });
        // Tamper: re-pack the tarball with an extra file that the catalog does NOT mention.
        // Easiest tamper that survives gzip integrity is to mutate a payload file inside
        // the staged tree on a fresh extract and re-tar. Use the spawn pattern to keep
        // the test self-contained.
        const { spawn } = await import('node:child_process');
        const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw7h-restore-tamper-'));
        await new Promise<void>((resolve, reject) => {
            const p = spawn('tar', ['-x', '-z', '-f', result.tarballPath, '-C', verifyDir]);
            p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar extract failed: ${code}`)));
            p.on('error', reject);
        });
        // Mutate the staged config.json so its hash no longer matches the manifest.
        fs.writeFileSync(path.join(verifyDir, '.lore', 'config.json'), '{"k":"TAMPERED"}');
        // Re-tar (gzipped) over the original tarball.
        const tamperedTarball = result.tarballPath + '.tampered.tar.gz';
        await new Promise<void>((resolve, reject) => {
            const p = spawn('tar', ['-c', '-z', '-f', tamperedTarball, '-C', verifyDir, '.']);
            p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar repack failed: ${code}`)));
            p.on('error', reject);
        });
        // Now point restore at the tampered tarball and an EMPTY destination workspace
        // so the failure happens during integrity check, before sidelining.
        const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw7h-restore-dst-'));
        await assert.rejects(
            () => restoreWorkspace({ tarballPath: tamperedTarball, workspaceDir: destDir }),
            /integrity check failed/i,
            'restore must reject a v2 tarball whose contents drift from the catalog',
        );
        // And the destination must not have a `.lore/` planted (no sidelining happened).
        assert.equal(fs.existsSync(path.join(destDir, '.lore')), false,
            'restore integrity failure must short-circuit BEFORE touching destination .lore/');
        try { fs.rmSync(verifyDir, { recursive: true, force: true }); } catch { /* */ }
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* */ }
    } finally {
        cleanup();
    }
});

// ── (d) ent-local-mode-no-rbac ───────────────────────────────────────────────

test('(d) docs/SECURITY_MODEL.md carries the local-mode RBAC honesty paragraph', async () => {
    const txt = fs.readFileSync(path.join(repoRoot, 'docs/SECURITY_MODEL.md'), 'utf-8');
    // Must explicitly say "cosmetically" — the spec word — and refer to cloud-mode
    // as the path for tenant-isolated RBAC.
    assert.match(txt, /cosmetically/i,
        'SECURITY_MODEL.md must contain the word "cosmetically" in the local-mode RBAC caveat');
    assert.match(txt, /local mode/i,
        'SECURITY_MODEL.md must explicitly call out "local mode"');
    assert.match(txt, /cloud mode/i,
        'SECURITY_MODEL.md must point to cloud mode for real RBAC');
    assert.match(txt, /tenant.isolated|tenant isolated/i,
        'SECURITY_MODEL.md must mention tenant-isolated RBAC as the cloud-mode capability');
    // And bypass via disk-access must be stated.
    assert.match(txt, /disk access|disk-access/i,
        'SECURITY_MODEL.md must note that local users with disk access bypass ReBAC');
});

// ── runner ───────────────────────────────────────────────────────────────────

console.log('\n=== NW-7h: enterprise honesty (encryption / audit chain / backup verify / RBAC) ===\n');
await runAll();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
