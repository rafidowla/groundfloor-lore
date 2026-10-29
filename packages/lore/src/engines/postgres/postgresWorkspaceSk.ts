/**
 * postgresWorkspaceSk.ts - Postgres engine: make `nodes.sk` unique PER WORKSPACE (Phase 0 / L1 of the shard-ready
 * data model) and move every structure that depends on it to a workspace-led key.
 *
 * WHY. `sk` is an identity column, so today it also happens to be unique across the database. That accident is
 * not an invariant: a restore shifts `sk` only when it overlaps, a workspace moved to another database or shard
 * keeps its own values, and a sharded cluster has one sequence per shard. Every join and foreign key that named
 * `sk` alone would then match the wrong workspace's node. The invariant is now `UNIQUE (workspace_id, sk)` and
 * every consumer names both columns.
 *
 * WHAT THIS FILE BUILDS (expand step; all additive, all idempotent):
 *   1. `nodes_workspace_sk_key`   UNIQUE INDEX on nodes (workspace_id, sk), then promoted to a UNIQUE constraint of
 *                                 the same name with `ADD CONSTRAINT ... UNIQUE USING INDEX`
 *   2. `idx_edges_ws_dst_sk`      edges (workspace_id, dst_sk): the reverse-direction index the scoped joins use
 *   3. `lore_entity_workspace_node_fkey`   composite FK (workspace_id, memory_node_sk) -> nodes (workspace_id, sk)
 *                                 ON DELETE SET NULL (memory_node_sk)  [PostgreSQL 15+: the column list keeps the
 *                                 NOT NULL workspace_id out of the SET NULL], added NOT VALID then VALIDATEd
 *   4. `lore_entity_ws_node_sk_idx`   lore_entity (workspace_id, memory_node_sk), partial on NOT NULL
 *
 * The database-wide `idx_nodes_sk`, `idx_edges_dst_sk` and lore_entity's single-column FK / index are KEPT: an
 * older build running against the same database still plans with them. {@link dropGlobalSkIndexes} is the
 * CONTRACT step that removes them; it is never called at startup (see `lore postgres drop-global-sk-indexes`).
 *
 * BUILD POLICY. Same split as postgresKeywordIndex.ts, for the same reason: bootstrap holds the cluster-wide
 * schema advisory lock, and `CREATE INDEX CONCURRENTLY` waits for every older transaction - including the other
 * openers parked on that very lock - which deadlocks.
 *   - table small (<= inlineRowLimit rows): built inline with a plain CREATE INDEX (well under a second);
 *   - table large: NOT built inline. {@link ensureWorkspaceSk} reports `pending` and the graph handle starts
 *     {@link startWorkspaceSkBuild}: a guarded background job (own advisory lock, own connection,
 *     statement_timeout unbounded) running `CREATE INDEX CONCURRENTLY`. Reads and writes keep working the whole
 *     time: the scoped joins are correct without the new indexes (they use the old ones and filter), only slower.
 * An INVALID index left by a cancelled or crashed concurrent build is dropped and rebuilt; because it also looks
 * INVALID while another session is still building it, every build takes {@link BUILD_LOCK_KEY} first and a busy
 * lock means "someone else is on it".
 */
import type { Pool, PoolClient } from 'pg';
import {
    EDGES_WS_DST_SK_INDEX, GLOBAL_SK_INDEXES, NODES_WORKSPACE_SK_INDEX, workspaceSkIndexDdl, workspaceSkIndexSpecs,
    type WorkspaceSkIndexSpec,
} from './postgresEdgeSchema.js';
import { poolGuardFor } from './postgresPoolGuard.js';
import { FIELD_INDEX_HASH_LEN } from './postgresFieldIndexName.js';

type Q = Pick<PoolClient, 'query'>;

/** lore_entity's composite FK to nodes (workspace_id, sk). */
export const ENTITY_NODE_FK = 'lore_entity_workspace_node_fkey';
/** lore_entity (workspace_id, memory_node_sk), partial on NOT NULL. */
export const ENTITY_NODE_IDX = 'lore_entity_ws_node_sk_idx';
/** The single-column FK to nodes (sk) that older builds created; dropped by the contract step. */
export const LEGACY_ENTITY_NODE_FK = 'lore_entity_memory_node_sk_fkey';
/** The single-column index older builds created on lore_entity (memory_node_sk); dropped by the contract step. */
export const LEGACY_ENTITY_NODE_IDX = 'lore_entity_node_sk_idx';

/** Tables at or below this many rows get their structures inline at bootstrap. */
export const WORKSPACE_SK_INLINE_ROW_LIMIT = 50_000;
/** Advisory lock for the (re)build, distinct from the schema (…117) and keyword (…118) keys. */
const BUILD_LOCK_KEY = 7_364_920_141;
const LOCK_TIMEOUT = '10s';

const ENTITY = 'lore_entity';

type IdxStatus = 'valid' | 'invalid' | 'absent';
type FkStatus = 'valid' | 'not_valid' | 'absent';

export interface WorkspaceSkState {
    nodesIndex: IdxStatus;
    /** `UNIQUE (workspace_id, sk)` exists as a constraint on nodes. */
    nodesConstraint: boolean;
    edgesIndex: IdxStatus;
    entityTable: boolean;
    entityFk: FkStatus;
    entityIndex: IdxStatus;
    legacyEntityFk: boolean;
    /** Nothing left to build. */
    complete: boolean;
}

const idxCase = (name: string): string => `(SELECT CASE WHEN i.indisvalid AND i.indisready THEN 'valid' ELSE 'invalid' END
        FROM pg_index i WHERE i.indexrelid = to_regclass('${name}'))`;
const fkCase = (name: string): string => `(SELECT CASE WHEN c.convalidated THEN 'valid' ELSE 'not_valid' END
        FROM pg_constraint c WHERE c.conname = '${name}' AND c.conrelid = to_regclass('${ENTITY}'))`;

/** One catalog round trip: where every structure of the expand step stands. */
export async function readWorkspaceSkState(q: Q): Promise<WorkspaceSkState> {
    const r = await q.query<{
        nodes_index: string | null; nodes_constraint: boolean; edges_index: string | null; entity_table: boolean;
        entity_fk: string | null; entity_index: string | null; legacy_fk: boolean;
    }>(`SELECT ${idxCase(NODES_WORKSPACE_SK_INDEX)} AS nodes_index,
               EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${NODES_WORKSPACE_SK_INDEX}' AND conrelid = to_regclass('nodes')) AS nodes_constraint,
               ${idxCase(EDGES_WS_DST_SK_INDEX)} AS edges_index,
               to_regclass('${ENTITY}') IS NOT NULL AS entity_table,
               ${fkCase(ENTITY_NODE_FK)} AS entity_fk,
               ${idxCase(ENTITY_NODE_IDX)} AS entity_index,
               EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${LEGACY_ENTITY_NODE_FK}' AND conrelid = to_regclass('${ENTITY}')) AS legacy_fk`);
    const row = r.rows[0]!;
    const idx = (v: string | null): IdxStatus => (v === 'valid' ? 'valid' : v === 'invalid' ? 'invalid' : 'absent');
    const fk = (v: string | null): FkStatus => (v === 'valid' ? 'valid' : v === 'not_valid' ? 'not_valid' : 'absent');
    const s: Omit<WorkspaceSkState, 'complete'> = {
        nodesIndex: idx(row.nodes_index), nodesConstraint: row.nodes_constraint, edgesIndex: idx(row.edges_index),
        entityTable: row.entity_table, entityFk: fk(row.entity_fk), entityIndex: idx(row.entity_index), legacyEntityFk: row.legacy_fk,
    };
    const nodesDone = s.nodesIndex === 'valid' && s.nodesConstraint;
    const entityDone = !s.entityTable || (s.entityFk === 'valid' && s.entityIndex === 'valid');
    return { ...s, complete: nodesDone && s.edgesIndex === 'valid' && entityDone };
}

/** True when the expand step still has something to build (cheap: one catalog query). */
export async function workspaceSkPending(q: Q): Promise<boolean> {
    return !(await readWorkspaceSkState(q)).complete;
}

async function smallEnough(q: Q, table: string, limit: number): Promise<boolean> {
    const r = await q.query<{ n: string }>(`SELECT count(*) AS n FROM (SELECT 1 FROM ${table} LIMIT ${Math.trunc(limit) + 1}) s`);
    return Number(r.rows[0]!.n) <= limit;
}

const sqlState = (err: unknown): string => (err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '');

/** Build one index; an INVALID leftover is dropped first. Returns true when it built. */
async function buildIndex(q: Q, name: string, ddl: string, concurrently: boolean, ctl: BuildControl): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
        const st = (await q.query<{ v: string | null }>(
            `SELECT ${idxCase(name)} AS v`)).rows[0]!.v;
        if (st === 'valid') return false;
        if (st === 'invalid') await q.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF EXISTS ${name}`);
        try {
            await q.query(ddl);
            return true;
        } catch (err) {
            // A manual ANALYZE/VACUUM can deadlock with CREATE INDEX CONCURRENTLY (the build is the victim): retry.
            if (sqlState(err) !== '40P01' || attempt >= 3 || ctl.isCancelled()) throw err;
        }
    }
}

export interface BuildControl { isCancelled: () => boolean }

export interface BuildOutcome { built: string[]; failed: string[]; skipped: string[]; busy: boolean }

interface BuildOptions {
    /** Plain CREATE INDEX (inline bootstrap) vs CREATE INDEX CONCURRENTLY (background / admin). */
    concurrently: boolean;
    /** Inline mode: skip a step whose table has more than this many rows (the background job does it). */
    inlineRowLimit?: number;
}

/**
 * Build every missing structure of the expand step on `q` (one session). Never throws for a step that fails: the
 * failure is logged, reported in `failed`, and the step is retried on the next open. Serialized by
 * {@link BUILD_LOCK_KEY}; a busy lock returns `busy` and touches nothing.
 */
export async function buildWorkspaceSk(q: Q, ctl: BuildControl, opts: BuildOptions): Promise<BuildOutcome> {
    const out: BuildOutcome = { built: [], failed: [], skipped: [], busy: false };
    const lock = await q.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [BUILD_LOCK_KEY]);
    if (!lock.rows[0]!.ok) { out.busy = true; return out; }
    const limit = opts.inlineRowLimit;
    const gate = async (label: string, table: string): Promise<boolean> => {
        if (limit !== undefined && !(await smallEnough(q, table, limit))) { out.skipped.push(label); return false; }
        return true;
    };
    const run = async (label: string, fn: () => Promise<boolean | void>): Promise<boolean> => {
        if (ctl.isCancelled()) return false;
        try {
            if ((await fn()) !== false) out.built.push(label);
            return true;
        } catch (err) {
            if (ctl.isCancelled()) return false; // our own cancel; leftovers are cleaned on the next run
            out.failed.push(label);
            console.warn(`[PostgresGraph] workspace-sk step ${label} not completed: ${(err as Error).message}`);
            return false;
        }
    };
    try {
        await q.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
        const specs = workspaceSkIndexSpecs();
        for (const spec of specs) {
            if (!(await gate(spec.name, spec.table))) continue;
            await run(spec.name, () => buildIndex(q, spec.name, workspaceSkIndexDdl(spec, opts.concurrently), opts.concurrently, ctl));
        }
        let state = await readWorkspaceSkState(q);
        if (state.nodesIndex === 'valid' && !state.nodesConstraint) {
            await run(`${NODES_WORKSPACE_SK_INDEX} (constraint)`, async () => {
                await q.query(`ALTER TABLE nodes ADD CONSTRAINT ${NODES_WORKSPACE_SK_INDEX} UNIQUE USING INDEX ${NODES_WORKSPACE_SK_INDEX}`);
            });
        }
        state = await readWorkspaceSkState(q);
        if (state.entityTable && state.nodesIndex === 'valid') {
            if (await gate(ENTITY_NODE_IDX, ENTITY)) {
                await run(ENTITY_NODE_IDX, () => buildIndex(q, ENTITY_NODE_IDX, entityIndexDdl(opts.concurrently), opts.concurrently, ctl));
            }
            if (state.entityFk === 'absent') {
                await run(ENTITY_NODE_FK, async () => { await q.query(entityNodeFkDdl()); });
            }
            if ((await readWorkspaceSkState(q)).entityFk === 'not_valid' && await gate(`${ENTITY_NODE_FK} (validate)`, ENTITY)) {
                await run(`${ENTITY_NODE_FK} (validate)`, async () => { await q.query(`ALTER TABLE ${ENTITY} VALIDATE CONSTRAINT ${ENTITY_NODE_FK}`); });
            }
        }
    } finally {
        try { await q.query('RESET lock_timeout'); } catch { /* the caller discards a broken connection */ }
        try { await q.query('SELECT pg_advisory_unlock($1)', [BUILD_LOCK_KEY]); } catch { /* session end releases it */ }
    }
    return out;
}

function entityIndexDdl(concurrently: boolean): string {
    return `CREATE INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF NOT EXISTS ${ENTITY_NODE_IDX} ON ${ENTITY} (workspace_id, memory_node_sk) WHERE memory_node_sk IS NOT NULL`;
}

/** The composite FK, NOT VALID so adding it never scans (new rows are checked from now on; VALIDATE runs separately). */
function entityNodeFkDdl(): string {
    return `ALTER TABLE ${ENTITY} ADD CONSTRAINT ${ENTITY_NODE_FK} FOREIGN KEY (workspace_id, memory_node_sk) `
        + 'REFERENCES nodes (workspace_id, sk) ON DELETE SET NULL (memory_node_sk) NOT VALID';
}

export interface WorkspaceSkEnsureResult {
    /** Large tables left for the background build: the caller should start it. */
    pending: boolean;
    built: string[];
}

/**
 * ensureWorkspaceSk - bootstrap step (runs on the schema-locked client, from ensureGraphSchema and again from the
 * table-storage bootstrap once lore_entity exists). Cheap when everything is already built. Builds inline what is
 * small; reports `pending` for what is large. Never throws for a step that fails (it is retried next open).
 */
export async function ensureWorkspaceSk(client: Q, opts: { inlineRowLimit?: number } = {}): Promise<WorkspaceSkEnsureResult> {
    const state = await readWorkspaceSkState(client);
    if (state.complete) return { pending: false, built: [] };
    const out = await buildWorkspaceSk(client, { isCancelled: () => false }, {
        concurrently: false, inlineRowLimit: opts.inlineRowLimit ?? WORKSPACE_SK_INLINE_ROW_LIMIT,
    });
    return { pending: await workspaceSkPending(client), built: out.built };
}

/* ── background build, shared per pool ───────────────────────────── */

interface Running { done: Promise<void>; owners: Set<object>; ctl: AbortController }
const running = new WeakMap<Pool, Running>();

/**
 * startWorkspaceSkBuild - run the concurrent build as a guarded background job (postgresPoolGuard.ts: waits for a
 * slot without holding a connection, statement_timeout unbounded) and return a promise that settles when it is done
 * (never rejects). One build per pool; further owners join it. The last owner out aborts it. If the pool is too
 * small to spare a connection the guard skips the job with a warning and the next open retries.
 */
export function startWorkspaceSkBuild(pool: Pool, owner: object): Promise<void> {
    const existing = running.get(pool);
    if (existing) { existing.owners.add(owner); return existing.done; }
    const state: Running = { done: Promise.resolve(), owners: new Set([owner]), ctl: new AbortController() };
    state.done = (async () => {
        try {
            await poolGuardFor(pool).run('workspace-sk-build',
                async (client) => {
                    if (!(await workspaceSkPending(client))) return;
                    await buildWorkspaceSk(client, { isCancelled: () => state.ctl.signal.aborted }, { concurrently: true });
                },
                { signal: state.ctl.signal, timeoutMs: 0 });
        } catch (err) {
            if (!state.ctl.signal.aborted) console.warn(`[PostgresGraph] background workspace-sk build failed: ${(err as Error).message}`);
        } finally {
            running.delete(pool);
        }
    })();
    running.set(pool, state);
    return state.done;
}

/** Leave the running build; if no owner remains, cancel it and wait for it to unwind. */
export async function releaseWorkspaceSkBuild(pool: Pool | null, owner: object): Promise<void> {
    const state = pool ? running.get(pool) : undefined;
    if (!pool || !state) return;
    state.owners.delete(owner);
    if (state.owners.size > 0) return;
    state.ctl.abort();
    await state.done;
}

/** The running build's promise for this pool (tests, graceful shutdown). */
export function workspaceSkBuildDone(pool: Pool | null): Promise<void> {
    return (pool ? running.get(pool)?.done : undefined) ?? Promise.resolve();
}

/* ── contract step ───────────────────────────────────────────────── */

export interface GlobalSkContractReport {
    /** Objects dropped (or, with dryRun, that would be dropped), in order. */
    dropped: string[];
    /** Set when the guard refused: nothing was dropped. */
    refused: string | null;
    dryRun: boolean;
}

const OLD_FIELD_INDEX = /^lore_ev_\d+_[ui]$/;

/**
 * dropGlobalSkIndexes - the CONTRACT step of the per-workspace `sk` change. Drops what only the database-wide
 * uniqueness needed, once the workspace-led replacements exist and are valid:
 *
 *   - `idx_nodes_sk` and `idx_edges_dst_sk`
 *   - lore_entity's single-column FK (`lore_entity_memory_node_sk_fkey`, which depends on idx_nodes_sk) and index
 *     (`lore_entity_node_sk_idx`)
 *   - the D10 per-field indexes under their old names (`lore_ev_<fieldId>_u|_i`), for every field whose
 *     workspace-led `lore_ev_<hash>_<fieldId>_u|_i` exists and is valid
 *
 * REFUSES (drops nothing) unless `UNIQUE (workspace_id, sk)` exists as a valid constraint, `idx_edges_ws_dst_sk` is
 * valid, and - when lore_entity exists - its composite FK is valid, and no other foreign key still depends on
 * `idx_nodes_sk`. NEVER called at startup: after it runs, startup does not recreate the dropped indexes (the
 * constraint's presence turns that off, see nodesSurrogateKeyDdl). Do not run it while a Lore build older than the
 * one that created the workspace-led indexes is still using the database. DROP INDEX CONCURRENTLY cannot run in a
 * transaction, so `client` must be in autocommit mode (a plain pooled client is).
 */
export async function dropGlobalSkIndexes(client: Q, opts: { dryRun?: boolean } = {}): Promise<GlobalSkContractReport> {
    const dryRun = opts.dryRun === true;
    const report: GlobalSkContractReport = { dropped: [], refused: null, dryRun };
    const refuse = (why: string): GlobalSkContractReport => { report.refused = why; return report; };

    const st = await readWorkspaceSkState(client);
    if (st.nodesIndex !== 'valid' || !st.nodesConstraint) return refuse(`UNIQUE (workspace_id, sk) on nodes (${NODES_WORKSPACE_SK_INDEX}) is not built and valid yet; open a workspace on this build and let startup finish`);
    if (st.edgesIndex !== 'valid') return refuse(`${EDGES_WS_DST_SK_INDEX} is not built and valid yet; open a workspace on this build and let startup finish`);
    if (st.entityTable && (st.entityFk !== 'valid' || st.entityIndex !== 'valid')) {
        return refuse(`${ENTITY} still lacks a valid ${ENTITY_NODE_FK} / ${ENTITY_NODE_IDX}; open a workspace on this build and let startup finish`);
    }
    // Any foreign key other than the one we are about to drop that still hangs on idx_nodes_sk would be lost with it.
    const dependents = await client.query<{ conname: string; rel: string }>(
        `SELECT c.conname, c.conrelid::regclass::text AS rel FROM pg_constraint c
          WHERE c.contype = 'f' AND c.conindid = to_regclass('idx_nodes_sk')
            AND NOT (c.conname = '${LEGACY_ENTITY_NODE_FK}' AND c.conrelid = to_regclass('${ENTITY}'))`);
    if (dependents.rows.length > 0) {
        return refuse(`foreign key(s) still depend on idx_nodes_sk: ${dependents.rows.map((d) => `${d.rel}.${d.conname}`).join(', ')}`);
    }

    const oldFieldIndexes = await staleFieldIndexes(client);
    const plan: Array<{ label: string; sql: string }> = [];
    if (st.legacyEntityFk) plan.push({ label: `${ENTITY}.${LEGACY_ENTITY_NODE_FK}`, sql: `ALTER TABLE ${ENTITY} DROP CONSTRAINT ${LEGACY_ENTITY_NODE_FK}` });
    if (st.entityTable && (await indexExists(client, LEGACY_ENTITY_NODE_IDX))) {
        plan.push({ label: LEGACY_ENTITY_NODE_IDX, sql: `DROP INDEX CONCURRENTLY IF EXISTS ${LEGACY_ENTITY_NODE_IDX}` });
    }
    for (const name of GLOBAL_SK_INDEXES) {
        if (await indexExists(client, name)) plan.push({ label: name, sql: `DROP INDEX CONCURRENTLY IF EXISTS ${name}` });
    }
    for (const name of oldFieldIndexes) plan.push({ label: name, sql: `DROP INDEX CONCURRENTLY IF EXISTS ${name}` });

    for (const step of plan) {
        if (!dryRun) {
            if (step.sql.startsWith('ALTER TABLE')) await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);
            try { await client.query(step.sql); } finally { if (step.sql.startsWith('ALTER TABLE')) await client.query('RESET lock_timeout'); }
        }
        report.dropped.push(step.label);
    }
    return report;
}

async function indexExists(q: Q, name: string): Promise<boolean> {
    return (await q.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [name])).rows[0]!.ok;
}

/**
 * Old-named D10 per-field indexes (`lore_ev_<fieldId>_u|_i`) whose workspace-led counterpart exists and is valid.
 * The counterpart's name is computed in SQL with the same hash as {@link fieldIndexHash}.
 */
async function staleFieldIndexes(q: Q): Promise<string[]> {
    if (!(await indexExists(q, 'lore_ev_current_uq'))) return []; // no table storage in this database
    const r = await q.query<{ old_name: string }>(
        `SELECT oc.relname AS old_name
           FROM pg_class oc
           JOIN pg_namespace ns ON ns.oid = oc.relnamespace AND ns.nspname = current_schema()
           JOIN lore_field_def f ON f.field_id = substring(oc.relname FROM '^lore_ev_(\\d+)_[ui]$')::bigint
          WHERE oc.relkind = 'i' AND oc.relname ~ '^lore_ev_\\d+_[ui]$'
            AND EXISTS (
                SELECT 1 FROM pg_index ni JOIN pg_class nc ON nc.oid = ni.indexrelid
                 WHERE ni.indisvalid AND ni.indisready
                   AND nc.relname = 'lore_ev_' || left(encode(sha256(convert_to(f.workspace_id, 'UTF8')), 'hex'), ${FIELD_INDEX_HASH_LEN})
                                    || '_' || f.field_id || right(oc.relname, 2))
          ORDER BY oc.relname`);
    return r.rows.map((x) => x.old_name).filter((n) => OLD_FIELD_INDEX.test(n));
}
