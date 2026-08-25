#!/usr/bin/env tsx
/**
 * audit-v1migration-no-shell-injection-unit.ts — deep-audit 2026-06-25
 * (MEDIUM, command injection).
 *
 * readV1Rows() shelled out via `execSync(\`sqlite3 -json ${JSON.stringify(path)}
 * ${JSON.stringify(query)}\`)`. JSON.stringify wraps the path in DOUBLE quotes,
 * but a POSIX shell still expands $(...) / backticks / ${} INSIDE double quotes —
 * so a v1-DB path supplied to `lore migrate v1-sqlite <path>` such as
 * `x$(touch INJ_PROOF).db` executed the embedded command as the operator.
 *
 * Fixed by switching to execFileSync('sqlite3', ['-json', path, query]): the
 * argv array is handed to the binary directly, no shell parses it.
 *
 * This test is valid whether or not the `sqlite3` CLI is installed: with the
 * old shell-string code the shell expands $(...) BEFORE invoking sqlite3, so
 * the marker would appear even if sqlite3 is missing. With execFileSync no
 * shell runs, so the marker never appears.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readV1Rows } from '../packages/lore/src/engines/v1Migration.js';

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('AUDIT v1Migration — readV1Rows must not let a malicious DB path inject a shell command');

test('a command-substitution path name does NOT execute (execFileSync, no shell)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-v1inject-'));
    const prevCwd = process.cwd();
    try {
        // chdir so an injected relative `touch INJ_PROOF` would land in `dir`
        // (filenames can't contain '/', so the payload must be relative).
        process.chdir(dir);
        const evilName = 'x$(touch INJ_PROOF).db';
        fs.writeFileSync(path.join(dir, evilName), ''); // 0-byte = valid empty sqlite db
        try {
            // With the new code this either returns rows or throws ENOENT (no
            // sqlite3) — both fine. What must NOT happen is the marker appearing.
            readV1Rows(evilName, 'SELECT 1');
        } catch { /* sqlite3 absent or errored on the odd filename — irrelevant */ }
        assert.ok(
            !fs.existsSync(path.join(dir, 'INJ_PROOF')),
            'INJ_PROOF marker created → a shell expanded $(touch ...) → injection still live',
        );
    } finally {
        process.chdir(prevCwd);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
