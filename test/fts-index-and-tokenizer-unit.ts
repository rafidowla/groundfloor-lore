#!/usr/bin/env tsx
/**
 * fts-index-and-tokenizer-unit.ts — fix/fts-index-and-tokenizer.
 *
 * Covers the three defects fixed on this branch:
 *   1. FTS index built proactively at store open, not only reactively.
 *   2. minRows lowered 256 -> 25; LIKE-scan (unranked) results are excluded
 *      from RRF fusion in recall/retrieve.ts instead of corrupting it.
 *   3. Language-aware tokenizer (ngram for CJK, stemmed "simple" for Latin
 *      scripts), migrated automatically when the detected language changes.
 *
 * Also pins the query-path bug this fix had to repair as a PREREQUISITE for
 * all three: VerbatimStore's native-FTS attempt used to call
 * `table.search(query, { queryType: 'fts' })`. Table.search's second
 * parameter is a plain STRING ('vector'|'fts'|'auto'), not an options
 * object — the object silently failed the `=== 'fts'` check and fell
 * through to embedding-based vector-search inference, which threw "No
 * embedding functions are defined in the table" on EVERY call. That
 * exception was swallowed and bm25Search always degraded straight to the
 * LIKE scan, regardless of whether an index existed — see
 * verbatimStore.ts's _bm25SearchUncached fix note for the full story.
 *
 * Run: npx tsx test/fts-index-and-tokenizer-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { detectLanguage } from '../packages/lore/src/engines/language.js';
import {
    detectTokenizerProfile,
    hasCjkScript,
    tokenizerSettingsEqual,
    readTokenizerFingerprint,
    writeTokenizerFingerprint,
    _deleteTokenizerFingerprintForTests,
} from '../packages/lore/src/engines/ftsTokenizerProfile.js';
import { retrieve } from '../packages/lore/src/recall/retrieve.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-tok-home-'));
process.env['LORE_HOME'] = TEST_HOME;

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        console.log(`  \u2713 ${name}`);
        passed++;
    } catch (e) {
        console.error(`  \u2717 ${name}\n    ${(e as Error).stack ?? (e as Error).message}`);
        failed++;
    }
}

/**
 * Deterministic, orthogonal-ish embedder. Semantic similarity is noise
 * here (uncorrelated with query relevance), so whether a target document
 * surfaces in a hybrid seed pass depends on BM25, not an accidental
 * semantic match. Mirrors test/sweep-recall-e2e-unit.ts's DeterministicEmbedder.
 */
class DeterministicEmbedder implements EmbeddingProvider {
    readonly modelId = 'deterministic-mock';
    readonly dimension = 32;
    async initialize(): Promise<void> { /* no-op */ }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> { return texts.map((t) => this.vec(t)); }
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 1000;
        const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / mag);
    }
}

function tmpDir(label: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `fts-tok-${label}-`));
}

/** English filler — long enough to clear detectLanguage's default minLength
 *  (20 chars) AND phrased distinctively enough that franc's margin clears
 *  the default confidence threshold (0.03) — generic short phrases like
 *  "Document number N" scored ~0.009 and detected as null in practice. */
function englishFiller(i: number): string {
    return `Report ${i}: our team finished the quarterly review of the project roadmap and decided to postpone the next release until further notice`;
}

console.log('fix/fts-index-and-tokenizer\n');

(async () => {

    /** Test-only: peek at the LanceDB table's built indices. VerbatimStore
     *  doesn't expose this publicly — the cast reaches into a private field
     *  this same package's engine owns (not external/untrusted data), to
     *  assert an index actually exists on disk rather than inferring it. */
    async function listStoreIndices(store: InstanceType<typeof VerbatimStore>): Promise<Array<{ columns?: string[]; indexType?: string }>> {
        const withTable = store as unknown as { table: { listIndices(): Promise<Array<{ columns?: string[]; indexType?: string }>> } };
        return withTable.table.listIndices();
    }

    /* ══════════════════════════════════════════════════════════════════
     * SECTION A — ranked at 40 & 300 rows on a REOPENED store (items 1+2
     * together: the FTS index is built proactively at open, at the
     * lowered 25-row threshold, so a restart no longer serves the FIRST
     * query in a degraded state).
     * ══════════════════════════════════════════════════════════════════ */
    async function rankedAtRowCount(rowCount: number): Promise<void> {
        const dir = tmpDir(`rows${rowCount}`);
        // Session 1: seed rowCount docs, then close (simulates a prior run).
        const storeA = new VerbatimStore(dir, new DeterministicEmbedder());
        await storeA.initialize();
        const docs = [];
        for (let i = 0; i < rowCount; i++) docs.push({ id: `lore:doc-${i}`, text: englishFiller(i), metadata: {} });
        // High-density wombat doc (short, repeats the term -> higher BM25).
        docs.push({ id: 'lore:wombat-dense', text: 'wombat wombat wombat burrow marsupial wombat', metadata: {} });
        // Low-density wombat doc (long, term appears once -> lower BM25).
        docs.push({
            id: 'lore:wombat-sparse',
            text: `${englishFiller(9999)} somewhere in this long passage a wombat is mentioned exactly once and nothing else relates to marsupials`,
            metadata: {},
        });
        await storeA.storeBatch(docs);
        await storeA.close();

        // Session 2: reopen — simulates a daemon/embedded-host restart
        // against an existing workspace. This is the exact window item 1
        // targets: nothing has queried this store since it reopened.
        const storeB = new VerbatimStore(dir, new DeterministicEmbedder());
        await storeB.initialize();
        try {
            const indices = await listStoreIndices(storeB);
            const hasFtsIndex = indices.some((idx) => idx.columns?.includes('text') && idx.indexType === 'FTS');
            assert.equal(hasFtsIndex, true, `FTS index must exist immediately after a fresh open at ${rowCount} rows (proactive build, item 1+2)`);

            const { hits, ranked } = await storeB.bm25Search('wombat', 10);
            assert.ok(hits.length >= 2, `expected at least the two wombat docs back for "wombat" at ${rowCount} rows, got ${hits.length}`);
            const scores = new Set(hits.map((h) => h.score));
            assert.ok(scores.size > 1, `results must be GENUINELY ranked (varied scores) at ${rowCount} rows — got uniform scores ${JSON.stringify([...scores])} (the LIKE-scan unranked signature)`);
            assert.equal(ranked, true, `bm25Search must report ranked:true at ${rowCount} rows`);
        } finally {
            await storeB.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    await test('ranked at 40 rows on a reopened store (today: silently unranked forever, below the 256-row floor)', () => rankedAtRowCount(40));
    await test('ranked at 300 rows on a reopened store (today: unranked on the first query after restart)', () => rankedAtRowCount(300));

    /* ══════════════════════════════════════════════════════════════════
     * SECTION B — CJK: ngram tokenizer makes Chinese searchable via the
     * NATIVE FTS path (not just the substring LIKE fallback, which would
     * trivially find a literal substring regardless of tokenizer and so
     * would mask this bug). isBm25Ranked()===true on the result proves the
     * hit came from the real FTS path, not the LIKE-scan safety net.
     * ══════════════════════════════════════════════════════════════════ */
    await test('CJK: a Chinese keyword query finds the right document via native FTS (not just substring LIKE)', async () => {
        const dir = tmpDir('cjk');
        const store = new VerbatimStore(dir, new DeterministicEmbedder());
        await store.initialize();
        const cjkDocs = [
            '\u4ed6\u559c\u6b22\u5403\u5317\u4eac\u70e4\u9e2d\u548c\u70b8\u9171\u9762\u6bcf\u5929\u665a\u4e0a\u90fd\u4f1a\u53bb\u5403\u8fd9\u9053\u4f20\u7edf\u7684\u4e2d\u56fd\u7f8e\u98df\u771f\u662f\u8ba9\u4eba\u56de\u5473\u65e0\u7a77',
            '\u4eca\u5929\u5929\u6c14\u5f88\u597d\u6211\u4eec\u51b3\u5b9a\u53bb\u9644\u8fd1\u7684\u516c\u56ed\u6563\u6b65\u987a\u4fbf\u770b\u770b\u76db\u5f00\u7684\u82b1\u6735\u611f\u53d7\u6625\u5929\u7684\u6c14\u606f',
            '\u8fd9\u4e2a\u5468\u672b\u6211\u4eec\u8ba1\u5212\u53bb\u7238\u5c71\u770b\u65e5\u51fa\u5e0c\u671b\u5929\u6c14\u6674\u6717\u80fd\u591f\u770b\u5230\u58ee\u89c2\u7684\u65e5\u51fa\u7f8e\u666f',
            '\u4ed6\u6bcf\u5929\u65e9\u4e0a\u90fd\u4f1a\u53bb\u5065\u8eab\u623f\u953b\u70bc\u8eab\u4f53\u7136\u540e\u518d\u53bb\u516c\u53f8\u4e0a\u73ed\u4ece\u4e0d\u8fdf\u5230\u4e5f\u4e0d\u65e9\u9000',
            '\u8fd9\u672c\u5c0f\u8bf4\u7684\u60c5\u8282\u975e\u5e38\u7cbe\u5f69\u8bb2\u8ff0\u4e86\u4e00\u4e2a\u5173\u4e8e\u52c7\u6c14\u548c\u53cb\u8c0a\u7684\u52a8\u4eba\u6545\u4e8b\u503c\u5f97\u4e00\u8bfb',
        ];
        // Pad to clear the 25-row threshold; language detection also needs
        // enough SAMPLES to see a meaningful CJK fraction (see
        // ftsTokenizerProfile.ts's CJK_MIN_SAMPLES/CJK_FRACTION_THRESHOLD).
        const docs = cjkDocs.map((text, i) => ({ id: `lore:cjk-${i}`, text, metadata: {} }));
        for (let i = 0; i < 25; i++) {
            docs.push({ id: `lore:cjk-filler-${i}`, text: `${cjkDocs[i % cjkDocs.length]}\u7b2c${i}\u6b21\u8bb0\u5f55\u8fd9\u6bb5\u5185\u5bb9`, metadata: {} });
        }
        await store.storeBatch(docs);
        await store.close();

        const reopened = new VerbatimStore(dir, new DeterministicEmbedder());
        await reopened.initialize();
        try {
            const { hits, ranked } = await reopened.bm25Search('\u70e4\u9e2d', 10); // "烤鸭" (Peking duck)
            assert.ok(hits.some((h) => h.id === 'lore:cjk-0'), `expected the Peking-duck document back for the CJK query, got ids: ${hits.map((h) => h.id).join(',')}`);
            assert.equal(ranked, true, 'the hit must come from native FTS (ranked), not the LIKE-scan fallback — proves the ngram tokenizer, not just substring matching, found it');
        } finally {
            await reopened.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /* ══════════════════════════════════════════════════════════════════
     * SECTION C — English stemming: "leases" must find a document that
     * only ever says "lease". Isolated at the ensureFtsIndex level (an
     * explicit `tokenizer` option) so this proves the SETTINGS are
     * actually applied, decoupled from threshold/auto-detection timing.
     * ══════════════════════════════════════════════════════════════════ */
    await test('English: "leases" query finds a document containing only "lease" (stemming)', async () => {
        const dir = tmpDir('stem');
        const store = new VerbatimStore(dir, new DeterministicEmbedder());
        await store.initialize();
        const docs = [{ id: 'lore:lease-doc', text: 'the commercial lease agreement was signed by both parties yesterday afternoon', metadata: {} }];
        for (let i = 0; i < 10; i++) docs.push({ id: `lore:filler-${i}`, text: englishFiller(i), metadata: {} });
        await store.storeBatch(docs);
        // storeBatch's own ensureFtsIndex() has already built the index by
        // now (minRows is 1), so this asserts the AUTO-DETECTED settings
        // rather than forcing an explicit tokenizer: a Latin corpus must
        // land on stemmed English by itself. (Before minRows dropped to 1
        // this test forced the build with an explicit tokenizer and asserted
        // built===true — that assertion only held because the threshold kept
        // the automatic build from firing first.)
        const fingerprint = readTokenizerFingerprint(dir);
        assert.equal(fingerprint?.baseTokenizer, 'simple', `Latin corpus must auto-select the "simple" tokenizer, got ${JSON.stringify(fingerprint)}`);
        assert.equal(fingerprint?.stem, true, 'stemming must be enabled for a Latin corpus');
        assert.equal(fingerprint?.language, 'English', `English corpus must auto-select English stemming, got ${JSON.stringify(fingerprint)}`);
        try {
            const { hits } = await store.bm25Search('leases', 10);
            assert.ok(hits.some((h) => h.id === 'lore:lease-doc'), `expected the lease document back for "leases" (stemming), got ids: ${hits.map((h) => h.id).join(',')}`);
        } finally {
            await store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /* ══════════════════════════════════════════════════════════════════
     * SECTION D — RRF never fed unranked results (recall/retrieve.ts).
     * Mocked RetrieveContext mirrors test/audit-ra2-retrieve-core-unit.ts's
     * pattern, exercising the real fusion/meta logic in retrieve.ts.
     * ══════════════════════════════════════════════════════════════════ */
    type MockNode = { id: string; type: string; label: string; content: string; tags: string[]; project: string; ecosystem: string; updatedAt: string };
    const mockNode = (id: string): MockNode => ({
        id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'w', ecosystem: '*', updatedAt: '2026-01-01T00:00:00.000Z',
    });

    function mockRetrieveCtx(cfg: {
        semantic?: Array<{ id: string; score?: number }>;
        bm25?: Array<{ id: string; score?: number }>;
        bm25Ranked: boolean;
        nodes: Record<string, MockNode>;
    }): Parameters<typeof retrieve>[0] {
        const graph = {
            async search() { return [] as MockNode[]; },
            async getNodesByIds(ids: string[]) {
                const m = new Map<string, MockNode>();
                for (const id of ids) { const n = cfg.nodes[id]; if (n) m.set(id, n); }
                return m;
            },
            async traverse() { return [] as Array<{ node: MockNode; depth: number }>; },
        };
        const ctx = {
            store: {
                loreGraph: graph,
                sessionCache: { pushNode() { /* no-op */ } },
                storageClient: {
                    async verbatimCount() { return 1; },
                    async verbatimSearch() { return cfg.semantic ?? []; },
                    async verbatimBm25Search() { return { hits: cfg.bm25 ?? [], ranked: cfg.bm25Ranked }; },
                },
            },
        };
        return ctx as unknown as Parameters<typeof retrieve>[0];
    }

    await test('RRF exclusion: unranked bm25 is dropped from fusion, no matchedBy=[bm25], sourcesConsulted=1', async () => {
        const ctx = mockRetrieveCtx({
            semantic: [{ id: 'lore:a', score: 0.9 }],
            bm25: [{ id: 'lore:b', score: 1.0 }, { id: 'lore:c', score: 1.0 }], // uniform 1.0 — the LIKE-scan signature
            bm25Ranked: false,
            nodes: { a: mockNode('a'), b: mockNode('b'), c: mockNode('c') },
        });
        const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
        assert.deepEqual(out.results.map((r) => r.node.id), ['a'], 'only the semantic hit should surface — bm25 must be excluded entirely from this seed pass');
        assert.ok(out.results.every((r) => !r.matchedBy.includes('bm25')), 'no result may carry matchedBy=[bm25] when bm25 was unranked');
        assert.equal(out.meta.sourcesConsulted, 1, 'sourcesConsulted must honestly report only ONE usable source (semantic) when bm25 was unranked');
    });

    await test('RRF control: ranked bm25 DOES fuse normally, sourcesConsulted=2', async () => {
        const ctx = mockRetrieveCtx({
            semantic: [{ id: 'lore:a', score: 0.9 }],
            bm25: [{ id: 'lore:b', score: 5.2 }, { id: 'lore:c', score: 2.1 }],
            bm25Ranked: true,
            nodes: { a: mockNode('a'), b: mockNode('b'), c: mockNode('c') },
        });
        const out = await retrieve(ctx, 'q', { workspace: 'w', depth: 0 });
        assert.deepEqual(out.results.map((r) => r.node.id).sort(), ['a', 'b', 'c']);
        assert.ok(out.results.some((r) => r.matchedBy.includes('bm25')), 'ranked bm25 results should fuse normally and carry matchedBy=bm25');
        assert.equal(out.meta.sourcesConsulted, 2);
    });

    /* ══════════════════════════════════════════════════════════════════
     * SECTION E — Migration: a tokenizer-settings mismatch on reopen drops
     * and rebuilds the index, and updates the sidecar.
     * ══════════════════════════════════════════════════════════════════ */
    await test('migration: sidecar mismatch (forced-stale ngram vs. detected English) drops + rebuilds the index and updates the sidecar', async () => {
        const dir = tmpDir('migrate');
        const store = new VerbatimStore(dir, new DeterministicEmbedder());
        await store.initialize();
        const docs = [];
        for (let i = 0; i < 30; i++) docs.push({ id: `lore:doc-${i}`, text: englishFiller(i), metadata: {} });
        await store.storeBatch(docs);
        // storeBatch() now proactively builds the FTS index itself (fix/fts-
        // index-and-tokenizer follow-up), so this explicit call may find one
        // already in place with matching settings and report `false` (no
        // rebuild needed) rather than `true` — either way is correct;
        // idempotency is not what this test exercises. What matters is the
        // sidecar reflecting the right (English/simple) settings afterward.
        await store.ensureFtsIndex({
            tokenizer: { baseTokenizer: 'simple', stem: true, removeStopWords: true, lowercase: true, language: 'English' },
        });
        const sidecarBefore = readTokenizerFingerprint(dir);
        assert.ok(sidecarBefore, 'sidecar should exist after an explicit ensureFtsIndex build');
        assert.equal(sidecarBefore!.baseTokenizer, 'simple');
        await store.close();

        // Simulate "detected language changed" by hand-writing a sidecar
        // that claims ngram was used, WITHOUT actually rebuilding the index
        // — so reopen must detect the mismatch (stored=ngram, corpus is
        // English -> desired=simple) and migrate.
        writeTokenizerFingerprint(dir, { baseTokenizer: 'ngram', ngramMinLength: 1, ngramMaxLength: 2 });

        const reopened = new VerbatimStore(dir, new DeterministicEmbedder());
        await reopened.initialize();
        try {
            const sidecarAfter = readTokenizerFingerprint(dir);
            assert.ok(sidecarAfter, 'sidecar should still exist after migration');
            assert.equal(sidecarAfter!.baseTokenizer, 'simple', 'migration should have rebuilt with the CORRECT (English) settings, not left the stale ngram sidecar in place');
            assert.equal(
                tokenizerSettingsEqual(sidecarAfter!, { baseTokenizer: 'simple', stem: true, removeStopWords: true, lowercase: true, language: 'English' }),
                true,
            );
            const indices = await listStoreIndices(reopened);
            assert.ok(indices.some((idx) => idx.columns?.includes('text') && idx.indexType === 'FTS'), 'a real FTS index must exist post-migration');
            // The index itself must actually work post-migration.
            const { hits } = await reopened.bm25Search('quarterly', 10);
            assert.ok(hits.length > 0, 'index must be queryable immediately after migration');
        } finally {
            await reopened.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /* ══════════════════════════════════════════════════════════════════
     * SECTION F — pure detectTokenizerProfile / sidecar unit tests (new
     * code, no meaningful "before" state — these characterize the new
     * module in isolation).
     * ══════════════════════════════════════════════════════════════════ */
    await test('detectTokenizerProfile: Latin corpus -> simple + stem + English', () => {
        const profile = detectTokenizerProfile([englishFiller(1), englishFiller(2), englishFiller(3)]);
        assert.equal(profile.baseTokenizer, 'simple');
        assert.equal(profile.stem, true);
        assert.equal(profile.language, 'English');
    });
    await test('detectTokenizerProfile: CJK-majority corpus -> ngram', () => {
        const profile = detectTokenizerProfile([
            '\u4ed6\u559c\u6b22\u5403\u5317\u4eac\u70e4\u9e2d\u548c\u70b8\u9171\u9762\u6bcf\u5929\u665a\u4e0a\u90fd\u4f1a\u53bb\u5403\u8fd9\u9053\u4f20\u7edf\u7684\u4e2d\u56fd\u7f8e\u98df\u771f\u662f\u8ba9\u4eba\u56de\u5473\u65e0\u7a77',
            '\u4eca\u5929\u5929\u6c14\u5f88\u597d\u6211\u4eec\u51b3\u5b9a\u53bb\u9644\u8fd1\u7684\u516c\u56ed\u6563\u6b65\u987a\u4fbf\u770b\u770b\u76db\u5f00\u7684\u82b1\u6735\u611f\u53d7\u6625\u5929\u7684\u6c14\u606f',
            '\u8fd9\u4e2a\u5468\u672b\u6211\u4eec\u8ba1\u5212\u53bb\u7238\u5c71\u770b\u65e5\u51fa\u5e0c\u671b\u5929\u6c14\u6674\u6717\u80fd\u591f\u770b\u5230\u58ee\u89c2\u7684\u65e5\u51fa\u7f8e\u666f',
        ]);
        assert.equal(profile.baseTokenizer, 'ngram');
    });
    await test('detectTokenizerProfile: empty sample -> Latin default (never guesses ngram on no evidence)', () => {
        const profile = detectTokenizerProfile([]);
        assert.equal(profile.baseTokenizer, 'simple');
    });
    await test('tokenizerSettingsEqual: same settings compare equal, different ones do not', () => {
        const a = detectTokenizerProfile([englishFiller(1), englishFiller(2), englishFiller(3)]);
        const b = detectTokenizerProfile([englishFiller(4), englishFiller(5), englishFiller(6)]);
        assert.equal(tokenizerSettingsEqual(a, b), true);
        assert.equal(tokenizerSettingsEqual(a, { baseTokenizer: 'ngram' }), false);
    });
    await test('sidecar round-trip: write then read returns the same settings; missing file returns null', () => {
        const dir = tmpDir('sidecar');
        try {
            assert.equal(readTokenizerFingerprint(dir), null);
            const settings = detectTokenizerProfile([englishFiller(1), englishFiller(2), englishFiller(3)]);
            writeTokenizerFingerprint(dir, settings);
            const roundTripped = readTokenizerFingerprint(dir);
            assert.ok(roundTripped, 'round-tripped settings must exist');
            assert.equal(tokenizerSettingsEqual(roundTripped!, settings), true, 'round-tripped settings must be semantically equal (undefined vs. absent optional fields don\'t count as a difference)');
            _deleteTokenizerFingerprintForTests(dir);
            assert.equal(readTokenizerFingerprint(dir), null);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /* ══════════════════════════════════════════════════════════════════
     * SECTION G — startup cost measurement (25 / 300 / ~5000 rows).
     * ══════════════════════════════════════════════════════════════════ */
    await test('startup cost: measure FTS build time at 25, 300, ~5000 rows', async () => {
        for (const rowCount of [25, 300, 5000]) {
            const dir = tmpDir(`perf${rowCount}`);
            const storeA = new VerbatimStore(dir, new DeterministicEmbedder());
            await storeA.initialize();
            const docs = [];
            for (let i = 0; i < rowCount; i++) docs.push({ id: `lore:doc-${i}`, text: englishFiller(i), metadata: {} });
            await storeA.storeBatch(docs);
            await storeA.close();

            const storeB = new VerbatimStore(dir, new DeterministicEmbedder());
            const t0 = Date.now();
            await storeB.initialize(); // includes the proactive FTS build
            const elapsedMs = Date.now() - t0;
            console.log(`    [perf] ${rowCount} rows: initialize() (incl. proactive FTS build) = ${elapsedMs}ms`);
            await storeB.close();
            fs.rmSync(dir, { recursive: true, force: true });
            assert.ok(elapsedMs < 30_000, `${rowCount}-row open should not take >30s (took ${elapsedMs}ms)`);
        }
    });

    /* ══════════════════════════════════════════════════════════════════
     * SECTION H — sub-threshold CJK. Post-review fix: `minRows` was 25, and
     * "below threshold" is NOT the harmless "slower keyword search" it reads
     * as. An unindexed table still answers the FTS query — LanceDB does it
     * brute-force with its OWN DEFAULT tokenizer, ignoring the ngram
     * tokenizer this module configures. The configured tokenizer only ever
     * exists ON the index. So a small CJK workspace returned ZERO hits for a
     * term sitting verbatim in the corpus, and reported ranked:true while
     * doing it — the same fail-open shape as the original bug, just narrower.
     * A brand-new workspace or a small per-app workspace is exactly this case.
     * ══════════════════════════════════════════════════════════════════ */
    await test('sub-threshold CJK: 10 rows (under the old minRows=25) still gets an FTS index and finds the term', async () => {
        const dir = tmpDir('cjk-subthreshold');
        const store = new VerbatimStore(dir, new DeterministicEmbedder());
        await store.initialize();
        // 10 rows only — comfortably under the retired 25-row threshold, and
        // over CJK_MIN_SAMPLES so tokenizer detection is not the variable
        // under test here (the threshold is).
        const target = '租户续租决定：西田购物中心三层商铺租约延长五年';
        const docs = [{ id: 'lore:cjk-sub-target', text: target, metadata: {} }];
        for (let i = 0; i < 9; i++) {
            docs.push({ id: `lore:cjk-sub-noise-${i}`, text: `供应商保险证明审批流程第${i}步骤说明文件`, metadata: {} });
        }
        await store.storeBatch(docs);
        await store.close();

        const reopened = new VerbatimStore(dir, new DeterministicEmbedder());
        await reopened.initialize();
        try {
            // 租约延长 ("lease extension") is a verbatim substring of `target`.
            const { hits, ranked } = await reopened.bm25Search('租约延长', 10);
            assert.ok(
                hits.some((h) => h.id === 'lore:cjk-sub-target'),
                `a 10-row CJK workspace must still find a term present verbatim in the corpus; got ids: ${hits.map((h) => h.id).join(',') || '(none)'}`,
            );
            assert.equal(ranked, true, 'the hit must come from native FTS over the ngram index, not the LIKE-scan fallback');
        } finally {
            await reopened.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /* ══════════════════════════════════════════════════════════════════
     * SECTION I — the CJK decision is SCRIPT-based, not language-ID-based.
     * Statistical language ID needs length; short strings defeat it, and a
     * corpus of short Chinese documents was silently landing on `simple`.
     * These pin the property that made the fix necessary, so a future
     * refactor back to language-ID voting fails here.
     * ══════════════════════════════════════════════════════════════════ */
    await test('hasCjkScript: short Han text that defeats language ID is still detected', () => {
        const shortHan = '供应商保险证明审批流程第0步骤说明文件'; // 19 chars
        assert.equal(detectLanguage(shortHan).language, null, 'precondition: language ID gives up on this string — if this ever starts returning "zh", the script check is still correct, just no longer load-bearing here');
        assert.equal(hasCjkScript(shortHan), true, 'the script check must not depend on language ID succeeding');
    });

    await test('hasCjkScript: English prose with a stray ideograph is NOT CJK', () => {
        assert.equal(hasCjkScript('the commercial lease agreement was signed 五 by both parties'), false, 'one ideograph in an English sentence must not flip the workspace to ngram');
        assert.equal(hasCjkScript('the commercial lease agreement was signed by both parties'), false);
        assert.equal(hasCjkScript(''), false, 'empty text is never CJK');
        assert.equal(hasCjkScript('12345 !!! ???'), false, 'punctuation/digits only is never CJK');
    });

    await test('hasCjkScript: Japanese and Thai count too (no whitespace word boundaries)', () => {
        assert.equal(hasCjkScript('今日は良い天気ですから公園へ散歩に行きます'), true, 'Japanese');
        assert.equal(hasCjkScript('ผู้เช่าตัดสินใจต่อสัญญาเช่าอีกห้าปี'), true, 'Thai');
    });

    await test('detectTokenizerProfile: ten SHORT Chinese docs -> ngram (the regression this fix closes)', () => {
        const shortChineseCorpus = Array.from({ length: 10 }, (_, i) => `供应商保险证明审批流程第${i}步骤说明文件`);
        assert.deepEqual(
            detectTokenizerProfile(shortChineseCorpus),
            { baseTokenizer: 'ngram', ngramMinLength: 1, ngramMaxLength: 2 },
            'a corpus of short Chinese documents must select ngram; under language-ID voting only 1 of these 10 classified as zh, falling below the 2-sample floor',
        );
    });

    await test('detectTokenizerProfile: mostly-English corpus with a little Chinese stays Latin', () => {
        const corpus = [
            ...Array.from({ length: 12 }, (_, i) => englishFiller(i)),
            '租户续租决定：西田购物中心三层商铺租约延长五年',
        ];
        const profile = detectTokenizerProfile(corpus);
        assert.equal(profile.baseTokenizer, 'simple', `1-in-13 CJK is under the 15% threshold, so English ranking is preserved; got ${JSON.stringify(profile)}`);
    });

    await test('empty table still skips the FTS build (minRows=1, not 0)', async () => {
        const dir = tmpDir('empty-no-index');
        const store = new VerbatimStore(dir, new DeterministicEmbedder());
        await store.initialize();
        try {
            const built = await store.ensureFtsIndex();
            assert.equal(built, false, 'a zero-row table has nothing to index; the build must be skipped, not attempted');
        } finally {
            await store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    try { fs.rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
