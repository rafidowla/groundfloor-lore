#!/usr/bin/env tsx
/**
 * test/mark-stale-outbox-unit.ts — X-markstale audit regression (2026-09-03).
 *
 * Pre-fix bug: `mark_stale` (mcp/tools/memory/markStale.ts) and
 * POST /api/mark-stale (mcp/http/routes/retention/policy.ts) called
 * `graph.markStaleByTags(tags)` directly — no outbox row, no per-node lock.
 * A crash between resolving the tag match and applying the flag lost the
 * operation entirely, and no cross-substrate consumer or replay/crash-
 * recovery could ever see a staleness change that WAS applied but not yet
 * durably recorded. The malformed-JSON body on the REST route also came
 * back as a 500 internal_error instead of a 400.
 *
 * Fix: both entry points now resolve the tag-matched ids FIRST
 * (`graph.findNodeIdsByTags`), then apply in per-chunk
 * (`core/nodeWriteLock.ts` BULK_LOCK_CHUNK_SIZE) locked + outbox-recorded
 * regions (`node.mark_stale` outbox rows, applied via `graph.markStaleByIds`)
 * — mirroring bulkWriteEdgesDelete.ts's handleBulkDelete chunking. The
 * dispatcher (outbox/dispatcher.ts) and the local + arcade wirings
 * (outbox/wiring.ts, engines/arcade/arcadeOutboxWiring.ts) now know how to
 * replay a `node.mark_stale` row. The REST route's JSON.parse is now in its
 * own try/catch returning 400 invalid_json_body.
 *
 * Cases:
 *   1. mark_stale (MCP tool) records `node.mark_stale` outbox rows for
 *      EXACTLY the matched ids (not more, not fewer) and applies the flag.
 *   2. A full replay of those rows through the real dispatcher, on a FRESH
 *      (empty) graph built from a brand-new `wireOutbox()`, reconstructs the
 *      SAME staleness state — proving crash-recovery sees it.
 *   3. mark_stale racing a concurrent `nodeUpsert()` on the SAME id
 *      converges: both calls succeed, and the real end-state (node content
 *      from the upsert, stale=true from the mark) is reproduced by a full
 *      replay onto a separate fresh graph.
 *   4. POST /api/mark-stale with a malformed JSON body returns 400
 *      invalid_json_body, not a 500.
 *
 * Shape: the real production stack, no mocks — a real `SurrealGraph`, a real
 * `VerbatimStore`, a real `FileOutboxStore`, the REAL `registerMarkStaleTool`
 * / `tryPolicyRoutes` handlers (captured via a fake req/res, mirroring
 * test/bulk-delete-outbox-lock-order-unit.ts), the REAL `nodeUpsert()`, and
 * the REAL `dispatch()` (outbox/dispatcher.ts) driven by REAL substrates
 * `wireOutbox()` builds.
 *
 * Run: npx tsx test/mark-stale-outbox-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';
import { nodeUpsert } from '../packages/lore/src/core/nodeService.js';
import { registerMarkStaleTool } from '../packages/lore/src/mcp/tools/memory/markStale.js';
import { tryPolicyRoutes } from '../packages/lore/src/mcp/http/routes/retention/policy.js';
import { dispatch, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import { wireOutbox } from '../packages/lore/src/outbox/wiring.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';

class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'mark-stale-outbox-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Real replicator substrates over a given (graph, verbatim) pair — used to
 *  replay outbox rows onto either the SAME substrates or a FRESH pair. */
function realDispatchSubstrates(graph: SurrealGraph, store: VerbatimStore): DispatcherSubstrates {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-mark-stale-wiring-'));
    const wiring = wireOutbox({
        loreDir: tmp,
        getSyncEngine: () => ({ recoverVectorMirror: async () => ({ recovered: 0, skipped: 0 }) }) as never,
        getGraph: () => graph as never,
        getVerbatim: () => store,
    });
    return (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
}

interface ToolBag {
    [name: string]: (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
    }>;
}
function makeMcpServerStub(): { server: object; tools: ToolBag } {
    const tools: ToolBag = {};
    const server = {
        tool: (name: string, ..._rest: unknown[]) => {
            const handler = _rest[_rest.length - 1];
            if (typeof handler === 'function') tools[name] = handler as ToolBag[string];
        },
    };
    return { server, tools };
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

async function markStaleOutboxRows(outboxStore: FileOutboxStore, ws: string): Promise<OutboxEntry[]> {
    const rows = await outboxStore.listPendingForWorkspace(ws, 10_000);
    return rows.filter((r) => r.operationKind === 'node.mark_stale');
}

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

console.log('\nmark_stale outbox durability + REST malformed-body regression (X-markstale)\n');

test('1: mark_stale (MCP) records node.mark_stale outbox rows for EXACTLY the matched ids and applies the flag', async () => {
    const g = mkTmp('lore-markstale-1-g-');
    const v = mkTmp('lore-markstale-1-v-');
    const o = mkTmp('lore-markstale-1-o-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    await graph.initialize();
    await store.initialize();
    const ws = 'markstale-1-ws';
    try {
        const matching = ['ms1-a', 'ms1-b', 'ms1-c'];
        const other = 'ms1-other';
        for (const id of [...matching, other]) {
            const tags = id === other ? ['unrelated-tag'] : ['stale-me'];
            const seed = await nodeUpsert(
                { id, workspace: ws, ecosystem: '*', initiator: 'test:seed',
                  nodeData: { id, type: 'note', label: 'seed', content: `seed-${id}`, tags, security_scopes: [] as string[] },
                  targetGraph: graph },
                { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
            );
            assert.equal(seed.ok, true, `seed write for ${id} must succeed`);
        }

        const { server, tools } = makeMcpServerStub();
        registerMarkStaleTool(server as never, {
            store: { loreGraph: graph, loreVerbatim: store } as never,
            graphRegistry: undefined,
            detectedScope: { workspace: ws, ecosystem: '*' },
            outboxStore,
            auditLog: { log: () => undefined } as never,
        } as never);

        const res = await tools['mark_stale']!({ tags: ['stale-me'], workspace: ws });
        assert.ok(!res.isError, `expected ok, got: ${res.content[0]?.text}`);
        const parsed = JSON.parse(res.content[0]!.text) as { marked: number; ok: boolean };
        assert.equal(parsed.ok, true, 'response ok must be true');
        assert.equal(parsed.marked, matching.length, `expected ${matching.length} marked, got ${parsed.marked}`);

        for (const id of matching) {
            const node = await graph.getNode(id);
            assert.ok(node, `${id} must still exist`);
            assert.equal((node as unknown as { stale?: boolean }).stale, true, `${id} must be stale`);
        }
        const otherNode = await graph.getNode(other);
        assert.notEqual((otherNode as unknown as { stale?: boolean })?.stale, true, `${other} (non-matching tag) must NOT be stale`);

        // Exactly the matched ids across all node.mark_stale rows — no more,
        // no fewer (this is the actual pre-fix bug: NO row existed at all).
        const rows = await markStaleOutboxRows(outboxStore, ws);
        assert.ok(rows.length > 0, 'at least one node.mark_stale outbox row must have been recorded');
        const recordedIds = rows
            .flatMap((r) => {
                const p = r.payload as { ids?: unknown } | undefined;
                return Array.isArray(p?.ids) ? p!.ids as string[] : [];
            })
            .sort();
        assert.deepEqual(recordedIds, [...matching].sort(), 'node.mark_stale row(s) must carry exactly the matched ids');
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup();
    }
});

test('2: a full replay through the real dispatcher, on a FRESH wiring + FRESH graph, reconstructs the staleness flag', async () => {
    const g = mkTmp('lore-markstale-2-g-');
    const v = mkTmp('lore-markstale-2-v-');
    const o = mkTmp('lore-markstale-2-o-');
    const freshG = mkTmp('lore-markstale-2-freshg-');
    const freshV = mkTmp('lore-markstale-2-freshv-');
    const graph = new SurrealGraph(g.dir);
    const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
    const outboxStore = new FileOutboxStore(o.dir);
    const freshGraph = new SurrealGraph(freshG.dir);
    const freshStore = new VerbatimStore(freshV.dir, new ConstEmbedProvider());
    await graph.initialize();
    await store.initialize();
    await freshGraph.initialize();
    await freshStore.initialize();
    const ws = 'markstale-2-ws';
    try {
        const ids = ['ms2-a', 'ms2-b'];
        for (const id of ids) {
            const seed = await nodeUpsert(
                { id, workspace: ws, ecosystem: '*', initiator: 'test:seed',
                  nodeData: { id, type: 'note', label: 'seed', content: `seed-${id}`, tags: ['stale-me-2'], security_scopes: [] as string[] },
                  targetGraph: graph },
                { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
            );
            assert.equal(seed.ok, true);
        }

        const { server, tools } = makeMcpServerStub();
        registerMarkStaleTool(server as never, {
            store: { loreGraph: graph, loreVerbatim: store } as never,
            graphRegistry: undefined,
            detectedScope: { workspace: ws, ecosystem: '*' },
            outboxStore,
            auditLog: { log: () => undefined } as never,
        } as never);
        const res = await tools['mark_stale']!({ tags: ['stale-me-2'], workspace: ws });
        assert.ok(!res.isError);

        // Crash-recovery / replay simulation: a BRAND NEW replicator wiring
        // (fresh outbox home dir for the store.batchRecord scratch, but
        // reading the SAME outboxStore's rows) applying to a completely
        // separate, empty graph + verbatim pair. If the fix's outbox rows
        // are correct, replaying them alone reconstructs the same state
        // `node.upsert` + `node.mark_stale` produced live.
        const substrates = realDispatchSubstrates(freshGraph, freshStore);
        const allPending = await outboxStore.listPendingForWorkspace(ws, 10_000);
        assert.ok(allPending.length > 0, 'there must be pending rows to replay');
        for (const entry of allPending) await dispatch(entry, substrates);

        for (const id of ids) {
            const node = await freshGraph.getNode(id);
            assert.ok(node, `${id} must exist on the fresh graph after replay`);
            assert.equal((node as unknown as { stale?: boolean }).stale, true, `${id} must be stale on the fresh graph after replay`);
        }
    } finally {
        await store.close().catch(() => undefined);
        await graph.close().catch(() => undefined);
        await freshStore.close().catch(() => undefined);
        await freshGraph.close().catch(() => undefined);
        g.cleanup(); v.cleanup(); o.cleanup(); freshG.cleanup(); freshV.cleanup();
    }
});

test('3: mark_stale racing a concurrent nodeUpsert on the SAME id converges (both succeed; replay reproduces the real end-state)', async () => {
    const ITERATIONS = 5;
    const mismatches: string[] = [];
    for (let run = 0; run < ITERATIONS; run++) {
        const g = mkTmp(`lore-markstale-3-g${run}-`);
        const v = mkTmp(`lore-markstale-3-v${run}-`);
        const o = mkTmp(`lore-markstale-3-o${run}-`);
        const freshG = mkTmp(`lore-markstale-3-freshg${run}-`);
        const freshV = mkTmp(`lore-markstale-3-freshv${run}-`);
        const graph = new SurrealGraph(g.dir);
        const store = new VerbatimStore(v.dir, new ConstEmbedProvider());
        const outboxStore = new FileOutboxStore(o.dir);
        const freshGraph = new SurrealGraph(freshG.dir);
        const freshStore = new VerbatimStore(freshV.dir, new ConstEmbedProvider());
        await graph.initialize();
        await store.initialize();
        await freshGraph.initialize();
        await freshStore.initialize();
        const ws = `markstale-3-ws-${run}`;
        try {
            const shared = 'ms3-shared';
            const seed = await nodeUpsert(
                { id: shared, workspace: ws, ecosystem: '*', initiator: 'test:seed',
                  nodeData: { id: shared, type: 'note', label: 'seed', content: 'seed-content', tags: ['race-tag'], security_scopes: [] as string[] },
                  targetGraph: graph },
                { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
            );
            assert.equal(seed.ok, true);

            const { server, tools } = makeMcpServerStub();
            registerMarkStaleTool(server as never, {
                store: { loreGraph: graph, loreVerbatim: store } as never,
                graphRegistry: undefined,
                detectedScope: { workspace: ws, ecosystem: '*' },
                outboxStore,
                auditLog: { log: () => undefined } as never,
            } as never);

            const markPromise = tools['mark_stale']!({ tags: ['race-tag'], workspace: ws });
            const upsertPromise = (async () => {
                await delay(2); // starts just after mark_stale resolves its id set, well before it applies the chunk
                return nodeUpsert(
                    { id: shared, workspace: ws, ecosystem: '*', initiator: 'test:concurrent-upsert',
                      nodeData: { id: shared, type: 'note', label: 'race-winner', content: 'RACE-WINNER-CONTENT', tags: ['race-tag'], security_scopes: [] as string[] },
                      targetGraph: graph },
                    { outboxStore, inlineVerbatim: { verbatimStore: (w) => store.store(w) } },
                );
            })();

            const [markResult, upsertResult] = await Promise.all([markPromise, upsertPromise]);
            assert.ok(!markResult.isError, `run ${run}: mark_stale must not error: ${markResult.content[0]?.text}`);
            assert.equal(upsertResult.ok, true, `run ${run}: the concurrent upsert must still report success`);

            const realNode = await graph.getNode(shared);
            const realStale = !!(realNode as unknown as { stale?: boolean } | null)?.stale;
            const realContent = (realNode as unknown as { content?: string } | null)?.content;

            // Regardless of interleave order, upsertNode preserves the prior
            // `stale` value when its own payload doesn't set one (Match-then-
            // Merge — see surrealGraphWrites.ts upsertNode), so the two
            // orderings converge to the SAME outcome: content from the
            // upsert, stale=true from the mark. A regression that reordered
            // the lock/outbox-commit around the substrate write would show
            // up here as stale=false or as an exception above.
            if (!realStale || realContent !== 'RACE-WINNER-CONTENT') {
                mismatches.push(`run ${run}: expected content=RACE-WINNER-CONTENT/stale=true, got content=${String(realContent)}/stale=${realStale}`);
            }

            // Full replay onto an independent fresh graph must reproduce the
            // SAME real end-state.
            const substrates = realDispatchSubstrates(freshGraph, freshStore);
            const allPending = await outboxStore.listPendingForWorkspace(ws, 10_000);
            for (const entry of allPending) await dispatch(entry, substrates);
            const replayedNode = await freshGraph.getNode(shared);
            const replayedStale = !!(replayedNode as unknown as { stale?: boolean } | null)?.stale;
            const replayedContent = (replayedNode as unknown as { content?: string } | null)?.content;
            if (replayedStale !== realStale || replayedContent !== realContent) {
                mismatches.push(
                    `run ${run}: replay diverged from real end-state (real content=${String(realContent)}/stale=${realStale}, replay content=${String(replayedContent)}/stale=${replayedStale})`,
                );
            }
        } finally {
            await store.close().catch(() => undefined);
            await graph.close().catch(() => undefined);
            await freshStore.close().catch(() => undefined);
            await freshGraph.close().catch(() => undefined);
            g.cleanup(); v.cleanup(); o.cleanup(); freshG.cleanup(); freshV.cleanup();
        }
    }
    assert.deepEqual(mismatches, [], `mark_stale vs concurrent upsert race diverged:\n      ${mismatches.join('\n      ')}`);
});

test('4: POST /api/mark-stale with a malformed JSON body returns 400 invalid_json_body, not a 500', async () => {
    const g = mkTmp('lore-markstale-4-g-');
    const graph = new SurrealGraph(g.dir);
    await graph.initialize();
    try {
        const res = fakeRes();
        const req = fakePostReqWithBody('{ this is not valid json ]');
        const handled = await tryPolicyRoutes(req, res, {
            store: { loreGraph: graph } as never,
            auditLog: { log: () => undefined } as never,
            runRetentionSweep: (async () => ({})) as never,
            deploymentMode: 'local',
            dataplane: null,
            detectedScope: { workspace: 'markstale-4-ws', ecosystem: '*' },
        } as never, '/api/mark-stale');

        assert.equal(handled, true, 'the route must claim the request');
        assert.equal(res._status, 400, `expected 400, got ${res._status}: ${res._body}`);
        const body = JSON.parse(res._body) as { code: string };
        assert.equal(body.code, 'invalid_json_body', `expected invalid_json_body, got ${body.code}`);
    } finally {
        await graph.close().catch(() => undefined);
        g.cleanup();
    }
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
