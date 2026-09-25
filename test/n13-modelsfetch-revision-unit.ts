#!/usr/bin/env tsx
/**
 * n13-modelsfetch-revision-unit.ts — N13 (3.23 final review).
 *
 * `lore models fetch-rerank --revision <rev>` passed `revision` straight
 * into `flattenRevisionDir()` (cli/commands/modelsFetch.ts), which joins it
 * onto `stagedModelDir` as a raw path segment (`path.join(stagedModelDir,
 * revision)`) — an unvalidated value like `../../etc` or an absolute path
 * could walk outside the staging directory. `--revision` is also forwarded
 * verbatim to `@huggingface/transformers`' `from_pretrained`.
 *
 * Fix: `validateRevision()` allowlists `/^[A-Za-z0-9._-]{1,64}$/` (real git
 * branch/tag/commit-sha shapes) and separately rejects any `..` substring.
 * This is a pure-function unit test of that validator — it deliberately
 * does NOT invoke `fetchRerankCommand` itself, since that path calls
 * `process.exit()` on a bad revision and requires network access to
 * proceed past validation, neither of which belongs in a unit test.
 */

import assert from 'node:assert/strict';
import { validateRevision } from '../packages/lore/src/cli/commands/modelsFetch.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

(async () => {
    console.log('N13 — modelsFetch.ts --revision validation');

    await test('accepts a plain branch name', () => {
        assert.equal(validateRevision('main'), true);
    });

    await test('accepts a full 40-char commit sha', () => {
        assert.equal(validateRevision('a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'), true);
    });

    await test('accepts a short commit sha', () => {
        assert.equal(validateRevision('a1b2c3d'), true);
    });

    await test('accepts a tag with dots and dashes', () => {
        assert.equal(validateRevision('v1.2.3-rc.1'), true);
    });

    await test('accepts a revision at exactly the 64-char cap', () => {
        assert.equal(validateRevision('a'.repeat(64)), true);
    });

    await test('rejects a revision over the 64-char cap', () => {
        assert.equal(validateRevision('a'.repeat(65)), false);
    });

    await test('rejects a relative path-traversal payload', () => {
        assert.equal(validateRevision('../../../etc/passwd'), false);
    });

    await test('rejects a bare ".."', () => {
        assert.equal(validateRevision('..'), false);
    });

    await test('rejects ".." embedded inside an otherwise-plausible revision', () => {
        assert.equal(validateRevision('main/../../etc'), false);
    });

    await test('rejects an absolute path', () => {
        assert.equal(validateRevision('/etc/passwd'), false);
    });

    await test('rejects a value containing a forward slash (not a flat identifier)', () => {
        assert.equal(validateRevision('refs/heads/main'), false);
    });

    await test('rejects a value containing a backslash', () => {
        assert.equal(validateRevision('a\\b'), false);
    });

    await test('rejects the empty string', () => {
        assert.equal(validateRevision(''), false);
    });

    await test('rejects whitespace', () => {
        assert.equal(validateRevision('main branch'), false);
    });

    await test('rejects shell-metacharacter injection attempts', () => {
        assert.equal(validateRevision('main; rm -rf /'), false);
        assert.equal(validateRevision('$(whoami)'), false);
        assert.equal(validateRevision('`whoami`'), false);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
})();
