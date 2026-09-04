#!/usr/bin/env tsx
/**
 * r3-sweep-abort-cursor-unit.ts — a sweep that ABORTED must not advance any
 * marker that means "this ground has been covered".
 *
 * Round 2 gave `reconnectGraph` cooperative cancellation (`shouldAbort` +
 * `aborted: true`) so the shutdown drain could stop a multi-minute sweep
 * instead of closing the legacy graph engine/LanceDB underneath it. What it did not do was tell
 * the three CURSOR WRITERS about the new outcome, and every one of them treats
 * "the call returned" as "the sweep finished":
 *
 *   A1 — `http/routes/ingestion.ts` POST /api/graph/reconnect writes
 *        `<ws>/.lore/reconnect.state.json` on `if (apply)`, full stop. An
 *        aborted sweep that scanned page 1 of N and applied NOTHING still
 *        stamped `lastReconnectAt = now`. Because the same route resolves
 *        `since = cursor?.lastReconnectAt`, the next `incremental: true` run
 *        filters to `updatedAt > <abort time>` — so every node the aborted
 *        sweep never reached is skipped by every future incremental run,
 *        forever, silently. That is strictly WORSE than the use-after-close it
 *        replaced: that lost edges recoverably (a later `reconnect` rebuilt
 *        them); this makes the recovery tool itself skip them.
 *
 *   A2 — the same route then returned HTTP 200 and logged `result: 'success'`
 *        for a rebuild that did not happen — the same hollow success the
 *        `result === null` (never-started) branch already refuses to report.
 *        `/api/graph/reconsume` did the same.
 *
 *   A3 — `engines/backgroundReconnect.ts` writes `<loreDir>/reconnect.cursor`,
 *        whose mere EXISTENCE makes every later boot skip the first-install
 *        reconnect. Writing it after an aborted first-install sweep leaves a
 *        graph that was never connected, with the one thing that would connect
 *        it permanently disabled.
 *
 * These tests drive the REAL route and the REAL background entry point and pin
 * all three, plus the positive control (a sweep that completes still writes its
 * cursor and still reports 200/success) so the fix cannot be "never write".
 *
 * License: original work for groundfloor-lore.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { tryIngestionRoutes } from '../packages/lore/src/mcp/http/routes/ingestion.js';
import { PendingAutolinkTracker } from '../packages/lore/src/engines/pendingAutolink.js';
import { readCursor } from '../packages/lore/src/engines/reconnectCursor.js';
import { maybeRunBackgroundReconnect, getBackgroundReconnectStatus } from '../packages/lore/src/engines/backgroundReconnect.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}

const tmpDirs: string[] = [];
function tmpDir(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}

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

type Node = { id: string; type: string; label: string; content: string; tags: string; project: string; ecosystem: string; updatedAt: string };
const node = (id: string): Node => ({
    id, type: 'note', label: `label ${id}`, content: `content for ${id}`, tags: '',
    project: 'ws', ecosystem: '*', updatedAt: '2026-06-01T00:00:00.000Z',
});

/**
 * A corpus paged 1-node-at-a-time so a test can seal the tracker BETWEEN pages
 * and get exactly the real-world shape: N pages requested, 1 delivered, the
 * rest never scanned.
 */
function pagedSubstrates(pages: number, onPage?: (i: number) => void) {
    let served = 0;
    const verbatim = {
        async initialize() { /* no-op */ },
        async getContentHashesByIds() { return new Map<string, string>(); },
        async storeBatch() { /* no-op */ },
        async search() { return []; },
    };
    const graph = {
        pagesServed: () => served,
        async bulkList() {
            const i = served++;
            onPage?.(i);
            const last = served >= pages;
            return {
                nodes: [node(`n${i}`)] as unknown as Array<Record<string, unknown>>,
                hasMore: !last,
                nextCursor: last ? null : { updatedAt: '2026-06-01T00:00:00.000Z', id: `n${i}` },
            };
        },
        async addEdge() { /* no-op */ },
        async pruneInferredLoreEdges() { return 0; },
    };
    return { graph, verbatim };
}

type AuditRow = { toolName: string; result: string; resultDetail?: string };

function ingestionDeps(tracker: PendingAutolinkTracker, graph: unknown, verbatim: unknown, cursorRoot: string, audit: AuditRow[]) {
    return {
        deploymentMode: 'local' as const,
        dataplane: null,
        store: { loreGraph: graph, loreVerbatim: verbatim, autolinkTracker: new PendingAutolinkTracker(), sweepTracker: tracker },
        // apply:true always requests consent; approve it so the sweep runs.
        consentManager: { request: () => ({ id: 'c1', wait: Promise.resolve({ approved: true }) }) },
        auditLog: { log(row: AuditRow) { audit.push(row); } },
        configManager: {} as never,
        graphBasePath: cursorRoot,
    } as unknown as Parameters<typeof tryIngestionRoutes>[4];
}

console.log('\nAn aborted sweep must not advance a "covered" marker\n');

/* ─── A1 + A2: POST /api/graph/reconnect ──────────────────────────────── */

await test('A1: an ABORTED apply-sweep does NOT write the incremental cursor', async () => {
    const cursorRoot = tmpDir('lore-r3-cursor-');
    const tracker = new PendingAutolinkTracker();
    const audit: AuditRow[] = [];
    // Seal the tracker as soon as page 0 is served: the sweep polls
    // shouldAbort() at the top of the next iteration and stops with 4 of 5
    // pages never scanned.
    const { graph, verbatim } = pagedSubstrates(5, (i) => { if (i === 0) tracker.seal(); });
    const res = fakeRes();
    await tryIngestionRoutes(
        makeReqWithBody('POST', JSON.stringify({ workspace: 'ws', apply: true, incremental: true })),
        res, '/api/graph/reconnect', '/api/graph/reconnect',
        ingestionDeps(tracker, graph, verbatim, cursorRoot, audit),
    );
    assert.equal(graph.pagesServed(), 1, 'fixture must abort mid-corpus for this test to mean anything');
    assert.equal(
        readCursor(cursorRoot), null,
        'the aborted sweep advanced lastReconnectAt over 4 pages it never scanned — every future incremental run now skips them',
    );
});

await test('A2: an ABORTED apply-sweep reports 503, not a 200 logged as success', async () => {
    const cursorRoot = tmpDir('lore-r3-cursor-');
    const tracker = new PendingAutolinkTracker();
    const audit: AuditRow[] = [];
    const { graph, verbatim } = pagedSubstrates(5, (i) => { if (i === 0) tracker.seal(); });
    const res = fakeRes();
    await tryIngestionRoutes(
        makeReqWithBody('POST', JSON.stringify({ workspace: 'ws', apply: true, incremental: true })),
        res, '/api/graph/reconnect', '/api/graph/reconnect',
        ingestionDeps(tracker, graph, verbatim, cursorRoot, audit),
    );
    assert.equal(res._status, 503, `expected 503 for an aborted rebuild; got ${res._status}: ${res._body}`);
    assert.match(res._body, /reconnect_aborted/, 'the caller must be able to tell an abort from a completed rebuild');
    const row = audit.find((a) => a.toolName === 'graph.reconnect');
    assert.ok(row, 'the abort must still be audited');
    assert.equal(row!.result, 'error', `an aborted rebuild logged as "${row!.result}" — the audit trail says it happened`);
});

await test('A2: /api/graph/reconsume — the larger sweep — reports an abort too', async () => {
    const cursorRoot = tmpDir('lore-r3-cursor-');
    const tracker = new PendingAutolinkTracker();
    const audit: AuditRow[] = [];
    const { graph, verbatim } = pagedSubstrates(5, (i) => { if (i === 0) tracker.seal(); });
    const res = fakeRes();
    await tryIngestionRoutes(
        makeReqWithBody('POST', JSON.stringify({ workspace: 'ws' })),
        res, '/api/graph/reconsume', '/api/graph/reconsume',
        ingestionDeps(tracker, graph, verbatim, cursorRoot, audit),
    );
    assert.equal(res._status, 503, `expected 503 for an aborted reconsume; got ${res._status}: ${res._body}`);
    const row = audit.find((a) => a.toolName === 'graph.reconsume');
    assert.equal(row?.result, 'error', 'an aborted reconsume must not be logged as a success');
});

await test('POSITIVE CONTROL: a sweep that COMPLETES still writes the cursor and reports 200', async () => {
    // The fix must be "do not advance over unscanned ground", not "stop
    // writing the cursor".
    const cursorRoot = tmpDir('lore-r3-cursor-');
    const tracker = new PendingAutolinkTracker();
    const audit: AuditRow[] = [];
    const { graph, verbatim } = pagedSubstrates(3);
    const res = fakeRes();
    await tryIngestionRoutes(
        makeReqWithBody('POST', JSON.stringify({ workspace: 'ws', apply: true, incremental: false })),
        res, '/api/graph/reconnect', '/api/graph/reconnect',
        ingestionDeps(tracker, graph, verbatim, cursorRoot, audit),
    );
    assert.equal(res._status, 200, `a completed rebuild must still succeed; got ${res._status}: ${res._body}`);
    assert.equal(graph.pagesServed(), 3, 'the whole corpus must have been scanned');
    const cursor = readCursor(cursorRoot);
    assert.ok(cursor, 'a completed apply-sweep must still persist its cursor');
    assert.equal(cursor!.lastReconnectMode, 'full');
    assert.equal(audit.find((a) => a.toolName === 'graph.reconnect')?.result, 'success');
});

/* ─── A3: first-install background reconnect ──────────────────────────── */

await test('A3: an ABORTED first-install sweep does NOT write reconnect.cursor', async () => {
    // The cursor's mere existence makes every later boot skip the trigger, so
    // writing it after an aborted sweep disables the only thing that would
    // ever connect the graph.
    const loreDir = tmpDir('lore-r3-bg-');
    const tracker = new PendingAutolinkTracker();
    const { graph, verbatim } = pagedSubstrates(5, (i) => { if (i === 0) tracker.seal(); });
    await maybeRunBackgroundReconnect({
        loreDir, graph: graph as never, verbatim: verbatim as never, tracker,
    });
    // The tracked run is fire-and-forget; drain it the way shutdown does.
    await tracker.drain(5000);
    assert.equal(graph.pagesServed(), 1, 'fixture must abort mid-corpus');
    assert.equal(
        fs.existsSync(path.join(loreDir, 'reconnect.cursor')), false,
        'the aborted first-install sweep marked itself done — no later boot will ever retry it',
    );
    assert.equal(getBackgroundReconnectStatus().state, 'error', 'an aborted first-install run is not a success');
});

await test('A3: the first-install sweep is registered on the CALLING INSTANCE\'s tracker', async () => {
    // pendingAutolink.ts property 1: a module-level `let` means instance B's
    // dispose() awaits instance A's sweep. Passing the bundle's sweepTracker
    // is what makes the registration per-instance — and it is also what gives
    // the sweep a `shouldAbort` at all.
    const loreDir = tmpDir('lore-r3-bg-');
    const tracker = new PendingAutolinkTracker();
    let sawInFlight = 0;
    const { graph, verbatim } = pagedSubstrates(3, () => { sawInFlight = Math.max(sawInFlight, tracker.count()); });
    await maybeRunBackgroundReconnect({
        loreDir, graph: graph as never, verbatim: verbatim as never, tracker,
    });
    await tracker.drain(5000);
    assert.equal(sawInFlight, 1, 'the drain cannot bound a sweep it was never told about');
    assert.ok(fs.existsSync(path.join(loreDir, 'reconnect.cursor')), 'a completed first-install sweep still writes its cursor');
});

await test('A3: a SEALED tracker stops the first-install sweep starting at all', async () => {
    const loreDir = tmpDir('lore-r3-bg-');
    const tracker = new PendingAutolinkTracker();
    tracker.seal();
    const { graph, verbatim } = pagedSubstrates(3);
    await maybeRunBackgroundReconnect({
        loreDir, graph: graph as never, verbatim: verbatim as never, tracker,
    });
    assert.equal(graph.pagesServed(), 0, 'no multi-minute sweep may begin against handles about to close');
    assert.equal(fs.existsSync(path.join(loreDir, 'reconnect.cursor')), false);
});

for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
