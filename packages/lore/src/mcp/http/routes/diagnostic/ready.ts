/**
 * ready.ts - GET /ready and GET /api/ready on the local/cloud listener
 * (3.35.0 (e)); the arcade listener answers the same shape from arcadeBoot.ts.
 *
 * /health is liveness: it never depends on a backend, so a platform may restart
 * on it. /ready is readiness - "can this daemon serve writes right now?" - so a
 * platform may take the instance out of rotation on 503, and must NOT restart
 * on it (a backend blip is not a reason to kill the process). Unauthenticated
 * and exempt from the rate limiter exactly like /health; an anonymous caller
 * gets only ready / not ready, an operator (bootstrap token or shared secret)
 * also gets reason / detail / latency. See mcp/readiness.ts for cost control.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getCurrentPrincipal } from '../../../../auth/principal.js';
import { readinessForStore } from '../../../readinessProviders.js';
import { writeReadyResponse } from '../../../readyResponse.js';
import type { Readiness } from '../../../readiness.js';
import type { DiagnosticDeps } from './shared.js';

export async function handleReady(_req: IncomingMessage, res: ServerResponse, deps: DiagnosticDeps): Promise<void> {
    const readiness: Readiness = deps.readiness ?? readinessForStore(deps.store, deps.deploymentMode);
    const r = await readiness.check();
    // Operator = the two daemon-wide credentials (bootstrap, shared secret), the same pair the
    // arcade listener's isOperatorBearer accepts. A tenant/app token is NOT an operator here.
    const kind = getCurrentPrincipal()?.kind;
    writeReadyResponse(res, r, deps.deploymentMode, kind === 'bootstrap' || kind === 'shared-secret');
}
