#!/usr/bin/env tsx
/**
 * test/ingestion-callback-listener-unit.ts - the separate callback listener: routing, error opacity,
 * rate limit, concurrency caps, slowloris timeout, port-collision refusal, bounded rate window, close.
 * No daemon, no fixed ports: every listener binds 127.0.0.1:0.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { startCallbackListener, RateWindow, CallbackListenerConfigError } from '../packages/lore/src/ingestion/callbackListener.js';
import type { CoordinatorResolver } from '../packages/lore/src/ingestion/callbackServer.js';

let passed = 0; let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok  ${name}`); passed++; } catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const JOB = 'job_0123456789abcdef';
const unknown: CoordinatorResolver = async () => undefined;

function rawRequest(port: number, head: string, body = ''): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1'); let buf = '';
        s.on('data', (d) => { buf += d.toString('utf8'); });
        s.on('close', () => { const m = /^HTTP\/1\.1 (\d{3})/.exec(buf); resolve({ status: m ? Number(m[1]) : 0, text: buf }); });
        s.on('error', reject);
        s.write(`${head}\r\nHost: x\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
}
const post = (port: number, path = `/api/ingest/callback/${JOB}`, body = '{}') => rawRequest(port, `POST ${path} HTTP/1.1`, body);
const bodyOf = (text: string) => text.slice(text.indexOf('\r\n\r\n') + 4);

await test('refuses the main daemon port and invalid ports; allows port 0 even when mainPort is 0', async () => {
    await assert.rejects(startCallbackListener({ resolve: unknown, port: 4321, mainPort: 4321 }), (e: unknown) => e instanceof CallbackListenerConfigError);
    await assert.rejects(startCallbackListener({ resolve: unknown, port: 70000 }), CallbackListenerConfigError);
    await assert.rejects(startCallbackListener({ resolve: unknown, port: -1 }), CallbackListenerConfigError);
    const l = await startCallbackListener({ resolve: unknown, port: 0, mainPort: 0 }); assert.ok(l.port > 0); assert.equal(l.bind, '127.0.0.1'); await l.close(50);
});

await test('only the callback route exists: unknown route 404, wrong method 405, fixed bodies, unknown job 401', async () => {
    const l = await startCallbackListener({ resolve: unknown, port: 0 });
    try {
        for (const p of ['/', '/mcp', '/api/health', '/api/ingest/callback', '/api/other']) {
            const r = await post(l.port, p); assert.equal(r.status, 404, p); assert.equal(bodyOf(r.text), '{"code":"not_found"}');
        }
        const g = await rawRequest(l.port, `GET /api/ingest/callback/${JOB} HTTP/1.1`); assert.equal(g.status, 405);
        assert.ok(!/stack|Error|at /.test(bodyOf(g.text)));
        const bad = await post(l.port, '/api/ingest/callback/../../etc'); assert.ok([401, 404].includes(bad.status));
        const u = await post(l.port); assert.equal(u.status, 401);
        const o = await rawRequest(l.port, `POST /api/ingest/callback/${JOB} HTTP/1.1`, 'x'.repeat(10)); assert.equal(o.status, 401);
    } finally { await l.close(50); }
});

await test('a declared oversize body is refused with 413 before it is read', async () => {
    const l = await startCallbackListener({ resolve: unknown, port: 0 });
    try {
        const r = await new Promise<number>((resolve, reject) => {
            const s = net.connect(l.port, '127.0.0.1'); let buf = '';
            s.on('data', (d) => { buf += d.toString(); }); s.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0))); s.on('error', reject);
            s.write(`POST /api/ingest/callback/${JOB} HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: ${64 * 1024 * 1024}\r\n\r\n`);
        });
        assert.equal(r, 413);
    } finally { await l.close(50); }
});

await test('a resolver that throws yields 500 with a fixed body that never echoes the error', async () => {
    const l = await startCallbackListener({ resolve: async () => { throw new Error('postgres://user:hunter2@db/secret'); }, port: 0 });
    try {
        const r = await post(l.port); assert.equal(r.status, 500); assert.equal(bodyOf(r.text), '{"code":"internal_error"}');
        assert.ok(!r.text.includes('hunter2'));
    } finally { await l.close(50); }
});

await test('per-source-IP rate limit: requests over the window limit get 429 + Retry-After', async () => {
    const l = await startCallbackListener({ resolve: unknown, port: 0, perIpPerMin: 3 });
    try {
        const codes: number[] = []; let last = '';
        for (let i = 0; i < 6; i++) { const r = await post(l.port); codes.push(r.status); last = r.text; }
        assert.deepEqual(codes.slice(0, 3), [401, 401, 401]); assert.ok(codes.slice(3).every((c) => c === 429), codes.join(','));
        assert.match(last, /Retry-After: 60/i); assert.ok(bodyOf(last).includes('rate_limited'));
    } finally { await l.close(50); }
});

await test('per-IP concurrency cap: a held request makes the next one from the same peer 503', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const l = await startCallbackListener({ resolve: async () => { await gate; return undefined; }, port: 0, maxConcurrent: 4, perIpPerMin: 1000 });
    try {
        const first = post(l.port); await sleep(100);
        const second = await post(l.port); assert.equal(second.status, 503); assert.match(second.text, /Retry-After/i);
        release(); assert.equal((await first).status, 401);
        assert.equal((await post(l.port)).status, 401, 'capacity is returned once the held request finishes');
    } finally { release(); await l.close(50); }
});

await test('slowloris: a connection that never completes its headers is dropped by the header timeout', async () => {
    const l = await startCallbackListener({ resolve: unknown, port: 0, headersTimeoutMs: 300, requestTimeoutMs: 1000 });
    try {
        const t0 = Date.now();
        await new Promise<void>((resolve, reject) => {
            const s = net.connect(l.port, '127.0.0.1'); s.resume(); s.on('close', () => resolve()); s.on('error', () => resolve());
            s.write('POST /api/ingest/callback/x HTTP/1.1\r\nHost: x\r\nX-Slow: '); // never finishes
            setTimeout(() => { s.destroy(); reject(new Error('connection was not dropped within 4s')); }, 4000).unref();
        });
        assert.ok(Date.now() - t0 < 3500, `dropped after ${Date.now() - t0}ms`);
    } finally { await l.close(50); }
});

await test('malformed requests get a fixed 400 with no detail', async () => {
    const l = await startCallbackListener({ resolve: unknown, port: 0 });
    try {
        const r = await new Promise<string>((resolve) => { const s = net.connect(l.port, '127.0.0.1'); let b = ''; s.on('data', (d) => { b += d; }); s.on('close', () => resolve(b)); s.on('error', () => resolve(b)); s.write('\x00\x01 NOT HTTP\r\n\r\n'); });
        assert.match(r, /^HTTP\/1\.1 400/); assert.ok(!/Error|stack/i.test(r));
    } finally { await l.close(50); }
});

await test('RateWindow: windows roll over and the tracked-key set is bounded', async () => {
    const w = new RateWindow(2, 1000, 8);
    assert.ok(w.allow('a', 0)); assert.ok(w.allow('a', 1)); assert.ok(!w.allow('a', 2)); assert.ok(w.allow('a', 1500), 'new window');
    for (let i = 0; i < 1000; i++) w.allow(`k${i}`, 10);
    const size = (w as unknown as { hits: Map<string, unknown> }).hits.size; assert.ok(size <= 8, `size ${size}`);
});

await test('close() stops accepting connections and returns promptly even with an idle keep-alive client', async () => {
    const l = await startCallbackListener({ resolve: unknown, port: 0 });
    const port = l.port; const idle = net.connect(port, '127.0.0.1'); idle.on('error', () => undefined); await new Promise<void>((r) => idle.once('connect', () => r()));
    const t0 = Date.now(); await l.close(200); assert.ok(Date.now() - t0 < 2000);
    await assert.rejects(new Promise<void>((resolve, reject) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(); }); s.once('error', reject); }));
    idle.destroy();
});

console.log(`ingestion-callback-listener: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
