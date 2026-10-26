/**
 * workspaceErase/dataplaneEraser.ts — erases a deleted workspace's rows from Dataplane (cloud / local-sync) (lane f6b).
 *
 * A thin wrapper over the existing cloud-purge apply (`applyWorkspacePurge`), reusing all of its per-row proof
 * (only rows whose key proves org + workspace id are deleted; unkeyed rows are reported, never deleted), its
 * walk/verify loop and its guards. The guard re-reads the registry strictly before every delete pass; the
 * recent-write probe refuses if another instance is still writing under this id. Never talks to a Dataplane unless
 * the deletion record is a cloud / local-sync one and the Dataplane settings are present.
 * The recent-write check (`probeCheck`) runs inside `applyWorkspacePurge` as a read-only pre-flight before any delete (lane f6d).
 */

import { applyWorkspacePurge, type PurgeApplyClient, type PurgeApplyResult } from '../dataplaneWorkspacePurgeApply.js';
import { probeDecision, purgeCollectionOrder, type PurgeTarget } from '../dataplaneWorkspacePurge.js';
import { liveWorkspaceIds, readDeletionLog } from '../../config/deletedWorkspaces.js';
import { readLiveEntriesStrict } from './liveRegistry.js';
import type { EraseOptions, EraseStepResult, EraseTarget, WorkspaceEraser } from './types.js';

const STORE = 'dataplane';

export interface DataplaneEraserDeps {
    home: string;
    env?: Record<string, string | undefined>;
    /** Builds the Dataplane client. Default: the live SDK (loaded lazily). Tests inject a fake. */
    clientFactory?: (baseUrl: string, apiKey: string) => PurgeApplyClient | Promise<PurgeApplyClient>;
    now?: () => Date;
    /** Extra app-declared collections to purge (same names `--collection` takes). */
    collections?: readonly string[];
}

async function liveClient(baseUrl: string, apiKey: string): Promise<PurgeApplyClient> {
    const { loadGroundfloorClient } = await import('../../mcp/cloudStores.js');
    const { createLoreDataplaneSdk } = await import('../dataplaneSdkCompat.js');
    return createLoreDataplaneSdk(await loadGroundfloorClient(), baseUrl, apiKey);
}

const res = (status: EraseStepResult['status'], detail?: string, removed: Record<string, number> = {}, remaining: Record<string, number> = {}): EraseStepResult =>
    ({ store: STORE, status, removed, remaining, ...(detail ? { detail } : {}) });

const isDataplaneMode = (mode: string | null): boolean => mode === 'cloud' || mode === 'local-sync';

export function createDataplaneEraser(deps: DataplaneEraserDeps): WorkspaceEraser {
    return {
        store: STORE,
        async erase(target: EraseTarget, _opts?: EraseOptions): Promise<EraseStepResult> {
            if (!isDataplaneMode(target.mode)) return res('not-applicable', 'the workspace was not deleted in a Dataplane (cloud) mode');
            const env = deps.env ?? process.env;
            const orgId = env['DATAPLANE_ORG_ID'] ?? '';
            const apiKey = env['DATAPLANE_API_KEY'] ?? '';
            const url = env['DATAPLANE_URL'] ?? '';
            const connection = (env['DATAPLANE_CONNECTION'] ?? '').trim();
            const missing = [!orgId || orgId === 'default' ? 'DATAPLANE_ORG_ID' : '', !apiKey ? 'DATAPLANE_API_KEY' : '', !url ? 'DATAPLANE_URL' : '', !connection ? 'DATAPLANE_CONNECTION' : ''].filter(Boolean);
            if (missing.length > 0) return res('partial', `Dataplane is not configured here (${missing.join(', ')} unset), so its rows were not erased; the scheduled run retries where it is configured`);
            if (target.orgId !== null && target.orgId !== orgId) return res('partial', 'the deletion was recorded under a different Dataplane org than this instance uses; rows were not erased');

            let collections: string[];
            try { collections = purgeCollectionOrder(deps.collections ?? []); }
            catch (e) { return res('partial', (e as Error).message); }
            const purgeTarget: PurgeTarget = { orgId, loreWorkspace: target.id, dataplaneWorkspaceId: env['DATAPLANE_WORKSPACE_ID'] || env['DATAPLANE_TENANT_ID'] || 'groundfloor_lore' };
            const scrub = (s: string): string => s.split(apiKey).join('[redacted]');

            let deletedAtMs: number | null = null;
            try {
                const at = readDeletionLog(deps.home).byId.get(target.id)?.deletion?.deletedAt;
                const ms = at ? Date.parse(at) : NaN;
                deletedAtMs = Number.isNaN(ms) ? null : ms;
            } catch { /* handled below: no deletedAt -> unrecorded rule applies */ }
            if (deletedAtMs === null) return res('partial', 'the deletion time could not be read, so the recent-write check cannot run; nothing was erased');

            let result: PurgeApplyResult;
            try {
                const client = await (deps.clientFactory ?? liveClient)(url, apiKey);
                result = await applyWorkspacePurge({
                    client, target: purgeTarget, connection, collections,
                    guard: () => {
                        if (liveWorkspaceIds(readLiveEntriesStrict(deps.home)).has(target.id)) throw new Error('the workspace id is live in workspaces.json again');
                    },
                    probeCheck: (p) => {
                        const v = probeDecision(p, { deletedAtMs, nowMs: (deps.now ?? (() => new Date()))().getTime(), minAgeMs: 0 });
                        if (v.refuse || v.verdict === 'unknown') throw new Error(v.reason);
                    },
                });
            } catch (e) {
                return res('partial', `Dataplane erase failed: ${scrub((e as Error).message)}`);
            }

            const removed = { rows: result.totals.deleted };
            const unkeyed = result.totals.unkeyed;
            if (result.exitCode === 0) {
                return unkeyed > 0
                    ? res('unverifiable', `${unkeyed} row(s) could not be proven to belong to this workspace and were left untouched`, removed, { unkeyed })
                    : res('complete', undefined, removed, { rows: 0 });
            }
            if (result.exitCode === 3) {
                return res('unverifiable', `Dataplane could not prove the erase complete (${result.outcome}${result.message ? `: ${scrub(result.message)}` : ''})`, removed, { unkeyed });
            }
            return res('partial', `Dataplane erase stopped (${result.outcome}${result.message ? `: ${scrub(result.message)}` : ''}); it will be retried`, removed, { rows: 1 });
        },
    };
}
