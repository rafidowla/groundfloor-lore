#!/usr/bin/env tsx
/**
 * reconnect-shutdown-tracking-unit.ts — every reconnect path must be visible
 * to the ordered shutdown drain.
 *
 * `reconnectOneNode` / `reconnectGraph` write to BOTH substrates. shutdownDrain
 * closes those substrates at step 10, after waiting on the things it knows
 * about: the embed queue (step 5), `backgroundReconnect`'s own handle (step 8),
 * and the `PendingAutolinkTracker` (step 8.5). A reconnect that is on none of
 * those lists races `graph.close()` and dies inside reconnect's own swallowing
 * catch — edges silently missing, caller told everything succeeded.
 *
 * Two such paths were left uncovered after the tracker landed:
 *
 *   R1 — `engines/v1Migration.ts` fires `reconnectOneNode` per imported node
 *        untracked and unsealed. It happened to be safe because a
 *        `Promise.allSettled` further down the SAME function awaits the local
 *        array — a coincidence of control flow, not an enforced invariant. An
 *        early return, a throw in the edge-import loop, or someone relocating
 *        that await restores the race with nothing to catch it. Registering
 *        each hook makes the drain the second, independent guarantee.
 *
 *   R2 — the HTTP `/api/graph/reconnect` + `/api/graph/reconsume` endpoints
 *        `await reconnectGraph(...)` inside a REQUEST. Being awaited binds them
 *        to the request, not to the drain — and `server.close()` lets in-flight
 *        requests finish while the drain proceeds past them to close Kùzu and
 *        LanceDB underneath. reconsume is the worst case: it re-embeds every
 *        node, so it is the longest-running writer in the process. They are now
 *        started through `tracker.runTracked`, which both registers the sweep
 *        (the drain waits) and refuses to START one once sealed (a fresh
 *        minutes-long rebuild during shutdown can only write into closing
 *        handles) — reported as 503 rather than a hollow success.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';

import { migrateV1Sqlite } from '../packages/lore/src/engines/v1Migration.js';
import { tryIngestionRoutes } from '../packages/lore/src/mcp/http/routes/ingestion.js';
import { PendingAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
}

/** Tracker that counts registrations, so a test can see work the migration
 *  awaits and discards within one call. */
function countingTracker(): { tracker: PendingAutolinkTracker; tracked: () => number } {
    const tracker = new PendingAutolinkTracker();
    let n = 0;
    const original = tracker.track.bind(tracker);
    tracker.track = (p: Promise<unknown>): void => { n++; original(p); };
    return { tracker, tracked: () => n };
}

/* ─── R1: v1 migration ────────────────────────────────────────────────── */

/** Duck-typed graph — v1Migration only needs these five methods. */
function fakeMigrationGraph() {
    const upserted: string[] = [];
    return {
        upserted,
        async initialize() { /* no-op */ },
        async listNodes() { return []; },
        async upsertNode(n: Record<string, unknown>) { upserted.push(String(n.id)); return n; },
        async queryEdges() { return [] as unknown[]; },
        async addEdge() { /* no-op */ },
    };
}

/** Verbatim fake whose search() marks that a reconnect hook actually ran. */
function fakeMigrationVerbatim() {
    return {
        searchCalls: 0,
        async initialize() { /* no-op */ },
        async store() { /* no-op */ },
        async search() { this.searchCalls++; return []; },
    };
}

function seedV1Sqlite(sqlitePath: string, ids: string[]): void {
    const db = new Database(sqlitePath);
    db.exec(`
        CREATE TABLE nodes (
            id TEXT PRIMARY KEY, type TEXT, label TEXT, content TEXT,
            metadata TEXT, tags TEXT, created_at TEXT, updated_at TEXT,
            project TEXT, ecosystem TEXT
        );
        CREATE TABLE edges (
            source_id TEXT, target_id TEXT, relation TEXT, weight REAL, metadata TEXT
        );
    `);
    const ins = db.prepare(
        `INSERT INTO nodes (id, type, label, content, metadata, tags, created_at, updated_at, project, ecosystem)
         VALUES (?, 'decision', ?, ?, '{}', '', '2024-01-01', '2024-01-01', 'dev', '*')`,
    );
    for (const id of ids) ins.run(id, `label ${id}`, `content for ${id}`);
    db.close();
}

const IDS = ['n1', 'n2', 'n3'];
function withV1Db<T>(fn: (sqlitePath: string) => Promise<T>): Promise<T> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-recon-'));
    const sqlitePath = path.join(tmp, 'knowledge.db');
    seedV1Sqlite(sqlitePath, IDS);
    return fn(sqlitePath).finally(() => fs.rmSync(tmp, { recursive: true, force: true }));
}

console.log('\nReconnect paths must be drain-visible\n');

await test('R1: the v1 migration REGISTERS every ingest hook on the supplied tracker', async () => {
    // Not "does the migration await them" (v1-migration-reconnect-await-unit.ts
    // already pins that) — does the DRAIN know about them, so the guarantee
    // survives an edit to this function's control flow.
    const { tracker, tracked } = countingTracker();
    const graph = fakeMigrationGraph();
    const verbatim = fakeMigrationVerbatim();
    await withV1Db((sqlitePath) => migrateV1Sqlite(graph as never, {
        sqlitePath, apply: true, verbatimStore: verbatim as never, autolinkTracker: tracker,
    }));
    assert.equal(graph.upserted.length, IDS.length, 'all V1 nodes imported');
    assert.equal(
        tracked(), IDS.length,
        `every reconnect hook must be registered with the drain; saw ${tracked()} of ${IDS.length}`,
    );
});

await test('R1: a SEALED tracker stops the migration starting new reconnect hooks', async () => {
    // Same contract nodeUpsert honours: once shutdown has begun, the node's own
    // writes still land but the best-effort edge inference is skipped rather
    // than started against handles about to close.
    const tracker = new PendingAutolinkTracker();
    tracker.seal();
    const graph = fakeMigrationGraph();
    const verbatim = fakeMigrationVerbatim();
    await withV1Db((sqlitePath) => migrateV1Sqlite(graph as never, {
        sqlitePath, apply: true, verbatimStore: verbatim as never, autolinkTracker: tracker,
    }));
    assert.equal(graph.upserted.length, IDS.length, 'the IMPORT itself must not be skipped');
    assert.equal(verbatim.searchCalls, 0, 'no reconnect hook may start once the drain has sealed');
});

/* ─── R2: the HTTP reconnect/reconsume endpoints ──────────────────────── */

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

/** Graph/verbatim pair for reconnectGraph. `sweepStarted` flips as soon as the
 *  sweep touches a substrate, which is what a seal must prevent. */
function sweepSubstrates() {
    const state = { sweepStarted: false, release: () => { /* set below */ } };
    const gate = new Promise<void>((resolve) => { state.release = resolve; });
    const verbatim = {
        async initialize() { /* no-op */ },
        async getContentHashesByIds() { return new Map<string, string>(); },
        async storeBatch() { /* no-op */ },
        async search() { return []; },
    };
    const graph = {
        async bulkList() {
            state.sweepStarted = true;
            await gate;                       // hold the sweep "in flight"
            return { nodes: [], hasMore: false, nextCursor: null };
        },
        async addEdge() { /* no-op */ },
        async pruneInferredLoreEdges() { return 0; },
    };
    return { state, graph, verbatim };
}

/**
 * `tracker` here is the SWEEP tracker — the operator-sweep registry the two
 * reconnect routes use. It is deliberately NOT `autolinkTracker`: registering a
 * multi-minute rebuild on the 5s ingest-autolink queue made it drain-VISIBLE
 * but not drain-PROTECTED (see StorageBundle.sweepTracker). The ingest tracker
 * is wired separately below so a test can prove the routes do not touch it.
 */
function ingestionDeps(
    tracker: PendingAutolinkTracker,
    graph: unknown,
    verbatim: unknown,
    ingestTracker: PendingAutolinkTracker = new PendingAutolinkTracker(),
) {
    return {
        deploymentMode: 'local' as const,
        dataplane: null,
        store: { loreGraph: graph, loreVerbatim: verbatim, autolinkTracker: ingestTracker, sweepTracker: tracker },
        consentManager: { request() { throw new Error('consent must not be reached on a dry run'); } },
        auditLog: { log() { /* no-op */ } },
        configManager: {} as never,
        graphBasePath: fs.mkdtempSync(path.join(os.tmpdir(), 'lore-recon-cur-')),
    } as unknown as Parameters<typeof tryIngestionRoutes>[4];
}

await test('R2: an in-flight /api/graph/reconnect sweep is REGISTERED with the drain', async () => {
    const tracker = new PendingAutolinkTracker();
    const { state, graph, verbatim } = sweepSubstrates();
    const res = fakeRes();
    const inFlight = tryIngestionRoutes(
        makeReqWithBody('POST', JSON.stringify({ workspace: 'ws', apply: false })),
        res, '/api/graph/reconnect', '/api/graph/reconnect',
        ingestionDeps(tracker, graph, verbatim),
    );
    try {
        // Let the request reach the sweep and park inside it.
        while (!state.sweepStarted) await new Promise((r) => setTimeout(r, 5));
        assert.equal(
            tracker.count(), 1,
            'the drain cannot wait for a sweep it was never told about — graph.close() would run underneath it',
        );
    } finally {
        // Always unpark, or a failed assertion leaves the request (and the
        // process) hanging instead of reporting the failure.
        state.release();
        await inFlight;
    }
    assert.equal(res._status, 200, `dry run should succeed; got ${res._status}: ${res._body}`);
});

await test('R2: /api/graph/reconnect refuses to START a sweep once the drain has sealed', async () => {
    const tracker = new PendingAutolinkTracker();
    tracker.seal();
    const { state, graph, verbatim } = sweepSubstrates();
    const res = fakeRes();
    await tryIngestionRoutes(
        makeReqWithBody('POST', JSON.stringify({ workspace: 'ws', apply: false })),
        res, '/api/graph/reconnect', '/api/graph/reconnect',
        ingestionDeps(tracker, graph, verbatim),
    );
    assert.equal(state.sweepStarted, false, 'no substrate work may begin after the seal');
    assert.equal(res._status, 503, `expected 503 shutting_down; got ${res._status}: ${res._body}`);
    assert.match(res._body, /shutting_down/, 'the caller must be told the rebuild did NOT run');
});

await test('R2: /api/graph/reconsume — the larger sweep — is sealed off too', async () => {
    // reconsume re-embeds every node, so an untracked one racing graph.close()
    // is strictly worse than reconnect's. It always applies, so consent is
    // requested first; approve it, then the seal must still stop the sweep.
    const tracker = new PendingAutolinkTracker();
    tracker.seal();
    const { state, graph, verbatim } = sweepSubstrates();
    const deps = ingestionDeps(tracker, graph, verbatim) as unknown as {
        consentManager: { request: () => { id: string; wait: Promise<{ approved: boolean }> } };
    };
    deps.consentManager = { request: () => ({ id: 'c1', wait: Promise.resolve({ approved: true }) }) };
    const res = fakeRes();
    await tryIngestionRoutes(
        makeReqWithBody('POST', JSON.stringify({ workspace: 'ws' })),
        res, '/api/graph/reconsume', '/api/graph/reconsume',
        deps as unknown as Parameters<typeof tryIngestionRoutes>[4],
    );
    assert.equal(state.sweepStarted, false, 'no re-embed sweep may begin after the seal');
    assert.equal(res._status, 503, `expected 503 shutting_down; got ${res._status}: ${res._body}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
