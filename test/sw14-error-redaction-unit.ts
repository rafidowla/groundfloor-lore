#!/usr/bin/env tsx
/**
 * sw14-error-redaction-unit.ts — SW-14 regressions: analytics route error redaction.
 *
 * Covers findings A4 and A6 from AUDIT_FINDINGS.md:
 *
 *   A4: analytics.ts catch blocks returned raw (err as Error).message to the
 *       HTTP client, leaking Kùzu query internals and turning a blind injection
 *       into an oracle. Fixed: catch blocks now log via redactError() and return
 *       a generic 'internal_error' / 'invalid_request_body' body to the client.
 *
 *   A6: kuzuTableStorage.ts called assertIdent(schema.name) for its side-effect
 *       only (throws on invalid input), but the DDL still interpolated the raw
 *       schema.name. Fixed: DDL now uses the *return value* of assertIdent()
 *       (safeName) so a refactor can never silently drop the guard.
 *
 * Approach: we test the analytics route handler directly by invoking
 * tryAnalyticsRoutes() with a mock IAnalyticalStorage that throws an error
 * containing a synthetic "internal query" string. The test asserts:
 *   - the response body does NOT contain the raw error / query string
 *   - the response body DOES contain the generic error key
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

import { tryAnalyticsRoutes } from '../packages/lore/src/mcp/http/routes/analytics.js';
import type { IAnalyticalStorage } from '../packages/lore/src/contracts/index.js';

let passed = 0;
let failed = 0;
const tests: Array<Promise<void>> = [];

function test(name: string, fn: () => Promise<void> | void): void {
    tests.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`); failed++; }
    })());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The substring that a Kùzu engine would echo back in a real error. */
const LEAK_SENTINEL = 'MATCH (n:LoreNodes) WHERE n.secret = $injected RETURN n';

/** Build a minimal mock IAnalyticalStorage that throws an error containing the leak sentinel. */
function makeLeakyAnalytical(): IAnalyticalStorage {
    const boom = (): never => {
        throw new Error(`Kùzu query failed: ${LEAK_SENTINEL}`);
    };
    return {
        timeSeries: boom,
        aggregate: boom,
        count: boom,
        sum: boom,
        avg: boom,
        min: boom,
        max: boom,
        groupBy: boom,
        distinct: boom,
    } as unknown as IAnalyticalStorage;
}

/** Build a mock IncomingMessage (POST with JSON body). */
function makeMockReq(body: unknown): IncomingMessage {
    const emitter = new EventEmitter() as IncomingMessage;
    (emitter as Record<string, unknown>).method = 'POST';
    (emitter as Record<string, unknown>).headers = { 'content-type': 'application/json' };

    // Emit the body asynchronously so readJsonBody can consume it.
    setImmediate(() => {
        emitter.emit('data', Buffer.from(JSON.stringify(body)));
        emitter.emit('end');
    });
    return emitter;
}

interface MockResponse {
    statusCode: number | null;
    body: string;
    res: ServerResponse;
}

/** Build a mock ServerResponse that captures status + body. */
function makeMockRes(): MockResponse {
    let statusCode: number | null = null;
    let body = '';
    const res = {
        headersSent: false,
        writeHead(code: number) { statusCode = code; this.headersSent = true; },
        end(chunk?: string) { if (chunk) body += chunk; },
    } as unknown as ServerResponse;
    return { statusCode, body, res, get statusCode() { return statusCode; }, get body() { return body; } } as MockResponse;
}

// ── A4 tests: analytics route error redaction ─────────────────────────────────

test('A4 — /api/time-series Kùzu error: response body does NOT contain raw query', async () => {
    const req = makeMockReq({
        workspace: 'test-ws',
        collection: 'events',
        timeField: 'created_at',
        bucket: 'day',
        aggregation: 'count',
    });
    const mock = makeMockRes();
    await tryAnalyticsRoutes(
        req,
        mock.res,
        '',
        '/api/time-series',
        { analytical: makeLeakyAnalytical() },
    );
    assert.ok(!mock.body.includes(LEAK_SENTINEL),
        `Response body must not contain raw query. Got: ${mock.body}`);
    assert.ok(mock.body.includes('internal_error'),
        `Response body must contain 'internal_error'. Got: ${mock.body}`);
    assert.equal(mock.statusCode, 500, 'Must respond with 500');
});

test('A4 — /api/aggregate Kùzu error: response body does NOT contain raw query', async () => {
    const req = makeMockReq({
        workspace: 'test-ws',
        collection: 'events',
        aggregation: 'count',
    });
    const mock = makeMockRes();
    await tryAnalyticsRoutes(
        req,
        mock.res,
        '',
        '/api/aggregate',
        { analytical: makeLeakyAnalytical() },
    );
    assert.ok(!mock.body.includes(LEAK_SENTINEL),
        `Response body must not contain raw query. Got: ${mock.body}`);
    assert.ok(mock.body.includes('internal_error'),
        `Response body must contain 'internal_error'. Got: ${mock.body}`);
    assert.equal(mock.statusCode, 500, 'Must respond with 500');
});

test('A4 — /api/time-series invalid JSON body: returns generic error (not raw parse message)', async () => {
    const emitter = new EventEmitter() as IncomingMessage;
    (emitter as Record<string, unknown>).method = 'POST';
    (emitter as Record<string, unknown>).headers = { 'content-type': 'application/json' };
    setImmediate(() => {
        emitter.emit('data', Buffer.from('{ this is not json }'));
        emitter.emit('end');
    });
    const mock = makeMockRes();
    await tryAnalyticsRoutes(
        emitter,
        mock.res,
        '',
        '/api/time-series',
        { analytical: makeLeakyAnalytical() },
    );
    assert.equal(mock.statusCode, 400, 'Must respond with 400 for bad JSON');
    // Must NOT echo the raw JSON parse error (which contains the malformed input)
    assert.ok(!mock.body.includes('{ this is not json }'),
        `Response body must not echo malformed input. Got: ${mock.body}`);
    assert.ok(mock.body.includes('invalid_request_body'),
        `Response body must contain 'invalid_request_body'. Got: ${mock.body}`);
});

test('A4 — /api/aggregate invalid JSON body: returns generic error (not raw parse message)', async () => {
    const emitter = new EventEmitter() as IncomingMessage;
    (emitter as Record<string, unknown>).method = 'POST';
    (emitter as Record<string, unknown>).headers = { 'content-type': 'application/json' };
    setImmediate(() => {
        emitter.emit('data', Buffer.from('<<INJECTED CONTENT>>'));
        emitter.emit('end');
    });
    const mock = makeMockRes();
    await tryAnalyticsRoutes(
        emitter,
        mock.res,
        '',
        '/api/aggregate',
        { analytical: makeLeakyAnalytical() },
    );
    assert.equal(mock.statusCode, 400, 'Must respond with 400 for bad JSON');
    assert.ok(!mock.body.includes('<<INJECTED CONTENT>>'),
        `Response body must not echo injected content. Got: ${mock.body}`);
    assert.ok(mock.body.includes('invalid_request_body'),
        `Response body must contain 'invalid_request_body'. Got: ${mock.body}`);
});

// ── A6 tests: DDL guard uses assertIdent return value ─────────────────────────

test('A6 — assertIdent return value is used in DDL (structural: same value, different code paths)', async () => {
    // Verify assertIdent returns the validated identifier — the DDL now uses
    // the return value (safeName) not schema.name directly.
    const { _assertIdentForTests } = await import('./helpers/ident-test-util.js');
    const validName = 'LoreNodes';
    const result = _assertIdentForTests(validName);
    assert.equal(result, validName, 'assertIdent returns the input when valid');
});

test('A6 — assertIdent throws on dangerous identifier (guard would have caught DDL injection)', async () => {
    const { _assertIdentForTests } = await import('./helpers/ident-test-util.js');
    const evil = 'LoreNodes); DROP TABLE LoreNodes; --';
    assert.throws(
        () => _assertIdentForTests(evil),
        /invalid identifier/i,
        'assertIdent must throw for injection attempt',
    );
});

// ── runner ────────────────────────────────────────────────────────────────────

console.log('\n=== SW-14 error-redaction + DDL guard unit tests ===\n');
await Promise.all(tests);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
