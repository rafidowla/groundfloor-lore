/**
 * Conditional writes, phase 2b: per-item `ifRevision` and `preconditions`.
 *
 *   1. ifRevision on POST /api/nodes/bulk (match, stale, absent, legacy 0)
 *   2. two concurrent writers with the same ifRevision
 *   3. arcade DB-level: the conditional UPDATE matches 0 rows -> mismatch, no retry, row retracted
 *   4. preconditions (match, stale, absent, in-batch ordering, concurrent parent write, lock set)
 *   5. validation
 *   6. embedded nodeUpsert
 *   7. a caller sending neither field is unchanged
 *   8. with the replicator paused (outbox rows pending, never replayed), then replayed
 *   9. an outbox row never predicts a revision above the one that landed (earlier same-id item wrote nothing)
 *  10. ifRevision is update-only at the engine (a row deleted after the check is not re-created)
 *
 * Real SqliteGraph + FileOutboxStore + the real route handlers (fake req/res); the arcade
 * cases run the real ArcadeGraphStore over an in-memory fake of ArcadeHttp. No daemon.
 *
 * Run: npx tsx test/conditional-writes-phase2b-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import { ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { recordHotWrite } from '../packages/lore/src/outbox/hotLane.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { tryBulkListRoutes } from '../packages/lore/src/mcp/http/routes/bulkList.js';
import { handleGetNode } from '../packages/lore/src/mcp/http/routes/nodes/getNode.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { replayNodePayload, upsertKeepingRevision } from '../packages/lore/src/engines/graphShared/revision.js';
import { applyRecallOutcome } from '../packages/lore/src/recall/recallOutcome.js';
import { bulkLockIds, chunkSpecsForLocking, reconcileOutboxRevision } from '../packages/lore/src/mcp/http/routes/bulkWriteConditional.js';
import { BULK_LOCK_CHUNK_SIZE } from '../packages/lore/src/core/nodeWriteLock.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function fakePostReqWithBody(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}

interface Item { id: string; ok: boolean; error?: string; unchanged?: boolean; revision?: number; [k: string]: unknown }
interface BulkBody { ok: boolean; count: number; succeeded: number; results: Item[] }

// Loosely typed on purpose: both SqliteGraph and ArcadeGraphStore satisfy the route's graph handle.
interface Rig { graph: any; outbox: FileOutboxStore; ws: string }

function sqliteRig(tag: string): Rig {
    const ws = `cw2b-${tag}`;
    return { graph: new SqliteGraph(mkTmp('cw2b-g-'), { workspaceId: ws }), outbox: new FileOutboxStore(mkTmp('cw2b-o-')), ws };
}
async function bulk(r: Rig, nodes: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Promise<BulkBody> {
    const res = fakeRes();
    await tryBulkWriteRoutes(
        fakePostReqWithBody(JSON.stringify({ workspace: r.ws, nodes, embed: 'skip', ...extra })),
        res, '/api/nodes/bulk', '/api/nodes/bulk',
        { store: { loreGraph: r.graph, loreVerbatim: {} } as never, auditLog: { log: () => undefined } as never,
          deploymentMode: 'local', dataplane: null, outboxStore: r.outbox },
    );
    return JSON.parse(res._body) as BulkBody;
}
async function getNodeRoute(r: Rig, id: string): Promise<{ status: number; body: { node?: Record<string, unknown> } }> {
    const res = fakeRes();
    await handleGetNode(res, `/api/node?id=${encodeURIComponent(id)}&workspace=${r.ws}`,
        { store: { loreGraph: r.graph } as never, auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null } as never);
    return { status: res._status, body: JSON.parse(res._body) };
}
async function bulkListRoute(r: Rig): Promise<Array<Record<string, unknown>>> {
    const res = fakeRes();
    await tryBulkListRoutes(
        fakePostReqWithBody(JSON.stringify({ workspace: r.ws, limit: 100 })), res, '/api/nodes/bulk-list', '/api/nodes/bulk-list',
        { store: { loreGraph: r.graph } as never, deploymentMode: 'local', dataplane: null },
    );
    return (JSON.parse(res._body) as { nodes: Array<Record<string, unknown>> }).nodes;
}
const node = (id: string, label = id, extra: Record<string, unknown> = {}) => ({ id, type: 'decision', label, content: `content ${label}`, ...extra });
const pending = (r: Rig) => r.outbox.listPendingForWorkspace(r.ws, 10_000);
const pendingFor = async (r: Rig, id: string) => (await pending(r)).filter((e) => (e.payload as { id?: unknown })?.id === id && String(e.operationKind).startsWith('node.'));
const rev = async (r: Rig, id: string) => (await r.graph.getNode(id))?.revision;
const nodeInput = (id: string, label: string) => ({ id, type: 'note', label, content: label, tags: [], project: 'p', ecosystem: '*', metadata: '{}' });


type Row = Record<string, unknown>;
class FakeArcade {
    nodes = new Map<string, Row>();
    conditionalUpdates = 0;
    /** Runs right before a conditional UPDATE is judged; may move the row's revision as another daemon would. */
    beforeConditional: ((id: string, fake: FakeArcade) => void) | null = null;

    private rev(id: string): number { return Number(this.nodes.get(id)?.['revision'] ?? 0) || 0; }
    private put(id: string, assign: Row): void { this.nodes.set(id, { ...(this.nodes.get(id) ?? { id }), ...assign }); }

    async command(_db: string, sql: string, params: Row = {}): Promise<{ result: unknown[] }> {
        if (/^UPDATE LoreNode SET .* UPSERT WHERE id = :id$/s.test(sql)) {
            const { id, ...rest } = params; this.put(String(id), { ...rest, revision: this.rev(String(id)) + 1 });
            return { result: [{ count: 1 }] };
        }
        if (/^INSERT INTO LoreNode SET /.test(sql)) {
            const id = String(params['id']);
            if (this.nodes.has(id)) throw new ArcadeHttpError(503, 'Duplicated key [' + id + '] found on index LoreNode[id]');
            const revision = /revision = :revision$/.test(sql) ? Number(params['revision']) : 1;
            this.put(id, { ...params, revision });
            return { result: [{ count: 1 }] };
        }
        if (/ WHERE id = :id AND ifnull\(revision, 0\) = :expectedRevision$/.test(sql)) {
            this.conditionalUpdates++;
            const id = String(params['id']);
            this.beforeConditional?.(id, this);
            if (this.rev(id) !== params['expectedRevision']) return { result: [{ count: 0 }] };
            const { id: _i, expectedRevision: _e, ...rest } = params;
            this.put(id, { ...rest, revision: this.rev(id) + 1 });
            return { result: [{ count: 1 }] };
        }
        if (/ WHERE id = :id AND ifnull\(revision, 0\) < :revision$/.test(sql)) {
            const id = String(params['id']);
            if (!(this.rev(id) < Number(params['revision']))) return { result: [{ count: 0 }] };
            const { id: _i, ...rest } = params;
            this.put(id, rest);
            return { result: [{ count: 1 }] };
        }
        if (/^UPDATE LoreNode SET supersededBy = :newid/.test(sql)) {
            const id = String(params['id']);
            const row = this.nodes.get(id);
            const cur = row?.['supersededBy'];
            if (!row || (cur && cur !== '' && cur !== params['newid'])) return { result: [{ count: 0 }] };
            Object.assign(row, { supersededBy: params['newid'], supersededAt: params['at'], supersededReason: params['reason'] });
            if (/revision = ifnull\(revision, 0\) \+ 1/.test(sql)) row['revision'] = this.rev(id) + 1;
            return { result: [{ count: 1 }] };
        }
        if (/^UPDATE LoreNode SET revision = ifnull\(revision, 0\) \+ 1 WHERE id = :id$/.test(sql)) {
            const id = String(params['id']);
            if (this.nodes.has(id)) this.nodes.get(id)!['revision'] = this.rev(id) + 1;
            return { result: [{ count: this.nodes.has(id) ? 1 : 0 }] };
        }
        if (/^UPDATE LoreNode SET supersededBy = '', /.test(sql)) {
            const id = String(params['id']);
            const row = this.nodes.get(id);
            if (row) {
                Object.assign(row, { supersededBy: '', supersededAt: '', supersededReason: '' });
                if (/revision = ifnull\(revision, 0\) \+ 1/.test(sql)) row['revision'] = this.rev(id) + 1;
            }
            return { result: [{ count: row ? 1 : 0 }] };
        }
        if (/^UPDATE LoreNode SET .* WHERE id = :id$/s.test(sql) && /SET id = :id/.test(sql)) { // counter-only (keep) write
            const { id, ...rest } = params; this.put(String(id), rest);
            return { result: [{ count: 1 }] };
        }
        if (/^DELETE VERTEX FROM LoreNode WHERE id = :id$/.test(sql)) { this.nodes.delete(String(params['id'])); return { result: [] }; }
        return { result: [] }; // DDL
    }
    async commandScript(): Promise<{ result: unknown[] }> { return { result: [] }; }
    async query(_db: string, sql: string, params: Row = {}): Promise<{ result: Row[] }> {
        if (/FROM LoreNode WHERE id = :id LIMIT 1$/.test(sql)) { const r = this.nodes.get(String(params['id'])); return { result: r ? [{ ...r }] : [] }; }
        if (/FROM LoreNode WHERE id IN :ids$/.test(sql)) { return { result: (params['ids'] as string[]).filter((i) => this.nodes.has(i)).map((i) => ({ ...this.nodes.get(i)! })) }; }
        if (/FROM LoreNode\s+ORDER BY updatedAt DESC, id ASC LIMIT \d+$/.test(sql)) return { result: [...this.nodes.values()].map((r) => ({ ...r })) };
        return { result: [] };
    }
}

function arcadeRig(tag: string): { rig: Rig; fake: FakeArcade } {
    const fake = new FakeArcade();
    const graph = new ArcadeGraphStore({ tenantDb: 't', http: fake as never });
    return { rig: { graph, outbox: new FileOutboxStore(mkTmp('cw2b-ao-')), ws: `cw2b-arcade-${tag}` }, fake };
}
const legacyRow = (id: string): Row => ({ id, type: 'note', label: 'old', content: 'old', tags: '[]', project: '', ecosystem: '*', metadata: '{}', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
const nodePending = async (r: Rig) => (await pending(r)).filter((e) => String(e.operationKind).startsWith('node.'));
const snap = async (r: Rig, id: string) => { const n = await r.graph.getNode(id); return n ? { label: n.label, revision: n.revision, updatedAt: n.updatedAt } : null; };
/** Replay every pending node payload through the replay gate, as the replicator would. */
async function replayAll(r: Rig): Promise<void> {
    for (const e of await nodePending(r)) {
        if (e.operationKind !== 'node.upsert') continue;
        await replayNodePayload(r.graph, e.payload as Record<string, unknown>, async () => { throw new Error('legacy path must not run'); });
    }
}

// ───────────────────────── 1. ifRevision ─────────────────────────

console.log('\n1. ifRevision (bulk)\n');

await test('1. correct ifRevision lands at n+1; the outbox row carries n+1', async () => {
    const r = sqliteRig('ok'); await r.graph.initialize();
    await bulk(r, [node('a')]); // rev 1
    const out = await bulk(r, [node('a', 'a2', { ifRevision: 1 })]);
    assert.equal(out.results[0]!.ok, true, JSON.stringify(out));
    assert.equal(out.results[0]!.revision, 2);
    assert.equal(await rev(r, 'a'), 2);
    assert.equal((await r.graph.getNode('a')).label, 'a2');
    const rows = (await pendingFor(r, 'a')).map((e) => e.payload as Record<string, unknown>);
    assert.equal(rows[rows.length - 1]!['revision'], 2);
    assert.equal('ifRevision' in rows[rows.length - 1]!, false, 'the directive is never stored or recorded');
    assert.equal('ifRevision' in (await r.graph.getNode('a')), false);
});

await test('1b. stale ifRevision: revision_mismatch with currentRevision; node, updatedAt and outbox untouched; others in the batch unaffected', async () => {
    const r = sqliteRig('stale'); await r.graph.initialize();
    await bulk(r, [node('a')]); await bulk(r, [node('a', 'a2')]); // rev 2
    const before = await snap(r, 'a'); const rows = (await nodePending(r)).length;
    const out = await bulk(r, [node('a', 'LOST', { ifRevision: 1 }), node('other', 'ok')]);
    assert.equal(out.results[0]!.ok, false);
    assert.equal(out.results[0]!.error, 'revision_mismatch: a expected revision 1, found 2');
    assert.equal(out.results[0]!['currentRevision'], 2);
    assert.equal(out.results[1]!.ok, true, 'the other item is unaffected');
    assert.deepEqual(await snap(r, 'a'), before);
    assert.equal((await nodePending(r)).length, rows + 1, 'only the other item left an outbox row');
});

await test('1c. absent node: mismatch with found absent and currentRevision null; nothing created', async () => {
    const r = sqliteRig('absent'); await r.graph.initialize();
    for (const n of [0, 3]) {
        const out = await bulk(r, [node('ghost', 'g', { ifRevision: n })]);
        assert.equal(out.results[0]!.ok, false);
        assert.equal(out.results[0]!.error, `revision_mismatch: ghost expected revision ${n}, found absent`);
        assert.equal(out.results[0]!['currentRevision'], null);
    }
    assert.equal(await r.graph.getNode('ghost'), null);
    assert.equal((await nodePending(r)).length, 0);
});

await test('1d. ifRevision 0 matches a legacy row (no revision value) and lands at 1 (arcade fake)', async () => {
    const { rig: r, fake } = arcadeRig('legacy');
    fake.nodes.set('old', legacyRow('old'));
    const out = await bulk(r, [node('old', 'new', { ifRevision: 0 })]);
    assert.equal(out.results[0]!.ok, true, JSON.stringify(out));
    assert.equal(out.results[0]!.revision, 1);
    assert.equal(fake.nodes.get('old')!['revision'], 1);
    assert.equal((await bulk(r, [node('old', 'again', { ifRevision: 0 })])).results[0]!.ok, false, 'now at 1: 0 is stale');
});

await test('1e. ifRevision on sqlite works for a repeated id inside one batch (second sees the first\'s write)', async () => {
    const r = sqliteRig('twice'); await r.graph.initialize();
    await bulk(r, [node('a')]);
    const out = await bulk(r, [node('a', 'x', { ifRevision: 1 }), node('a', 'y', { ifRevision: 1 }), node('a', 'z', { ifRevision: 2 })]);
    assert.deepEqual(out.results.map((x) => x.ok), [true, false, true], JSON.stringify(out));
    assert.equal(out.results[1]!['currentRevision'], 2);
    assert.equal(await rev(r, 'a'), 3);
    assert.equal((await r.graph.getNode('a')).label, 'z');
});

await test('1f. ifRevision + supersedes: the guard still applies to the old ids; a lost-guard item leaves nothing', async () => {
    const r = sqliteRig('sup'); await r.graph.initialize();
    await bulk(r, [node('old'), node('mine'), node('rival')]);
    assert.equal((await bulk(r, [node('rival', 'rival', { supersedes: ['old'] })])).results[0]!.ok, true);
    const before = await snap(r, 'mine');
    const out = await bulk(r, [node('mine', 'mine2', { ifRevision: 1, supersedes: ['old'] })]);
    assert.equal(out.results[0]!.ok, false);
    assert.match(out.results[0]!.error!, /already_superseded/);
    assert.deepEqual(await snap(r, 'mine'), before);
    // the happy path: ifRevision + supersedes lands at n+1 + one bump for the claim
    const okOut = await bulk(r, [node('mine', 'mine3', { ifRevision: 1, supersedes: ['rival'] })]);
    assert.equal(okOut.results[0]!.ok, true, JSON.stringify(okOut));
    assert.equal(okOut.results[0]!.revision, 3, 'n+1 for the write, +1 for the claim');
});

await test('1g. pure retry of a supersede item carrying ifRevision: unchanged only at n+1+k; otherwise mismatch', async () => {
    const r = sqliteRig('retry'); await r.graph.initialize();
    await bulk(r, [node('old1'), node('old2'), node('new')]); // new at 1
    const first = await bulk(r, [node('new', 'new2', { ifRevision: 1, supersedes: ['old1', 'old2'] })]);
    assert.equal(first.results[0]!.ok, true, JSON.stringify(first));
    const landed = await rev(r, 'new');
    assert.equal(landed, 4, '1 + write + two claims');
    const retry = await bulk(r, [node('new', 'new2', { ifRevision: 1, supersedes: ['old1', 'old2'] })]);
    assert.equal(retry.results[0]!.unchanged, true, JSON.stringify(retry));
    assert.equal(retry.results[0]!.revision, 4);
    assert.equal(await rev(r, 'new'), 4);
    // somebody else moved the node since: ambiguous, so mismatch
    await bulk(r, [node('new', 'by someone else')]);
    const late = await bulk(r, [node('new', 'new2', { ifRevision: 1, supersedes: ['old1', 'old2'] })]);
    assert.equal(late.results[0]!.ok, false);
    assert.match(late.results[0]!.error!, /^revision_mismatch: new expected revision 1, found 5$/);
});

await test('1h. a graph with no revision support refuses ifRevision / preconditions instead of ignoring them', async () => {
    const r = sqliteRig('nosup'); await r.graph.initialize();
    await bulk(r, [node('a')]);
    const bare = Object.create(r.graph) as Record<string, unknown>;
    bare['upsertNodeAtRevision'] = undefined; bare['replayNodeAtRevision'] = undefined;
    const out = await bulk({ ...r, graph: bare }, [node('a', 'x', { ifRevision: 1 }), node('b', 'y', { preconditions: [{ id: 'a', revision: 1 }] }), node('c', 'plain')]);
    assert.match(out.results[0]!.error!, /^revision_unsupported/);
    assert.match(out.results[1]!.error!, /^revision_unsupported/);
    assert.equal(out.results[2]!.ok, true);
});

// ───────────────────────── 2. concurrency ─────────────────────────

console.log('\n2. concurrent ifRevision\n');

await test('2. two concurrent writers with the same ifRevision: exactly one wins', async () => {
    for (const eng of ['sqlite', 'arcade'] as const) {
        const r = eng === 'sqlite' ? sqliteRig('race') : arcadeRig('race').rig;
        if (eng === 'sqlite') await r.graph.initialize();
        await bulk(r, [node('n')]);
        const [x, y] = await Promise.all([bulk(r, [node('n', 'writer-x', { ifRevision: 1 })]), bulk(r, [node('n', 'writer-y', { ifRevision: 1 })])]);
        const oks = [x, y].filter((o) => o.results[0]!.ok);
        const bad = [x, y].filter((o) => !o.results[0]!.ok);
        assert.equal(oks.length, 1, `${eng}: ${JSON.stringify([x, y])}`);
        assert.equal(bad.length, 1);
        assert.match(bad[0]!.results[0]!.error!, /^revision_mismatch: n expected revision 1, found 2$/);
        assert.equal(bad[0]!.results[0]!['currentRevision'], 2);
        assert.equal(await rev(r, 'n'), 2);
    }
});

// ───────────────────────── 3. arcade DB level ─────────────────────────

console.log('\n3. arcade DB-level conflict\n');

await test('3. the conditional UPDATE matches 0 rows (another daemon moved it): mismatch, no retry, outbox row retracted', async () => {
    const { rig: r, fake } = arcadeRig('dbconflict');
    await bulk(r, [node('c')]);
    const rowsBefore = (await nodePending(r)).length;
    fake.beforeConditional = (id, f) => { f.nodes.get(id)!['revision'] = 2; f.nodes.get(id)!['label'] = 'other daemon'; };
    const before = fake.conditionalUpdates;
    const out = await bulk(r, [node('c', 'LOST', { ifRevision: 1 })]);
    assert.equal(out.results[0]!.ok, false, JSON.stringify(out));
    assert.equal(out.results[0]!.error, 'revision_mismatch: c expected revision 1, found 2');
    assert.equal(out.results[0]!['currentRevision'], 2);
    assert.equal(fake.conditionalUpdates - before, 1, 'one attempt: a conflict IS the answer');
    assert.equal(fake.nodes.get('c')!['label'], 'other daemon');
    assert.equal((await nodePending(r)).length, rowsBefore, 'the item\'s outbox row was retracted');
});

// ───────────────────────── 4. preconditions ─────────────────────────

console.log('\n4. preconditions\n');

await test('4. all preconditions match -> ok; the field is not stored', async () => {
    const r = sqliteRig('pc-ok'); await r.graph.initialize();
    await bulk(r, [node('p1'), node('p2')]);
    const out = await bulk(r, [node('kid', 'k', { preconditions: [{ id: 'p1', revision: 1 }, { id: 'p2', revision: 1 }] })]);
    assert.equal(out.results[0]!.ok, true, JSON.stringify(out));
    assert.equal(out.results[0]!.revision, 1);
    assert.equal('preconditions' in (await r.graph.getNode('kid')), false);
    const row = (await pendingFor(r, 'kid'))[0]!.payload as Record<string, unknown>;
    assert.equal('preconditions' in row, false);
});

await test('4b. stale preconditions: precondition_failed lists every failing entry; nothing written; others unaffected', async () => {
    const r = sqliteRig('pc-stale'); await r.graph.initialize();
    await bulk(r, [node('p1'), node('p2'), node('p3')]); await bulk(r, [node('p1', 'p1b')]);
    const rows = (await nodePending(r)).length;
    const out = await bulk(r, [node('kid', 'k', { preconditions: [{ id: 'p1', revision: 1 }, { id: 'p2', revision: 1 }, { id: 'p3', revision: 9 }] }), node('fine', 'f')]);
    const x = out.results[0]!;
    assert.equal(x.ok, false);
    assert.equal(x.error, 'precondition_failed: p1 expected revision 1, found 2 (and 1 more)');
    assert.deepEqual(x['failedPreconditions'], [{ id: 'p1', expected: 1, found: 2 }, { id: 'p3', expected: 9, found: 1 }]);
    assert.equal(await r.graph.getNode('kid'), null);
    assert.equal(out.results[1]!.ok, true);
    assert.equal((await nodePending(r)).length, rows + 1);
});

await test('4c. an absent precondition node fails with found null', async () => {
    const r = sqliteRig('pc-absent'); await r.graph.initialize();
    const out = await bulk(r, [node('kid', 'k', { preconditions: [{ id: 'nope', revision: 0 }] })]);
    assert.equal(out.results[0]!.error, 'precondition_failed: nope expected revision 0, found absent');
    assert.deepEqual(out.results[0]!['failedPreconditions'], [{ id: 'nope', expected: 0, found: null }]);
    assert.equal(await r.graph.getNode('kid'), null);
});

await test('4d. items apply in array order: a later item\'s precondition sees an earlier item\'s post-write revision', async () => {
    for (const eng of ['sqlite', 'arcade'] as const) {
        const r = eng === 'sqlite' ? sqliteRig('pc-order') : arcadeRig('pc-order').rig;
        if (eng === 'sqlite') await r.graph.initialize();
        await bulk(r, [node('par')]); // rev 1
        const out = await bulk(r, [
            node('par', 'par2'),                                             // bumps par to 2
            node('stale', 's', { preconditions: [{ id: 'par', revision: 1 }] }),
            node('fresh', 'f', { preconditions: [{ id: 'par', revision: 2 }] }),
        ]);
        assert.deepEqual(out.results.map((x) => x.ok), [true, false, true], `${eng}: ${JSON.stringify(out)}`);
        assert.deepEqual(out.results[1]!['failedPreconditions'], [{ id: 'par', expected: 1, found: 2 }]);
        assert.equal(await r.graph.getNode('stale'), null);
    }
});

await test('4e. a concurrent parent write vs a child with a precondition on the old revision: never both against the stale revision', async () => {
    const r = sqliteRig('pc-race'); await r.graph.initialize();
    for (let i = 0; i < 12; i++) {
        const par = `par${i}`, kid = `kid${i}`;
        await bulk(r, [node(par)]);
        const calls = [bulk(r, [node(par, 'moved')]), bulk(r, [node(kid, 'k', { preconditions: [{ id: par, revision: 1 }] })])];
        if (i % 2) calls.reverse();
        const outs = await Promise.all(calls);
        const parentOut = (i % 2 ? outs[1]! : outs[0]!).results[0]!;
        const kidOut = (i % 2 ? outs[0]! : outs[1]!).results[0]!;
        assert.equal(parentOut.ok, true);
        assert.equal(await rev(r, par), 2);
        if (kidOut.ok) {
            // the child saw revision 1 before the parent moved: its write is ordered strictly before the parent's
            const kidNode = await r.graph.getNode(kid);
            const parNode = await r.graph.getNode(par);
            assert.ok(kidNode.updatedAt <= parNode.updatedAt, 'the child was written before the parent moved');
        } else {
            assert.deepEqual(kidOut['failedPreconditions'], [{ id: par, expected: 1, found: 2 }], 'a failing child saw the parent AFTER its write');
            assert.equal(await r.graph.getNode(kid), null);
        }
    }
});

await test('4f. precondition ids join the item\'s own chunk lock set; a conditional item gets a chunk of its own; order is preserved', async () => {
    const mk = (i: number, n: number) => ({ idx: i, raw: { id: `item${i}` }, preconditions: Array.from({ length: n }, (_, j) => ({ id: `dep${i}-${j}`, revision: 1 })) });
    const one = mk(0, 3);
    assert.deepEqual(bulkLockIds([one]).sort(), ['dep0-0', 'dep0-1', 'dep0-2', 'item0']);
    const specs = [mk(0, 32), mk(1, 32), mk(2, 5), mk(3, 5)];
    const chunks = chunkSpecsForLocking(specs);
    assert.deepEqual(chunks.map((c) => c.map((s) => s.idx)), [[0], [1], [2], [3]], 'each conditional item is alone in its chunk, order preserved');
    for (const c of chunks) assert.ok(bulkLockIds(c).length <= BULK_LOCK_CHUNK_SIZE);
    // without preconditions: unchanged 50-item chunks
    const plain = Array.from({ length: 120 }, (_, i) => ({ idx: i, raw: { id: `p${i}` } }));
    assert.deepEqual(chunkSpecsForLocking(plain).map((c) => c.length), [50, 50, 20]);
    // and it runs end to end
    const r = sqliteRig('pc-chunks'); await r.graph.initialize();
    await bulk(r, [node('dep0-0'), node('dep1-0')]);
    const out = await bulk(r, [
        node('i0', 'a', { preconditions: Array.from({ length: 32 }, (_, j) => ({ id: j === 0 ? 'dep0-0' : `x${j}`, revision: j === 0 ? 1 : 0 })) }),
        node('i1', 'b', { preconditions: [{ id: 'dep1-0', revision: 1 }] }),
    ]);
    assert.equal(out.results[0]!.ok, false, 'x1..x31 are absent');
    assert.equal((out.results[0]!['failedPreconditions'] as unknown[]).length, 31);
    assert.equal(out.results[1]!.ok, true);
});

await test('4g. a concurrent plain write to a precondition node waits for the chunk (lock), so the check and the write are one critical section', async () => {
    const r = sqliteRig('pc-lock'); await r.graph.initialize();
    await bulk(r, [node('par')]);
    // slow the child's graph write; a parent write issued meanwhile must not slip in between check and write
    const realAt = r.graph.upsertNodeAtRevision.bind(r.graph);
    r.graph.upsertNodeAtRevision = async (n: any, e: number, at: string) => {
        if (n.id === 'kid') await new Promise((res) => setTimeout(res, 40));
        return realAt(n, e, at);
    };
    const [kid, par] = await Promise.all([
        bulk(r, [node('kid', 'k', { preconditions: [{ id: 'par', revision: 1 }] })]),
        new Promise<BulkBody>((res) => setTimeout(() => res(bulk(r, [node('par', 'p2')])), 5)),
    ]);
    assert.equal(kid.results[0]!.ok, true, JSON.stringify(kid));
    assert.equal(par.results[0]!.ok, true);
    assert.equal(await rev(r, 'par'), 2);
});

// ───────────────────────── 5. validation ─────────────────────────

console.log('\n5. validation\n');

await test('5. bad ifRevision / preconditions are per-item validation errors; nothing is written; neighbours are fine', async () => {
    const r = sqliteRig('valid'); await r.graph.initialize();
    await bulk(r, [node('p')]);
    const rows = (await nodePending(r)).length;
    const bad: Array<[string, Record<string, unknown>, RegExp]> = [
        ['string', { ifRevision: '1' }, /^invalid_if_revision/],
        ['negative', { ifRevision: -1 }, /^invalid_if_revision/],
        ['fraction', { ifRevision: 1.5 }, /^invalid_if_revision/],
        ['boolean', { ifRevision: true }, /^invalid_if_revision/],
        ['null', { ifRevision: null }, /^invalid_if_revision/],
        ['ifAbsent+ifRevision', { ifRevision: 1, ifAbsent: true }, /^invalid_if_revision.*ifAbsent/],
        ['preconditions not array', { preconditions: { id: 'p', revision: 1 } }, /^invalid_preconditions/],
        ['entry not object', { preconditions: ['p'] }, /^invalid_preconditions/],
        ['entry id not string', { preconditions: [{ id: 5, revision: 1 }] }, /^invalid_preconditions/],
        ['entry revision negative', { preconditions: [{ id: 'p', revision: -1 }] }, /^invalid_preconditions/],
        ['entry revision fraction', { preconditions: [{ id: 'p', revision: 0.5 }] }, /^invalid_preconditions/],
        ['entry revision string', { preconditions: [{ id: 'p', revision: '1' }] }, /^invalid_preconditions/],
        ['unsafe id (NUL)', { preconditions: [{ id: 'a\0b', revision: 1 }] }, /^invalid_preconditions/],
        ['empty id', { preconditions: [{ id: '', revision: 1 }] }, /^invalid_preconditions/],
        ['own id', { preconditions: [{ id: 'victim', revision: 1 }] }, /^invalid_preconditions.*own id/],
        ['33 entries', { preconditions: Array.from({ length: 33 }, (_, i) => ({ id: `d${i}`, revision: 1 })) }, /^invalid_preconditions.*at most 32/],
    ];
    const out = await bulk(r, [...bad.map(([, extra]) => node('victim', 'v', extra)), node('fine', 'f')]);
    bad.forEach(([name, , re], i) => {
        assert.equal(out.results[i]!.ok, false, name);
        assert.match(out.results[i]!.error!, re, name);
        assert.equal(out.results[i]!.id, 'victim');
    });
    assert.equal(out.results[bad.length]!.ok, true);
    assert.equal(await r.graph.getNode('victim'), null);
    assert.equal((await nodePending(r)).length, rows + 1);
    // exactly 32 is fine (all absent -> a precondition failure, not a validation error)
    const edge = await bulk(r, [node('v32', 'v', { preconditions: Array.from({ length: 32 }, (_, i) => ({ id: `d${i}`, revision: 0 })) })]);
    assert.match(edge.results[0]!.error!, /^precondition_failed/);
});

// ───────────────────────── 6. embedded ─────────────────────────

console.log('\n6. embedded nodeUpsert\n');

const upArgs = (r: Rig, id: string, label: string, extra: Record<string, unknown> = {}) => ({
    id, workspace: r.ws, ecosystem: '*', initiator: 'cw2b-test', skipEmbed: true, targetGraph: r.graph, nodeData: nodeInput(id, label), ...extra,
});

await test('6. nodeUpsert with ifRevision and preconditions: ok, then mismatch / precondition_failed / validation codes', async () => {
    const r = sqliteRig('emb'); await r.graph.initialize();
    const hooks = { outboxStore: r.outbox };
    assert.equal((await nodeUpsert(upArgs(r, 'dep', 'dep') as never, hooks as never)).ok, true);
    assert.equal((await nodeUpsert(upArgs(r, 'e', 'v1') as never, hooks as never)).ok, true);
    const ok = await nodeUpsert(upArgs(r, 'e', 'v2', { ifRevision: 1, preconditions: [{ id: 'dep', revision: 1 }] }) as never, hooks as never);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal((ok as { node: LoreNode }).node.revision, 2);

    const rows = (await nodePending(r)).length; const before = await snap(r, 'e');
    const stale = await nodeUpsert(upArgs(r, 'e', 'LOST', { ifRevision: 1 }) as never, hooks as never) as Record<string, any>;
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'revision_mismatch');
    assert.equal(stale.currentRevision, 2);
    assert.equal(stale.error.message, 'revision_mismatch: e expected revision 1, found 2');
    const pre = await nodeUpsert(upArgs(r, 'e', 'LOST', { preconditions: [{ id: 'dep', revision: 4 }, { id: 'gone', revision: 0 }] }) as never, hooks as never) as Record<string, any>;
    assert.equal(pre.code, 'precondition_failed');
    assert.deepEqual(pre.failedPreconditions, [{ id: 'dep', expected: 4, found: 1 }, { id: 'gone', expected: 0, found: null }]);
    const absent = await nodeUpsert(upArgs(r, 'nobody', 'x', { ifRevision: 0 }) as never, hooks as never) as Record<string, any>;
    assert.equal(absent.code, 'revision_mismatch'); assert.equal(absent.currentRevision, null);
    assert.equal(((await nodeUpsert(upArgs(r, 'e', 'x', { ifRevision: -1 }) as never, hooks as never)) as Record<string, any>).code, 'invalid_if_revision');
    assert.equal(((await nodeUpsert(upArgs(r, 'e', 'x', { ifRevision: 2, ifAbsent: true }) as never, hooks as never)) as Record<string, any>).code, 'invalid_if_revision');
    assert.equal(((await nodeUpsert(upArgs(r, 'e', 'x', { preconditions: [{ id: 'e', revision: 1 }] }) as never, hooks as never)) as Record<string, any>).code, 'invalid_preconditions');
    assert.deepEqual(await snap(r, 'e'), before, 'no refused call changed the node');
    assert.equal((await nodePending(r)).length, rows, 'and none left an outbox row');
});

await test('6b. embedded: concurrent ifRevision writers (same lock), and an arcade DB-level conflict is a mismatch with no retry', async () => {
    const r = sqliteRig('emb-race'); await r.graph.initialize();
    const hooks = { outboxStore: r.outbox };
    await nodeUpsert(upArgs(r, 'e', 'v1') as never, hooks as never);
    const outs = await Promise.all([1, 2, 3].map((i) => nodeUpsert(upArgs(r, 'e', `w${i}`, { ifRevision: 1 }) as never, hooks as never)));
    assert.equal(outs.filter((o) => o.ok).length, 1);
    assert.deepEqual(outs.filter((o) => !o.ok).map((o) => (o as { code: string }).code), ['revision_mismatch', 'revision_mismatch']);

    const { rig: a, fake } = arcadeRig('emb-db');
    await nodeUpsert(upArgs(a, 'c', 'v1') as never, { outboxStore: a.outbox } as never);
    const rows = (await nodePending(a)).length;
    fake.beforeConditional = (id, f) => { f.nodes.get(id)!['revision'] = 2; };
    const before = fake.conditionalUpdates;
    const out = await nodeUpsert(upArgs(a, 'c', 'LOST', { ifRevision: 1 }) as never, { outboxStore: a.outbox } as never) as Record<string, any>;
    assert.equal(out.code, 'revision_mismatch'); assert.equal(out.currentRevision, 2);
    assert.equal(fake.conditionalUpdates - before, 1, 'no retry');
    assert.equal((await nodePending(a)).length, rows, 'row retracted');
});

await test('6c. embedded: the lock set includes the precondition ids (a write to a precondition node waits)', async () => {
    const r = sqliteRig('emb-lock'); await r.graph.initialize();
    const hooks = { outboxStore: r.outbox };
    await nodeUpsert(upArgs(r, 'par', 'v1') as never, hooks as never);
    const outs = await Promise.all([
        nodeUpsert(upArgs(r, 'par', 'v2') as never, hooks as never),
        nodeUpsert(upArgs(r, 'kid', 'k', { preconditions: [{ id: 'par', revision: 1 }] }) as never, hooks as never),
    ]);
    assert.equal(outs[0]!.ok, true);
    if (!outs[1]!.ok) assert.deepEqual((outs[1] as Record<string, any>).failedPreconditions, [{ id: 'par', expected: 1, found: 2 }]);
    else assert.equal(await r.graph.getNode('kid') !== null, true);
});

// ───────────────────────── 7. unchanged behaviour ─────────────────────────

console.log('\n7. a caller sending neither field\n');

await test('7. results are identical to before: no new keys, same revisions, same error shapes', async () => {
    const r = sqliteRig('plain'); await r.graph.initialize();
    const out = await bulk(r, [node('a'), node('a', 'a2'), { id: 'bad', type: 'x' } as never, node('b', 'b', { ifAbsent: true }), node('b', 'b2', { ifAbsent: true })]);
    assert.deepEqual(out.results.map((x) => Object.keys(x).sort()), [
        ['id', 'ok', 'revision'], ['id', 'ok', 'revision'], ['error', 'ok'], ['id', 'ok', 'revision'], ['error', 'id', 'ok'],
    ]);
    assert.deepEqual(out.results.slice(0, 2).map((x) => x.revision), [1, 2]);
    const { rig: a } = arcadeRig('plain');
    const outA = await bulk(a, [node('a'), node('a', 'a2')]);
    assert.deepEqual(outA.results.map((x) => Object.keys(x).sort()), [['id', 'ok', 'revision'], ['id', 'ok', 'revision']]);
    // embedded: no conditions -> no new fields on the result
    const emb = await nodeUpsert(upArgs(r, 'z', 'z') as never, { outboxStore: r.outbox } as never) as Record<string, unknown>;
    assert.equal(emb['ok'], true); assert.equal('currentRevision' in emb, false);
});

// ───────────────────────── 8. replicator paused ─────────────────────────

console.log('\n8. replicator paused (accepted, not yet replayed)\n');

await test('8. ifRevision, concurrent ifRevision and in-batch preconditions all decide on the accepted state; replaying the pending rows afterwards changes nothing', async () => {
    const r = sqliteRig('paused'); await r.graph.initialize();
    await bulk(r, [node('n'), node('par')]);
    // nothing has been replayed: every write so far is only accepted (graph inline + pending outbox row)
    assert.ok((await nodePending(r)).length >= 2);
    const okOut = await bulk(r, [node('n', 'n2', { ifRevision: 1 })]);
    assert.equal(okOut.results[0]!.ok, true);
    const [x, y] = await Promise.all([bulk(r, [node('n', 'x', { ifRevision: 2 })]), bulk(r, [node('n', 'y', { ifRevision: 2 })])]);
    assert.equal([x, y].filter((o) => o.results[0]!.ok).length, 1);
    const batch = await bulk(r, [node('par', 'par2'), node('s', 's', { preconditions: [{ id: 'par', revision: 1 }] }), node('f', 'f', { preconditions: [{ id: 'par', revision: 2 }] })]);
    assert.deepEqual(batch.results.map((o) => o.ok), [true, false, true]);
    const stale = await bulk(r, [node('n', 'late', { ifRevision: 1 })]);
    assert.equal(stale.results[0]!['currentRevision'], 3);

    const before = { n: await snap(r, 'n'), par: await snap(r, 'par'), f: await snap(r, 'f'), s: await snap(r, 's') };
    assert.equal(before.s, null);
    await replayAll(r);
    assert.deepEqual({ n: await snap(r, 'n'), par: await snap(r, 'par'), f: await snap(r, 'f'), s: await snap(r, 's') }, before, 'replay moved nothing');
    assert.equal(before.n!.revision, 3);
});

await test('8b. arcade: the same with the replicator paused', async () => {
    const { rig: r } = arcadeRig('paused');
    await bulk(r, [node('n'), node('par')]);
    const [x, y] = await Promise.all([bulk(r, [node('n', 'x', { ifRevision: 1 })]), bulk(r, [node('n', 'y', { ifRevision: 1 })])]);
    assert.equal([x, y].filter((o) => o.results[0]!.ok).length, 1);
    const batch = await bulk(r, [node('par', 'par2'), node('s', 's', { preconditions: [{ id: 'par', revision: 1 }] }), node('f', 'f', { preconditions: [{ id: 'par', revision: 2 }] })]);
    assert.deepEqual(batch.results.map((o) => o.ok), [true, false, true]);
    const before = { n: await snap(r, 'n'), par: await snap(r, 'par'), f: await snap(r, 'f') };
    await replayAll(r);
    assert.deepEqual({ n: await snap(r, 'n'), par: await snap(r, 'par'), f: await snap(r, 'f') }, before);
});

// ───────────────────────── 9. outbox rows never predict a revision above the one that landed ─────────────────────────

console.log('\n9. outbox row revision == landed revision (earlier same-id item wrote nothing)\n');

/** Bring `id` to revision `n` with n plain writes. */
async function climb(r: Rig, id: string, n: number): Promise<void> { for (let i = 0; i < n; i++) await bulk(r, [node(id, `v${i + 1}`)]); }
/** Make the next engine write of a node labelled `label` throw, as a failing substrate would. */
function failWritesOf(r: Rig, label: string): void {
    const orig = r.graph.upsertNodeAtRevision.bind(r.graph) as (...a: unknown[]) => Promise<unknown>;
    r.graph.upsertNodeAtRevision = async (n: { label: string }, ...rest: unknown[]) => {
        if (n.label === label) throw new Error('injected substrate failure');
        return orig(n, ...rest);
    };
}
async function assertRowsNeverAbove(r: Rig, id: string, landed: number): Promise<void> {
    const revs = (await pendingFor(r, id)).filter((e) => e.operationKind === 'node.upsert').map((e) => (e.payload as { revision?: number }).revision ?? 0);
    assert.ok(revs.every((x) => x <= landed), `an outbox row for ${id} is above the landed revision ${landed}: ${JSON.stringify(revs)}`);
    assert.ok(revs.includes(landed), `no outbox row for ${id} at the landed revision ${landed}: ${JSON.stringify(revs)}`);
}
async function assertReplayInert(r: Rig, id: string, landed: number): Promise<void> {
    const before = await snap(r, id);
    assert.equal(before!.revision, landed);
    await replayAll(r);
    assert.deepEqual(await snap(r, id), before, 'replaying every outbox row moved the revision or updatedAt');
}

for (const eng of ['sqlite', 'arcade'] as const) {
    const mk = (tag: string): Rig => { if (eng === 'sqlite') { const r = sqliteRig(tag); return r; } return arcadeRig(tag).rig; };
    const init = async (r: Rig): Promise<void> => { if (eng === 'sqlite') await r.graph.initialize(); };

    await test(`9a [${eng}]. A fails its precondition, B (same id, plain) lands at 6 and its row says 6; replay leaves 6`, async () => {
        const r = mk('9a'); await init(r);
        await bulk(r, [node('P')]); await climb(r, 'X', 5);
        const out = await bulk(r, [node('X', 'A', { ifRevision: 5, preconditions: [{ id: 'P', revision: 99 }] }), node('X', 'B')]);
        assert.equal(out.results[0]!.ok, false);
        assert.match(out.results[0]!.error!, /^precondition_failed/);
        assert.equal(out.results[1]!.ok, true, JSON.stringify(out));
        assert.equal(out.results[1]!.revision, 6);
        assert.equal(await rev(r, 'X'), 6);
        assert.equal((await r.graph.getNode('X')).label, 'B');
        await assertRowsNeverAbove(r, 'X', 6);
        await assertReplayInert(r, 'X', 6);
    });

    await test(`9b [${eng}]. A is unconditional and its write throws (phase 2a), B lands at 6 and its row says 6; replay leaves 6`, async () => {
        const r = mk('9b'); await init(r);
        await climb(r, 'X', 5);
        failWritesOf(r, 'A');
        const out = await bulk(r, [node('X', 'A'), node('X', 'B')]);
        assert.equal(out.results[0]!.ok, false);
        assert.match(out.results[0]!.error!, /injected substrate failure/);
        assert.equal(out.results[1]!.ok, true, JSON.stringify(out));
        assert.equal(out.results[1]!.revision, 6);
        await assertRowsNeverAbove(r, 'X', 6);
        assert.equal((await pendingFor(r, 'X')).some((e) => (e.payload as { label?: string }).label === 'A'), false, 'the failed item left no row');
        await assertReplayInert(r, 'X', 6);
    });

    await test(`9c [${eng}]. a chain of three: A fails, B and C (same id) land at 6 and 7, each row equals its landed revision`, async () => {
        const r = mk('9c'); await init(r);
        await climb(r, 'X', 5);
        failWritesOf(r, 'A');
        const out = await bulk(r, [node('X', 'A'), node('X', 'B'), node('X', 'C')]);
        assert.deepEqual(out.results.map((o) => o.ok), [false, true, true], JSON.stringify(out));
        assert.deepEqual([out.results[1]!.revision, out.results[2]!.revision], [6, 7]);
        const revs = (await pendingFor(r, 'X')).map((e) => (e.payload as { revision?: number }).revision!).filter((x) => x > 5).sort();
        assert.deepEqual(revs, [6, 7]);
        await assertReplayInert(r, 'X', 7);
        assert.equal((await r.graph.getNode('X')).label, 'C');
    });

    await test(`9d [${eng}]. nothing changes for a clean chain: the rows are the ones recorded up front (no re-record)`, async () => {
        const r = mk('9d'); await init(r);
        await climb(r, 'X', 2);
        const idsBefore = new Set((await pending(r)).map((e) => e.id));
        const out = await bulk(r, [node('X', 'B'), node('X', 'C')]);
        assert.deepEqual(out.results.map((o) => o.revision), [3, 4]);
        const fresh = (await pending(r)).filter((e) => !idsBefore.has(e.id));
        assert.deepEqual(fresh.map((e) => (e.payload as { revision?: number }).revision), [3, 4]);
        await assertReplayInert(r, 'X', 4);
    });
}

await test('9e. a cross-daemon bump makes the write land ABOVE the prediction; the row is corrected to the landed revision (arcade fake)', async () => {
    const { rig: r, fake } = arcadeRig('9e');
    await bulk(r, [node('n')]); // rev 1
    fake.beforeConditional = (id, f) => { f.beforeConditional = null; f.nodes.get(id)!['revision'] = 3; }; // another daemon, between our read and our UPDATE
    const out = await bulk(r, [node('n', 'mine')]);
    assert.equal(out.results[0]!.ok, true, JSON.stringify(out));
    assert.equal(out.results[0]!.revision, 4);
    await assertRowsNeverAbove(r, 'n', 4);
    await assertReplayInert(r, 'n', 4);
});

await test('9f. reconcileOutboxRevision: a pending row is re-recorded at the landed revision (same updatedAt); a claimed row is left alone; equal is a no-op', async () => {
    const r = sqliteRig('9f');
    const stamp = { expected: 5, updatedAt: '2026-01-01T00:00:00.000Z' };
    const rec = async (revision: number) => {
        const e = await recordHotWrite(r.outbox, { workspace: r.ws, operationKind: 'node.upsert', payload: { id: 'X', label: 'B', updatedAt: stamp.updatedAt, revision } });
        return e;
    };
    const base = { store: r.outbox, stamp, workspace: r.ws, id: 'X' };
    const same = await rec(6);
    assert.equal(await reconcileOutboxRevision({ ...base, entry: same, landed: 6 }), same, 'equal: untouched');
    const high = await rec(7);
    const fixed = await reconcileOutboxRevision({ ...base, entry: high, landed: 6 });
    assert.notEqual(fixed!.id, high.id);
    assert.deepEqual({ ...(fixed!.payload as object) }, { id: 'X', label: 'B', updatedAt: stamp.updatedAt, revision: 6 });
    assert.equal((await r.outbox.listPendingForWorkspace(r.ws, 100)).some((e) => e.id === high.id), false, 'the too-high row is gone');
    const lowRow = await rec(5);
    assert.equal((await reconcileOutboxRevision({ ...base, entry: lowRow, landed: 8 }))!.payload && ((await r.outbox.listPendingForWorkspace(r.ws, 100)).find((e) => e.id === lowRow.id) === undefined), true, 'a row below the landed revision is corrected too (equal is the goal)');
    const claimed = await rec(7);
    await r.outbox.markEntryStatus!(claimed.id, 'replicating');
    const before = (await r.outbox.listUnfinished()).length;
    assert.equal(await reconcileOutboxRevision({ ...base, entry: claimed, landed: 6 }), claimed, 'claimed: returned as is');
    assert.equal((await r.outbox.listUnfinished()).length, before, 'claimed: nothing recorded or removed');
    assert.equal(await reconcileOutboxRevision({ ...base, entry: undefined, landed: 6 }), undefined);
    assert.equal(await reconcileOutboxRevision({ ...base, entry: high, stamp: undefined, landed: 6 }), high, 'an unstamped item has no prediction to correct');
});

// ───────────────────────── 10. ifRevision never creates ─────────────────────────

console.log('\n10. ifRevision is update-only at the engine\n');

await test('10a. ifRevision 0, the row deleted between the check and the write (arcade fake): revision_mismatch, currentRevision null, nothing created', async () => {
    const { rig: r, fake } = arcadeRig('10a');
    fake.nodes.set('old', legacyRow('old')); // revision 0
    const orig = r.graph.upsertNodeAtRevision.bind(r.graph);
    r.graph.upsertNodeAtRevision = async (...a: unknown[]) => { fake.nodes.delete('old'); return orig(...a); }; // another daemon deletes it after the check
    const out = await bulk(r, [node('old', 'resurrect', { ifRevision: 0 })]);
    assert.equal(out.results[0]!.ok, false, JSON.stringify(out));
    assert.equal(out.results[0]!.error, 'revision_mismatch: old expected revision 0, found absent');
    assert.equal(out.results[0]!['currentRevision'], null);
    assert.equal(fake.nodes.has('old'), false, 'nothing was created');
    assert.equal((await nodePending(r)).length, 0, 'the item\'s outbox row was retracted');
});

await test('10b. the same on sqlite (real): the row deleted between the check and the write', async () => {
    const r = sqliteRig('10b'); await r.graph.initialize();
    await bulk(r, [node('a')]);
    const orig = r.graph.upsertNodeAtRevision.bind(r.graph);
    r.graph.upsertNodeAtRevision = async (...a: unknown[]) => { await r.graph.deleteNode('a'); return orig(...a); };
    const out = await bulk(r, [node('a', 'resurrect', { ifRevision: 1 })]);
    assert.equal(out.results[0]!.ok, false, JSON.stringify(out));
    assert.equal(out.results[0]!['currentRevision'], null);
    assert.equal(await r.graph.getNode('a'), null, 'nothing was created');
});

await test('10c. engine verb: mustExist updates a present row (keeping outcome counters) and refuses an absent one; without it an absent row is still created (2a unchanged)', async () => {
    for (const eng of ['sqlite', 'arcade'] as const) {
        const r = eng === 'sqlite' ? sqliteRig('10c') : arcadeRig('10c').rig;
        if (eng === 'sqlite') await r.graph.initialize();
        const at = new Date().toISOString();
        await assert.rejects(() => r.graph.upsertNodeAtRevision(nodeInput('g', 'x'), 0, at, true), (e: Error) => e.name === 'RevisionConflictError', `${eng}: absent + mustExist`);
        assert.equal(await r.graph.getNode('g'), null, `${eng}: not created`);
        const created = await r.graph.upsertNodeAtRevision(nodeInput('g', 'x'), 0, at);
        assert.equal(created.revision, 1, `${eng}: plain conditional write still creates`);
        const updated = await r.graph.upsertNodeAtRevision(nodeInput('g', 'y'), 1, at, true);
        assert.equal(updated.revision, 2, `${eng}: mustExist updates a present row`);
        assert.equal((await r.graph.getNode('g')).label, 'y');
        await assert.rejects(() => r.graph.upsertNodeAtRevision(nodeInput('g', 'z'), 1, at, true), (e: Error) => e.name === 'RevisionConflictError', `${eng}: stale + mustExist`);
    }
});

// ───────────────────────── 11. same-id items never share a chunk ─────────────────────────

console.log('\n11. duplicate item ids land in separate chunks\n');

await test('11a. chunkSpecsForLocking starts a new chunk at a repeated item id; unique ids keep the plain size-based split', () => {
    const sp = (id: string, idx: number, extra: Record<string, unknown> = {}) => ({ idx, raw: { id }, ...extra });
    const ids = (cs: Array<Array<{ raw: { id?: unknown } }>>) => cs.map((c) => c.map((s) => s.raw.id as string));
    assert.deepEqual(ids(chunkSpecsForLocking([sp('X', 0), sp('Y', 1), sp('X', 2), sp('Z', 3), sp('X', 4)])), [['X', 'Y'], ['X', 'Z'], ['X']]);
    assert.deepEqual(ids(chunkSpecsForLocking([sp('X', 0), sp('X', 1)])), [['X'], ['X']]);
    // A conditional item (ifRevision / preconditions) is always alone in its chunk; plain items around it keep the size-based split.
    assert.deepEqual(ids(chunkSpecsForLocking([sp('X', 0), sp('Y', 1, { preconditions: [{ id: 'X', revision: 1 }] }), sp('Z', 2), sp('W', 3)])), [['X'], ['Y'], ['Z', 'W']]);
    assert.deepEqual(ids(chunkSpecsForLocking([sp('X', 0), sp('Y', 1, { ifRevision: 3 }), sp('Z', 2, { ifRevision: 0 })])), [['X'], ['Y'], ['Z']]);
    assert.deepEqual(ids(chunkSpecsForLocking([sp('Y', 0, { preconditions: [] }), sp('Z', 1)])), [['Y', 'Z']], 'an empty preconditions list is not a condition');
    // Unique ids: one chunk up to BULK_LOCK_CHUNK_SIZE, results order untouched.
    const many = Array.from({ length: BULK_LOCK_CHUNK_SIZE + 3 }, (_, i) => sp(`u${i}`, i));
    const chunks = chunkSpecsForLocking(many);
    assert.deepEqual(chunks.map((c) => c.length), [BULK_LOCK_CHUNK_SIZE, 3]);
    assert.deepEqual(chunks.flat().map((s) => s.idx), many.map((s) => s.idx));
});

await test('11b. a batch repeating an id: results stay in array order, each later item builds on the earlier one (Phase 1 see-each-other)', async () => {
    const r = sqliteRig('11b'); await r.graph.initialize();
    const out = await bulk(r, [node('X', 'one'), node('Y', 'y'), node('X', 'two'), node('X', 'three')]);
    assert.deepEqual(out.results.map((o) => [o.id, o.ok]), [['X', true], ['Y', true], ['X', true], ['X', true]]);
    assert.deepEqual(out.results.map((o) => o.revision), [1, 1, 2, 3]);
    assert.equal((await r.graph.getNode('X')).label, 'three');
    await assertReplayInert(r, 'X', 3);
    // ifAbsent on a later repeat sees the earlier write and is refused.
    const out2 = await bulk(r, [node('N', 'a', { ifAbsent: true }), node('N', 'b', { ifAbsent: true })]);
    assert.equal(out2.results[0]!.ok, true);
    assert.equal(out2.results[1]!.ok, false);
});

await test('11c. without revision support a unique-id chunk is still ONE bulkUpsertNodes call; a repeated id costs one call per chunk', async () => {
    const r = sqliteRig('11c'); await r.graph.initialize();
    r.graph.upsertNodeAtRevision = undefined; // a graph with no per-node revision: the legacy single-call path
    let calls = 0;
    const orig = r.graph.bulkUpsertNodes.bind(r.graph);
    r.graph.bulkUpsertNodes = async (...a: unknown[]) => { calls++; return orig(...a); };
    const out = await bulk(r, [node('a'), node('b'), node('c')]);
    assert.equal(out.succeeded, 3);
    assert.equal(calls, 1, 'unique ids: one substrate call');
    calls = 0;
    const out2 = await bulk(r, [node('a', 'a1'), node('b'), node('a', 'a2')]);
    assert.equal(out2.succeeded, 3);
    assert.equal(calls, 2, 'a repeated id splits the batch into two chunks');
    assert.equal((await r.graph.getNode('a')).label, 'a2');
});

for (const eng of ['sqlite', 'arcade'] as const) {
    await test(`11d [${eng}]. A fails its precondition, B plain; the replicator claims EVERY row (removeIfPending false for all): A records no row so nothing of it can be claimed; B ends at 6 after replay`, async () => {
        const r = eng === 'sqlite' ? sqliteRig('11d') : arcadeRig('11d').rig;
        if (eng === 'sqlite') await r.graph.initialize();
        await bulk(r, [node('P')]); await climb(r, 'X', 5);
        const ob = r.outbox as unknown as { removeIfPending: (id: string) => Promise<boolean> };
        ob.removeIfPending = async () => false;
        const spy = spyRecords(r);
        const out = await bulk(r, [node('X', 'A', { ifRevision: 5, preconditions: [{ id: 'P', revision: 99 }] }), node('X', 'B')]);
        assert.equal(out.results[0]!.ok, false);
        assert.equal(out.results[1]!.ok, true, JSON.stringify(out));
        assert.equal(out.results[1]!.revision, 6);
        assert.deepEqual(spy.labels(), ['B'], 'only B ever recorded a row');
        const revs = (await pendingFor(r, 'X')).filter((e) => e.operationKind === 'node.upsert').map((e) => (e.payload as { revision?: number }).revision ?? 0);
        assert.ok(revs.every((x) => x <= 6), `a row is above the landed revision: ${JSON.stringify(revs)}`);
        await assertReplayInert(r, 'X', 6);
    });
}

// ───────────────────────── 12. a failed condition records no outbox row ─────────────────────────

console.log('\n12. failed conditions record nothing\n');

/** Count the node.upsert rows recorded through the store across a request (the net pending count hides record-then-retract). */
function spyRecords(r: Rig): { labels(): string[]; reset(): void } {
    let seen: string[] = [];
    const store = r.outbox as unknown as { record(e: { operationKind?: string; payload?: { label?: string } }): Promise<unknown>; batchRecord(es: Array<{ operationKind?: string; payload?: { label?: string } }>): Promise<unknown> };
    const note = (e: { operationKind?: string; payload?: { label?: string } }): void => { if (e.operationKind === 'node.upsert') seen.push(String(e.payload?.label)); };
    const rec = store.record.bind(store), batch = store.batchRecord.bind(store);
    store.record = async (e) => { note(e); return rec(e); };
    store.batchRecord = async (es) => { es.forEach(note); return batch(es); };
    return { labels: () => seen, reset: () => { seen = []; } };
}

for (const eng of ['sqlite', 'arcade'] as const) {
    const mk = async (tag: string): Promise<Rig> => { const r = eng === 'sqlite' ? sqliteRig(tag) : arcadeRig(tag).rig; if (eng === 'sqlite') await r.graph.initialize(); return r; };

    await test(`12a [${eng}]. a failed precondition records ZERO rows for the item; revision stays n; replay of every row leaves n`, async () => {
        const r = await mk('12a');
        await bulk(r, [node('P')]); await climb(r, 'X', 3);
        const spy = spyRecords(r);
        const out = await bulk(r, [node('X', 'refused', { preconditions: [{ id: 'P', revision: 99 }] })]);
        assert.match(out.results[0]!.error!, /^precondition_failed/);
        assert.deepEqual(spy.labels(), [], 'no node.upsert row was ever recorded');
        assert.equal(await rev(r, 'X'), 3);
        assert.equal((await r.graph.getNode('X')).label, 'v3');
        await assertReplayInert(r, 'X', 3);
    });

    await test(`12b [${eng}]. an ifRevision mismatch records ZERO rows; revision stays n; replay leaves n`, async () => {
        const r = await mk('12b');
        await climb(r, 'X', 3);
        const spy = spyRecords(r);
        const out = await bulk(r, [node('X', 'refused', { ifRevision: 2 })]);
        assert.match(out.results[0]!.error!, /^revision_mismatch/);
        assert.equal(out.results[0]!['currentRevision'], 3);
        assert.deepEqual(spy.labels(), []);
        assert.equal(await rev(r, 'X'), 3);
        await assertReplayInert(r, 'X', 3);
    });

    await test(`12c [${eng}]. a mixed batch records rows only for the items that pass`, async () => {
        const r = await mk('12c');
        await climb(r, 'X', 2);
        const spy = spyRecords(r);
        const out = await bulk(r, [node('a', 'plain'), node('X', 'bad', { ifRevision: 9 }), node('X', 'good', { ifRevision: 2 }), node('b', 'bad2', { preconditions: [{ id: 'X', revision: 2 }] }), node('c', 'tail')]);
        assert.deepEqual(out.results.map((o) => o.ok), [true, false, true, false, true], JSON.stringify(out));
        assert.deepEqual(spy.labels().sort(), ['good', 'plain', 'tail']);
        assert.equal(await rev(r, 'X'), 3);
        await assertReplayInert(r, 'X', 3);
    });

    await test(`12d [${eng}]. array order: an earlier item bumps the parent; a later precondition on the old revision fails, on the new one passes`, async () => {
        const r = await mk('12d');
        await bulk(r, [node('P')]); // P at 1
        const out = await bulk(r, [
            node('P', 'P2'),                                                // P -> 2
            node('c1', 'stale', { preconditions: [{ id: 'P', revision: 1 }] }), // old revision: fails
            node('c2', 'fresh', { preconditions: [{ id: 'P', revision: 2 }] }), // new revision: passes
        ]);
        assert.deepEqual(out.results.map((o) => o.ok), [true, false, true], JSON.stringify(out));
        assert.deepEqual(out.results[1]!['failedPreconditions'], [{ id: 'P', expected: 1, found: 2 }]);
        assert.equal(await r.graph.getNode('c1'), null);
        assert.equal(await rev(r, 'c2'), 1);
    });
}

for (const eng of ['sqlite', 'arcade'] as const) {
    await test(`12e [${eng}]. cross-daemon conflict AFTER the item's row was claimed: another daemon moved the node past n; replay of every row leaves the other daemon's state`, async () => {
        const r = eng === 'sqlite' ? sqliteRig('12e') : arcadeRig('12e').rig;
        if (eng === 'sqlite') await r.graph.initialize();
        await climb(r, 'X', 2);
        // The replicator claims every row it is asked about (removeIfPending false), as if it had already taken the item's row.
        (r.outbox as unknown as { removeIfPending: (id: string) => Promise<boolean> }).removeIfPending = async () => false;
        const orig = r.graph.upsertNodeAtRevision.bind(r.graph);
        r.graph.upsertNodeAtRevision = async (...a: unknown[]) => { // another daemon writes twice between our check and our conditional write
            await r.graph.upsertNode({ ...nodeInput('X', 'other'), updatedAt: new Date().toISOString() });
            await r.graph.upsertNode({ ...nodeInput('X', 'other2'), updatedAt: new Date().toISOString() });
            return orig(...a);
        };
        const out = await bulk(r, [node('X', 'refused', { ifRevision: 2 })]);
        assert.match(out.results[0]!.error!, /^revision_mismatch/, JSON.stringify(out));
        assert.equal(await rev(r, 'X'), 4);
        await replayAll(r);
        const after = await r.graph.getNode('X');
        assert.equal(after.revision, 4, 'replay of the claimed row and its compensation moved nothing');
        assert.equal(after.label, 'other2');
    });
}

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
