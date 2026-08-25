#!/usr/bin/env tsx
/**
 * nw7b-sync-correctness-unit.ts — NW-7b regression tests.
 *
 * Five sync-surface correctness fixes — all live in the same engine file
 * (engines/syncEngine.ts) and would each FAIL on base:
 *
 *   (1) err-pullremote-silent-failure-indistinguishable
 *       pullRemote() swallowed mid-pull errors and returned (0, 0, 0) —
 *       indistinguishable from "nothing new". Now returns a PullResult
 *       with optional `error` field + emits a structured-logger
 *       error-level record. Caller can distinguish + retry.
 *
 *   (2) err-vector-mirror-outbox-step-marked-done-on-failure
 *       The outbox 'sync.vector.mirror' step was unconditionally marked
 *       'done' even when EVERY mirror in the chunk failed silently. The
 *       step is now marked 'failed' when 100% of the chunk fails, so
 *       outbox recovery re-runs it.
 *
 *   (3) corr-pull-edges-silently-dropped
 *       A bare `try { addEdge } catch {}` ate every failure AND the pull
 *       cursor advanced past those edges. Failed edges now persist to
 *       `.lore/.last-sync.pull-edge-dlq.jsonl` and surface via
 *       PullResult.edgesDeadLettered.
 *
 *   (4) corr-pull-no-pagination-1000-cap
 *       Remote pull was hard-capped at 1000 records with no pagination.
 *       pullRemote() now loops, advancing `since` to the page's max
 *       updatedAt, until the adapter returns < 1000 records OR the
 *       safety cap (PULL_MAX_PAGES) is hit.
 *
 *   (5) corr-marksynced-stale-during-push
 *       markSynced flipped a node's `syncedAt` even when a NEWER local
 *       edit landed in the WAL between push-start and now. The new
 *       implementation re-reads the WAL post-push and skips markSynced
 *       for any nodeId that was re-appended mid-push — so next cycle
 *       re-pushes the newer version and recall doesn't read a row whose
 *       `syncedAt` lies about its actual sync state.
 *
 * Each test would FAIL on base (the legacy syncEngine.ts before this
 * commit) and PASSES on this branch.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    SyncEngine,
    type SyncAdapter,
    type SyncResult,
} from '../packages/lore/src/engines/syncEngine.js';
import type { LoreNode, LoreEdge } from '../packages/lore/src/providers/types.js';
import { FileOutboxStore } from '../packages/lore/src/outbox/store.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

function tmpLoreDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'nw7b-sync-'));
}

/**
 * Minimal local-graph stub used by pullRemote / pushPending. Records
 * markSynced calls so test (5) can assert on them. Records addEdge
 * failures so test (3) can drive a programmable edge-apply failure.
 */
function makeGraph(opts?: {
    edgeApplyShouldThrow?: (e: LoreEdge) => string | null;
}) {
    const nodes = new Map<string, LoreNode>();
    const markSyncedCalls: string[] = [];
    const edgesApplied: LoreEdge[] = [];
    return {
        markSyncedCalls,
        edgesApplied,
        nodes,
        async getNode(id: string): Promise<LoreNode | null> { return nodes.get(id) ?? null; },
        async upsertNode(n: LoreNode): Promise<void> { nodes.set(n.id, n); },
        async addEdge(e: LoreEdge): Promise<void> {
            const msg = opts?.edgeApplyShouldThrow?.(e) ?? null;
            if (msg) throw new Error(msg);
            edgesApplied.push(e);
        },
        async markSynced(id: string): Promise<void> { markSyncedCalls.push(id); },
    };
}

interface ProgAdapter extends SyncAdapter {
    pullSinceArgs: string[];
    pullResults: Array<{ nodes: LoreNode[]; edges: LoreEdge[] }>;
    pullThrowOn?: number; // index into pullSinceArgs at which the adapter throws
    pushSideEffect?: () => void; // runs synchronously inside push
}

function makeAdapter(over?: Partial<ProgAdapter>): ProgAdapter {
    const a: ProgAdapter = {
        pullSinceArgs: [],
        pullResults: [],
        async push(nodes: LoreNode[], edges: LoreEdge[]): Promise<SyncResult> {
            if (a.pushSideEffect) a.pushSideEffect();
            return { nodesPushed: nodes.length, edgesPushed: edges.length, failures: 0, errors: [] };
        },
        async pushDeletes(ids: string[]): Promise<SyncResult> {
            return { nodesPushed: ids.length, edgesPushed: 0, failures: 0, errors: [] };
        },
        async pull(since: string) {
            const idx = a.pullSinceArgs.length;
            a.pullSinceArgs.push(since);
            if (a.pullThrowOn !== undefined && a.pullThrowOn === idx) {
                throw new Error('synthetic mid-pull failure');
            }
            return a.pullResults[idx] ?? { nodes: [], edges: [] };
        },
        async isConnected() { return true; },
        async connect() { /* no-op */ },
        async disconnect() { /* no-op */ },
        ...over,
    };
    return a;
}

/** Vector store stub that always fails — used for test (2). */
function makeFailingVectorStore() {
    return {
        async store(): Promise<void> { throw new Error('synthetic vector store failure'); },
    };
}

const EPOCH = '1970-01-01T00:00:00.000Z';

(async () => {
    console.log('NW-7b · sync-surface correctness (5 fixes grouped)');

    // ───────────────────────────────────────────────────────────────────
    // (1) pullRemote distinguishes "nothing new" from "mid-pull error"
    // ───────────────────────────────────────────────────────────────────
    await test('(1) pullRemote returns error field on mid-pull failure', async () => {
        const dir = tmpLoreDir();
        const graph = makeGraph();
        const adapter = makeAdapter();
        adapter.pullThrowOn = 0; // first pull throws
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);
        const r = await engine.pullRemote();

        // Behavioural distinction: on base, this returned identically to
        // a successful empty pull. The fix surfaces `error` so callers
        // can distinguish — and the error message must propagate.
        assert.ok(r.error !== undefined,
            `pullRemote must surface error field on mid-pull failure (got ${JSON.stringify(r)})`);
        assert.match(r.error!, /synthetic mid-pull failure/,
            'error field must carry the underlying adapter error');

        // Cursor MUST NOT have advanced past epoch on a failed pull.
        const pullCursorPath = path.join(dir, '.last-sync.pull');
        const cursorOnDisk = fs.existsSync(pullCursorPath)
            ? fs.readFileSync(pullCursorPath, 'utf-8').trim()
            : '';
        assert.ok(!cursorOnDisk || cursorOnDisk === EPOCH || cursorOnDisk === '',
            `pull cursor must NOT advance on mid-pull failure (got ${cursorOnDisk})`);
    });

    await test('(1) pullRemote with no error returns NO error field', async () => {
        const dir = tmpLoreDir();
        const graph = makeGraph();
        const adapter = makeAdapter();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);
        const r = await engine.pullRemote();
        // The error field is OPTIONAL — clean pulls leave it undefined so
        // existing callers stay unaffected.
        assert.equal(r.error, undefined, 'clean pull must not set error field');
        assert.equal(r.nodesPulled, 0);
        assert.equal(r.edgesPulled, 0);
    });

    // ───────────────────────────────────────────────────────────────────
    // (2) Vector-mirror outbox step is 'failed' when every mirror failed
    // ───────────────────────────────────────────────────────────────────
    await test('(2) outbox sync.vector.mirror step is marked failed when every mirror fails', async () => {
        const dir = tmpLoreDir();
        const graph = makeGraph();
        const adapter = makeAdapter();
        const node: LoreNode = {
            id: 'n-vec-fail',
            type: 'fact', label: 'L', content: 'C', tags: '', project: '*', ecosystem: '*',
            metadata: '{}',
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
            syncedAt: '',
        };
        adapter.pullResults = [{ nodes: [node], edges: [] }];

        const failingVS = makeFailingVectorStore();
        const outbox = new FileOutboxStore(dir);
        const engine = new SyncEngine(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            graph as any, dir, adapter,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            failingVS as any,
            outbox,
        );
        const r = await engine.pullRemote();
        assert.equal(r.nodesPulled, 1, 'graph upsert must still happen — only vector mirror failed');

        // Inspect the outbox: there must be an entry whose
        // 'sync.vector.mirror' step is 'failed' (not 'done').
        const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'outbox.json'), 'utf-8'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries = Object.values(persisted) as any[];
        const mirrorEntries = entries.filter(e =>
            Array.isArray(e.steps) && e.steps.some((s: { kind: string }) => s.kind === 'sync.vector.mirror'),
        );
        assert.ok(mirrorEntries.length >= 1, 'a sync.vector.mirror outbox entry must have been recorded');
        const failedStep = mirrorEntries[0].steps.find((s: { kind: string }) => s.kind === 'sync.vector.mirror');
        assert.equal(
            failedStep.status, 'failed',
            `outbox step must be 'failed' when every mirror failed (got '${failedStep.status}')`,
        );
        // And the entry must NOT have been marked completed — recovery
        // needs to see it as unfinished.
        assert.equal(mirrorEntries[0].completed, false,
            'entry must remain uncompleted so recovery picks it up');
    });

    // ───────────────────────────────────────────────────────────────────
    // (3) Pulled edges that fail apply go to DLQ (not silently dropped)
    // ───────────────────────────────────────────────────────────────────
    await test('(3) pulled edges that fail to apply are dead-lettered, not silently dropped', async () => {
        const dir = tmpLoreDir();
        const graph = makeGraph({
            edgeApplyShouldThrow: (e) => e.sourceId === 'bad-src' ? 'fk-violation: missing endpoint' : null,
        });
        const adapter = makeAdapter();
        const goodEdge: LoreEdge = { sourceId: 'a', targetId: 'b', relation: 'rel1' };
        const badEdge: LoreEdge = { sourceId: 'bad-src', targetId: 'b', relation: 'rel2' };
        adapter.pullResults = [{ nodes: [], edges: [goodEdge, badEdge] }];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);
        const r = await engine.pullRemote();
        assert.equal(r.edgesPulled, 1, 'good edge must apply');
        assert.equal(r.edgesDeadLettered, 1, 'bad edge must be reported as dead-lettered');

        const dlqPath = path.join(dir, '.last-sync.pull-edge-dlq.jsonl');
        assert.ok(fs.existsSync(dlqPath), `DLQ file must be written: ${dlqPath}`);
        const lines = fs.readFileSync(dlqPath, 'utf-8').trim().split('\n').filter(Boolean);
        assert.equal(lines.length, 1, 'exactly one DLQ entry for the bad edge');
        const parsed = JSON.parse(lines[0]);
        assert.equal(parsed.edge.sourceId, 'bad-src', 'DLQ entry must persist the failed edge for replay');
        assert.match(parsed.error, /fk-violation/, 'DLQ entry must persist the underlying error message');
        assert.ok(parsed.ts, 'DLQ entry must include a timestamp for operator triage');
    });

    // ───────────────────────────────────────────────────────────────────
    // (4) Remote pull pagination beyond the 1000-record adapter cap
    // ───────────────────────────────────────────────────────────────────
    await test('(4) pullRemote paginates beyond the 1000-record adapter cap', async () => {
        const dir = tmpLoreDir();
        const graph = makeGraph();

        // Build two "pages": 1000 records each (full), then 5 records
        // (terminal). Each node carries a strictly increasing updatedAt
        // so the pagination cursor can advance deterministically.
        const mkPage = (start: number, count: number): LoreNode[] =>
            Array.from({ length: count }, (_, k) => {
                const i = start + k;
                return {
                    id: `n-${i}`,
                    type: 'fact', label: `L${i}`, content: 'C', tags: '', project: '*', ecosystem: '*',
                    metadata: '{}',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    // Distinct updatedAt per node so since-advances every page.
                    updatedAt: new Date(Date.parse('2026-06-01T00:00:00.000Z') + i * 1000).toISOString(),
                    syncedAt: '',
                } as LoreNode;
            });

        const adapter = makeAdapter();
        adapter.pullResults = [
            { nodes: mkPage(0, 1000), edges: [] },   // full page — must trigger another pull
            { nodes: mkPage(1000, 5), edges: [] },   // short page — terminal
        ];

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);
        const r = await engine.pullRemote();
        assert.equal(r.nodesPulled, 1005,
            `must pull ALL 1005 records across pages (got ${r.nodesPulled} — base drops the 5 overflow)`);
        assert.equal(adapter.pullSinceArgs.length, 2,
            `adapter must be invoked twice (got ${adapter.pullSinceArgs.length})`);
        // The second pull's `since` MUST be > the first's — that's the
        // pagination cursor advancing by the max updatedAt seen.
        assert.ok(
            adapter.pullSinceArgs[1] > adapter.pullSinceArgs[0],
            `pagination must advance the since cursor between pages (got ${adapter.pullSinceArgs[1]} <= ${adapter.pullSinceArgs[0]})`,
        );
        assert.ok((r.pages ?? 0) >= 2, 'PullResult.pages must report the paginated round-trip count');
    });

    await test('(4) pullRemote stops after one page when the result is short (no extra round-trip)', async () => {
        const dir = tmpLoreDir();
        const graph = makeGraph();
        const adapter = makeAdapter();
        adapter.pullResults = [{ nodes: [], edges: [] }];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);
        await engine.pullRemote();
        assert.equal(adapter.pullSinceArgs.length, 1,
            'short page (or empty) must not trigger an extra pull');
    });

    // ───────────────────────────────────────────────────────────────────
    // (5) markSynced skipped for nodes re-appended during the push
    // ───────────────────────────────────────────────────────────────────
    await test('(5) markSynced is NOT called for a node re-appended to WAL during the push', async () => {
        const dir = tmpLoreDir();
        const graph = makeGraph();
        const adapter = makeAdapter();

        // Pre-load the WAL with one node. During the awaited push, the
        // adapter side-effect appends a NEWER write for the SAME node id
        // (e.g. user edits the row while sync is in flight). On base the
        // engine still calls markSynced('n-x') because it only checked
        // result.failures === 0. The fix's WAL re-read sees a new
        // entryId for 'n-x' that is NOT in pushedEntryIds and skips
        // markSynced — next cycle re-pushes the newer version.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const engine = new SyncEngine(graph as any, dir, adapter);
        const wal = engine.getWal();
        wal.append('upsert_node', { id: 'n-x', updatedAt: '2026-06-01T00:00:00.000Z' });
        wal.append('upsert_node', { id: 'n-y', updatedAt: '2026-06-01T00:00:00.000Z' });

        adapter.pushSideEffect = () => {
            // Mid-push: a fresher edit for n-x lands. This adds a NEW
            // WAL entryId for the same node id.
            wal.append('upsert_node', { id: 'n-x', updatedAt: '2026-06-01T00:00:01.000Z' });
        };

        const r = await engine.pushPending();
        assert.equal(r.failures, 0, 'push must succeed');

        // Behavioural assertion: n-x was re-written mid-push, so
        // markSynced('n-x') MUST be skipped. n-y stayed stable so
        // markSynced('n-y') MUST run.
        assert.ok(
            !graph.markSyncedCalls.includes('n-x'),
            `markSynced('n-x') must be SKIPPED because a fresher write landed mid-push — got calls=${JSON.stringify(graph.markSyncedCalls)}`,
        );
        assert.ok(
            graph.markSyncedCalls.includes('n-y'),
            `markSynced('n-y') must still run (no re-append) — got calls=${JSON.stringify(graph.markSyncedCalls)}`,
        );

        // And the re-appended n-x entry must survive in the WAL for the
        // next sync cycle (SW-02 truncatePushed guarantee).
        const remaining = wal.readPending().map(e => ({ op: e.op, id: e.data['id'], ts: e.timestamp }));
        const nxRemaining = remaining.filter(e => e.id === 'n-x');
        assert.equal(nxRemaining.length, 1, 'the mid-push n-x re-append must remain in the WAL');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
