/**
 * retention.ts — dispatcher for verbatim-store cleanup, stale-marking, and
 * workspace retention policy routes. Handlers live under ./retention/.
 *
 *   verbatim — reap/tombstone/get/history/store/search  (retention/verbatim.ts)
 *   policy   — mark-stale, workspace retention GET/PUT/sweep,
 *              resolve-deferred, prune-ephemeral          (retention/policy.ts)
 *
 * `runRetentionSweep` lives in server.ts because the daily setTimeout
 * also calls it; it's threaded in here as a deps callback.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RetentionDeps } from './retention/shared.js';
import { tryVerbatimRoutes } from './retention/verbatim.js';
import { tryPolicyRoutes } from './retention/policy.js';

export type { RetentionDeps, RetentionSweepResult } from './retention/shared.js';

export async function tryRetentionRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: RetentionDeps,
): Promise<boolean> {
    if (await tryVerbatimRoutes(req, res, url, deps, pathname)) return true;
    if (await tryPolicyRoutes(req, res, deps, pathname)) return true;
    return false;
}
