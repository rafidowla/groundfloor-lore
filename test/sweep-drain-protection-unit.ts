#!/usr/bin/env tsx
/**
 * sweep-drain-protection-unit.ts — a long graph sweep must be drain-PROTECTED,
 * not merely drain-VISIBLE.
 *
 * `reconnect-shutdown-tracking-unit.ts` pins the previous half of this: the
 * operator-initiated `/api/graph/reconnect` + `/api/graph/reconsume` sweeps are
 * REGISTERED with the ordered shutdown drain, and refuse to start once it has
 * sealed. That closed the "the drain doesn't know about this writer" hole and
 * left the one behind it open:
 *
 *   S1 — the sweeps were registered on the INGEST-autolink tracker, whose
 *        drain deadline is 5s (`DEFAULT_AUTOLINK_DRAIN_TIMEOUT_MS`, and neither
 *        `buildShutdownDrain` call site in server.ts overrides it).
 *        `reconnectGraph` re-embeds and searches the whole corpus and runs for
 *        MINUTES. So on any real sweep the drain timed out after 5s and step 10
 *        closed Kùzu + LanceDB underneath the still-running sweep — exactly the
 *        use-after-close the registration was added to prevent. Registration
 *        without a survivable deadline is not protection.
 *
 *   S2 — the timeout message read "N ingest autolink hook(s) abandoned; their
 *        semantic_neighbor edges may be missing", which is the wrong subject
 *        for an operator who just called /api/graph/reconnect.
 *
 *   S3 — conflating the two workloads on one queue also made EVERY shutdown
 *        that overlapped a sweep stall for the full ingest budget.
 *
 * Fix: a separate `StorageBundle.sweepTracker` with its own (larger, still
 * bounded) deadline, AND cooperative cancellation — `reconnectGraph` polls
 * `opts.shouldAbort` at every page boundary and search chunk, so sealing the
 * tracker makes a multi-minute rebuild unwind fast enough for the drain to
 * actually wait for it. Both halves are needed: a bigger deadline alone just
 * moves the stall, and an abort hook alone still shares a queue whose message
 * and budget belong to a different workload.
 *
 * License: original work for groundfloor-lore.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { reconnectGraph } from '../packages/lore/src/engines/reconnect.js';
import { buildShutdownDrain } from '../packages/lore/src/mcp/shutdownDrain.js';
import { tryIngestionRoutes } from '../packages/lore/src/mcp/http/routes/ingestion.js';
import { PendingAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

console.log('\nLong graph sweeps must be drain-PROTECTED\n');

/* ─── S-abort: reconnectGraph honours cooperative cancellation ─────────── */

/** A corpus of `pages` pages, so the sweep has real page boundaries to stop
 *  at. Records every page fetched + every edge applied. */
function pagedSubstrates(pages: number) {
    const seen = { pagesFetched: 0, edgesApplied: 0, pruned: 0 };
    let page = 0;
    const graph = {
        async bulkList() {
            seen.pagesFetched++;
            page++;
            const nodes = [{
                id: `n${page}`, type: 'fact', label: `label ${page}`, content: `content ${page}`,
                tags: [], project: 'ws', ecosystem: '*',
                updatedAt: '2026-08-01T00:00:00.000Z', security_scopes: [],
            }];
            return page >= pages
                ? { nodes, hasMore: false, nextCursor: null }
                : { nodes, hasMore: true, nextCursor: { updatedAt: '2026-08-01T00:00:00.000Z', id: `n${page}` } };
        },
        async addEdge() { seen.edgesApplied++; },
        async pruneInferredLoreEdges() { seen.pruned++; return 0; },
    };
    const verbatim = {
        async initialize() { /* no-op */ },
        async getContentHashesByIds() { return new Map<string, string>(); },
        async storeBatch() { /* no-op */ },
        // A neighbour on every page, so a completed sweep WOULD apply edges.
        async search() { return [{ id: 'lore:other', score: 0.99, metadata: { ecosystem: '*' } }]; },
    };
    return { seen, graph, verbatim };
}

await test('S-abort: a sweep with no abort signal runs to completion (control)', async () => {
    const { seen, graph, verbatim } = pagedSubstrates(4);
    const res = await reconnectGraph(graph as never, verbatim as never, { dryRun: false, force: true, pruneInferred: false });
    assert.equal(seen.pagesFetched, 4, 'every page walked');
    assert.equal(res.applied, true);
    assert.ok(res.aborted !== true, 'a normal sweep is not marked aborted');
    assert.ok(seen.edgesApplied > 0, 'and it actually writes edges');
});

await test('S-abort: sealing mid-sweep stops it at the NEXT page boundary', async () => {
    // This is what makes a bounded drain survivable. Without it the sweep runs
    // to completion — minutes — and the drain can only time out and close the
    // substrates underneath it.
    const { seen, graph, verbatim } = pagedSubstrates(50);
    let sealed = false;
    const res = await reconnectGraph(graph as never, verbatim as never, {
        dryRun: false, force: true, pruneInferred: false,
        shouldAbort: () => sealed,
    });
    // (sealed stays false above; the next case seals for real — this call is
    // the baseline the assertion below compares against.)
    assert.equal(seen.pagesFetched, 50, 'baseline: unsealed, the whole corpus is walked');

    const second = pagedSubstrates(50);
    sealed = false;
    let fetched = 0;
    const gatedGraph = {
        ...second.graph,
        async bulkList() {
            fetched++;
            if (fetched === 3) sealed = true;  // "shutdown begins" mid-sweep
            return second.graph.bulkList();
        },
    };
    const aborted = await reconnectGraph(gatedGraph as never, second.verbatim as never, {
        dryRun: false, force: true, pruneInferred: false,
        shouldAbort: () => sealed,
    });
    assert.ok(
        second.seen.pagesFetched <= 4,
        `sweep ignored the abort signal and kept walking: ${second.seen.pagesFetched} pages`,
    );
    assert.equal(aborted.aborted, true, 'the caller is told the sweep stopped early');
    assert.equal(res.applied, true, 'sanity: the baseline DID apply');
});

await test('S-abort: an aborted sweep applies NOTHING — no prune, no insert', async () => {
    // Partial apply against handles that are about to close is how edges get
    // lost. Stopping must mean stopping, not "prune then die".
    const { seen, graph, verbatim } = pagedSubstrates(20);
    let sealed = false;
    let fetched = 0;
    const gated = {
        ...graph,
        async bulkList() { fetched++; if (fetched === 2) sealed = true; return graph.bulkList(); },
    };
    const res = await reconnectGraph(gated as never, verbatim as never, {
        dryRun: false, force: true, pruneInferred: true,
        shouldAbort: () => sealed,
    });
    assert.equal(res.aborted, true);
    assert.equal(res.applied, false, 'an aborted sweep must not claim it applied');
    assert.equal(seen.pruned, 0, 'the inferred-edge prune must not run');
    assert.equal(seen.edgesApplied, 0, 'no edges may be written into closing handles');
});

/* ─── S-route: the routes use the SWEEP tracker, not the ingest one ────── */

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

/** Sweep substrates that park inside bulkList until released. */
function parkedSubstrates() {
    const state = { started: false, release: () => { /* replaced */ } };
    const gate = new Promise<void>((resolve) => { state.release = resolve; });
    return {
        state,
        verbatim: {
            async initialize() { /* no-op */ },
            async getContentHashesByIds() { return new Map<string, string>(); },
            async storeBatch() { /* no-op */ },
            async search() { return []; },
        },
        graph: {
            async bulkList() {
                state.started = true;
                await gate;
                return { nodes: [], hasMore: false, nextCursor: null };
            },
            async addEdge() { /* no-op */ },
            async pruneInferredLoreEdges() { return 0; },
        },
    };
}

function ingestionDeps(store: Record<string, unknown>) {
    return {
        deploymentMode: 'local' as const,
        dataplane: null,
        store,
        consentManager: { request() { throw new Error('consent must not be reached on a dry run'); } },
        auditLog: { log() { /* no-op */ } },
        configManager: {} as never,
        graphBasePath: fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sweep-')),
    } as unknown as Parameters<typeof tryIngestionRoutes>[4];
}

await test('S-route: /api/graph/reconnect registers on the SWEEP tracker, never the ingest one', async () => {
    // Same queue = same 5s deadline + a timeout message about "ingest autolink
    // hooks". Two workloads, two trackers.
    const sweepTracker = new PendingAutolinkTracker();
    const autolinkTracker = new PendingAutolinkTracker();
    const { state, graph, verbatim } = parkedSubstrates();
    const res = fakeRes();
    const inFlight = tryIngestionRoutes(
        makeReqWithBody('POST', JSON.stringify({ workspace: 'ws', apply: false })),
        res, '/api/graph/reconnect', '/api/graph/reconnect',
        ingestionDeps({ loreGraph: graph, loreVerbatim: verbatim, autolinkTracker, sweepTracker }),
    );
    try {
        while (!state.started) await new Promise((r) => setTimeout(r, 5));
        assert.equal(sweepTracker.count(), 1, 'the sweep must be on the sweep tracker');
        assert.equal(autolinkTracker.count(), 0, 'a multi-minute sweep must NOT sit in the 5s ingest queue');
    } finally {
        state.release();
        await inFlight;
    }
    assert.equal(res._status, 200, `dry run should succeed; got ${res._status}: ${res._body}`);
});

/* ─── S-drain: the ordered drain waits for the sweep before closing ────── */

/** Minimal ShutdownDrainDeps with every stop() a no-op, recording the order
 *  substrate close happens in relative to the sweep finishing. */
function drainDeps(store: Record<string, unknown>, order: string[], extra: Record<string, unknown> = {}) {
    const noop = { async stop() { /* no-op */ } };
    return {
        graph: { async close() { order.push('graph.close'); } },
        store,
        verbatimStore: null,
        syncPoller: noop,
        outboxReplicator: noop,
        embedQueue: { async drained() { /* no-op */ }, stop() { /* no-op */ } },
        consistencySweeper: noop,
        getLoadJobsRunner: () => null,
        authTokenSweeper: { stop() { /* no-op */ } },
        stopAllLocalWatchers: () => { /* no-op */ },
        ...extra,
    } as unknown as Parameters<typeof buildShutdownDrain>[0];
}

await test('S-drain: a sweep that stops on the seal finishes BEFORE the graph closes', async () => {
    // The whole point. Pre-fix the sweep sat in the 5s ingest queue with no way
    // to stop, so the drain gave up and step 10 closed Kùzu + LanceDB
    // underneath it.
    const order: string[] = [];
    const sweepTracker = new PendingAutolinkTracker();
    const autolinkTracker = new PendingAutolinkTracker();
    // Stands in for reconnectGraph's page loop: runs "forever" until sealed.
    sweepTracker.runTracked(async () => {
        while (!sweepTracker.isSealed()) await tick();
        order.push('sweep.finished');
    });
    const drain = buildShutdownDrain(drainDeps({ autolinkTracker, sweepTracker }, order));
    await drain('test');
    assert.deepEqual(
        order, ['sweep.finished', 'graph.close'],
        'the substrate handles must not close while an operator sweep is still writing to them',
    );
});

await test('S-drain: the sweep budget is its OWN, not the ingest queue\'s', async () => {
    // A sweep that refuses to stop must be bounded by the SWEEP deadline. If it
    // were still drained on the ingest tracker, `sweepDrainTimeoutMs` would
    // have no effect at all and this would hang for the ingest budget instead.
    const order: string[] = [];
    const sweepTracker = new PendingAutolinkTracker();
    const autolinkTracker = new PendingAutolinkTracker();
    let stop = false;
    sweepTracker.runTracked(async () => {
        while (!stop) await new Promise((r) => setTimeout(r, 5));
        order.push('sweep.finished');
    });
    const started = Date.now();
    const drain = buildShutdownDrain(drainDeps({ autolinkTracker, sweepTracker }, order, {
        autolinkDrainTimeoutMs: 5000,   // the ingest budget must NOT be spent here
        sweepDrainTimeoutMs: 80,
    }));
    await drain('test');
    const elapsed = Date.now() - started;
    stop = true;
    assert.ok(elapsed < 1500, `drain waited ${elapsed}ms — the sweep is being drained on the wrong budget`);
    assert.deepEqual(order, ['graph.close'], 'a sweep that never stops is abandoned, not waited on forever');
});

await test('S-drain: an unwired sweepTracker leaves the step a no-op (test/embedded wiring)', async () => {
    const order: string[] = [];
    const autolinkTracker = new PendingAutolinkTracker();
    const drain = buildShutdownDrain(drainDeps({ autolinkTracker }, order));
    await drain('test');
    assert.deepEqual(order, ['graph.close'], 'no sweepTracker ⇒ nothing to drain, and no crash');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
