#!/usr/bin/env tsx
/**
 * sw20-stream-reconnect-unit.ts — SW-20 regression (findings E3, E7, E11).
 *
 * Proves the streaming/chunked reconnect rewrite:
 *
 *   A. (E3) reconnectGraph PAGES the node load via the cursor-paginated
 *      graph.bulkList instead of `graph.listNodes()` (which materialized the
 *      whole node table). A 2,500-node graph with PAGE_SIZE=1000 must be
 *      walked in multiple bounded bulkList calls, and listNodes must NOT be
 *      called on the reconnect hot path.
 *
 *   B. (E3) reconnect resolves the --only-changed contentHashes via the
 *      CHUNKED verbatim.getContentHashesByIds (one id-IN query per ≤500-id
 *      chunk) and NOT via a per-node verbatim.getById (1M nodes ⇒ 1M serial
 *      scans). We assert getById is never called and getContentHashesByIds
 *      receives the page's ids.
 *
 *   C. (E7) VerbatimStore.storeBatch resolves contentHashes in CHUNKED
 *      `contentHash IN (...)` queries (≤500 ids/predicate), not one
 *      `contentHash = '...'` scan per doc. We instrument the live LanceDB
 *      table's query().where() and assert the predicate shape + chunk size.
 *
 * Fails on base (serial getById + per-doc lookupByContentHash), passes on
 * the SW-20 branch.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/sw20-stream-reconnect-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { reconnectGraph } from '../packages/lore/src/engines/reconnect.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import type { BulkListQuery, BulkListPage } from '../packages/lore/src/providers/types.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sw20-lore-'));
process.env['LORE_HOME'] = TEST_HOME;

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
        if (process.env['SW20_DEBUG']) console.error((e as Error).stack);
        failed++;
    }
};

interface FakeNode {
    id: string;
    type: string;
    label: string;
    content: string;
    tags: string;
    project: string;
    ecosystem: string;
    updatedAt: string;
    security_scopes: string[];
}

/**
 * Cursor-paginated fake graph. Records every bulkList page request and flags
 * any listNodes call so the test can assert reconnect never falls back to the
 * unbounded load-everything path.
 */
function makeFakeGraph(nodes: FakeNode[]) {
    const calls = { bulkListPages: [] as number[], listNodesCalls: 0, maxPageSize: 0 };
    // Stable (updatedAt DESC, id ASC) order — matches the real bulkList contract.
    const sorted = [...nodes].sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : (a.id < b.id ? -1 : 1));
    const graph = {
        async bulkList(q: BulkListQuery): Promise<BulkListPage> {
            calls.maxPageSize = Math.max(calls.maxPageSize, q.limit);
            let start = 0;
            if (q.cursor) {
                const idx = sorted.findIndex((n) =>
                    n.updatedAt === q.cursor!.updatedAt && n.id === q.cursor!.id);
                start = idx >= 0 ? idx + 1 : 0;
            }
            const slice = sorted.slice(start, start + q.limit);
            calls.bulkListPages.push(slice.length);
            const hasMore = start + q.limit < sorted.length;
            const last = slice[slice.length - 1];
            return {
                nodes: slice as unknown as Array<Record<string, unknown>>,
                hasMore,
                nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
            };
        },
        async listNodes(): Promise<unknown[]> {
            calls.listNodesCalls++;
            return nodes as unknown[];
        },
        async addEdge() { /* unused in dryRun */ },
        async pruneInferredLoreEdges() { return 0; },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { graph: graph as any, calls };
}

/**
 * Spy vector store. Records getById vs getContentHashesByIds usage and the
 * id-set passed to the chunked resolver, while no-op'ing the embed/search so
 * the test stays fast and deterministic.
 */
function makeSpyVerbatim() {
    const calls = {
        getByIdCalls: 0,
        hashResolveCalls: 0,
        hashResolveIdCounts: [] as number[],
        storeBatchCalls: 0,
        storeBatchDocCounts: [] as number[],
    };
    const store = {
        async initialize() { /* no-op */ },
        async getById() { calls.getByIdCalls++; return null; },
        async getContentHashesByIds(ids: string[]) {
            calls.hashResolveCalls++;
            calls.hashResolveIdCounts.push(ids.length);
            return new Map<string, string>(); // all "changed" → embed every node
        },
        async storeBatch(docs: unknown[]) {
            calls.storeBatchCalls++;
            calls.storeBatchDocCounts.push(docs.length);
        },
        async search() { return []; },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { store: store as any, calls };
}

function makeNodes(n: number): FakeNode[] {
    return Array.from({ length: n }, (_, i) => ({
        id: `n${String(i).padStart(5, '0')}`,
        type: 'lore',
        label: `node ${i}`,
        content: `content body ${i}`,
        tags: 'a,b',
        project: 'p',
        ecosystem: 'e',
        // Distinct, monotonically-decreasing timestamps for a stable order.
        updatedAt: new Date(2_000_000_000_000 - i * 1000).toISOString(),
        security_scopes: [],
    }));
}

(async () => {
    console.log('SW-20 — streaming reconnect: paged node load + chunked hash resolution');

    /* ── A+B (E3): reconnect pages bulkList and chunk-resolves hashes ── */
    await test('A1 — node load is PAGED via bulkList, not a single listNodes()', async () => {
        const { graph, calls: gcalls } = makeFakeGraph(makeNodes(2500));
        const { store } = makeSpyVerbatim();
        await reconnectGraph(graph, store, { dryRun: true });

        assert.equal(gcalls.listNodesCalls, 0,
            `reconnect must NOT call the unbounded listNodes() (got ${gcalls.listNodesCalls})`);
        assert.ok(gcalls.bulkListPages.length >= 3,
            `2500 nodes must page in >=3 bulkList calls (got ${gcalls.bulkListPages.length})`);
        // Every page is bounded — no page returns the whole corpus.
        assert.ok(gcalls.maxPageSize <= 1000,
            `page size must be bounded ≤1000 (got ${gcalls.maxPageSize})`);
        for (const sz of gcalls.bulkListPages) {
            assert.ok(sz <= 1000, `each page bounded ≤1000 (got a page of ${sz})`);
        }
    });

    await test('B1 — hashes resolved via CHUNKED getContentHashesByIds, never per-node getById', async () => {
        const { graph } = makeFakeGraph(makeNodes(2500));
        const { store, calls: vcalls } = makeSpyVerbatim();
        await reconnectGraph(graph, store, { dryRun: true });

        assert.equal(vcalls.getByIdCalls, 0,
            `reconnect must NOT do a per-node getById (got ${vcalls.getByIdCalls} — that's the O(N)-scan bug)`);
        assert.ok(vcalls.hashResolveCalls >= 3,
            `hash resolution must run once per page (got ${vcalls.hashResolveCalls})`);
        // Each resolver call carries at most one page worth of ids (bounded).
        for (const c of vcalls.hashResolveIdCounts) {
            assert.ok(c > 0 && c <= 1000, `each resolve call is page-bounded (got ${c})`);
        }
        const totalResolved = vcalls.hashResolveIdCounts.reduce((a, b) => a + b, 0);
        assert.equal(totalResolved, 2500, `every node id resolved exactly once (got ${totalResolved})`);
    });

    await test('B2 — force:true skips hash resolution but still pages', async () => {
        const { graph, calls: gcalls } = makeFakeGraph(makeNodes(1500));
        const { store, calls: vcalls } = makeSpyVerbatim();
        await reconnectGraph(graph, store, { dryRun: true, force: true });
        assert.equal(vcalls.getByIdCalls, 0, 'no per-node getById under force');
        assert.equal(vcalls.hashResolveCalls, 0, 'force skips the only-changed resolver entirely');
        assert.ok(gcalls.bulkListPages.length >= 2, 'still paged under force');
    });

    /* ── C (E7): storeBatch resolves hashes via chunked contentHash IN ── */
    await test('C1 — storeBatch resolves contentHashes in CHUNKED `contentHash IN (...)`', async () => {
        const ws = path.join(TEST_HOME, 'ws-c');
        const store = new VerbatimStore(ws);
        await store.initialize();
        try {
            // Seed one doc so the live LanceDB table exists, then instrument
            // table.query().where() to record predicate shapes.
            await store.store({ id: 'lore:seed', text: 'seed', metadata: {} });

            const whereClauses: string[] = [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const table = (store as any).table;
            assert.ok(table, 'live LanceDB table available after seed');
            const origQuery = table.query.bind(table);
            table.query = () => {
                const builder = origQuery();
                const origWhere = builder.where.bind(builder);
                builder.where = (clause: string) => {
                    whereClauses.push(clause);
                    return origWhere(clause);
                };
                return builder;
            };

            // 1200 docs through storeBatch. Base (per-doc lookupByContentHash)
            // would emit ~1200 `contentHash = '...'` predicates; the SW-20
            // chunked resolver emits ceil(1200/500)=3 `contentHash IN (...)`.
            const docs = Array.from({ length: 1200 }, (_, i) => ({
                id: `lore:batch${i}`,
                text: `batch doc ${i}`,
                metadata: {},
            }));
            await store.storeBatch(docs);

            const inClauses = whereClauses.filter((c) => /contentHash IN \(/.test(c));
            const eqClauses = whereClauses.filter((c) => /contentHash = '/.test(c));
            assert.ok(inClauses.length >= 1,
                `storeBatch must use chunked contentHash IN(...) (got ${inClauses.length})`);
            assert.equal(eqClauses.length, 0,
                `storeBatch must NOT do per-doc contentHash='...' scans (got ${eqClauses.length} — the E7 bug)`);
            // Chunk discipline: each IN predicate holds ≤500 quoted ids.
            for (const c of inClauses) {
                const count = (c.match(/'/g)?.length ?? 0) / 2;
                assert.ok(count <= 500, `each IN chunk ≤500 ids (got ${count})`);
            }
            // 1200 unique hashes / 500 ⇒ at most 3 hash-resolution chunks.
            assert.ok(inClauses.length <= 4,
                `~1200 docs resolve in a handful of chunks, not per-doc (got ${inClauses.length})`);
        } finally {
            await store.close();
        }
    });

    /* ── E11: FTS index ensure path exists ─────────────────────────── */
    await test('D1 — ensureFtsIndex exists and is non-fatal below threshold', async () => {
        const ws = path.join(TEST_HOME, 'ws-d');
        const store = new VerbatimStore(ws);
        await store.initialize();
        try {
            await store.store({ id: 'lore:fts', text: 'hello world', metadata: {} });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            assert.equal(typeof (store as any).ensureFtsIndex, 'function',
                'ensureFtsIndex is the FTS sibling of ensureVectorIndex');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const built = await (store as any).ensureFtsIndex({ minRows: 100000 });
            assert.equal(built, false, 'below minRows → no index built, no throw');
        } finally {
            await store.close();
        }
    });

    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
