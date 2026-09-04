#!/usr/bin/env tsx
/**
 * test/security-response-headers-unit.ts — security checklist item #12:
 * the HTTP daemon set no browser security headers on any response (no
 * X-Content-Type-Options, X-Frame-Options / CSP frame-ancestors,
 * Content-Security-Policy, Referrer-Policy) — including GET
 * /api/export/html, which returns text/html with an inline <script> and a
 * CDN-loaded vis-network.
 *
 * Fix: mcp/http/helpers.ts's applySecurityHeaders() is called as the FIRST
 * statement of mcp/http/middleware.ts's runHttpGates — the one chokepoint
 * every request passes through before any gate or route writes a byte —
 * setting X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
 * Cache-Control, and a strict default Content-Security-Policy via
 * res.setHeader(). GET /api/export/html (routes/static.ts) overrides the
 * CSP with a page-specific policy (buildHtmlExportCsp) carrying a
 * per-response nonce that engines/htmlExport.ts stamps onto its inline
 * <script>/<style> tags.
 *
 * This suite:
 *   A. runHttpGates-level — headers present on every gate outcome: a
 *      normal pass-through, a 401 auth failure, an OPTIONS preflight, and
 *      a 429 rate-limit response. Uses a res mock that replicates Node's
 *      real setHeader()/writeHead() merge semantics (case-insensitive,
 *      writeHead's own object wins on a name collision) so "does route X's
 *      writeHead accidentally clobber a header" is actually verified, not
 *      assumed.
 *   B. GET /api/export/html (routes/static.ts + engines/htmlExport.ts) —
 *      the response's CSP differs from the generic default, and the nonce
 *      inside that CSP header matches the nonce attribute stamped on both
 *      the inline <script> and inline <style> tags in the body.
 *   C. POST /api/stream/connect (routes/stream.ts, cloud-only) — the
 *      route's own Content-Type/Transfer-Encoding/Cache-Control survive
 *      the baseline headers untouched (proving the merge rule, not just
 *      the setHeader call), and the connection still actually streams
 *      (the 'connected' ack frame arrives, and a follow-up event gets an
 *      ack).
 *
 * Fails on the pre-fix tree (helpers.ts has no applySecurityHeaders /
 * generateCspNonce / buildHtmlExportCsp export — import error — and, once
 * stubbed to compile, no security headers would appear on any response).
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
    applySecurityHeaders,
    generateCspNonce,
    buildHtmlExportCsp,
} from '../packages/lore/src/mcp/http/helpers.js';
import { runHttpGates } from '../packages/lore/src/mcp/http/middleware.js';
import { tryStaticRoutes } from '../packages/lore/src/mcp/http/routes/static.js';
import { tryStreamRoutes } from '../packages/lore/src/mcp/http/routes/stream.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

const REQUIRED_HEADERS: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
};

/**
 * Mock ServerResponse that replicates Node's REAL header semantics closely
 * enough to catch a regression: setHeader() stores case-insensitively;
 * writeHead(status, headersObj) merges headersObj OVER whatever was set via
 * setHeader (matching Node's documented precedence), not the other way
 * around. This is the exact behavior applySecurityHeaders' doc comment
 * relies on, so the test asserts the assumption holds, not just the
 * outcome.
 */
function makeMockRes() {
    const headers: Record<string, string> = {};
    const chunks: string[] = [];
    const r = {
        statusCode: 0,
        headersSent: false,
        _headers: headers,
        _chunks: chunks,
        get _body() { return chunks.join(''); },
        setHeader(name: string, value: string | number) {
            headers[name.toLowerCase()] = String(value);
        },
        getHeader(name: string) {
            return headers[name.toLowerCase()];
        },
        writeHead(status: number, arg2?: unknown, arg3?: unknown) {
            r.statusCode = status;
            const hdrs = (typeof arg2 === 'object' && arg2 !== null ? arg2
                : typeof arg3 === 'object' && arg3 !== null ? arg3
                : undefined) as Record<string, string | number> | undefined;
            if (hdrs) {
                for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = String(v);
            }
            r.headersSent = true;
            return r;
        },
        write(chunk: string | Buffer) {
            chunks.push(chunk.toString());
            return true;
        },
        end(chunk?: string | Buffer) {
            if (chunk !== undefined) chunks.push(chunk.toString());
            r.headersSent = true;
            return r;
        },
        on() { return r; },
    };
    return r as unknown as ServerResponse & {
        statusCode: number; _headers: Record<string, string>; _chunks: string[]; _body: string;
    };
}

function assertBaselineHeaders(headers: Record<string, string>, label: string): void {
    for (const [name, expected] of Object.entries(REQUIRED_HEADERS)) {
        assert.equal(headers[name], expected, `${label}: expected ${name}=${expected}, got ${headers[name]}`);
    }
    assert.equal(headers['cache-control'], 'no-store', `${label}: expected default Cache-Control: no-store`);
    assert.ok(headers['content-security-policy'], `${label}: expected a Content-Security-Policy header`);
}

console.log('\nsecurity-response-headers (checklist #12)');

/* ═══════════════ A. runHttpGates — headers on every gate outcome ═══════════════ */

const PORT = 58421;
const TOKEN = 'a'.repeat(64);
const noopRateLimiter = { tryConsume: () => ({ allowed: true, limit: 100, remaining: 99, resetSec: 60, retryAfterSec: 0 }) };
const denyingRateLimiter = { tryConsume: () => ({ allowed: false, limit: 1, remaining: 0, resetSec: 60, retryAfterSec: 30 }) };

function gateDeps(rateLimiter: { tryConsume: () => { allowed: boolean; limit: number; remaining: number; resetSec: number; retryAfterSec: number } }) {
    return {
        port: PORT,
        dataHome: '/tmp/security-response-headers-unit-unused',
        getAuthToken: () => TOKEN,
        rateLimiter: rateLimiter as never,
        deploymentMode: 'local' as const,
        getBootstrapWorkspace: () => 'dev',
    };
}

function mockReq(overrides: { method?: string; url?: string; headers?: Record<string, string> }): IncomingMessage {
    return {
        method: overrides.method ?? 'GET',
        url: overrides.url ?? '/api/health',
        headers: { host: `localhost:${PORT}`, ...(overrides.headers ?? {}) },
    } as unknown as IncomingMessage;
}

await test('applySecurityHeaders sets all five headers directly', () => {
    const res = makeMockRes();
    applySecurityHeaders(res);
    assertBaselineHeaders(res._headers, 'applySecurityHeaders');
    assert.equal(res._headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
});

await test('runHttpGates: normal pass-through (GET /api/health, no token) carries the headers', async () => {
    const res = makeMockRes();
    const gate = await runHttpGates(mockReq({}), res, gateDeps(noopRateLimiter));
    assert.equal(gate.handled, false, 'public path should pass through ungated');
    assertBaselineHeaders(res._headers, 'pass-through');
});

await test('runHttpGates: 401 auth failure (GET /api/nodes, no token) still carries the headers', async () => {
    const res = makeMockRes();
    const gate = await runHttpGates(mockReq({ url: '/api/nodes' }), res, gateDeps(noopRateLimiter));
    assert.equal(gate.handled, true);
    assert.equal(res.statusCode, 401);
    assertBaselineHeaders(res._headers, '401 auth failure');
});

await test('runHttpGates: OPTIONS preflight still carries the headers', async () => {
    const res = makeMockRes();
    const gate = await runHttpGates(
        mockReq({ method: 'OPTIONS', url: '/api/nodes', headers: { origin: `http://localhost:${PORT}` } }),
        res,
        gateDeps(noopRateLimiter),
    );
    assert.equal(gate.handled, true);
    assert.equal(res.statusCode, 204);
    assertBaselineHeaders(res._headers, 'OPTIONS preflight');
    // Existing CORS behavior must be untouched by the new headers.
    assert.ok(res._headers['access-control-allow-methods'], 'CORS headers still present alongside the new ones');
});

await test('runHttpGates: 429 rate-limited response still carries the headers, Retry-After intact', async () => {
    const res = makeMockRes();
    const gate = await runHttpGates(
        mockReq({ url: '/api/nodes', headers: { authorization: `Bearer ${TOKEN}` } }),
        res,
        gateDeps(denyingRateLimiter),
    );
    assert.equal(gate.handled, true);
    assert.equal(res.statusCode, 429);
    assertBaselineHeaders(res._headers, '429 rate limited');
    assert.equal(res._headers['retry-after'], '30', 'rate-limit Retry-After header untouched by the new defaults');
});

/* ═══════════════ B. GET /api/export/html — page-specific CSP + nonce ═══════════════ */

function fakeGraph() {
    return {
        async getTopology(_max: number) {
            return {
                nodes: [{ id: 'n1', label: 'Node One', type: 'note' }],
                edges: [] as unknown[],
            };
        },
    } as never;
}

await test('GET /api/export/html: CSP overrides the generic default and matches the inline nonce', async () => {
    const res = makeMockRes();
    // Simulate the middleware chokepoint exactly as runHttpGates would.
    applySecurityHeaders(res);
    assert.equal(res._headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'", 'starts with the generic default, like every response');

    const handled = await tryStaticRoutes(
        mockReq({ url: '/api/export/html?workspace=demo' }),
        res,
        '/api/export/html?workspace=demo',
        '/api/export/html',
        { store: { loreGraph: fakeGraph() } as never, deploymentMode: 'local' },
    );
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);
    assert.equal(res._headers['content-type'], 'text/html; charset=utf-8', 'Content-Type unaltered');

    const csp = res._headers['content-security-policy'];
    assert.notEqual(csp, "default-src 'none'; frame-ancestors 'none'", 'the HTML export CSP must override the generic default, not just inherit it');
    assert.match(csp, /script-src 'nonce-([^']+)' https:\/\/unpkg\.com/, 'script-src carries a nonce + the vis-network CDN origin');
    assert.match(csp, /style-src 'nonce-([^']+)'/, 'style-src carries a nonce');
    assert.match(csp, /connect-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);

    const scriptNonceMatch = /script-src 'nonce-([^']+)'/.exec(csp);
    const styleNonceMatch = /style-src 'nonce-([^']+)'/.exec(csp);
    assert.ok(scriptNonceMatch && styleNonceMatch, 'both nonces parsed out of the CSP header');
    const nonce = scriptNonceMatch![1];
    assert.equal(nonce, styleNonceMatch![1], 'script-src and style-src share the same per-response nonce');

    const body = res._body;
    assert.ok(body.includes(`<style nonce="${nonce}">`), 'inline <style> tag carries the matching nonce attribute');
    assert.ok(body.includes(`<script nonce="${nonce}">`), 'inline <script> tag (DATA + vis.Network wiring) carries the matching nonce attribute');
    // The CDN loader script must NOT carry the nonce attribute (it's
    // allow-listed by origin, and giving every script tag a nonce would
    // mask a future accidental nonce-less inline script from CSP).
    assert.ok(!body.includes(`<script nonce="${nonce}" src=`), 'CDN <script src=...> is not nonced');
    assert.ok(body.includes('src="https://unpkg.com/vis-network@9.1.9/'), 'CDN script tag still present, unpinned/unchanged');
});

await test('exportGraphAsHtml with no cspNonce (e.g. `lore export html` CLI path) omits the nonce attribute', async () => {
    const { exportGraphAsHtml } = await import('../packages/lore/src/engines/htmlExport.js');
    const html = await exportGraphAsHtml(fakeGraph());
    assert.ok(!html.includes('nonce='), 'no nonce attribute anywhere when the caller supplies none');
    assert.ok(html.includes('<style>'), 'plain <style> tag preserved');
    assert.ok(html.includes('<script>'), 'plain inline <script> tag preserved');
});

/* ═══════════════ C. POST /api/stream/connect — merge survives, still streams ═══════════════ */

await test('POST /api/stream/connect: baseline headers merge under the route\'s own Content-Type/Transfer-Encoding, and the connection still streams', async () => {
    // Real HTTP round-trip (not the mock res) so Node's actual header-merge
    // and chunked-transfer behavior is what's under test, not a
    // reimplementation of it.
    const fakeOutboxStore = {} as never;
    const openSessions = new Map<string, { sessionId: string; openedAt: string }>();
    const fakeStreamRegistry = {
        open: (workspace: string) => {
            const session = { sessionId: `sess-${workspace}`, openedAt: new Date().toISOString() };
            openSessions.set(session.sessionId, session);
            return { ok: true as const, session, current: 1, cap: 3 };
        },
        release: (sessionId: string) => { openSessions.delete(sessionId); },
        recordEvent: () => undefined,
        getCap: () => 3,
        getCount: () => 1,
    };
    const fakeConsumer = {
        start: async () => undefined,
        stop: async () => undefined,
        onEvent: async (event: { id: string }) => ({ id: event.id, ok: true as const }),
    };

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        applySecurityHeaders(res);
        void tryStreamRoutes(req, res, req.url ?? '', (req.url ?? '').split('?')[0], {
            deploymentMode: 'cloud',
            outboxStore: fakeOutboxStore,
            streamRegistry: fakeStreamRegistry as never,
            createConsumer: () => fakeConsumer as never,
        });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
        const ac = new AbortController();
        const res = await fetch(`http://127.0.0.1:${port}/api/stream/connect?workspace=demo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-ndjson' },
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: 'e1', operationKind: 'stream.event', payload: {} }) + '\n'));
                    setTimeout(() => controller.close(), 50);
                },
            }),
            // @ts-expect-error - Node fetch requires duplex for a streamed body
            duplex: 'half',
            signal: ac.signal,
        });

        // Route-specific headers must survive, unaltered.
        assert.equal(res.headers.get('content-type'), 'application/x-ndjson', 'stream Content-Type unaltered by the new defaults');
        assert.equal(res.headers.get('cache-control'), 'no-cache, no-transform', 'stream keeps its OWN Cache-Control, overriding the generic no-store default');
        // Baseline headers not touched by the route's writeHead still ride along.
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff', 'nosniff still present on the streaming response');
        assert.equal(res.headers.get('x-frame-options'), 'DENY', 'X-Frame-Options still present on the streaming response');
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer', 'Referrer-Policy still present on the streaming response');

        const text = await res.text();
        const frames = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        assert.equal(frames[0]?.type, 'connected', 'connection-open ack frame still arrives (still streams)');
        const ackFrame = frames.find((f) => f.ok === true);
        assert.ok(ackFrame, 'the queued event still got acked over the stream');
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
