#!/usr/bin/env tsx
/**
 * test/node-batch-engine-contract-unit.ts - 3.35.0: the `commitNodeBatch` engine contract.
 *
 *   sqlite    real SqliteGraph over a temp file: all-pass, precondition false, ifRevision miss, ifAbsent
 *             duplicate, mixed, empty batch, caps, "touches" never bump revision/updatedAt, and TWO
 *             connections on one file (the second BEGIN IMMEDIATE waits, then fails its precondition)
 *   arcade    the real ArcadeGraphStore over a fake ArcadeHttp that records the generated sqlscript:
 *             sorted touches, one CAS per touch, ROLLBACK + RETURN after every IF, no `RETURN COUNT`,
 *             no `COMMIT RETRY`, bound parameters only; outcome mapping (CME -> contention, duplicate ->
 *             exists, timeout -> unknown, failed guard -> precondition/revision)
 *   dataplane not supported: no `commitNodeBatch`, nothing written
 *
 * Run: npx tsx test/node-batch-engine-contract-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import { ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { DataplaneGraph } from '../packages/lore/src/engines/dataplaneGraph.js';
import {
    hasNodeBatchSupport, MAX_NODE_BATCH_WRITES, MAX_NODE_BATCH_CHECKS, NodeBatchInvalidError,
    type NodeBatchWrite, type NodeBatchNodeInput,
} from '../packages/lore/src/engines/graphShared/nodeBatch.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

const input = (id: string, label = id): NodeBatchNodeInput =>
    ({ id, type: 'note', label, content: `content ${label}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' });
const cas = (id: string, expected: number, label = id, mustExist = false): NodeBatchWrite =>
    ({ kind: 'cas', node: input(id, label), expectedRevision: expected, mustExist, updatedAt: '2026-10-01T00:00:00.000Z' });
const ins = (id: string): NodeBatchWrite => ({ kind: 'insert', node: input(id), updatedAt: '2026-10-01T00:00:00.000Z' });

// ───────────────────────── sqlite ─────────────────────────
console.log('\nsqlite');

async function sqliteGraph(dir = mkTmp('nb-sq-')): Promise<SqliteGraph> {
    const g = new SqliteGraph(dir, { workspaceId: 'nb' });
    await g.initialize();
    return g;
}
/** Seed `id` at revision `n` (n writes). */
async function seed(g: SqliteGraph, id: string, n = 1): Promise<void> {
    for (let i = 0; i < n; i++) await g.upsertNode({ ...input(id, `${id}-v${i}`) } as never);
}

await test('all pass: every write lands at expected + 1 (insert at 1) and the outcome reports them', async () => {
    const g = await sqliteGraph();
    await seed(g, 'x', 2); await seed(g, 'a', 1);
    const out = await g.commitNodeBatch([{ id: 'x', revision: 2 }], [cas('a', 1), ins('b')]);
    assert.deepEqual(out, { ok: true, revisions: { a: 2, b: 1 } });
    assert.equal((await g.getNode('a'))!.revision, 2);
    assert.equal((await g.getNode('b'))!.revision, 1);
});

await test('precondition false: nothing is written; the failing index and actual revision are reported', async () => {
    const g = await sqliteGraph();
    await seed(g, 'x', 3); await seed(g, 'a', 1);
    const out = await g.commitNodeBatch([{ id: 'x', revision: 3 }, { id: 'a', revision: 5 }], [cas('a', 1, 'changed'), ins('b')]);
    assert.deepEqual(out, { ok: false, code: 'precondition', index: 1, id: 'a', actual: 1 });
    assert.equal((await g.getNode('a'))!.label, 'a-v0', 'untouched');
    assert.equal(await g.getNode('b'), null, 'the insert did not land');
});

await test('ifRevision miss (cas with the wrong expected revision): nothing is written', async () => {
    const g = await sqliteGraph();
    await seed(g, 'a', 2);
    const out = await g.commitNodeBatch([], [ins('b'), cas('a', 1)]);
    assert.deepEqual(out, { ok: false, code: 'revision', index: 1, id: 'a', actual: 2 });
    assert.equal(await g.getNode('b'), null);
});

await test('mustExist cas on an absent node is a revision miss, not a create', async () => {
    const g = await sqliteGraph();
    const out = await g.commitNodeBatch([], [cas('ghost', 0, 'ghost', true)]);
    assert.equal(out.ok, false);
    assert.equal((out as { code: string }).code, 'revision');
    assert.equal(await g.getNode('ghost'), null);
});

await test('ifAbsent duplicate: `exists`, nothing else written', async () => {
    const g = await sqliteGraph();
    await seed(g, 'taken', 1);
    const out = await g.commitNodeBatch([], [ins('fresh'), ins('taken')]);
    assert.deepEqual(out, { ok: false, code: 'exists', index: 1, id: 'taken' });
    assert.equal(await g.getNode('fresh'), null);
});

await test('mixed batch: checks + cas + insert commit together', async () => {
    const g = await sqliteGraph();
    await seed(g, 'x', 1); await seed(g, 'y', 4); await seed(g, 'a', 1);
    const out = await g.commitNodeBatch([{ id: 'x', revision: 1 }, { id: 'y', revision: 4 }], [cas('a', 1), ins('n1'), ins('n2')]);
    assert.equal(out.ok, true);
    assert.deepEqual((out as { revisions: unknown }).revisions, { a: 2, n1: 1, n2: 1 });
});

await test('an empty batch, an over-cap batch and a repeated write id are rejected up front', async () => {
    const g = await sqliteGraph();
    await assert.rejects(g.commitNodeBatch([], []), NodeBatchInvalidError);
    const many = Array.from({ length: MAX_NODE_BATCH_WRITES + 1 }, (_, i) => ins(`n${i}`));
    await assert.rejects(g.commitNodeBatch([], many), /at most 100 writes/);
    const checks = Array.from({ length: MAX_NODE_BATCH_CHECKS + 1 }, (_, i) => ({ id: `c${i}`, revision: 0 }));
    await assert.rejects(g.commitNodeBatch(checks, [ins('z')]), /at most 400 checks/);
    await assert.rejects(g.commitNodeBatch([], [ins('dup'), ins('dup')]), /appears twice/);
    assert.equal(await g.getNode('n0'), null);
    // exactly at the cap is fine
    const ok = await g.commitNodeBatch([], Array.from({ length: MAX_NODE_BATCH_WRITES }, (_, i) => ins(`m${i}`)));
    assert.equal(ok.ok, true);
});

await test('a precondition check never bumps the checked node (revision and updatedAt unchanged)', async () => {
    const g = await sqliteGraph();
    await seed(g, 'x', 2);
    const before = await g.getNode('x');
    await g.commitNodeBatch([{ id: 'x', revision: 2 }], [ins('t')]);
    const after = await g.getNode('x');
    assert.equal(after!.revision, before!.revision);
    assert.equal(after!.updatedAt, before!.updatedAt);
});

await test('two connections on one file: the second BEGIN IMMEDIATE waits for the first, then fails its precondition', async () => {
    const dir = mkTmp('nb-sq2-');
    const g1 = await sqliteGraph(dir);
    await seed(g1, 'x', 1);
    const g2 = await sqliteGraph(dir);
    // Connection 1 holds the write lock (open IMMEDIATE transaction) and bumps X before committing.
    const dbFile = g1.dataPath;
    const raw = new Database(dbFile);
    raw.pragma('busy_timeout = 5000');
    raw.exec('BEGIN IMMEDIATE');
    raw.prepare('UPDATE nodes SET revision = revision + 1 WHERE id = ?').run('x');
    // Connection 2 starts its batch NOW (it will block inside better-sqlite3 until the lock is free).
    // A synchronous call would block this thread, so run it from a child process.
    const { spawn } = await import('node:child_process');
    const script = `
      import { SqliteGraph } from ${JSON.stringify(path.resolve('packages/lore/src/engines/sqliteGraph.ts'))};
      const g = new SqliteGraph(${JSON.stringify(dir)}, { workspaceId: 'nb' });
      await g.initialize();
      const out = await g.commitNodeBatch([{ id: 'x', revision: 1 }], [{ kind: 'insert', node: { id: 'w', type: 'note', label: 'w', content: 'w', tags: [], project: 'p', ecosystem: '*', metadata: '{}' }, updatedAt: '2026-10-01T00:00:00.000Z' }]);
      console.log(JSON.stringify(out));
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    await new Promise((r) => setTimeout(r, 1500)); // let the child reach (and wait on) the write lock
    assert.equal(stdout, '', 'the second connection has not decided yet - it is waiting for the lock');
    raw.exec('COMMIT');
    raw.close();
    await new Promise<void>((resolve, reject) => { child.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`child exit ${c}: ${stderr}`)))); });
    const out = JSON.parse(stdout.trim().split('\n').pop()!);
    assert.deepEqual(out, { ok: false, code: 'precondition', index: 0, id: 'x', actual: 2 });
    assert.equal(await g2.getNode('w'), null, 'nothing was written by the loser');
});

// ───────────────────────── arcade (fake http) ─────────────────────────
console.log('\narcade (fake ArcadeHttp, generated script)');

type Row = Record<string, unknown>;
class FakeArcade {
    nodes = new Map<string, Row>();
    scripts: Array<{ script: string; params: Row }> = [];
    scriptValue: unknown = { ok: true };
    scriptError: Error | null = null;
    async command(): Promise<{ result: unknown[] }> { return { result: [] }; }
    async commandScript(_db: string, script: string, params: Row = {}): Promise<{ result: unknown[] }> {
        if (!script.startsWith('BEGIN;')) return { result: [] }; // schema DDL
        this.scripts.push({ script, params });
        if (this.scriptError) throw this.scriptError;
        return { result: [{ value: this.scriptValue }] };
    }
    async query(_db: string, sql: string, params: Row = {}): Promise<{ result: Row[] }> {
        if (/FROM LoreNode WHERE id = :id LIMIT 1$/.test(sql)) { const r = this.nodes.get(String(params['id'])); return { result: r ? [{ ...r }] : [] }; }
        return { result: [] };
    }
}
const row = (id: string, revision: number): Row =>
    ({ id, type: 'note', label: id, content: id, tags: '[]', project: 'p', ecosystem: '*', metadata: '{}', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revision });
function arcadeRig(): { fake: FakeArcade; g: ArcadeGraphStore } {
    const fake = new FakeArcade();
    return { fake, g: new ArcadeGraphStore({ tenantDb: 't', http: fake as never }) };
}

await test('script shape: sorted touches, one CAS per touch, ROLLBACK + RETURN after each IF, writes sorted, no RETURN COUNT / COMMIT RETRY', async () => {
    const { fake, g } = arcadeRig();
    fake.nodes.set('zz', row('zz', 3)); fake.nodes.set('aa', row('aa', 7)); fake.nodes.set('m2', row('m2', 1)); fake.nodes.set('m1', row('m1', 1));
    const out = await g.commitNodeBatch([{ id: 'zz', revision: 3 }, { id: 'aa', revision: 7 }], [cas('m2', 1), cas('m1', 1), ins('k')]);
    assert.equal(out.ok, true);
    const { script, params } = fake.scripts[0]!;
    assert.match(script, /^BEGIN;/);
    assert.match(script, /COMMIT;\nRETURN \{"ok":true\};$/);
    assert.doesNotMatch(script, /RETURN COUNT/i);
    assert.doesNotMatch(script, /COMMIT RETRY/i);
    const touchLines = script.split('\n').filter((l) => l.startsWith('LET t'));
    assert.equal(touchLines.length, 2);
    for (const l of touchLines) {
        assert.match(l, /UPDATE LoreNode SET txTouch = ifnull\(txTouch, 0\) \+ 1 WHERE id = :t\d+_id AND ifnull\(revision, 0\) = :t\d+_rev;$/);
    }
    assert.equal(params['t0_id'], 'aa', 'touches run in ascending id order');
    assert.equal(params['t1_id'], 'zz');
    // every IF is followed by ROLLBACK and a RETURN inside the same block
    const ifLines = script.split('\n').filter((l) => l.startsWith('IF '));
    assert.equal(ifLines.length, 4, '2 touches + 2 cas writes');
    for (const l of ifLines) assert.match(l, /^IF \(\$[tw]\d+\[0\]\.count < 1\) \{ ROLLBACK; RETURN \{"failed":"(precondition|revision)","i":\d+\}; \}$/);
    // writes: ascending id order (k, m1, m2); one CAS (`ifnull(revision, 0) = :wN_exp`) per cas item; the insert has no guard
    const ids = Object.entries(params).filter(([k]) => /^w\d+_id$/.test(k)).sort().map(([, v]) => v);
    assert.deepEqual(ids, ['k', 'm1', 'm2']);
    assert.equal(script.split('\n').filter((l) => /ifnull\(revision, 0\) = :w\d+_exp;$/.test(l)).length, 2);
    assert.equal(script.split('\n').filter((l) => l.startsWith('INSERT INTO LoreNode')).length, 1);
    // bound parameters only: no node content in the script text
    assert.doesNotMatch(script, /content m1|content k/);
});

await test('outcome mapping: guard failures, CME -> contention, duplicate -> exists, timeout -> unknown', async () => {
    const { fake, g } = arcadeRig();
    fake.nodes.set('x', row('x', 1)); fake.nodes.set('a', row('a', 1));
    fake.scriptValue = { failed: 'precondition', i: 0 };
    assert.deepEqual(await g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), { ok: false, code: 'precondition', index: 0, id: 'x', actual: 1 });
    fake.scriptValue = { failed: 'revision', i: 0 };
    assert.deepEqual(await g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), { ok: false, code: 'revision', index: 0, id: 'a', actual: 1 });
    fake.scriptValue = { ok: true };
    fake.scriptError = new ArcadeHttpError(500, '{"exception":"com.arcadedb.exception.ConcurrentModificationException","error":"Concurrent modification"}');
    assert.deepEqual(await g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), { ok: false, code: 'contention' });
    // (A) the commit-time RecordNotFoundException (real 26.7.1 body) is contention too; a plain 500 stays a refusal.
    fake.scriptError = new ArcadeHttpError(500, '{"error":"Error on transaction commit","detail":"Record #1:77 not found","exception":"com.arcadedb.exception.RecordNotFoundException"}');
    assert.deepEqual(await g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), { ok: false, code: 'contention' });
    fake.scriptError = new ArcadeHttpError(500, '{"error":"Internal error","detail":"Record #1:77 not found","exception":"com.arcadedb.exception.RecordNotFoundException"}');
    await assert.rejects(g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), /ArcadeDB HTTP 500/, 'a RecordNotFound that is NOT the commit error is not retried');
    fake.scriptError = new ArcadeHttpError(409, '{"exception":"com.arcadedb.exception.DuplicatedKeyException"}');
    const dup = await g.commitNodeBatch([], [ins('fresh')]);
    assert.equal(dup.ok, false); assert.equal((dup as { code: string }).code, 'exists');
    fake.scriptError = new Error('request timeout');
    assert.deepEqual(await g.commitNodeBatch([{ id: 'x', revision: 1 }], [cas('a', 1)]), { ok: false, code: 'unknown' });
    fake.scriptError = new ArcadeHttpError(400, 'bad sql');
    await assert.rejects(g.commitNodeBatch([], [cas('a', 1)]), /bad sql|400/);
});

await test('reads judge what a read can: a stale expected revision or an existing insert id never reaches the server', async () => {
    const { fake, g } = arcadeRig();
    fake.nodes.set('a', row('a', 4));
    assert.deepEqual(await g.commitNodeBatch([], [cas('a', 1)]), { ok: false, code: 'revision', index: 0, id: 'a', actual: 4 });
    assert.deepEqual(await g.commitNodeBatch([], [ins('a')]), { ok: false, code: 'exists', index: 0, id: 'a' });
    assert.equal(fake.scripts.length, 0);
});

await test('a cas on a row that is ABSENT creates it with an INSERT (found live: an UPDATE has no record to match); a rival creating it first is a revision conflict, not "exists"', async () => {
    const { fake, g } = arcadeRig();
    const out = await g.commitNodeBatch([], [cas('fresh', 0)]);
    assert.equal(out.ok, true);
    const { script } = fake.scripts[0]!;
    assert.equal(script.split('\n').filter((l) => l.startsWith('INSERT INTO LoreNode')).length, 1);
    assert.equal(script.split('\n').filter((l) => l.startsWith('LET w')).length, 0, 'no guarded UPDATE for an absent row');
    // the rival: duplicate key on the INSERT, and the row now exists at revision 2 -> the cas lost a revision race
    fake.scriptError = new ArcadeHttpError(409, '{"exception":"com.arcadedb.exception.DuplicatedKeyException"}');
    fake.nodes.set('late', row('late', 2));
    const realQuery = fake.query.bind(fake);
    let reads = 0;
    fake.query = async (db: string, sql: string, params: Row = {}) => {
        if (String(params['id']) === 'late' && reads++ === 0) return { result: [] }; // absent at read time, present afterwards
        return realQuery(db, sql, params);
    };
    assert.deepEqual(await g.commitNodeBatch([], [cas('late', 0)]), { ok: false, code: 'revision', index: 0, id: 'late', actual: 2 });
});

await test('D7: a revision-0 check on an absent node holds and is not touched; on an existing revision-0 row it is touched', async () => {
    const { fake, g } = arcadeRig();
    fake.nodes.set('legacy', row('legacy', 0));
    const out = await g.commitNodeBatch([{ id: 'ghost', revision: 0 }, { id: 'legacy', revision: 0 }], [ins('n')]);
    assert.equal(out.ok, true);
    const touchIds = Object.entries(fake.scripts[0]!.params).filter(([k]) => /^t\d+_id$/.test(k)).map(([, v]) => v);
    assert.deepEqual(touchIds, ['legacy']);
});

await test('empty batch and the caps are rejected before any request', async () => {
    const { fake, g } = arcadeRig();
    await assert.rejects(g.commitNodeBatch([], []), NodeBatchInvalidError);
    await assert.rejects(g.commitNodeBatch([], Array.from({ length: MAX_NODE_BATCH_WRITES + 1 }, (_, i) => ins(`n${i}`))), /at most 100 writes/);
    assert.equal(fake.scripts.length, 0);
});

// ───────────────────────── dataplane ─────────────────────────
console.log('\ndataplane');

await test('the Dataplane graph has no commitNodeBatch (not supported); hasNodeBatchSupport is false and nothing is written', async () => {
    const writes: string[] = [];
    const dp = Object.create(DataplaneGraph.prototype) as object;
    assert.equal(hasNodeBatchSupport(dp), false);
    assert.equal(hasNodeBatchSupport({ upsertNode: async () => { writes.push('w'); } }), false);
    assert.equal(hasNodeBatchSupport(await sqliteGraph()), true);
    assert.equal(hasNodeBatchSupport(arcadeRig().g), true);
    assert.deepEqual(writes, []);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
