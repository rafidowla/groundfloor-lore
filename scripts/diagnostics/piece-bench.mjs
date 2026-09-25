#!/usr/bin/env node
/**
 * scripts/diagnostics/piece-bench.mjs — D7 (3.23, piece-level vectors)
 * query-latency bench, DESIGN-3.23.md §7.4 ("D7 query latency"):
 *
 *   "Add scripts/diagnostics/piece-bench.mjs, which is D7-owned. It opens
 *   the fixture in-process and runs 200 recall queries warm (after a
 *   20-query warm-up) with pieces off and on. It reports p50 and p90 for
 *   the full retrieve() and for the seed search alone. Run it on SQLite
 *   with the sqlite-vec native path and with the brute-force fallback, and
 *   on Lance. Flag a regression if the SQLite p90 exceeds 2x off."
 *
 * MEASUREMENT ONLY. Nothing here edits packages/lore/src/**.
 *
 * Builds TWO fixtures via recall-eval's shared buildFixture.mjs — one with
 * pieceVectors:false ("off"), one with pieceVectors:true ("on") — same
 * engine/code-rows/embedder otherwise, so the comparison is apples-to-
 * apples on identical corpus content (buildFixture.mjs's fixtureCacheKey
 * already folds pieceVectors into the cache dir, per D7c's runner.mjs
 * change, so this never collides with an off-cache from a prior run).
 *
 * For each fixture, opens it via createLore() and measures two things per
 * query, interleaved:
 *   - "full": `lore.recall(query, {max})` — the whole retrieve() pipeline
 *     (seed search + ecosystem/type gating + fusion + calibration).
 *   - "seed": the seed-search stage ALONE, called directly against the raw
 *     per-workspace VerbatimStore/SqliteVerbatimStore handle (via
 *     lore._daemon.getVerbatimResolver().getOrOpen(WORKSPACE), the same
 *     accessor buildFixture.mjs already uses for the graph registry) —
 *     `store.search(query, max)` when pieces are off, or
 *     `pieceAwareSearch(store, query, max)` (recall/pieceSeedSearch.js,
 *     D7b) when pieces are on. This is deliberately the SAME two calls
 *     retrieveSeedStore.ts's own vectorSeeds/pieceRun closures make in
 *     production (see its `pooledRun`/`pieceRun` for the non-active-boot
 *     workspace branch) — the bench never re-derives its own approximation
 *     of the seed stage.
 *
 * Each configuration (off, on) gets its own 20-query warm-up (discarded)
 * followed by 200 measured queries (`--queries`/`--warmup` to override),
 * built by cycling questions.json's terse+chatty phrasings (48 distinct
 * strings) round-robin up to the requested count — deterministic, no
 * randomness, so repeat runs on the same machine are comparable.
 *
 * IMPORTANT — SQLite has no native fast path for PIECE search. Unlike the
 * canonical/pooled vector column (sqliteVerbatimVector.ts: sqlite-vec
 * native, or JS brute-force via LORE_SQLITE_VECTOR_DISABLE_NATIVE=1),
 * sqlitePieceIndex.ts is JS-brute-force ONLY by design (see its own
 * header: "Piece search is not on D7a's critical path... raw query speed
 * does not yet"). So `--sqlite-vector-path` only changes the "off" (pooled)
 * leg's timing on SQLite — the "on" (piece) leg's seed timing is the same
 * JS brute-force cost either way. This is expected, not a bug in the bench.
 *
 * Usage (SQLite, native pooled-vector path — the default):
 *   node scripts/diagnostics/piece-bench.mjs --engine sqlite \
 *     --embedder real --code-rows 10000 --out results/3.23/piece-bench-sqlite-native.json
 *
 * SQLite, brute-force pooled-vector fallback:
 *   node scripts/diagnostics/piece-bench.mjs --engine sqlite \
 *     --sqlite-vector-path brute-force --embedder real --code-rows 10000 \
 *     --out results/3.23/piece-bench-sqlite-bruteforce.json
 *
 * Lance:
 *   node scripts/diagnostics/piece-bench.mjs --engine surreal-lance \
 *     --embedder real --code-rows 10000 --out results/3.23/piece-bench-lance.json
 *
 * Flags:
 * --engine sqlite | surreal-lance   (graph+vector pair; default sqlite)
 * --sqlite-vector-path native | brute-force
 *                                    (default native; sqlite-only — sets
 *                                    LORE_SQLITE_VECTOR_DISABLE_NATIVE=1 for
 *                                    brute-force before opening either
 *                                    fixture; refused with --engine
 *                                    surreal-lance, since Lance has no such
 *                                    toggle)
 * --embedder real | fake            (real = local ONNX, must already be
 *                                    cached; fake = deterministic hash)
 * --code-rows N                     (default 10000)
 * --queries N                       (measured queries per configuration;
 *                                    default 200)
 * --warmup N                        (discarded warm-up queries per
 *                                    configuration; default 20)
 * --max N                           (recall()/search() result window;
 *                                    default 10, matches the design's
 *                                    "seed search alone" == the same
 *                                    window retrieve() itself asks for)
 * --cache-root PATH                 (fixture build cache; default a
 *                                    mkdtemp under os.tmpdir())
 * --force                           (rebuild both fixtures even on a cache
 *                                    hit)
 * --out PATH                        (JSON report path; also writes PATH
 *                                    with .md instead of .json; if omitted,
 *                                    prints the JSON to stdout only)
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');

if (!process.env.__PIECE_BENCH_REEXEC) {
    const res = spawnSync(
        process.execPath,
        ['--import', 'tsx', SELF, ...process.argv.slice(2)],
        { stdio: 'inherit', cwd: REPO_ROOT, env: { ...process.env, __PIECE_BENCH_REEXEC: '1' } },
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
const SQLITE_VECTOR_PATH = argOf('--sqlite-vector-path', 'native'); // 'native' | 'brute-force'
const EMBEDDER = argOf('--embedder', 'real'); // 'real' | 'fake'
const CODE_ROWS = Number.parseInt(argOf('--code-rows', '10000'), 10);
const N_QUERIES = Number.parseInt(argOf('--queries', '200'), 10);
const N_WARMUP = Number.parseInt(argOf('--warmup', '20'), 10);
const MAX = Number.parseInt(argOf('--max', '10'), 10);
const CACHE_ROOT = argOf('--cache-root', undefined);
const FORCE = hasFlag('--force');
const OUT = argOf('--out', null);

const [graphEngine, vectorEngine] = ENGINE === 'surreal-lance' ? ['surreal', 'lance'] : ['sqlite', 'sqlite'];

if (SQLITE_VECTOR_PATH !== 'native' && SQLITE_VECTOR_PATH !== 'brute-force') {
    console.error(`[piece-bench] --sqlite-vector-path must be 'native' or 'brute-force', got '${SQLITE_VECTOR_PATH}'`);
    process.exit(2);
}
if (SQLITE_VECTOR_PATH === 'brute-force' && ENGINE !== 'sqlite') {
    console.error(`[piece-bench] --sqlite-vector-path brute-force only makes sense with --engine sqlite (got --engine ${ENGINE})`);
    process.exit(2);
}
// Must be set before either fixture's store ever opens (this run's whole
// process, build AND query) — sqliteVerbatimSchema.ts reads this fresh each
// time it tries to load the native module, but only the FIRST open per
// underlying db file actually probes it, so setting it late (after a
// fixture already opened once with native) would not retroactively flip an
// already-built fixture's own pooled-vector index shape. Setting it here,
// before ensureFixture() ever runs, keeps build and query consistent.
if (SQLITE_VECTOR_PATH === 'brute-force') process.env.LORE_SQLITE_VECTOR_DISABLE_NATIVE = '1';

function pct(sorted, p) {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[i];
}

function summarize(ms) {
    const sorted = [...ms].sort((a, b) => a - b);
    return { n: sorted.length, p50: pct(sorted, 50), p90: pct(sorted, 90), min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0 };
}

/** Round-robins questions.json's terse+chatty phrasings up to `count`
 *  strings — deterministic, no randomness. */
function buildQueryPool(questions, count) {
    const phrasings = [];
    for (const q of questions) {
        phrasings.push(q.terse);
        phrasings.push(q.chatty);
    }
    const out = [];
    for (let i = 0; i < count; i++) out.push(phrasings[i % phrasings.length]);
    return out;
}

/** Opens `fixture` via createLore(), runs `queries` (first N_WARMUP
 *  discarded) measuring `lore.recall()` ("full") and the raw seed-search
 *  call ("seed") for each, then disposes. Returns {full, seed} percentile
 *  summaries over the measured (post-warm-up) portion only. */
async function benchFixture(fixture, piecesOn, queries, log) {
    const { createLore } = await import(path.join(REPO_ROOT, 'packages', 'lore', 'src', 'index.js'));
    const createOpts = { deploymentMode: 'embedded', dataDir: fixture.dataDir, ownsProcess: false };
    if (piecesOn) createOpts.pieceVectors = true;
    if (EMBEDDER === 'fake') {
        const { FakeEmbeddingProvider } = await import(path.join(REPO_ROOT, 'scripts', 'diagnostics', 'recall-eval', 'lib', 'fakeEmbeddingProvider.mjs'));
        createOpts.embeddingProvider = new FakeEmbeddingProvider();
    }
    const lore = await createLore(createOpts);

    const resolver = lore._daemon.getVerbatimResolver?.();
    if (!resolver) throw new Error('[piece-bench] lore._daemon.getVerbatimResolver() unavailable — cannot reach the raw store for the seed-alone measurement');
    const { WORKSPACE } = await import(path.join(REPO_ROOT, 'scripts', 'diagnostics', 'recall-eval', 'lib', 'corpus.mjs'));
    const store = await resolver.getOrOpen(WORKSPACE);

    let pieceAwareSearch;
    if (piecesOn) {
        ({ pieceAwareSearch } = await import(path.join(REPO_ROOT, 'packages', 'lore', 'src', 'recall', 'pieceSeedSearch.js')));
        const status = typeof store.pieceIndexStatus === 'function' ? store.pieceIndexStatus() : null;
        if (!status?.open || !status?.valid) {
            throw new Error(`[piece-bench] pieces-on fixture's piece index is not open+valid (${JSON.stringify(status)}) — the "on" measurement would silently be measuring an empty index`);
        }
    }

    const fullMs = [];
    const seedMs = [];
    for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const warmingUp = i < N_WARMUP;

        const t0 = process.hrtime.bigint();
        await lore.recall(q, { max: MAX });
        const t1 = process.hrtime.bigint();

        const s0 = process.hrtime.bigint();
        if (piecesOn) await pieceAwareSearch(store, q, MAX);
        else await store.search(q, MAX);
        const s1 = process.hrtime.bigint();

        if (!warmingUp) {
            fullMs.push(Number(t1 - t0) / 1e6);
            seedMs.push(Number(s1 - s0) / 1e6);
        }
        if (!warmingUp && (i - N_WARMUP + 1) % 50 === 0) {
            log(`[piece-bench] pieces=${piecesOn ? 'on' : 'off'} measured ${i - N_WARMUP + 1}/${queries.length - N_WARMUP}`);
        }
    }

    await lore.dispose('piece-bench-done');
    return { full: summarize(fullMs), seed: summarize(seedMs) };
}

async function main() {
    const log = (...a) => console.error(...a);
    const { ensureFixture } = await import(path.join(REPO_ROOT, 'scripts', 'diagnostics', 'recall-eval', 'lib', 'buildFixture.mjs'));
    const questions = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'diagnostics', 'recall-eval', 'questions.json'), 'utf8'));
    const pool = buildQueryPool(questions, N_WARMUP + N_QUERIES);

    log(`[piece-bench] engine=${ENGINE} sqliteVectorPath=${ENGINE === 'sqlite' ? SQLITE_VECTOR_PATH : 'n/a'} embedder=${EMBEDDER} codeRows=${CODE_ROWS} warmup=${N_WARMUP} queries=${N_QUERIES}`);

    log('[piece-bench] building/reusing OFF fixture (pieceVectors:false)...');
    const offFixture = await ensureFixture({
        graphEngine, vectorEngine, codeRowCount: CODE_ROWS, embedder: EMBEDDER,
        pieceVectors: false, cacheRoot: CACHE_ROOT, force: FORCE, log,
    });
    log('[piece-bench] building/reusing ON fixture (pieceVectors:true)...');
    const onFixture = await ensureFixture({
        graphEngine, vectorEngine, codeRowCount: CODE_ROWS, embedder: EMBEDDER,
        pieceVectors: true, cacheRoot: CACHE_ROOT, force: FORCE, log,
    });

    log('[piece-bench] running OFF configuration...');
    const off = await benchFixture(offFixture, false, pool, log);
    log('[piece-bench] running ON configuration...');
    const on = await benchFixture(onFixture, true, pool, log);

    // Design's regression gate — SQLite only, both metrics (the design text
    // names p90 generically; applying it to both full and seed is the
    // conservative reading, and costs nothing extra since both are already
    // measured).
    const regressions = [];
    if (ENGINE === 'sqlite') {
        if (off.full.p90 > 0 && on.full.p90 > 2 * off.full.p90) {
            regressions.push(`full retrieve() p90 regression: on=${on.full.p90.toFixed(2)}ms > 2x off=${off.full.p90.toFixed(2)}ms`);
        }
        if (off.seed.p90 > 0 && on.seed.p90 > 2 * off.seed.p90) {
            regressions.push(`seed search p90 regression: on=${on.seed.p90.toFixed(2)}ms > 2x off=${off.seed.p90.toFixed(2)}ms`);
        }
    }

    const report = {
        generatedAt: new Date().toISOString(),
        config: {
            engine: ENGINE, graphEngine, vectorEngine,
            sqliteVectorPath: ENGINE === 'sqlite' ? SQLITE_VECTOR_PATH : null,
            embedder: EMBEDDER, codeRows: CODE_ROWS, warmup: N_WARMUP, queries: N_QUERIES, max: MAX,
        },
        fixtures: {
            off: { dataDir: offFixture.dataDir, reused: offFixture.reused, counts: offFixture.counts },
            on: { dataDir: onFixture.dataDir, reused: onFixture.reused, counts: onFixture.counts },
        },
        results: { off, on },
        regressionGate: ENGINE === 'sqlite' ? { checked: true, threshold: '2x', regressions } : { checked: false, reason: 'gate is SQLite-only per DESIGN-3.23.md §7.4' },
    };

    const json = JSON.stringify(report, null, 2);
    if (OUT) {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(OUT, json);
        const md = renderMarkdown(report);
        fs.writeFileSync(OUT.replace(/\.json$/, '.md'), md);
        log(`[piece-bench] wrote ${OUT} and ${OUT.replace(/\.json$/, '.md')}`);
    } else {
        console.log(json);
    }

    if (regressions.length) {
        log(`[piece-bench] REGRESSION: ${regressions.join('; ')}`);
        process.exitCode = 1;
    } else {
        log('[piece-bench] no regression flagged.');
    }
}

function renderMarkdown(report) {
    const { config, fixtures, results, regressionGate } = report;
    const row = (label, s) => `| ${label} | ${s.n} | ${s.p50.toFixed(2)} | ${s.p90.toFixed(2)} | ${s.min.toFixed(2)} | ${s.max.toFixed(2)} |`;
    return [
        `# D7 piece-vector query-latency bench`,
        ``,
        `Generated: ${report.generatedAt}`,
        ``,
        `Config: engine=${config.engine} sqliteVectorPath=${config.sqliteVectorPath ?? 'n/a'} embedder=${config.embedder} codeRows=${config.codeRows} warmup=${config.warmup} queries=${config.queries} max=${config.max}`,
        ``,
        `Fixtures: off=${fixtures.off.dataDir} (reused=${fixtures.off.reused}) on=${fixtures.on.dataDir} (reused=${fixtures.on.reused})`,
        ``,
        `## Latency (ms)`,
        ``,
        `| leg | n | p50 | p90 | min | max |`,
        `|---|---|---|---|---|---|`,
        row('off / full retrieve()', results.off.full),
        row('off / seed search alone', results.off.seed),
        row('on / full retrieve()', results.on.full),
        row('on / seed search alone', results.on.seed),
        ``,
        `## Regression gate`,
        ``,
        regressionGate.checked
            ? (regressionGate.regressions.length
                ? regressionGate.regressions.map((r) => `- FLAGGED: ${r}`).join('\n')
                : '- none (SQLite p90 within 2x off for both legs)')
            : `- not checked (${regressionGate.reason})`,
        ``,
    ].join('\n');
}

main().catch((e) => { console.error('[piece-bench] FAILED:', e); process.exit(1); });
