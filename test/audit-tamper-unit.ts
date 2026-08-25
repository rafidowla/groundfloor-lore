#!/usr/bin/env tsx
/**
 * audit-tamper-unit.ts — Audit log tamper-evidence (launch audit finding #3).
 *
 * Pins the two defects closed by audit fix #3 (see
 * docs/audit/FINDINGS-2026-06-27-tamper-proofing.md):
 *
 *   DEFECT 1 — rotation continuity:
 *     A1 rotation writes a continuation record linking the new live file to the
 *         .gz archive; verifyChainWithHistory() walks across the boundary.
 *     A2 a byte mutated INSIDE the archive is detected by the history verifier.
 *     A3 a forged continuation link (wrong prevHash) is detected.
 *
 *   DEFECT 2 — genesis anchor / whole-rewrite / truncation:
 *     B1 a whole-file rewrite (fresh internally-consistent chain, no/forged
 *         anchorHash) is DETECTED by verifyChain().
 *     B2 a legacy (pre-anchor) file still verifies ok with a legacy_genesis note
 *         — no false alarm (backward compat, HARD CONSTRAINT #1).
 *     B3 a naive middle edit is still detected (regression — keep NW-7h's
 *         guarantee).
 *     B4 truncate-to-zero does NOT silently start a fresh unanchored chain:
 *         (i) an anchored-but-empty file is flagged; (ii) onRotated() with no
 *         matching archive refuses to reset to a null genesis, so the next
 *         record dangles and verifyChain() surfaces the break.
 *
 * Run: npm run test:unit:audit-tamper
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';

let passed = 0, failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void): void { cases.push({ name, fn }); }

const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf-8').digest('hex');

/** Each case gets its own LORE_HOME + AuditLog module instance (cacheBust). */
async function freshLog(prefix: string): Promise<{
    AuditLog: any;
    rotateIfNeeded: any;
    auditPath: string;
    home: string;
}> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.env['LORE_HOME'] = home;
    const bust = `${Date.now()}-${Math.round(passed + failed)}-${prefix}`;
    const { AuditLog } = await import(`../packages/lore/src/security/audit.js?cb=${bust}`);
    const { rotateIfNeeded } = await import(`../packages/lore/src/security/logRotator.js?cb=${bust}`);
    return { AuditLog, rotateIfNeeded, auditPath: path.join(home, 'audit.jsonl'), home };
}

function readLines(p: string): string[] {
    return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
}

// ── DEFECT 1 — rotation continuity ───────────────────────────────────────────

test('A1 rotation writes a continuation record; verifyChainWithHistory walks the boundary', async () => {
    const { AuditLog, rotateIfNeeded, auditPath } = await freshLog('audit-tamper-a1-');
    const log = new AuditLog({ path: auditPath });
    log.log({ toolName: 'a', args: {}, result: 'success', durationMs: 1 });
    log.log({ toolName: 'b', args: {}, result: 'success', durationMs: 1 });
    await log.flush();

    const rot = rotateIfNeeded(auditPath, { maxBytes: 1 });
    assert.equal(rot.rotated, true, 'precondition: rotateIfNeeded must rotate');
    log.onRotated();
    log.log({ toolName: 'c', args: {}, result: 'success', durationMs: 1 });
    await log.flush();

    const lines = readLines(auditPath);
    const first = JSON.parse(lines[0]!);
    assert.equal(first.kind, 'continuation', 'first live line is a continuation record');
    assert.ok(first.rotatedFrom?.endsWith('.gz'), 'continuation points at the .gz archive');

    const vHist = log.verifyChainWithHistory();
    assert.equal(vHist.ok, true, `history must verify; got ${vHist.reason ?? ''}`);
    assert.equal(vHist.segments, 2, 'archive + live = 2 segments');
});

test('A2 a byte mutated inside the .gz archive is DETECTED by verifyChainWithHistory', async () => {
    const { AuditLog, rotateIfNeeded, auditPath } = await freshLog('audit-tamper-a2-');
    const log = new AuditLog({ path: auditPath });
    log.log({ toolName: 'a', args: {}, result: 'success', durationMs: 1 });
    log.log({ toolName: 'keep-me', args: {}, result: 'success', durationMs: 1 });
    await log.flush();
    rotateIfNeeded(auditPath, { maxBytes: 1 });
    log.onRotated();
    log.log({ toolName: 'c', args: {}, result: 'success', durationMs: 1 });
    await log.flush();

    // Clean history verifies first.
    assert.equal(log.verifyChainWithHistory().ok, true, 'sanity: clean history verifies');

    // Mutate the archive: flip the second archived record's toolName.
    const dir = path.dirname(auditPath);
    const gz = fs.readdirSync(dir).find((f) => f.endsWith('.gz'))!;
    const gzPath = path.join(dir, gz);
    const text = zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf-8');
    const mutated = text.replace('keep-me', 'TAMPERED');
    assert.notEqual(text, mutated, 'precondition: found the archived record to mutate');
    fs.writeFileSync(gzPath, zlib.gzipSync(Buffer.from(mutated, 'utf-8')));

    const v = log.verifyChainWithHistory();
    assert.equal(v.ok, false, 'history verify must FAIL on an archive mutation');
    assert.ok(/mismatch|continuity/i.test(v.reason), `reason should name the break; got: ${v.reason}`);
});

test('A3 a forged continuation link (wrong prevHash) is DETECTED', async () => {
    const { AuditLog, rotateIfNeeded, auditPath } = await freshLog('audit-tamper-a3-');
    const log = new AuditLog({ path: auditPath });
    log.log({ toolName: 'a', args: {}, result: 'success', durationMs: 1 });
    log.log({ toolName: 'b', args: {}, result: 'success', durationMs: 1 });
    await log.flush();
    rotateIfNeeded(auditPath, { maxBytes: 1 });
    log.onRotated();
    log.log({ toolName: 'c', args: {}, result: 'success', durationMs: 1 });
    await log.flush();

    // Rewrite the live file's continuation record with a bogus prevHash.
    const lines = readLines(auditPath);
    const cont = JSON.parse(lines[0]!);
    cont.prevHash = sha('not-the-real-tail');
    lines[0] = JSON.stringify(cont);
    fs.writeFileSync(auditPath, lines.join('\n') + '\n');

    const v = log.verifyChainWithHistory();
    assert.equal(v.ok, false, 'forged continuation link must FAIL history verify');
    assert.ok(/continuity broken/i.test(v.reason), `reason should mention continuity; got: ${v.reason}`);
});

// ── DEFECT 2 — genesis anchor / rewrite / truncation ─────────────────────────

test('B1 a whole-file rewrite (forged/absent anchorHash) is DETECTED by verifyChain', async () => {
    const { AuditLog, auditPath } = await freshLog('audit-tamper-b1-');
    const log = new AuditLog({ path: auditPath });
    log.log({ toolName: 'a', args: { x: 1 }, result: 'success', durationMs: 1 });
    log.log({ toolName: 'b', args: { x: 2 }, result: 'success', durationMs: 1 });
    log.log({ toolName: 'c', args: { x: 3 }, result: 'success', durationMs: 1 });
    await log.flush();
    assert.equal(log.verifyChain().ok, true, 'sanity: anchored chain verifies');

    // Attacker rewrites the ENTIRE live file with an internally-consistent chain
    // whose genesis carries prevHash:null but NO anchorHash (doesn't know the
    // scheme / can't reproduce the anchor tie).
    const mk = (toolName: string, prevHash: string | null) =>
        JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', actor: { id: 'evil', roles: [] }, toolName, args: {}, result: 'success', durationMs: 0, prevHash });
    const f0 = mk('forged-0', null);
    const f1 = mk('forged-1', sha(f0 + '\n'));
    fs.writeFileSync(auditPath, f0 + '\n' + f1 + '\n');

    const v = log.verifyChain();
    assert.equal(v.ok, false, 'whole-file rewrite must be detected once the anchor exists');
    assert.ok(/anchor/i.test(v.reason), `reason should mention the anchor tie; got: ${v.reason}`);

    // Even a rewrite that copies a WRONG anchorHash is rejected.
    const g0 = JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', actor: { id: 'evil', roles: [] }, toolName: 'forged', args: {}, result: 'success', durationMs: 0, prevHash: null, anchorHash: sha('wrong-anchor') });
    fs.writeFileSync(auditPath, g0 + '\n');
    const v2 = log.verifyChain();
    assert.equal(v2.ok, false, 'forged anchorHash must still be detected');
});

test('B2 a legacy (pre-anchor) file verifies ok with a legacy_genesis note (backward compat)', async () => {
    const { AuditLog, auditPath } = await freshLog('audit-tamper-b2-');
    // Hand-craft a genuine pre-fix file: null-genesis prevHash chain, NO
    // anchorHash field, and NO .anchor sidecar.
    const mk = (toolName: string, prevHash: string | null) =>
        JSON.stringify({ timestamp: '2020-01-01T00:00:00.000Z', actor: { id: 'legacy', roles: [] }, toolName, args: {}, result: 'success', durationMs: 1, prevHash });
    const e0 = mk('t0', null);
    const e1 = mk('t1', sha(e0 + '\n'));
    const e2 = mk('t2', sha(e1 + '\n'));
    fs.writeFileSync(auditPath, e0 + '\n' + e1 + '\n' + e2 + '\n');
    assert.equal(fs.existsSync(auditPath + '.anchor'), false, 'precondition: no anchor sidecar (legacy)');

    const log = new AuditLog({ path: auditPath });
    const v = log.verifyChain();
    assert.equal(v.ok, true, `legacy file must still verify; got ${v.reason ?? ''}`);
    assert.equal(v.count, 3, 'all three legacy records counted');
    assert.equal(v.note, 'legacy_genesis', 'flagged as a legacy genesis, not anchored');
});

test('B3 a naive middle edit is still detected (regression)', async () => {
    const { AuditLog, auditPath } = await freshLog('audit-tamper-b3-');
    const log = new AuditLog({ path: auditPath });
    log.log({ toolName: 'a', args: { id: 'one' }, result: 'success', durationMs: 1 });
    log.log({ toolName: 'b', args: { id: 'two' }, result: 'success', durationMs: 1 });
    log.log({ toolName: 'c', args: { id: 'three' }, result: 'success', durationMs: 1 });
    await log.flush();

    const raw = fs.readFileSync(auditPath, 'utf-8');
    fs.writeFileSync(auditPath, raw.replace('"id":"two"', '"id":"TWO"'));

    const v = log.verifyChain();
    assert.equal(v.ok, false, 'middle edit must be detected');
    assert.ok(v.brokenAt >= 1, `break should be after the mutated record; got ${v.brokenAt}`);
    assert.ok(/prevHash mismatch/i.test(v.reason), `reason should mention prevHash mismatch; got: ${v.reason}`);
});

test('B4 truncate-to-zero does NOT silently start a fresh unanchored chain', async () => {
    const { AuditLog, auditPath } = await freshLog('audit-tamper-b4-');
    const log = new AuditLog({ path: auditPath });
    log.log({ toolName: 'a', args: {}, result: 'success', durationMs: 1 });
    log.log({ toolName: 'b', args: {}, result: 'success', durationMs: 1 });
    await log.flush();
    assert.ok(fs.existsSync(auditPath + '.anchor'), 'precondition: anchor was minted on first write');

    // (i) Out-of-band truncate-to-zero: anchored-but-empty file is flagged.
    fs.truncateSync(auditPath, 0);
    const vEmpty = log.verifyChain();
    assert.equal(vEmpty.ok, false, 'anchored-but-empty file must be flagged');
    assert.ok(/empty|truncat/i.test(vEmpty.reason), `reason should mention truncation; got: ${vEmpty.reason}`);

    // (ii) onRotated() with NO matching archive must refuse to reset to a null
    // genesis — the next record then dangles and verifyChain surfaces the break.
    log.onRotated(); // no .gz archive exists → must be a no-op (keeps lastHash)
    log.log({ toolName: 'c-after-attack', args: {}, result: 'success', durationMs: 1 });
    await log.flush();
    const vAfter = log.verifyChain();
    assert.equal(vAfter.ok, false, 'post-truncation write must NOT produce a clean fresh chain');
});

// ── runner ───────────────────────────────────────────────────────────────────

console.log('\n=== Audit fix #3: tamper-evidence (rotation continuity + genesis anchor) ===\n');
for (const c of cases) {
    try { await c.fn(); console.log(`  ✓ ${c.name}`); passed++; }
    catch (err) { console.error(`  ✗ ${c.name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
