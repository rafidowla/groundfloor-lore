/**
 * readyResponse.ts - the one wire shape of `GET /ready` / `GET /api/ready`,
 * shared by the arcade listener (arcadeBoot.ts) and the local/cloud listener
 * (http/routes/diagnostic/ready.ts) so the two cannot drift.
 *
 *   200 {status:'ready', version, mode}                      ready
 *   503 {status:'not_ready', version, mode} + Retry-After: 2  not ready
 *   always Cache-Control: no-store
 *
 * An operator (bootstrap token or shared secret) additionally gets
 * `reason` + `detail` (not-ready only), `latencyMs`, `checkedAgeMs`. An
 * anonymous caller learns only ready / not ready.
 */

import type { ServerResponse } from 'node:http';
import { VERSION } from '../version.js';
import { writeJson } from './http/helpers.js';
import type { ReadinessResult } from './readiness.js';

export function writeReadyResponse(res: ServerResponse, r: ReadinessResult, mode: string, operator: boolean): void {
    const base = { status: r.ready ? 'ready' : 'not_ready', version: VERSION, mode };
    const body = operator
        ? { ...base, ...(r.reason ? { reason: r.reason, detail: r.detail } : {}), latencyMs: r.latencyMs, checkedAgeMs: Math.max(0, Date.now() - r.checkedAt) }
        : base;
    if (!r.ready) res.setHeader('Retry-After', '2');
    res.setHeader('Cache-Control', 'no-store');
    writeJson(res, r.ready ? 200 : 503, body);
}
