/**
 * surrealConnection.ts — embedded SurrealDB lifecycle + schema for Lore.
 *
 * One concern: opening an in-process SurrealDB instance against a workspace
 * directory, applying the graph schema idempotently, and closing it cleanly.
 * No query logic lives here.
 *
 * Deployment shape mirrors Kùzu exactly: an embedded engine (`@surrealdb/node`
 * NAPI addon), one instance per workspace directory, no port, no daemon, no
 * shared server. This is NOT the 2026-04 shared-Docker-server attempt that
 * DECISIONS.md removed — see docs/SURREALDB_BUILD_PLAN.md, "The historical
 * question".
 *
 * Storage backend
 * ---------------
 * `surrealkv://` is the default; `rocksdb://` is selectable via
 * `LORE_SURREAL_BACKEND`. Both are exercised by
 * scripts/diagnostics/surreal-backend-matrix.mjs (open time, throughput,
 * close/reopen, SIGKILL-mid-write recovery) so the choice is evidence-backed
 * and reversible with one env var rather than a code change.
 *
 * Licence
 * -------
 * SurrealDB core is BSL 1.1: embedding is permitted, offering SurrealDB
 * itself as a hosted service is not. The enforcement is
 * storage/surrealLicenceGuard.ts (a runtime throw) plus the D-022 arch rule —
 * this file only ever opens LOCAL, on-disk, in-process instances.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { Surreal } from 'surrealdb';
import { createNodeEngines } from '@surrealdb/node';

import { surrealError } from './surrealError.js';
import {
    EDGE_TABLE,
    FTS_CONTENT_INDEX,
    FTS_LABEL_INDEX,
    NODE_COUNT_VIEW,
    NODE_TABLE,
} from './surrealRecordId.js';

/**
 * The two on-disk engines this build supports. `mem://` is deliberately NOT
 * offered: a graph substrate that silently loses data on restart is a footgun,
 * and the crash-recovery guarantees are the whole point of the evaluation.
 */
export type SurrealBackend = 'surrealkv' | 'rocksdb';

/** Default backend. See the matrix diagnostic for the evidence behind it. */
export const DEFAULT_SURREAL_BACKEND: SurrealBackend = 'surrealkv';

/**
 * Namespace/database inside the embedded instance. Fixed rather than derived
 * from the workspace name: isolation is per-DIRECTORY (one instance per
 * workspace, same as Kùzu's single-writer-per-workspace rule), so a second
 * name axis would add a way to get confinement wrong without adding isolation.
 */
export const SURREAL_NAMESPACE = 'lore';
export const SURREAL_DATABASE = 'graph';

/**
 * resolveSurrealBackend — read `LORE_SURREAL_BACKEND`, falling back to the
 * default. An unrecognised value warns and falls back rather than throwing,
 * matching resolveDeploymentMode's "a typo must not brick the daemon" policy.
 */
export function resolveSurrealBackend(
    raw: string | undefined = process.env['LORE_SURREAL_BACKEND'],
): SurrealBackend {
    if (raw === undefined || raw.trim() === '') return DEFAULT_SURREAL_BACKEND;
    const value = raw.trim().toLowerCase();
    if (value === 'surrealkv' || value === 'rocksdb') return value;
    console.error(
        `[SurrealGraph] Ignoring invalid LORE_SURREAL_BACKEND=${raw} ` +
        `(expected 'surrealkv' or 'rocksdb') — using '${DEFAULT_SURREAL_BACKEND}'`,
    );
    return DEFAULT_SURREAL_BACKEND;
}

/**
 * surrealDataPath — where a workspace's SurrealDB files ACTUALLY live.
 *
 * Sibling of Kùzu's `.lore/graph` and LanceDB's `.lore/lancedb`, so a
 * Surreal-backed workspace is inspectable/backup-able with the same mental
 * model — and so a workspace can hold BOTH engines' data during a Phase-4
 * migration without either clobbering the other.
 *
 * NOT a plain path.join. `openSurreal` below builds the connection string
 * as `${backend}://${dataPath}`, and `@surrealdb/node`/`surrealdb` parse
 * that as a URL internally — silently, with no error and no decode step.
 * Any reserved URL character in the path (a space is the common case: any
 * ancestor directory name containing one, e.g. an operator's "Documents/My
 * Project/") comes out the other side percent-encoded (a space becomes a
 * literal 3-character "%20", not decoded back), and THAT string — not the
 * literal filesystem path — is what the embedded engine creates and reads
 * on disk. A workspace opened this way silently gets a SECOND, empty store
 * at the %20-spelled sibling path while the real data sits inert at the
 * literal path forever; every later open repeats the same split. Confirmed
 * live: `new URL(backend + '://' + literalPath).pathname` predicts the
 * actual on-disk directory exactly, matching what the raw (un-normalized)
 * literal path never does once it contains such a character.
 *
 * `#` and `?` need a manual pre-escape before that `new URL()` call, and
 * every other reserved character does not — because those two are WHATWG
 * URL DELIMITERS (they start the fragment/query components), not merely
 * "unsafe" pathname bytes. `new URL()` percent-encodes an unsafe byte like
 * space/quote/backslash/unicode in place, but a `#` or `?` is parsed as a
 * component boundary and everything after it is silently DROPPED from
 * `.pathname` instead of being escaped. Confirmed live: two workspace paths
 * differing only after a `#` or `?` collapsed onto the identical `.pathname`
 * and therefore the identical on-disk store directory — writes to one
 * workspace were readable from the other. Escaping `#`/`?` to `%23`/`%3F`
 * in `literal` before it ever reaches `new URL()` neutralizes them as
 * delimiters so they survive as literal (percent-encoded) pathname data,
 * exactly like every other reserved character already does.
 *
 * The fix is to stop fighting that and make it Lore's own answer: run the
 * SAME normalization here, once, so this function's return value is what
 * `openSurreal` connects to AND the single source of truth every other
 * reader (`graphStoresOnDisk`, `bannerGraphPath`, backup/restore) must
 * also use — never re-derive `.lore/surreal` by hand elsewhere. For the
 * overwhelmingly common case (no reserved characters anywhere in the
 * path) `new URL(...).pathname` is a byte-identical no-op; this only
 * changes behavior for the paths that were already silently broken.
 */
export function surrealDataPath(basePath: string): string {
    const literal = path.join(basePath, '.lore', 'surreal');
    // `#`/`?` are delimiters, not unsafe bytes — `new URL()` would silently
    // truncate `.pathname` at the first one instead of percent-encoding it
    // (see the doc comment above). Pre-escape only these two so they reach
    // `new URL()` as inert literal text; every other character is already
    // handled correctly by `new URL()` itself and MUST NOT be touched here —
    // doing so would silently relocate already-correct existing on-disk data.
    const escaped = literal.replace(/#/g, '%23').replace(/\?/g, '%3F');
    // Mirror exactly what `openSurreal`'s `${backend}://${dataPath}` connect
    // string will do to this path — see the doc comment above. The backend
    // scheme is irrelevant to path normalization; 'surrealkv' is fixed here
    // rather than threading `resolveSurrealBackend()` through, since both
    // supported backends parse identically as a URL authority+path.
    return new URL(`surrealkv://${escaped}`).pathname;
}

/**
 * Optional accelerations, each independently switchable so any of them can be
 * rolled back with an env var rather than a revert.
 */
export interface SurrealFeatures {
    /**
     * Pre-computed count view (`node_counts`). DEFAULT OFF as of the
     * Kuzu-removal bulk-write investigation (2026-08-21): it is a plain
     * `DEFINE TABLE … AS SELECT … GROUP BY`, it leaks no process handle, and
     * it backfills correctly when defined over existing data — but it does
     * NOT reliably return the same numbers as the live GROUP BY it replaces.
     * Under CONCURRENT writers that share a (project, type) group (the normal
     * case for a bulk ingest into one workspace), surrealdb-core 3.0.2's
     * view-maintenance transactions can commit with a lost update: the write
     * itself lands correctly, but the view's running count silently
     * undercounts, permanently, with no self-healing. Reproduced directly:
     * 300 concurrent distinct-id upserts into one group left the view at
     * 63-64/300 while all 300 node rows were genuinely present. Serial
     * writes, or writers spread across distinct (project, type) groups, are
     * unaffected — the tests in surreal-feature-matrix-unit.ts pin that
     * correctness. On with `LORE_SURREAL_COUNT_VIEW=1` for anyone who wants
     * the read speedup and can guarantee single-writer or per-group-isolated
     * write patterns.
     */
    countView: boolean;
    /**
     * Full-text search indexes. DEFAULT OFF, and it must stay that way unless
     * someone accepts the trade: FTS matches whole WORDS where the current
     * path matches SUBSTRINGS, so `search('kapp')` stops finding `kappa`. That
     * is a deliberate behaviour change, not a tuning knob — see
     * test/surreal-fts-parity-unit.ts for the measured divergence. It also
     * inherits the DEFINE INDEX handle leak. On with `LORE_SURREAL_FTS=1`.
     */
    fts: boolean;
    /** Secondary B-tree indexes. DEFAULT OFF — see INDEX_STATEMENTS. */
    indexes: boolean;
}

/** Read the feature flags from the environment. */
export function resolveSurrealFeatures(env: NodeJS.ProcessEnv = process.env): SurrealFeatures {
    return {
        // Opt-IN: correctness risk under concurrent same-group writers, see
        // the SurrealFeatures.countView doc comment above.
        countView: env['LORE_SURREAL_COUNT_VIEW'] === '1',
        fts: env['LORE_SURREAL_FTS'] === '1',
        indexes: env['LORE_SURREAL_DEFINE_INDEXES'] === '1',
    };
}

export interface SurrealConnectionOptions {
    /** Storage backend; defaults to `resolveSurrealBackend()`. */
    backend?: SurrealBackend;
    /** Feature overrides; defaults to `resolveSurrealFeatures()`. */
    features?: Partial<SurrealFeatures>;
}

export interface SurrealConnection {
    db: Surreal;
    backend: SurrealBackend;
    /** Absolute path of the on-disk store (useful for diagnostics/backup). */
    dataPath: string;
    /** Which accelerations this connection actually applied. */
    features: SurrealFeatures;
}

/**
 * Per-attempt connect timeout, and the total budget across retries.
 *
 * These exist because of a MEASURED defect, not as generic defensiveness:
 * `@surrealdb/node@3.0.3` releases the on-disk directory lock ASYNCHRONOUSLY
 * after `close()` resolves, so an immediate reopen of the same path in the
 * same process blocks — and it blocks by never settling the `connect()`
 * promise, holding no libuv handle. There is no error, no timeout, and no log
 * line: Node just drains its event loop and exits 13
 * ("unsettled top-level await"). A daemon that reopens a workspace would
 * simply stop, silently.
 *
 * Measured on this machine (scripts/diagnostics/surreal-backend-matrix.mjs):
 *   - `surrealkv://` — lock clears in ~500ms; reopen succeeds on attempt 2.
 *   - `rocksdb://`   — lock is NEVER released in-process (still held after 8s
 *                      / 16 attempts). This is why surrealkv is the default.
 *
 * So every open races a timeout and retries within a budget, and exhaustion
 * raises a NAMED error. Slow is recoverable; silent is not.
 */
const OPEN_ATTEMPT_TIMEOUT_MS = 2_000;
const OPEN_TOTAL_BUDGET_MS = 15_000;

function intEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * openSurreal — create `.lore/surreal`, connect the embedded engine, and
 * select the namespace/database.
 *
 * Does NOT apply the schema; callers pair this with {@link applySurrealSchema}
 * so schema application can be retried/awaited independently of connect (the
 * same split LocalGraph has between its constructor and `initialize()`).
 *
 * Never hangs: see the timeout constants above for why that is a hard
 * requirement rather than a nicety.
 */
export async function openSurreal(
    basePath: string,
    opts: SurrealConnectionOptions = {},
): Promise<SurrealConnection> {
    const backend = opts.backend ?? resolveSurrealBackend();
    const features: SurrealFeatures = { ...resolveSurrealFeatures(), ...opts.features };
    const dataPath = surrealDataPath(basePath);
    try {
        fs.mkdirSync(path.dirname(dataPath), { recursive: true });
    } catch (error) {
        // Inside the redaction boundary like every other failure here: a raw
        // ENOENT/EEXIST/EACCES echoes the absolute workspace path, which on a
        // personal machine carries the username and the workspace name.
        throw surrealError(`Failed to prepare the SurrealDB data directory (${backend})`, 'openSurreal', error);
    }

    const attemptTimeoutMs = intEnv('LORE_SURREAL_OPEN_TIMEOUT_MS', OPEN_ATTEMPT_TIMEOUT_MS);
    const budgetMs = intEnv('LORE_SURREAL_OPEN_BUDGET_MS', OPEN_TOTAL_BUDGET_MS);
    const deadline = Date.now() + budgetMs;
    let attempts = 0;
    let lastError: unknown;

    for (let backoffMs = 250; ; backoffMs = Math.min(backoffMs * 2, 1_000)) {
        attempts++;
        const db = new Surreal({ engines: createNodeEngines() });
        try {
            await withTimeout(
                (async () => {
                    await db.connect(`${backend}://${dataPath}`);
                    await db.use({ namespace: SURREAL_NAMESPACE, database: SURREAL_DATABASE });
                })(),
                attemptTimeoutMs,
            );
            return { db, backend, dataPath, features };
        } catch (error) {
            lastError = error;
            // Never leave a half-open native handle behind on a failed open.
            await db.close().catch(() => undefined);
            if (Date.now() + backoffMs >= deadline) break;
            await delay(backoffMs);
        }
    }

    throw surrealError(
        `Failed to open embedded SurrealDB (${backend}) after ${attempts} attempt(s) in ${budgetMs}ms. `
        + 'The most likely cause is another instance holding the directory lock — either a live '
        + 'handle on this workspace that was not closed, or a just-closed one whose lock has not '
        + 'been released yet (the driver releases it asynchronously). Note that rocksdb:// does not '
        + 'release its lock in-process at all; use surrealkv:// for anything that reopens a workspace.',
        'openSurreal',
        lastError,
    );
}

/**
 * Reject after `ms` if `work` has not settled.
 *
 * The timer is deliberately NOT unref'd. The failure being defended against is
 * a `connect()` that never settles AND holds no libuv handle — with an unref'd
 * timer the event loop would still be empty, so Node would exit 13 before the
 * timeout could fire and the guard would do nothing at all. Keeping the timer
 * referenced is what turns a silent exit into a raised error.
 *
 * `Promise.withResolvers` is not available at this package's TS lib target
 * (ES2022), hence the executor form here.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`surreal connect timed out after ${ms}ms`)), ms);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function delay(ms: number): Promise<void> {
    return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/**
 * The graph schema.
 *
 * SCHEMALESS on purpose: Lore Core is a schema-agnostic database, and
 * LocalGraph's own Kùzu table has accreted ~30 `ALTER TABLE ... ADD` migration
 * statements precisely because the column set is not knowable up front. A
 * SCHEMALESS table makes that entire migration ladder a no-op here — a node
 * gaining a field is a write, not a DDL event.
 */
const SCHEMA_STATEMENTS: readonly string[] = [
    `DEFINE TABLE IF NOT EXISTS ${NODE_TABLE} SCHEMALESS`,
    `DEFINE TABLE IF NOT EXISTS ${EDGE_TABLE} TYPE RELATION IN ${NODE_TABLE} OUT ${NODE_TABLE} SCHEMALESS`,
];

/**
 * Secondary indexes — OPT-IN ONLY, and off by default. Two reasons, in order:
 *
 * 1. **`@surrealdb/node@3.0.3` leaks a live libuv handle from the DEFINE INDEX
 *    that actually BUILDS an index, so the host process never exits after
 *    `close()`.** Reproduced on both `surrealkv://` and `rocksdb://`
 *    (scripts/diagnostics/surreal-backend-matrix.mjs, and asserted as a
 *    regression by test/surreal-process-exit-unit.ts). It is specific to the
 *    building DEFINE: a no-op `IF NOT EXISTS` re-DEFINE on an existing index
 *    exits cleanly, and so does normal index-maintained writing. So only the
 *    FIRST boot of a workspace would hang — which is worse than always, not
 *    better, because it hangs exactly once per machine and looks like a fluke.
 *
 * 2. **Parity: LocalGraph has no secondary indexes either.** The Kùzu binding
 *    exposes no CREATE INDEX surface at all (see
 *    migration/adapters/kuzuMigrationAdapter.ts, `addIndex: false` — "kuzu
 *    binding has no CREATE INDEX surface"). Both `search()` and `listNodes()`
 *    are scan-then-sort on Kùzu today. Shipping without indexes is therefore
 *    engine parity, not a regression, and it keeps the Phase-2 comparison
 *    honest (indexed-Surreal vs unindexed-Kùzu would flatter Surreal).
 *
 * `LORE_SURREAL_DEFINE_INDEXES=1` turns them on for the Phase-2 real-scale
 * measurement, where the trade — a hung process at the end of a benchmark run
 * — is acceptable and the latency delta is the number being sought.
 */
const INDEX_STATEMENTS: readonly string[] = [
    `DEFINE INDEX IF NOT EXISTS node_type ON ${NODE_TABLE} FIELDS type`,
    `DEFINE INDEX IF NOT EXISTS node_project ON ${NODE_TABLE} FIELDS project`,
    `DEFINE INDEX IF NOT EXISTS node_ecosystem ON ${NODE_TABLE} FIELDS ecosystem`,
    `DEFINE INDEX IF NOT EXISTS node_updated ON ${NODE_TABLE} FIELDS updatedAt`,
    `DEFINE INDEX IF NOT EXISTS node_superseded ON ${NODE_TABLE} FIELDS supersededBy`,
    `DEFINE INDEX IF NOT EXISTS edge_relation ON ${EDGE_TABLE} FIELDS relation`,
];

/**
 * Pre-computed count view — the fix for `getStats`.
 *
 * `SELECT type, count() … GROUP BY type` is a full table scan: 42.4 ms at
 * 20 000 nodes, 210 ms at 50 000, against Kùzu's 4.4 ms. This view IS that
 * aggregate, maintained by the database as rows are written, so reading it is
 * 0.4 ms and flat in corpus size (measured 106× at 20k).
 *
 * Grouped by (project, type) so ONE view answers both `getStats()` and
 * `getStats(projectFilter)` — the scoped read filters the view, it does not
 * fall back to a scan.
 *
 * Three properties were verified before turning this on by default, because
 * each of them would otherwise be a silent-wrong-answer bug:
 *   1. It BACKFILLS. Defining the view over a table that already has rows
 *      produces the correct counts immediately, so enabling it on an existing
 *      workspace is safe (a view that started empty and only counted
 *      subsequent writes would under-report forever).
 *   2. It is maintained on INSERT, on `UPSERT … MERGE` that changes the
 *      grouped field, and on DELETE — including the engine's delete sequence
 *      (edges by id, then the node), and including deleting the last member
 *      of a group.
 *   3. It leaks no libuv handle, unlike DEFINE INDEX, so the host process
 *      still exits.
 *
 * NOT extended to an edge-count view. That was tried and is BROKEN upstream:
 * a view over the `edge` RELATION table never decrements — deleting an edge
 * leaves the count untouched — and in one combination it panicked the engine
 * outright ("unreachable logic … Deletion for a view but no record exists for
 * that view", surrealdb-core-3.0.2 doc/table.rs:434). The edge count stays a
 * live `count()`, which measured 1.9 ms at 20 000 edges — it was never the
 * expensive half.
 */
const COUNT_VIEW_STATEMENTS: readonly string[] = [
    `DEFINE TABLE IF NOT EXISTS ${NODE_COUNT_VIEW} AS`
    + ` SELECT project, type, count() AS c FROM ${NODE_TABLE} GROUP BY project, type`,
];

/**
 * Full-text search — OPT-IN, and a genuine behaviour change.
 *
 * `FULLTEXT ANALYZER … BM25` is the SurrealDB 3.0.2 spelling; the documented
 * `SEARCH ANALYZER …` form is a parse error on this version.
 *
 * What it buys: the label/content candidate scan drops from 93.4 ms to 19.2 ms
 * at 20 000 nodes (4.9×).
 *
 * What it costs: the analyzer tokenizes, so matching becomes WHOLE-WORD where
 * `string::contains` is SUBSTRING. `search('kapp')` finds `kappa` today and
 * would not with FTS. That breaks set-parity with Kùzu by construction, which
 * is why this cannot be defaulted on — and why the divergence is measured
 * rather than described (test/surreal-fts-parity-unit.ts).
 *
 * Tags are deliberately NOT indexed here. A FULLTEXT index over the tag array
 * would match a WORD inside a multi-word tag, where the contract is exact
 * membership; and a plain index does not help either (measured: `$q IN tags`
 * is 28.6 ms with an index and 28.3 ms without — the planner does not use it).
 * So the tag branch stays an exact-membership query and runs separately.
 */
const FTS_STATEMENTS: readonly string[] = [
    'DEFINE ANALYZER IF NOT EXISTS lore_txt TOKENIZERS class FILTERS lowercase,ascii',
    `DEFINE INDEX IF NOT EXISTS ${FTS_LABEL_INDEX} ON ${NODE_TABLE} FIELDS label FULLTEXT ANALYZER lore_txt BM25`,
    `DEFINE INDEX IF NOT EXISTS ${FTS_CONTENT_INDEX} ON ${NODE_TABLE} FIELDS content FULLTEXT ANALYZER lore_txt BM25`,
];

/**
 * applySurrealSchema — idempotent DDL. Every statement is `IF NOT EXISTS`, so
 * this is safe on every boot and on a store written by an older build.
 */
export async function applySurrealSchema(db: Surreal, features: SurrealFeatures): Promise<void> {
    const statements = [
        ...SCHEMA_STATEMENTS,
        ...(features.countView ? COUNT_VIEW_STATEMENTS : []),
        ...(features.indexes ? INDEX_STATEMENTS : []),
        ...(features.fts ? FTS_STATEMENTS : []),
    ];
    try {
        for (const statement of statements) {
            await db.query(statement);
        }
    } catch (error) {
        throw surrealError('Failed to initialize graph schema', 'initialize', error);
    }
}
