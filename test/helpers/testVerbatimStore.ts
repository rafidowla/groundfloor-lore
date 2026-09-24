/**
 * test/helpers/testVerbatimStore.ts — 3.21 step 2, Opus review follow-up
 * (acceptance: "retrieval-parity and verbatim suites pass on SQLite").
 *
 * `makeVerbatimStore(basePath, embeddingProvider, opts)` constructs the
 * engine selected by `LORE_TEST_VECTOR_ENGINE` ('lance' default, or
 * 'sqlite') with the SAME constructor signature both engines share
 * (VerbatimStore / SqliteVerbatimStore both take
 * `(basePath, embeddingProvider?, opts?: { role?, strictFingerprintCheck? })`
 * — see 3.21 step 2 part 0/1). Every verbatim/retrieval suite that
 * constructs its own store directly (rather than going through the daemon
 * boot path or WorkspaceVerbatimResolver) routes through this instead, so
 * the SAME test body exercises both engines via
 * `LORE_TEST_VECTOR_ENGINE=sqlite npx tsx test/<suite>.ts` — see
 * package.json's `:sqlite` script variants.
 *
 * `LORE_SQLITE_VECTOR_DISABLE_NATIVE` / `LORE_SQLITE_VECTOR_CACHE_MB` (the
 * SqliteVerbatimStore-specific env knobs from part 1) are NOT read here —
 * a suite that wants to force the JS-fallback path sets them directly,
 * same as sqlite-verbatim-store-unit.ts's own `:fallback` variant does.
 *
 * ── Second Opus review pass (2026-09-18) ────────────────────────────────
 * Six of the files originally excluded below were re-examined per the
 * review's explicit finding: several excluded suites test SEMANTICS
 * SqliteVerbatimStore must also honor, not Lance-internal mechanics that
 * genuinely have no SQLite analogue. Each was either routed through this
 * helper (with a per-engine branch where the two engines' on-disk
 * encodings differ) or given a dedicated SQLite-equivalent test, and in
 * three cases the routing surfaced a REAL bug that is now fixed:
 *
 *  - sp13-verbatim-batch-unit.ts — Test B (store()'s skip-identical
 *    contract) is now routed; its `#rev`-id-suffix probe is Lance-only,
 *    so it branches to a getHistory()-row-count probe on SQLite instead.
 *    Test A (outbox consolidation) never touched a VerbatimStore and is
 *    unchanged.
 *  - fc1-verbatim-tombstone-unit.ts — routed. T1.M10b (a real substrate
 *    failure must propagate loudly) now sabotages per engine: Lance's
 *    on-disk table directory vs. closing SQLite's native db handle
 *    directly; SQLite doesn't (yet) wrap the resulting error in a
 *    VerbatimStoreError, so that assertion branches to "a real Error was
 *    thrown, not swallowed" instead. Routing this file surfaced a REAL
 *    bug (T1.M9): SqliteVerbatimStore's store() skip-identical was missing
 *    the metadata-equality check Lance's M9 fix added — a text-identical,
 *    metadata-different re-store silently dropped the metadata change.
 *    Fixed in sqliteVerbatimWrite.ts's store(), which also required fixing
 *    upsertCanonical()/replaceCanonical()'s `updatedAt` default (was
 *    stamping a fresh timestamp when the caller omitted it, permanently
 *    defeating the new metadata check — Lance defaults to `''`, not `now`).
 *  - bm25-envelope-adversarial-unit.ts — Sections A/B never construct a
 *    VerbatimStore (pure function + bare-mock retrieve()) and are
 *    unchanged. Section C's two real-store tests are now routed: the
 *    genuine-zero-match probe uses a corpus-absent nonsense token on
 *    SQLite instead of Lance's stopword-exclusion trick (porter has no
 *    stopword list — a real, documented tokenizer-feature gap, not a bug
 *    this pass fixes); the cross-contamination test corrupts SQLite's FTS5
 *    shadow table via `db.unsafeMode(true)` instead of Lance's on-disk
 *    `_indices` sabotage.
 *  - id-alphabet-roundtrip-unit.ts — routed. Parts A-C are engine-neutral
 *    (bound `?` parameters vs. Lance's escaped string-interpolation both
 *    close the same injection class); two probes needed a per-engine
 *    branch because they read Lance's `#rev`-id-suffix encoding directly
 *    (Part A's snapshot-id assertion; Part C's canonical-set assertion,
 *    fixed to probe listIds() without includeHistory instead of filtering
 *    a combined list). Part D's NUL-byte "loud refusal" has a GENUINE,
 *    verified engine divergence at the store level: Lance's getById calls
 *    assertSafeLanceId (its filter API string-interpolates the id, so a
 *    NUL byte is a real hazard); SqliteVerbatimStore binds the id as a `?`
 *    parameter (verified empirically: better-sqlite3 round-trips a NUL
 *    byte in a TEXT column byte-identically, no hazard to guard against),
 *    so it correctly does NOT reject it — the test now asserts that
 *    documented difference instead of forcing artificial parity. The
 *    nodeUpsert-chokepoint refusals earlier in Part D are unchanged
 *    (assertSafeLanceId runs at the graph/node-service layer regardless of
 *    which verbatim store backs the workspace).
 *  - verbatim-search-cache-unit.ts — this file's original exclusion reason
 *    was WRONG: `ReadCache` (cache.ts) is a generic, already-shared class
 *    (SurrealGraph uses the same one), not a Lance-only mechanism —
 *    SqliteVerbatimStore simply never wrapped search()/bm25Search() with
 *    it. Fixed directly in sqliteVerbatimStore.ts (added the identical
 *    cachedRead()/cacheKey()/epoch-bump pattern VerbatimStore uses, same
 *    env knobs: LORE_SEARCH_CACHE_TTL_MS, LORE_SEARCH_CACHE_MAX_ENTRIES,
 *    LORE_CACHE_DISABLED). This suite now runs UNMODIFIED against both
 *    engines via makeVerbatimStore.
 *  - sp05-injection-unit.ts — its generic VerbatimStore sections (filter-
 *    VALUE escaping, listIds() LIKE-wildcard escaping) are now routed —
 *    both engines close this injection class the same way in spirit (bound
 *    parameters vs. escaped string-interpolation). A NEW, dedicated
 *    SQLite-only section was added (FTS5 MATCH syntax injection: `?`-bound
 *    parameters do NOT protect against FTS5's own query mini-language
 *    parsing the bound STRING VALUE — a hostile/ordinary query containing
 *    `NEAR()`, boolean AND/OR/NOT, a `col:term` filter, a trailing `*`, or
 *    an unbalanced `"` used to be parsed as FTS5 syntax rather than
 *    literal text). Fixed with `escapeFts5Query()` in sqliteVerbatimFts.ts
 *    (quotes every whitespace-split token as an FTS5 string literal before
 *    binding it to MATCH) — a genuine production fix, not just a test.
 *
 * ── Suites deliberately EXCLUDED from parameterization ──────────────────
 * (per the review: "You may EXCLUDE only suites that test LanceDB
 * internals... list every excluded file with a one-line reason"). Every
 * OTHER file that constructs `new VerbatimStore(...)` was mechanically
 * routed through this helper.
 *
 *  - lancedb-ivf-flat-vector-index-unit.ts — IVF_FLAT index-build
 *    mechanics (computeIvfPartitions, KMeans partition counts); SQLite's
 *    vector path is a scalar-function full scan with no ANN index at all
 *    (design section 1.1) — there is no equivalent to build.
 *  - lance-recall-concurrency-unit.ts — LanceTablePool (the read-handle
 *    pool) internals; SqliteVerbatimStore has one connection, no pool.
 *  - index-integrity-heal-unit.ts — Lance-specific index-corruption
 *    self-heal (build markers, listIndices(), dropped IVF/FTS indices);
 *    SQLite has no comparable native-index-corruption failure mode.
 *  - fts-index-and-tokenizer-unit.ts — Lance's own tokenizer-drift
 *    reconcile machinery (detectTokenizerProfile/tokenizerSettingsEqual
 *    sidecar); SQLite's tokenizer reconcile is a separate, already-tested
 *    mechanism (sqlite-verbatim-store-unit.ts's ensureFtsIndex test).
 *  - verbatim-search-worker-e2e.ts / fc1-worker-proxy-delete-unit.ts —
 *    VerbatimSearchWorkerProxy / child-process isolation exists ONLY to
 *    fence a LanceDB native crash; resolveSearchWorkerIsolation always
 *    returns false for a SQLite target (part 1), so a worker is never
 *    spawned for it — nothing to parameterize.
 *  - sp11-bounded-memory-unit.ts — asserts VerbatimStore.hashCache is a
 *    bounded LRU; SqliteVerbatimStore has no hash cache at all
 *    (hashCacheSize() always returns 0 — content-hash lookups read the
 *    indexed content_hash column directly instead).
 *  - nw4b-bm25-cache-singleflight-unit.ts — asserts Lance-specific internal
 *    call-count/cache-key-namespacing details of VerbatimStore's
 *    cachedRead() wrapper (verbatim-search-cache-unit.ts's own cache-hit /
 *    single-flight BEHAVIOR contract is routed and passes on both engines
 *    since SqliteVerbatimStore gained the same cachedRead() wrapper in this
 *    review pass — see above; this file's assertions go deeper into
 *    Lance-internal plumbing than the behavioral contract).
 *  - verbatim-close-releases-natives-unit.ts /
 *    verbatim-close-concurrent-write-stress-unit.ts — LanceDB native
 *    Table/Connection close ordering and a real-native-crash stress run;
 *    SQLite's close() is a plain `db.close()` with no native-handle-drain
 *    hazard (better-sqlite3 is synchronous, no in-flight async native
 *    calls to race — see sqliteVerbatimStore.ts's close() doc comment).
 *  - verbatim-store-role-unit.ts — asserts EXACT LanceTablePool handle
 *    counts (2 for role:'write', 17/18 for role:'read'/'both' at the
 *    default pool size) — entirely Lance-pool-architecture-specific
 *    numbers. SqliteVerbatimStore's role-gating BEHAVIOR (writes refused
 *    under role:'read', reads still served) is already covered engine-
 *    natively by sqlite-verbatim-store-unit.ts's own role test.
 *  - phase6-p4-migrate-and-compact-unit.ts — T7 asserts `lore compact`
 *    reduces LanceDB's on-disk SIZE via fragment/version pruning
 *    (table.optimize()); SqliteVerbatimStore's compact() is a `PRAGMA
 *    optimize` + FTS5 merge with no comparable on-disk-size assertion,
 *    and the migrate CLI under test constructs `new VerbatimStore(...)`
 *    directly in production code (migrateWorkspaceToWorkspace.ts),
 *    unrelated to this test-only helper.
 *  - audit-56-history-id-suffix-unit.ts — regresses a Lance-specific bug
 *    in the `<id>#rev<timestamp>` ID-SUFFIX encoding scheme (a URL
 *    fragment id merely containing "#rev" being misclassified as
 *    history). SqliteVerbatimStore has no id-suffix history encoding —
 *    history is a real `is_canonical` column — so this bug class cannot
 *    recur there. (Its cross-engine listIds()-parity addition, a separate
 *    Opus-review fix, was added directly to this file instead — see that
 *    diff.)
 *  - cloud-slice3-local-harness.ts — a fixed local-vs-cloud (Dataplane)
 *    differential-parity HARNESS module (not a test itself), deliberately
 *    pairing a specific known local configuration (SurrealGraph +
 *    VerbatimStore) to diff REST-route responses against Arcade/cloud —
 *    an unrelated parity axis (local vs. cloud) from lance vs. sqlite;
 *    swapping its engine would not change what it's proving.
 *  - helpers/memory-open-close-cycles-child.ts — already has a dedicated
 *    SQLite counterpart added in part 1
 *    (helpers/sqlite-verbatim-open-close-cycles-child.ts +
 *    sqlite-verbatim-open-close-cycles-unit.ts). Its `resolver` mode also
 *    drives WorkspaceVerbatimResolver, whose engine selection is
 *    out-of-scope (design section 2) for this step.
 */

import { VerbatimStore } from '../../packages/lore/src/engines/verbatimStore.js';
import { SqliteVerbatimStore } from '../../packages/lore/src/engines/sqliteVerbatimStore.js';
import type { EmbeddingProvider } from '../../packages/lore/src/providers/types.js';
import type { VerbatimStoreRole } from '../../packages/lore/src/engines/verbatimStoreRole.js';
import type { VerbatimStoreApi } from '../../packages/lore/src/engines/verbatimStoreApi.js';

export type TestVectorEngine = 'lance' | 'sqlite';

export function testVectorEngine(): TestVectorEngine {
    return process.env.LORE_TEST_VECTOR_ENGINE === 'sqlite' ? 'sqlite' : 'lance';
}

export function makeVerbatimStore(
    basePath: string,
    embeddingProvider?: EmbeddingProvider,
    opts?: { role?: VerbatimStoreRole; strictFingerprintCheck?: boolean },
): VerbatimStoreApi {
    return testVectorEngine() === 'sqlite'
        ? new SqliteVerbatimStore(basePath, embeddingProvider, opts)
        : new VerbatimStore(basePath, embeddingProvider, opts);
}

/** Re-exported so a suite that needs the concrete class (e.g. an
 *  `instanceof` sanity check, or a Lance-only assertion it guards with
 *  `if (testVectorEngine() === 'lance')`) doesn't need a second import. */
export { VerbatimStore, SqliteVerbatimStore };
