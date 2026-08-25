/**
 * schema.ts — dispatcher for the REST mirror of the Phase A schema-authoring
 * + governance MCP tools (so the admin app + no-code tools can drive
 * propose/approve/reject/rollback/migrate without an MCP client).
 *
 * The family owns the entire `/api/schema` prefix: each handler group lives
 * under ./schema/, and any /api/schema path that no group matches gets a
 * 404 here (never falls through to other route families).
 *
 *   reads      — GET /api/schema, /summary                    (schema/reads.ts)
 *   proposals  — propose/list/get/approve/reject              (schema/proposals.ts)
 *   governance — history, audit, exceptions, sync             (schema/governance.ts)
 *   migrations — dry-run/execute/in-flight/resume/decompose/rollback (schema/migrations.ts)
 *
 * Auth: every /api/* route requires Bearer (httpAuth.ts). Phase 1
 * destructive guards still apply at the SchemaAuthoringStore level
 * — destructive proposals require `proposedBy` to start with `human:`.
 *
 * Behavior is byte-for-byte identical to the pre-split inline handlers.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PREFIX, type SchemaRoutesDeps } from './schema/shared.js';
import { writeError } from '../helpers.js';
import { tryReadRoutes } from './schema/reads.js';
import { tryProposalRoutes } from './schema/proposals.js';
import { tryGovernanceRoutes } from './schema/governance.js';
import { tryMigrationRoutes } from './schema/migrations.js';
import { bindRouteTarget, isLegacyBypass } from '../../../security/routeWorkspaceBinding.js';

export { SCHEMA_APPROVE_OPERATION } from './schema/shared.js';
export type { SchemaRoutesDeps } from './schema/shared.js';

export async function trySchemaRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: SchemaRoutesDeps,
): Promise<boolean> {
    if (!pathname.startsWith(PREFIX)) return false;

    // ── Wave 4.2 Step 1: per-workspace confinement gate ───────────────────
    // The /api/schema family is physically wired to the BOOT workspace's .lore
    // (createPhaseAServices + wireOrchestration in mcp/server.ts): the
    // SchemaAuthoringStore, the migration backend, CheckpointStore, and
    // PlanOrchestrator all persist under `deps.schemaWorkspace` REGARDLESS of
    // the request's target. Pre-4.2 the sub-routes gated with
    // requireWriteToWorkspace(principal, undefined) — which defaults to the
    // token's OWN workspace and so ALWAYS passes for any write-scoped token,
    // even one bound to a non-boot workspace. That let an app token whose
    // workspace differs from boot silently mutate the boot workspace's schema.
    //
    // The single fail-closed gate below closes that lie without any new
    // per-workspace plumbing:
    //   1. bindRouteTarget resolves + scope-checks the request's CONCRETE
    //      target (?workspace= when present, else the principal's own bound
    //      workspace — never a boot/detectedScope default). A scoped token
    //      naming a foreign workspace is 403'd here (via the chokepoint gate).
    //   2. If the (authorized) target is not the family's wired workspace, we
    //      refuse honestly with 409 schema_workspace_not_active rather than
    //      pretending to act on `target` while actually touching boot.
    //
    // Consequence: the boot-workspace app and the bootstrap operator (whose
    // own workspace IS boot) are unaffected — the common local path is
    // unchanged 2xx. Per-workspace schema authoring for non-boot targets is
    // deferred to 4.2b (per-workspace PhaseAServices + orchestrator lifecycle);
    // until then non-boot targets FAIL CLOSED, with no silent cross-workspace
    // effect. Intent is method-derived: GET/HEAD → read, everything else → write
    // (covers every sub-route: reads=GET, proposals/governance/migrations mutate
    // via POST/DELETE and read via GET).
    const u = new URL(url, 'http://x');
    const requestedWs = u.searchParams.get('workspace') ?? undefined;
    const method = (req.method ?? 'GET').toUpperCase();
    const intent: 'read' | 'write' = method === 'GET' || method === 'HEAD' ? 'read' : 'write';

    // The ONLY case in which bindRouteTarget returns null WITHOUT writing a
    // denial is the pure legacy/direct-call bypass: no principal, no binding
    // slot, and no ?workspace= — so no target is resolvable and nothing is
    // confined (documented in routeTargetContract step 7). This is unreachable
    // on the real HTTP path (the dispatcher installs a slot for every gated
    // local request, and a Bearer-less /api/schema 401s at validateRequest); it
    // only occurs in direct-call unit harnesses. In that case, skip the
    // confinement gate entirely and fall through to the sub-routes exactly as
    // pre-4.2, rather than returning a bodyless "handled". Detect it up front via
    // the shared isLegacyBypass helper so we never depend on res.headersSent
    // (which stub responses don't track).
    if (!isLegacyBypass(requestedWs)) {
        const target = bindRouteTarget(res, { requested: requestedWs, intent });
        if (target === null) return true; // denial (403/401) already written.
        const schemaWorkspace = deps.schemaWorkspace ?? 'default';
        if (target !== schemaWorkspace) {
            writeError(res, 409, 'schema_workspace_not_active',
                `schema authoring is currently bound to workspace "${schemaWorkspace}"; ` +
                `targeting "${target}" is not yet supported (per-workspace schema authoring lands in 4.2b)`);
            return true;
        }
    }

    if (tryReadRoutes(req, res, pathname, deps)) return true;
    if (await tryProposalRoutes(req, res, deps, pathname)) return true;
    if (await tryGovernanceRoutes(req, res, url, pathname, deps)) return true;
    if (await tryMigrationRoutes(req, res, deps, pathname)) return true;

    writeError(res, 404, 'unknown_schema_route', `no /api/schema route for ${pathname}`);
    return true;
}
