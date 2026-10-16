#!/usr/bin/env tsx
/**
 * test/arcade-transient-errors-unit.ts - 3.35.0 (a)/(p): the shared ArcadeDB transient-error
 * classifier and the CME-aware retryIdempotentArcadeWrite.
 *
 * Bodies below are the REAL ones captured from ArcadeDB 26.7.1 (see arcadeTransientErrors.ts):
 * the same ConcurrentModificationException arrives as HTTP 500 from a sqlscript commit and HTTP 503
 * from a session commit, so the classifier must key on the body, never the status.
 *
 * Run: npx tsx test/arcade-transient-errors-unit.ts
 */
import assert from 'node:assert/strict';
import { ArcadeHttpError, retryIdempotentArcadeWrite } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import {
    isArcadeConcurrentModification, isArcadeUnreachable, isArcadeTransientReplayError, isArcadeConnectRefused, isArcadeCommitRecordNotFound,
} from '../packages/lore/src/engines/arcade/arcadeTransientErrors.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? String(e)}`); failed++; }
}

const CME_DETAIL = 'Concurrent modification on page PageId(file=47,num=3) (current v=12 expected v=11)';
const CME_500 = JSON.stringify({ error: 'Error on transaction commit', detail: CME_DETAIL, exception: 'com.arcadedb.exception.ConcurrentModificationException' });
const CME_503 = JSON.stringify({ error: 'Cannot execute command', detail: CME_DETAIL, exception: 'com.arcadedb.exception.ConcurrentModificationException' });
const DUP_409 = JSON.stringify({ error: 'Duplicated key', detail: 'Duplicated key [a] found on index Node[id]', exception: 'com.arcadedb.exception.DuplicatedKeyException' });
const PLAIN_500 = JSON.stringify({ error: 'Internal error', detail: 'boom', exception: 'java.lang.NullPointerException' });

const errno = (code: string): Error => Object.assign(new Error(`connect ${code} 127.0.0.1:2480`), { code });

console.log('classifier');
await test('sqlscript-commit CME (HTTP 500) is a concurrent modification and transient', () => {
    const e = new ArcadeHttpError(500, CME_500);
    assert.equal(isArcadeConcurrentModification(e), true);
    assert.equal(isArcadeUnreachable(e), false);
    assert.equal(isArcadeTransientReplayError(e), true);
});
await test('session-commit CME (HTTP 503) is a concurrent modification, NOT merely unreachable, and transient', () => {
    const e = new ArcadeHttpError(503, CME_503);
    assert.equal(isArcadeConcurrentModification(e), true);
    assert.equal(isArcadeUnreachable(e), false, 'a 503 carrying a CME body is a commit conflict, not an outage');
    assert.equal(isArcadeTransientReplayError(e), true);
});
await test('DuplicatedKey (HTTP 409) is neither', () => {
    const e = new ArcadeHttpError(409, DUP_409);
    assert.equal(isArcadeConcurrentModification(e), false);
    assert.equal(isArcadeUnreachable(e), false);
    assert.equal(isArcadeTransientReplayError(e), false);
});
await test('a plain 500 (any other exception) is permanent', () => {
    const e = new ArcadeHttpError(500, PLAIN_500);
    assert.equal(isArcadeTransientReplayError(e), false);
    assert.equal(isArcadeTransientReplayError(new ArcadeHttpError(500, 'not json at all')), false);
    assert.equal(isArcadeTransientReplayError(new ArcadeHttpError(400, PLAIN_500)), false);
});
await test('a non-JSON body that names the CME class still counts', () => {
    assert.equal(isArcadeConcurrentModification(new ArcadeHttpError(500, 'com.arcadedb.exception.ConcurrentModificationException: page')), true);
});
await test('a bare 502/503/504 (gateway or restart window) is unreachable', () => {
    for (const s of [502, 503, 504]) {
        const e = new ArcadeHttpError(s, 'upstream down');
        assert.equal(isArcadeUnreachable(e), true, String(s));
        assert.equal(isArcadeTransientReplayError(e), true, String(s));
    }
    assert.equal(isArcadeUnreachable(new ArcadeHttpError(500, 'x')), false);
});
await test('ECONNREFUSED / ECONNRESET / ENOTFOUND, bare, wrapped in a cause, or inside AggregateError.errors', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN']) {
        assert.equal(isArcadeTransientReplayError(errno(code)), true, code);
        assert.equal(isArcadeTransientReplayError(new Error('wrapper', { cause: errno(code) })), true, `${code} via cause`);
    }
    const agg = Object.assign(new Error('AggregateError'), { errors: [errno('ECONNREFUSED'), errno('ECONNREFUSED')] });
    assert.equal(isArcadeUnreachable(agg), true);
});
await test('a TIMEOUT / AbortError is NOT transient (the write may have committed)', () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const timeout = Object.assign(new Error('ArcadeDB request timed out'), { code: 'ETIMEDOUT' });
    assert.equal(isArcadeTransientReplayError(abort), false);
    assert.equal(isArcadeTransientReplayError(timeout), false);
    assert.equal(isArcadeTransientReplayError(new Error('socket hang up')), false);
});
await test('junk inputs never throw', () => {
    for (const v of [undefined, null, 0, 'str', {}, [], { status: 'x', body: 1 }]) {
        assert.equal(isArcadeTransientReplayError(v), false);
    }
});

console.log('\nretryIdempotentArcadeWrite');
await test('retries a 500 CME and returns the eventual success (the pre-3.35 bug: 500 was never retried)', async () => {
    let calls = 0;
    const out = await retryIdempotentArcadeWrite(async () => {
        calls++;
        if (calls <= 3) throw new ArcadeHttpError(500, CME_500);
        return 'ok';
    });
    assert.equal(out, 'ok');
    assert.equal(calls, 4);
});
await test('retries a 503 CME too', async () => {
    let calls = 0;
    const out = await retryIdempotentArcadeWrite(async () => { calls++; if (calls < 3) throw new ArcadeHttpError(503, CME_503); return 7; });
    assert.equal(out, 7);
    assert.equal(calls, 3);
});
await test('CME budget is bounded: gives up after 6 retries and rethrows the CME', async () => {
    let calls = 0;
    await assert.rejects(
        retryIdempotentArcadeWrite(async () => { calls++; throw new ArcadeHttpError(500, CME_500); }),
        (e: unknown) => e instanceof ArcadeHttpError && e.status === 500,
    );
    assert.equal(calls, 7, '1 try + 6 retries');
});
await test('does not retry a plain 500, a 409 DuplicatedKey or a 400', async () => {
    for (const err of [new ArcadeHttpError(500, PLAIN_500), new ArcadeHttpError(409, DUP_409), new ArcadeHttpError(400, 'bad')]) {
        let calls = 0;
        await assert.rejects(retryIdempotentArcadeWrite(async () => { calls++; throw err; }));
        assert.equal(calls, 1, `status ${err.status}`);
    }
});
await test('a bare 503 keeps the original two-retry budget', async () => {
    let calls = 0;
    await assert.rejects(retryIdempotentArcadeWrite(async () => { calls++; throw new ArcadeHttpError(503, 'down'); }));
    assert.equal(calls, 3, '1 try + 2 retries');
});

console.log('\nrefused connection (3.35.0 (r))');
const agg = (...codes: string[]): Error => Object.assign(new Error('AggregateError'), { errors: codes.map(errno) });
await test('isArcadeConnectRefused: ECONNREFUSED bare / via cause / on every AggregateError member; nothing else', () => {
    assert.equal(isArcadeConnectRefused(errno('ECONNREFUSED')), true);
    assert.equal(isArcadeConnectRefused(new Error('wrapper', { cause: errno('ECONNREFUSED') })), true);
    assert.equal(isArcadeConnectRefused(agg('ECONNREFUSED', 'ECONNREFUSED')), true);
    for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH']) assert.equal(isArcadeConnectRefused(errno(code)), false, code);
    assert.equal(isArcadeConnectRefused(agg('ECONNREFUSED', 'ECONNRESET')), false, 'a mixed aggregate is not provably a refusal');
    assert.equal(isArcadeConnectRefused(agg()), false);
    assert.equal(isArcadeConnectRefused(new ArcadeHttpError(503, 'down')), false);
    assert.equal(isArcadeConnectRefused(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), false);
    for (const v of [undefined, null, 0, 'ECONNREFUSED', {}]) assert.equal(isArcadeConnectRefused(v), false);
});
await test('retry: ECONNREFUSED once then success -> ok, 2 calls', async () => {
    let calls = 0;
    const out = await retryIdempotentArcadeWrite(async () => { calls++; if (calls === 1) throw errno('ECONNREFUSED'); return 'ok'; });
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
});
await test('retry: ECONNREFUSED inside an AggregateError (happy-eyeballs) is retried', async () => {
    let calls = 0;
    const out = await retryIdempotentArcadeWrite(async () => { calls++; if (calls === 1) throw agg('ECONNREFUSED', 'ECONNREFUSED'); return 'ok'; });
    assert.equal(out, 'ok');
    assert.equal(calls, 2);
});
await test('retry: a refusal shares the 502/503/504 budget (1 try + 2 retries), then the refusal is rethrown', async () => {
    let calls = 0;
    const refused = errno('ECONNREFUSED');
    await assert.rejects(retryIdempotentArcadeWrite(async () => { calls++; throw refused; }), (e) => e === refused);
    assert.equal(calls, 3);
    calls = 0;
    const mixed = await retryIdempotentArcadeWrite(async () => { calls++; if (calls === 1) throw errno('ECONNREFUSED'); if (calls === 2) throw new ArcadeHttpError(503, 'down'); return 'ok'; });
    assert.equal(mixed, 'ok');
    assert.equal(calls, 3);
});
await test('retry: ECONNRESET, EPIPE, a hang-up and a timeout are NOT retried (the request may have been sent)', async () => {
    const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    for (const err of [errno('ECONNRESET'), errno('EPIPE'), new Error('socket hang up'), new Error('[ArcadeHttp] request timeout after 30000ms'), abort, agg('ECONNREFUSED', 'ECONNRESET')]) {
        let calls = 0;
        await assert.rejects(retryIdempotentArcadeWrite(async () => { calls++; throw err; }));
        assert.equal(calls, 1, err.message);
    }
});

console.log('(A) commit-time RecordNotFoundException');
const RNF_COMMIT_500 = JSON.stringify({ error: 'Error on transaction commit', detail: 'Record #1:2907 not found', exception: 'com.arcadedb.exception.RecordNotFoundException' });
await test('the real commit-time RNF body (HTTP 500) is matched, also through a cause chain', () => {
    const e = new ArcadeHttpError(500, RNF_COMMIT_500);
    assert.equal(isArcadeCommitRecordNotFound(e), true);
    assert.equal(isArcadeCommitRecordNotFound(Object.assign(new Error('wrapped'), { cause: e })), true);
    assert.equal(isArcadeConcurrentModification(e), false, 'it is not a CME');
});
await test('RNF is matched NARROWLY: other status, other error text, other exception, non-JSON, a CME, or a non-HTTP error', () => {
    for (const e of [
        new ArcadeHttpError(404, RNF_COMMIT_500),
        new ArcadeHttpError(503, RNF_COMMIT_500),
        new ArcadeHttpError(500, JSON.stringify({ error: 'Internal error', detail: 'Record #1:2907 not found', exception: 'com.arcadedb.exception.RecordNotFoundException' })),
        new ArcadeHttpError(500, JSON.stringify({ error: 'Error on transaction commit', detail: 'x', exception: 'java.lang.NullPointerException' })),
        new ArcadeHttpError(500, 'Error on transaction commit RecordNotFoundException (not json)'),
        new ArcadeHttpError(500, CME_500),
        new Error('RecordNotFoundException'),
        undefined, null,
    ]) assert.equal(isArcadeCommitRecordNotFound(e), false);
});
await test('the single-statement retryIdempotentArcadeWrite does NOT retry RNF (all-or-nothing was only proven for sqlscript commits)', async () => {
    let calls = 0;
    await assert.rejects(retryIdempotentArcadeWrite(async () => { calls++; throw new ArcadeHttpError(500, RNF_COMMIT_500); }));
    assert.equal(calls, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
