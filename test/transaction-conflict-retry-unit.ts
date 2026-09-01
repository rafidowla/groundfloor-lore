#!/usr/bin/env tsx
/**
 * transaction-conflict-retry-unit.ts — withTransactionConflictRetry in
 * isolation, with an injected zero-delay backoffMs so the whole suite runs
 * near-instantly. This is the deterministic proof that used to be missing —
 * the original fix (bulkIngest.ts, 2026-08-13) was only provable by
 * re-running the real workload that broke it. These tests pin the retry
 * logic's actual behavior: which errors retry, how many attempts, and that
 * the backoff schedule receives the attempt sequence it's supposed to.
 */

import assert from 'node:assert/strict';
import { withTransactionConflictRetry, isTransactionConflictError } from '../packages/lore/src/engines/transactionConflictRetry.js';
import { log } from '../packages/lore/src/logger.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const noDelay = () => 0;
const conflictErr = () => new Error('Transaction conflict: Transaction write conflict. This transaction can be retried');

console.log('withTransactionConflictRetry');

await test('succeeds on the first try — no retry, fn called once', async () => {
    let calls = 0;
    const result = await withTransactionConflictRetry(async () => { calls++; return 'ok'; }, { backoffMs: noDelay });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
});

await test('retries a transaction-conflict error and succeeds once it clears', async () => {
    let calls = 0;
    const result = await withTransactionConflictRetry(async () => {
        calls++;
        if (calls < 4) throw conflictErr();
        return 'recovered';
    }, { backoffMs: noDelay });
    assert.equal(result, 'recovered');
    assert.equal(calls, 4);
});

await test('a non-conflict error is NOT retried — thrown immediately on attempt 1', async () => {
    let calls = 0;
    await assert.rejects(
        () => withTransactionConflictRetry(async () => { calls++; throw new Error('some other db error'); }, { backoffMs: noDelay }),
        /some other db error/,
    );
    assert.equal(calls, 1);
});

await test('exhausts maxAttempts on sustained conflict, then throws the conflict error (not swallowed)', async () => {
    let calls = 0;
    await assert.rejects(
        () => withTransactionConflictRetry(async () => { calls++; throw conflictErr(); }, { maxAttempts: 5, backoffMs: noDelay }),
        /Transaction conflict/,
    );
    assert.equal(calls, 5, 'exactly maxAttempts calls, not more, not fewer');
});

await test('custom maxAttempts=1 means no retry at all even for a conflict error', async () => {
    let calls = 0;
    await assert.rejects(
        () => withTransactionConflictRetry(async () => { calls++; throw conflictErr(); }, { maxAttempts: 1, backoffMs: noDelay }),
        /Transaction conflict/,
    );
    assert.equal(calls, 1);
});

await test('backoffMs receives the correct 1-based attempt sequence', async () => {
    const seenAttempts: number[] = [];
    let calls = 0;
    await assert.rejects(
        () => withTransactionConflictRetry(async () => { calls++; throw conflictErr(); }, {
            maxAttempts: 4,
            backoffMs: (attempt) => { seenAttempts.push(attempt); return 0; },
        }),
    );
    // 4 attempts total, but backoff is only consulted BEFORE a retry — i.e.
    // after attempts 1,2,3 (attempt 4 is the last, no further retry/backoff).
    assert.deepEqual(seenAttempts, [1, 2, 3]);
    assert.equal(calls, 4);
});

await test('the error match is case-insensitive ("TRANSACTION CONFLICT" still retries)', async () => {
    let calls = 0;
    const result = await withTransactionConflictRetry(async () => {
        calls++;
        if (calls < 2) throw new Error('TRANSACTION CONFLICT: retry me');
        return 'ok';
    }, { backoffMs: noDelay });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
});

await test('a non-Error thrown value (e.g. a bare string) is treated as non-matching, not a crash', async () => {
    let calls = 0;
    await assert.rejects(
        () => withTransactionConflictRetry(async () => { calls++; throw 'plain string failure'; }, { backoffMs: noDelay }),
    );
    assert.equal(calls, 1, 'non-Error throws are never retried, but must not crash the retry loop itself');
});

console.log('\nisTransactionConflictError');

await test('matches the real SurrealDB message', async () => {
    assert.equal(isTransactionConflictError(conflictErr()), true);
});

await test('does not match an unrelated error', async () => {
    assert.equal(isTransactionConflictError(new Error('workspace_not_found')), false);
});

await test('does not match a non-Error value', async () => {
    assert.equal(isTransactionConflictError({ some: 'object' }), false);
});

await test('retries log warn, not error; exhausted conflict logs error once', async () => {
    const warns: unknown[] = [];
    const errors: unknown[] = [];
    const origWarn = log.warn;
    const origError = log.error;
    log.warn = (m) => { warns.push(m); };
    log.error = (m) => { errors.push(m); };
    try {
        let calls = 0;
        await withTransactionConflictRetry(async () => {
            calls++;
            if (calls < 3) throw conflictErr();
            return 'ok';
        }, { backoffMs: noDelay });
        assert.equal(warns.length, 2);
        assert.equal(errors.length, 0);
        assert.match(String(warns[0]), /conflict on attempt 1/);

        warns.length = 0;
        await assert.rejects(
            () => withTransactionConflictRetry(async () => { throw conflictErr(); }, { maxAttempts: 3, backoffMs: noDelay }),
            /Transaction conflict/,
        );
        assert.equal(warns.length, 2);
        assert.equal(errors.length, 1);
        assert.match(String(errors[0]), /giving up after 3/);
    } finally {
        log.warn = origWarn;
        log.error = origError;
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
