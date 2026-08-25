/**
 * orchestrations.ts — Phase 4 item 4 REST surface.
 *
 *   POST   /api/schema/orchestrations          — body {decomposedPlan, proposedBy, approvedBy, soakSeconds?, note?}
 *                                                creates an orchestration. First tick happens synchronously
 *                                                so the response includes the initial submitted state.
 *   GET    /api/schema/orchestrations          — list active + completed orchestrations
 *   GET    /api/schema/orchestrations/{id}     — fetch one
 *   POST   /api/schema/orchestrations/{id}/tick   — manually advance (also called automatically by daemon timer)
 *   POST   /api/schema/orchestrations/{id}/abort  — stop the orchestration
 *
 * Auto-tick: the daemon owns a setInterval that walks every running
 * orchestration. The explicit /tick endpoint is for tests and for
 * admin UIs that don't want to wait for the timer.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { PlanOrchestrator } from '../../../schemas/orchestration/orchestrator.js';
import type { DecomposedPlan } from '../../../schemas/decomposition.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import { readJsonBody, writeJson, writeError } from '../helpers.js';
import { redactError } from '../../../security/logRedact.js';
import { bindRouteTarget, isLegacyBypass } from '../../../security/routeWorkspaceBinding.js';

const PREFIX = '/api/schema/orchestrations';

export interface OrchestrationsRoutesDeps {
    orchestrator?: PlanOrchestrator;
    /**
     * Wave 4 sweep (closing the Wave-4 adversarial-review HIGH finding) — the
     * PlanOrchestrator is physically wired to the BOOT workspace's .lore
     * (wireOrchestration in mcp/server.ts is constructed over the same `graph`
     * as createPhaseAServices, keyed by `detectedScope.workspace`), exactly
     * like the /api/schema family (schema.ts's `schemaWorkspace`). Passing this
     * through lets the family gate below fail closed (409) instead of quietly
     * serving/mutating the boot workspace's orchestration state for a
     * different, authorized-looking target. Falls back to 'default' if unset
     * (mirrors schema/shared.ts SchemaRoutesDeps.schemaWorkspace).
     */
    schemaWorkspace?: string;
}

/**
 * Audit C1 (L-001, 2026-06-17) — the orchestration routes drive the SAME
 * destructive MigrationRunner.execute path as /api/schema/migrations, through
 * the decomposed plan's `migrate` phases (POST create runs the first tick
 * synchronously). They were ungated, so a read-only Bearer could mass-delete
 * by POSTing a crafted decomposedPlan. The in-process auto-tick timer never
 * goes through HTTP, so gating the HTTP entry points (create / tick / abort)
 * is sufficient and safe.
 *
 * Wave 4 sweep (closes the Wave-4 adversarial-review HIGH finding) — the
 * write/read-scope gates here used to call requireWriteToWorkspace /
 * requireReadFromWorkspace(principal, undefined) directly, the exact
 * literal-undefined-target anti-pattern D-021 bans: an undefined target
 * always resolves to the TOKEN'S OWN workspace, so it can never confine a
 * cross-workspace request. Removed (mirrors migrations.ts's removal of
 * requireMigrationWriteScope in 4.2) — the single family gate in
 * tryOrchestrationsRoutes (bindRouteTarget + boot-workspace 409, identical to
 * trySchemaRoutes) now runs BEFORE any handler below and covers both read and
 * write intents for the whole family.
 */

/**
 * F-M04 (medium, authz-bypass, 2026-06-27) — `create` gates on BOTH write
 * scope AND a human approver (`approvedBy.startsWith('human:')`), but `tick`
 * and `abort` only gated on write scope. `tick` is the DESTRUCTIVE trigger:
 * it advances the orchestration and runs its `migrate` phases through the same
 * MigrationRunner.execute path. So a non-human / service principal that could
 * NOT have created the orchestration as a human could still drive it forward
 * (or abort it) via tick/abort. `tick`/`abort` carry no `approvedBy` body to
 * re-check, so — mirroring /api/schema/migrations (migrations.ts
 * denyNonHumanOperator) — bind the gate to the authenticated principal KIND:
 *   - null principal               → local/legacy bypass (preserved; tests + no-auth local).
 *   - kind==='bootstrap'           → the local operator (the human). Allowed.
 *   - kind==='app'/'shared-secret' → a service/automation principal cannot
 *                                    drive a destructive orchestration. Rejected 403.
 * Returns true once a 403 has been written.
 */
function denyNonHumanOrchestrationOperator(res: ServerResponse): boolean {
    const p = getCurrentPrincipal();
    if (!p || p.kind === 'bootstrap') return false;
    writeError(res, 403, 'destructive_orchestration_requires_human',
        `principal kind '${p.kind}' cannot drive a destructive orchestration — it requires ` +
        `the operator (bootstrap) identity. A shared-secret / app token cannot advance or abort ` +
        `an orchestration that runs destructive migrate phases.`);
    return true;
}

export async function tryOrchestrationsRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: OrchestrationsRoutesDeps,
): Promise<boolean> {
    if (!pathname.startsWith(PREFIX)) return false;

    // ── Wave 4 sweep: per-workspace confinement gate (mirrors trySchemaRoutes
    // in ../schema.ts, Wave 4.2 Step 1) ────────────────────────────────────
    // The PlanOrchestrator is physically wired to the BOOT workspace's .lore
    // (wireOrchestration in mcp/server.ts, constructed over the same `graph`
    // as createPhaseAServices) REGARDLESS of the request's target. Pre-sweep,
    // every handler below gated with requireWriteToWorkspace/
    // requireReadFromWorkspace(principal, undefined) — literal-undefined
    // always resolves to the TOKEN'S OWN workspace, so a read-scoped ws-B
    // token calling GET /api/schema/orchestrations (or /{id}) sailed through
    // the gate and was served the BOOT workspace's orchestration/migration
    // plan state — cross-workspace disclosure (the audited HIGH finding).
    //
    // Fixed identically to trySchemaRoutes:
    //   1. bindRouteTarget resolves + scope-checks the request's CONCRETE
    //      target (?workspace= when present, else the principal's own bound
    //      workspace — never a boot/detectedScope default). A foreign target
    //      403s here (the chokepoint gate).
    //   2. If the (authorized) target isn't the family's wired workspace,
    //      refuse honestly with 409 rather than silently touching boot.
    // Intent is method-derived: GET/HEAD → read, everything else → write.
    const u = new URL(url, 'http://x');
    const requestedWs = u.searchParams.get('workspace') ?? undefined;
    const method = (req.method ?? 'GET').toUpperCase();
    const intent: 'read' | 'write' = method === 'GET' || method === 'HEAD' ? 'read' : 'write';

    // Pure legacy/direct-call bypass (no principal, no binding slot, no
    // ?workspace=) — unreachable on the real HTTP path; preserved so
    // direct-call unit harnesses keep working exactly as before the sweep.
    // Detected via the shared isLegacyBypass helper so we never depend on
    // res.headersSent (which stub responses don't track).
    if (!isLegacyBypass(requestedWs)) {
        const target = bindRouteTarget(res, { requested: requestedWs, intent });
        if (target === null) return true; // denial (403/401) already written.
        const orchestrationWorkspace = deps.schemaWorkspace ?? 'default';
        if (target !== orchestrationWorkspace) {
            writeError(res, 409, 'orchestration_workspace_not_active',
                `schema orchestration is currently bound to workspace "${orchestrationWorkspace}"; ` +
                `targeting "${target}" is not yet supported (per-workspace orchestration lands with 4.2b)`);
            return true;
        }
    }

    if (!deps.orchestrator) {
        writeError(res, 503, 'orchestrator_unavailable',
            'orchestration is not wired in this daemon (no schemaAuthoring + migrationBackend)');
        return true;
    }
    const orchestrator = deps.orchestrator;

    if (pathname === PREFIX && req.method === 'POST') {
        // Write-scope + workspace-confinement gated above (bindRouteTarget).
        // D2-orch-1 — create runs the FIRST migrate tick synchronously, so it is
        // a destructive trigger exactly like tick/abort. The approvedBy:"human:"
        // check below is client-supplied (self-attestable); bind the gate to the
        // authenticated principal too (mirrors F-A1/F-M04). An app/shared-secret
        // token cannot drive a destructive orchestration by self-attesting.
        if (denyNonHumanOrchestrationOperator(res)) return true;
        try {
            const body = await readJsonBody(req) as {
                decomposedPlan?: DecomposedPlan;
                proposedBy?: string;
                approvedBy?: string;
                soakSeconds?: number;
                note?: string;
            };
            if (!body?.decomposedPlan || !Array.isArray(body.decomposedPlan.phases)) {
                writeError(res, 400, 'invalid_orchestration_body',
                    'body must be {decomposedPlan: DecomposedPlan, proposedBy, approvedBy, soakSeconds?, note?}');
                return true;
            }
            if (!body.proposedBy || !body.approvedBy) {
                writeError(res, 400, 'invalid_orchestration_body',
                    'proposedBy and approvedBy are required');
                return true;
            }
            // Audit C1/C2 (L-001/L-002) — an orchestration runs destructive
            // `migrate` phases against the runner. Mirror the
            // /migrations/execute human-approver guard so an AI / automated
            // actor cannot drive destructive migrations through this surface.
            if (!body.approvedBy.startsWith('human:')) {
                writeError(res, 403, 'destructive_migration_requires_human',
                    `approvedBy must be a human:* identity (got "${body.approvedBy}") — ` +
                    `orchestration executes destructive migrate phases.`);
                return true;
            }
            const initial = orchestrator.create(body.decomposedPlan, {
                proposedBy: body.proposedBy,
                approvedBy: body.approvedBy,
                soakSeconds: body.soakSeconds ?? 0,
                note: body.note,
            });
            // First tick so the caller sees the initial submission outcome.
            const advanced = await orchestrator.tick(initial.id);
            writeJson(res, 201, advanced);
        } catch (e) {
            writeError(res, 400, 'create_orchestration_failed', redactError(e));
        }
        return true;
    }

    if (pathname === PREFIX && req.method === 'GET') {
        // Read-scope + workspace-confinement gated above (bindRouteTarget).
        writeJson(res, 200, { orchestrations: orchestrator.listAll() });
        return true;
    }

    // /api/schema/orchestrations/{id}[/(tick|abort)]
    const tail = pathname.slice(PREFIX.length + 1);
    if (!tail) {
        writeError(res, 405, 'method_not_allowed', `method ${req.method} not allowed on ${pathname}`);
        return true;
    }
    const segments = tail.split('/').filter(Boolean);
    const id = decodeURIComponent(segments[0] ?? '');
    const action = segments[1];

    if (segments.length === 1 && req.method === 'GET') {
        // Read-scope + workspace-confinement gated above (bindRouteTarget).
        const state = orchestrator.get(id);
        if (!state) {
            writeError(res, 404, 'orchestration_not_found', `no orchestration with id '${id}'`);
            return true;
        }
        writeJson(res, 200, state);
        return true;
    }

    if (action === 'tick' && req.method === 'POST') {
        // Write-scope + workspace-confinement gated above (bindRouteTarget).
        if (denyNonHumanOrchestrationOperator(res)) return true;   // F-M04
        try {
            const state = await orchestrator.tick(id);
            writeJson(res, 200, state);
        } catch (e) {
            const msg = (e as Error).message;
            const status = /no orchestration/i.test(msg) ? 404 : 500;
            writeError(res, status, 'tick_failed', redactError(e));
        }
        return true;
    }

    if (action === 'abort' && req.method === 'POST') {
        // Write-scope + workspace-confinement gated above (bindRouteTarget).
        if (denyNonHumanOrchestrationOperator(res)) return true;   // F-M04
        try {
            const body = await readJsonBody(req).catch(() => ({})) as { reason?: string };
            const state = orchestrator.abort(id, body?.reason);
            writeJson(res, 200, state);
        } catch (e) {
            const msg = (e as Error).message;
            const status = /no orchestration/i.test(msg) ? 404 : 500;
            writeError(res, status, 'abort_failed', redactError(e));
        }
        return true;
    }

    writeError(res, 404, 'unknown_orchestration_route', `no route for ${pathname}`);
    return true;
}
