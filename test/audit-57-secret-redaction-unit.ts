#!/usr/bin/env tsx
/**
 * audit-57-secret-redaction-unit.ts — regression for audit finding 5.7
 * (2026-08-17 functional-correctness audit, HIGH).
 *
 * Bug: secretScan.ts's generic `(api_key|secret|token|password|passwd)
 * \s*[:=]\s*<12+ chars>` pattern fired on ordinary code and config text
 * (`const token = crypto.randomBytes(...)`, `const apiKey = process.env.X`
 * — 15+ false positives against this repo's OWN source tree) on every
 * verbatim write, silently: the mangled text is what got embedded,
 * searched, and returned, and two genuinely-different writes that redacted
 * to the same '[REDACTED]' placeholder collapsed into a skip-identical
 * no-op (the second update silently discarded).
 *
 * Fix: the pattern set is restricted to VENDOR-SHAPE prefixes only
 * (sk-/AKIA/gh?_/xox?-/PEM) — the generic assignment-shape rule is dropped.
 * Defense in depth: VerbatimStore.store() now bypasses the skip-identical
 * short-circuit whenever redaction rewrote the text.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/audit-57-secret-redaction-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-audit57-'));
process.env['LORE_HOME'] = TEST_HOME;

import { redactSecrets } from '../packages/lore/src/security/secretScan.js';
import { computeContentHash } from '../packages/lore/src/engines/contentHash.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
        if (process.env['AUDIT57_DEBUG']) console.error((e as Error).stack);
        failed++;
    }
};

console.log('Audit 5.7 — secret redaction: vendor shapes only, no silent code mangling');

await test('ordinary code/config text is NOT rewritten (the repo\'s own patterns)', () => {
    const code = [
        "const token = crypto.randomBytes(32).toString('hex');",
        'const apiKey = process.env.LORE_OPENAI_API_KEY;',
        "const token = fs.readFileSync(tokenPath, 'utf-8').trim();",
        'token: deps.getAuthToken',
        'password = AAAAAAAAAAAAAA', // generic assignment — NOT a vendor shape
        'api_key: abcdef0123456789abcd', // generic assignment — NOT a vendor shape
    ];
    for (const line of code) {
        assert.equal(redactSecrets(line), line, `must not redact ordinary code: ${line}`);
    }
});

await test('vendor-shaped secrets ARE still redacted', () => {
    assert.equal(
        redactSecrets('key: sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'),
        'key: [REDACTED]',
    );
    assert.equal(
        redactSecrets('aws id AKIAIOSFODNN7EXAMPLE here'),
        'aws id [REDACTED] here',
    );
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----';
    assert.equal(redactSecrets(pem), '[REDACTED]');
});

await test('RAN repro: a code snippet round-trips byte-identical through VerbatimStore', async () => {
    const store = new VerbatimStore(path.join(TEST_HOME, 'ws-code'), new LocalEmbeddingProvider());
    await store.initialize();
    const snippet =
        "const token = crypto.randomBytes(32).toString('hex');\n" +
        'const apiKey = process.env.LORE_OPENAI_API_KEY;';
    await store.store({ id: 'lore:snippet', text: snippet, metadata: {} });
    const got = await store.getById('lore:snippet');
    assert.equal(got?.text, snippet, 'stored text must be byte-identical to input');
    // Integrity: with no caller-supplied hash, the stored contentHash must
    // describe the ACTUALLY stored text.
    assert.equal(got?.contentHash, computeContentHash(snippet));
    // Searchable: the identifiers survive redaction, so BM25 can find them.
    const bm25 = await store.bm25Search('crypto.randomBytes', 5);
    assert.ok(bm25.hits.some((h) => h.id === 'lore:snippet'),
        `code snippet must be findable; got [${bm25.hits.map((h) => h.id).join(', ')}]`);
});

await test('two distinct writes that redact alike do NOT collapse into a no-op', async () => {
    const store = new VerbatimStore(path.join(TEST_HOME, 'ws-redact'), new LocalEmbeddingProvider());
    await store.initialize();
    // Both inputs redact to the IDENTICAL string 'key: [REDACTED]'.
    await store.store({ id: 'lore:cfg', text: 'key: sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', metadata: {} });
    await store.store({ id: 'lore:cfg', text: 'key: sk-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', metadata: {} });
    // Pre-fix the second write was silently discarded (skip-identical saw
    // the same contentHash of the same redacted text). Now it must go
    // through: a history snapshot of the first row proves the rewrite ran.
    const history = await store.getHistory('lore:cfg');
    assert.ok(
        history.filter((h) => !h.isCanonical).length >= 1,
        'second distinct write must replace the canonical row (snapshot exists)',
    );
    const got = await store.getById('lore:cfg');
    assert.equal(got?.text, 'key: [REDACTED]');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
