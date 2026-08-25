#!/usr/bin/env tsx
/**
 * test/S-streaming-unit.ts — Sprint S unit tests.
 *
 * Drives tryStreamRoutes directly with a stub OutboxStore + a real
 * StreamRegistry + a stubbed chunked-transfer IncomingMessage so the
 * per-endpoint contract (workspace_required, backpressure, concurrency,
 * per-event ack, drop-mid-stream cleanup) is pinned without a live
 * daemon.
 *
 * Pins from Sprint S spec:
 *   - POST /api/stream/connect?workspace=X → 200 chunked + ack frames
 *   - Each event → outbox commit via LocalStreamConsumer
 *   - workspace_required preserved (Sprint L sentinel)
 *   - Concurrency cap enforced (3 concurrent + 4th 429)
 *   - Backpressure 503 outbox_lag
 *   - Cloud-pluggable StreamConsumerAdapter interface exists
 *   - Malformed JSON event → per-event ack with ok:false, stream stays open
 *   - Connection drop mid-stream → outbox state consistent, registry slot released
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { tryStreamRoutes } from '../packages/lore/src/mcp/http/routes/stream.js';
import { StreamRegistry, DEFAULT_MAX_CONCURRENT_PER_WORKSPACE } from '../packages/lore/src/streaming/streamRegistry.js';
import { ConcurrencyLimiter } from '../packages/lore/src/streaming/concurrencyLimiter.js';
import {
    LocalStreamConsumer,
    createDefaultStreamConsumer,
    type StreamConsumerAdapter,
    type StreamEvent,
    type StreamEventAck,
} from '../packages/lore/src/streaming/streamConsumer.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
const test = (name: string, fn: () => Promise<void> | void) => {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) {
            console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
            const stack = (e as Error).stack?.split('\n').slice(1, 5).join('\n    ');
            if (stack) console.error(`    ${stack}`);
            failed++;
        }
    })());
};

console.log('Sprint S — streaming-ingest unit tests');

// ─── Test doubles ────────────────────────────────────────────────────

function makeStubOutbox(): { records: OutboxEntry[]; store: OutboxStore } {
    const records: OutboxEntry[] = [];
    const store: OutboxStore = {
        async record(e: OutboxEntry) { records.push(e); },
        async markStep() { /* noop */ },
        async markCompleted() { /* noop */ },
        async remove() { /* noop */ },
        async listUnfinished() { return []; },
    };
    return { records, store };
}

interface FakeReq {
    method: 'POST' | 'GET';
    /** Chunks to flush on next tick. */
    chunks?: Buffer[];
    /** When true, simulate the client dropping (fires 'close' after data
     *  flush, no 'end'). */
    drop?: boolean;
}

function makeReq(opts: FakeReq): IncomingMessage & { _flushAfter(ms: number): Promise<void> } {
    const chunks = opts.chunks ?? [];
    const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    const req = {
        method: opts.method,
        on(event: string, cb: (arg?: unknown) => void) {
            (handlers[event] ??= []).push(cb);
            return this;
        },
        async _flushAfter(ms: number) {
            await new Promise((r) => setTimeout(r, ms));
            for (const c of chunks) {
                for (const cb of handlers['data'] ?? []) cb(c);
            }
            if (opts.drop) {
                for (const cb of handlers['close'] ?? []) cb();
            } else {
                for (const cb of handlers['end'] ?? []) cb();
            }
        },
    } as unknown as IncomingMessage & { _flushAfter(ms: number): Promise<void> };
    return req;
}

interface FakeRes extends ServerResponse {
    _status: number;
    _headers: Record<string, string>;
    _frames: string[];
    _body: string;
    _ended: boolean;
}

function fakeRes(): FakeRes {
    const r = {
        _status: 0,
        _headers: {} as Record<string, string>,
        _frames: [] as string[],
        _body: '',
        _ended: false,
        statusCode: 0,
        setHeader(name: string, value: string) {
            (this as { _headers: Record<string, string> })._headers[name] = value;
        },
        writeHead(s: number, headers?: Record<string, string>) {
            (this as { _status: number; statusCode: number })._status = s;
            (this as { statusCode: number }).statusCode = s;
            if (headers) Object.assign((this as { _headers: Record<string, string> })._headers, headers);
            return this;
        },
        write(chunk: string) {
            (this as { _frames: string[] })._frames.push(chunk);
            return true;
        },
        end(b?: string) {
            if (b) (this as { _body: string })._body = b;
            (this as { _ended: boolean })._ended = true;
        },
    };
    return r as unknown as FakeRes;
}

interface LagCacheStub {
    shouldBackpressure: (ws: string) => {
        shouldBlock: boolean; currentLagSeconds: number; thresholdSeconds: number;
        outboxDepth: number; cacheMiss: boolean;
    };
}
function makeLagCache(block: boolean): LagCacheStub {
    return {
        shouldBackpressure: () => ({
            shouldBlock: block,
            currentLagSeconds: block ? 999 : 0,
            thresholdSeconds: 60,
            outboxDepth: block ? 5000 : 0,
            cacheMiss: false,
        }),
    };
}

// ─── ConcurrencyLimiter ──────────────────────────────────────────────

test('ConcurrencyLimiter rejects invalid cap', () => {
    assert.throws(() => new ConcurrencyLimiter(0));
    assert.throws(() => new ConcurrencyLimiter(-1));
    assert.throws(() => new ConcurrencyLimiter(NaN));
});

test('ConcurrencyLimiter tryAcquire honours cap; release decrements', () => {
    const limit = new ConcurrencyLimiter(2);
    assert.equal(limit.tryAcquire('w1'), true);
    assert.equal(limit.tryAcquire('w1'), true);
    assert.equal(limit.tryAcquire('w1'), false);
    assert.equal(limit.getCount('w1'), 2);
    limit.release('w1');
    assert.equal(limit.getCount('w1'), 1);
    assert.equal(limit.tryAcquire('w1'), true);
});

test('ConcurrencyLimiter release never goes negative', () => {
    const limit = new ConcurrencyLimiter(3);
    limit.release('ghost');
    assert.equal(limit.getCount('ghost'), 0);
});

// ─── StreamRegistry ──────────────────────────────────────────────────

test('StreamRegistry default cap = 3 (matches Sprint Z3 symmetry)', () => {
    const r = new StreamRegistry();
    assert.equal(r.getCap(), DEFAULT_MAX_CONCURRENT_PER_WORKSPACE);
    assert.equal(DEFAULT_MAX_CONCURRENT_PER_WORKSPACE, 3);
});

test('StreamRegistry open/release across workspaces is isolated', () => {
    const r = new StreamRegistry(2);
    const a1 = r.open('a'); assert.ok(a1.ok);
    const a2 = r.open('a'); assert.ok(a2.ok);
    const a3 = r.open('a'); assert.equal(a3.ok, false);
    const b1 = r.open('b'); assert.ok(b1.ok); // 'b' unaffected
    if (a1.ok) r.release(a1.session.sessionId);
    const a4 = r.open('a'); assert.ok(a4.ok);
});

// ─── StreamConsumerAdapter interface assertions ──────────────────────

test('S-D3 StreamConsumerAdapter cloud-pluggable interface present', () => {
    // The interface is structural — assert by constructing a fake
    // adapter and checking it satisfies the surface. If any of
    // start/onEvent/stop disappear from the interface this test
    // breaks at compile time before it ever runs.
    const fake: StreamConsumerAdapter = {
        name: 'kafka-fake',
        async start() { /* would open a broker subscription */ },
        async stop() { /* would close the subscription */ },
        async onEvent(_e: StreamEvent): Promise<StreamEventAck> {
            return { id: _e.id, ok: true };
        },
        async commit() { /* would commit offsets to Kafka */ },
    };
    assert.equal(fake.name, 'kafka-fake');
    assert.equal(typeof fake.start, 'function');
    assert.equal(typeof fake.onEvent, 'function');
    assert.equal(typeof fake.stop, 'function');
    assert.equal(typeof fake.commit, 'function');
});

test('LocalStreamConsumer commits each event to outbox', async () => {
    const { store, records } = makeStubOutbox();
    const c = new LocalStreamConsumer({ outboxStore: store });
    await c.start();
    const ack = await c.onEvent({
        id: 'evt-1',
        workspace: 'default',
        operationKind: 'stream.event',
        payload: { foo: 'bar' },
        receivedAt: new Date().toISOString(),
    });
    assert.equal(ack.ok, true);
    assert.equal(ack.id, 'evt-1');
    assert.ok(ack.outboxId, 'outboxId returned on success');
    assert.equal(records.length, 1);
    assert.equal(records[0].workspace, 'default');
    assert.equal(records[0].operationKind, 'stream.event');
    await c.stop();
});

test('LocalStreamConsumer rejects when not started', async () => {
    const { store } = makeStubOutbox();
    const c = new LocalStreamConsumer({ outboxStore: store });
    const ack = await c.onEvent({
        id: 'evt-x', workspace: 'default', operationKind: 'stream.event',
        payload: {}, receivedAt: new Date().toISOString(),
    });
    assert.equal(ack.ok, false);
    assert.equal(ack.error, 'closed');
});

test('createDefaultStreamConsumer returns a LocalStreamConsumer', () => {
    const { store } = makeStubOutbox();
    const c = createDefaultStreamConsumer({ outboxStore: store });
    assert.ok(c instanceof LocalStreamConsumer);
});

// ─── HTTP route tests ────────────────────────────────────────────────
// Launch gate (2026-08-19): streaming ingest is cloud-only — tryStreamRoutes
// 501s at dispatch unless deploymentMode === 'cloud'. The handler-contract
// tests below therefore pass deploymentMode:'cloud' so they keep pinning the
// handler behaviour on the one mode where the route is reachable; the
// local-mode 501 refusal itself is pinned by the gate tests at the bottom.

const URL_OK = '/api/stream/connect?workspace=default';
const PATH = '/api/stream/connect';

test('S-D6 POST /api/stream/connect without workspace → 400 workspace_required', async () => {
    const { store: outbox } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    const req = makeReq({ method: 'POST', chunks: [] });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, '/api/stream/connect', PATH,
        { deploymentMode: 'cloud' as const, outboxStore: outbox, streamRegistry: registry });
    assert.equal(handled, true);
    assert.equal(res._status, 400);
    assert.match(res._body, /workspace_required/);
    assert.equal(registry.totalActive(), 0);
});

test('S-D2 POST /api/stream/connect streams 10 events → all land in outbox', async () => {
    const { store: outbox, records } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    const events = Array.from({ length: 10 }, (_, i) =>
        Buffer.from(JSON.stringify({ id: `e${i}`, payload: { n: i } }) + '\n'));
    const req = makeReq({ method: 'POST', chunks: events });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, URL_OK, PATH,
        { deploymentMode: 'cloud' as const, outboxStore: outbox, streamRegistry: registry });
    assert.equal(handled, true);
    assert.equal(res._status, 200);
    assert.equal(records.length, 10, `expected 10 outbox commits got ${records.length}`);
    // Frame 0 = connected; next 10 = per-event acks.
    assert.ok(res._frames.length >= 11, `expected >= 11 frames got ${res._frames.length}`);
    const connected = JSON.parse(res._frames[0]);
    assert.equal(connected.type, 'connected');
    assert.equal(connected.workspace, 'default');
    // Every event ack ok.
    for (let i = 1; i <= 10; i++) {
        const ack = JSON.parse(res._frames[i]);
        assert.equal(ack.ok, true, `ack #${i} should be ok`);
    }
    // Registry released after close.
    assert.equal(registry.totalActive(), 0);
    assert.equal(registry.getCount('default'), 0);
});

test('S-D5 concurrency cap: 3 concurrent + 4th gets 429', async () => {
    const { store: outbox } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    // Manually open 3 sessions on the registry (simulates 3 long-lived
    // in-flight connections) — equivalent to the route having accepted
    // 3 connections that are still pumping.
    for (let i = 0; i < 3; i++) {
        const r = registry.open('default');
        assert.equal(r.ok, true);
    }
    // 4th HTTP attempt against the same workspace must hit 429.
    const req = makeReq({ method: 'POST', chunks: [] });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, URL_OK, PATH,
        { deploymentMode: 'cloud' as const, outboxStore: outbox, streamRegistry: registry });
    assert.equal(handled, true);
    // 429 path uses res.statusCode + setHeader (no writeHead).
    assert.equal(res.statusCode, 429);
    assert.equal(res._headers['Retry-After'], '5');
    const body = JSON.parse(res._body);
    // Wave-5 canonical envelope carries `code` (the old `error` field moved).
    assert.equal(body.code, 'concurrency_limit');
    assert.equal(body.cap, 3);
    assert.equal(body.current, 3);
});

test('S-D8 backpressure: high outbox lag → 503 outbox_lag (no slot acquired)', async () => {
    const { store: outbox } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    const lagCache = makeLagCache(true);
    const req = makeReq({ method: 'POST', chunks: [] });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, URL_OK, PATH,
        { deploymentMode: 'cloud' as const, outboxStore: outbox, streamRegistry: registry, outboxLagCache: lagCache });
    assert.equal(handled, true);
    assert.equal(res._status, 503);
    assert.match(res._body, /outbox_lag/);
    // CRITICAL: no slot was acquired (backpressure check fires BEFORE
    // registry.open).
    assert.equal(registry.getCount('default'), 0);
});

test('Malformed JSON event → per-event ack ok=false, stream stays open', async () => {
    const { store: outbox, records } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    const chunks = [
        Buffer.from('{"id":"good-1","payload":{}}\n'),
        Buffer.from('this is not json\n'),
        Buffer.from('{"id":"good-2","payload":{}}\n'),
    ];
    const req = makeReq({ method: 'POST', chunks });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, URL_OK, PATH,
        { deploymentMode: 'cloud' as const, outboxStore: outbox, streamRegistry: registry });
    assert.equal(handled, true);
    assert.equal(res._status, 200);
    // 2 good events committed; the malformed one did NOT commit.
    assert.equal(records.length, 2);
    // Frames: connected + 3 acks.
    assert.equal(res._frames.length, 4);
    const ack1 = JSON.parse(res._frames[1]);
    const ack2 = JSON.parse(res._frames[2]);
    const ack3 = JSON.parse(res._frames[3]);
    assert.equal(ack1.ok, true);
    assert.equal(ack2.ok, false);
    assert.equal(ack2.error, 'validation');
    assert.equal(ack3.ok, true);
});

test('S-D4 connection drop mid-stream → registry slot released, outbox consistent', async () => {
    const { store: outbox, records } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    const chunks = [
        Buffer.from('{"id":"e1","payload":{}}\n'),
        Buffer.from('{"id":"e2","payload":{}}\n'),
    ];
    // drop=true → simulates client disconnect mid-stream (no 'end').
    const req = makeReq({ method: 'POST', chunks, drop: true });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, URL_OK, PATH,
        { deploymentMode: 'cloud' as const, outboxStore: outbox, streamRegistry: registry });
    assert.equal(handled, true);
    // Both events that landed before drop are committed to outbox.
    assert.equal(records.length, 2);
    // Registry slot released (finally block ran).
    assert.equal(registry.totalActive(), 0);
    assert.equal(registry.getCount('default'), 0);
});

test('Invalid format → 400 invalid_format', async () => {
    const { store: outbox } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    const req = makeReq({ method: 'POST', chunks: [] });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, '/api/stream/connect?workspace=default&format=protobuf', PATH,
        { deploymentMode: 'cloud' as const, outboxStore: outbox, streamRegistry: registry });
    assert.equal(handled, true);
    assert.equal(res._status, 400);
    assert.match(res._body, /invalid_format/);
});

test('Missing outbox wiring → 503 outbox_unavailable', async () => {
    const registry = new StreamRegistry(3);
    const req = makeReq({ method: 'POST', chunks: [] });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, URL_OK, PATH,
        { deploymentMode: 'cloud' as const, streamRegistry: registry });
    assert.equal(handled, true);
    assert.equal(res._status, 503);
    assert.match(res._body, /outbox_unavailable/);
});

test('GET /api/stream/sessions?workspace=X lists active sessions', async () => {
    const { store: outbox } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    registry.open('default', 'cdc-stream-1');
    registry.open('default', 'cdc-stream-2');
    const req = makeReq({ method: 'GET' });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, '/api/stream/sessions?workspace=default', '/api/stream/sessions',
        { deploymentMode: 'cloud' as const, outboxStore: outbox, streamRegistry: registry });
    assert.equal(handled, true);
    assert.equal(res._status, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.workspace, 'default');
    assert.equal(body.count, 2);
    assert.equal(body.cap, 3);
    assert.equal(body.sessions.length, 2);
});

// ─── Launch gate (2026-08-19): cloud-only refusal in local mode ─────

test('local mode: POST /api/stream/connect → 501 stream_ingest_cloud_only, no session/outbox side effects', async () => {
    const { store: outbox, records } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    const req = makeReq({ method: 'POST', chunks: [Buffer.from('{"payload":{}}\n')] });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, URL_OK, PATH,
        { deploymentMode: 'local' as const, outboxStore: outbox, streamRegistry: registry });
    assert.equal(handled, true);
    assert.equal(res._status, 501);
    const body = JSON.parse(res._body);
    assert.equal(body.code, 'stream_ingest_cloud_only');
    assert.match(body.message, /cloud-only/);
    // The gate fires BEFORE registry.open / consumer start: no session, no
    // outbox commit, no 'connected' frame.
    assert.equal(registry.getCount('default'), 0, 'refused connect must not open a registry session');
    assert.equal(registry.listForWorkspace('default').length, 0);
    assert.equal(records.length, 0, 'refused connect must not commit to the outbox');
    assert.equal(res._frames.length, 0, 'refused connect must not open a chunked ack stream');
});

test('local mode: gate fires before workspace_required (no workspace param → still 501)', async () => {
    const { store: outbox } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    const req = makeReq({ method: 'POST', chunks: [] });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, '/api/stream/connect', PATH,
        { deploymentMode: 'local' as const, outboxStore: outbox, streamRegistry: registry });
    assert.equal(handled, true);
    assert.equal(res._status, 501);
    assert.match(res._body, /stream_ingest_cloud_only/);
});

test('local mode: GET /api/stream/sessions → 501 stream_ingest_cloud_only (not an empty list)', async () => {
    const { store: outbox } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    const req = makeReq({ method: 'GET' });
    const res = fakeRes();
    void req._flushAfter(2);
    const handled = await tryStreamRoutes(req, res, '/api/stream/sessions?workspace=default', '/api/stream/sessions',
        { deploymentMode: 'local' as const, outboxStore: outbox, streamRegistry: registry });
    assert.equal(handled, true);
    assert.equal(res._status, 501);
    const body = JSON.parse(res._body);
    assert.equal(body.code, 'stream_ingest_cloud_only');
});

test('gate does not swallow non-stream paths (unmatched pathname → handled=false)', async () => {
    const { store: outbox } = makeStubOutbox();
    const registry = new StreamRegistry(3);
    const req = makeReq({ method: 'GET' });
    const res = fakeRes();
    const handled = await tryStreamRoutes(req, res, '/api/health', '/api/health',
        { deploymentMode: 'local' as const, outboxStore: outbox, streamRegistry: registry });
    assert.equal(handled, false, 'non-stream path must fall through to the next dispatcher family');
    assert.equal(res._status, 0, 'no response may be written for an unmatched path');
});

// ─── Runner ──────────────────────────────────────────────────────────

await Promise.all(pending);
console.log('');
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed > 0) process.exit(1);
