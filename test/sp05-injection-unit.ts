#!/usr/bin/env tsx
/**
 * sp05-injection-unit.ts — SP-05 substrate query-injection regressions.
 *
 * Proves the four injection vectors closed by sprint SP-05 are neutralised:
 *
 *   1. Filter KEYS (column names) are run through an identifier allowlist
 *      in buildWhereClause. A malicious key like
 *      `id) DELETE n; --` throws instead of being interpolated raw — this
 *      is the worst vector (mass-delete via the DELETE path). Covered on
 *      the sqlite backend, across query/update/delete.
 *      Also covers CREATE TABLE column-name validation.
 *
 *   2. VerbatimStore.search() metadata filter VALUES are escaped + KEYS
 *      allowlisted. A value `a' OR '1'='1` cannot break out of the LanceDB
 *      WHERE literal (no clause injection: a row that doesn't match the
 *      literal stays excluded), and an unknown key is dropped, not injected.
 *
 *   3. verbatimHistory.listIds escapes LIKE wildcards (% _ \) + appends
 *      ESCAPE. A prefix of `%` matches NO ids literally (rather than every
 *      id), proving the wildcard is neutralised.
 *
 * Fast + deterministic: sqlite runs against a real on-disk DB (cheap);
 * the verbatim cases use a tiny constant-vector embedding provider so no
 * model loads.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteTableStorage } from '../packages/lore/src/engines/sqliteTableStorage.js';
import * as verbatimHistory from '../packages/lore/src/engines/verbatimHistory.js';
import type { TableSchema } from '../packages/lore/src/contracts/tables.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
// Opus review follow-up (item: excluded suites testing SEMANTICS, not Lance
// internals). The two VerbatimStore sections below are routed through
// makeVerbatimStore — filter-VALUE escaping and listIds() LIKE-wildcard
// escaping are engine-neutral concerns both engines must honor (SQLite via
// bound `?` parameters throughout; Lance via escapeSqlLiteral/
// escapeLikeWildcards on its string-interpolated filter API). A NEW,
// SQLite-specific section below closes the gap the review flagged as
// missing entirely: FTS5's MATCH operator applies its OWN query mini-
// language to the bound query STRING (binding protects against ordinary
// SQL injection, not against FTS5 syntax injection) — see
// escapeFts5Query() in sqliteVerbatimFts.ts, added in this same review pass.
import { makeVerbatimStore, SqliteVerbatimStore } from './helpers/testVerbatimStore.js';

let passed = 0;
let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

/** A malicious filter KEY that, if interpolated raw, would close the
 *  WHERE clause and append a destructive statement (mass delete). */
const EVIL_KEY = 'id) DELETE n; --';
/** A malicious metadata filter VALUE — classic SQL-style breakout. */
const EVIL_VALUE = "a' OR '1'='1";

const SCHEMA: TableSchema = {
    name: 'tenant',
    columns: [
        { name: 'id', type: 'string', primary: true },
        { name: 'name', type: 'string' },
    ],
};

/* ─────────────────────────── SQLite backend ─────────────────────────── */

function mkSqliteTmp(): { dbPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp05-sqlite-'));
    return {
        dbPath: path.join(dir, 'tables.sqlite'),
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } },
    };
}

test('sqlite: malicious filter KEY in delete() throws (no mass-delete)', async () => {
    const t = mkSqliteTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(SCHEMA);
        await s.insert('tenant', { id: 't1', name: 'Alice' });
        await s.insert('tenant', { id: 't2', name: 'Bob' });

        await assert.rejects(
            () => s.delete('tenant', { eq: { [EVIL_KEY]: 'x' } } as never),
            /invalid identifier/,
            'malicious filter key must be rejected, not interpolated',
        );
        // Rows survived — the injected DELETE never ran.
        assert.equal(await s.count('tenant'), 2, 'rows must be untouched after a rejected injection');
        s.close();
    } finally { t.cleanup(); }
});

test('sqlite: malicious filter KEY in query() throws', async () => {
    const t = mkSqliteTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(SCHEMA);
        await assert.rejects(
            () => s.query('tenant', { eq: { [EVIL_KEY]: 'x' } } as never),
            /invalid identifier/,
        );
        s.close();
    } finally { t.cleanup(); }
});

test('sqlite: malicious filter KEY in update() throws', async () => {
    const t = mkSqliteTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(SCHEMA);
        await s.insert('tenant', { id: 't1', name: 'Alice' });
        await assert.rejects(
            () => s.update('tenant', { eq: { [EVIL_KEY]: 'x' } } as never, { name: 'pwn' }),
            /invalid identifier/,
        );
        // Patch never applied.
        const row = await s.getByKey('tenant', 't1');
        assert.equal((row as { name?: string })?.name, 'Alice');
        s.close();
    } finally { t.cleanup(); }
});

test('sqlite: legitimate filter KEY still works (allowlist not over-broad)', async () => {
    const t = mkSqliteTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await s.createTable(SCHEMA);
        await s.insert('tenant', { id: 't1', name: 'Alice' });
        await s.insert('tenant', { id: 't2', name: 'Bob' });
        const rows = await s.query('tenant', { eq: { name: 'Alice' } });
        assert.equal(rows.length, 1);
        assert.equal((rows[0] as { id: string }).id, 't1');
        s.close();
    } finally { t.cleanup(); }
});

test('sqlite: CREATE TABLE rejects a malicious column name', async () => {
    const t = mkSqliteTmp();
    try {
        const s = new SqliteTableStorage(t.dbPath);
        await assert.rejects(
            () => s.createTable({
                name: 'evil',
                columns: [
                    { name: 'id', type: 'string', primary: true },
                    { name: 'x); DROP TABLE tenant; --', type: 'string' },
                ],
            }),
            /invalid identifier/,
        );
        s.close();
    } finally { t.cleanup(); }
});

/* ───────────────────── VerbatimStore search filter ──────────────────── */

/** Constant-vector embedder: avoids loading a real model. All documents +
 *  queries map to the same vector, so vectorSearch returns rows ordered
 *  only by the WHERE filter — exactly what we want to probe injection. */
class ConstEmbedProvider implements EmbeddingProvider {
    get modelId() { return 'sp05-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

test('verbatim: malicious filter VALUE cannot inject WHERE clause', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp05-verbatim-'));
    const store = makeVerbatimStore(tmp, new ConstEmbedProvider());
    try {
        await store.initialize();
        // Two rows in distinct projects. Neither project equals EVIL_VALUE.
        await store.store({
            id: 'v1', text: 'alpha', metadata: {
                type: 'note', label: 'A', tags: '', project: 'projA',
                ecosystem: '', updatedAt: '', security_scopes: [],
            },
        });
        await store.store({
            id: 'v2', text: 'bravo', metadata: {
                type: 'note', label: 'B', tags: '', project: 'projB',
                ecosystem: '', updatedAt: '', security_scopes: [],
            },
        });

        // If the value broke out of the literal (… OR '1'='1'), the filter
        // would match BOTH rows. Properly escaped, it matches NEITHER
        // (no project equals the literal string EVIL_VALUE).
        const injected = await store.search('alpha', 10, { project: EVIL_VALUE } as never);
        assert.equal(injected.length, 0, 'escaped value must match no rows, not all rows');

        // Sanity: a legitimate value still filters correctly.
        const legit = await store.search('alpha', 10, { project: 'projA' });
        assert.ok(legit.every(r => r.metadata.project === 'projA'),
            'legitimate project filter must still scope results');
        assert.ok(legit.length >= 1, 'legitimate filter must return the matching row');

        // An unknown filter key is dropped (allowlist), not injected.
        const unknownKey = await store.search('alpha', 10, { 'id = 1 OR 1=1 --': 'x' } as never);
        // Drops the bad key → behaves like no filter → returns rows.
        assert.ok(unknownKey.length >= 1, 'unknown filter key must be ignored, not crash/inject');
    } finally {
        await store.close().catch(() => undefined);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
});

/* ───────────────────── verbatimHistory.listIds LIKE ─────────────────── */

test('verbatim: listIds prefix LIKE wildcards are escaped (literal match)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp05-listids-'));
    const store = makeVerbatimStore(tmp, new ConstEmbedProvider());
    try {
        await store.initialize();
        for (const id of ['lore:1', 'lore:2', 'other:3']) {
            await store.store({
                id, text: id, metadata: {
                    type: 'note', label: id, tags: '', project: 'p',
                    ecosystem: '', updatedAt: '', security_scopes: [],
                },
            });
        }
        // Legit prefix scopes correctly.
        const lore = await store.listIds('lore:');
        assert.equal(lore.filter(id => !id.includes('#rev')).sort().join(','), 'lore:1,lore:2');

        // A bare '%' must be treated literally: NO id literally starts with
        // a percent sign, so the result is empty. Pre-fix it would have
        // matched every id (wildcard).
        const pct = await store.listIds('%');
        assert.equal(pct.length, 0, "'%' prefix must match literally (no wildcard expansion)");

        // '_' likewise literal — matches nothing.
        const underscore = await store.listIds('_');
        assert.equal(underscore.length, 0, "'_' prefix must match literally");
    } finally {
        await store.close().catch(() => undefined);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
});

/* ───────── SqliteVerbatimStore.bm25Search FTS5 MATCH injection ───────── */

/**
 * Opus review follow-up — dedicated SQLite suite (the review's own words:
 * "hostile ids, filter values, FTS5 query syntax like \", *, NEAR, -,
 * column filters — FTS5 MATCH input must be escaped/quoted so user text
 * can never be FTS query syntax"). Ids and filter VALUES are already
 * covered generically above (bound `?` parameters throughout
 * sqliteVerbatimWrite.ts/sqliteVerbatimHistory.ts neutralize them the same
 * way for every SQLite-backed table in this codebase) — what was missing
 * is FTS5-MATCH-SPECIFIC syntax injection: `?`-binding protects against
 * ordinary SQL injection, but FTS5's MATCH operator parses its OWN
 * mini-language out of the bound STRING VALUE itself, so binding alone
 * does not neutralize it. This is deliberately SQLite-only: FTS5's syntax
 * (NEAR(), column filters, bareword AND/OR/NOT, trailing `*`) doesn't
 * exist on the Lance path, which uses a different (tantivy) query engine.
 */
/** Hostile ids for the SQLite FTS-backed store section below (a local set —
 *  the same class of payloads id-alphabet-roundtrip-unit.ts's HOSTILE_IDS
 *  battery uses, kept local to this file rather than imported across test
 *  files). */
const SQLITE_HOSTILE_IDS = [
    "evil:' OR '1'='1",
    'evil:"double"quote',
    'evil:\\back\\slash',
    'evil:100%_wild',
    "evil:'; DROP TABLE lore_verbatim; --",
    "evil:x' OR id LIKE 'evil:%",
];

test('sqlite bm25Search: hostile ids store + read back byte-identically through the FTS-backed store', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp05-sqlite-fts-ids-'));
    const store = new SqliteVerbatimStore(tmp, new ConstEmbedProvider());
    try {
        await store.initialize();
        for (const id of SQLITE_HOSTILE_IDS) {
            await store.store({ id, text: `payload of ${id}`, metadata: { type: 'note', label: id, tags: '', project: 'sec', ecosystem: '', updatedAt: '', security_scopes: [] } });
        }
        for (const id of SQLITE_HOSTILE_IDS) {
            const row = await store.getById(id);
            assert.ok(row, `getById must find ${JSON.stringify(id)}`);
            assert.equal(row.text, `payload of ${id}`, 'own text, unmangled (bound parameter, not string-interpolated)');
        }
    } finally {
        await store.close().catch(() => undefined);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
});

test('sqlite bm25Search: filter VALUE cannot inject the metadata WHERE clause', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp05-sqlite-fts-filter-'));
    const store = new SqliteVerbatimStore(tmp, new ConstEmbedProvider());
    try {
        await store.initialize();
        await store.store({ id: 'v1', text: 'alpha keyword search', metadata: { type: 'note', label: 'A', tags: '', project: 'projA', ecosystem: '', updatedAt: '', security_scopes: [] } });
        await store.store({ id: 'v2', text: 'bravo keyword search', metadata: { type: 'note', label: 'B', tags: '', project: 'projB', ecosystem: '', updatedAt: '', security_scopes: [] } });
        const injected = await store.bm25Search('alpha', 10, { project: EVIL_VALUE } as never);
        assert.equal(injected.hits.length, 0, 'escaped filter value must match no rows via bm25Search either');
        const legit = await store.bm25Search('alpha', 10, { project: 'projA' });
        assert.ok(legit.hits.length >= 1 && legit.hits.every((h) => h.metadata.project === 'projA'), 'legitimate project filter still scopes bm25Search results');
    } finally {
        await store.close().catch(() => undefined);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
});

test('sqlite bm25Search: FTS5 query-syntax operators in user text are neutralized, never parsed as operators', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp05-sqlite-fts-syntax-'));
    const store = new SqliteVerbatimStore(tmp, new ConstEmbedProvider());
    try {
        await store.initialize();
        // Opus review follow-up #3: escapeFts5Query() joins tokens with
        // ` OR ` (matching Lance's default MatchQuery OR semantics — see
        // sqliteVerbatimFts.ts's doc comment), NOT AND. So a query like
        // 'fox OR dog' or 'fox AND dog' is now SUPPOSED to find both d1
        // (fox) and d2 (dog) — that is the correct, intended parity
        // behavior, not an injection. What "neutralized, never parsed as
        // an operator" actually means here: the word "OR"/"AND"/"NEAR" in
        // the query is just one more literal term in that OR list, never a
        // SECOND, NESTED operator that changes how the surrounding terms
        // combine — proven by d1 (fox, no "dog") still matching a query
        // containing the word "AND" between fox and dog (a real AND
        // operator would require BOTH present in the same row and exclude
        // d1); and a literal search for the bare word "or"/"near" finds
        // the doc that contains it as ordinary content (d5/d6), proving
        // the tokenizer/matcher never treats it as inert operator syntax
        // instead of searchable content.
        await store.storeBatch([
            { id: 'd1', text: 'the quick brown fox jumps over nothing', metadata: {} },
            { id: 'd2', text: 'a lazy dog sleeps all afternoon', metadata: {} },
            { id: 'd3', text: 'quotes " inside ordinary text are rare', metadata: {} },
            { id: 'd4', text: 'a column filter attempt: text:fox should not scope to a column', metadata: {} },
            { id: 'd5', text: 'the sign said or else you may not pass', metadata: {} },
            { id: 'd6', text: 'the station is quite near the old bridge', metadata: {} },
        ]);

        // 1. A real AND-proximity operator would require BOTH "fox" and
        //    "dog" in the SAME row — none of our rows have both, so if
        //    "AND"/"OR" were mis-parsed as anything other than one more
        //    literal OR'd term, this would find nothing (AND) or something
        //    other than the plain union (a misparsed operator). Under the
        //    correct OR-join, both queries find d1 (via "fox") and d2 (via
        //    "dog") regardless of which literal boolean word sits between
        //    them in the query text — "fox"/"or|and"/"dog" are each just
        //    one more whitespace-separated, individually-quoted token.
        for (const query of ['fox OR dog', 'fox AND dog']) {
            const env = await store.bm25Search(query, 10);
            assert.equal(env.ranked, true, `bm25Search(${JSON.stringify(query)}) must stay on the ranked native path`);
            const ids = env.hits.map((h) => h.id);
            assert.ok(ids.includes('d1'), `bm25Search(${JSON.stringify(query)}) must still find d1 (fox) — the literal operator word must not force an exclusionary AND (got ${JSON.stringify(ids)})`);
            assert.ok(ids.includes('d2'), `bm25Search(${JSON.stringify(query)}) must still find d2 (dog) via OR-term matching (got ${JSON.stringify(ids)})`);
        }

        // NEAR(fox dog, 5) tokenizes DIFFERENTLY from the two cases above:
        // "NEAR(fox" has no whitespace before the "(", so it's ONE
        // whitespace-split token, quoted as a single literal — which FTS5
        // then tokenizes (stripping the punctuation) into the two-word
        // PHRASE "near fox", requiring those tokens ADJACENT in matching
        // content. No row has "near" immediately followed by "fox", so
        // that clause alone contributes zero rows — verified empirically,
        // not assumed. The remaining OR'd clauses ("dog," -> "dog", "5)"
        // -> "5") still match d2 via plain term content. The property this
        // proves: the hostile clump is being tokenized and phrase-matched
        // like ordinary punctuated text, never dispatched to FTS5's REAL
        // `NEAR(x y, N)` proximity operator (which takes different,
        // unquoted syntax and would need "fox" and "dog" within 5 tokens
        // of each other in the SAME row — true of none of our rows either
        // way, so this alone doesn't distinguish the two; the phrase-only
        // "near fox" match failing is the actual proof).
        const nearEnv = await store.bm25Search('NEAR(fox dog, 5)', 10);
        assert.equal(nearEnv.ranked, true, 'NEAR(...) hostile query must stay on the ranked native path');
        const nearIds = nearEnv.hits.map((h) => h.id);
        assert.ok(nearIds.includes('d2'), `NEAR(...) hostile query must still find d2 (dog) via the "dog," OR-clause (got ${JSON.stringify(nearIds)})`);
        assert.ok(!nearIds.includes('d1'), `NEAR(...) hostile query must NOT find d1 via a bare "fox" match — "NEAR(fox" is a quoted "near fox" PHRASE clause, not a free "fox" term (got ${JSON.stringify(nearIds)})`);

        // 2. The literal words "or"/"and"/"near" are ordinary searchable
        //    CONTENT, not inert operator syntax that vanishes from a query.
        const orHit = await store.bm25Search('or', 10);
        assert.ok(orHit.hits.some((h) => h.id === 'd5'), 'a literal query for the word "or" must find the doc containing it as content');
        const nearHit = await store.bm25Search('near', 10);
        assert.ok(nearHit.hits.some((h) => h.id === 'd6'), 'a literal query for the word "near" must find the doc containing it as content');

        // 3. Structural hostility (crash/parse-error/injection) checks —
        //    still must never throw, still must stay on the ranked path,
        //    still must not silently rescope to a column or otherwise
        //    misbehave.
        const structural = [
            { query: 'text:fox', note: 'column-filter syntax must not crash or silently rescope' },
            { query: '"', note: 'a lone unbalanced quote must not throw / must not crash the query' },
            { query: 'fox" OR "1"="1', note: 'a quote-breakout payload must not throw' },
            { query: '""""', note: 'garbage repeated quotes must not throw' },
            { query: 'fox*', note: 'prefix-wildcard syntax must not crash (may literal-match "fox")' },
            { query: '-fox', note: 'a leading hyphen must not throw' },
        ];
        for (const { query, note } of structural) {
            let env: Awaited<ReturnType<typeof store.bm25Search>> | undefined;
            await assert.doesNotReject(async () => { env = await store.bm25Search(query, 10); }, `bm25Search(${JSON.stringify(query)}) must never throw — ${note}`);
            assert.equal(env!.ranked, true, `bm25Search(${JSON.stringify(query)}) must stay on the ranked native path — ${note}`);
        }
        // A column-filter attempt is treated as an ordinary PHRASE search
        // (quoting turns "text:fox" into one literal token, tokenized —
        // like any other punctuation — into adjacent "text"/"fox"
        // sub-tokens) rather than the FTS5 `column:term` operator. d4's
        // content genuinely contains "text:fox" adjacent, so the correct,
        // non-operator behavior is to find it as literal phrase content —
        // verified empirically (not assumed) — never via a real
        // column-scoping operator, which this single-column table has no
        // reason to expose either way.
        const colFilter = await store.bm25Search('text:fox', 10);
        assert.ok(colFilter.hits.some((h) => h.id === 'd4'), 'a literal "text:fox" query matches d4 as ordinary phrase content, not via a column-filter operator');

        // Sanity: ordinary multi-word free text still finds the doc
        // containing every term (fix is additive — OR-of-more-terms never
        // excludes a row that already matched every term).
        const legit = await store.bm25Search('quick fox', 10);
        assert.ok(legit.hits.some((h) => h.id === 'd1'), 'ordinary multi-word query still matches (fix is additive, not exclusionary)');
    } finally {
        await store.close().catch(() => undefined);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
    }
});

console.log('\n=== SP-05 substrate injection regressions ===\n');
await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
// Force a clean exit rather than wait on native-handle (LanceDB via
// VerbatimStore) GC teardown.
process.exit(failed > 0 ? 1 : 0);
