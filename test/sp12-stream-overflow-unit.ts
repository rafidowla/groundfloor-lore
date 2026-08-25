#!/usr/bin/env tsx
/**
 * sp12-stream-overflow-unit.ts — SP-12 regression.
 *
 * Stream ingest (POST /api/stream/connect) built an unbounded per-line
 * buffer (cap was the whole-body maxBytes = 1 GiB per connection) and kept
 * reading attacker-controlled bytes after a body-cap overflow. This suite:
 *
 *   1. line_too_long: a payload with NO newline that exceeds the per-line
 *      cap (LORE_STREAM_MAX_LINE_BYTES) emits a {type:'closed',
 *      reason:'line_too_long'} frame and the buffer never balloons.
 *   2. socket teardown: on overflow the handler calls req.pause() +
 *      req.destroy() instead of draining further bytes, and discards
 *      chunks that arrive after the cap is hit.
 *   3. body_too_large still fires its close frame and tears down.
 *
 * Each assertion fails on the pre-SP-12 tree (no per-line cap; no destroy).
 *
 * Run: LORE_STREAM_MAX_LINE_BYTES=1024 npx tsx test/sp12-stream-overflow-unit.ts
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { tryStreamRoutes } from '../packages/lore/src/mcp/http/routes/stream.js';
import { StreamRegistry } from '../packages/lore/src/streaming/streamRegistry.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
        if (process.env['SP12_DEBUG']) console.error((e as Error).stack);
        failed++;
    }
};

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

/** Fake chunked-transfer request with pause()/destroy() tracking and
 *  per-step chunk emission so the test can observe state mid-stream. */
interface FakeReq extends IncomingMessage {
    _emit(chunk: Buffer): void;
    _end(): void;
    _paused: boolean;
    _destroyed: boolean;
}
function makeReq(): FakeReq {
    const handlers: Record<string, Array<(arg?: unknown) => void>> = {};
    const req = {
        method: 'POST' as const,
        _paused: false,
        _destroyed: false,
        on(event: string, cb: (arg?: unknown) => void) {
            (handlers[event] ??= []).push(cb);
            return this;
        },
        pause() { (this as unknown as { _paused: boolean })._paused = true; return this; },
        destroy() {
            (this as unknown as { _destroyed: boolean })._destroyed = true;
            for (const cb of handlers['close'] ?? []) cb();
            return this;
        },
        _emit(chunk: Buffer) {
            if ((this as unknown as { _destroyed: boolean })._destroyed) return;
            for (const cb of handlers['data'] ?? []) cb(chunk);
        },
        _end() { for (const cb of handlers['end'] ?? []) cb(); },
    };
    return req as unknown as FakeReq;
}

interface FakeRes extends ServerResponse {
    _status: number;
    _frames: string[];
    _ended: boolean;
}
function fakeRes(): FakeRes {
    const r = {
        _status: 0, _frames: [] as string[], _ended: false, statusCode: 0,
        setHeader() { /* noop */ },
        writeHead(s: number) { (this as { _status: number })._status = s; (this as { statusCode: number }).statusCode = s; return this; },
        write(chunk: string) { (this as { _frames: string[] })._frames.push(chunk); return true; },
        end(b?: string) { if (b) (this as { _frames: string[] })._frames.push(b); (this as { _ended: boolean })._ended = true; },
    };
    return r as unknown as FakeRes;
}

const PATH = '/api/stream/connect';
const URL_OK = '/api/stream/connect?workspace=default';

function parseFrames(res: FakeRes): Array<Record<string, unknown>> {
    return res._frames
        .flatMap((f) => f.split('\n'))
        .filter((s) => s.trim())
        .map((s) => { try { return JSON.parse(s); } catch { return { _raw: s }; } });
}

(async () => {
    console.log('SP-12 — stream ingest bounded buffer + overflow teardown');
    // Tight per-line cap so the test stays small + fast.
    process.env['LORE_STREAM_MAX_LINE_BYTES'] = '1024';

    await test('line_too_long: huge no-newline payload bounds the buffer + closes', async () => {
        const { store } = makeStubOutbox();
        const registry = new StreamRegistry(3);
        const req = makeReq();
        const res = fakeRes();

        const done = tryStreamRoutes(req, res, URL_OK, PATH,
            { deploymentMode: 'cloud' as const, outboxStore: store, streamRegistry: registry });

        // Let the connect handshake run (connected frame), then stream a
        // 4 KiB chunk with NO newline (> the 1 KiB per-line cap).
        await new Promise((r) => setImmediate(r));
        req._emit(Buffer.from('x'.repeat(4096))); // no '\n'
        // The cap should have fired synchronously inside the data handler.
        await new Promise((r) => setImmediate(r));

        assert.equal(req._paused, true, 'req.pause() called on overflow');
        assert.equal(req._destroyed, true, 'req.destroy() called (deferred a tick)');
        const frames = parseFrames(res);
        const closed = frames.find((f) => f['type'] === 'closed');
        assert.ok(closed, 'a closed frame was emitted');
        assert.equal(closed!['reason'], 'line_too_long', 'reason is line_too_long');

        await done;
        assert.equal(registry.getCount('default'), 0, 'registry slot released');
    });

    await test('post-overflow chunks are discarded (no further processing)', async () => {
        const { store, records } = makeStubOutbox();
        const registry = new StreamRegistry(3);
        const req = makeReq();
        const res = fakeRes();

        const done = tryStreamRoutes(req, res, URL_OK, PATH,
            { deploymentMode: 'cloud' as const, outboxStore: store, streamRegistry: registry });
        await new Promise((r) => setImmediate(r));
        req._emit(Buffer.from('y'.repeat(4096))); // triggers line_too_long
        await new Promise((r) => setImmediate(r));
        // A late, well-formed event after destroy() must NOT be processed.
        req._emit(Buffer.from(JSON.stringify({ id: 'late', payload: {} }) + '\n'));
        await new Promise((r) => setImmediate(r));

        assert.equal(records.length, 0, 'no events committed after overflow');
        await done;
    });

    await test('body_too_large still fires its close frame + teardown', async () => {
        // Lift the line cap so the body cap is what trips first.
        process.env['LORE_STREAM_MAX_LINE_BYTES'] = String(64 * 1024 * 1024);
        process.env['LORE_STREAM_MAX_BYTES'] = '2048';
        const { store } = makeStubOutbox();
        const registry = new StreamRegistry(3);
        const req = makeReq();
        const res = fakeRes();
        const done = tryStreamRoutes(req, res, URL_OK, PATH,
            { deploymentMode: 'cloud' as const, outboxStore: store, streamRegistry: registry });
        await new Promise((r) => setImmediate(r));
        req._emit(Buffer.from('z'.repeat(4096))); // > 2048 body cap, no newline yet
        await new Promise((r) => setImmediate(r));
        const frames = parseFrames(res);
        const closed = frames.find((f) => f['type'] === 'closed');
        assert.ok(closed, 'closed frame emitted on body overflow');
        assert.equal(closed!['reason'], 'body_too_large', 'reason is body_too_large');
        assert.equal(req._destroyed, true, 'socket torn down on body overflow');
        await done;
        delete process.env['LORE_STREAM_MAX_BYTES'];
        process.env['LORE_STREAM_MAX_LINE_BYTES'] = '1024';
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
