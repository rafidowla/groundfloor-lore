#!/usr/bin/env tsx
/**
 * test/supersede-atomic-unit.ts - 3.35.0 (q) + item 9: write-time `supersedes` as ONE atomic commit.
 *
 *   sqlite engine   commitNodeBatch(.., supersedes): successor + marks + edges in one transaction; a lost claim rolls
 *                   the successor back too (no successor, no mark, no edge, no revision bump)
 *   arcade script   the generated sqlscript: successor INSERT, guarded mark, ROLLBACK on a lost claim, edge create,
 *                   one COMMIT; outcome mapping (lost claim, refused connect, reset -> unknown)
 *   service         nodeUpsert on a real SqliteGraph behind a spy handle: multi-target, a claim lost AFTER the
 *                   successor statement leaves nothing, CME x2 then success = one successor / one set of outbox rows,
 *                   S1 preconditions keep working, re-send of a 3.34-style partial repairs and says so
 *   bulk            POST /api/nodes/bulk: repair is `ok` + supersedesRepaired; a complete re-send is `unchanged`
 *   item 9          a refused connect is retried on the shared transient budget (once then ok; exhausted ->
 *                   arcade_unavailable); a reset stays outcome-unknown
 *   outbox settle   a pending_commit supersedes edge row is decided by the target's mark
 *
 * Run: npx tsx test/supersede-atomic-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { settlePendingCommits } from '../packages/lore/src/outbox/pendingCommit.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { classifyItemWriteError } from '../packages/lore/src/mcp/http/routes/bulkWriteErrors.js';
import { commitNodeBatchWithRetry, type NodeBatchPlan } from '../packages/lore/src/engines/graphShared/nodeBatchRetry.js';
import { OutcomeUnknownError } from '../packages/lore/src/engines/graphShared/writeOutcome.js';
import type {
    NodeBatchCapable, NodeBatchNodeInput, NodeBatchOutcome, NodeBatchSupersedes, NodeBatchWrite,
} from '../packages/lore/src/engines/graphShared/nodeBatch.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const dirs: string[] = [];
const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const STAMP = '2026-10-01T00:00:00.000Z';
const input = (id: string, label = id): NodeBatchNodeInput =>
    ({ id, type: 'note', label, content: `content ${label}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' });
const ins = (id: string): NodeBatchWrite => ({ kind: 'insert', node: input(id), updatedAt: STAMP });
const casW = (id: string, expectedRevision: number): NodeBatchWrite => ({ kind: 'cas', node: input(id), expectedRevision, mustExist: false, updatedAt: STAMP });
const sup = (successorId: string, links: Array<[string, boolean, boolean]>): NodeBatchSupersedes =>
    ({ successorId, reason: 'r', supersededAt: STAMP, links: links.map(([targetId, mark, edge]) => ({ targetId, mark, edge })) });
const edgeOf = (s: string, t: string) => ({ sourceId: s, targetId: t, relation: 'supersedes', confidence: 'extracted' as const, confidenceScore: 1.0 });

async function sqlite(ws = 'sa'): Promise<SqliteGraph> {
    const g = new SqliteGraph(mkTmp('sa-g-'), { workspaceId: ws });
    await g.initialize();
    return g;
}
const seed = async (g: SqliteGraph, id: string, n = 1) => { for (let i = 0; i < n; i++) await g.upsertNode({ ...input(id, `${id}${i}`) } as never); };
const hasEdge = async (g: SqliteGraph, s: string, t: string) => (await g.queryEdges({ source: s, target: t, relation: 'supersedes', limit: 5, offset: 0 })).length;

// ───────────────────────── sqlite engine ─────────────────────────
console.log('\nsqlite engine (one transaction)');

await test('successor + marks + edges land together; successor revision = 1 + marks, each target +1', async () => {
    const g = await sqlite();
    await seed(g, 't1'); await seed(g, 't2', 2);
    const out = await g.commitNodeBatch([], [ins('n')], sup('n', [['t1', true, true], ['t2', true, true]]));
    assert.deepEqual(out, { ok: true, revisions: { n: 3 } });
    assert.equal((await g.getNode('n'))!.revision, 3);
    assert.equal((await g.getNode('t1'))!.supersededBy, 'n');
    assert.equal((await g.getNode('t1'))!.revision, 2);
    assert.equal((await g.getNode('t2'))!.revision, 3);
    assert.equal(await hasEdge(g, 'n', 't1'), 1);
    assert.equal(await hasEdge(g, 'n', 't2'), 1);
});

await test('a claim lost AFTER the successor statement rolls everything back: no successor, no mark, no edge, no bump', async () => {
    const g = await sqlite();
    await seed(g, 't1'); await seed(g, 't2'); await seed(g, 'rival');
    assert.equal((await g.supersedeNode('t2', 'rival', 'x')).ok, true);
    const before = { t1: (await g.getNode('t1'))!.revision, t2: (await g.getNode('t2'))!.revision };
    // t1 is claimable and is marked FIRST in the transaction; t2 is held by 'rival' - the guard fails after the INSERT and the first mark.
    const out = await g.commitNodeBatch([], [ins('n')], sup('n', [['t1', true, true], ['t2', true, true]]));
    assert.equal(out.ok, false);
    assert.equal((out as { code: string }).code, 'supersede');
    assert.equal(await g.getNode('n'), null, 'the successor was rolled back');
    assert.equal((await g.getNode('t1'))!.supersededBy ?? '', '', 't1 was not marked');
    assert.equal((await g.getNode('t1'))!.revision, before.t1);
    assert.equal((await g.getNode('t2'))!.revision, before.t2);
    assert.equal(await hasEdge(g, 'n', 't1'), 0);
});

await test('a half-done link writes only its missing half: edge-only does not re-mark, mark-only adds the edge; no duplicate edge', async () => {
    const g = await sqlite();
    await seed(g, 'n'); await seed(g, 't1'); await seed(g, 't2');
    await g.supersedeNode('t1', 'n', 'x');                 // mark without edge (3.34 partial)
    await g.addEdge(edgeOf('n', 't2') as never);            // edge without mark (3.34 partial)
    const rev = (id: string) => g.getNode(id).then((n) => n!.revision as number);
    const t1 = await rev('t1'), t2 = await rev('t2'), n = await rev('n');
    const out = await g.commitNodeBatch([], [casW('n', n)], sup('n', [['t1', false, true], ['t2', true, false]]));
    assert.deepEqual(out, { ok: true, revisions: { n: n + 1 + 1 } }, 'one mark written');
    assert.equal(await rev('t1'), t1, 't1 was already marked: no second bump');
    assert.equal(await rev('t2'), t2 + 1);
    assert.equal(await hasEdge(g, 'n', 't1'), 1);
    assert.equal(await hasEdge(g, 'n', 't2'), 1, 'the existing edge was not duplicated');
    assert.equal((await g.getNode('t2'))!.supersededBy, 'n');
});

// ───────────────────────── arcade script ─────────────────────────
console.log('\narcade (fake ArcadeHttp, generated script)');

type Row = Record<string, unknown>;
class FakeArcade {
    scripts: Array<{ script: string; params: Row }> = [];
    scriptValue: unknown = { ok: true };
    scriptError: Error | null = null;
    async command(): Promise<{ result: unknown[] }> { return { result: [] }; }
    async commandScript(_db: string, script: string, params: Row = {}): Promise<{ result: unknown[] }> {
        if (!script.startsWith('BEGIN;')) return { result: [] };
        this.scripts.push({ script, params });
        if (this.scriptError) throw this.scriptError;
        return { result: [{ value: this.scriptValue }] };
    }
    async query(): Promise<{ result: Row[] }> { return { result: [] }; }
}
const arcadeRig = () => { const fake = new FakeArcade(); return { fake, g: new ArcadeGraphStore({ tenantDb: 't', http: fake as never }) }; };
const refusedErr = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2480'), { code: 'ECONNREFUSED' });
const resetErr = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

await test('script: successor INSERT, guarded mark with ROLLBACK, successor bump, conditional edges, ONE commit - in that order', async () => {
    const { fake, g } = arcadeRig();
    const out = await g.commitNodeBatch([{ id: 'x', revision: 0 }], [ins('n')], sup('n', [['t1', true, true], ['t2', false, true]]));
    assert.deepEqual(out, { ok: true, revisions: { n: 2 } });
    const lines = fake.scripts[0]!.script.split('\n');
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const iInsert = at(/^INSERT INTO LoreNode/), iMark = at(/^LET m0 = UPDATE LoreNode SET supersededBy/);
    const iGuard = at(/^IF \(\$m0\[0\]\.count < 1\) \{ ROLLBACK; RETURN \{"failed":"supersede","i":0\}; \}$/);
    const iBump = at(/^UPDATE LoreNode SET revision = ifnull\(revision, 0\) \+ :sp_n WHERE id = :sp_sid;$/);
    const iEdge = at(/^IF \(\$e0\.size\(\) < 1\) \{ CREATE EDGE LoreEdge/), iCommit = at(/^COMMIT;$/);
    for (const [name, i] of Object.entries({ iInsert, iMark, iGuard, iBump, iEdge, iCommit })) assert.ok(i >= 0, `${name} present`);
    assert.ok(iInsert < iMark && iMark < iGuard && iGuard < iBump && iBump < iEdge && iEdge < iCommit, 'statement order');
    assert.equal(lines.filter((l) => /^LET m\d/.test(l)).length, 1, 'only the target that needs a mark gets one');
    assert.equal(lines.filter((l) => /^LET e\d/.test(l)).length, 2);
    assert.equal(lines.filter((l) => l === 'COMMIT;').length, 1);
    assert.equal(fake.scripts[0]!.params['sp_n'], 1);
    assert.doesNotMatch(fake.scripts[0]!.script, /RETURN COUNT|COMMIT RETRY/i);
});

await test('outcome mapping: lost claim -> supersede; refused connect -> refused (carries the cause); reset / timeout -> unknown', async () => {
    const { fake, g } = arcadeRig();
    fake.scriptValue = { failed: 'supersede', i: 1 };
    assert.deepEqual(await g.commitNodeBatch([], [ins('n')], sup('n', [['t1', true, true], ['t2', true, true]])), { ok: false, code: 'supersede', index: 1, id: 't2' });
    fake.scriptValue = { ok: true };
    const e = refusedErr();
    fake.scriptError = e;
    const refused = await g.commitNodeBatch([], [ins('n')]);
    assert.equal(refused.ok, false); assert.equal((refused as { code: string }).code, 'refused'); assert.equal((refused as { cause: unknown }).cause, e);
    fake.scriptError = resetErr();
    assert.deepEqual(await g.commitNodeBatch([], [ins('n')]), { ok: false, code: 'unknown' });
    fake.scriptError = new Error('request timeout');
    assert.deepEqual(await g.commitNodeBatch([], [ins('n')]), { ok: false, code: 'unknown' });
});

// ───────────────────────── item 9: refused connect ─────────────────────────
console.log('\nitem 9 - refused connect on the batch path');

function scripted(answers: Array<NodeBatchOutcome>) {
    const calls: NodeBatchPlan[] = [];
    const graph: NodeBatchCapable & { getNode(id: string): Promise<null> } = {
        async commitNodeBatch(checks, writes, supersedes) { calls.push({ checks, writes, supersedes }); return answers[Math.min(calls.length - 1, answers.length - 1)]!; },
        async getNode() { return null; },
    };
    return { graph, calls };
}
const noSleep = { sleep: async () => undefined, random: () => 0.5 };

await test('refused once then ok: re-submitted, prepare() re-judged on the retry, success', async () => {
    const { graph, calls } = scripted([{ ok: false, code: 'refused', cause: refusedErr() }, { ok: true, revisions: { n: 1 } }]);
    const seen: number[] = [];
    const out = await commitNodeBatchWithRetry(graph, async (a) => { seen.push(a); return { checks: [], writes: [ins('n')] }; }, noSleep);
    assert.deepEqual(out, { ok: true, revisions: { n: 1 }, attempts: 2 });
    assert.deepEqual(seen, [1, 2]);
    assert.equal(calls.length, 2);
});

await test('refused every time: the transient budget (2 retries = 3 submissions) is spent, the ORIGINAL error is rethrown, and it classifies as arcade_unavailable', async () => {
    const cause = refusedErr();
    const { graph, calls } = scripted([{ ok: false, code: 'refused', cause }]);
    const waits: number[] = [];
    const err = await commitNodeBatchWithRetry(graph, async () => ({ checks: [], writes: [ins('n')] }), { sleep: async (ms) => { waits.push(ms); }, random: () => 0.999 }).then(() => null, (e) => e);
    assert.equal(err, cause);
    assert.equal(calls.length, 3);
    assert.equal(waits.length, 2);
    assert.ok(waits.every((w) => w < 400), 'bounded by the shared cap');
    assert.ok(!(err instanceof OutcomeUnknownError));
    assert.match(classifyItemWriteError(err).error, /^arcade_unavailable: /);
});

await test('refused retries do not eat the contention budget: refused x2 then contention x3 then ok still succeeds (4 contention attempts)', async () => {
    const R: NodeBatchOutcome = { ok: false, code: 'refused', cause: refusedErr() };
    const C: NodeBatchOutcome = { ok: false, code: 'contention' };
    const { graph, calls } = scripted([R, R, C, C, C, { ok: true, revisions: { n: 1 } }]);
    const out = await commitNodeBatchWithRetry(graph, async () => ({ checks: [], writes: [ins('n')] }), noSleep);
    assert.equal(out.ok, true);
    assert.equal(calls.length, 6);
});

await test('a reset is NOT refused: the arcade engine answers unknown and the batch is never blindly replayed', async () => {
    const { fake, g } = arcadeRig();
    fake.scriptError = resetErr();
    await assert.rejects(commitNodeBatchWithRetry(g as never, async () => ({ checks: [], writes: [ins('n')] }), noSleep), OutcomeUnknownError);
    assert.equal(fake.scripts.length, 1, 'submitted once');
});

// ───────────────────────── service: nodeUpsert ─────────────────────────
console.log('\nnodeUpsert (real SqliteGraph behind a spy handle)');

let seq = 0;
interface Rig {
    ws: string; graph: SqliteGraph; outbox: FileOutboxStore; handle: any;
    calls: Array<{ writes: NodeBatchWrite[]; supersedes?: NodeBatchSupersedes }>;
    beforeCommit: (() => Promise<void>) | null;
    override: ((real: () => Promise<NodeBatchOutcome>, n: number) => Promise<NodeBatchOutcome>) | null;
    /** supersedeNode calls: the NON-atomic path must not run when the commit was atomic. */
    legacy: number;
}
async function rig(): Promise<Rig> {
    const ws = `sa-${++seq}`;
    const graph = await sqlite(ws);
    const outbox = new FileOutboxStore(mkTmp('sa-o-'));
    const r = { ws, graph, outbox, calls: [], beforeCommit: null, override: null, legacy: 0 } as unknown as Rig;
    r.handle = new Proxy(graph as object, {
        get(t, p) {
            if (p === 'commitNodeBatch') {
                return async (checks: never, writes: NodeBatchWrite[], supersedes?: NodeBatchSupersedes) => {
                    r.calls.push({ writes, supersedes });
                    await r.beforeCommit?.();
                    const real = () => graph.commitNodeBatch(checks, writes, supersedes);
                    return r.override ? r.override(real, r.calls.length) : real();
                };
            }
            if (p === 'supersedeNode') return async (...a: unknown[]) => { r.legacy++; return (graph.supersedeNode as any)(...a); };
            const v = (t as any)[p];
            return typeof v === 'function' ? v.bind(t) : v;
        },
    });
    return r;
}
const nodeRows = async (r: Rig) => (await r.outbox.listUnfinished()).filter((e) => e.operationKind === 'node.upsert');
const edgeRows = async (r: Rig) => (await r.outbox.listUnfinished()).filter((e) => e.operationKind === 'edge.upsert');
const args = (r: Rig, id: string, extra: Record<string, unknown> = {}) =>
    ({ id, workspace: r.ws, ecosystem: '*', initiator: 'sa-test', skipEmbed: true, targetGraph: r.handle, nodeData: { ...input(id, `${id}-new`) }, ...extra });
const upsert = (r: Rig, id: string, extra: Record<string, unknown> = {}) => nodeUpsert(args(r, id, extra) as never, { outboxStore: r.outbox } as never) as Promise<any>;
const stateOf = async (r: Rig, succ: string, targets: string[]) => ({
    succ: !!(await r.graph.getNode(succ)),
    marks: await Promise.all(targets.map(async (t) => (await r.graph.getNode(t))!.supersededBy ?? '')),
    edges: await Promise.all(targets.map((t) => hasEdge(r.graph, succ, t))),
});

await test('multi-target: ONE atomic commit (no legacy supersedeNode), marks + edges, outbox: one node row + one edge row per target, all ready', async () => {
    const r = await rig();
    await seed(r.graph, 't1'); await seed(r.graph, 't2'); await seed(r.graph, 't3');
    const out = await upsert(r, 'n', { supersedes: ['t1', 't2', 't3'] });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(r.calls.length, 1);
    assert.equal(r.legacy, 0, 'the non-atomic path did not run');
    assert.deepEqual(await stateOf(r, 'n', ['t1', 't2', 't3']), { succ: true, marks: ['n', 'n', 'n'], edges: [1, 1, 1] });
    assert.equal(out.supersedesRepaired, undefined);
    assert.equal(out.node.revision, 4, 'successor 1 + 3 marks');
    assert.equal((await nodeRows(r)).length, 1);
    const es = await edgeRows(r);
    assert.equal(es.length, 3);
    assert.ok(es.every((e) => e.status === 'pending' && (e.payload as any).bidirectional === false && (e.payload as any).sourceId === 'n'), JSON.stringify(es.map((e) => [e.status, e.payload])));
    assert.deepEqual((await nodeRows(r)).map((e) => e.status), ['pending']);
});

await test('FAULT after the successor statement: the second target is claimed by a rival between plan and commit -> nothing written, no revision bump, zero outbox rows', async () => {
    const r = await rig();
    await seed(r.graph, 't1'); await seed(r.graph, 't2'); await seed(r.graph, 'rival');
    const before = [(await r.graph.getNode('t1'))!.revision, (await r.graph.getNode('t2'))!.revision];
    r.beforeCommit = async () => { r.beforeCommit = null; await r.graph.supersedeNode('t2', 'rival', 'x'); };
    const out = await upsert(r, 'n', { supersedes: ['t1', 't2'] });
    assert.equal(out.ok, false, JSON.stringify(out));
    assert.match(String(out.error), /supersed/i);
    assert.equal(await r.graph.getNode('n'), null, 'no successor');
    assert.equal((await r.graph.getNode('t1'))!.supersededBy ?? '', '', 'no mark on t1');
    assert.equal((await r.graph.getNode('t1'))!.revision, before[0]);
    assert.equal((await r.graph.getNode('t2'))!.revision, before[1]! + 1, 'only the rival bumped t2');
    assert.equal(await hasEdge(r.graph, 'n', 't1'), 0);
    assert.deepEqual(await nodeRows(r), []);
    assert.deepEqual(await edgeRows(r), []);
});

await test('CME x2 then success: one successor, marks + edges present, ONE set of outbox rows (no duplicates across attempts)', async () => {
    const r = await rig();
    await seed(r.graph, 't1'); await seed(r.graph, 't2');
    r.override = async (real, n) => (n <= 2 ? { ok: false, code: 'contention' } : real());
    const out = await upsert(r, 'n', { supersedes: ['t1', 't2'] });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(r.calls.length, 3);
    assert.deepEqual(await stateOf(r, 'n', ['t1', 't2']), { succ: true, marks: ['n', 'n'], edges: [1, 1] });
    assert.equal((await nodeRows(r)).length, 1);
    assert.equal((await edgeRows(r)).length, 2);
    assert.ok([...(await nodeRows(r)), ...(await edgeRows(r))].every((e) => e.status === 'pending'));
});

await test('contention exhausted: 503-class error, nothing written, every outbox row retracted', async () => {
    const r = await rig();
    await seed(r.graph, 't1');
    r.override = async () => ({ ok: false, code: 'contention' });
    await assert.rejects(upsert(r, 'n', { supersedes: ['t1'] }), /contention/);
    assert.equal(r.calls.length, 4);
    assert.equal(await r.graph.getNode('n'), null);
    assert.equal((await r.graph.getNode('t1'))!.supersededBy ?? '', '');
    assert.deepEqual(await nodeRows(r), []);
    assert.deepEqual(await edgeRows(r), []);
});

await test('unknown outcome that the re-read cannot prove: no blind retry; rows stay pending_commit for the settle sweep', async () => {
    const r = await rig();
    await seed(r.graph, 't1');
    r.override = async () => ({ ok: false, code: 'unknown' });
    await assert.rejects(upsert(r, 'n', { supersedes: ['t1'] }), /outcome_unknown|unknown/i);
    assert.equal(r.calls.length, 1);
    assert.deepEqual((await nodeRows(r)).map((e) => e.status), ['pending_commit']);
    assert.deepEqual((await edgeRows(r)).map((e) => e.status), ['pending_commit']);
});

await test('S1: a held precondition on a supersede write keeps working in the SAME commit; a stale one is refused with nothing written', async () => {
    const r = await rig();
    await seed(r.graph, 't1'); await seed(r.graph, 'x', 2);
    const ok = await upsert(r, 'n', { supersedes: ['t1'], preconditions: [{ id: 'x', revision: 2 }] });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(r.calls.length, 1);
    assert.deepEqual(await stateOf(r, 'n', ['t1']), { succ: true, marks: ['n'], edges: [1] });
    await seed(r.graph, 't2');
    const stale = await upsert(r, 'm', { supersedes: ['t2'], preconditions: [{ id: 'x', revision: 1 }] });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'precondition_failed');
    assert.equal(await r.graph.getNode('m'), null);
    assert.equal((await r.graph.getNode('t2'))!.supersededBy ?? '', '');
    assert.equal(await hasEdge(r.graph, 'm', 't2'), 0);
});

await test('another successor already holds a target: refused, nothing written (no successor, no partial marks)', async () => {
    const r = await rig();
    await seed(r.graph, 't1'); await seed(r.graph, 't2'); await seed(r.graph, 'rival');
    await r.graph.supersedeNode('t2', 'rival', 'x');
    const out = await upsert(r, 'n', { supersedes: ['t1', 't2'] });
    assert.equal(out.ok, false);
    assert.equal(out.code, 'already_superseded', JSON.stringify(out));
    assert.equal(await r.graph.getNode('n'), null);
    assert.equal((await r.graph.getNode('t1'))!.supersededBy ?? '', '');
});

await test('RE-SEND of a 3.34-style partial (mark but NO edge): ok + supersedesRepaired, edge written, mark not re-bumped', async () => {
    const r = await rig();
    await seed(r.graph, 't1'); await seed(r.graph, 't2');
    await upsert(r, 'n');                                   // the successor exists
    await r.graph.supersedeNode('t1', 'n', 'x');            // t1: mark only (the 3.34 partial)
    const t1Rev = (await r.graph.getNode('t1'))!.revision;
    const out = await upsert(r, 'n', { supersedes: ['t1', 't2'], ifRevision: (await r.graph.getNode('n'))!.revision });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.supersedesRepaired, ['t1'], 't2 was simply new, t1 was repaired');
    assert.deepEqual(await stateOf(r, 'n', ['t1', 't2']), { succ: true, marks: ['n', 'n'], edges: [1, 1] });
    assert.equal((await r.graph.getNode('t1'))!.revision, t1Rev, 'the existing mark is not bumped again');
});

await test('RE-SEND of a partial with the EDGE but no mark: repaired the other way round', async () => {
    const r = await rig();
    await seed(r.graph, 't1');
    await upsert(r, 'n');
    await r.graph.addEdge(edgeOf('n', 't1') as never);
    const out = await upsert(r, 'n', { supersedes: ['t1'], ifRevision: (await r.graph.getNode('n'))!.revision });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(out.supersedesRepaired, ['t1']);
    assert.deepEqual(await stateOf(r, 'n', ['t1']), { succ: true, marks: ['n'], edges: [1] });
    assert.equal(await hasEdge(r.graph, 'n', 't1'), 1, 'not duplicated');
});

await test('RE-SEND of a COMPLETE supersede: ok, nothing repaired, no new mark, edge not duplicated', async () => {
    const r = await rig();
    await seed(r.graph, 't1');
    assert.equal((await upsert(r, 'n', { supersedes: ['t1'] })).ok, true);
    const t1Rev = (await r.graph.getNode('t1'))!.revision;
    const again = await upsert(r, 'n', { supersedes: ['t1'], ifRevision: (await r.graph.getNode('n'))!.revision });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.supersedesRepaired, undefined);
    assert.equal((await r.graph.getNode('t1'))!.revision, t1Rev);
    assert.equal(await hasEdge(r.graph, 'n', 't1'), 1);
});

// ───────────────────────── bulk ─────────────────────────
console.log('\nPOST /api/nodes/bulk');

function req(body: unknown): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST', headers: {},
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(JSON.stringify(body), 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
function res(): ServerResponse & { _status: number; _body: string } {
    return { _status: 0, _body: '', writeHead(s: number) { (this as { _status: number })._status = s; return this; }, end(b?: string) { (this as { _body: string })._body = b ?? ''; } } as never;
}
async function bulk(r: Rig, nodes: Array<Record<string, unknown>>) {
    const out = res();
    await tryBulkWriteRoutes(req({ workspace: r.ws, nodes, embed: 'skip' }), out, '/api/nodes/bulk', '/api/nodes/bulk',
        { store: { loreGraph: r.handle, loreVerbatim: {} } as never, auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null, outboxStore: r.outbox });
    return JSON.parse(out._body) as { results: Array<Record<string, any>> };
}
const bnode = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], ...extra });

await test('bulk: a supersede item commits atomically (one batch, no legacy supersedeNode), marks + edges present', async () => {
    const r = await rig();
    await seed(r.graph, 't1'); await seed(r.graph, 't2');
    const body = await bulk(r, [bnode('n', { supersedes: ['t1', 't2'] })]);
    assert.equal(body.results[0]!['ok'], true, JSON.stringify(body));
    assert.equal(r.calls.length, 1);
    assert.equal(r.legacy, 0);
    assert.deepEqual(await stateOf(r, 'n', ['t1', 't2']), { succ: true, marks: ['n', 'n'], edges: [1, 1] });
    assert.equal(body.results[0]!['revision'], 3);
});

await test('bulk RE-SEND of a partial (successor + mark, no edge): ok + supersedesRepaired - NOT unchanged; complete re-send is unchanged', async () => {
    const r = await rig();
    await seed(r.graph, 't1');
    const first = await bulk(r, [bnode('n')]);                      // the successor alone
    assert.equal(first.results[0]!['ok'], true);
    await r.graph.supersedeNode('t1', 'n', 'x');                    // mark without edge
    const repaired = await bulk(r, [bnode('n', { supersedes: ['t1'] })]);
    assert.equal(repaired.results[0]!['ok'], true, JSON.stringify(repaired));
    assert.notEqual(repaired.results[0]!['unchanged'], true, 'a repair is a write, not unchanged');
    assert.deepEqual(repaired.results[0]!['supersedesRepaired'], ['t1']);
    assert.equal(await hasEdge(r.graph, 'n', 't1'), 1);
    const again = await bulk(r, [bnode('n', { supersedes: ['t1'] })]);
    assert.equal(again.results[0]!['ok'], true, JSON.stringify(again));
    assert.equal(again.results[0]!['unchanged'], true, 'fully consistent re-send stays unchanged');
    assert.equal(again.results[0]!['supersedesRepaired'], undefined);
});

await test('bulk: a target held by another successor refuses the item, nothing written', async () => {
    const r = await rig();
    await seed(r.graph, 't1'); await seed(r.graph, 't2'); await seed(r.graph, 'rival');
    await r.graph.supersedeNode('t2', 'rival', 'x');
    const body = await bulk(r, [bnode('n', { supersedes: ['t1', 't2'] })]);
    assert.equal(body.results[0]!['ok'], false);
    assert.match(String(body.results[0]!['error']), /already_superseded|already superseded/);
    assert.equal(await r.graph.getNode('n'), null);
    assert.equal((await r.graph.getNode('t1'))!.supersededBy ?? '', '');
});

// ───────────────────────── outbox settle ─────────────────────────
console.log('\npending_commit supersedes edge rows');

await test('settle: an edge row is flipped when the target shows the mark, retracted (after the grace) when it does not', async () => {
    const outbox = new FileOutboxStore(mkTmp('sa-settle-'));
    const { recordHotWrite } = await import('../packages/lore/src/outbox/hotLane.js');
    const mk = (s: string, t: string) => recordHotWrite(outbox, {
        workspace: 'w', operationKind: 'edge.upsert', initiator: 't', operation: 'edge.upsert', pendingCommit: true,
        payload: { sourceId: s, targetId: t, relation: 'supersedes', confidence: 'extracted', confidenceScore: 1.0, bidirectional: false },
    });
    const landed = await mk('n', 'ta'), lost = await mk('n', 'tb');
    const nodes: Record<string, any> = { ta: { id: 'ta', supersededBy: 'n' }, tb: { id: 'tb' } };
    const getNode = async (id: string) => nodes[id] ?? null;
    let r = await settlePendingCommits({ store: outbox, getNode, graceMs: 60_000 });
    assert.equal(r.flipped, 1); assert.equal(r.waiting, 1, 'the unproven row waits out the grace');
    r = await settlePendingCommits({ store: outbox, getNode, graceMs: 0, now: () => Date.now() + 1000 });
    assert.equal(r.retracted, 1);
    const left = await outbox.listUnfinished();
    assert.deepEqual(left.map((e) => e.id), [landed.id]);
    assert.notEqual(lost.id, landed.id);
});

for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
