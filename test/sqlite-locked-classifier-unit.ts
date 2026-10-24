#!/usr/bin/env tsx
/**
 * sqlite-locked-classifier-unit.ts - 3.35.3 (SQLITE-STALL fix item 2): the shared SQLite
 * lock-contention classifier, `isSqliteLockedError` (engines/graphShared/deleteOutcome.ts).
 *
 * It is the outbox replicator's `transientClassifier` for SQLite (outbox/wiring.ts) and the base of
 * the delete-retry classifier. Pins the real error shapes better-sqlite3 throws, what must NOT be
 * classed as a lock (constraint / corruption / readonly stay permanent), and that
 * `isSqliteTransientDeleteError` kept its historical behaviour (locks + `transaction conflict`).
 *
 * Run: npx tsx test/sqlite-locked-classifier-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';

import { isSqliteLockedError, isSqliteTransientDeleteError } from '../packages/lore/src/engines/graphShared/deleteOutcome.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}
const withCode = (code: string, message: string): Error => Object.assign(new Error(message), { code });

console.log('isSqliteLockedError');

test('a REAL better-sqlite3 lock error (second connection holds BEGIN EXCLUSIVE) is classified as locked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-locked-cls-'));
    const a = new Database(path.join(dir, 'x.sqlite'));
    const b = new Database(path.join(dir, 'x.sqlite'));
    try {
        a.pragma('journal_mode = WAL');
        a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
        b.pragma('busy_timeout = 20');
        a.exec('BEGIN EXCLUSIVE');
        let caught: unknown;
        try { b.prepare('INSERT INTO t (v) VALUES (?)').run('x'); } catch (err) { caught = err; }
        assert.ok(caught, 'the second connection must fail while the first holds the gate');
        assert.match((caught as { code?: string }).code ?? '', /^SQLITE_BUSY/);
        assert.equal(isSqliteLockedError(caught), true);
        assert.equal(isSqliteTransientDeleteError(caught), true);
        a.exec('ROLLBACK');
    } finally { a.close(); b.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SQLITE_BUSY / SQLITE_LOCKED and their extended codes are locked', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_RECOVERY', 'SQLITE_LOCKED_SHAREDCACHE']) {
        assert.equal(isSqliteLockedError(withCode(code, 'x')), true, code);
    }
});

test('the message alone is enough when there is no code (wrapped / re-thrown errors)', () => {
    assert.equal(isSqliteLockedError(new Error('database is locked')), true);
    assert.equal(isSqliteLockedError(new Error('database table is locked')), true);
    assert.equal(isSqliteLockedError(new Error('SqliteError: SQLITE_BUSY: cannot start a transaction')), true);
    assert.equal(isSqliteLockedError(new Error('SQLITE_LOCKED: database table is locked: verbatim')), true);
});

test('errors that must stay PERMANENT are not locked', () => {
    for (const e of [
        withCode('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed: verbatim.id'),
        withCode('SQLITE_CONSTRAINT_NOTNULL', 'NOT NULL constraint failed: verbatim.text'),
        withCode('SQLITE_CORRUPT', 'database disk image is malformed'),
        withCode('SQLITE_READONLY', 'attempt to write a readonly database'),
        withCode('SQLITE_FULL', 'database or disk is full'),
        withCode('SQLITE_ERROR', 'no such table: verbatim'),
        new Error('Cannot read properties of undefined'),
        new Error('connect ECONNREFUSED 127.0.0.1:2480'),
    ]) assert.equal(isSqliteLockedError(e), false, e.message);
});

test('a SQLite code decides alone: a non-lock code is permanent even if its message mentions a lock', () => {
    assert.equal(isSqliteLockedError(withCode('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE failed (database is locked by trigger)')), false);
    assert.equal(isSqliteLockedError(withCode('SQLITE_ERROR', 'SQLITE_BUSY mentioned in a user string')), false);
    assert.equal(isSqliteLockedError(withCode('SQLITE_CORRUPT', 'database table is locked')), false);
    // A lock code is locked regardless of the message wording.
    assert.equal(isSqliteLockedError(withCode('SQLITE_BUSY', 'something else entirely')), true);
    // A non-SQLite code (e.g. a Node errno) carries no SQLite verdict: the message fallback applies.
    assert.equal(isSqliteLockedError(withCode('EIO', 'database is locked')), true);
});

test('null / undefined / non-error values do not throw and are not locked', () => {
    for (const v of [null, undefined, 0, '', 'database is locked', {}, { code: 5 }, { message: 7 }]) {
        // A bare string has no .message/.code properties: only real error objects classify.
        assert.equal(isSqliteLockedError(v), false, String(v));
    }
});

console.log('isSqliteTransientDeleteError (behaviour preserved)');

test('still retries a historical `transaction conflict` and every lock; still rejects permanent errors', () => {
    assert.equal(isSqliteTransientDeleteError(new Error('Transaction conflict on commit')), true);
    assert.equal(isSqliteTransientDeleteError(withCode('SQLITE_BUSY', 'database is locked')), true);
    assert.equal(isSqliteTransientDeleteError(withCode('SQLITE_CONSTRAINT_UNIQUE', 'UNIQUE constraint failed')), false);
    // The outbox classifier does NOT inherit the delete path's `transaction conflict` rule.
    assert.equal(isSqliteLockedError(new Error('Transaction conflict on commit')), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
