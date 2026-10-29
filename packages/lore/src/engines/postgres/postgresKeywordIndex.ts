/**
 * postgresKeywordIndex.ts - additive indexes that make the Postgres engine's
 * keyword search (postgresGraphReads.search) index-served.
 *
 *   idx_nodes_label_trgm    GIN (lower(label)   gin_trgm_ops)   substring match on label
 *   idx_nodes_content_trgm  GIN (lower(content) gin_trgm_ops)   substring match on content
 *   idx_nodes_tags_gin      GIN ((tags::jsonb)  jsonb_path_ops) exact tag membership
 *
 * WORKSPACE-LED GENERATION (Phase 0, shard-ready). Every keyword query is filtered `workspace_id = $1`, so each of the
 * three indexes also exists as `(workspace_id, <expr>)` (btree_gin supplies the text opclass for the leading column):
 *
 *   idx_nodes_ws_label_trgm    GIN (workspace_id, lower(label)   gin_trgm_ops)
 *   idx_nodes_ws_content_trgm  GIN (workspace_id, lower(content) gin_trgm_ops)
 *   idx_nodes_ws_tags_gin      GIN (workspace_id, (tags::jsonb)  jsonb_path_ops)
 *
 * Expand only: both generations are built (CONCURRENTLY, under new names) and the planner may use either. Nothing is
 * dropped at startup. {@link dropLegacyKeywordIndexes} is the explicit CONTRACT step (`lore postgres contract-phase0`),
 * refused unless all three workspace-led indexes are valid. If btree_gin cannot be created the workspace-led indexes are
 * skipped with a warning and the legacy ones keep serving search.
 *
 * Why pg_trgm and not the verbatim store's full-text index: the verbatim FTS is
 * a word-level tsvector on a DIFFERENT table; search() promises case-insensitive
 * SUBSTRING matching on nodes ("auth" finds "oauth2", "tok" finds "token").
 * Word-level FTS cannot do that, so reusing it would shrink the result set.
 * A trigram index accelerates the identical LIKE '%t%' predicate with no
 * semantic change (see postgresKeywordMatch.ts).
 *
 * BUILD POLICY. The background build is `CREATE INDEX CONCURRENTLY` (no write lock) and is
 * idempotent: existing valid indexes are left alone, an INVALID one (a build
 * that was cancelled or crashed) is dropped and rebuilt.
 *   - small table (<= inlineRowLimit rows): built inline during schema
 *     bootstrap with a plain CREATE INDEX (under a second; CONCURRENTLY would
 *     deadlock against the other openers queued on the schema lock);
 *   - large table: NOT built inline. runSchemaBootstrap holds a cluster-wide
 *     advisory lock, waiters on it sit under the 30 s statement timeout, so an
 *     inline multi-minute build would make every other process fail to open.
 *     The graph handle starts it in the background instead (own advisory lock,
 *     own connection under the pool guard, statement_timeout = 0) and searches keep working through
 *     the old scan until it lands. No search or write is ever blocked.
 *
 * STATISTICS TARGET. The planner estimates `lower(col) LIKE '%t%'` from the statistics of the indexed EXPRESSION, which
 * default to ~100 histogram samples and swing about 2x between ANALYZEs. The keyword-plan choice (postgresKeywordPlan.ts)
 * compares those estimates against thresholds, so every trigram index's expression column gets
 * KEYWORD_STATISTICS_TARGET (1000: 300k sampled rows per ANALYZE) via `ALTER INDEX .. ALTER COLUMN n SET STATISTICS`
 * (valid for expression columns only, PG 11+): column 1 on the legacy indexes, column 2 on the workspace-led ones, whose
 * column 1 is the plain `workspace_id` and rejects a statistics target. Applied only when the stored target differs, never fails startup, and followed by
 * an ANALYZE of nodes (inline on a small table, in the background job on a large one) so it takes effect.
 * pg_trgm is a trusted extension (PG 13+); if it cannot be created the label
 * and content indexes are skipped with a warning and search stays correct, just
 * unindexed.
 */
import type { Pool, PoolClient } from 'pg';
import { poolGuardFor } from './postgresPoolGuard.js';

export interface KeywordIndexSpec {
    readonly name: string;
    readonly ddl: string;
    readonly needsTrgm: boolean;
    /** Workspace-led generation (needs btree_gin). The legacy generation is dropped only by {@link dropLegacyKeywordIndexes}. */
    readonly workspaceLed?: boolean;
}

export const KEYWORD_INDEXES: readonly KeywordIndexSpec[] = [
    {
        name: 'idx_nodes_label_trgm',
        ddl: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nodes_label_trgm ON nodes USING gin (lower(label) gin_trgm_ops)',
        needsTrgm: true,
    },
    {
        name: 'idx_nodes_content_trgm',
        ddl: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nodes_content_trgm ON nodes USING gin (lower(content) gin_trgm_ops)',
        needsTrgm: true,
    },
    {
        name: 'idx_nodes_tags_gin',
        ddl: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nodes_tags_gin ON nodes USING gin ((tags::jsonb) jsonb_path_ops)',
        needsTrgm: false,
    },
    {
        name: 'idx_nodes_ws_label_trgm',
        ddl: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nodes_ws_label_trgm ON nodes USING gin (workspace_id, lower(label) gin_trgm_ops)',
        needsTrgm: true,
        workspaceLed: true,
    },
    {
        name: 'idx_nodes_ws_content_trgm',
        ddl: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nodes_ws_content_trgm ON nodes USING gin (workspace_id, lower(content) gin_trgm_ops)',
        needsTrgm: true,
        workspaceLed: true,
    },
    {
        name: 'idx_nodes_ws_tags_gin',
        ddl: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nodes_ws_tags_gin ON nodes USING gin (workspace_id, (tags::jsonb) jsonb_path_ops)',
        needsTrgm: false,
        workspaceLed: true,
    },
];

/** The legacy single-expression indexes, superseded by the workspace-led generation. */
export const LEGACY_KEYWORD_INDEX_NAMES: readonly string[] = KEYWORD_INDEXES.filter((s) => !s.workspaceLed).map((s) => s.name);

/** Arbitrary constant key, distinct from the schema-bootstrap key (7_364_920_117). */
const KEYWORD_BUILD_LOCK_KEY = 7_364_920_118;

/** Tables at or below this many rows get their indexes inline at bootstrap. */
export const DEFAULT_INLINE_ROW_LIMIT = 50_000;

export interface KeywordIndexEnsureResult {
    /** pg_trgm is installed (so the trigram indexes can exist). */
    trgm: boolean;
    /** Index names this call built. */
    built: string[];
    /** Large table with indexes still missing: the caller should start the background build. */
    pending: boolean;
    /** The statistics target changed on a large table: the background job should ANALYZE nodes (see STATISTICS TARGET). */
    analyzePending?: boolean;
}

/** Statistics target of the trigram indexes' expression column (see STATISTICS TARGET in the file header). */
export const KEYWORD_STATISTICS_TARGET = 1000;

/** Index column holding the trigram expression: 2 on the workspace-led generation (column 1 is `workspace_id`), else 1. */
export function keywordIndexExpressionColumn(spec: KeywordIndexSpec): number {
    return spec.workspaceLed ? 2 : 1;
}

/**
 * applyKeywordIndexStatistics - set the statistics target on the trigram indexes that exist. Idempotent (only alters an index
 * whose current target differs), skips missing indexes, and never throws: a failure is logged and search stays correct on the
 * default target. Returns true when at least one index changed (an ANALYZE is then needed for it to take effect).
 */
export async function applyKeywordIndexStatistics(client: Q): Promise<boolean> {
    let changed = false;
    for (const spec of KEYWORD_INDEXES) {
        if (!spec.needsTrgm) continue; // the jsonb tag index is on a plain expression and is exact containment
        const col = keywordIndexExpressionColumn(spec);
        try {
            const cur = await client.query<{ t: number | null }>(
                `SELECT a.attstattarget AS t FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum = $2`, [spec.name, col]);
            if (cur.rows.length === 0) continue; // index missing
            if (cur.rows[0]!.t === KEYWORD_STATISTICS_TARGET) continue;
            await client.query(`ALTER INDEX ${spec.name} ALTER COLUMN ${col} SET STATISTICS ${KEYWORD_STATISTICS_TARGET}`);
            changed = true;
        } catch (err) {
            console.warn(`[PostgresGraph] could not set the statistics target of ${spec.name}: ${(err as Error).message}`);
        }
    }
    return changed;
}

async function analyzeNodes(client: Q): Promise<void> {
    try { await client.query('ANALYZE nodes'); }
    catch (err) { console.warn(`[PostgresGraph] ANALYZE nodes failed: ${(err as Error).message}`); }
}

type Q = Pick<PoolClient, 'query'>;

async function ensureBtreeGin(client: Q): Promise<boolean> {
    try {
        await client.query('CREATE EXTENSION IF NOT EXISTS btree_gin');
        return true;
    } catch (err) {
        console.warn(`[PostgresGraph] btree_gin unavailable (${(err as Error).message}); the workspace-led keyword indexes are skipped and the legacy ones keep serving search.`);
        return false;
    }
}

async function ensureTrgm(client: Q): Promise<boolean> {
    try {
        await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        return true;
    } catch (err) {
        console.warn(`[PostgresGraph] pg_trgm unavailable (${(err as Error).message}); keyword search stays correct but unindexed on label/content.`);
        return false;
    }
}

/** Names of keyword indexes that exist AND are valid. */
export async function validKeywordIndexes(client: Q): Promise<Set<string>> {
    const res = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = ANY($1) AND i.indisvalid AND i.indisready`,
        [KEYWORD_INDEXES.map((s) => s.name)],
    );
    return new Set(res.rows.map((r) => r.relname));
}

/**
 * ensureKeywordIndexes - bootstrap step (runs inside ensureGraphSchema, on the
 * schema-locked client). Cheap when the indexes exist; see the file header for
 * the inline-vs-background split.
 */
export async function ensureKeywordIndexes(
    client: PoolClient,
    opts: { inlineRowLimit?: number } = {},
): Promise<KeywordIndexEnsureResult> {
    const limit = opts.inlineRowLimit ?? DEFAULT_INLINE_ROW_LIMIT;
    const trgm = await ensureTrgm(client);
    const btree = await ensureBtreeGin(client);
    const wanted = KEYWORD_INDEXES.filter((s) => (trgm || !s.needsTrgm) && (btree || !s.workspaceLed));
    const have = await validKeywordIndexes(client);
    const smallTable = async (): Promise<boolean> => {
        const probe = await client.query<{ n: string }>(`SELECT count(*) AS n FROM (SELECT 1 FROM nodes LIMIT ${Math.trunc(limit) + 1}) s`);
        return Number(probe.rows[0]!.n) <= limit;
    };
    if (wanted.every((s) => have.has(s.name))) {
        // Existing indexes (upgrade path): lift the statistics target; ANALYZE inline only when that is cheap.
        const changed = await applyKeywordIndexStatistics(client);
        if (!changed) return { trgm, built: [], pending: false };
        if (await smallTable()) { await analyzeNodes(client); return { trgm, built: [], pending: false }; }
        return { trgm, built: [], pending: false, analyzePending: true };
    }

    if (!(await smallTable())) {
        await applyKeywordIndexStatistics(client); // the indexes that do exist; the background build covers the rest
        return { trgm, built: [], pending: true };
    }

    // Plain CREATE INDEX here, NOT CONCURRENTLY: this runs while holding the schema advisory lock, and a concurrent
    // build waits for every older transaction - including the other openers parked in `pg_advisory_lock` on that
    // very lock - which is a deadlock (seen with 8 concurrent first openers, 40P01). At <= inlineRowLimit rows the
    // plain build takes well under a second and its SHARE lock only briefly holds back writers.
    const built = await buildKeywordIndexes(client, { isCancelled: () => false }, { concurrently: false });
    return { trgm, built: built.built, pending: false };
}

export interface BuildOutcome { built: string[]; failed: string[]; busy: boolean }

/**
 * buildKeywordIndexes - build every missing keyword index on `client` (one
 * session, statement_timeout lifted for the duration). Serialized by a
 * dedicated advisory lock: if another session is already building, returns
 * `busy` and touches nothing (so an index that is INVALID only because that
 * session is mid-build is never dropped from under it).
 */
export async function buildKeywordIndexes(
    client: Q,
    ctl: { isCancelled: () => boolean },
    opts: { concurrently?: boolean; analyze?: boolean } = {},
): Promise<BuildOutcome> {
    const concurrently = opts.concurrently ?? true;
    const ddlOf = (spec: KeywordIndexSpec): string => (concurrently ? spec.ddl : spec.ddl.replace(' CONCURRENTLY', ''));
    const out: BuildOutcome = { built: [], failed: [], busy: false };
    const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [KEYWORD_BUILD_LOCK_KEY]);
    if (!lock.rows[0]!.ok) { out.busy = true; return out; }
    try {
        await client.query('SET statement_timeout = 0');
        const trgmRow = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
        const trgm = (trgmRow.rowCount ?? 0) > 0;
        const btreeRow = await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gin'`);
        const btree = (btreeRow.rowCount ?? 0) > 0;
        for (const spec of KEYWORD_INDEXES) {
            if (ctl.isCancelled()) break;
            if (spec.needsTrgm && !trgm) continue;
            if (spec.workspaceLed && !btree) continue;
            try {
                // A manual ANALYZE/VACUUM on `nodes` can deadlock with CREATE INDEX CONCURRENTLY
                // (40P01, the build is the victim). Retry a couple of times; the invalid leftover is dropped on re-entry.
                for (let attempt = 1; ; attempt++) {
                    const state = await client.query<{ indisvalid: boolean }>(
                        `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1`, [spec.name]);
                    if (state.rows[0]?.indisvalid) break; // already good
                    if (state.rows.length > 0) await client.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF EXISTS ${spec.name}`); // invalid leftover
                    try {
                        await client.query(ddlOf(spec));
                        out.built.push(spec.name);
                        break;
                    } catch (err) {
                        if ((err as { code?: string }).code !== '40P01' || attempt >= 3 || ctl.isCancelled()) throw err;
                    }
                }
            } catch (err) {
                if (ctl.isCancelled()) break; // our own cancel; the leftover INVALID index is cleaned next time
                out.failed.push(spec.name);
                console.warn(`[PostgresGraph] keyword index ${spec.name} not built: ${(err as Error).message}`);
            }
        }
        // Statistics target for the trigram indexes (new ones must have it before their first ANALYZE), then ANALYZE nodes
        // when something was built or the target moved so the planner's LIKE estimates use it.
        if (!ctl.isCancelled()) {
            const changed = await applyKeywordIndexStatistics(client);
            if (changed || out.built.length > 0 || opts.analyze) await analyzeNodes(client);
        }
    } finally {
        try { await client.query('RESET statement_timeout'); } catch { /* connection is discarded by the caller on error */ }
        try { await client.query('SELECT pg_advisory_unlock($1)', [KEYWORD_BUILD_LOCK_KEY]); } catch { /* session end releases it */ }
    }
    return out;
}

/* ── background build, shared per pool ───────────────────────────── */

interface Running {
    done: Promise<void>;
    owners: Set<object>;
    ctl: AbortController;
}
const running = new WeakMap<Pool, Running>();

/**
 * startKeywordIndexBuild - run the build as a guarded background job
 * (postgresPoolGuard.ts: waits for a slot WITHOUT holding a connection, never
 * takes the pool's foreground reserve, statement_timeout unbounded as before)
 * and return a promise that settles when it finishes (never rejects). One build
 * per pool: further owners join the running one. Owners leave via
 * {@link releaseKeywordIndexBuild}; the last one out aborts the job - the guard
 * pg_cancel_backend's the statement - so a closing handle never leaves a
 * multi-minute statement holding the pool open. If the pool is too small to
 * spare a connection the guard skips the job with a warning; search stays
 * correct through the scan path.
 */
export function startKeywordIndexBuild(pool: Pool, owner: object, opts: { analyze?: boolean } = {}): Promise<void> {
    const existing = running.get(pool);
    if (existing) { existing.owners.add(owner); return existing.done; }
    const state: Running = { done: Promise.resolve(), owners: new Set([owner]), ctl: new AbortController() };
    state.done = (async () => {
        try {
            await poolGuardFor(pool).run('keyword-index-build',
                (client) => buildKeywordIndexes(client, { isCancelled: () => state.ctl.signal.aborted }, opts.analyze ? { analyze: true } : {}),
                { signal: state.ctl.signal, timeoutMs: 0 });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!state.ctl.signal.aborted) console.warn(`[PostgresGraph] background keyword index build failed: ${msg}`);
        } finally {
            running.delete(pool);
        }
    })();
    running.set(pool, state);
    return state.done;
}

/** Leave the running build; if no owner remains, cancel it and wait for it to unwind. */
export async function releaseKeywordIndexBuild(pool: Pool | null, owner: object): Promise<void> {
    const state = pool ? running.get(pool) : undefined;
    if (!pool || !state) return;
    state.owners.delete(owner);
    if (state.owners.size > 0) return;
    state.ctl.abort(); // the guard drops a queued job or pg_cancel_backend's a running one
    await state.done;
}

/** The running build's promise for this pool (tests, graceful shutdown). */
export function keywordIndexBuildDone(pool: Pool | null): Promise<void> {
    return (pool ? running.get(pool)?.done : undefined) ?? Promise.resolve();
}

/**
 * CONTRACT step (never run at startup): drop the legacy single-expression keyword indexes once the workspace-led ones are
 * valid. Refuses (drops nothing) unless all three workspace-led indexes exist and are valid. DROP INDEX CONCURRENTLY, so
 * `client` must be autocommit (not inside a transaction) and writers are never blocked.
 */
export async function dropLegacyKeywordIndexes(client: Q): Promise<{ dropped: string[]; refused: string[] }> {
    const have = await validKeywordIndexes(client);
    const missing = KEYWORD_INDEXES.filter((s) => s.workspaceLed && !have.has(s.name)).map((s) => s.name);
    if (missing.length > 0) return { dropped: [], refused: missing.map((n) => `workspace-led index ${n} is missing or invalid`) };
    const dropped: string[] = [];
    for (const n of LEGACY_KEYWORD_INDEX_NAMES) {
        const r = await client.query(`SELECT 1 FROM pg_class WHERE relname = $1 AND relkind = 'i'`, [n]);
        if ((r.rowCount ?? 0) === 0) continue;
        await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${n}`);
        dropped.push(n);
    }
    return { dropped, refused: [] };
}
