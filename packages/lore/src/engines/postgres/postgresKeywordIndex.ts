/**
 * postgresKeywordIndex.ts - additive indexes that make the Postgres engine's
 * keyword search (postgresGraphReads.search) index-served.
 *
 *   idx_nodes_label_trgm    GIN (lower(label)   gin_trgm_ops)   substring match on label
 *   idx_nodes_content_trgm  GIN (lower(content) gin_trgm_ops)   substring match on content
 *   idx_nodes_tags_gin      GIN ((tags::jsonb)  jsonb_path_ops) exact tag membership
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
 * pg_trgm is a trusted extension (PG 13+); if it cannot be created the label
 * and content indexes are skipped with a warning and search stays correct, just
 * unindexed.
 */
import type { Pool, PoolClient } from 'pg';
import { poolGuardFor } from './postgresPoolGuard.js';

export interface KeywordIndexSpec { readonly name: string; readonly ddl: string; readonly needsTrgm: boolean }

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
];

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
}

type Q = Pick<PoolClient, 'query'>;

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
    const wanted = KEYWORD_INDEXES.filter((s) => trgm || !s.needsTrgm);
    const have = await validKeywordIndexes(client);
    if (wanted.every((s) => have.has(s.name))) return { trgm, built: [], pending: false };

    const probe = await client.query<{ n: string }>(`SELECT count(*) AS n FROM (SELECT 1 FROM nodes LIMIT ${Math.trunc(limit) + 1}) s`);
    if (Number(probe.rows[0]!.n) > limit) return { trgm, built: [], pending: true };

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
    opts: { concurrently?: boolean } = {},
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
        for (const spec of KEYWORD_INDEXES) {
            if (ctl.isCancelled()) break;
            if (spec.needsTrgm && !trgm) continue;
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
export function startKeywordIndexBuild(pool: Pool, owner: object): Promise<void> {
    const existing = running.get(pool);
    if (existing) { existing.owners.add(owner); return existing.done; }
    const state: Running = { done: Promise.resolve(), owners: new Set([owner]), ctl: new AbortController() };
    state.done = (async () => {
        try {
            await poolGuardFor(pool).run('keyword-index-build',
                (client) => buildKeywordIndexes(client, { isCancelled: () => state.ctl.signal.aborted }),
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
