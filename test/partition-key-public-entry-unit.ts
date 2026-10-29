#!/usr/bin/env tsx
/**
 * test/partition-key-public-entry-unit.ts - Phase 0 lane L3, wire-up proof through the PUBLIC entry points.
 *
 * Drives the real MCP tool (`store_node`), the real REST route (`POST /api/node` via tryNodesRoutes) and the shared
 * service (`nodeUpsert`) over a REAL graph engine - SqliteGraph always, PostgresGraph too when LORE_PG_URL is set -
 * and reads back through the engine:
 *
 *   key set        store_node / POST /api/node with `partitionKey` -> stored, read back, verbatim copy receives the key
 *   unkeyed        a caller not passing `partitionKey` gets the SAME response shape as before (no `partitionKey` anywhere)
 *   immutability   changing a non-empty key -> MCP error PARTITION_KEY_IMMUTABLE / HTTP 409; the node is unchanged
 *   validation     an over-long / control-character key -> MCP invalid_partition_key / HTTP 400; nothing written
 *   convergence    a retried partial write (node committed, verbatim fails once) converges: node + verbatim agree on the key
 *
 * Run: npx tsx test/partition-key-public-entry-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'pg';
import { z } from 'zod';

import { SqliteGraph } from '../packages/lore/src/engines/sqliteGraph.js';
import { PostgresGraph } from '../packages/lore/src/engines/postgres/postgresGraph.js';
import { createPostgresPool } from '../packages/lore/src/engines/postgres/postgresClient.js';
import { registerStoreNodeTool } from '../packages/lore/src/mcp/tools/memory/storeNode.js';
import { tryNodesRoutes } from '../packages/lore/src/mcp/http/routes/nodes.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import type { LoreNode } from '../packages/lore/src/providers/types.js';
import { gateDbUrl } from './helpers/testPostgres.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

type Verb = { id: string; text: string; metadata: Record<string, unknown> };
type Tool = (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
interface Graph {
    getNode(id: string): Promise<LoreNode | null>;
    upsertNode(n: never): Promise<LoreNode>;
    deleteNode(id: string): Promise<unknown>;
}

function mcp(graph: Graph, verbatim: Verb[]): Tool {
    const tools: Record<string, Tool> = {};
    const server = { tool: (name: string, ...rest: unknown[]) => { const h = rest[rest.length - 1]; if (typeof h === 'function') tools[name] = h as Tool; } };
    const store = {
        loreGraph: graph as never, loreVerbatim: { async store() {}, async getById() { return null; }, async search() { return []; } } as never,
        sessionCache: { pushNode: () => undefined } as never,
        storageClient: { async verbatimStore(d: Verb) { verbatim.push(d); }, async upsertNode(n: unknown) { return n as never; } } as never,
        deploymentMode: 'local' as const, sdk: {} as never, tableStorage: {} as never,
    };
    registerStoreNodeTool(server as never, {
        store, configManager: { read: () => ({ pluginConfig: {} }) } as never, auditLog: { log: () => undefined } as never,
        detectedScope: { workspace: 'p0l3', ecosystem: 'default' }, getWal: () => ({ append: () => undefined }) as never,
        domain: 'lore', edgeRelations: ['related_to'], nodeTypesEnum: z.enum(['decision', 'note']) as never, nodeTypesDescription: 'decision|note',
        edgeRelationsEnum: z.enum(['related_to']) as never, embedQueue: { enqueue() {} },
        coreNodeTypes: ['decision', 'note', 'convention', 'bug_pattern', 'architecture', 'troubleshooting'],
    } as never);
    return tools['store_node']!;
}

function req(method: string, body: string): IncomingMessage {
    let consumed = false;
    return { method, on(ev: string, cb: (c?: Buffer) => void) {
        if (ev === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
        if (ev === 'end') setImmediate(() => cb());
        return this;
    } } as unknown as IncomingMessage;
}
async function post(graph: Graph, verbatim: Verb[], body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = { _s: 0, _b: '', writeHead(s: number) { this._s = s; return this; }, end(b?: string) { this._b = b ?? ''; } };
    await tryNodesRoutes(req('POST', JSON.stringify(body)), res as unknown as ServerResponse, '/api/node', '/api/node', {
        deploymentMode: 'local', dataplane: null,
        store: { loreGraph: graph as never, loreVerbatim: { async store(w: Verb) { verbatim.push(w); } } as never } as never,
        auditLog: { append: () => undefined } as never, coreNodeTypes: ['decision', 'convention', 'bug_pattern', 'architecture', 'troubleshooting'],
    } as never);
    await new Promise<void>((r) => setImmediate(r));
    return { status: res._s, body: res._b ? JSON.parse(res._b) as Record<string, unknown> : {} };
}

async function suite(label: string, graph: Graph): Promise<void> {
    console.log(`\n${label}`);
    const verb: Verb[] = [];
    const store = mcp(graph, verb);
    const base = { type: 'note', label: 'L', content: 'body text', workspace: 'p0l3' };

    await test('store_node with partitionKey stores it; getNode reads it; the verbatim copy receives it', async () => {
        const r = await store({ ...base, id: 'pe-1', partitionKey: 'tenant-1' });
        assert.ok(!r.isError, r.content[0]?.text);
        assert.equal((await graph.getNode('pe-1'))?.partitionKey, 'tenant-1');
        assert.equal(verb.find((v) => v.id === 'lore:pe-1')?.metadata['partitionKey'], 'tenant-1');
    });
    await test('store_node WITHOUT partitionKey: response + stored node + verbatim metadata carry no partitionKey', async () => {
        verb.length = 0;
        const r = await store({ ...base, id: 'pe-2' });
        assert.ok(!r.isError, r.content[0]?.text);
        assert.ok(!/partitionKey|partition_key/i.test(r.content[0]!.text), 'response shape unchanged');
        assert.ok(!('partitionKey' in ((await graph.getNode('pe-2')) as object)));
        assert.ok(!('partitionKey' in (verb.find((v) => v.id === 'lore:pe-2')?.metadata ?? {})));
    });
    await test("store_node: '' -> key is allowed; changing a non-empty key is refused with PARTITION_KEY_IMMUTABLE; node unchanged", async () => {
        assert.ok(!(await store({ ...base, id: 'pe-3' })).isError);
        assert.ok(!(await store({ ...base, id: 'pe-3', partitionKey: 'k' })).isError);
        const bad = await store({ ...base, id: 'pe-3', label: 'changed', partitionKey: 'other' });
        assert.equal(bad.isError, true);
        assert.equal((JSON.parse(bad.content[0]!.text) as { error: string }).error, 'PARTITION_KEY_IMMUTABLE');
        const n = await graph.getNode('pe-3');
        assert.equal(n?.partitionKey, 'k');
        assert.equal(n?.label, 'L', 'the refused write changed nothing');
        assert.ok(!(await store({ ...base, id: 'pe-3', label: 'keyless rewrite' })).isError, 'omitting the key keeps it');
        assert.equal((await graph.getNode('pe-3'))?.partitionKey, 'k');
    });
    await test('store_node rejects an over-long / control-character key (invalid_partition_key) and writes nothing', async () => {
        for (const bad of ['x'.repeat(129), 'a\u0000b', 'a\nb']) {
            const r = await store({ ...base, id: 'pe-4', partitionKey: bad });
            assert.equal(r.isError, true);
            assert.equal((JSON.parse(r.content[0]!.text) as { error: string }).error, 'invalid_partition_key');
        }
        assert.equal(await graph.getNode('pe-4'), null);
        assert.ok(!(await store({ ...base, id: 'pe-4b', partitionKey: 'x'.repeat(128) })).isError, '128 chars is accepted');
    });

    await test('POST /api/node: key stored (200), unkeyed response unchanged, change -> 409 PARTITION_KEY_IMMUTABLE, invalid -> 400', async () => {
        const ok = await post(graph, verb, { ...base, id: 'pe-h1', partitionKey: 'tenant-h' });
        assert.ok(ok.status === 200 || ok.status === 201, JSON.stringify(ok.body));
        assert.equal((await graph.getNode('pe-h1'))?.partitionKey, 'tenant-h');
        const plain = await post(graph, verb, { ...base, id: 'pe-h2' });
        assert.ok(plain.status === 200 || plain.status === 201, JSON.stringify(plain.body));
        assert.ok(!/partitionKey|partition_key/i.test(JSON.stringify(plain.body)), 'unkeyed REST response shape unchanged');
        const chg = await post(graph, verb, { ...base, id: 'pe-h1', partitionKey: 'zzz' });
        assert.equal(chg.status, 409, JSON.stringify(chg.body));
        assert.match(JSON.stringify(chg.body), /PARTITION_KEY_IMMUTABLE/);
        assert.equal((await graph.getNode('pe-h1'))?.partitionKey, 'tenant-h');
        const inv = await post(graph, verb, { ...base, id: 'pe-h3', partitionKey: 'a\u0001b' });
        assert.equal(inv.status, 400, JSON.stringify(inv.body));
        assert.equal(await graph.getNode('pe-h3'), null);
    });

    const nodeData = (id: string, over: Record<string, unknown> = {}) =>
        ({ id, type: 'note', label: 'L', content: `conv ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}', ...over });
    /** An outbox whose `verbatim.upsert` record fails while `failing` - the failure point that makes nodeUpsert roll back. */
    const flakyOutbox = () => {
        const recorded: Array<{ kind: string; payload: Record<string, unknown> }> = [];
        const o = { failing: true, recorded };
        const store = {
            async record(e: { steps: Array<{ kind: string; payload: Record<string, unknown> }> }) {
                const st = e.steps[0]!;
                if (o.failing && st.kind === 'verbatim.upsert') throw new Error('outbox down');
                recorded.push({ kind: st.kind, payload: st.payload });
            },
            async markStep() {}, async markCompleted() {}, async remove() {}, async removeIfPending() { return true; }, async listUnfinished() { return []; },
        };
        return { o, store };
    };
    const callUpsert = (id: string, over: Record<string, unknown>, hooks: Record<string, unknown>) => nodeUpsert({
        id, workspace: 'p0l3', ecosystem: '*', initiator: 'p0l3-test', targetGraph: graph as never, nodeData: nodeData(id, over),
    }, hooks as never);

    await test('inline verbatim fails once: node is KEPT with its key, the retry stores the verbatim copy with the same key', async () => {
        const seen: Verb[] = [];
        let fail = true;
        const verbatim = { async verbatimStore(w: Verb) { if (fail) { fail = false; throw new Error('verbatim down'); } seen.push(w); } };
        const first = await callUpsert('pe-c0', { partitionKey: 'conv-key' }, { verbatim });
        assert.equal(first.ok, true, 'node kept, retry deferred (3.21 step 3d)');
        assert.equal((await graph.getNode('pe-c0'))?.partitionKey, 'conv-key');
        assert.equal(seen.length, 0);
        const second = await callUpsert('pe-c0', { partitionKey: 'conv-key' }, { verbatim });
        assert.equal(second.ok, true);
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.metadata['partitionKey'], 'conv-key', 'verbatim copy carries the node key');
    });
    await test('rollback path, NEW node: the whole write (node + key) is undone; the retry converges and queues the verbatim copy with the key', async () => {
        const { o, store } = flakyOutbox();
        const first = await callUpsert('pe-c1', { partitionKey: 'conv-key' }, { outboxStore: store });
        assert.equal(first.ok, false);
        assert.equal(first.ok === false && first.code, 'verbatim_unavailable');
        assert.equal(await graph.getNode('pe-c1'), null, 'a NEW node is rolled back whole');
        o.failing = false;
        const second = await callUpsert('pe-c1', { partitionKey: 'conv-key' }, { outboxStore: store });
        assert.equal(second.ok, true);
        assert.equal((await graph.getNode('pe-c1'))?.partitionKey, 'conv-key');
        const v = o.recorded.find((r) => r.kind === 'verbatim.upsert');
        assert.equal((v?.payload['metadata'] as Record<string, unknown>)['partitionKey'], 'conv-key');
    });
    await test("rollback path, EXISTING unkeyed node: the '' -> key promotion survives the rollback (documented) and the retry converges", async () => {
        await graph.upsertNode(nodeData('pe-c2') as never);
        const { o, store } = flakyOutbox();
        const first = await callUpsert('pe-c2', { partitionKey: 'late-key' }, { outboxStore: store });
        assert.equal(first.ok, false);
        assert.ok(await graph.getNode('pe-c2'), 'an existing node is restored, not deleted');
        assert.equal((await graph.getNode('pe-c2'))?.partitionKey, 'late-key', 'a key only ever moves from empty to set, so the rollback does not unset it');
        o.failing = false;
        const second = await callUpsert('pe-c2', { partitionKey: 'late-key' }, { outboxStore: store });
        assert.equal(second.ok, true);
        const v = o.recorded.find((r) => r.kind === 'verbatim.upsert');
        assert.equal((v?.payload['metadata'] as Record<string, unknown>)['partitionKey'], 'late-key');
        // and a DIFFERENT key on the retry is still refused
        const third = await callUpsert('pe-c2', { partitionKey: 'other' }, { outboxStore: store });
        assert.equal(third.ok === false && third.code, 'partition_key_immutable');
    });
}

// ---------------------------------------------------------------- SQLite
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-p0l3-entry-'));
const sg = new SqliteGraph(path.join(root, 's'), { workspaceId: 'p0l3' });
await sg.initialize();
await suite('SqliteGraph', sg as unknown as Graph);
await sg.close();
fs.rmSync(root, { recursive: true, force: true });

// ---------------------------------------------------------------- Postgres
const gate = gateDbUrl();
if (!gate) {
    console.log('\nSKIP postgres half: LORE_PG_URL is not set');
} else {
    const DB = `lore_p0l3pe_${process.pid}`;
    const adminUrl = new URL(gate); adminUrl.pathname = '/postgres';
    const dbUrl = new URL(gate); dbUrl.pathname = `/${DB}`;
    const admin = async (sql: string): Promise<void> => { const c = new Client({ connectionString: adminUrl.toString() }); await c.connect(); try { await c.query(sql); } finally { await c.end(); } };
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${DB}`);
    const pool = createPostgresPool({ url: dbUrl.toString() });
    try {
        const pg = new PostgresGraph('p0l3', pool);
        await pg.initialize();
        await suite('PostgresGraph (real Postgres)', pg as unknown as Graph);
        const rows = (await pool.query(`SELECT id, partition_key, created_at_ts IS NOT NULL AS has_ts FROM nodes WHERE workspace_id = 'p0l3' AND id IN ('pe-1','pe-2','pe-3','pe-h1','pe-c0','pe-c1') ORDER BY id`)).rows;
        await test('the rows the public entry points wrote carry partition_key and created_at_ts in SQL', () => {
            assert.deepEqual(rows, [
                { id: 'pe-1', partition_key: 'tenant-1', has_ts: true }, { id: 'pe-2', partition_key: '', has_ts: true },
                { id: 'pe-3', partition_key: 'k', has_ts: true }, { id: 'pe-c0', partition_key: 'conv-key', has_ts: true }, { id: 'pe-c1', partition_key: 'conv-key', has_ts: true },
                { id: 'pe-h1', partition_key: 'tenant-h', has_ts: true },
            ]);
        });
        await pg.close();
    } finally {
        await pool.end().catch(() => undefined);
        await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`).catch(() => undefined);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
