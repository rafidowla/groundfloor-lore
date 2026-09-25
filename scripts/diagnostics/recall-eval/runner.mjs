#!/usr/bin/env node
/**
 * runner.mjs — D0 shared recall-eval harness for D1 (calibration/
 * abstention) and D3 (rank stability).
 *
 * Builds/reuses a deterministic synthetic Riverstone fixture (lib/corpus.mjs)
 * inside an embedded createLore() instance, runs questions.json (terse +
 * chatty) and gibberish.json through lore.recall(), and computes:
 *   - hit@1, hit@3, MRR (direct-match rank, expectedIds exact-id scoring)
 *   - terse-vs-chatty top-3 agreement %
 *   - prefix stability % (top-10 @ max:10 == first 10 of top-50 @ max:50),
 *     reported separately for chatty, terse and BOTH phrasings
 *   - D3 §5.3: anchor-in-both-top-3 (the expected node ranks <=3 for BOTH
 *     phrasings — the spec's "same target node in top 3" pass criterion,
 *     distinct from top-3 SET agreement) and top-1-equal (terse id[0] ==
 *     chatty id[0])
 *   - mean pairwise Jaccard of top-10 across the real questions
 *   - gibberish zero-hit rate + real-vs-gibberish top_score quantiles
 *   - D3 §5.3 negatives pass (negatives.json): off-topic + in-domain-
 *     unanswerable queries, reporting how often the top-1 hit has no
 *     semantic support and how often topScore is null
 *   - review round 2: identifiers pass (identifiers.json) — rare-term/
 *     identifier queries (file names, unique fixture symbol numbers) against
 *     the SAME 10k fixture; reports rank1 (found at rank 1), hit@3, found@10
 *     at max:10, same scoring shape as the real questions pass. This is the
 *     metric the anchored default regressed on (0/12 rank1 vs legacy 10/12)
 *     — see docs/design/D3-prefix-stable-ranking.md and the gating rule.
 *   - recall() latency (p50/p95) over every real query issued this run
 *
 * Usage:
 *   node scripts/diagnostics/recall-eval/runner.mjs \
 *     --engine sqlite --embedder real --code-rows 10000 --depth 0 \
 *     --search-mode hybrid --out baseline/sqlite-real-10k.json
 *
 * --engine sqlite | surreal-lance   (graph+vector pair; sqlite is the 3.21 default)
 * --embedder real | fake            (real = local ONNX, must already be cached; fake = deterministic hash)
 * --code-rows N                     (default 10000; pass 100000 for the larger fixture)
 * --depth N                         (graph traversal depth passed to recall(); default 0 — clean D1/D3
 *                                     measurement, mirrors Atlas's own depth:0 workaround for D4)
 * --search-mode hybrid|semantic|keyword
 * --max N                           (primary result window; default 10)
 * --wide-max N                      (prefix-stability comparison window; default 50)
 * --cache-root PATH                 (fixture build cache; default a mkdtemp under os.tmpdir())
 * --force                           (rebuild fixture even if a cache hit exists)
 * --out PATH                        (JSON output path; also writes PATH with .md instead of .json)
 *
 * D1 (calibrated relevance + abstention) additions:
 * --abstain on|off                  (default off; passed as lore.recall()'s `abstain` option)
 * --relevance-floor N               (default unset -> retrieve()'s own default, 2.0)
 *
 * D8 (optional local cross-encoder re-rank) addition:
 * --rerank on|off                   (default unset -> no per-call opinion, falls through to workspace/
 *                                     env/off precedence like every other production recall surface;
 *                                     passed straight through as lore.recall()'s `rerank` option)
 * --gibberish-file PATH             (default gibberish.json; pass gibberish-heldout.json for the held-out set)
 * --questions-file A[,B...]        (default questions.json; comma-separated list of {id,terse,chatty,expectedIds}
 *                                     files, all run as real questions -- e.g. questions.json,questions-heldout.json.
 *                                     Relative paths resolve next to this script; each row gets a `source` field)
 * --distractors-file PATH           (optional; comma-separated list allowed, each row tagged with `source`; runs distractors.json-shaped {id,query} rows through the
 *                                     same gibberish-style eval loop, reported separately, no pass bar)
 * --term-coverage on|off            (default off; passes abstainTermCoverage: true -- the D1 key-term coverage
 *                                     signal, only active with --abstain on)
 * --with-queries                    (also runs each question's `queries[]` multi-phrasing variant --
 *                                     terse + queries:[chatty] for real questions, gibberish query +
 *                                     a second gibberish phrasing for gibberish -- and reports hit@1/hit@3/MRR/
 *                                     zero-hit for that variant alongside the single-phrasing numbers)
 * --candidate-floor N                (D3 §5.3: sets LORE_RECALL_CANDIDATE_FLOOR before createLore(); 0 = legacy)
 * --lexical-base anchored|rrf        (D3 §5.3: sets LORE_RECALL_LEXICAL_BASE before createLore(); rrf = legacy)
 * --negatives PATH                   (default negatives.json next to this script; skipped if absent)
 * --skip-negatives                   (skip the negatives pass entirely)
 * --identifiers PATH                 (default identifiers.json next to this script; skipped if absent;
 *                                     alias --identifiers-file, see below)
 * --skip-identifiers                 (skip the identifiers pass entirely)
 * --identifiers-file PATH           (optional; {id,query,expectedIds} rows naming something that IS stored,
 *                                     e.g. identifiers.json -- scored rank1/hit@3/found@10 plus abstained/
 *                                     rescued counts; the exact-identifier rescue's target population)
 * --absent-identifiers-file PATH    (optional; {id,query} identifier-shaped rows naming something NOT
 *                                     stored, e.g. identifiers-absent.json (absent at --code-rows <= 10000)
 *                                     -- reported like distractors, no pass bar; the rescue must not fire)
 *
 * D7 (piece-level vectors, 3.23) addition:
 * --piece-vectors on|off             (default off; passed to ensureFixture() as a FIXTURE-SHAPE input --
 *                                     see buildFixture.mjs's fixtureCacheKey doc -- and to createLore() as
 *                                     the `pieceVectors` option, so this run's recall()/retrieve() calls
 *                                     see the fixture's piece index. `on` never silently reuses an `off`
 *                                     fixture build (or vice versa): they hash to different cache dirs.
 *                                     Per DESIGN-3.23.md §7.1, pass --force if you want a guaranteed
 *                                     rebuild regardless of cache state.)
 */
import { spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..', '..');

if (!process.env.__RECALL_EVAL_REEXEC) {
    const res = spawnSync(
        process.execPath,
        ['--import', 'tsx', SELF, ...process.argv.slice(2)],
        { stdio: 'inherit', cwd: REPO_ROOT, env: { ...process.env, __RECALL_EVAL_REEXEC: '1' } },
    );
    process.exit(res.status ?? 1);
}

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
};
const hasFlag = (flag) => argv.includes(flag);

const ENGINE = argOf('--engine', 'sqlite'); // 'sqlite' | 'surreal-lance'
const EMBEDDER = argOf('--embedder', 'real'); // 'real' | 'fake'
const CODE_ROWS = Number.parseInt(argOf('--code-rows', '10000'), 10);
const DEPTH = Number.parseInt(argOf('--depth', '0'), 10);
const SEARCH_MODE = argOf('--search-mode', 'hybrid');
const MAX = Number.parseInt(argOf('--max', '10'), 10);
const WIDE_MAX = Number.parseInt(argOf('--wide-max', '50'), 10);
const CACHE_ROOT = argOf('--cache-root', undefined);
const FORCE = hasFlag('--force');
const OUT = argOf('--out', null);
const ABSTAIN = argOf('--abstain', 'off') === 'on';
const RELEVANCE_FLOOR_RAW = argOf('--relevance-floor', undefined);
const RELEVANCE_FLOOR = RELEVANCE_FLOOR_RAW === undefined ? undefined : Number.parseFloat(RELEVANCE_FLOOR_RAW);
// D8b — --rerank on|off maps straight to the per-call lore.recall({rerank})
// option (same on/off vocabulary --abstain already uses above). Omitted
// (the default) means "no per-call opinion" — opts.rerank is left unset
// entirely below so the call falls through to workspace/env/off precedence,
// exactly like every other production recall surface.
const RERANK_RAW = argOf('--rerank', undefined);
if (RERANK_RAW !== undefined && RERANK_RAW !== 'on' && RERANK_RAW !== 'off') {
    console.error(`[runner] --rerank must be "on" or "off" (got "${RERANK_RAW}")`);
    process.exit(1);
}
const RERANK = RERANK_RAW === undefined ? undefined : RERANK_RAW === 'on';
const GIBBERISH_FILE = argOf('--gibberish-file', 'gibberish.json');
const DISTRACTORS_FILE = argOf('--distractors-file', null);
const QUESTIONS_FILES = argOf('--questions-file', 'questions.json');
const WITH_QUERIES = hasFlag('--with-queries');
const TERM_COVERAGE = argOf('--term-coverage', 'off') === 'on'; // D1 term-coverage signal (needs --abstain on)
const CANDIDATE_FLOOR = argOf('--candidate-floor', null); // string | null — left unset means "don't touch the env var"
const LEXICAL_BASE = argOf('--lexical-base', null); // 'anchored' | 'rrf' | null
const NEGATIVES_PATH = argOf('--negatives', path.join(path.dirname(SELF), 'negatives.json'));
const SKIP_NEGATIVES = hasFlag('--skip-negatives');
// D3's --identifiers and D1's --identifiers-file name the same pass (same identifiers.json);
// --identifiers-file wins if both are given. Default-on unless --skip-identifiers.
const IDENTIFIERS_PATH = argOf('--identifiers-file', argOf('--identifiers', path.join(path.dirname(SELF), 'identifiers.json')));
const SKIP_IDENTIFIERS = hasFlag('--skip-identifiers');
const ABSENT_IDENTIFIERS_FILE = argOf('--absent-identifiers-file', null);
const PIECE_VECTORS = argOf('--piece-vectors', 'off') === 'on'; // D7c — fixture-shape input, see buildFixture.mjs

const [graphEngine, vectorEngine] = ENGINE === 'surreal-lance' ? ['surreal', 'lance'] : ['sqlite', 'sqlite'];

// D3 §5.3 — set the env vars BEFORE createLore() so every recall() call in
// this process resolves the same candidateFloor/lexicalBase. Left untouched
// (inherits ambient env / package default) when the flag is omitted.
if (CANDIDATE_FLOOR !== null) process.env.LORE_RECALL_CANDIDATE_FLOOR = CANDIDATE_FLOOR;
if (LEXICAL_BASE !== null) process.env.LORE_RECALL_LEXICAL_BASE = LEXICAL_BASE;

const latencies = []; // ms, every real lore.recall() call this run (fixture build excluded)

async function main() {
    const HERE = path.dirname(SELF);
    const { ensureFixture } = await import(path.join(HERE, 'lib', 'buildFixture.mjs'));
    const inHere = (f) => (path.isAbsolute(f) ? f : path.join(HERE, f));
    const loadTagged = (list) => list.split(',').filter(Boolean).flatMap((f) => JSON.parse(fs.readFileSync(inHere(f), 'utf8')).map((row) => ({ ...row, source: path.basename(f) })));
    const questions = loadTagged(QUESTIONS_FILES);
    const gibberishPath = path.isAbsolute(GIBBERISH_FILE) ? GIBBERISH_FILE : path.join(HERE, GIBBERISH_FILE);
    const gibberish = JSON.parse(fs.readFileSync(gibberishPath, 'utf8'));
    const distractors = DISTRACTORS_FILE ? loadTagged(DISTRACTORS_FILE) : null;
    let negatives = null;
    if (!SKIP_NEGATIVES && fs.existsSync(NEGATIVES_PATH)) {
        negatives = JSON.parse(fs.readFileSync(NEGATIVES_PATH, 'utf8'));
    }
    const resolveIn = (f) => (path.isAbsolute(f) || fs.existsSync(f) ? f : path.join(HERE, f));
    let identifiers = null;
    if (!SKIP_IDENTIFIERS && fs.existsSync(resolveIn(IDENTIFIERS_PATH))) {
        identifiers = JSON.parse(fs.readFileSync(resolveIn(IDENTIFIERS_PATH), 'utf8'));
    }
    const absentIdentifiers = ABSENT_IDENTIFIERS_FILE ? JSON.parse(fs.readFileSync(resolveIn(ABSENT_IDENTIFIERS_FILE), 'utf8')) : null;

    const log = (...a) => console.error(...a);
    const t0 = Date.now();
    const fixture = await ensureFixture({
        graphEngine, vectorEngine, codeRowCount: CODE_ROWS, embedder: EMBEDDER,
        pieceVectors: PIECE_VECTORS,
        cacheRoot: CACHE_ROOT, force: FORCE, log,
    });
    const fixtureMs = Date.now() - t0;
    log(`[runner] fixture ready in ${fixtureMs}ms (reused=${fixture.reused}): ${JSON.stringify(fixture.counts)}`);
    log(`[runner] candidateFloor env=${process.env.LORE_RECALL_CANDIDATE_FLOOR ?? '(unset/default)'} lexicalBase env=${process.env.LORE_RECALL_LEXICAL_BASE ?? '(unset/default)'}`);

    const { createLore } = await import(path.join(REPO_ROOT, 'packages', 'lore', 'src', 'index.js'));
    const evalOpts = { deploymentMode: 'embedded', dataDir: fixture.dataDir, ownsProcess: false };
    // D7c — must match what the fixture was BUILT with (fixture.pieceVectors),
    // not necessarily the raw PIECE_VECTORS flag: a cache hit from a run that
    // didn't pass --piece-vectors would otherwise open a piece-off fixture
    // with pieceVectors:true and see an empty/invalid index at query time.
    if (fixture.pieceVectors) evalOpts.pieceVectors = true;
    if (EMBEDDER === 'fake') {
        const { FakeEmbeddingProvider } = await import(path.join(HERE, 'lib', 'fakeEmbeddingProvider.mjs'));
        evalOpts.embeddingProvider = new FakeEmbeddingProvider();
    }
    const lore = await createLore(evalOpts);

    const t1 = Date.now();
    const perQuestion = [];
    for (const q of questions) {
        const chattyR = await recallOne(lore, q.chatty, MAX);
        const chattyWide = await recallOne(lore, q.chatty, WIDE_MAX);
        const terseR = await recallOne(lore, q.terse, MAX);
        const terseWide = await recallOne(lore, q.terse, WIDE_MAX);

        const rank = firstHitRank(chattyR.ids, q.expectedIds);
        const rankTerse = firstHitRank(terseR.ids, q.expectedIds);
        const prefixStableChatty = arraysEqual(chattyR.ids.slice(0, MAX), chattyWide.ids.slice(0, MAX));
        const prefixStableTerse = arraysEqual(terseR.ids.slice(0, MAX), terseWide.ids.slice(0, MAX));
        const top3Chatty = new Set(chattyR.ids.slice(0, 3));
        const top3Terse = new Set(terseR.ids.slice(0, 3));
        const top3AgreementFrac = jaccard(top3Chatty, top3Terse);
        const hit3Chatty = rank !== null && rank <= 3;
        const hit3Terse = rankTerse !== null && rankTerse <= 3;

        const entry = {
            id: q.id, source: q.source, expectedIds: q.expectedIds,
            chatty: { ids: chattyR.ids, rank, hit1: rank === 1, hit3: hit3Chatty, topScore: chattyR.topScore, confidence: chattyR.confidence, abstained: chattyR.abstained, topRelevance: chattyR.topRelevance, overridden: chattyR.overridden, abstainReason: chattyR.abstainReason, termCoverage: chattyR.termCoverage },
            terse: { ids: terseR.ids, rank: rankTerse, hit1: rankTerse === 1, hit3: hit3Terse, topScore: terseR.topScore, confidence: terseR.confidence, abstained: terseR.abstained, topRelevance: terseR.topRelevance, overridden: terseR.overridden, abstainReason: terseR.abstainReason, termCoverage: terseR.termCoverage },
            prefixStableChatty,
            prefixStableTerse,
            prefixStableBoth: prefixStableChatty && prefixStableTerse,
            // D3 §5.3 "same target node in top 3 for both phrasings" — the spec's own
            // phrasing-stability pass criterion. NOT the same thing as top3SetEqual
            // (identical result SETS) — this only requires the expected node to rank
            // <=3 under each phrasing independently.
            anchorBothTop3: hit3Chatty && hit3Terse,
            top1Equal: chattyR.ids[0] !== undefined && chattyR.ids[0] === terseR.ids[0],
            top3AgreementFrac,
            top3SetEqual: setEqual(top3Chatty, top3Terse),
            calibration: chattyR.calibration,
        };
        if (WITH_QUERIES) {
            // terse primary + chatty as an extra phrasing, mirroring the
            // design doc's "queries[] variant" row.
            const wq = await recallOne(lore, q.terse, MAX, [q.chatty]);
            const rankWq = firstHitRank(wq.ids, q.expectedIds);
            entry.withQueries = { ids: wq.ids, rank: rankWq, hit1: rankWq === 1, hit3: rankWq !== null && rankWq <= 3, abstained: wq.abstained };
        }
        perQuestion.push(entry);
    }

    const gibberishResults = [];
    for (const g of gibberish) {
        const r = await recallOne(lore, g.query, MAX);
        const entry = { id: g.id, query: g.query, ids: r.ids, hitCount: r.ids.length, topScore: r.topScore, confidence: r.confidence, abstained: r.abstained, topRelevance: r.topRelevance, overridden: r.overridden, abstainReason: r.abstainReason, termCoverage: r.termCoverage };
        if (WITH_QUERIES) {
            const wq = await recallOne(lore, g.query, MAX, [`${g.query} extra`]);
            entry.withQueries = { hitCount: wq.ids.length, abstained: wq.abstained };
        }
        gibberishResults.push(entry);
    }

    let distractorResults = null;
    if (distractors) {
        distractorResults = [];
        for (const d of distractors) {
            const r = await recallOne(lore, d.query, MAX);
            distractorResults.push({ id: d.id, source: d.source, query: d.query, ids: r.ids, hitCount: r.ids.length, topScore: r.topScore, abstained: r.abstained, topRelevance: r.topRelevance, overridden: r.overridden, abstainReason: r.abstainReason, termCoverage: r.termCoverage });
        }
    }

    let negativesReport = null;
    if (negatives) {
        negativesReport = await runNegatives(lore, negatives);
    }
    let identifiersReport = null;
    if (identifiers) {
        identifiersReport = await runIdentifiers(lore, identifiers);
    }
    let absentIdentifierResults = null;
    if (absentIdentifiers) {
        absentIdentifierResults = [];
        for (const d of absentIdentifiers) {
            const r = await recallOne(lore, d.query, MAX);
            absentIdentifierResults.push({ id: d.id, query: d.query, ids: r.ids, hitCount: r.ids.length, topScore: r.topScore, abstained: r.abstained, topRelevance: r.topRelevance, overridden: r.overridden, abstainReason: r.abstainReason, termCoverage: r.termCoverage });
        }
    }
    const evalMs = Date.now() - t1;

    await lore.dispose('recall-eval-complete');

    const latSorted = [...latencies].sort((a, b) => a - b);
    const latP = (p) => latSorted.length ? latSorted[Math.min(latSorted.length - 1, Math.floor(p * latSorted.length))] : null;
    const latency = { n: latSorted.length, p50: latP(0.5), p90: latP(0.9), p95: latP(0.95), p99: latP(0.99) };

    const aggregate = aggregateMetrics(perQuestion, gibberishResults, distractorResults, identifiersReport?.perQuery ?? null, absentIdentifierResults);
    const report = {
        generatedAt: new Date().toISOString(),
        config: {
            engine: ENGINE, graphEngine, vectorEngine, embedder: EMBEDDER, codeRows: CODE_ROWS, depth: DEPTH, pieceVectors: PIECE_VECTORS,
            searchMode: SEARCH_MODE, max: MAX, wideMax: WIDE_MAX, abstain: ABSTAIN, relevanceFloor: RELEVANCE_FLOOR ?? null, rerank: RERANK ?? null, termCoverage: TERM_COVERAGE, termCoverageMin: process.env.LORE_RECALL_TERM_COVERAGE_MIN ?? null,
            gibberishFile: path.basename(gibberishPath), distractorsFile: DISTRACTORS_FILE ?? null, questionsFiles: QUESTIONS_FILES,
            withQueries: WITH_QUERIES,
            candidateFloor: process.env.LORE_RECALL_CANDIDATE_FLOOR ?? null,
            lexicalBase: process.env.LORE_RECALL_LEXICAL_BASE ?? null,
            identifiersFile: identifiers ? path.basename(IDENTIFIERS_PATH) : null,
            absentIdentifiersFile: ABSENT_IDENTIFIERS_FILE ? path.basename(ABSENT_IDENTIFIERS_FILE) : null,
        },
        fixture: { dataDir: fixture.dataDir, reused: fixture.reused, counts: fixture.counts, buildMs: fixtureMs },
        // meanRecallMs: mean over every recall() call actually made (D3's latency sampler).
        timings: { fixtureMs, evalMs, totalMs: Date.now() - t0, meanRecallMs: latSorted.length ? latSorted.reduce((a, b) => a + b, 0) / latSorted.length : null },
        latency,
        perQuestion, gibberish: gibberishResults, distractors: distractorResults, negatives: negativesReport,
        // identifiers: D3's {n,rank1,hit3,found10,mrr,perQuery}; each perQuery row also carries
        // D1's abstention fields (abstained/topRelevance/overridden), which aggregate.identifiers summarises.
        identifiers: identifiersReport, absentIdentifiers: absentIdentifierResults, aggregate,
    };

    const jsonOut = OUT ?? path.join(HERE, 'baseline', 'last-run.json');
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
    const mdOut = jsonOut.replace(/\.json$/, '.md');
    fs.writeFileSync(mdOut, renderMarkdown(report));
    log(`[runner] wrote ${jsonOut} and ${mdOut}`);
    console.log(renderMarkdown(report));
}

async function recallOne(lore, topic, max, queries, searchModeOverride) {
    const opts = {
        workspace: 'default', ecosystem: 'riverstone', mode: 'summary',
        depth: DEPTH, max, searchMode: searchModeOverride ?? SEARCH_MODE,
        abstain: ABSTAIN,
    };
    if (RELEVANCE_FLOOR !== undefined) opts.relevanceFloor = RELEVANCE_FLOOR;
    if (RERANK !== undefined) opts.rerank = RERANK;
    if (TERM_COVERAGE) opts.abstainTermCoverage = true;
    if (queries && queries.length > 0) opts.queries = queries;
    const t = performance.now();
    const result = await lore.recall(topic, opts);
    latencies.push(performance.now() - t);
    const ids = (result.hits ?? []).map((h) => h.id);
    const meta = result._meta ?? {};
    return {
        ids,
        topScore: meta.top_score ?? null,
        confidence: meta.confidence ?? null,
        abstained: meta.abstained ?? false,
        topRelevance: meta.top_relevance ?? null,
        calibration: meta.calibration ?? null,
        // D1 follow-up: exact-identifier rescue overriding an
        // otherwise-abstained decision (abstention.ts's abstain_overridden).
        overridden: meta.abstain_overridden ?? null,
        // D1 term-coverage signal (--term-coverage on).
        abstainReason: meta.abstain_reason ?? null,
        termCoverage: meta.term_coverage ?? null,
    };
}

/**
 * D3 §5.3 negatives pass. Reports, per set (offtopic / unanswerable):
 *   - topScoreNullCount: RecallMeta.top_score is null (no semantic score
 *     anywhere in the displayed hits at all) — a direct, PUBLIC signal.
 *   - top1LexicalOnlyCount: the top-1 hit has no genuine semantic support.
 *     There is no per-hit score on the public RecallHit type (see README —
 *     "RecallHit has no per-hit score field"), and the internal per-seed
 *     semantic-score map is intentionally not exposed through meta (D3
 *     kept RetrieveMeta additive-only, §3.1). Rather than patch product
 *     code to leak that internal map for a diagnostic, this uses a
 *     non-invasive proxy available through the existing public API: rerun
 *     the SAME query with searchMode:'semantic' at a wide window
 *     (wideMax) and check whether the hybrid top-1 id appears in that
 *     semantic-only candidate set. A row absent from a wide semantic-only
 *     search has no meaningful cosine support for this query — which is
 *     exactly the condition lexicalOnlyBase()/semFloor guards against
 *     (candidateWindow.ts).
 */
async function runNegatives(lore, negatives) {
    const sets = { offtopic: negatives.offtopic ?? [], unanswerable: negatives.unanswerable ?? [] };
    const out = {};
    for (const [setName, queries] of Object.entries(sets)) {
        let topScoreNullCount = 0, top1LexicalOnlyCount = 0, top3LexicalOnlySlots = 0;
        for (const query of queries) {
            const hybrid = await recallOne(lore, query, MAX);
            if (hybrid.topScore === null) topScoreNullCount++;
            if (hybrid.ids.length === 0) continue;
            const semanticWide = await recallOne(lore, query, WIDE_MAX, undefined, 'semantic');
            const semSet = new Set(semanticWide.ids);
            if (!semSet.has(hybrid.ids[0])) top1LexicalOnlyCount++;
            top3LexicalOnlySlots += hybrid.ids.slice(0, 3).filter((id) => !semSet.has(id)).length;
        }
        out[setName] = {
            n: queries.length,
            topScoreNullCount, top1LexicalOnlyCount,
            top3LexicalOnlySlots, top3LexicalOnlySlotsOf: 3 * queries.length,
        };
    }
    return out;
}

/**
 * Review round 2 (item 1) — identifier/rare-term pass (identifiers.json).
 * Same scoring shape as the real-questions pass (firstHitRank against
 * expectedIds), but each query targets a rare/exact token (a unique numeric
 * fixture-symbol marker, or a filePath that matches exactly one code row) —
 * the class of query the anchored-default regression buried (reviewer's
 * probe: rank1 0/12, found@10 1/12 vs legacy's 10/12 / 12/12).
 */
async function runIdentifiers(lore, identifiers) {
    const perQuery = [];
    for (const q of identifiers) {
        const r = await recallOne(lore, q.query, MAX);
        const rank = firstHitRank(r.ids, q.expectedIds);
        perQuery.push({
            id: q.id, query: q.query, expectedIds: q.expectedIds,
            ids: r.ids, rank, rank1: rank === 1, hit3: rank !== null && rank <= 3, found10: rank !== null,
            // D1 abstention fields, summarised in aggregate.identifiers.
            hitCount: r.ids.length, topScore: r.topScore, abstained: r.abstained, topRelevance: r.topRelevance, overridden: r.overridden, abstainReason: r.abstainReason, termCoverage: r.termCoverage,
        });
    }
    const n = perQuery.length;
    const rank1 = perQuery.filter((q) => q.rank1).length / n;
    const hit3 = perQuery.filter((q) => q.hit3).length / n;
    const found10 = perQuery.filter((q) => q.found10).length / n;
    const mrr = perQuery.reduce((s, q) => s + (q.rank ? 1 / q.rank : 0), 0) / n;
    return { n, rank1, hit3, found10, mrr, perQuery };
}

function firstHitRank(ids, expectedIds) {
    for (let i = 0; i < ids.length; i++) {
        if (expectedIds.includes(ids[i])) return i + 1;
    }
    return null;
}
function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
}
function jaccard(a, b) {
    const union = new Set([...a, ...b]);
    if (union.size === 0) return 1;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return inter / union.size;
}
function setEqual(a, b) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}
function quantiles(values, qs) {
    const sorted = [...values].filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
    if (sorted.length === 0) return Object.fromEntries(qs.map((q) => [q, null]));
    return Object.fromEntries(qs.map((q) => {
        const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
        return [q, sorted[idx]];
    }));
}

function aggregateMetrics(perQuestion, gibberishResults, distractorResults, identifierResults = null, absentIdentifierResults = null) {
    const n = perQuestion.length;
    const hit1 = perQuestion.filter((q) => q.chatty.hit1).length / n;
    const hit3 = perQuestion.filter((q) => q.chatty.hit3).length / n;
    const mrr = perQuestion.reduce((s, q) => s + (q.chatty.rank ? 1 / q.chatty.rank : 0), 0) / n;
    const hit1Terse = perQuestion.filter((q) => q.terse.hit1).length / n;
    const hit3Terse = perQuestion.filter((q) => q.terse.hit3).length / n;
    const mrrTerse = perQuestion.reduce((s, q) => s + (q.terse.rank ? 1 / q.terse.rank : 0), 0) / n;

    // D1: pooled hit@3 over both phrasings of every question (48 phrasings
    // for the 24-question set) -- the design doc's actual acceptance unit
    // ("at most 1 of 48 may regress"), not either phrasing alone.
    const pooledHit3Count = perQuestion.reduce((s, q) => s + (q.chatty.hit3 ? 1 : 0) + (q.terse.hit3 ? 1 : 0), 0);
    const pooledHit3 = pooledHit3Count / (n * 2);

    // D1: how many of the 2*n real-question phrasings got gated by
    // abstention (should be ~0 -- these are in-corpus, answerable
    // questions; a real question abstaining is a regression, not a win).
    const realAbstainedCount = perQuestion.reduce((s, q) => s + (q.chatty.abstained ? 1 : 0) + (q.terse.abstained ? 1 : 0), 0);

    // D1 follow-up: how many phrasings/queries hit the exact-identifier
    // rescue (an abstention that WOULD have fired but was overridden because
    // the query contains an identifier-shaped token verbatim in a hit's
    // content). Counted across every result set the runner produces so a
    // regression in rescue breadth (too broad OR too narrow) shows up here.
    const rescueOverrideCount =
        perQuestion.reduce((s, q) => s + (q.chatty.overridden ? 1 : 0) + (q.terse.overridden ? 1 : 0), 0) +
        gibberishResults.filter((g) => g.overridden).length +
        (distractorResults ? distractorResults.filter((d) => d.overridden).length : 0) +
        (identifierResults ? identifierResults.filter((d) => d.overridden).length : 0) +
        (absentIdentifierResults ? absentIdentifierResults.filter((d) => d.overridden).length : 0);

    const nullMedians = perQuestion.map((q) => q.calibration?.null_median).filter((v) => v !== null && v !== undefined);
    const nullScales = perQuestion.map((q) => q.calibration?.null_scale).filter((v) => v !== null && v !== undefined);
    const calibrationStatuses = [...new Set(perQuestion.map((q) => q.calibration?.status).filter(Boolean))];

    const prefixStableChattyPct = perQuestion.filter((q) => q.prefixStableChatty).length / n;
    const prefixStableTersePct = perQuestion.filter((q) => q.prefixStableTerse).length / n;
    const prefixStableBothPct = perQuestion.filter((q) => q.prefixStableBoth).length / n;
    const anchorBothTop3Pct = perQuestion.filter((q) => q.anchorBothTop3).length / n;
    const top1EqualPct = perQuestion.filter((q) => q.top1Equal).length / n;
    const top3AgreementMean = perQuestion.reduce((s, q) => s + q.top3AgreementFrac, 0) / n;
    const top3SetEqualPct = perQuestion.filter((q) => q.top3SetEqual).length / n;

    // Mean pairwise Jaccard of top-10 (chatty ids) across all question pairs.
    const top10Sets = perQuestion.map((q) => new Set(q.chatty.ids.slice(0, 10)));
    let jSum = 0, jCount = 0;
    for (let i = 0; i < top10Sets.length; i++) {
        for (let j = i + 1; j < top10Sets.length; j++) {
            jSum += jaccard(top10Sets[i], top10Sets[j]);
            jCount++;
        }
    }
    const meanPairwiseJaccard = jCount ? jSum / jCount : null;

    const zeroHitGibberish = gibberishResults.filter((g) => g.hitCount === 0).length / gibberishResults.length;
    // D1: with abstain on, "zero hit" and "abstained" should coincide for
    // gibberish (abstained IS the mechanism producing the zero hit) --
    // tracked separately so a zero-hit that happened for some OTHER reason
    // (e.g. an empty seed window) doesn't get silently credited to D1.
    const abstainedGibberishPct = gibberishResults.filter((g) => g.abstained).length / gibberishResults.length;

    const realTopScores = perQuestion.map((q) => q.chatty.topScore);
    const gibberishTopScores = gibberishResults.map((g) => g.topScore);
    const qLevels = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];

    let distractorAgg = null;
    if (distractorResults) {
        distractorAgg = {
            n: distractorResults.length,
            zeroHitPct: distractorResults.filter((d) => d.hitCount === 0).length / distractorResults.length,
            abstainedPct: distractorResults.filter((d) => d.abstained).length / distractorResults.length,
            abstainedBySource: Object.fromEntries([...new Set(distractorResults.map((d) => d.source))].map((src) => {
                const rows = distractorResults.filter((d) => d.source === src);
                return [src, { n: rows.length, abstained: rows.filter((d) => d.abstained).length }];
            })),
            topScoreQuantiles: quantiles(distractorResults.map((d) => d.topScore), qLevels),
        };
    }

    let identifiersAgg = null;
    if (identifierResults) {
        const m = identifierResults.length;
        identifiersAgg = {
            n: m,
            rank1: identifierResults.filter((q) => q.rank === 1).length / m,
            hit3: identifierResults.filter((q) => q.rank !== null && q.rank <= 3).length / m,
            found10: identifierResults.filter((q) => q.rank !== null).length / m,
            abstainedPct: identifierResults.filter((q) => q.abstained).length / m,
            overriddenCount: identifierResults.filter((q) => q.overridden).length,
        };
    }
    let absentIdentifiersAgg = null;
    if (absentIdentifierResults) {
        const m = absentIdentifierResults.length;
        absentIdentifiersAgg = {
            n: m,
            zeroHitPct: absentIdentifierResults.filter((d) => d.hitCount === 0).length / m,
            abstainedPct: absentIdentifierResults.filter((d) => d.abstained).length / m,
            overriddenCount: absentIdentifierResults.filter((d) => d.overridden).length,
        };
    }

    let withQueriesAgg = null;
    if (perQuestion[0]?.withQueries !== undefined) {
        const wqHit3 = perQuestion.filter((q) => q.withQueries.hit3).length / n;
        const wqRealAbstained = perQuestion.filter((q) => q.withQueries.abstained).length / n;
        const wqGibberishZeroHit = gibberishResults.filter((g) => g.withQueries?.hitCount === 0).length / gibberishResults.length;
        // D3 (705251b9) added hit@1 and MRR for the same terse + queries:[chatty] variant.
        const wqHit1 = perQuestion.filter((q) => q.withQueries.hit1).length / n;
        const wqMrr = perQuestion.reduce((s, q) => s + (q.withQueries.rank ? 1 / q.withQueries.rank : 0), 0) / n;
        withQueriesAgg = { hit1: wqHit1, hit3: wqHit3, mrr: wqMrr, realAbstainedPct: wqRealAbstained, gibberishZeroHitPct: wqGibberishZeroHit };
    }

    return {
        n_questions: n, n_gibberish: gibberishResults.length,
        hit1, hit3, mrr, hit1Terse, hit3Terse, mrrTerse,
        pooledHit3, pooledHit3Count, pooledHit3N: n * 2,
        prefixStableChattyPct, prefixStableTersePct, prefixStableBothPct,
        anchorBothTop3Pct, top1EqualPct,
        top3AgreementMean, top3SetEqualPct,
        meanPairwiseJaccard,
        zeroHitGibberishPct: zeroHitGibberish,
        abstainedGibberishPct,
        realAbstainedCount, realAbstainedN: n * 2,
        rescueOverrideCount,
        topScoreQuantiles: { real: quantiles(realTopScores, qLevels), gibberish: quantiles(gibberishTopScores, qLevels) },
        calibration: {
            statuses: calibrationStatuses,
            nullMedianMean: nullMedians.length ? nullMedians.reduce((a, b) => a + b, 0) / nullMedians.length : null,
            nullScaleMean: nullScales.length ? nullScales.reduce((a, b) => a + b, 0) / nullScales.length : null,
        },
        distractors: distractorAgg,
        identifiers: identifiersAgg,
        absentIdentifiers: absentIdentifiersAgg,
        withQueries: withQueriesAgg,
    };
}

function pct(x) { return x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`; }
function num(x, d = 3) { return x === null || x === undefined ? 'n/a' : x.toFixed(d); }
function ms(x) { return x === null || x === undefined ? 'n/a' : `${x.toFixed(1)}ms`; }

function renderMarkdown(report) {
    const a = report.aggregate;
    const q = a.topScoreQuantiles;
    const l = report.latency;
    const qRow = (label, obj) => `| ${label} | ${['0','0.1','0.25','0.5','0.75','0.9','1'].map((k) => num(obj[k])).join(' | ')} |`;
    let negRows = '';
    if (report.negatives) {
        negRows = `\n## Negatives (D3 §5.3)\n\n| set | n | topScore null | top-1 lexical-only | top-3 lexical-only slots |\n|---|---|---|---|---|\n` +
            Object.entries(report.negatives).map(([name, r]) =>
                `| ${name} | ${r.n} | ${r.topScoreNullCount} | ${r.top1LexicalOnlyCount} | ${r.top3LexicalOnlySlots}/${r.top3LexicalOnlySlotsOf} |`
            ).join('\n') + '\n';
    }
    let idRows = '';
    if (report.identifiers) {
        const idr = report.identifiers;
        idRows = `\n## Identifiers / rare-term (review round 2 item 1)\n\n| metric | value |\n|---|---|\n` +
            `| n | ${idr.n} |\n| rank1 | ${pct(idr.rank1)} |\n| hit@3 | ${pct(idr.hit3)} |\n| found@10 | ${pct(idr.found10)} |\n| MRR | ${num(idr.mrr)} |\n`;
    }
    return `# recall-eval baseline — ${report.config.engine} / ${report.config.embedder} / ${report.config.codeRows} code rows

Generated: ${report.generatedAt}
Config: candidateFloor=${report.config.candidateFloor ?? '(default)'} lexicalBase=${report.config.lexicalBase ?? '(default)'}
Fixture: ${report.fixture.dataDir} (reused=${report.fixture.reused}), counts: ${JSON.stringify(report.fixture.counts)}
Timings: fixture ${report.timings.fixtureMs}ms, eval ${report.timings.evalMs}ms, total ${report.timings.totalMs}ms

## Baseline numbers

| metric | value |
|---|---|
| hit@1 (chatty) | ${pct(a.hit1)} |
| hit@3 (chatty) | ${pct(a.hit3)} |
| MRR (chatty) | ${num(a.mrr)} |
| hit@1 (terse) | ${pct(a.hit1Terse)} |
| hit@3 (terse) | ${pct(a.hit3Terse)} |
| MRR (terse) | ${num(a.mrrTerse)} |
| terse/chatty top-3 agreement (mean Jaccard) | ${pct(a.top3AgreementMean)} |
| terse/chatty top-3 exact-set-equal | ${pct(a.top3SetEqualPct)} |
| anchor in both top-3 (expected node ranks <=3 under BOTH phrasings) | ${pct(a.anchorBothTop3Pct)} |
| top-1 equal (terse vs chatty) | ${pct(a.top1EqualPct)} |
| prefix stability chatty (top-10@10 == first10@${report.config.wideMax}) | ${pct(a.prefixStableChattyPct)} |
| prefix stability terse | ${pct(a.prefixStableTersePct)} |
| prefix stability BOTH phrasings | ${pct(a.prefixStableBothPct)} |
| mean pairwise Jaccard of top-10 (unrelated questions) | ${num(a.meanPairwiseJaccard)} |
| gibberish zero-hit rate | ${pct(a.zeroHitGibberishPct)} |
| recall() latency p50 / p90 / p95 / p99 (n=${l.n}) | ${ms(l.p50)} / ${ms(l.p90)} / ${ms(l.p95)} / ${ms(l.p99)} |
| pooled hit@3 (terse+chatty, n=${a.pooledHit3N}) | ${pct(a.pooledHit3)} (${a.pooledHit3Count}/${a.pooledHit3N}) |

## D1 — calibration / abstention (abstain=${report.config.abstain ? 'on' : 'off'}${report.config.relevanceFloor !== null ? `, floor=${report.config.relevanceFloor}` : ''}, gibberish file=${report.config.gibberishFile})

| metric | value |
|---|---|
| real questions abstained (of ${a.realAbstainedN} terse+chatty phrasings) | ${a.realAbstainedCount} |
| exact-identifier rescue overrides (across all sets) | ${a.rescueOverrideCount} |
| gibberish abstained % | ${pct(a.abstainedGibberishPct)} |
| gibberish zero-hit % | ${pct(a.zeroHitGibberishPct)} |
| calibration status(es) seen | ${a.calibration.statuses.join(', ') || 'n/a'} |
| null_median (mean across questions) | ${num(a.calibration.nullMedianMean)} |
| null_scale (mean across questions) | ${num(a.calibration.nullScaleMean)} |
| calibration build cost | fixture ${report.timings.fixtureMs}ms (includes 128-probe fit; single-flight cached across the run) |
| mean recall() latency | ${num(report.timings.meanRecallMs, 1)}ms |
${a.distractors ? `| distractors zero-hit % (n=${a.distractors.n}, no pass bar) | ${pct(a.distractors.zeroHitPct)} |
| distractors abstained % | ${pct(a.distractors.abstainedPct)} |` : ''}
${a.identifiers ? `| identifiers present (n=${a.identifiers.n}) rank1 / hit@3 / found@10 | ${pct(a.identifiers.rank1)} / ${pct(a.identifiers.hit3)} / ${pct(a.identifiers.found10)} |
| identifiers present abstained % / rescued | ${pct(a.identifiers.abstainedPct)} / ${a.identifiers.overriddenCount} |` : ''}
${a.absentIdentifiers ? `| identifiers absent (n=${a.absentIdentifiers.n}, no pass bar) zero-hit % / abstained % / rescued | ${pct(a.absentIdentifiers.zeroHitPct)} / ${pct(a.absentIdentifiers.abstainedPct)} / ${a.absentIdentifiers.overriddenCount} |` : ''}
${a.withQueries ? `| queries[] variant hit@1 / hit@3 / MRR (terse + queries:[chatty]) | ${pct(a.withQueries.hit1)} / ${pct(a.withQueries.hit3)} / ${num(a.withQueries.mrr)} |
| queries[] variant real-abstained % | ${pct(a.withQueries.realAbstainedPct)} |
| queries[] variant gibberish zero-hit % | ${pct(a.withQueries.gibberishZeroHitPct)} |` : ''}

## Real vs. gibberish top_score quantiles

| set | p0 | p10 | p25 | p50 | p75 | p90 | p100 |
|---|---|---|---|---|---|---|---|
${qRow('real (n=' + a.n_questions + ')', q.real)}
${qRow('gibberish (n=' + a.n_gibberish + ')', q.gibberish)}
${a.distractors ? qRow('distractors (n=' + a.distractors.n + ')', a.distractors.topScoreQuantiles) : ''}
${negRows}${idRows}`;
}

main().catch((e) => { console.error(e); process.exit(1); });
