#!/usr/bin/env tsx
/**
 * workspace-erase-audit-unit.ts — the `audit-log` erase step: a deleted workspace's audit entries are blanked
 * (live file + rotated archives), the hash chain stays verifiable, and tampering with a blanked line is still caught.
 *
 * Proves: content gone but time / action / outcome kept; neighbours byte-identical; marker present; verifier accepts the
 * blanked history and rejects forged / altered / unvouched blanked lines; archives keep their mtime; matching by id and by
 * name-within-lifetime; name reuse is ambiguous (left alone, step unverifiable); concurrent appends are not lost;
 * rewrite failure and foreign-writer drift leave the file intact and are retried; a crash before the marker is recovered.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { readDeletionLog } from '../packages/lore/src/config/deletedWorkspaces.js';
import { AuditLog, type AuditEntry } from '../packages/lore/src/security/audit.js';
import { listArchives, verifyChainWithHistory, verifyLiveChain } from '../packages/lore/src/security/auditChain.js';
import { rotateIfNeeded } from '../packages/lore/src/security/logRotator.js';
import { createAuditEraser } from '../packages/lore/src/engines/workspaceErase/auditEraser.js';
import { deleteWorkspaceWithLifecycle, targetFromRecord, type LifecycleDeps } from '../packages/lore/src/engines/workspaceErase/lifecycle.js';
import { eraseNow } from '../packages/lore/src/engines/workspaceErase/tick.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const homes: string[] = [];
const mkHome = (): string => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'au-')); homes.push(h); loadWorkspaces(h); return h; };
const base = (home: string): LifecycleDeps => ({ home, env: {}, eraserFactory: { keyringEnabled: false }, lock: { staleMs: 60_000, heartbeatMs: 5_000 } });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const audit = (h: string): string => path.join(h, 'audit.jsonl');
const ev = (log: AuditLog, tool: string, args: Record<string, unknown>, result: AuditEntry['result'] = 'success'): void =>
    log.log({ toolName: tool, args, result, durationMs: 3 });
const parse = (text: string): AuditEntry[] => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditEntry);
const liveEntries = (h: string): AuditEntry[] => parse(fs.readFileSync(audit(h), 'utf8'));
const allText = (h: string): string => [...listArchives(audit(h)).map((a) => zlib.gunzipSync(fs.readFileSync(a)).toString('utf8')), fs.readFileSync(audit(h), 'utf8')].join('');
const storeOf = (h: string, id: string) => readDeletionLog(h).byId.get(id)!.completedErase!.stores.find((s) => s.store === 'audit-log')!;
const eraserFor = (h: string, id: string, extra: Parameters<typeof createAuditEraser>[0] extends infer D ? Partial<D> : never = {}) =>
    createAuditEraser({ home: h, ...extra }).erase(targetFromRecord(readDeletionLog(h).byId.get(id)!.deletion!));

console.log('workspace erase: audit log blank-out');
try {
    await test('blanks the deleted workspace only; keeps time/action/outcome; chain verifies; marker appended', async () => {
        const h = mkHome(); const d = base(h);
        const log = new AuditLog({ path: audit(h) });
        createWorkspace('gone', undefined, h); createWorkspace('keep', undefined, h);
        const gid = loadWorkspaces(h).workspaces.find((w) => w.name === 'gone')!.id!;
        await sleep(5);
        ev(log, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-gone-1' });          // first record = anchored genesis
        ev(log, 'memory.store', { workspace: 'keep', content: 'TOPSECRET-keep-1' });
        ev(log, 'memory.recall', { workspace: 'gone', query: 'TOPSECRET-gone-2' }, 'error');
        ev(log, 'workspaces.create', { name: 'gone', template: 'TOPSECRET-gone-3' });
        ev(log, 'retention.sweep', { note: 'no workspace attribution' });
        ev(log, 'node.read', { nodeId: `n-${gid}-x`, content: 'TOPSECRET-gone-4' });          // matched by permanent id, no name
        await log.flush();
        const beforeLines = fs.readFileSync(audit(h), 'utf8').split('\n').filter(Boolean);
        assert.deepEqual(verifyChainWithHistory(audit(h)), { ok: true, count: 6, segments: 1, note: 'anchored' });
        const r = await deleteWorkspaceWithLifecycle('gone', { eraseNow: true }, d);
        assert.equal(r.status, 'erased');
        const s = storeOf(h, r.id);
        assert.equal(s.status, 'complete'); assert.equal(s.removed['entries'], 4); assert.equal(s.remaining['entries'], 0);
        const text = allText(h);
        assert.ok(!text.includes('TOPSECRET-gone'), 'no content of the deleted workspace remains');
        assert.ok(text.includes('TOPSECRET-keep-1'));
        const now = fs.readFileSync(audit(h), 'utf8').split('\n').filter(Boolean);
        assert.equal(now.length, beforeLines.length + 1, 'one marker appended');
        for (const i of [1, 4]) assert.equal(now[i], beforeLines[i], 'untouched lines are byte-identical');
        const e = liveEntries(h); const o = beforeLines.map((l) => JSON.parse(l) as AuditEntry);
        for (const i of [0, 2, 3, 5]) {
            assert.deepEqual([e[i]!.timestamp, e[i]!.toolName, e[i]!.result, e[i]!.durationMs, e[i]!.prevHash], [o[i]!.timestamp, o[i]!.toolName, o[i]!.result, o[i]!.durationMs, o[i]!.prevHash]);
            assert.deepEqual(e[i]!.args, {}); assert.equal(e[i]!.redacted!.workspaceId, gid);
        }
        assert.equal(e[0]!.anchorHash, o[0]!.anchorHash, 'genesis anchor kept');
        const m = e[e.length - 1]!;
        assert.equal(m.toolName, 'audit.redacted'); assert.equal((m.args as { count: number }).count, 4);
        assert.ok(!JSON.stringify(m).includes('"gone"'), 'marker does not carry the workspace name');
        assert.deepEqual(verifyChainWithHistory(audit(h)), { ok: true, count: 7, segments: 1, note: 'anchored' });
        assert.equal(verifyLiveChain(audit(h)).ok, true);
        // the live writer keeps chaining after the rewrite
        ev(log, 'memory.store', { workspace: 'keep', content: 'later' }); await log.flush();
        assert.equal(verifyChainWithHistory(audit(h)).ok, true);
        assert.equal(log.verifyChain().ok, true);
    });

    await test('second run is a no-op (idempotent): same bytes, nothing more removed', async () => {
        const h = mkHome(); const d = base(h);
        const log = new AuditLog({ path: audit(h) });
        createWorkspace('gone', undefined, h); await sleep(5);
        ev(log, 'memory.store', { workspace: 'gone', content: 'x' }); await log.flush();
        const r = await deleteWorkspaceWithLifecycle('gone', { windowDays: 7 }, d);
        assert.equal((await eraserFor(h, r.id)).removed['entries'], 1);
        const bytes = fs.readFileSync(audit(h));
        const again = await eraserFor(h, r.id);
        assert.equal(again.status, 'complete'); assert.equal(again.removed['entries'], 0);
        assert.ok(bytes.equals(fs.readFileSync(audit(h))), 'no second marker, no rewrite');
    });

    await test('rotated archives are blanked too; archive mtimes preserved; full-history chain verifies', async () => {
        const h = mkHome(); const d = base(h);
        const log = new AuditLog({ path: audit(h) });
        createWorkspace('gone', undefined, h); createWorkspace('keep', undefined, h); await sleep(5);
        ev(log, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-gone-a' }); ev(log, 'memory.store', { workspace: 'keep', content: 'k1' });
        await log.flush(); assert.equal(rotateIfNeeded(audit(h), { maxBytes: 1 }).rotated, true); log.onRotated();
        await sleep(5); // archive names are millisecond timestamps; two rotations in one ms would collide
        ev(log, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-gone-b' }); ev(log, 'memory.store', { workspace: 'keep', content: 'k2' });
        await log.flush(); assert.equal(rotateIfNeeded(audit(h), { maxBytes: 1 }).rotated, true); log.onRotated();
        await sleep(5);
        ev(log, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-gone-c' }); ev(log, 'memory.store', { workspace: 'keep', content: 'k3' });
        await log.flush();
        const arch = listArchives(audit(h)); assert.equal(arch.length, 2);
        const t0 = Date.now() / 1000;
        fs.utimesSync(arch[0]!, t0 - 5000, t0 - 5000); fs.utimesSync(arch[1]!, t0 - 3000, t0 - 3000);
        const mt = arch.map((a) => fs.statSync(a).mtimeMs);
        assert.equal(verifyChainWithHistory(audit(h)).ok, true);
        const r = await deleteWorkspaceWithLifecycle('gone', { eraseNow: true }, d);
        assert.equal(storeOf(h, r.id).removed['entries'], 3);
        assert.ok(!allText(h).includes('TOPSECRET-gone'));
        assert.deepEqual(listArchives(audit(h)), arch, 'same archives, same order');
        arch.forEach((a, i) => assert.ok(Math.abs(fs.statSync(a).mtimeMs - mt[i]!) < 1, 'archive mtimes preserved (sub-millisecond float rounding allowed)'));
        assert.equal(fs.statSync(arch[0]!).mode & 0o777, 0o600);
        const v = verifyChainWithHistory(audit(h));
        assert.equal(v.ok, true, JSON.stringify(v)); assert.equal((v as { segments: number }).segments, 3);
        const live = verifyLiveChain(audit(h)); assert.equal(live.ok, true, JSON.stringify(live));
        assert.deepEqual(fs.readdirSync(h).filter((f) => f.includes('.tmp')), []);
    });

    await test('the verifier rejects forged, altered and unvouched blanked lines', async () => {
        const h = mkHome(); const d = base(h);
        const log = new AuditLog({ path: audit(h) });
        createWorkspace('gone', undefined, h); await sleep(5);
        ev(log, 'a.one', { workspace: 'other' }); ev(log, 'memory.store', { workspace: 'gone', content: 'x' }); ev(log, 'a.three', { workspace: 'other' });
        await log.flush();
        const r = await deleteWorkspaceWithLifecycle('gone', { eraseNow: true }, d);
        assert.equal(r.status, 'erased');
        const good = fs.readFileSync(audit(h), 'utf8'); assert.equal(verifyChainWithHistory(audit(h)).ok, true);
        const lines = good.split('\n').filter(Boolean);
        const check = (mutate: (l: string[]) => string[], why: string): void => {
            fs.writeFileSync(audit(h), mutate([...lines]).join('\n') + '\n');
            const v = verifyChainWithHistory(audit(h)); assert.equal(v.ok, false, why);
            fs.writeFileSync(audit(h), good);
        };
        check((l) => { const e = JSON.parse(l[1]!); e.toolName = 'memory.delete'; l[1] = JSON.stringify(e); return l; }, 'kept field altered');
        check((l) => { const e = JSON.parse(l[1]!); e.timestamp = '2020-01-01T00:00:00.000Z'; l[1] = JSON.stringify(e); return l; }, 'time altered');
        check((l) => { const e = JSON.parse(l[1]!); e.args = { smuggled: 1 }; l[1] = JSON.stringify(e); return l; }, 'content smuggled into a stub');
        check((l) => l.slice(0, -1), 'marker removed (blanked line unvouched)');
        check((l) => { const m = JSON.parse(l[l.length - 1]!); m.args.digest = '0'.repeat(64); l[l.length - 1] = JSON.stringify(m); return l; }, 'marker digest wrong');
        check((l) => { const e = JSON.parse(l[0]!); e.redacted = { at: 'x', by: 'workspace-erase', workspaceId: 'w', runId: 'r', origHash: '1'.repeat(64) }; l[0] = JSON.stringify(e); return l; }, 'unlisted line claims to be blanked');
        check((l) => { const e = JSON.parse(l[1]!); e.redacted.origHash = '2'.repeat(64); l[1] = JSON.stringify(e); return l; }, 'original hash changed breaks the next link');
        assert.equal(verifyChainWithHistory(audit(h)).ok, true, 'restored file verifies again');
    });

    await test('matching: name only inside the lifetime; a re-used name is ambiguous (left alone, unverifiable)', async () => {
        const h = mkHome(); const d = base(h);
        const log = new AuditLog({ path: audit(h) });
        createWorkspace('gone', undefined, h); createWorkspace('keep', undefined, h); await sleep(8);
        ev(log, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-old' }); await log.flush();
        const r = await deleteWorkspaceWithLifecycle('gone', { windowDays: 7 }, d);
        await sleep(8); createWorkspace('gone', undefined, h); await sleep(8); // a different workspace takes the name
        ev(log, 'memory.store', { workspace: 'gone', content: 'NEW-OWNER-DATA' }); await log.flush();
        const res = await eraserFor(h, r.id);
        assert.equal(res.status, 'unverifiable', JSON.stringify(res));
        assert.equal(res.removed['entries'], 1); assert.equal(res.remaining['ambiguous'], 1);
        const text = fs.readFileSync(audit(h), 'utf8');
        assert.ok(!text.includes('TOPSECRET-old')); assert.ok(text.includes('NEW-OWNER-DATA'), 'the new workspace entry is never blanked');
        assert.equal(verifyChainWithHistory(audit(h)).ok, true);
    });

    await test('no audit file: not-applicable', async () => {
        const h = mkHome(); const d = base(h);
        createWorkspace('gone', undefined, h);
        const r = await deleteWorkspaceWithLifecycle('gone', { eraseNow: true }, d);
        assert.equal(r.status, 'erased');
        assert.equal(storeOf(h, r.id).status, 'not-applicable');
    });

    await test('appends made while the erase runs are not lost and the chain stays linear', async () => {
        const h = mkHome(); const d = base(h);
        const log = new AuditLog({ path: audit(h) });
        createWorkspace('gone', undefined, h); createWorkspace('keep', undefined, h); await sleep(5);
        for (let i = 0; i < 20; i++) ev(log, 'memory.store', { workspace: i % 2 ? 'gone' : 'keep', i });
        const r = await deleteWorkspaceWithLifecycle('gone', { windowDays: 7 }, d);
        const erasing = eraseNow(r.id, d);
        let n = 0;
        for (let i = 0; i < 60; i++) { ev(log, 'memory.store', { workspace: 'keep', during: i }); n++; if (i % 5 === 0) await sleep(0); }
        const out = await erasing; assert.equal(out.kind, 'complete');
        for (let i = 0; i < 10; i++) { ev(log, 'memory.store', { workspace: 'keep', after: i }); n++; }
        await log.flush();
        const e = liveEntries(h);
        assert.equal(e.length, 20 + n + 1, 'every entry present, plus exactly one marker');
        assert.equal(e.filter((x) => (x.args as { during?: number }).during !== undefined).length, 60);
        const v = verifyChainWithHistory(audit(h)); assert.equal(v.ok, true, JSON.stringify(v));
        assert.equal(log.verifyChain().ok, true);
    });

    await test('a failed rewrite leaves the file untouched and is retried; drift from another process is detected', async () => {
        const h = mkHome(); const d = base(h);
        const log = new AuditLog({ path: audit(h) });
        createWorkspace('gone', undefined, h); await sleep(5);
        ev(log, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-z' }); ev(log, 'memory.store', { workspace: 'keep', content: 'k' }); await log.flush();
        const r = await deleteWorkspaceWithLifecycle('gone', { windowDays: 7 }, d);
        const before = fs.readFileSync(audit(h));
        const failed1 = await eraserFor(h, r.id, { beforeRename: () => { throw new Error('disk full'); } });
        assert.equal(failed1.status, 'partial'); assert.equal(failed1.remaining['entries'], 1);
        assert.ok(before.equals(fs.readFileSync(audit(h)))); assert.deepEqual(fs.readdirSync(h).filter((f) => f.includes('.tmp')), []);
        const failed2 = await eraserFor(h, r.id, { beforeRename: () => fs.appendFileSync(audit(h), JSON.stringify({ timestamp: new Date().toISOString(), toolName: 'foreign', args: {}, result: 'success', durationMs: 0, prevHash: null }) + '\n') });
        assert.equal(failed2.status, 'partial'); assert.match(failed2.detail ?? '', /changed while/);
        assert.ok(fs.readFileSync(audit(h), 'utf8').includes('"foreign"'), 'the other process line was not overwritten');
        assert.deepEqual(fs.readdirSync(h).filter((f) => f.includes('.tmp')), []);
    });

    await test('crash between the rewrite and the marker: next run writes a recovery marker', async () => {
        const h = mkHome(); const d = base(h);
        const log = new AuditLog({ path: audit(h) });
        createWorkspace('gone', undefined, h); await sleep(5);
        ev(log, 'a', { workspace: 'keep' }); ev(log, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-q' }); await log.flush();
        const r = await deleteWorkspaceWithLifecycle('gone', { eraseNow: true }, d);
        assert.equal(r.status, 'erased');
        const lines = fs.readFileSync(audit(h), 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(audit(h), lines.slice(0, -1).join('\n') + '\n'); // as if the process died before the marker
        assert.equal(verifyChainWithHistory(audit(h)).ok, false);
        const res = await eraserFor(h, r.id);
        assert.equal(res.status, 'complete');
        const v = verifyChainWithHistory(audit(h)); assert.equal(v.ok, true, JSON.stringify(v));
        assert.equal((liveEntries(h).at(-1)!.args as { recovered?: boolean }).recovered, true);
    });

    await test('no live writer in this process (CLI-style): the marker is appended directly and the chain verifies', async () => {
        const h = mkHome(); const d = base(h);
        const src = new AuditLog({ path: audit(h) });
        createWorkspace('gone', undefined, h); await sleep(5);
        ev(src, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-c' }); ev(src, 'memory.store', { workspace: 'keep' }); await src.flush();
        const r = await deleteWorkspaceWithLifecycle('gone', { windowDays: 7 }, d);
        const other = path.join(h, 'other'); fs.mkdirSync(other);
        fs.copyFileSync(audit(h), path.join(other, 'audit.jsonl')); fs.copyFileSync(audit(h) + '.anchor', path.join(other, 'audit.jsonl.anchor'));
        const res = await eraserFor(h, r.id, { auditPath: path.join(other, 'audit.jsonl') });
        assert.equal(res.status, 'complete'); assert.equal(res.removed['entries'], 1);
        assert.equal(verifyChainWithHistory(path.join(other, 'audit.jsonl')).ok, true);
        assert.ok(!fs.readFileSync(path.join(other, 'audit.jsonl'), 'utf8').includes('TOPSECRET-c'));
    });
} finally {
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
