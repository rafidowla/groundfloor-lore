/**
 * executePlan.ts - library entry point for running a query plan (Tables P3). No MCP tool, HTTP route or env var
 * exposes this yet.
 *
 *   executePlan(storage, workspace, plan, limits?) -> PlanResult
 *
 * The workspace always comes from the CALLER and must be the one the storage is bound to (by name or by permanent id); a plan cannot name one.
 * Postgres table storage is the only engine today; any other engine answers `engine_not_supported`.
 * Never throws for a bad plan, a cap, a timeout or an unsupported engine: every outcome is a typed `PlanResult`.
 */

import type { ITableStorage } from '../contracts/tables.js';
import { registryHomeForKey, resolvePostgresWorkspaceKey } from '../engines/postgres/postgresWorkspaceKey.js';
import { DEFAULT_PLAN_LIMITS, type PlanLimits, type PlanResult } from './planTypes.js';

const MAX_ROWS_CEILING = 1_000_000;
const MAX_TIMEOUT_CEILING_MS = 120_000;

function resolveLimits(partial: Partial<PlanLimits> | undefined): PlanLimits | string {
    const l: PlanLimits = { ...DEFAULT_PLAN_LIMITS, ...(partial ?? {}) };
    const intIn = (v: number, lo: number, hi: number): boolean => Number.isInteger(v) && v >= lo && v <= hi;
    if (!intIn(l.maxRowsPerStep, 1, MAX_ROWS_CEILING)) return `maxRowsPerStep must be an integer 1..${MAX_ROWS_CEILING}`;
    if (!intIn(l.maxTotalRows, 1, MAX_ROWS_CEILING * 10)) return `maxTotalRows must be an integer 1..${MAX_ROWS_CEILING * 10}`;
    if (!intIn(l.statementTimeoutMs, 1, MAX_TIMEOUT_CEILING_MS)) return `statementTimeoutMs must be an integer 1..${MAX_TIMEOUT_CEILING_MS}`;
    if (!intIn(l.lockTimeoutMs, 1, MAX_TIMEOUT_CEILING_MS)) return `lockTimeoutMs must be an integer 1..${MAX_TIMEOUT_CEILING_MS}`;
    return l;
}

/**
 * The storage is bound to the workspace's permanent id (its Postgres row key). Callers name the workspace, so
 * accept the name when it resolves to that same id in the registry the storage was opened from.
 */
function isBoundWorkspace(workspace: string, boundKey: string): boolean {
    if (workspace === boundKey) return true;
    const home = registryHomeForKey(boundKey);
    if (home === undefined) return false;
    try { return resolvePostgresWorkspaceKey(workspace, home) === boundKey; } catch { return false; }
}

export async function executePlan(
    storage: ITableStorage, workspace: string, plan: unknown, limits?: Partial<PlanLimits>,
): Promise<PlanResult> {
    const { PostgresTableStorage } = await import('../engines/postgres/postgresTableStorage.js');
    if (!(storage instanceof PostgresTableStorage)) {
        return { status: 'error', error: { code: 'engine_not_supported', message: 'query plans run on Postgres table storage only (server mode); this engine is not supported yet' } };
    }
    if (typeof workspace !== 'string' || workspace.length === 0 || !isBoundWorkspace(workspace, storage.workspace)) {
        return { status: 'error', error: { code: 'workspace_mismatch', message: 'the workspace must be the one this table storage is bound to' } };
    }
    const resolved = resolveLimits(limits);
    if (typeof resolved === 'string') return { status: 'error', error: { code: 'invalid_limits', message: resolved } };
    const { runPlanPostgres } = await import('../engines/postgres/postgresPlanExecutor.js');
    return runPlanPostgres(storage, plan, resolved);
}
