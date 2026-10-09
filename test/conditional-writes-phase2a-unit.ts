#!/usr/bin/env tsx
/**
 * conditional-writes-phase2a-unit.ts — conditional writes, phase 2a: the per-node
 * `revision` (storage, bump, replay gating, read surfaces).
 *
 *   1. lifecycle bumps (sqlite real; arcade statements via the fake)
 *   2. `revision` on GET /api/node, POST /api/nodes/bulk-list, POST /api/nodes/bulk
 *   3. outbox replay gating (G5: replay no longer rewrites updatedAt / overwrites newer writes)
 *   4. sqlite migration from a pre-revision database
 *   5. arcade conditional-bump conflict + outbox payload revision
 *   6. concurrent in-process upserts of one id
 *   7. compensating outbox rows carry the restored revision (replay is gated)
 *   8. maintenance content writes (archive, schema-ops metadata/type) bump
 *
 * Real SqliteGraph + real FileOutboxStore + the real route handlers (fake req/res);
 * the arcade cases run the real ArcadeGraphStore over an in-memory fake of
 * ArcadeHttp (no ArcadeDB, no daemon).
 *
 * Run: npx tsx test/conditional-writes-phase2a-unit.ts
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
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { tryBulkListRoutes } from '../packages/lore/src/mcp/http/routes/bulkList.js';
import { handleGetNode } from '../packages/lore/src/mcp/http/routes/nodes/getNode.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { replayNodePayload, upsertKeepingRevision } from '../packages/lore/src/engines/graphShared/revision.js';
import { applyRecallOutcome } from '../packages/lore/src/recall/recallOutcome.js';
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
    const ws = `cw2a-${tag}`;
    return { graph: new SqliteGraph(mkTmp('cw2a-g-'), { workspaceId: ws }), outbox: new FileOutboxStore(mkTmp('cw2a-o-')), ws };
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

// ───────────────────────── 1. lifecycle ─────────────────────────

console.log('\n1. revision lifecycle (sqlite)\n');

await test('1. new node = 1, upsert = 2, supersede bumps BOTH, unsupersede + mark-stale bump, retries and counters do not', async () => {
    const r = sqliteRig('life');
    await r.graph.initialize();
    const first = await bulk(r, [node('a'), node('b'), node('c')]);
    assert.deepEqual(first.results.map((x) => x.revision), [1, 1, 1]);
    assert.equal((await bulk(r, [node('a', 'again')])).results[0]!.revision, 2);

    assert.equal((await r.graph.supersedeNode('a', 'b')).ok, true);
    assert.equal(await rev(r, 'a'), 3, 'old node bumped');
    assert.equal(await rev(r, 'b'), 2, 'new node bumped too');
    assert.equal((await r.graph.supersedeNode('a', 'b')).ok, true);
    assert.equal(await rev(r, 'a'), 3, 'an idempotent supersede retry does not bump the old node');
    assert.equal(await rev(r, 'b'), 2, '... nor the new one');

    assert.equal(await r.graph.unsupersedeNode('a'), true);
    assert.equal(await rev(r, 'a'), 4, 'unsupersede bumps');
    assert.equal(await r.graph.unsupersedeNode('a'), true);
    assert.equal(await rev(r, 'a'), 4, 'un-superseding a current node is not a change');

    assert.equal(await r.graph.markStaleByIds(['c']), 1);
    assert.equal(await rev(r, 'c'), 2, 'mark-stale bumps');
    await r.graph.markStaleByIds(['c']);
    assert.equal(await rev(r, 'c'), 2, 're-marking an already-stale node does not bump');

    // counters and access times are not mutations of the node
    await r.graph.stampAccessTimes([{ id: 'c', accessedAt: new Date().toISOString(), retrievedAt: new Date().toISOString() }]);
    assert.equal(await rev(r, 'c'), 2, 'access stamping does not bump');
    // (sqlite persists outcome counters through its aux store, not the node row; the arcade case 2c checks the stored counter)
    const before = await r.graph.getNode('c');
    await upsertKeepingRevision(r.graph, { ...before, label: 'counter-only write path', success_count: 3 } as LoreNode);
    const after = await r.graph.getNode('c');
    assert.equal(after.label, 'counter-only write path', 'the keep verb did write');
    assert.equal(after.revision, 2, 'but the revision did not move');
});

await test('1b. the recall-outcome counter write goes through the keep-revision verb: no bump', async () => {
    const r = sqliteRig('outcome');
    await r.graph.initialize();
    await bulk(r, [node('o')]);
    const auxStore = {
        recordOutcome: () => undefined,
        getOutcomeCount: () => ({ success: 2, failure: 0, partial: 0 }),
        incrementCounter: () => undefined,
    };
    const out = await applyRecallOutcome({ auxStore, graph: r.graph, nodeId: 'o', workspace: r.ws, outcome: 'success', recordedBy: 'test', principal: 'test' } as never);
    assert.equal((out as { ok: boolean }).ok, true, JSON.stringify(out));
    const n = await r.graph.getNode('o');
    assert.equal(n.revision, 1, 'outcome counters do not move the revision');
});

await test('1c. an upsert that is an idempotent Phase 1 retry (unchanged: true) does not bump', async () => {
    const r = sqliteRig('unchanged');
    await r.graph.initialize();
    await bulk(r, [node('old')]);
    assert.equal((await bulk(r, [node('new', 'new', { supersedes: ['old'] })])).results[0]!.ok, true);
    const oldRev = await rev(r, 'old'), newRev = await rev(r, 'new');
    const retry = await bulk(r, [node('new', 'new', { supersedes: ['old'] })]);
    assert.equal(retry.results[0]!.unchanged, true, JSON.stringify(retry));
    assert.equal(retry.results[0]!.revision, newRev, 'the result reports the stored revision');
    assert.equal(await rev(r, 'old'), oldRev);
    assert.equal(await rev(r, 'new'), newRev);
});

// ───────────────────────── 2. read surfaces ─────────────────────────

console.log('\n2. revision on the read surfaces\n');

await test('2. sqlite: GET /api/node, bulk-list rows and bulk results carry the revision', async () => {
    const r = sqliteRig('read');
    await r.graph.initialize();
    await bulk(r, [node('x'), node('y')]);
    const again = await bulk(r, [node('x', 'x2')]);
    assert.equal(again.results[0]!.revision, 2);
    const got = await getNodeRoute(r, 'x');
    assert.equal(got.status, 200);
    assert.equal(got.body.node!['revision'], 2);
    const rows = await bulkListRoute(r);
    assert.deepEqual(rows.map((n) => [n['id'], n['revision']]).sort(), [['x', 2], ['y', 1]]);
});

console.log('\narcade (fake ArcadeHttp)\n');

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
    return { rig: { graph, outbox: new FileOutboxStore(mkTmp('cw2a-ao-')), ws: `cw2a-arcade-${tag}` }, fake };
}

await test('2b. arcade: bulk results, GET /api/node and bulk-list carry the revision; rows with no value read 0', async () => {
    const { rig: r, fake } = arcadeRig('read');
    const out = await bulk(r, [node('p'), node('q')]);
    assert.deepEqual(out.results.map((x) => x.revision), [1, 1], JSON.stringify(out));
    assert.equal((await bulk(r, [node('p', 'p2')])).results[0]!.revision, 2);
    // a row written before this change: the property does not exist
    fake.nodes.set('legacy', { id: 'legacy', type: 'note', label: 'old', content: 'old', tags: '[]', project: '', ecosystem: '*', metadata: '{}', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' });
    assert.equal((await getNodeRoute(r, 'p')).body.node!['revision'], 2);
    assert.equal((await getNodeRoute(r, 'legacy')).body.node!['revision'], 0, 'a pre-change row reads 0');
    const rows = await bulkListRoute(r);
    assert.deepEqual(rows.map((n) => [n['id'], n['revision']]).sort(), [['legacy', 0], ['p', 2], ['q', 1]]);
});

await test('2c. arcade: supersede bumps both nodes, unsupersede bumps, an idempotent retry does not; counters keep the revision', async () => {
    const { rig: r } = arcadeRig('life');
    await bulk(r, [node('a'), node('b')]);
    assert.equal((await r.graph.supersedeNode('a', 'b')).ok, true);
    assert.equal(await rev(r, 'a'), 2);
    assert.equal(await rev(r, 'b'), 2);
    assert.equal((await r.graph.supersedeNode('a', 'b')).ok, true);
    assert.equal(await rev(r, 'a'), 2, 'idempotent retry: no bump');
    assert.equal(await rev(r, 'b'), 2);
    await r.graph.unsupersedeNode('a');
    assert.equal(await rev(r, 'a'), 3);
    const n = await r.graph.getNode('b');
    await upsertKeepingRevision(r.graph, { ...n, success_count: 4 } as LoreNode);
    assert.equal((await r.graph.getNode('b')).success_count, 4);
    assert.equal(await rev(r, 'b'), 2, 'counter write kept the revision');
});

// ───────────────────────── 3. replay gating ─────────────────────────

console.log('\n3. outbox replay gating\n');

const payloadOf = (n: LoreNode, extra: Record<string, unknown> = {}) => ({ ...n, ...extra }) as unknown as Record<string, unknown>;

await test('3. replay of an OLDER payload after a newer write changes nothing (revision and updatedAt stay)', async () => {
    const r = sqliteRig('replay-old');
    await r.graph.initialize();
    await bulk(r, [node('n', 'v1')]);
    const v1 = await r.graph.getNode('n');
    await new Promise((res) => setTimeout(res, 5));
    await bulk(r, [node('n', 'v2')]);
    const v2 = await r.graph.getNode('n');
    assert.equal(v2.revision, 2);
    let fallbacks = 0;
    await replayNodePayload(r.graph, payloadOf(v1, { label: 'STALE', revision: 1 }), async () => { fallbacks++; });
    const after = await r.graph.getNode('n');
    assert.equal(fallbacks, 0, 'a revisioned payload never takes the legacy path');
    assert.equal(after.label, 'v2');
    assert.equal(after.revision, 2);
    assert.equal(after.updatedAt, v2.updatedAt);
});

await test('3b. replay of the LATEST payload after the inline write changes nothing: revision and updatedAt are the inline write\'s', async () => {
    const r = sqliteRig('replay-latest');
    await r.graph.initialize();
    await bulk(r, [node('n', 'v1')]);
    const [entry] = await pendingFor(r, 'n');
    const payload = entry!.payload as Record<string, unknown>;
    assert.equal(payload['revision'], 1, 'the outbox row carries the revision the write produced');
    const stored = await r.graph.getNode('n');
    assert.equal(payload['updatedAt'], stored.updatedAt, 'and the SAME updatedAt (stamped once)');
    await replayNodePayload(r.graph, payload, async () => { throw new Error('legacy path must not run'); });
    const after = await r.graph.getNode('n');
    assert.equal(after.revision, 1, 'replay does not bump');
    assert.equal(after.updatedAt, stored.updatedAt, 'G5: replay does not rewrite updatedAt');
});

await test('3c. replay when the inline write never happened applies with the payload\'s revision and updatedAt (verbatim)', async () => {
    const r = sqliteRig('replay-apply');
    await r.graph.initialize();
    const at = '2021-02-03T04:05:06.789Z';
    const applied = await replayNodePayload(r.graph, { ...nodeInput('ghost', 'from outbox'), updatedAt: at, revision: 4 }, async () => { throw new Error('legacy path must not run'); });
    assert.equal(applied, true);
    const n = await r.graph.getNode('ghost');
    assert.equal(n.label, 'from outbox');
    assert.equal(n.revision, 4);
    assert.equal(n.updatedAt, at);
    // and over an OLDER stored row too
    await bulk(r, [node('behind', 'old')]);
    assert.equal(await replayNodePayload(r.graph, { ...nodeInput('behind', 'newer'), updatedAt: at, revision: 7 }, async () => undefined), true);
    const b = await r.graph.getNode('behind');
    assert.deepEqual([b.label, b.revision, b.updatedAt], ['newer', 7, at]);
});

await test('3d. a legacy payload (no revision) keeps today\'s replay: the plain upsert runs and bumps', async () => {
    const r = sqliteRig('replay-legacy');
    await r.graph.initialize();
    await bulk(r, [node('n', 'v1')]);
    let ran = 0;
    await replayNodePayload(r.graph, nodeInput('n', 'legacy payload'), async () => { ran++; await r.graph.upsertNode(nodeInput('n', 'legacy payload')); });
    assert.equal(ran, 1);
    const n = await r.graph.getNode('n');
    assert.equal(n.label, 'legacy payload');
    assert.equal(n.revision, 2, 'today\'s behaviour: a legacy replay is a plain upsert');
});

await test('3e. arcade: the same gate through the fake — older skips, newer applies verbatim, absent inserts', async () => {
    const { rig: r, fake } = arcadeRig('replay');
    await bulk(r, [node('n', 'v1')]);
    await bulk(r, [node('n', 'v2')]);
    const cur = await r.graph.getNode('n');
    assert.equal(await r.graph.replayNodeAtRevision({ ...cur, label: 'STALE', revision: 1 }), false);
    assert.equal(fake.nodes.get('n')!['label'], 'v2');
    assert.equal(await r.graph.replayNodeAtRevision({ ...cur, label: 'v2', revision: 2 }), false, 'equal revision: already applied');
    const at = '2022-01-01T00:00:00.000Z';
    assert.equal(await r.graph.replayNodeAtRevision({ ...cur, label: 'v9', revision: 9, updatedAt: at }), true);
    assert.deepEqual([fake.nodes.get('n')!['label'], fake.nodes.get('n')!['revision'], fake.nodes.get('n')!['updatedAt']], ['v9', 9, at]);
    assert.equal(await r.graph.replayNodeAtRevision({ ...cur, id: 'fresh', label: 'f', revision: 3, updatedAt: at, createdAt: at }), true);
    assert.deepEqual([fake.nodes.get('fresh')!['revision'], fake.nodes.get('fresh')!['updatedAt']], [3, at]);
});

// ───────────────────────── 4. sqlite migration ─────────────────────────

console.log('\n4. sqlite migration\n');

await test('4. a database created before `revision` existed opens, gains the column, reads 0, and the next write is 1 / 1 + n', async () => {
    const dir = mkTmp('cw2a-mig-');
    // Create the DB the old way: open a fresh graph, then drop the column to recreate the pre-change shape.
    const seed = new SqliteGraph(dir, { workspaceId: 'cw2a-mig' });
    await seed.initialize();
    await seed.upsertNode(nodeInput('old1', 'one'));
    await seed.upsertNode(nodeInput('old2', 'two'));
    await seed.close?.();
    const file = path.join(dir, '.lore', 'graph.sqlite');
    const raw = new Database(file);
    raw.exec('ALTER TABLE nodes DROP COLUMN revision');
    assert.equal((raw.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).some((c) => c.name === 'revision'), false, 'the old shape has no revision column');
    raw.close();

    const g = new SqliteGraph(dir, { workspaceId: 'cw2a-mig' });
    await g.initialize();
    const cols = new Database(file, { readonly: true });
    const col = (cols.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string; notnull: number; dflt_value: string }>).find((c) => c.name === 'revision');
    cols.close();
    assert.ok(col, 'the column was added on open');
    assert.equal(col!.notnull, 1);
    assert.equal(String(col!.dflt_value), '0');
    assert.equal((await g.getNode('old1'))!.revision, 0, 'existing rows read 0');
    assert.equal((await g.getNode('old2'))!.revision, 0);
    await g.upsertNode(nodeInput('old1', 'one!'));
    assert.equal((await g.getNode('old1'))!.revision, 1, 'the next write gives 1');
    await g.upsertNode(nodeInput('fresh', 'fresh'));
    assert.equal((await g.getNode('fresh'))!.revision, 1, 'a new node is 1');
    await g.close?.();

    // idempotent: opening an already-migrated database again changes nothing
    const again = new SqliteGraph(dir, { workspaceId: 'cw2a-mig' });
    await again.initialize();
    assert.equal((await again.getNode('old1'))!.revision, 1);
    await again.close?.();
});

await test('4b. an OLDER Lore on the migrated database still works: its explicit-column reads and writes ignore the extra column', async () => {
    const dir = mkTmp('cw2a-mig-old-');
    const g = new SqliteGraph(dir, { workspaceId: 'cw2a-mig-old' });
    await g.initialize();
    await g.upsertNode(nodeInput('n', 'new lore'));
    await g.close?.();
    const file = path.join(dir, '.lore', 'graph.sqlite');
    const db = new Database(file);
    // What a 3.31 build does: an INSERT/UPDATE naming its own columns, and a SELECT of its own columns.
    db.prepare(`UPDATE nodes SET label = 'old lore wrote this' WHERE id = 'n'`).run();
    db.prepare(`INSERT INTO nodes (id, type, label, content, tags, project, ecosystem, metadata, createdAt, updatedAt) VALUES ('m', 'note', 'm', 'm', '[]', 'p', '*', '{}', 'x', 'y')`).run();
    const row = db.prepare('SELECT id, label FROM nodes WHERE id = ?').get('n') as { label: string };
    assert.equal(row.label, 'old lore wrote this');
    assert.equal((db.prepare('SELECT revision FROM nodes WHERE id = ?').get('m') as { revision: number }).revision, 0, 'a row the old build inserted reads 0 (the column default)');
    db.close();
});

// ───────────────────────── 5. arcade conditional-bump conflict ─────────────────────────

console.log('\n5. arcade conditional-bump conflict\n');

await test('5. the first conditional UPDATE matches 0 rows (another daemon moved it): re-read, retry, land the right revision; the outbox row matches', async () => {
    const { rig: r, fake } = arcadeRig('conflict');
    const hooks = { outboxStore: r.outbox };
    const args = (label: string) => ({
        id: 'c1', workspace: r.ws, ecosystem: '*', initiator: 'cw2a-test', skipEmbed: true, targetGraph: r.graph,
        nodeData: nodeInput('c1', label),
    });
    const created = await nodeUpsert(args('v1') as never, hooks as never);
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal((created as { node: LoreNode }).node.revision, 1);

    // Another daemon bumps the row (revision 1 -> 2) just before our conditional UPDATE is judged — once.
    let moved = false;
    fake.beforeConditional = (id, f) => { if (!moved) { moved = true; f.nodes.get(id)!['revision'] = 2; f.nodes.get(id)!['label'] = 'other daemon'; } };
    const before = fake.conditionalUpdates;
    const out = await nodeUpsert(args('v2') as never, hooks as never);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(fake.conditionalUpdates - before, 2, 'first attempt matched 0 rows, the retry landed');
    assert.equal((out as { node: LoreNode }).node.revision, 3, 'the retry was based on the re-read revision (2) and landed 3');
    assert.equal(fake.nodes.get('c1')!['label'], 'v2');
    assert.equal(fake.nodes.get('c1')!['revision'], 3);

    // The outbox: the conflicted attempt's row was taken back; the live row's revision is what was written.
    const rows = (await pendingFor(r, 'c1')).map((e) => e.payload as Record<string, unknown>);
    const forV2 = rows.filter((p) => p['label'] === 'v2');
    assert.equal(forV2.length, 1, 'exactly one outbox row for the v2 write (the conflicted one was retracted)');
    assert.equal(forV2[0]!['revision'], 3, 'its payload revision equals the revision stored');
    assert.equal(forV2[0]!['updatedAt'], fake.nodes.get('c1')!['updatedAt'], 'and its updatedAt is the stored one (stamped once)');
});

await test('5b. arcade: five straight conflicts exhaust the bounded retries -> the write fails and leaves no outbox row', async () => {
    const { rig: r, fake } = arcadeRig('exhaust');
    const hooks = { outboxStore: r.outbox };
    const args = (label: string) => ({
        id: 'c2', workspace: r.ws, ecosystem: '*', initiator: 'cw2a-test', skipEmbed: true, targetGraph: r.graph, nodeData: nodeInput('c2', label),
    });
    await nodeUpsert(args('v1') as never, hooks as never);
    const rowsBefore = (await pendingFor(r, 'c2')).length;
    fake.beforeConditional = (id, f) => { f.nodes.get(id)!['revision'] = Number(f.nodes.get(id)!['revision']) + 1; }; // always loses
    const before = fake.conditionalUpdates;
    const out = await nodeUpsert(args('v2') as never, hooks as never);
    assert.equal(out.ok, false, 'a node that keeps moving is reported, not silently overwritten');
    assert.equal(fake.conditionalUpdates - before, 5, 'bounded at 5 attempts');
    assert.equal((await pendingFor(r, 'c2')).length, rowsBefore, 'every conflicted attempt\'s outbox row was retracted');
    assert.notEqual(fake.nodes.get('c2')!['label'], 'v2');
});

// ───────────────────────── 6. concurrency ─────────────────────────

console.log('\n6. concurrent upserts\n');

await test('6. five concurrent in-process upserts of one id end at initial + 5 (and five distinct revisions are handed out)', async () => {
    const r = sqliteRig('conc');
    await r.graph.initialize();
    await bulk(r, [node('hot', 'seed')]);
    assert.equal(await rev(r, 'hot'), 1);
    const outs = await Promise.all([1, 2, 3, 4, 5].map((i) => bulk(r, [node('hot', `w${i}`)])));
    assert.ok(outs.every((o) => o.ok), JSON.stringify(outs));
    assert.equal(await rev(r, 'hot'), 6, 'initial 1 + 5');
    assert.deepEqual(outs.map((o) => o.results[0]!.revision).sort(), [2, 3, 4, 5, 6]);
    // the outbox rows carry the same five revisions, one each
    const revs = (await pendingFor(r, 'hot')).map((e) => (e.payload as { revision?: number }).revision).filter((x) => x !== 1).sort();
    assert.deepEqual(revs, [2, 3, 4, 5, 6]);
});

await test('6b. the same through the single-write path (nodeUpsert), five at once', async () => {
    const r = sqliteRig('conc-single');
    await r.graph.initialize();
    const mk = (i: number) => nodeUpsert({ id: 'one', workspace: r.ws, ecosystem: '*', initiator: 'cw2a-test', skipEmbed: true, targetGraph: r.graph, nodeData: nodeInput('one', `w${i}`) } as never, { outboxStore: r.outbox } as never);
    const outs = await Promise.all([1, 2, 3, 4, 5].map(mk));
    assert.ok(outs.every((o) => o.ok), JSON.stringify(outs.map((o) => o.ok)));
    assert.equal(await rev(r, 'one'), 5);
    assert.deepEqual(outs.map((o) => (o as { node: LoreNode }).node.revision).sort(), [1, 2, 3, 4, 5]);
});

// ───────────────────────── 7. compensating rows are revision-gated ─────────────────────────

console.log('\n7. compensating outbox rows\n');

import { retractNodeUpsertRow } from '../packages/lore/src/core/nodeServiceConditional.js';
import { undoBulkGraphWrite, retractBulkNodeUpsert } from '../packages/lore/src/mcp/http/routes/bulkWriteRollback.js';

/** Make every `verbatim.upsert` record fail and every pending row look already claimed; returns the undo. */
function failVerbatimAndClaim(r: Rig): () => void {
    const record = r.outbox.record.bind(r.outbox);
    const removeIfPending = r.outbox.removeIfPending!.bind(r.outbox);
    r.outbox.record = async (e: Parameters<typeof record>[0]) => {
        if (e.operationKind === 'verbatim.upsert') throw new Error('injected: outbox full');
        return record(e);
    };
    r.outbox.removeIfPending = async () => false;
    return () => { r.outbox.record = record; r.outbox.removeIfPending = removeIfPending; };
}
const upsertArgs = (r: Rig, id: string, label: string) => ({
    id, workspace: r.ws, ecosystem: '*', initiator: 'cw2a-test', targetGraph: r.graph, nodeData: nodeInput(id, label),
});

/** The failed-write scenario on one engine: node at revision 1, failed update whose row was claimed. */
async function compensationScenario(r: Rig): Promise<void> {
    const hooks = { outboxStore: r.outbox };
    assert.equal((await nodeUpsert({ ...upsertArgs(r, 'cmp', 'v1'), skipEmbed: true } as never, hooks as never)).ok, true);
    const restoreHooks = failVerbatimAndClaim(r);
    let out: { ok: boolean };
    try { out = await nodeUpsert(upsertArgs(r, 'cmp', 'v2') as never, hooks as never); } finally { restoreHooks(); }
    assert.equal(out.ok, false, 'the failed write is reported');
    const stored = await r.graph.getNode('cmp');
    assert.equal(stored.label, 'v1', 'the node is back on the previous state');
    assert.equal(stored.revision, 3, 'v1 = 1, the write = 2, the restore = 3 (a restore is a new state; revision never goes down)');

    const rows = (await pendingFor(r, 'cmp')).filter((e) => e.operationKind === 'node.upsert');
    const compensating = rows[rows.length - 1]!.payload as Record<string, unknown>;
    assert.equal(compensating['label'], 'v1', 'the last row is the compensating save of the previous state');
    assert.equal(compensating['revision'], stored.revision, 'it carries the revision the restore landed');
    assert.equal(compensating['updatedAt'], stored.updatedAt, 'and the updatedAt the restore landed');

    // Replay everything that is pending, in order: the claimed original and the compensating row.
    for (const e of rows) {
        await replayNodePayload(r.graph, e.payload as Record<string, unknown>, async () => { throw new Error('legacy path must not run'); });
    }
    const after = await r.graph.getNode('cmp');
    assert.equal(after.revision, stored.revision, 'replay moved no revision');
    assert.equal(after.updatedAt, stored.updatedAt, 'and no updatedAt');
    assert.equal(after.label, 'v1');
}

await test('7. sqlite: a failed write whose outbox row was claimed -> the compensating row carries the restore\'s revision; replaying both changes nothing', async () => {
    const r = sqliteRig('comp'); await r.graph.initialize();
    await compensationScenario(r);
});

await test('7b. arcade: the same, with the restore going through the conditional verb', async () => {
    const { rig: r } = arcadeRig('comp');
    await compensationScenario(r);
});

await test('7c. arcade: the restore loses a cross-daemon race once -> bounded retry lands the restore; the compensating row matches the stored node', async () => {
    const { rig: r, fake } = arcadeRig('comp-race');
    const hooks = { outboxStore: r.outbox };
    await nodeUpsert({ ...upsertArgs(r, 'rc', 'v1'), skipEmbed: true } as never, hooks as never);
    const restoreHooks = failVerbatimAndClaim(r);
    // The write is the first conditional UPDATE from here, the restore the second: another daemon bumps the row just before the restore is judged.
    let calls = 0;
    fake.beforeConditional = (id, f) => { if (++calls === 2) f.nodes.get(id)!['revision'] = Number(f.nodes.get(id)!['revision']) + 1; };
    try { await nodeUpsert(upsertArgs(r, 'rc', 'v2') as never, hooks as never); } finally { restoreHooks(); }
    assert.equal(calls, 3, 'write, lost restore, retried restore');
    const stored = await r.graph.getNode('rc');
    assert.equal(stored.label, 'v1');
    assert.equal(stored.revision, 4, '1, +1 write, +1 other daemon, +1 restore');
    const rows = (await pendingFor(r, 'rc')).filter((e) => e.operationKind === 'node.upsert');
    const last = rows[rows.length - 1]!.payload as Record<string, unknown>;
    assert.equal(last['revision'], stored.revision);
    assert.equal(last['updatedAt'], stored.updatedAt);
});

await test('7d. the retract path (a refused write, winner already in the graph): the compensating row carries the winner\'s revision and updatedAt', async () => {
    const r = sqliteRig('comp-retract'); await r.graph.initialize();
    await bulk(r, [node('w', 'winner')]);
    await bulk(r, [node('w', 'winner2')]);
    const entry = (await pendingFor(r, 'w'))[0]!;
    assert.equal(await r.outbox.claimForReplication!(entry.id), true);
    await retractNodeUpsertRow({ store: r.outbox, entryId: entry.id, workspace: r.ws, graph: r.graph, id: 'w', written: nodeInput('w', 'loser'), initiator: 'cw2a-test' });
    const stored = await r.graph.getNode('w');
    const rows = (await pendingFor(r, 'w')).filter((e) => e.operationKind === 'node.upsert');
    const last = rows[rows.length - 1]!.payload as Record<string, unknown>;
    assert.equal(last['revision'], stored.revision);
    assert.equal(last['updatedAt'], stored.updatedAt);
    await replayNodePayload(r.graph, last, async () => { throw new Error('legacy path must not run'); });
    assert.equal((await r.graph.getNode('w')).revision, stored.revision, 'replay does not bump');
});

await test('7e. bulk undo: the inline restore bumps, and the compensating row for a claimed bulk row carries that revision', async () => {
    const r = sqliteRig('comp-bulk'); await r.graph.initialize();
    await bulk(r, [node('b1', 'v1')]);
    const prior = await r.graph.getNode('b1');
    await bulk(r, [node('b1', 'v2')]);
    const entry = (await pendingFor(r, 'b1')).filter((e) => (e.payload as { label?: string }).label === 'v2')[0]!;
    assert.equal(await r.outbox.claimForReplication!(entry.id), true);
    await undoBulkGraphWrite(r.graph, 'b1', prior, node('b1', 'v2'));
    const stored = await r.graph.getNode('b1');
    assert.equal(stored.label, 'v1');
    assert.equal(stored.revision, 3, 'v1 = 1, write = 2, restore = 3');
    await retractBulkNodeUpsert({ store: r.outbox, entryId: entry.id, workspace: r.ws, graph: r.graph, id: 'b1', written: node('b1', 'v2') });
    const rows = (await pendingFor(r, 'b1')).filter((e) => e.operationKind === 'node.upsert');
    const last = rows[rows.length - 1]!.payload as Record<string, unknown>;
    assert.equal(last['revision'], 3);
    assert.equal(last['updatedAt'], stored.updatedAt);
    for (const e of rows) await replayNodePayload(r.graph, e.payload as Record<string, unknown>, async () => { throw new Error('legacy path must not run'); });
    const after = await r.graph.getNode('b1');
    assert.deepEqual([after.revision, after.updatedAt, after.label], [3, stored.updatedAt, 'v1']);
});

// ───────────────────────── 8. maintenance content writes bump ─────────────────────────

console.log('\n8. maintenance content writes\n');

await test('8. sqlite archiveNode bumps by exactly 1; re-archiving an archived node does not; an absent id is a no-op', async () => {
    const r = sqliteRig('archive'); await r.graph.initialize();
    await bulk(r, [node('ar')]);
    assert.equal(await rev(r, 'ar'), 1);
    await r.graph.archiveNode('ar');
    const n = await r.graph.getNode('ar');
    assert.equal(n.status, 'archived');
    assert.equal(n.revision, 2);
    await r.graph.archiveNode('ar');
    assert.equal(await rev(r, 'ar'), 2, 'already archived: no state change, no bump');
    await r.graph.archiveNode('missing');
    assert.equal(await r.graph.getNode('missing'), null);
});

await test('8b. sqlite schema ops setNodeMetadata / setNodeType bump by exactly 1 per change; a no-op write does not', async () => {
    const r = sqliteRig('schemaops'); await r.graph.initialize();
    await bulk(r, [node('so')]);
    const ops = r.graph.getSchemaGraphOps();
    await ops.setNodeMetadata('so', { a: 1 });
    assert.equal(await rev(r, 'so'), 2);
    assert.deepEqual(await ops.getNodeMetadata('so'), { a: 1 });
    await ops.setNodeMetadata('so', { a: 1 });
    assert.equal(await rev(r, 'so'), 2, 'identical metadata: unchanged');
    await ops.setNodeMetadata('so', { a: 2 });
    assert.equal(await rev(r, 'so'), 3);
    await ops.setNodeType('so', 'renamed');
    assert.equal((await r.graph.getNode('so')).type, 'renamed');
    assert.equal(await rev(r, 'so'), 4);
    await ops.setNodeType('so', 'renamed');
    assert.equal(await rev(r, 'so'), 4, 'same type: unchanged');
    // restoreNode = one upsert (+1); the timestamp repair after it does not bump again
    const before = await rev(r, 'so');
    await ops.restoreNode({ id: 'so', type: 'renamed', label: 'so', content: 'c', createdAt: '2020-01-01T00:00:00.000Z', syncedAt: '2020-01-02T00:00:00.000Z' });
    assert.equal(await rev(r, 'so'), before + 1);
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
