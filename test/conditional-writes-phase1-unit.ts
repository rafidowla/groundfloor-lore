#!/usr/bin/env tsx
/**
 * conditional-writes-phase1-unit.ts — conditional writes, phase 1:
 *   R1  per-item `ifAbsent: true` on POST /api/nodes/bulk (and embedded nodeUpsert)
 *   R2  supersede guard for every caller (bulk `supersedes`, POST /api/node/supersede,
 *       engine supersedeNode)
 *
 * Real SqliteGraph + real FileOutboxStore + the real route handlers (fake req/res);
 * the arcade DB-level cases run the real ArcadeGraphStore over an in-memory fake of
 * ArcadeHttp (no ArcadeDB, no daemon).
 *
 * Run: npx tsx test/conditional-writes-phase1-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import { ArcadeHttpError } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import { handleSupersede } from '../packages/lore/src/mcp/http/routes/nodes/supersede.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { LoreStorageClient } from '../packages/lore/src/storage/loreStorageClient.js';
import { NodeAlreadyExistsError } from '../packages/lore/src/engines/graphShared/conditionalInsert.js';

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

interface Item { id: string; ok: boolean; error?: string; unchanged?: boolean; [k: string]: unknown }
interface BulkBody { ok: boolean; count: number; succeeded: number; results: Item[] }

// Loosely typed on purpose: both SqliteGraph and ArcadeGraphStore satisfy the route's graph handle.
interface Rig { graph: any; outbox: FileOutboxStore; ws: string }

function sqliteRig(tag: string): Rig {
    const ws = `cw1-${tag}`;
    const graph = new SqliteGraph(mkTmp('cw1-g-'), { workspaceId: ws });
    return { graph, outbox: new FileOutboxStore(mkTmp('cw1-o-')), ws };
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
const node = (id: string, label = id, extra: Record<string, unknown> = {}) => ({ id, type: 'decision', label, content: `content ${label}`, ...extra });
const pending = (r: Rig) => r.outbox.listPendingForWorkspace(r.ws, 10_000);
const pendingFor = async (r: Rig, id: string) => (await pending(r)).filter((e) => (e.payload as { id?: unknown })?.id === id && String(e.operationKind).startsWith('node.'));

// ───────────────────────── R1 — ifAbsent ─────────────────────────

console.log('\nR1 ifAbsent (sqlite)\n');

await test('1. two concurrent ifAbsent creates of one id: exactly one ok, the other already_exists, the winner is stored', async () => {
    const r = sqliteRig('r1-race');
    await r.graph.initialize();
    const [a, b] = await Promise.all([
        bulk(r, [node('dup', 'from-A', { ifAbsent: true })]),
        bulk(r, [node('dup', 'from-B', { ifAbsent: true })]),
    ]);
    const all = [a.results[0]!, b.results[0]!];
    const oks = all.filter((x) => x.ok), fails = all.filter((x) => !x.ok);
    assert.equal(oks.length, 1, JSON.stringify(all));
    assert.equal(fails.length, 1);
    assert.match(fails[0]!.error!, /^already_exists: /);
    const winner = a.results[0]!.ok ? 'from-A' : 'from-B';
    assert.equal((await r.graph.getNode('dup'))!.label, winner);
    assert.equal((await pendingFor(r, 'dup')).length, 1, 'only the winner has an outbox row');
    assert.equal(a.ok === b.ok, false);
});

await test('1b. the same id twice in ONE batch: the first creates, the second is already_exists; other items are unaffected', async () => {
    const r = sqliteRig('r1-batch');
    await r.graph.initialize();
    const out = await bulk(r, [node('x', 'first', { ifAbsent: true }), node('x', 'second', { ifAbsent: true }), node('y', 'plain')]);
    assert.equal(out.results[0]!.ok, true);
    assert.equal(out.results[1]!.ok, false);
    assert.match(out.results[1]!.error!, /^already_exists: /);
    assert.equal(out.results[2]!.ok, true);
    assert.equal(out.ok, false);
    assert.equal(out.succeeded, 2);
    assert.equal((await r.graph.getNode('x'))!.label, 'first');
});

await test('1c. DB level on sqlite: concurrent insertNodeIfAbsent calls (no route lock) — one wins, one NodeAlreadyExistsError', async () => {
    const r = sqliteRig('r1-db');
    await r.graph.initialize();
    const mk = (label: string) => ({ id: 'db-dup', type: 'note', label, content: label, tags: [], project: 'p', ecosystem: '*', metadata: '{}' });
    const res = await Promise.allSettled([r.graph.insertNodeIfAbsent(mk('one')), r.graph.insertNodeIfAbsent(mk('two'))]);
    assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1);
    const rej = res.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    assert.ok(rej.reason instanceof NodeAlreadyExistsError, String(rej.reason));
});

await test('2. ifAbsent on an existing SUPERSEDED node: already_exists, nothing changes', async () => {
    const r = sqliteRig('r1-superseded');
    await r.graph.initialize();
    await bulk(r, [node('old'), node('new')]);
    assert.equal((await r.graph.supersedeNode('old', 'new')).ok, true);
    const before = await r.graph.getNode('old');
    const rows = (await pending(r)).length;
    const out = await bulk(r, [node('old', 'overwrite attempt', { ifAbsent: true })]);
    assert.equal(out.results[0]!.ok, false);
    assert.match(out.results[0]!.error!, /^already_exists: /);
    assert.deepEqual(await r.graph.getNode('old'), before);
    assert.equal((await pending(r)).length, rows, 'no outbox row for the refused item');
});

await test('2b. ifAbsent must be a boolean; the flag is never stored', async () => {
    const r = sqliteRig('r1-type');
    await r.graph.initialize();
    const out = await bulk(r, [node('bad', 'bad', { ifAbsent: 'yes' }), node('good', 'good', { ifAbsent: true }), node('false-ok', 'f', { ifAbsent: false })]);
    assert.equal(out.results[0]!.ok, false);
    assert.match(out.results[0]!.error!, /^invalid_if_absent: /);
    assert.equal(await r.graph.getNode('bad'), null);
    assert.equal(out.results[1]!.ok, true);
    assert.equal(out.results[2]!.ok, true);
    assert.equal((JSON.parse((await r.graph.getNode('good'))!.metadata) as Record<string, unknown>).ifAbsent, undefined);
    assert.equal(((await r.graph.getNode('good')) as unknown as Record<string, unknown>).ifAbsent, undefined);
    // the outbox payload carries the flag so a replay is insert-only
    assert.equal((await pendingFor(r, 'good'))[0]!.payload!['ifAbsent'], true);
    assert.equal((await pendingFor(r, 'false-ok'))[0]!.payload!['ifAbsent'], undefined);
});

await test('2c. embedded nodeUpsert ifAbsent: second create returns already_exists and writes nothing', async () => {
    const r = sqliteRig('r1-embedded');
    await r.graph.initialize();
    const args = (label: string, extra: Record<string, unknown> = {}) => ({
        id: 'emb', workspace: r.ws, ecosystem: '*', initiator: 'cw1-test', skipEmbed: true, targetGraph: r.graph,
        nodeData: { id: 'emb', type: 'note', label, content: label, tags: [], project: 'p', ecosystem: '*', metadata: '{}' }, ...extra,
    });
    const first = await nodeUpsert(args('first', { ifAbsent: true }) as never);
    assert.equal(first.ok, true, JSON.stringify(first));
    const second = await nodeUpsert(args('second', { ifAbsent: true }) as never);
    assert.equal(second.ok, false);
    assert.equal((second as { code: string }).code, 'already_exists');
    assert.equal((await r.graph.getNode('emb'))!.label, 'first');
    const plain = await nodeUpsert(args('third') as never);
    assert.equal(plain.ok, true, 'without ifAbsent the upsert still overwrites');
    assert.equal((await r.graph.getNode('emb'))!.label, 'third');
});

// ───────────────────────── R2 — supersede guard ─────────────────────────

console.log('\nR2 supersede guard (sqlite)\n');

await test('4. concurrent supersedes of one old node by two new ids: one ok, one already_superseded, the loser leaves nothing', async () => {
    const r = sqliteRig('r2-race');
    await r.graph.initialize();
    await bulk(r, [node('old')]);
    const [a, b] = await Promise.all([
        bulk(r, [node('winner-a', 'a', { supersedes: ['old'] })]),
        bulk(r, [node('winner-b', 'b', { supersedes: ['old'] })]),
    ]);
    const all = [{ id: 'winner-a', res: a.results[0]! }, { id: 'winner-b', res: b.results[0]! }];
    const oks = all.filter((x) => x.res.ok), fails = all.filter((x) => !x.res.ok);
    assert.equal(oks.length, 1, JSON.stringify(all));
    assert.match(fails[0]!.res.error!, /^already_superseded: old is already superseded by /);
    assert.equal((await r.graph.getNode('old'))!.supersededBy, oks[0]!.id);
    assert.equal(await r.graph.getNode(fails[0]!.id), null, 'the loser\'s new node is not left behind');
    assert.deepEqual(await pendingFor(r, fails[0]!.id), [], 'and has no outbox row');
});

await test('4b. a mixed list (one free, one taken by another id) fails whole; nothing is written or claimed', async () => {
    const r = sqliteRig('r2-mixed');
    await r.graph.initialize();
    await bulk(r, [node('o1'), node('o2'), node('first')]);
    assert.equal((await bulk(r, [node('first', 'first', { supersedes: ['o1'] })])).results[0]!.ok, true);
    const out = await bulk(r, [node('second', 'second', { supersedes: ['o2', 'o1'] })]);
    assert.equal(out.results[0]!.ok, false);
    assert.match(out.results[0]!.error!, /^already_superseded: o1 is already superseded by first/);
    assert.equal(await r.graph.getNode('second'), null);
    assert.equal((await r.graph.getNode('o2'))!.supersededBy ?? '', '', 'the free target was not claimed');
});

await test('5. retried supersede with the same new id: ok, unchanged, node + updatedAt + outbox untouched', async () => {
    const r = sqliteRig('r2-retry');
    await r.graph.initialize();
    await bulk(r, [node('old')]);
    const first = await bulk(r, [node('new', 'original', { supersedes: ['old'] })]);
    assert.equal(first.results[0]!.ok, true);
    assert.equal(first.results[0]!.unchanged, undefined);
    const nodeBefore = await r.graph.getNode('new'), oldBefore = await r.graph.getNode('old');
    const rowsBefore = (await pending(r)).length;
    await new Promise((res) => setTimeout(res, 15));
    const retry = await bulk(r, [node('new', 'CHANGED LABEL', { supersedes: ['old'] })]);
    // Phase 2a: created at 1, bumped to 2 by the supersede claim; the retry reports it without bumping.
    assert.deepEqual(retry.results[0], { ok: true, id: 'new', unchanged: true, revision: 2 });
    assert.equal(retry.ok, true);
    assert.equal(retry.succeeded, 1);
    assert.deepEqual(await r.graph.getNode('new'), nodeBefore, 'node fields of a retried item are not rewritten');
    assert.deepEqual(await r.graph.getNode('old'), oldBefore);
    assert.equal((await pending(r)).length, rowsBefore, 'no outbox entry');
});

await test('5b. an ifAbsent + supersedes retry succeeds (unchanged) instead of failing already_exists', async () => {
    const r = sqliteRig('r2-retry-ifabsent');
    await r.graph.initialize();
    await bulk(r, [node('old')]);
    const a = await bulk(r, [node('new', 'n', { supersedes: ['old'], ifAbsent: true })]);
    assert.equal(a.results[0]!.ok, true, JSON.stringify(a));
    const b = await bulk(r, [node('new', 'n', { supersedes: ['old'], ifAbsent: true })]);
    assert.deepEqual(b.results[0], { ok: true, id: 'new', unchanged: true, revision: 2 });
});

await test('5c. old already superseded by this id but the new node is gone: the item writes the node (not a pure retry)', async () => {
    const r = sqliteRig('r2-retry-missing-new');
    await r.graph.initialize();
    await bulk(r, [node('old'), node('new')]);
    assert.equal((await r.graph.supersedeNode('old', 'new')).ok, true);
    await r.graph.deleteNode('new');
    // new is gone, so supersedeNode would report new-not-found: the item must still fail cleanly or write; it must not claim unchanged.
    const out = await bulk(r, [node('new', 'back', { supersedes: ['old'] })]);
    assert.notEqual(out.results[0]!.unchanged, true);
    assert.equal((await r.graph.getNode('new'))?.label ?? null, out.results[0]!.ok ? 'back' : null);
});

await test('engine level: supersedeNode refuses a second successor and treats the same successor as a no-op', async () => {
    const r = sqliteRig('r2-engine');
    await r.graph.initialize();
    await bulk(r, [node('old'), node('n1'), node('n2')]);
    assert.deepEqual(await r.graph.supersedeNode('old', 'n1'), { ok: true });
    assert.deepEqual(await r.graph.supersedeNode('old', 'n1'), { ok: true, unchanged: true });
    const lost = await r.graph.supersedeNode('old', 'n2');
    assert.equal(lost.ok, false);
    assert.equal(lost.reason, 'already-superseded');
    assert.equal(lost.supersededBy, 'n1');
    assert.equal((await r.graph.getNode('old'))!.supersededBy, 'n1');
});

// ── REST: POST /api/node/supersede ──

function postSupersede(r: Rig, body: Record<string, unknown>) {
    const res = fakeRes();
    return handleSupersede(
        fakePostReqWithBody(JSON.stringify({ workspace: r.ws, ...body })), res, '/api/node/supersede',
        { store: { loreGraph: r.graph } as never, auditLog: { log: () => undefined } as never, deploymentMode: 'local', dataplane: null, outboxStore: r.outbox } as never,
    ).then(() => ({ status: res._status, body: JSON.parse(res._body) as Record<string, unknown> }));
}

await test('6. POST /api/node/supersede: another id -> 409 already_superseded; same id -> ok, nothing changes', async () => {
    const r = sqliteRig('r2-rest');
    await r.graph.initialize();
    await bulk(r, [node('old'), node('n1'), node('n2')]);
    const first = await postSupersede(r, { oldId: 'old', newId: 'n1' });
    assert.equal(first.status, 200);
    assert.equal(first.body['ok'], true);
    const oldAfterFirst = await r.graph.getNode('old');
    const rowsAfterFirst = (await pending(r)).length;
    const again = await postSupersede(r, { oldId: 'old', newId: 'n1' });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { ok: true, unchanged: true });
    assert.deepEqual(await r.graph.getNode('old'), oldAfterFirst, 'old node not rewritten');
    assert.equal((await pending(r)).length, rowsAfterFirst, 'no second edge / alias row');
    const other = await postSupersede(r, { oldId: 'old', newId: 'n2' });
    assert.equal(other.status, 409);
    assert.equal(other.body['error'], 'already_superseded');
    assert.equal(other.body['code'], 'already_superseded');
    assert.match(String(other.body['message']), /old is already superseded by n1/);
    assert.equal((await r.graph.getNode('old'))!.supersededBy, 'n1');
});

await test('6b. POST /api/node/supersede: a missing old id keeps the 400 + reason body', async () => {
    const r = sqliteRig('r2-rest-missing');
    await r.graph.initialize();
    await bulk(r, [node('n1')]);
    const out = await postSupersede(r, { oldId: 'ghost', newId: 'n1' });
    assert.equal(out.status, 400);
    assert.deepEqual(out.body, { ok: false, reason: 'old-not-found' });
});

// ───────────────────────── 7. nothing new sent → unchanged behaviour ─────────────────────────

await test('7. a caller sending none of the new fields gets the pre-change results', async () => {
    const r = sqliteRig('legacy');
    await r.graph.initialize();
    const out = await bulk(r, [node('a'), node('b')]);
    // Phase 2a adds `revision` to each result; nothing else changes.
    assert.deepEqual(out, { ok: true, count: 2, succeeded: 2, results: [{ ok: true, id: 'a', revision: 1 }, { ok: true, id: 'b', revision: 1 }] });
    const again = await bulk(r, [node('a', 'rewritten')]);
    assert.deepEqual(again, { ok: true, count: 1, succeeded: 1, results: [{ ok: true, id: 'a', revision: 2 }] });
    assert.equal((await r.graph.getNode('a'))!.label, 'rewritten', 'a plain bulk write still overwrites');
    const sup = await bulk(r, [node('c', 'c', { supersedes: ['a'] })]);
    assert.deepEqual(sup, { ok: true, count: 1, succeeded: 1, results: [{ ok: true, id: 'c', revision: 2 }] });
    assert.equal((await r.graph.getNode('a'))!.supersededBy, 'c');
    assert.equal((await pendingFor(r, 'a')).every((e) => e.payload?.['ifAbsent'] === undefined), true);
});

// ───────────────────────── arcade, DB level (fake ArcadeHttp) ─────────────────────────

console.log('\narcade DB level (fake ArcadeHttp)\n');

type Row = Record<string, unknown>;
class FakeArcade {
    nodes = new Map<string, Row>();
    /** Called right before an INSERT lands; may plant a foreign row to simulate another daemon winning the race. */
    beforeInsert: ((id: string, fake: FakeArcade) => void) | null = null;
    /** Called right before a conditional supersede UPDATE; may plant a foreign claim. */
    beforeSupersede: ((id: string, fake: FakeArcade) => void) | null = null;
    inserts = 0;
    supersedeUpdates = 0;

    private put(id: string, assign: Row): void { this.nodes.set(id, { ...(this.nodes.get(id) ?? { id }), ...assign }); }

    async command(_db: string, sql: string, params: Row = {}): Promise<{ result: unknown[] }> {
        if (/^UPDATE LoreNode SET .* UPSERT WHERE id = :id$/s.test(sql)) {
            const { id, ...rest } = params; this.put(String(id), rest); return { result: [{ count: 1 }] };
        }
        if (/^INSERT INTO LoreNode SET /.test(sql)) {
            this.inserts++;
            const id = String(params['id']);
            this.beforeInsert?.(id, this);
            if (this.nodes.has(id)) throw new ArcadeHttpError(503, 'Duplicated key [' + id + '] found on index LoreNode[id]');
            this.put(id, params); return { result: [{ count: 1 }] };
        }
        if (/^UPDATE LoreNode SET supersededBy = :newid/.test(sql)) {
            this.supersedeUpdates++;
            const id = String(params['id']);
            this.beforeSupersede?.(id, this);
            const row = this.nodes.get(id);
            const cur = row?.['supersededBy'];
            if (!row || (cur && cur !== '' && cur !== params['newid'])) return { result: [{ count: 0 }] };
            row['supersededBy'] = params['newid']; row['supersededAt'] = params['at']; row['supersededReason'] = params['reason'];
            return { result: [{ count: 1 }] };
        }
        if (/^UPDATE LoreNode SET supersededBy = '', /.test(sql)) {
            const row = this.nodes.get(String(params['id']));
            if (row) { row['supersededBy'] = ''; row['supersededAt'] = ''; row['supersededReason'] = ''; }
            return { result: [{ count: row ? 1 : 0 }] };
        }
        if (/^DELETE VERTEX FROM LoreNode WHERE id = :id$/.test(sql)) { this.nodes.delete(String(params['id'])); return { result: [] }; }
        return { result: [] }; // DDL
    }
    async commandScript(_db: string, script: string, params: Row = {}): Promise<{ result: unknown[] }> {
        for (const line of script.split('\n')) {
            const m = /^UPDATE LoreNode SET (.+) UPSERT WHERE id = :(n\d+_)id;$/.exec(line);
            if (!m) continue;
            const p = m[2]!; const assign: Row = {};
            for (const part of m[1]!.split(', ')) { const f = part.split(' = ')[0]!; assign[f] = params[`${p}${f}`]; }
            this.put(String(params[`${p}id`]), assign);
        }
        return { result: [] };
    }
    async query(_db: string, sql: string, params: Row = {}): Promise<{ result: Row[] }> {
        if (/FROM LoreNode WHERE id = :id LIMIT 1$/.test(sql)) { const r = this.nodes.get(String(params['id'])); return { result: r ? [r] : [] }; }
        if (/FROM LoreNode WHERE id IN :ids$/.test(sql)) { return { result: (params['ids'] as string[]).filter((i) => this.nodes.has(i)).map((i) => this.nodes.get(i)!) }; }
        return { result: [] };
    }
}

function arcadeRig(tag: string): { rig: Rig; fake: FakeArcade } {
    const fake = new FakeArcade();
    const graph = new ArcadeGraphStore({ tenantDb: 't', http: fake as never });
    return { rig: { graph, outbox: new FileOutboxStore(mkTmp('cw1-ao-')), ws: `cw1-arcade-${tag}` }, fake };
}

await test('3. arcade: a duplicate-key error on the INSERT -> already_exists, outbox entry retracted, winner untouched', async () => {
    const { rig: r, fake } = arcadeRig('dup');
    fake.beforeInsert = (id, f) => { f.nodes.set(id, { id, type: 'decision', label: 'WINNER', content: 'w', tags: '[]', project: '', ecosystem: '*', metadata: '{}', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }); };
    const out = await bulk(r, [node('race', 'loser', { ifAbsent: true }), node('other', 'fine')]);
    assert.equal(out.results[0]!.ok, false, JSON.stringify(out));
    assert.match(out.results[0]!.error!, /^already_exists: /);
    assert.equal(out.results[1]!.ok, true);
    assert.equal(fake.nodes.get('race')!['label'], 'WINNER');
    assert.deepEqual(await pendingFor(r, 'race'), [], 'the refused item has no outbox entry that could replay over the winner');
    assert.equal((await pendingFor(r, 'other')).length, 1);
});

await test('3b. arcade: the ifAbsent check hits the DB insert once (no read-then-write gap), success path stores via INSERT', async () => {
    const { rig: r, fake } = arcadeRig('insert');
    const out = await bulk(r, [node('fresh', 'f', { ifAbsent: true })]);
    assert.equal(out.results[0]!.ok, true, JSON.stringify(out));
    assert.equal(fake.inserts, 1);
    assert.equal(fake.nodes.get('fresh')!['label'], 'f');
});

await test('3c. arcade: the conditional supersede UPDATE returns 0 rows (another daemon claimed it) -> already_superseded, new node + outbox row taken back', async () => {
    const { rig: r, fake } = arcadeRig('claim');
    await bulk(r, [node('old')]);
    fake.beforeSupersede = (id, f) => { f.nodes.get(id)!['supersededBy'] = 'someone-else'; };
    const rowsBefore = (await pending(r)).length;
    const out = await bulk(r, [node('mine', 'mine', { supersedes: ['old'], ifAbsent: true })]);
    assert.equal(out.results[0]!.ok, false, JSON.stringify(out));
    assert.match(out.results[0]!.error!, /^already_superseded: old is already superseded by someone-else/);
    assert.equal(fake.nodes.has('mine'), false, 'the new node was rolled back');
    assert.equal(fake.nodes.get('old')!['supersededBy'], 'someone-else', 'the other daemon\'s claim stands');
    assert.deepEqual(await pendingFor(r, 'mine'), [], 'the outbox entry is retracted');
    assert.equal((await pending(r)).length, rowsBefore);
});

await test('3d. arcade: a lost claim on an UPDATE of an existing node restores the node as it was', async () => {
    const { rig: r, fake } = arcadeRig('claim-restore');
    await bulk(r, [node('old'), node('existing', 'before')]);
    fake.beforeSupersede = (id, f) => { f.nodes.get(id)!['supersededBy'] = 'someone-else'; };
    const out = await bulk(r, [node('existing', 'AFTER', { supersedes: ['old'] })]);
    assert.equal(out.results[0]!.ok, false);
    assert.match(out.results[0]!.error!, /^already_superseded: /);
    assert.equal(fake.nodes.get('existing')!['label'], 'before');
});

await test('3e. arcade: a two-id list where the second claim is lost hands back the first claim', async () => {
    const { rig: r, fake } = arcadeRig('claim-partial');
    await bulk(r, [node('o1'), node('o2')]);
    fake.beforeSupersede = (id, f) => { if (id === 'o2') f.nodes.get(id)!['supersededBy'] = 'someone-else'; };
    const out = await bulk(r, [node('mine', 'mine', { supersedes: ['o1', 'o2'], ifAbsent: true })]);
    assert.equal(out.results[0]!.ok, false, JSON.stringify(out));
    assert.match(out.results[0]!.error!, /^already_superseded: o2 is already superseded by someone-else/);
    assert.ok(!fake.nodes.get('o1')!['supersededBy'], 'the claim on o1 was handed back');
    assert.equal(fake.nodes.has('mine'), false);
});

// ───────────────────────── replay of an ifAbsent entry ─────────────────────────

console.log('\nreplay\n');

await test('replay of an ifAbsent node.upsert is insert-only: it never overwrites a different writer\'s node', async () => {
    const { replayIfAbsentUpsert } = await import('../packages/lore/src/engines/graphShared/conditionalInsert.js');
    const r = sqliteRig('replay');
    await r.graph.initialize();
    await bulk(r, [node('taken', 'WINNER')]);
    const wrote = await replayIfAbsentUpsert(r.graph, { id: 'taken', type: 'decision', label: 'stale replay', content: 'x', ifAbsent: true });
    assert.equal(wrote, false);
    assert.equal((await r.graph.getNode('taken'))!.label, 'WINNER');
    const wrote2 = await replayIfAbsentUpsert(r.graph, { id: 'free', type: 'decision', label: 'created', content: 'x', ifAbsent: true });
    assert.equal(wrote2, true);
    assert.equal((await r.graph.getNode('free'))!.label, 'created');
});

void LoreStorageClient;
console.log(`\n${passed} passed, ${failed} failed\n`);
for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
