#!/usr/bin/env tsx
/**
 * audit-rotation-lock-unit.ts — audit-log rotation must run under the writer's lock and never overwrite archives.
 *
 *   1. rotateExclusive: appends issued before / during a rotation are not lost; the continuation's prevHash is the
 *      hash of the last line in the archive; verifyChainWithHistory() passes.
 *   2. Two rotations in the same millisecond produce distinct archives (`<ts>.gz`, `<ts>-1.gz`, `<ts>-2.gz`);
 *      listArchives() returns them in creation order even when mtimes tie; history verifies.
 *   3. Retention sweep with tied mtimes deletes the oldest by the shared ordering (numeric suffix, not lexical).
 *   4. Plain onRotated() (legacy call pattern) still works.
 *   5. rotateExclusive is a no-op (no continuation) when nothing rotates, and swallows a throwing rotate().
 *
 * Temp dirs only. Run: npm run test:unit:audit-rotation-lock
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as crypto from 'node:crypto';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-rotation-lock-'));
process.env['LORE_HOME'] = sandbox;
process.env['HOME'] = sandbox;

const { AuditLog } = await import('../packages/lore/src/security/audit.js');
const { rotateIfNeeded } = await import('../packages/lore/src/security/logRotator.js');
const { listArchives } = await import('../packages/lore/src/security/auditChain.js');

let passed = 0, failed = 0;
const cases: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void): void { cases.push({ name, fn }); }

const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
let seq = 0;
function freshLog(): { log: InstanceType<typeof AuditLog>; auditPath: string; dir: string } {
    const dir = fs.mkdtempSync(path.join(sandbox, `case${seq++}-`));
    const auditPath = path.join(dir, 'audit.jsonl');
    return { log: new AuditLog({ path: auditPath }), auditPath, dir };
}
const w = (log: InstanceType<typeof AuditLog>, name: string): void =>
    log.log({ toolName: name, args: {}, result: 'success', durationMs: 1 });
const lines = (p: string): string[] => fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
const gunzipLines = (p: string): string[] => zlib.gunzipSync(fs.readFileSync(p)).toString('utf-8').split('\n').filter(Boolean);
/** Every tool name across all archives (oldest first) then the live file. */
function allToolNames(log: InstanceType<typeof AuditLog>): string[] {
    const files = [...listArchives(log.filePath).map(gunzipLines), lines(log.filePath)];
    return files.flat().map((l) => (JSON.parse(l) as { toolName: string }).toolName);
}

test('1. rotateExclusive: appends before and during a rotation are all kept and the chain verifies', async () => {
    const { log, auditPath } = freshLog();
    for (let i = 0; i < 20; i++) w(log, `pre-${i}`);          // queued async appends, NOT flushed
    const rotation = log.rotateExclusive(() => { rotateIfNeeded(auditPath, { maxBytes: 1 }); });
    for (let i = 0; i < 5; i++) w(log, `during-${i}`);        // gate is open: parked, replayed after the section
    await rotation;
    for (let i = 0; i < 3; i++) w(log, `post-${i}`);
    await log.flush();

    const archives = listArchives(auditPath);
    assert.equal(archives.length, 1, 'exactly one archive');
    const archived = gunzipLines(archives[0]!);
    assert.equal(archived.length, 20, 'every pre-rotation append landed in the archive (none lost between read and truncate)');

    const live = lines(auditPath);
    const first = JSON.parse(live[0]!) as { kind?: string; prevHash: string; rotatedFrom?: string };
    assert.equal(first.kind, 'continuation', 'live file starts with a continuation record');
    assert.equal(first.prevHash, sha(archived[archived.length - 1]! + '\n'), 'continuation prevHash = hash of the last archived line');
    assert.equal(first.rotatedFrom, path.basename(archives[0]!));

    const names = allToolNames(log).filter((n) => !n.startsWith('audit:'));
    assert.deepEqual(names, [
        ...Array.from({ length: 20 }, (_, i) => `pre-${i}`),
        ...Array.from({ length: 5 }, (_, i) => `during-${i}`),
        ...Array.from({ length: 3 }, (_, i) => `post-${i}`),
    ], 'all 28 entries present, in order');
    const v = log.verifyChainWithHistory();
    assert.equal(v.ok, true, `history must verify: ${JSON.stringify(v)}`);
});

test('2. two rotations in the same millisecond never overwrite an archive; creation order is deterministic', async () => {
    const { log, auditPath } = freshLog();
    const fixed = new Date('2026-10-25T12:00:00.123Z');
    const now = () => fixed;
    const archives: string[] = [];
    for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 4; i++) w(log, `r${round}-${i}`);
        await log.rotateExclusive(() => { rotateIfNeeded(auditPath, { maxBytes: 1, now }); });
        // Force identical mtimes so only the name can order them.
        for (const a of listArchives(auditPath)) fs.utimesSync(a, 1_800_000_000, 1_800_000_000);
    }
    w(log, 'tail');
    await log.flush();

    const names = fs.readdirSync(path.dirname(auditPath)).filter((f) => f.endsWith('.gz')).sort();
    assert.deepEqual(names, [
        'audit.jsonl.2026-10-25T12-00-00-123Z-1.gz',
        'audit.jsonl.2026-10-25T12-00-00-123Z-2.gz',
        'audit.jsonl.2026-10-25T12-00-00-123Z.gz',
    ], 'three distinct archives');
    const ordered = listArchives(auditPath).map((p) => path.basename(p).replace('audit.jsonl.2026-10-25T12-00-00-123Z', '').replace('.gz', ''));
    assert.deepEqual(ordered, ['', '-1', '-2'], 'creation order despite tied mtimes (and lexical order being wrong)');
    archives.push(...listArchives(auditPath));
    assert.ok(gunzipLines(archives[0]!).some((l) => l.includes('"r0-0"')), 'first archive still holds round 0');
    assert.ok(gunzipLines(archives[1]!).some((l) => l.includes('"r1-0"')), 'second archive holds round 1');
    assert.ok(gunzipLines(archives[2]!).some((l) => l.includes('"r2-0"')), 'third archive holds round 2');
    const v = log.verifyChainWithHistory();
    assert.equal(v.ok, true, `history must verify: ${JSON.stringify(v)}`);
});

test('3. retention sweep with tied mtimes deletes the oldest by the shared ordering', () => {
    const dir = fs.mkdtempSync(path.join(sandbox, `retain-${seq++}-`));
    const file = path.join(dir, 'x.log');
    fs.writeFileSync(file, 'payload payload payload');
    const ts = '2026-10-25T12-00-00-123Z';
    const seeded = [`x.log.${ts}.gz`, `x.log.${ts}-1.gz`, `x.log.${ts}-2.gz`, `x.log.${ts}-10.gz`];
    for (const n of seeded) {
        fs.writeFileSync(path.join(dir, n), zlib.gzipSync('old'));
        fs.utimesSync(path.join(dir, n), 1_700_000_000, 1_700_000_000);
    }
    const r = rotateIfNeeded(file, { maxBytes: 1, retainCount: 3, now: () => new Date('2026-10-25T12:00:00.123Z') });
    assert.equal(r.rotated, true);
    assert.ok(r.rotatedTo!.endsWith(`${ts}-3.gz`), `new archive takes the first free suffix, got ${r.rotatedTo}`);
    assert.equal(r.deleted, 2);
    const left = fs.readdirSync(dir).filter((f) => f.endsWith('.gz')).sort();
    // Oldest by (mtime, ts, numeric suffix) = base and -1; lexical order would have wrongly dropped -1 and -10.
    assert.deepEqual(left, [`x.log.${ts}-10.gz`, `x.log.${ts}-2.gz`, `x.log.${ts}-3.gz`]);
});

test('4. plain onRotated() keeps working (legacy call pattern)', async () => {
    const { log, auditPath } = freshLog();
    for (let i = 0; i < 5; i++) w(log, `e${i}`);
    await log.flush();
    assert.equal(rotateIfNeeded(auditPath, { maxBytes: 1 }).rotated, true);
    log.onRotated();
    w(log, 'after');
    await log.flush();
    const live = lines(auditPath);
    assert.equal((JSON.parse(live[0]!) as { kind?: string }).kind, 'continuation');
    assert.equal(live.length, 2);
    const v = log.verifyChainWithHistory();
    assert.equal(v.ok, true, `history must verify: ${JSON.stringify(v)}`);
});

test('5. rotateExclusive writes no continuation when nothing rotates, and swallows a throwing rotate()', async () => {
    const { log, auditPath } = freshLog();
    w(log, 'only');
    await log.rotateExclusive(() => { rotateIfNeeded(auditPath); }); // below thresholds
    assert.equal(listArchives(auditPath).length, 0);
    assert.equal(lines(auditPath).length, 1, 'no continuation appended');
    const errs: string[] = [];
    const orig = console.error; console.error = (m: unknown) => { errs.push(String(m)); };
    try { await log.rotateExclusive(() => { throw new Error('boom'); }); } finally { console.error = orig; }
    assert.ok(errs.some((e) => e.includes('boom')), 'failure is logged, not thrown');
    w(log, 'still-works');
    await log.flush();
    assert.equal(lines(auditPath).length, 2, 'writer ungated after the failure');
    assert.equal(log.verifyChainWithHistory().ok, true);
});

console.log('\n=== Audit rotation lock + archive collision ===\n');
for (const c of cases) {
    try { await c.fn(); console.log(`  ✓ ${c.name}`); passed++; }
    catch (err) { console.error(`  ✗ ${c.name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
fs.rmSync(sandbox, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
