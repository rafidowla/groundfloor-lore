#!/usr/bin/env tsx
/**
 * nw7e-verbatimBatch-injection-unit.ts — NW-7e coverage gap:
 * test-verbatimBatch-escape-untested
 *
 * SQL-injection / predicate-breakout tests for the LanceDB where()-predicate
 * layer.
 *
 * DESIGN CHANGE (fix/id-alphabet-sql-interpolation, 2026-08-04): the guard
 * is no longer an alphabet allowlist that throws on dangerous chars. Every
 * interpolation site escapes (single-quote doubling on all values;
 * escapeLanceLike + ESCAPE '\' on LIKE values) — that escaping IS the
 * injection control, matching LanceDB 0.27.2's own toSQL helper (the filter
 * API has no bound parameters). assertSafeLanceId now rejects only what
 * escaping cannot make safe: non-string ids, oversized ids, NUL bytes.
 * This file's earlier "validators not quote-doubling" rationale feared a
 * DataFusion backslash-escape mode breaking the doubled-quote invariant;
 * that fear is retired by the round-trip + leakage proofs below — hostile
 * ids (quotes, backslashes, LIKE wildcards, classic payloads) are STORED
 * and then must resolve to exactly their own row and no other.
 *
 * Three layers tested:
 *   1. Validator unit tests — assertSafeLanceId / assertSafeLanceHash directly.
 *   2. bulkLookupByContentHash — unsafe hash throws at validator; safe hash resolves.
 *   3. getContentHashesByIds — hostile ids round-trip with zero cross-row
 *      leakage; NUL/oversized ids still throw loud (naming the id).
 *
 * Run: npx tsx test/nw7e-verbatimBatch-injection-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, Utf8, Float32, FixedSizeList } from 'apache-arrow';

import {
    bulkLookupByContentHash,
    getContentHashesByIds,
} from '../packages/lore/src/engines/verbatimBatch.js';
import type { VerbatimBatchCtx } from '../packages/lore/src/engines/verbatimBatch.js';
import { BoundedVectorCache } from '../packages/lore/src/engines/boundedVectorCache.js';
import {
    assertSafeLanceId,
    assertSafeLanceHash,
} from '../packages/lore/src/engines/verbatimHistory.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

// ── Setup: a real in-process LanceDB with a minimal verbatim schema ──

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nw7e-verbatim-injection-'));
const VECTOR_DIM = 4;

const verbatimSchema = new Schema([
    new Field('id', new Utf8(), false),
    new Field('contentHash', new Utf8(), false),
    new Field('text', new Utf8(), false),
    new Field('vector', new FixedSizeList(VECTOR_DIM, new Field('item', new Float32(), true)), false),
    new Field('workspace', new Utf8(), false),
    new Field('nodeId', new Utf8(), false),
]);

function makeZeroVec(): Float32Array {
    return new Float32Array(VECTOR_DIM).fill(0);
}

// Safe seed rows, plus HOSTILE-id rows added below via table.add — under the
// new design hostile ids are legitimate writes (the old alphabet rejected
// them at the door; now they must round-trip through escaped predicates).
const SEED_ROWS = [
    {
        id: 'normal-id',
        contentHash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
        text: 'Normal row',
        vector: makeZeroVec(),
        workspace: 'ws',
        nodeId: 'node-1',
    },
    {
        id: 'another-id',
        contentHash: 'def456abc123def456abc123def456abc123def456abc123def456abc123def4',
        text: 'Another row',
        vector: makeZeroVec(),
        workspace: 'ws',
        nodeId: 'node-2',
    },
];

/** Hostile ids: quote, classic payload, backslash, LIKE wildcards, and the
 *  Next.js dynamic-route brackets whose rejection was the original bug. */
const HOSTILE_ROWS = [
    "id-with-'quote",
    "') OR ('1'='1",
    'id-with-\\-backslash',
    '100%_wild',
    'next:apps/web/src/app/(app)/page.tsx',
    'next:src/app/[id]/route.ts',
].map((id, i) => ({
    id,
    contentHash: `hostile${i}def456abc123def456abc123def456abc123def456abc123def456abc${i}`.slice(0, 64).padEnd(64, '0'),
    text: `Hostile row ${i}`,
    vector: makeZeroVec(),
    workspace: 'ws',
    nodeId: `node-hostile-${i}`,
}));

let db: lancedb.Connection;
let table: lancedb.Table;

async function setup(): Promise<void> {
    db = await lancedb.connect(TMP_DIR);
    table = await db.createTable('lore_verbatim', SEED_ROWS);
    await table.add(HOSTILE_ROWS);
}

function makeCtx(): VerbatimBatchCtx {
    let _ftsFallbackWarned = false;
    return {
        get initialized() { return true; },
        get db() { return db; },
        get table() { return table; },
        set table(v) { /* no-op for test */ },
        get verbatimSchema() { return verbatimSchema; },
        get hashCache() { return new BoundedVectorCache(100); },
        get ftsFallbackWarned() { return _ftsFallbackWarned; },
        set ftsFallbackWarned(v) { _ftsFallbackWarned = v; },
        get lancedbPath() { return TMP_DIR; },
        bumpSearchEpoch() { /* no-op */ },
    };
}

// ── Section 1: assertSafeLanceId unit tests ────────────────────────────────

console.log('\n=== Section 1: assertSafeLanceId ===\n');

await test('accepts normal kebab-case id', () => {
    assert.doesNotThrow(() => assertSafeLanceId('decision:auth-flow-2026', 'test'));
});

await test('accepts lore: namespace id', () => {
    assert.doesNotThrow(() => assertSafeLanceId('lore:some-note', 'test'));
});

await test('accepts id with dots and underscores', () => {
    assert.doesNotThrow(() => assertSafeLanceId('type_name:v1.2.3', 'test'));
});

await test('accepts id with slash and at-sign', () => {
    assert.doesNotThrow(() => assertSafeLanceId('github:owner/repo@main', 'test'));
});

// ── The bug this branch fixes: Next.js dynamic-route ids must be accepted ──

await test('accepts Next.js route-group id (parentheses)', () => {
    assert.doesNotThrow(() => assertSafeLanceId('next:apps/web/src/app/(app)/page.tsx', 'test'));
});

await test('accepts Next.js dynamic-segment ids (brackets)', () => {
    assert.doesNotThrow(() => assertSafeLanceId('next:src/app/[id]/route.ts', 'test'));
    assert.doesNotThrow(() => assertSafeLanceId('next:src/app/[...slug]/page.tsx', 'test'));
});

// ── Chars the old alphabet rejected are now accepted: escaping (quote
//    doubling + LIKE-escape) is the injection control, not the alphabet.
//    Sections 3–4 prove these exact strings cannot break out of a predicate.

await test('accepts id with single-quote (escaping handles it)', () => {
    assert.doesNotThrow(() => assertSafeLanceId("id-with-'quote", 'test'));
});

await test('accepts id with backslash (LIKE-escape handles it)', () => {
    assert.doesNotThrow(() => assertSafeLanceId('id-with-\\-backslash', 'test'));
});

await test('accepts id with LIKE wildcards (% _)', () => {
    assert.doesNotThrow(() => assertSafeLanceId('100%_wild', 'test'));
});

await test('accepts classic SQL injection payload as a LITERAL id', () => {
    assert.doesNotThrow(() => assertSafeLanceId("') OR ('1'='1", 'test'));
});

// ── What still rejects: the three things escaping cannot make safe ──

await test('rejects id with NUL byte — loudly, naming the id', () => {
    assert.throws(
        () => assertSafeLanceId('id-with-\x00-null', 'test'),
        (err: Error) => {
            assert.match(err.message, /NUL byte/, 'reason must name NUL');
            assert.match(err.message, /id-with-\\u0000-null/, 'message must carry the id (JSON-escaped)');
            assert.match(err.message, /\[LanceFilter:test\]/, 'message must name the site');
            return true;
        },
    );
});

await test('rejects id exceeding max length — naming the id', () => {
    const longId = 'a'.repeat(513);
    assert.throws(
        () => assertSafeLanceId(longId, 'test'),
        (err: Error) => {
            assert.match(err.message, /too long/, 'reason must name length');
            assert.ok(err.message.includes('aaa'), 'message must carry a truncated id preview');
            return true;
        },
    );
});

await test('rejects non-string id — naming the value', () => {
    assert.throws(
        () => assertSafeLanceId(5 as unknown as string, 'test'),
        (err: Error) => {
            assert.match(err.message, /must be a string/, 'reason must name the type confusion');
            assert.ok(err.message.includes('5'), 'message must carry the offending value');
            return true;
        },
    );
});

await test('rejects empty id (old alphabet rejected it too)', () => {
    assert.throws(
        () => assertSafeLanceId('', 'test'),
        /non-empty/,
    );
});

// ── Section 2: assertSafeLanceHash unit tests ──────────────────────────────

console.log('\n=== Section 2: assertSafeLanceHash ===\n');

await test('accepts valid sha-256 hex hash', () => {
    assert.doesNotThrow(() =>
        assertSafeLanceHash('abc123def456abc123def456abc123def456abc123def456abc123def456abc1', 'test'),
    );
});

await test('rejects hash with uppercase hex', () => {
    assert.throws(
        () => assertSafeLanceHash('ABC123', 'test'),
        /lowercase hex/,
    );
});

await test('rejects hash with single-quote', () => {
    assert.throws(
        () => assertSafeLanceHash("abc'def", 'test'),
        /lowercase hex/,
    );
});

await test('rejects hash with injection payload', () => {
    assert.throws(
        () => assertSafeLanceHash("') OR ('1'='1", 'test'),
        /lowercase hex/,
    );
});

await test('rejects hash exceeding max length', () => {
    assert.throws(
        () => assertSafeLanceHash('a'.repeat(129), 'test'),
        /too long/,
    );
});

// ── Section 3: bulkLookupByContentHash integration ────────────────────────

console.log('\n=== Section 3: bulkLookupByContentHash ===\n');

await setup();
const ctx = makeCtx();

await test('normal hex hash lookup works', async () => {
    const hash = SEED_ROWS[0].contentHash;
    const result = await bulkLookupByContentHash(ctx, [hash]);
    assert.ok(result.has(hash), 'safe hex hash must be found');
});

await test('empty hash list returns empty map', async () => {
    const result = await bulkLookupByContentHash(ctx, []);
    assert.equal(result.size, 0);
});

await test('hash with single-quote throws before reaching LanceDB', async () => {
    await assert.rejects(
        async () => bulkLookupByContentHash(ctx, ["abc'def"]),
        /lowercase hex/,
    );
});

await test('injection payload throws before reaching LanceDB (not a parse error)', async () => {
    await assert.rejects(
        async () => bulkLookupByContentHash(ctx, ["') OR ('1'='1"]),
        /lowercase hex/,
    );
});

// ── Section 4: getContentHashesByIds integration ───────────────────────────

console.log('\n=== Section 4: getContentHashesByIds ===\n');

await test('normal id lookup works', async () => {
    const result = await getContentHashesByIds(ctx, ['normal-id']);
    assert.ok(result.has('normal-id'), 'safe id must be found');
    assert.equal(result.get('normal-id'), SEED_ROWS[0].contentHash);
});

await test('empty id list returns empty map', async () => {
    const result = await getContentHashesByIds(ctx, []);
    assert.equal(result.size, 0);
});

// ── Round-trip + leakage proofs: every hostile id resolves to EXACTLY its
//    own row through the chunked `id IN (...)` predicate, and nothing else.
//    If escaping were broken (quote-doubling defeated, wildcards live), the
//    payload id would match every row or the map would hold foreign hashes.

await test('single-quote id round-trips through id IN (...) to its own row only', async () => {
    const id = "id-with-'quote";
    const result = await getContentHashesByIds(ctx, [id]);
    assert.equal(result.size, 1, 'exactly one id must resolve — no breakout, no drop');
    assert.equal(result.get(id), HOSTILE_ROWS[0].contentHash, 'must resolve to its OWN hash');
});

await test('classic injection payload id matches its own row only (no OR 1=1 leak)', async () => {
    const id = "') OR ('1'='1";
    const result = await getContentHashesByIds(ctx, [id]);
    assert.equal(result.size, 1, "payload must NOT widen the match (OR '1'='1 would return all rows)");
    assert.equal(result.get(id), HOSTILE_ROWS[1].contentHash);
});

await test('backslash id round-trips byte-identically', async () => {
    const id = 'id-with-\\-backslash';
    const result = await getContentHashesByIds(ctx, [id]);
    assert.equal(result.size, 1, 'backslash id must match exactly one row');
    assert.equal(result.get(id), HOSTILE_ROWS[2].contentHash);
});

await test('LIKE-wildcard id (% _) is literal in the equality/IN path', async () => {
    const id = '100%_wild';
    const result = await getContentHashesByIds(ctx, [id]);
    assert.equal(result.size, 1, 'wildcards must not widen the IN match');
    assert.equal(result.get(id), HOSTILE_ROWS[3].contentHash);
});

await test('Next.js bracketed ids round-trip through id IN (...)', async () => {
    const ids = ['next:apps/web/src/app/(app)/page.tsx', 'next:src/app/[id]/route.ts'];
    const result = await getContentHashesByIds(ctx, ids);
    assert.equal(result.size, 2, 'both bracketed ids must resolve');
    assert.equal(result.get(ids[0]), HOSTILE_ROWS[4].contentHash);
    assert.equal(result.get(ids[1]), HOSTILE_ROWS[5].contentHash);
});

await test('mixed chunk: hostile + normal ids each resolve to their own row', async () => {
    const result = await getContentHashesByIds(ctx, ['normal-id', "id-with-'quote", "') OR ('1'='1"]);
    assert.equal(result.size, 3, 'all three resolve, no cross-contamination');
    assert.equal(result.get('normal-id'), SEED_ROWS[0].contentHash);
    assert.equal(result.get("id-with-'quote"), HOSTILE_ROWS[0].contentHash);
    assert.equal(result.get("') OR ('1'='1"), HOSTILE_ROWS[1].contentHash);
});

await test('nonexistent hostile-shaped id resolves nothing (no accidental widening)', async () => {
    const result = await getContentHashesByIds(ctx, ["nope' OR '1'='1", 'zzz%']);
    assert.equal(result.size, 0, 'absent ids must match zero rows even when payload-shaped');
});

await test('NUL-byte id still throws before reaching LanceDB', async () => {
    await assert.rejects(
        async () => getContentHashesByIds(ctx, ['bad\x00id']),
        /NUL byte/,
    );
});

// ── Cleanup ──

try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }

// ── Summary ──

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
