#!/usr/bin/env tsx
/**
 * workspace-erase-audit-export-unit.ts — the `audit-log` erase step also blanks the deleted workspace's lines in the
 * default local exporter's sidecar copy `<home>/audit-export.jsonl` (3.37.0 left them in place).
 *
 * Proves: after an erase no export line carries the workspace name, its content or its node ids; other workspaces' lines
 * are byte-identical; line count and timestamps are kept; the receipt is complete; records still queued in the exporter's
 * memory are blanked too; appends racing the rewrite are not lost (and not duplicated); no export file = nothing to do
 * (complete); a failed export rewrite makes the step `partial` with a reason and leaves the file untouched; an export
 * file with no live exporter in this process (CLI-style) is cleaned directly.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace, loadWorkspaces } from '../packages/lore/src/config/workspaces.js';
import { readDeletionLog } from '../packages/lore/src/config/deletedWorkspaces.js';
import { FileTailExporter } from '../packages/lore/src/audit/fileTailExporter.js';
import { AuditLog, type AuditEntry } from '../packages/lore/src/security/audit.js';
import { verifyChainWithHistory } from '../packages/lore/src/security/auditChain.js';
import { createAuditEraser } from '../packages/lore/src/engines/workspaceErase/auditEraser.js';
import { deleteWorkspaceWithLifecycle, targetFromRecord, type LifecycleDeps } from '../packages/lore/src/engines/workspaceErase/lifecycle.js';
import { eraseNow } from '../packages/lore/src/engines/workspaceErase/tick.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}
const homes: string[] = [];
const mkHome = (): string => { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'aue-')); homes.push(h); loadWorkspaces(h); return h; };
const base = (home: string): LifecycleDeps => ({ home, env: {}, eraserFactory: { keyringEnabled: false }, lock: { staleMs: 60_000, heartbeatMs: 5_000 } });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const audit = (h: string): string => path.join(h, 'audit.jsonl');
const exp = (h: string): string => path.join(h, 'audit-export.jsonl');
const ev = (log: AuditLog, tool: string, args: Record<string, unknown>): void => log.log({ toolName: tool, args, result: 'success', durationMs: 3 });
const lines = (f: string): string[] => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
const storeOf = (h: string, id: string) => readDeletionLog(h).byId.get(id)!.completedErase!.stores.find((s) => s.store === 'audit-log')!;
const idOf = (h: string, name: string): string => loadWorkspaces(h).workspaces.find((w) => w.name === name)!.id!;

/** An AuditLog with the default file exporter attached and started, as the daemon wires it. */
async function withExporter(h: string): Promise<{ log: AuditLog; ex: FileTailExporter }> {
    const log = new AuditLog({ path: audit(h) });
    const ex = new FileTailExporter();
    await ex.configure({ env: {}, auditLogPath: audit(h) });
    ex.start();
    log.attachExporter(ex);
    return { log, ex };
}
/** Wait until the exporter's 1 s timer has appended everything queued so far. */
const settle = async (): Promise<void> => { await sleep(1300); };

console.log('workspace erase: audit export sidecar');
try {
    await test('blanks the deleted workspace in audit-export.jsonl; others byte-identical; count + times kept; receipt complete', async () => {
        const h = mkHome(); const d = base(h);
        const { log, ex } = await withExporter(h);
        createWorkspace('gone', undefined, h); createWorkspace('keep', undefined, h);
        const gid = idOf(h, 'gone');
        await sleep(5);
        ev(log, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-gone-1' });
        ev(log, 'memory.store', { workspace: 'keep', content: 'TOPSECRET-keep-1' });
        ev(log, 'workspaces.create', { name: 'gone', template: 'TOPSECRET-gone-2' });
        ev(log, 'node.read', { nodeId: `n-${gid}-x`, content: 'TOPSECRET-gone-3' });
        ev(log, 'retention.sweep', { note: 'no attribution' });
        await log.flush(); await settle();
        const before = lines(exp(h));
        assert.equal(before.length, 5);
        assert.ok(before.join('\n').includes('TOPSECRET-gone-1'), 'precondition: the export holds the content');

        const r = await deleteWorkspaceWithLifecycle('gone', { eraseNow: true }, d);
        assert.equal(r.status, 'erased');
        const s = storeOf(h, r.id);
        assert.equal(s.status, 'complete', JSON.stringify(s));
        assert.equal(s.removed['exportEntries'], 3); assert.equal(s.remaining['exportEntries'], 0);

        const now = lines(exp(h));
        // the audit.redacted marker is surfaced to the exporter asynchronously: compare the original span first
        assert.deepEqual(now.slice(0, 5).map((l) => (JSON.parse(l) as AuditEntry).timestamp), before.map((l) => (JSON.parse(l) as AuditEntry).timestamp), 'timestamps and order kept');
        for (const i of [1, 4]) assert.equal(now[i], before[i], 'other lines are byte-identical');
        const text = fs.readFileSync(exp(h), 'utf8');
        assert.ok(!text.includes('TOPSECRET-gone'), 'no content of the deleted workspace');
        assert.ok(!text.includes('"gone"'), 'no workspace name');
        assert.ok(text.includes('TOPSECRET-keep-1'));
        for (const l of now) {
            const e = JSON.parse(l) as AuditEntry;
            if (l.includes(gid)) assert.ok(e.redacted !== undefined || e.toolName === 'audit.redacted', 'the id only survives in stubs and the marker');
        }
        for (const i of [0, 2, 3]) {
            const e = JSON.parse(now[i]!) as AuditEntry;
            assert.deepEqual(e.args, {}); assert.equal(e.actor.id, 'redacted'); assert.equal(e.redacted!.workspaceId, gid);
        }
        assert.equal(fs.statSync(exp(h)).mode & 0o777, 0o600);
        assert.deepEqual(fs.readdirSync(h).filter((f) => f.includes('.tmp')), []);
        assert.equal(verifyChainWithHistory(audit(h)).ok, true);

        // the live exporter keeps appending to the new file; the marker shows up too
        ev(log, 'memory.store', { workspace: 'keep', content: 'later' }); await log.flush(); await settle();
        const after = lines(exp(h));
        assert.ok(after.length >= 7 && after.join('\n').includes('"later"'));
        await ex.stop();
    });

    await test('records still queued in the exporter are blanked too (drained to disk first)', async () => {
        const h = mkHome(); const d = base(h);
        const { log, ex } = await withExporter(h);
        createWorkspace('gone', undefined, h); await sleep(5);
        ev(log, 'memory.store', { workspace: 'keep', content: 'K0' });
        ev(log, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-queued' });
        // no wait: both records are still in the exporter's memory queue
        assert.equal(fs.readFileSync(exp(h), 'utf8'), '', 'precondition: nothing flushed yet');
        const r = await deleteWorkspaceWithLifecycle('gone', { eraseNow: true }, d);
        assert.equal(storeOf(h, r.id).status, 'complete');
        await settle();
        const text = fs.readFileSync(exp(h), 'utf8');
        assert.ok(!text.includes('TOPSECRET-queued') && !text.includes('"gone"'));
        assert.ok(text.includes('K0'));
        await ex.stop();
    });

    await test('appends racing the rewrite are not lost and not duplicated', async () => {
        const h = mkHome(); const d = base(h);
        const { log, ex } = await withExporter(h);
        createWorkspace('gone', undefined, h); createWorkspace('keep', undefined, h); await sleep(5);
        for (let i = 0; i < 40; i++) ev(log, 'memory.store', { workspace: i % 2 ? 'gone' : 'keep', content: `pre-${i}` });
        await log.flush();
        const r = await deleteWorkspaceWithLifecycle('gone', { windowDays: 7 }, d);
        const erasing = eraseNow(r.id, d);
        let n = 0;
        for (let i = 0; i < 60; i++) { ev(log, 'memory.recall', { workspace: 'keep', content: `race-${n++}` }); await new Promise((res) => setImmediate(res)); }
        const out = await erasing; await log.flush(); await settle();
        const text = fs.readFileSync(exp(h), 'utf8');
        assert.equal(out.kind, 'complete', JSON.stringify(out));
        for (let i = 0; i < 60; i++) assert.equal(text.split(`"race-${i}"`).length - 1, 1, `race-${i} present exactly once`);
        for (let i = 0; i < 40; i += 2) assert.equal(text.split(`"pre-${i}"`).length - 1, 1, `pre-${i} kept once`);
        assert.ok(!text.includes('"gone"'));
        await ex.stop();
    });

    await test('no export file: nothing to do, receipt complete with no export counters', async () => {
        const h = mkHome(); const d = base(h);
        const log = new AuditLog({ path: audit(h) });          // exporter off / cloud exporter
        createWorkspace('gone', undefined, h); await sleep(5);
        ev(log, 'memory.store', { workspace: 'gone', content: 'x' }); await log.flush();
        assert.ok(!fs.existsSync(exp(h)));
        const r = await deleteWorkspaceWithLifecycle('gone', { eraseNow: true }, d);
        const s = storeOf(h, r.id);
        assert.equal(s.status, 'complete'); assert.equal(s.removed['entries'], 1);
        assert.equal(s.removed['exportEntries'], undefined);
        assert.ok(!fs.existsSync(exp(h)), 'the eraser does not create the file');
    });

    await test('a failed export rewrite makes the step partial with a reason; file untouched; retry completes', async () => {
        const h = mkHome(); const d = base(h);
        const { log, ex } = await withExporter(h);
        createWorkspace('gone', undefined, h); await sleep(5);
        ev(log, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-fail' }); ev(log, 'memory.store', { workspace: 'keep', content: 'K' });
        await log.flush(); await settle();
        const r = await deleteWorkspaceWithLifecycle('gone', { windowDays: 7 }, d);
        const before = fs.readFileSync(exp(h));
        const target = targetFromRecord(readDeletionLog(h).byId.get(r.id)!.deletion!);
        const bad = await createAuditEraser({ home: h, beforeRename: (f) => { if (f.includes('audit-export.jsonl')) throw new Error('disk full'); } }).erase(target);
        assert.equal(bad.status, 'partial'); assert.match(bad.detail ?? '', /audit-export\.jsonl/); assert.match(bad.detail ?? '', /disk full/);
        assert.equal(bad.remaining['exportEntries'], 1);
        assert.ok(before.equals(fs.readFileSync(exp(h))), 'export file untouched');
        assert.deepEqual(fs.readdirSync(h).filter((f) => f.includes('.tmp')), [], 'no temp file left');
        const ok = await createAuditEraser({ home: h }).erase(target);
        assert.equal(ok.status, 'complete'); assert.equal(ok.removed['exportEntries'], 1);
        assert.ok(!fs.readFileSync(exp(h), 'utf8').includes('TOPSECRET-fail'));
        await ex.stop();
    });

    await test('export file with no live exporter in this process (CLI-style) is cleaned directly', async () => {
        const h = mkHome(); const d = base(h);
        const src = new AuditLog({ path: audit(h) });
        createWorkspace('gone', undefined, h); await sleep(5);
        ev(src, 'memory.store', { workspace: 'gone', content: 'TOPSECRET-cli' }); ev(src, 'memory.store', { workspace: 'keep', content: 'K' }); await src.flush();
        const r = await deleteWorkspaceWithLifecycle('gone', { windowDays: 7 }, d);
        const other = path.join(h, 'other'); fs.mkdirSync(other);
        fs.copyFileSync(audit(h), path.join(other, 'audit.jsonl')); fs.copyFileSync(audit(h) + '.anchor', path.join(other, 'audit.jsonl.anchor'));
        fs.copyFileSync(audit(h), path.join(other, 'audit-export.jsonl'));
        const res = await createAuditEraser({ home: h, auditPath: path.join(other, 'audit.jsonl') }).erase(targetFromRecord(readDeletionLog(h).byId.get(r.id)!.deletion!));
        assert.equal(res.status, 'complete'); assert.equal(res.removed['exportEntries'], 1);
        assert.ok(!fs.readFileSync(path.join(other, 'audit-export.jsonl'), 'utf8').includes('TOPSECRET-cli'));
        assert.equal(lines(path.join(other, 'audit-export.jsonl')).length, 2, 'line count kept');
    });
} finally {
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
