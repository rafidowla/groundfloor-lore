#!/usr/bin/env tsx
/**
 * audit-bw1-token-store-unit.ts — re-audit 2026-06-25 backlog wave, token store.
 *
 *   BW-1a  ensureRegistry backs up a parseable-but-WRONG-VERSION registry
 *          instead of silently overwriting it with an empty one (token wipe).
 *   BW-1b  revokeByPrefix with a full plaintext revokes EXACTLY that token, not
 *          every sibling sharing the workspace-derived 12-char prefix.
 *   BW-1c  touchLastUsed throttles the per-request registry rewrite.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === path.join(process.env['HOME'] ?? '', '.groundfloor')) {
    TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-bw1-'));
    process.env['LORE_HOME'] = TEST_HOME;
}
process.env['NODE_ENV'] = 'test';

const t = await import('../packages/lore/src/auth/tokens.js');

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}

console.log('BW-1 — token-store hardening');

test('ensureRegistry backs up a wrong-version registry (no silent token wipe)', () => {
    t._resetForTests();
    const p = t.getRegistryPath();
    // A parseable JSON registry with the WRONG version + real entries.
    fs.writeFileSync(p, JSON.stringify({
        version: 999,
        entries: { abc: { hash: 'abc', prefix: 'lore_wsabcde', workspace: 'wsabcde', label: 'old', scopes: ['read'], createdAt: new Date().toISOString() } },
    }));
    t.reloadRegistry(); // triggers ensureRegistry
    const backups = fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith('registry.json.corrupt.'));
    assert.ok(backups.length >= 1, 'a wrong-version registry must be renamed aside (recoverable), not silently wiped');
});

test('revokeByPrefix(full plaintext) revokes exactly that token, not prefix-siblings', () => {
    t._resetForTests();
    const a = t.issueToken({ workspace: 'wsabcde', label: 'a', scopes: ['read'] });
    const b = t.issueToken({ workspace: 'wsabcde', label: 'b', scopes: ['read'] });
    assert.equal(a.record.prefix, b.record.prefix, 'precondition: siblings share the 12-char workspace prefix');
    const n = t.revokeByPrefix(a.token); // full plaintext — must NOT mass-revoke
    assert.equal(n, 1, 'exactly one token revoked');
    assert.notEqual(t.resolveByPlaintext(a.token).kind, 'ok', 'token A is revoked');
    assert.equal(t.resolveByPlaintext(b.token).kind, 'ok', 'sibling token B must NOT be mass-revoked');
});

test('RA2-33: per-token hash id is unique where the workspace prefix collides', () => {
    t._resetForTests();
    // 'development' is >= 9 chars, so prefix = gf_ + first 9 chars of the slug
    // is FULLY workspace-derived → identical for every token of this workspace.
    const a = t.issueToken({ workspace: 'development', label: 'a', scopes: ['read'] });
    const b = t.issueToken({ workspace: 'development', label: 'b', scopes: ['read'] });
    assert.equal(a.record.prefix, b.record.prefix,
        'precondition: same-workspace tokens share the 12-char (workspace-derived) prefix');
    // The principal id now used for the rate-limit bucket + audit label is
    // record.hash.slice(0,12); it must be DISTINCT per token (else one token's
    // burst starves the other's bucket + audit can't tell them apart).
    assert.notEqual(a.record.hash.slice(0, 12), b.record.hash.slice(0, 12),
        'per-token hash id must differ for distinct tokens of the same workspace');
});

test('RA2-24: registry mutation releases its lock; a stale lock is stolen', () => {
    t._resetForTests();
    const lockPath = t.getRegistryPath() + '.lock';
    // A normal mutation must not leave a lock behind.
    t.issueToken({ workspace: 'wsabcde', label: 'a', scopes: ['read'] });
    assert.ok(!fs.existsSync(lockPath), 'mutation must release the registry lock');

    // A stale lock (crashed holder, mtime well past STALE_MS) must be stolen so
    // a wedged lock can never deadlock token issuance.
    fs.writeFileSync(lockPath, '', { mode: 0o600 });
    const oldSec = (Date.now() - 60_000) / 1000;
    fs.utimesSync(lockPath, oldSec, oldSec);
    const r = t.issueToken({ workspace: 'wsabcde', label: 'b', scopes: ['read'] });
    assert.equal(t.resolveByPlaintext(r.token).kind, 'ok', 'mutation succeeds by stealing the stale lock');
    assert.ok(!fs.existsSync(lockPath), 'stale lock is removed after the mutation');
});

test('touchLastUsed throttles the registry rewrite within the window', () => {
    t._resetForTests();
    const a = t.issueToken({ workspace: 'wsabcde', label: 'a', scopes: ['read'] });
    const p = t.getRegistryPath();
    const hash = Object.keys(JSON.parse(fs.readFileSync(p, 'utf8')).entries)[0]!;
    const setLastUsed = (iso: string) => {
        const reg = JSON.parse(fs.readFileSync(p, 'utf8'));
        reg.entries[hash].lastUsedAt = iso;
        fs.writeFileSync(p, JSON.stringify(reg));
    };
    const readLastUsed = () => JSON.parse(fs.readFileSync(p, 'utf8')).entries[hash].lastUsedAt;

    // 30s ago = within the 60s window → touch must NOT rewrite.
    const within = new Date(Date.now() - 30_000).toISOString();
    setLastUsed(within);
    t.touchLastUsed(a.token);
    assert.equal(readLastUsed(), within, 'within window: lastUsedAt not rewritten (throttled)');

    // 2min ago = outside the window → touch SHOULD refresh.
    const stale = new Date(Date.now() - 120_000).toISOString();
    setLastUsed(stale);
    t.touchLastUsed(a.token);
    assert.notEqual(readLastUsed(), stale, 'outside window: lastUsedAt refreshed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
