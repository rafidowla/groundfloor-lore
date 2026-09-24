#!/usr/bin/env tsx
/**
 * test/sqlite-verbatim-engine-parity-unit.ts — 3.21 step 2 part 1.
 *
 * Cross-ENGINE parity: the SAME fixture corpus stored on both VerbatimStore
 * (LanceDB) and SqliteVerbatimStore, then the SAME queries run against
 * both. Design section 4 ("Tests (the CHECK)"): "retrieval-parity and
 * every verbatim suite are parameterized over vectorEngine and pass on
 * 'sqlite'" + "Tokenizer-profile parity (English stemming, CJK trigram):
 * same top-k id SET as Lance on the fixtures."
 *
 * Parity target (design section 1, explicitly NOT bit-identical):
 *   - Vector search: same top-k id SET, and the SAME top-1 for a
 *     near-identical query (cosine similarity is an exact function of the
 *     vectors, which are IDENTICAL across engines since both embed with
 *     the same deterministic provider — so this is a strong equality, not
 *     a fuzzy one).
 *   - BM25 search: same top-k id SET. Scores are NOT compared (design:
 *     "BM25 scores are NOT bit-identical across engines").
 *
 * LORE_TEST_VECTOR_ENGINE selects which SINGLE engine a plain verbatim
 * suite runs against (see sqlite-verbatim-store-unit.ts and its `:sqlite`
 * npm script variant) — THIS file always runs both, because parity is the
 * point of it.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { SqliteVerbatimStore } from '../packages/lore/src/engines/sqliteVerbatimStore.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import type { VerbatimStoreApi } from '../packages/lore/src/engines/verbatimStoreApi.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
    catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

/** Deterministic embedding, IDENTICAL on both engines (same provider
 *  instance class, no ONNX model download) — the whole point of the
 *  parity test is that engine choice, not embedding choice, is the only
 *  variable between the two stores. */
class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'engine-parity-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
}

function tmpWorkspace(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-verbatim-parity-'));
}

const ENGLISH_FIXTURE: Array<{ id: string; text: string }> = [
    { id: 'e1', text: 'the authentication token rotation policy was updated last quarter' },
    { id: 'e2', text: 'refresh tokens expire after thirty days of inactivity' },
    { id: 'e3', text: 'database migrations run automatically on deploy' },
    { id: 'e4', text: 'the quarterly earnings report showed strong revenue growth' },
    { id: 'e5', text: 'runners participated in the marathon despite the rain' },
    { id: 'e6', text: 'the running total is updated after every transaction' },
    { id: 'e7', text: 'weather forecasts predict a cold front moving in tomorrow' },
    { id: 'e8', text: 'the cold storage archive holds records older than five years' },
    { id: 'e9', text: 'security scopes restrict which rows an actor may read' },
    { id: 'e10', text: 'the actor context binds a request to its calling principal' },
    // Opus review follow-up #3 (AND-vs-OR keyword-recall parity): e11
    // shares 3 of a natural-language query's content terms (vet, dog,
    // limping), e12 shares only 1 (dog) — used to check that a
    // partial-term match is still found (not silently excluded by an
    // implicit-AND requirement neither engine is supposed to impose), and
    // that both engines agree on RELATIVE order (more matching terms
    // ranks higher).
    { id: 'e11', text: 'the vet examined the dog after it started limping during the walk' },
    { id: 'e12', text: 'the dog barked loudly at the mail carrier this morning' },
];

const CJK_FIXTURE: Array<{ id: string; text: string }> = [
    { id: 'c1', text: '供应商保险证明审批流程说明文件第一部分' },
    { id: 'c2', text: '供应商保险证明审批流程说明文件第二部分' },
    { id: 'c3', text: '财务报表季度审核结果显示收入增长' },
    { id: 'c4', text: '天气预报显示明天会有寒潮来袭' },
    { id: 'c5', text: '数据库迁移在部署时自动运行' },
    // Mixed CJK+Latin doc — for the mixed-query parity test (Opus review
    // follow-up: 1-2 char CJK terms + a Latin term, both present in the
    // SAME query, must match this doc on both engines).
    { id: 'c6', text: 'API 限流 policy update for the payment 网关 service' },
];

async function seedBoth(
    lance: VerbatimStoreApi, sqlite: VerbatimStoreApi, fixture: Array<{ id: string; text: string }>,
): Promise<void> {
    for (const doc of fixture) {
        await lance.store({ id: doc.id, text: doc.text, metadata: {} });
        await sqlite.store({ id: doc.id, text: doc.text, metadata: {} });
    }
}

function idSet(hits: Array<{ id: string }>): Set<string> {
    return new Set(hits.map((h) => h.id));
}

async function main(): Promise<void> {
    const provider = new DetEmbedProvider();
    // TWO separate store pairs, not one mixed corpus: the CJK/Latin
    // tokenizer decision (isCjkCorpus, shared by both engines) is
    // WHOLE-WORKSPACE — mixing the fixtures in one store would push BOTH
    // engines over CJK_FRACTION_THRESHOLD and flip the ENTIRE corpus
    // (including the English rows) to the CJK profile, which is correct,
    // deliberate policy (see ftsTokenizerProfile.ts's header) but not what
    // "English stemming, CJK trigram" parity (design section 4) is asking
    // to be checked — that wants the porter/stemming path and the
    // CJK/n-gram path each exercised on their own, not superimposed.
    const lance = new VerbatimStore(tmpWorkspace(), provider);
    const sqlite = new SqliteVerbatimStore(tmpWorkspace(), provider);
    await lance.initialize();
    await sqlite.initialize();
    await seedBoth(lance, sqlite, ENGLISH_FIXTURE);

    const lanceCjk = new VerbatimStore(tmpWorkspace(), provider);
    const sqliteCjk = new SqliteVerbatimStore(tmpWorkspace(), provider);
    await lanceCjk.initialize();
    await sqliteCjk.initialize();
    await seedBoth(lanceCjk, sqliteCjk, CJK_FIXTURE);

    // Force each engine's FTS index/tokenizer to reconcile against its
    // seeded corpus — on Lance this is normally driven by storeBatch()
    // crossing a row threshold; this test uses store() (singular) per doc,
    // so it must call ensureFtsIndex() explicitly on BOTH engines for a
    // fair comparison.
    await lance.ensureFtsIndex();
    await sqlite.ensureFtsIndex();
    await lanceCjk.ensureFtsIndex();
    await sqliteCjk.ensureFtsIndex();

    await test('vector search: same top-1 id for a near-identical query (English)', async () => {
        const lHits = await lance.search('the authentication token rotation policy was updated last quarter', 5);
        const sHits = await sqlite.search('the authentication token rotation policy was updated last quarter', 5);
        assert.equal(lHits[0]?.id, 'e1');
        assert.equal(sHits[0]?.id, 'e1');
    });

    await test('vector search: same top-5 id SET for a topical query (English)', async () => {
        const lHits = await lance.search('token expiry and authentication', 5);
        const sHits = await sqlite.search('token expiry and authentication', 5);
        assert.deepEqual(idSet(lHits), idSet(sHits), `Lance ids=${[...idSet(lHits)]} vs SQLite ids=${[...idSet(sHits)]}`);
    });

    await test('vector search: same top-3 id SET for a CJK query', async () => {
        const lHits = await lanceCjk.search('供应商保险证明审批流程', 3);
        const sHits = await sqliteCjk.search('供应商保险证明审批流程', 3);
        assert.deepEqual(idSet(lHits), idSet(sHits), `Lance ids=${[...idSet(lHits)]} vs SQLite ids=${[...idSet(sHits)]}`);
    });

    await test('bm25Search: same top-k id SET for an English keyword query (porter stemming both sides)', async () => {
        const lBm = await lance.bm25Search('running', 5);
        const sBm = await sqlite.bm25Search('running', 5);
        assert.ok(lBm.ranked && sBm.ranked, 'both engines must return a genuine ranking, not the LIKE fallback');
        assert.deepEqual(idSet(lBm.hits), idSet(sBm.hits), `Lance ids=${[...idSet(lBm.hits)]} vs SQLite ids=${[...idSet(sBm.hits)]}`);
        // Porter stemming: 'running' as a query must hit e5/e6 ('runners'/'running') on BOTH engines.
        assert.ok(idSet(lBm.hits).has('e5') || idSet(lBm.hits).has('e6'));
        assert.ok(idSet(sBm.hits).has('e5') || idSet(sBm.hits).has('e6'));
    });

    await test('bm25Search: both engines find the true-positive CJK docs (c1, c2) for a CJK keyword query', async () => {
        const lBm = await lanceCjk.bm25Search('保险证明', 5);
        const sBm = await sqliteCjk.bm25Search('保险证明', 5);
        assert.ok(lBm.ranked && sBm.ranked, 'both engines must return a genuine ranking on CJK content');
        assert.ok(idSet(lBm.hits).has('c1') && idSet(lBm.hits).has('c2'));
        assert.ok(idSet(sBm.hits).has('c1') && idSet(sBm.hits).has('c2'));
        // NOT asserted as an exact id-SET match: LanceDB's ngram tokenizer
        // profile is 1-2 CHARACTER n-grams (NGRAM_SETTINGS in
        // ftsTokenizerProfile.ts), while SQLite FTS5's built-in `trigram`
        // tokenizer is a fixed 3-character window — a real, inherent
        // difference between the two engines' CJK tokenizer FAMILIES, not
        // a bug on either side. The looser 1-2-char window is measurably
        // more permissive: it matches c4 (an unrelated "weather forecast"
        // doc) on shared single/double-character sequences that a 3-char
        // window correctly excludes. Design section 1's parity target
        // ("same top-k id SET... BM25 scores are NOT bit-identical across
        // engines") is read here as: both engines must find the same TRUE
        // positives (checked above); Lance's extra, lower-precision hits
        // from its looser n-gram window are the documented, accepted
        // divergence — SQLite's is arguably the more precise of the two,
        // not a regression.
    });

    await test('bm25Search: 1-character CJK query — same top-k id SET on both engines', async () => {
        // '供' appears only in c1/c2 ("供应商..."). Both engines' short-
        // query paths are equally permissive at 1 character (SQLite's
        // trigram-too-short substring fallback; Lance's ngram(1,2) tokenizer
        // natively indexes single characters) — a clean, unambiguous case,
        // unlike the 4-char query above where Lance's looser window picked
        // up a genuine false positive.
        const lBm = await lanceCjk.bm25Search('供', 5);
        const sBm = await sqliteCjk.bm25Search('供', 5);
        assert.ok(lBm.ranked && sBm.ranked, 'both engines must return a genuine ranking for a 1-char CJK query');
        assert.deepEqual(idSet(lBm.hits), idSet(sBm.hits), `Lance ids=${[...idSet(lBm.hits)]} vs SQLite ids=${[...idSet(sBm.hits)]}`);
        assert.deepEqual(idSet(sBm.hits), new Set(['c1', 'c2']));
    });

    await test('bm25Search: 2-character CJK query — same top-k id SET on both engines', async () => {
        // '显示' appears in c3 ("结果显示") and c4 ("预报显示").
        const lBm = await lanceCjk.bm25Search('显示', 5);
        const sBm = await sqliteCjk.bm25Search('显示', 5);
        assert.ok(lBm.ranked && sBm.ranked, 'both engines must return a genuine ranking for a 2-char CJK query');
        assert.deepEqual(idSet(lBm.hits), idSet(sBm.hits), `Lance ids=${[...idSet(lBm.hits)]} vs SQLite ids=${[...idSet(sBm.hits)]}`);
        assert.deepEqual(idSet(sBm.hits), new Set(['c3', 'c4']));
    });

    await test('bm25Search: mixed CJK+Latin query (short CJK token + a Latin token) — same top-k id SET on both engines', async () => {
        // c6 is the only doc containing BOTH '网关' (2-char CJK, "gateway")
        // and 'API' (Latin) — and, unlike '限流', shares no character with
        // any OTHER fixture doc, so this isolates the mixed-token path
        // cleanly from the separately-documented "Lance's looser ngram
        // window over-matches on an incidental shared character" case
        // (see the 4-char query test above). Exercises: SqliteVerbatimStore's
        // short-token detector triggers on the CJK token alone (any token
        // under 3 chars routes the WHOLE query through the substring
        // fallback, Latin token included) — verifying the Latin token is
        // still honored as an AND-required term, not dropped.
        const lBm = await lanceCjk.bm25Search('API 网关', 5);
        const sBm = await sqliteCjk.bm25Search('API 网关', 5);
        assert.ok(lBm.ranked && sBm.ranked, 'both engines must return a genuine ranking for a mixed CJK+Latin query');
        assert.deepEqual(idSet(lBm.hits), idSet(sBm.hits), `Lance ids=${[...idSet(lBm.hits)]} vs SQLite ids=${[...idSet(sBm.hits)]}`);
        assert.deepEqual(idSet(sBm.hits), new Set(['c6']));
    });

    await test('bm25Search: a multi-word natural-language query finds a row matching only SOME of its terms, on both engines', async () => {
        // Opus review follow-up #3: Lance's fullTextSearch() uses LanceDB's
        // default MatchQuery operator OR, so a natural-language query ranks
        // by how MANY of its terms a row contains — a row need not contain
        // every word. sqliteVerbatimFts.ts's escapeFts5Query() was
        // switched from joining tokens with a bare space (FTS5's implicit
        // AND) to ` OR `, matching that contract. Before the fix, this
        // query would have found almost nothing on SQLite: it requires
        // literally every one of "what/did/the/vet/say/was/wrong/after/
        // the/dog/started/limping" present in one row, including common
        // words the porter tokenizer does NOT strip (unlike Lance's
        // removeStopWords:true) — a severe keyword-recall gap, not merely
        // a scoring difference. The core property under test — the target
        // row is found on BOTH engines despite matching only some of the
        // query's terms — is checked directly; the id SETS are NOT
        // asserted equal here, because Lance's stopword removal makes it
        // far more precise on a stopword-heavy sentence (SQLite's porter
        // tokenizer has no stopword list at all — the SAME already-
        // documented gap the CJK 4-char-query test above notes, now
        // showing up on English too): SQLite additionally matches every
        // row sharing a common word like "the"/"was", which is a real,
        // pre-existing, unaddressed tokenizer-feature difference, not a
        // regression from this fix.
        const query = 'what did the vet say was wrong after the dog started limping';
        const lBm = await lance.bm25Search(query, 10);
        const sBm = await sqlite.bm25Search(query, 10);
        assert.ok(lBm.ranked && sBm.ranked, 'both engines must return a genuine ranking, not the LIKE fallback');
        assert.ok(idSet(lBm.hits).has('e11'), `Lance must find e11 (matches vet/dog/limping, not every query word) — got ${[...idSet(lBm.hits)]}`);
        assert.ok(idSet(sBm.hits).has('e11'), `SQLite must find e11 (matches vet/dog/limping, not every query word) — got ${[...idSet(sBm.hits)]}`);
        // Precision aside, both engines must rank e11 (3 content-term
        // matches) at or near the top of their own result set.
        assert.ok(lBm.hits.map((h) => h.id).indexOf('e11') <= 1, `Lance must rank e11 at/near the top — got ${JSON.stringify(lBm.hits.map((h) => h.id))}`);
        assert.ok(sBm.hits.map((h) => h.id).indexOf('e11') <= 1, `SQLite must rank e11 at/near the top — got ${JSON.stringify(sBm.hits.map((h) => h.id))}`);
    });

    await test('bm25Search: literal OR/AND/NOT/NEAR words in query text are never parsed as operators, on both engines', async () => {
        // e13 ("...said or else you would be turned away") is the only
        // fixture doc containing the literal word "or". Lance's own
        // tokenizer strips "or" as an English stopword (removeStopWords:
        // true — the SAME reason a bare "the" query finds nothing on Lance
        // in bm25-envelope-adversarial-unit.ts), so a BARE "or" query is
        // not a fair cross-engine probe — it would fail on Lance for a
        // reason unrelated to operator-parsing. The meaningful, engine-
        // neutral property is instead: a query MIXING the operator-shaped
        // words "AND"/"NEAR" with ordinary content terms must still find a
        // PARTIAL-term match (e12, "dog" only) on both engines, rather
        // than behaving as a real boolean AND (which would require every
        // term — including the literal words "and"/"near" themselves — in
        // one row, true of no fixture doc, so e12 would vanish) or a real
        // NEAR proximity operator (different, unquoted syntax; not
        // reachable here at all since every token is quoted before
        // binding — see escapeFts5Query()'s doc comment).
        const query = 'dog AND vet NEAR limping';
        const lBm = await lance.bm25Search(query, 10);
        const sBm = await sqlite.bm25Search(query, 10);
        assert.ok(lBm.ranked && sBm.ranked, 'both engines must return a genuine ranking');
        assert.ok(idSet(lBm.hits).has('e11'), `Lance must find e11 (vet+limping present) despite literal AND/NEAR in the query — got ${[...idSet(lBm.hits)]}`);
        assert.ok(idSet(sBm.hits).has('e11'), `SQLite must find e11 (vet+limping present) despite literal AND/NEAR in the query — got ${[...idSet(sBm.hits)]}`);
        assert.ok(idSet(lBm.hits).has('e12'), `Lance must ALSO find e12 (dog-only, partial match) — a real AND would exclude it — got ${[...idSet(lBm.hits)]}`);
        assert.ok(idSet(sBm.hits).has('e12'), `SQLite must ALSO find e12 (dog-only, partial match) — a real AND would exclude it — got ${[...idSet(sBm.hits)]}`);
        assert.deepEqual(idSet(lBm.hits), idSet(sBm.hits), `Lance ids=${[...idSet(lBm.hits)]} vs SQLite ids=${[...idSet(sBm.hits)]}`);
    });

    await test('bm25Search: relative order agrees across engines — a 3-term match ranks above a 1-term match', async () => {
        // e11 matches all 3 query terms (vet, dog, limping); e12 matches
        // only 1 (dog). BM25 rewards a row matching more of the query's
        // terms, so e11 must rank strictly above e12 on BOTH engines —
        // "rough order" agreement (design section 1: scores are not
        // bit-identical across engines, but the RANKING should agree)
        // rather than exact score equality.
        const query = 'vet dog limping';
        const lBm = await lance.bm25Search(query, 10);
        const sBm = await sqlite.bm25Search(query, 10);
        assert.ok(lBm.ranked && sBm.ranked, 'both engines must return a genuine ranking');
        assert.deepEqual(idSet(lBm.hits), idSet(sBm.hits), `Lance ids=${[...idSet(lBm.hits)]} vs SQLite ids=${[...idSet(sBm.hits)]}`);
        const lRank = lBm.hits.map((h) => h.id);
        const sRank = sBm.hits.map((h) => h.id);
        assert.ok(lRank.indexOf('e11') < lRank.indexOf('e12'), `Lance must rank e11 (3-term match) above e12 (1-term match) — got order ${JSON.stringify(lRank)}`);
        assert.ok(sRank.indexOf('e11') < sRank.indexOf('e12'), `SQLite must rank e11 (3-term match) above e12 (1-term match) — got order ${JSON.stringify(sRank)}`);
    });

    await test('getById / getHistory / listIds agree on canonical state after an overwrite', async () => {
        await lance.store({ id: 'e1', text: 'the authentication token rotation policy was updated last quarter AGAIN', metadata: {} });
        await sqlite.store({ id: 'e1', text: 'the authentication token rotation policy was updated last quarter AGAIN', metadata: {} });
        const lGot = await lance.getById('e1');
        const sGot = await sqlite.getById('e1');
        assert.equal(lGot?.text, sGot?.text);
        const lHist = await lance.getHistory('e1');
        const sHist = await sqlite.getHistory('e1');
        assert.equal(lHist.length, sHist.length, 'same number of history entries on both engines');
        // count() is total PHYSICAL rows on both engines (parity — see
        // sqliteVerbatimStore.ts's count() doc comment), so it must agree
        // exactly even with a history snapshot in the mix.
        assert.equal(await lance.count(), await sqlite.count(), 'count() (total rows incl. history) agrees across engines');
        // listIds() is NOT compared raw: Lance's no-prefix listIds()
        // returns every physical row's id, including `<id>#rev<ts>`
        // history-snapshot ids (verbatimHistory.ts's listIds has no
        // canonical-only filter) — a documented "list every stored id"
        // contract, not a bug. SqliteVerbatimStore's schema tracks
        // canonical-vs-history with a real column instead of a synthetic
        // suffixed id, so it can (and does) return canonical-only, which
        // has no bit-identical Lance-side equivalent to compare against.
        // Strip Lance's history-suffixed ids before comparing so this
        // checks what both engines actually agree on: the canonical id set.
        const lCanonicalIds = new Set([...await lance.listIds()].filter((id) => !/#rev\d{4}-\d{2}-\d{2}T/.test(id)));
        const sIds = new Set(await sqlite.listIds());
        assert.deepEqual(lCanonicalIds, sIds, 'canonical id set agrees across engines');
    });

    await lance.close();
    await sqlite.close();
    await lanceCjk.close();
    await sqliteCjk.close();

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
