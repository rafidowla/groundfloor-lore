#!/usr/bin/env tsx
/**
 * d5-write-paths-refusal-unit.ts — D5 round 4 (#7): end-to-end proof that
 * write-time supersession enforcement (the shared `resolveSupersessionContext`
 * chokepoint) is actually reached from EVERY write surface, not just the
 * MCP `store_node` tool (already covered by d5-supersedes-corrects-unit.ts's
 * Part 2). One refusal case per path:
 *
 *   - REST POST /api/node        (nodes/postNode.ts)
 *   - REST POST /api/nodes/bulk  (bulkWrite.ts, batched-local branch)
 *   - REST POST /api/import      (import.ts)
 *   - embedded lib nodeUpsert()
 *   - embedded lib nodeUpsertBatch()
 *   - embedded lib bulkIngest()
 *   - commit_changeset (mcp/changesetWrite.ts, via registerVersioningTools)
 *
 * Every path below is driven with NO seeded per-workspace policy — the
 * workspace name used is unregistered, so `resolveSupersessionContext`'s
 * `getWorkspaceSupersessionPolicy` throws "Unknown workspace" and falls back
 * to `{enforce: hostDefaultEnforce === true}` (round-2 fail-open fix). Each
 * harness supplies `supersessionEnforceDefault: true` (the REST/MCP DI field)
 * or `supersessionEnforce: true` (createLore()'s option) to drive that
 * fallback to `true` — this is deliberate: it proves the HOST DEFAULT reaches
 * enforcement at every site individually (the round-3 HANDOFF explicitly
 * flagged this as untested beyond store_node), not just that a per-workspace
 * policy can.
 *
 * A separate section at the bottom proves Task A (#3) with REAL embeddings:
 * a genuine `EmbeddingProvider` (same technique as
 * vector-engine-promotion-e2e-unit.ts's DetEmbedProvider — char-code sum,
 * normalised) run through `createLore({deploymentMode:'embedded'})`'s real
 * outbox → LanceDB/SQLite pipeline, so the near-duplicate hit comes from an
 * ACTUAL nearest-neighbour vector search over a close paraphrase, not a
 * canned `search()` stub. Runs against the default embedded profile
 * (sqlite/sqlite) — NOT also run against surreal/lance in this round due to
 * turn-budget; see HANDOFF.md.
 *
 * Run: npx tsx test/d5-write-paths-refusal-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
    catch (e) { console.error(`  \x1b[31m✗ ${name}\x1b[0m\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

/* ─── shared fake-http plumbing (pattern from bulk-write-scope-metadata-unit.ts) ── */

function makeReqWithBody(method: string, body: string): IncomingMessage {
    let consumed = false;
    return {
        method,
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
function fakeRes(): ServerResponse & { _status: number; _body: string } {
    const r = {
        _status: 0, _body: '',
        writeHead(status: number) { (this as { _status: number })._status = status; return this; },
        end(body?: string) { (this as { _body: string })._body = body ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
function jsonOf(res: { _body: string }): Record<string, unknown> {
    try { return JSON.parse(res._body); } catch { return {}; }
}

/** A minimal fake graph: getNode always null (no existing rows to validate
 *  `supersedes` ids against — fine, every case here omits `supersedes`
 *  entirely, so the missing-field check fires before any id lookup). */
function makeFakeGraph() {
    const upsertCalls: Array<Record<string, unknown>> = [];
    return {
        upsertCalls,
        async upsertNode(n: Record<string, unknown>) { upsertCalls.push(n); return n; },
        async bulkUpsertNodes(nodes: Array<Record<string, unknown>>) { for (const n of nodes) upsertCalls.push(n); return nodes.map(() => ({ ok: true as const })); },
        async deleteNode(_id: string) {},
        async getNode(_id: string) { return null; },
        getGraphContext() { return {}; },
    };
}
function makeFakeVerbatim() {
    const writes: Array<{ id: string; text: string; metadata?: Record<string, unknown> }> = [];
    return { writes, async store(d: { id: string; text: string; metadata?: Record<string, unknown> }) { writes.push(d); }, async delete(_id: string) {} };
}
function makeFakeOutboxStore() {
    return {
        async record() {}, async markStep() {}, async markCompleted() {}, async remove() {},
        async listUnfinished() { return []; }, async batchRecord() {},
    };
}

console.log('D5 round 4 (#7) — write-time supersession enforcement reached from every write surface\n');

/* ─── 1. REST POST /api/node (postNode.ts) ─────────────────────────────── */

await test('POST /api/node: missing supersedes field is refused (400, missing_supersedes_field), host default drives it', async () => {
    const { tryNodesRoutes } = await import('../packages/lore/src/mcp/http/routes/nodes.js');
    const graph = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const res = fakeRes();
    const handled = await tryNodesRoutes(
        makeReqWithBody('POST', JSON.stringify({ id: 'pn-1', type: 'decision', label: 'D', content: 'body', workspace: 'ws-postnode-unreg' })),
        res, '/api/node', '/api/node',
        {
            store: { loreGraph: graph, loreVerbatim: verbatim, storageClient: { verbatimStore: verbatim.store.bind(verbatim), rawGraph: () => graph } } as never,
            auditLog: { log: () => undefined } as never,
            deploymentMode: 'local', dataplane: null,
            outboxStore: makeFakeOutboxStore() as never,
            supersessionEnforceDefault: true,
        } as never,
    );
    assert.equal(handled, true);
    assert.equal(res._status, 400, `expected 400, got ${res._status}: ${res._body}`);
    assert.equal(jsonOf(res)['code'], 'missing_supersedes_field', `expected code missing_supersedes_field, got ${res._body}`);
    assert.equal(graph.upsertCalls.length, 0, 'nothing written to the graph');
});

/* ─── 2. REST POST /api/nodes/bulk (bulkWrite.ts) ──────────────────────── */

await test('POST /api/nodes/bulk: an item missing supersedes is refused per-item, host default drives it', async () => {
    const { tryBulkWriteRoutes } = await import('../packages/lore/src/mcp/http/routes/bulkWrite.js');
    const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
    const graph = Object.setPrototypeOf(makeFakeGraph(), SurrealGraph.prototype);
    const verbatim = makeFakeVerbatim();
    const res = fakeRes();
    const handled = await tryBulkWriteRoutes(
        makeReqWithBody('POST', JSON.stringify({ nodes: [{ id: 'bw-1', type: 'decision', label: 'D', content: 'body' }], workspace: 'ws-bulkwrite-unreg', embed: 'inline' })),
        res, '/api/nodes/bulk', '/api/nodes/bulk',
        {
            deploymentMode: 'local', dataplane: null,
            store: { loreGraph: graph as never, loreVerbatim: verbatim as never, storageClient: { verbatimStore: verbatim.store.bind(verbatim), rawGraph: () => graph } as never } as never,
            auditLog: { log: () => undefined } as never,
            outboxStore: makeFakeOutboxStore() as never,
            supersessionEnforceDefault: true,
        } as never,
    );
    assert.equal(handled, true);
    assert.equal(res._status, 200, `route itself returns 200 with a per-item failure; got ${res._status}: ${res._body}`);
    const body = jsonOf(res) as { results?: Array<{ ok: boolean; error?: string }> };
    assert.ok(body.results && body.results.length === 1, `expected 1 result, got ${JSON.stringify(body)}`);
    assert.equal(body.results![0]!.ok, false, `expected the item refused, got ${JSON.stringify(body.results)}`);
    assert.match(body.results![0]!.error ?? '', /missing_supersedes_field|supersedes/, `expected a supersedes-related refusal, got ${JSON.stringify(body.results![0])}`);
    assert.equal((graph as { upsertCalls: unknown[] }).upsertCalls.length, 0, 'nothing written to the graph');
});

/* ─── 3. REST POST /api/import (import.ts) ─────────────────────────────── */

await test('POST /api/import: a row missing supersedes is refused per-row, host default drives it', async () => {
    const { tryImportRoutes } = await import('../packages/lore/src/mcp/http/routes/import.js');
    const graph = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const csv = Buffer.from('id,label,content\nim-1,D,body\n', 'utf-8').toString('base64');
    const res = fakeRes();
    const handled = await tryImportRoutes(
        makeReqWithBody('POST', JSON.stringify({
            format: 'csv', filename: 'x.csv', data: csv, workspace: 'ws-import-unreg',
            mapping: { entityType: 'decision', idColumn: 'id', fields: { label: 'label', content: 'content' } },
        })),
        res, '/api/import', '/api/import',
        {
            store: { loreGraph: graph, loreVerbatim: verbatim, storageClient: { verbatimStore: verbatim.store.bind(verbatim), rawGraph: () => graph } } as never,
            detectedScope: { workspace: 'ws-import-unreg', ecosystem: '*' },
            deploymentMode: 'local', dataplane: null,
            supersessionEnforceDefault: true,
        } as never,
    );
    assert.equal(handled, true);
    assert.equal(res._status, 200, `route itself returns 200 with per-row errors; got ${res._status}: ${res._body}`);
    const body = jsonOf(res) as { errors?: Array<{ row: number; message: string }>; imported?: number };
    assert.equal(body.imported, 0, `nothing should have imported, got ${JSON.stringify(body)}`);
    assert.ok(body.errors && body.errors.length === 1, `expected 1 row error, got ${JSON.stringify(body)}`);
    assert.match(body.errors![0]!.message, /supersedes/, `expected a supersedes-related refusal, got ${JSON.stringify(body.errors![0])}`);
    assert.equal(graph.upsertCalls.length, 0, 'nothing written to the graph');
});

/* ─── 4-6. embedded lib: nodeUpsert / nodeUpsertBatch / bulkIngest ─────── */

const { createLore } = await import('../packages/lore/src/index.js');

function freshHome(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'd5-write-paths-home-'));
}

await test('embedded lib nodeUpsert(): missing supersedes is refused end-to-end (createLore({supersessionEnforce:true}))', async () => {
    const dataDir = freshHome();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', supersessionEnforce: true });
    try {
        const res = await lore.nodeUpsert({
            id: 'lib-1', workspace: 'default', ecosystem: '*',
            nodeData: { type: 'decision', label: 'D', content: 'body' },
        });
        assert.equal(res.ok, false, `expected refusal, got ${JSON.stringify(res)}`);
        if (!res.ok) assert.equal(res.code, 'missing_supersedes_field');
    } finally {
        await lore.dispose();
    }
});

await test('embedded lib nodeUpsertBatch(): one bad item is refused in its own result slot, others unaffected', async () => {
    const dataDir = freshHome();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', supersessionEnforce: true });
    try {
        const results = await lore.nodeUpsertBatch([
            { id: 'batch-good', workspace: 'default', ecosystem: '*', nodeData: { type: 'decision', label: 'Good', content: 'ok' }, supersedes: [] },
            { id: 'batch-bad', workspace: 'default', ecosystem: '*', nodeData: { type: 'decision', label: 'Bad', content: 'missing field' } },
        ]);
        assert.equal(results.length, 2);
        assert.equal(results[0]!.ok, true, `good item should succeed: ${JSON.stringify(results[0])}`);
        assert.equal(results[1]!.ok, false, `bad item should be refused: ${JSON.stringify(results[1])}`);
        if (!results[1]!.ok) assert.equal((results[1] as { code: string }).code, 'missing_supersedes_field');
    } finally {
        await lore.dispose();
    }
});

await test('embedded lib bulkIngest(): a bad node is refused in results[], the batch itself does not abort', async () => {
    const dataDir = freshHome();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', supersessionEnforce: true });
    try {
        const result = await lore.bulkIngest([
            { id: 'ing-good', workspace: 'default', ecosystem: '*', nodeData: { type: 'decision', label: 'Good', content: 'ok' }, supersedes: [] },
            { id: 'ing-bad', workspace: 'default', ecosystem: '*', nodeData: { type: 'decision', label: 'Bad', content: 'missing field' } },
        ] as never);
        assert.equal(result.count, 2);
        const good = result.results.find((r) => r.id === 'ing-good');
        const bad = result.results.find((r) => r.id === 'ing-bad');
        assert.ok(good?.ok, `good node should have ingested: ${JSON.stringify(good)}`);
        assert.equal(bad?.ok, false, `bad node should be refused: ${JSON.stringify(bad)}`);
        if (bad && !bad.ok) assert.match(bad.error, /supersedes/, `expected a supersedes-related error, got ${JSON.stringify(bad)}`);
    } finally {
        await lore.dispose();
    }
});

/* ─── 7. commit_changeset (mcp/changesetWrite.ts via registerVersioningTools) ── */

await test('commit_changeset: an upsert write missing supersedes is refused, changeset write does not silently bypass enforcement', async () => {
    const { registerVersioningTools } = await import('../packages/lore/src/mcp/tools/versioning.js');
    interface RecordedTool { name: string; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; }
    class FakeMcpServer {
        public tools: RecordedTool[] = [];
        tool(name: string, _d: string, _s: unknown, handler: RecordedTool['handler']) { this.tools.push({ name, handler }); }
    }
    let status: 'open' | 'committed' | 'rolled_back' = 'open';
    const writes = [{ seq: 0, operation: 'upsert_node' as const, payload: { workspace: 'ws-changeset-unreg', nodeData: { id: 'cs-refused', type: 'decision', label: 'D', content: 'body' } } }];
    const nodes = new Map<string, Record<string, unknown>>();
    const graph = {
        nodes,
        async upsertNode(n: Record<string, unknown>) { nodes.set(String(n['id']), n); return n; },
        async getNode(id: string) { return nodes.get(id) ?? null; },
        async deleteNode(id: string) { return nodes.delete(id); },
    };
    const versionStore = {
        getChangeset: (id: string) => ({ changesetId: id, workspace: 'ws-changeset-unreg', status }),
        getChangesetWrites: (_id: string) => writes,
        recordVersion: () => {},
        updateChangeset: (_id: string, s: typeof status) => { status = s; },
        getVersionsByChangeset: () => [],
        createChangeset: () => 'cs-1',
        getVersions: () => [], getDiff: () => [], addChangesetWrite: () => 1,
    };
    const verbatimWrites: Array<{ id: string; text: string }> = [];
    const deps = {
        versionStore: versionStore as never,
        store: { loreGraph: graph, storageClient: { verbatimStore: async (d: { id: string; text: string }) => { verbatimWrites.push(d); } }, loreVerbatim: { tombstone: async () => {} } } as never,
        graphRegistry: undefined,
        detectedScope: { workspace: 'ws-changeset-unreg', ecosystem: '*' },
        supersessionEnforceDefault: true,
    } as never;
    const srv = new FakeMcpServer();
    registerVersioningTools(srv as never, deps);
    const commit = srv.tools.find((t) => t.name === 'commit_changeset')!;
    const res = JSON.parse((await commit.handler({ changeset_id: 'cs-1' })).content[0]!.text) as Record<string, unknown>;
    // The changeset transaction itself still "commits" (status stays
    // 'committed') — what's refused is the individual write inside it,
    // surfaced as failed:1 + a supersedes-related message in errors[].
    // The node must never have landed on the graph either way.
    assert.equal(res['failed'], 1, `expected the one write to be refused, got ${JSON.stringify(res)}`);
    const errs = res['errors'] as string[] | undefined;
    assert.ok(errs && errs.some((e) => /supersedes/.test(e)), `expected a supersedes-related error, got ${JSON.stringify(res)}`);
    assert.ok(!nodes.has('cs-refused'), 'the refused node must not have been written to the graph');
});

/* ─── 8. Task A (#3): real near-duplicate via a genuine embedding pipeline ── */

console.log('\nD5 round 4 (#3) — near-duplicate detection from a REAL deterministic embedder, not a canned hit');

class DetEmbedProvider {
    readonly dimension = 8;
    readonly modelId = 'd5-write-paths-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
}

async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 50));
    }
    if (!(await cond())) throw new Error(`waitFor timed out: ${label}`);
}

await test('embedded profile (sqlite/sqlite): a close paraphrase of an existing decision is refused as an unlisted near-duplicate', async () => {
    const dataDir = freshHome();
    const lore = await createLore({ dataDir, deploymentMode: 'embedded', supersessionEnforce: true, embeddingProvider: new DetEmbedProvider() });
    try {
        const ORIGINAL = 'the team decided to migrate the build pipeline to esbuild for faster CI runs';
        const first = await lore.nodeUpsert({
            id: 'dup-original', workspace: 'default', ecosystem: '*',
            nodeData: { type: 'decision', label: 'Migrate build to esbuild', content: ORIGINAL },
            supersedes: [],
        });
        assert.equal(first.ok, true, `seed write must succeed: ${JSON.stringify(first)}`);

        // Flush the seed's async embed to LanceDB/SQLite vectors before the
        // near-dup search below can find it.
        await lore.awaitEmbeds();

        // A close paraphrase (DetEmbedProvider is deterministic — shared
        // character content cosine-matches; same technique + same comment
        // rationale as vector-engine-promotion-e2e-unit.ts line ~204).
        const PARAPHRASE = 'the team decided to migrate the build pipeline to esbuild for faster CI run';
        let dup: Awaited<ReturnType<typeof lore.nodeUpsert>> | undefined;
        // The vector row lands asynchronously via the outbox; poll rather
        // than assume the first attempt already sees it indexed.
        await waitFor(async () => {
            dup = await lore.nodeUpsert({
                id: `dup-attempt-${Date.now()}`, workspace: 'default', ecosystem: '*',
                nodeData: { type: 'decision', label: 'Migrate build to esbuild', content: PARAPHRASE },
                supersedes: [],
            });
            return dup.ok === false && !dup.ok && dup.code === 'unlisted_near_duplicate';
        }, 15_000, 'paraphrase write is refused as a near-duplicate once the seed vector is indexed');
        assert.ok(dup && !dup.ok && dup.code === 'unlisted_near_duplicate', `expected unlisted_near_duplicate, got ${JSON.stringify(dup)}`);
    } finally {
        await lore.dispose();
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
