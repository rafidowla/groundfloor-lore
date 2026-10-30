/**
 * postgresFieldIndexes.ts - bring the D10 per-field partial indexes of ONE workspace to their workspace-led names.
 *
 * A field created before Phase 0 has `lore_ev_<fieldId>_u|_i` over the value column alone. The workspace-led index is
 * `lore_ev_<hash>_<fieldId>_u|_i` over `(workspace_id, value column)` (postgresFieldIndexName.ts). This module builds
 * the new one next to the old one for every unique / indexed field of the workspace; the old one is dropped only by
 * the contract step (`dropGlobalSkIndexes`), so uniqueness stays enforced (by either index) the whole time and an
 * older build sharing the database keeps working.
 *
 * It runs AFTER `ensureRekeyed`, because the name hashes the workspace id that is stored in `lore_field_def`, and the
 * rekey is what turns a workspace name into its permanent id there.
 *
 * Build policy: it is a guarded BACKGROUND job (CREATE INDEX CONCURRENTLY on lore_entity_value can be large, and
 * running it inside the schema-locked bootstrap would deadlock - see postgresWorkspaceSk.ts). A failure is logged
 * and retried on the next open. Unlike a unique index created at table creation, an index built here over existing
 * rows can fail on a duplicate; the old unique index prevents that for data written by Lore, so a failure is
 * surfaced as a warning rather than an error.
 */
import type { Pool, PoolClient } from 'pg';
import type { ColumnDecl } from '../../contracts/tables.js';
import { poolGuardFor, INDEX_BUILD_EXCLUSIVE } from './postgresPoolGuard.js';
import { TABLE_TABLES } from './postgresTableSchema.js';
import { fieldIndexSpecDdl, fieldIndexSpecs, type FieldIndexSpec } from './postgresTableViews.js';

type Q = Pick<PoolClient, 'query'>;

interface Running { done: Promise<void>; ctl: AbortController }
const running = new WeakMap<Pool, Map<string, Running>>();

/** Field index specs this workspace wants, from its field definitions (empty when table storage is not installed yet). */
async function wantedSpecs(q: Q, workspace: string): Promise<FieldIndexSpec[]> {
    const t = await q.query<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [TABLE_TABLES.fieldDef]);
    if (!t.rows[0]!.ok) return [];
    const r = await q.query<{ field_id: string; decl_json: string | null }>(
        `SELECT field_id::text AS field_id, decl_json FROM ${TABLE_TABLES.fieldDef} WHERE workspace_id = $1 ORDER BY field_id`, [workspace]);
    const out: FieldIndexSpec[] = [];
    for (const row of r.rows) {
        if (row.decl_json == null) continue;
        out.push(...fieldIndexSpecs(workspace, Number(row.field_id), JSON.parse(String(row.decl_json)) as ColumnDecl));
    }
    return out;
}

async function status(q: Q, name: string): Promise<'valid' | 'invalid' | 'absent'> {
    const r = await q.query<{ ok: boolean | null }>(
        `SELECT (SELECT i.indisvalid AND i.indisready FROM pg_index i WHERE i.indexrelid = to_regclass($1)) AS ok`, [name]);
    const v = r.rows[0]!.ok;
    return v === null ? 'absent' : v ? 'valid' : 'invalid';
}

/** Specs whose workspace-led index is missing or INVALID. */
export async function missingFieldIndexes(q: Q, workspace: string): Promise<FieldIndexSpec[]> {
    const missing: FieldIndexSpec[] = [];
    for (const spec of await wantedSpecs(q, workspace)) if ((await status(q, spec.name)) !== 'valid') missing.push(spec);
    return missing;
}

/** Build the missing indexes on `q` (autocommit session). Returns the names built. A failing index is warned about and skipped. */
export async function buildFieldIndexes(q: Q, workspace: string, isCancelled: () => boolean): Promise<string[]> {
    const built: string[] = [];
    for (const spec of await missingFieldIndexes(q, workspace)) {
        if (isCancelled()) break;
        try {
            if ((await status(q, spec.name)) === 'invalid') await q.query(`DROP INDEX CONCURRENTLY IF EXISTS ${spec.name}`);
            await q.query(fieldIndexSpecDdl(spec, true));
            built.push(spec.name);
        } catch (err) {
            if (isCancelled()) break;
            console.warn(`[PostgresTableStorage] field index ${spec.name} not built: ${(err as Error).message}`);
        }
    }
    return built;
}

/**
 * ensureFieldIndexes - start (or join) the background job for `workspace` if any workspace-led field index is missing.
 * Returns the job's promise as `done` (never rejects); already settled when nothing is missing.
 */
export async function ensureFieldIndexes(pool: Pool, workspace: string): Promise<{ done: Promise<void> }> {
    if ((await missingFieldIndexes(pool, workspace)).length === 0) return { done: Promise.resolve() };
    let byWs = running.get(pool);
    if (!byWs) { byWs = new Map(); running.set(pool, byWs); }
    const existing = byWs.get(workspace);
    if (existing) return { done: existing.done };
    const state: Running = { done: Promise.resolve(), ctl: new AbortController() };
    state.done = (async () => {
        try {
            await poolGuardFor(pool).run('field-index-build',
                (client) => buildFieldIndexes(client, workspace, () => state.ctl.signal.aborted),
                { signal: state.ctl.signal, timeoutMs: 0, exclusive: INDEX_BUILD_EXCLUSIVE });
        } catch (err) {
            if (!state.ctl.signal.aborted) console.warn(`[PostgresTableStorage] background field index build failed: ${(err as Error).message}`);
        } finally {
            byWs!.delete(workspace);
        }
    })();
    byWs.set(workspace, state);
    return { done: state.done };
}

/** Abort the running field-index build of `workspace` and wait for it to unwind (store close; the next open retries). */
export async function cancelFieldIndexBuild(pool: Pool | null, workspace: string): Promise<void> {
    const state = pool ? running.get(pool)?.get(workspace) : undefined;
    if (!state) return;
    state.ctl.abort();
    await state.done;
}

/** Abort every running field-index build on this pool and wait for it to unwind. */
export async function cancelFieldIndexBuilds(pool: Pool | null): Promise<void> {
    const byWs = pool ? running.get(pool) : undefined;
    if (!byWs) return;
    const all = [...byWs.values()];
    for (const s of all) s.ctl.abort();
    await Promise.all(all.map((s) => s.done));
}

/** Running builds' promises (tests). */
export function fieldIndexBuildsDone(pool: Pool | null): Promise<void> {
    const byWs = pool ? running.get(pool) : undefined;
    return byWs ? Promise.all([...byWs.values()].map((s) => s.done)).then(() => undefined) : Promise.resolve();
}
