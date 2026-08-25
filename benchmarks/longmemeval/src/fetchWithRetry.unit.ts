#!/usr/bin/env tsx
/**
 * fetchWithRetry.unit.ts — fetchWithRetry in isolation, with injected
 * fetchFn + zero-delay sleep. Zero real network calls, fast, deterministic.
 */

import assert from 'node:assert/strict';
import { fetchWithRetry } from './fetchWithRetry.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const noDelay = async () => {};
function fakeResponse(ok: boolean, status: number): Response {
    return { ok, status, text: async () => 'body', json: async () => ({}) } as unknown as Response;
}

console.log('fetchWithRetry');

await test('succeeds on the first try — fetchFn called once', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return fakeResponse(true, 200); }) as typeof fetch;
    const res = await fetchWithRetry('https://x', {}, { fetchFn, sleep: noDelay });
    assert.equal(res.ok, true);
    assert.equal(calls, 1);
});

await test('a thrown network error retries and succeeds once it clears', async () => {
    let calls = 0;
    const fetchFn = (async () => {
        calls++;
        if (calls < 3) throw new Error('EHOSTUNREACH');
        return fakeResponse(true, 200);
    }) as typeof fetch;
    const res = await fetchWithRetry('https://x', {}, { fetchFn, sleep: noDelay });
    assert.equal(res.ok, true);
    assert.equal(calls, 3);
});

await test('a thrown network error that never clears exhausts retries and throws', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; throw new Error('EHOSTUNREACH'); }) as typeof fetch;
    await assert.rejects(
        () => fetchWithRetry('https://x', {}, { fetchFn, sleep: noDelay, maxRetries: 3 }),
        /EHOSTUNREACH/,
    );
    assert.equal(calls, 4, 'initial attempt + 3 retries = 4 calls');
});

await test('a 429 response is retried and eventually succeeds', async () => {
    let calls = 0;
    const fetchFn = (async () => {
        calls++;
        return calls < 2 ? fakeResponse(false, 429) : fakeResponse(true, 200);
    }) as typeof fetch;
    const res = await fetchWithRetry('https://x', {}, { fetchFn, sleep: noDelay });
    assert.equal(res.ok, true);
    assert.equal(calls, 2);
});

await test('a 503 response is retried (5xx retryable)', async () => {
    let calls = 0;
    const fetchFn = (async () => {
        calls++;
        return calls < 2 ? fakeResponse(false, 503) : fakeResponse(true, 200);
    }) as typeof fetch;
    const res = await fetchWithRetry('https://x', {}, { fetchFn, sleep: noDelay });
    assert.equal(calls, 2);
    assert.equal(res.ok, true);
});

await test('a 404 is NOT retried — returned immediately as the non-ok response', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return fakeResponse(false, 404); }) as typeof fetch;
    const res = await fetchWithRetry('https://x', {}, { fetchFn, sleep: noDelay });
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
    assert.equal(calls, 1, '404 must not be retried');
});

await test('sustained 429s exhaust retries and return the last non-ok response (not throw) — caller handles it', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls++; return fakeResponse(false, 429); }) as typeof fetch;
    const res = await fetchWithRetry('https://x', {}, { fetchFn, sleep: noDelay, maxRetries: 2 });
    assert.equal(res.ok, false);
    assert.equal(res.status, 429);
    assert.equal(calls, 3, 'initial attempt + 2 retries = 3 calls');
});

await test('fetchFn receives the same url and init on every attempt', async () => {
    const seenUrls: string[] = [];
    const seenMethods: (string | undefined)[] = [];
    let calls = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
        calls++;
        seenUrls.push(url as string);
        seenMethods.push(init?.method);
        if (calls < 2) throw new Error('blip');
        return fakeResponse(true, 200);
    }) as typeof fetch;
    await fetchWithRetry('https://example.test/api', { method: 'POST' }, { fetchFn, sleep: noDelay });
    assert.deepEqual(seenUrls, ['https://example.test/api', 'https://example.test/api']);
    assert.deepEqual(seenMethods, ['POST', 'POST']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
