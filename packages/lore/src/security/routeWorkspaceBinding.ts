/**
 * routeWorkspaceBinding.ts — Wave 4.1 LOCAL-MODE WORKSPACE CONFINEMENT.
 *
 * The chokepoint invariant:
 *
 *   Every authenticated local-mode HTTP request executes under an
 *   AsyncLocalStorage-bound RouteWorkspaceBinding whose target is validated
 *   against the principal BEFORE any route runs. Any workspace-addressed
 *   substrate open (LocalGraphRegistry.getOrOpen / withGraph,
 *   WorkspaceVerbatimResolver.getOrOpen, LocalGraph mutation surface) during a
 *   bound request MUST match the binding's target, an explicitly authorized
 *   extra target, or a declared cross-workspace / daemon-operator lane —
 *   otherwise it throws WorkspaceAccessDeniedError (HTTP 403
 *   workspace_forbidden). A workspace target is NEVER silently defaulted to a
 *   boot / active / detected scope.
 *
 * This file is the SINGLE route-facing gate. Routes never import the raw
 * `requireWriteToWorkspace` / `requireReadFromWorkspace` scope guards from
 * auth/principal.js (arch rule D-021 forbids it); they call one of:
 *
 *   - bindRouteTarget(res, { requested?, intent })      — data-plane target
 *   - bindDaemonOperatorLane(res, { intent, requested? }) — control-plane
 *   - authorizeExtraTarget(ws)                          — enumeration fan-out
 *
 * and pass the returned target verbatim to the substrate. The substrate then
 * re-verifies via assertWorkspaceOpenAllowed, so binding ws-a then opening
 * ws-b throws — deny-by-default holds even if a route forgets to declare.
 *
 * Deny-by-default (three layers):
 *   L1 (edge)       — middleware binds a validated target for EVERY
 *                     authenticated local /api|/v1 request; a foreign
 *                     X-Lore-Workspace header 403s before any route runs.
 *   L2 (chokepoint) — a route that declares NO target stays bound to
 *                     principal.workspace; opening a different workspace's
 *                     substrate throws. An undeclared route is structurally
 *                     confined to the caller's own workspace.
 *   L3 (guard)      — assertWorkspaceOpenAllowed only allows-without-checking
 *                     when there is NO request slot (boot, timers, outbox
 *                     replicator, SyncPoller, CLI, stdio MCP, embedded,
 *                     direct-call unit harnesses). A filled slot always checks.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { ServerResponse } from 'node:http';
import {
    getCurrentPrincipal,
    requireReadFromWorkspace,
    requireWriteToWorkspace,
} from '../auth/principal.js';

/* ─── Lanes ────────────────────────────────────────────────────── */

/**
 * Which authorization lane the request is running in:
 *   - 'workspace'       — confined to a single workspace target (the default).
 *   - 'cross-workspace' — a scope-checked fan-out read (workspace:"*"); the
 *                         substrate guard admits any workspace.
 *   - 'daemon-operator' — a control-plane operation (workspace CRUD, daemon
 *                         control, audit export, config write) that
 *                         legitimately touches many workspaces / workspaces.json.
 */
export type RouteLane = 'workspace' | 'cross-workspace' | 'daemon-operator';

export interface RouteWorkspaceBinding {
    /** The workspace this request is currently confined to. */
    target: string;
    /** The active authorization lane. */
    lane: RouteLane;
    /**
     * Additional workspaces this request was explicitly authorized to open —
     * used by per-item enumeration routes that requireReadFromWorkspace each
     * workspace then open the ones that passed (authorizeExtraTarget).
     */
    extraTargets?: Set<string>;
}

/**
 * The binding lives in a MUTABLE slot (a one-field box) inside the AsyncLocalStorage
 * rather than a nested storage.run per re-bind, so imperative route bodies can
 * re-bind after body parsing without restructuring into callbacks.
 */
interface BindingSlot {
    binding: RouteWorkspaceBinding;
}

const storage = new AsyncLocalStorage<BindingSlot>();

/** Run `fn` with a route-binding slot seeded to `initial`. */
export function runWithRouteBindingSlot<T>(initial: RouteWorkspaceBinding, fn: () => T): T {
    return storage.run({ binding: initial }, fn);
}

/** The current request's binding, or null when no slot is installed. */
export function getRouteBinding(): RouteWorkspaceBinding | null {
    return storage.getStore()?.binding ?? null;
}

/**
 * isLegacyBypass — the ONE case in which bindRouteTarget returns null WITHOUT
 * writing a denial (routeTargetContract step 7): no principal, no binding slot,
 * and no requested workspace, so no target is resolvable and there is nothing to
 * confine. This is unreachable on the real HTTP path (the dispatcher installs a
 * slot for every gated local request, and a Bearer-less /api/* request 401s at
 * validateRequest); it only occurs in direct-call unit harnesses.
 *
 * Callers detect it UP FRONT so they can skip the gate and fall through exactly
 * as pre-confinement, then treat any later `bindRouteTarget(...) === null`
 * unambiguously as a DENIAL (which already wrote its 4xx). This is the ONLY
 * robust way to distinguish denied-vs-bypass: it does NOT touch res.headersSent,
 * which real Node ServerResponses set on writeHead but which stub responses
 * across the test suite (and any future non-Node HTTP shim) do not track. A route
 * that discriminated on res.headersSent silently fell through a real cross-
 * workspace 403 under those responses, overwriting the denial with a 2xx.
 */
export function isLegacyBypass(requested?: string): boolean {
    return getCurrentPrincipal() === null && getRouteBinding() === null && requested === undefined;
}

/* ─── WorkspaceAccessDeniedError ───────────────────────────────── */

/**
 * Thrown by the substrate guard when a bound request tries to open a workspace
 * it is not authorized for. Carries `code='workspace_forbidden'` so the HTTP
 * error mapper turns it into a 403 with the canonical `{code, message}` shape.
 */
export class WorkspaceAccessDeniedError extends Error {
    readonly code = 'workspace_forbidden';
    readonly status = 403 as const;
    readonly boundTarget: string;
    readonly requestedWorkspace: string;
    constructor(boundTarget: string, requestedWorkspace: string) {
        super(
            `workspace confinement: request is bound to workspace "${boundTarget}", ` +
                `refusing to open "${requestedWorkspace}" (no authorized cross-workspace lane)`,
        );
        this.name = 'WorkspaceAccessDeniedError';
        this.boundTarget = boundTarget;
        this.requestedWorkspace = requestedWorkspace;
    }
}

/* ─── Denial envelope ──────────────────────────────────────────── */

/**
 * Write the canonical 4xx denial envelope. Wave 5: emits the single canonical
 * error shape `{ code, message }` (matching helpers.ts writeError), NOT the
 * legacy `{ error, reason }`. The machine code STRING is unchanged
 * (workspace_forbidden / workspace_required / ...) — it only moves from the
 * `error` field to `code`, and the human `reason` is folded into `message`.
 * The HTTP STATUS is unchanged (status codes are isolation-critical, covered
 * by the Wave-4 multi-app E2E). Kept in one place so every gate helper emits
 * an identical wire shape.
 */
function writeDenial(res: ServerResponse, status: number, code: string, reason?: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code, message: reason }));
}

/* ─── bindRouteTarget — the single data-plane gate ─────────────── */

/**
 * THE single route-facing target gate. Call exactly once, AFTER parsing
 * whatever carries the workspace (URL segment / query param / body field) and
 * BEFORE any substrate or store access:
 *
 *   const target = bindRouteTarget(res, { requested, intent: 'write' });
 *   if (target === null) return true;   // denial already written
 *   await deps.graphRegistry.withGraph(target, ...);
 *
 * Semantics:
 *   1. principal = getCurrentPrincipal(). `requested` is the route-parsed
 *      workspace (undefined when the route has no workspace parameter).
 *   2. target = requested ?? getRouteBinding()?.target ?? principal?.workspace.
 *      NEVER consults detectedScope / getActiveWorkspaceName / any boot value.
 *   3. Scope check with the CONCRETE target (never literal-undefined):
 *      requireWriteToWorkspace(principal, target) for 'write',
 *      requireReadFromWorkspace(principal, target) for 'read'.
 *   4. requested === '*' (aggregation): intent must be 'read'; requires
 *      cross-workspace-read; on success sets lane='cross-workspace', returns '*'.
 *   5. On failure: writes { code, message } with the outcome status and returns null.
 *   6. On success: MUTATES the slot (binding.target = target; lane stays
 *      'workspace' unless '*'), returns target. Re-binding to a different
 *      workspace repeats the scope check.
 *   7. Null principal (legacy/local bypass, direct-call test harnesses):
 *      preserved — scope check skipped; slot re-targeted if present.
 */
export function bindRouteTarget(
    res: ServerResponse,
    opts: { requested?: string; intent: 'read' | 'write' },
): string | null {
    const principal = getCurrentPrincipal();
    const slot = getRouteBinding();
    const requested = opts.requested;

    // ── workspace:"*" fan-out (read-only aggregation) ──
    if (requested === '*') {
        if (opts.intent !== 'read') {
            writeDenial(res, 403, 'workspace_forbidden', 'workspace:"*" is a read-only aggregation lane; there is no "*" write lane');
            return null;
        }
        if (principal) {
            const outcome = requireReadFromWorkspace(principal, '*');
            if (!outcome.ok) {
                writeDenial(res, outcome.status ?? 403, outcome.code ?? 'workspace_forbidden', outcome.reason);
                return null;
            }
        }
        if (slot) {
            slot.target = '*';
            slot.lane = 'cross-workspace';
        }
        return '*';
    }

    // ── concrete target ──
    const target = requested ?? slot?.target ?? principal?.workspace;
    if (target === undefined) {
        // No principal, no slot, no requested — cannot resolve a target. This
        // is only reachable off the HTTP path (direct-call harness with no
        // slot and no principal). Nothing to confine; caller falls through.
        return null;
    }

    if (principal) {
        const outcome =
            opts.intent === 'write'
                ? requireWriteToWorkspace(principal, target)
                : requireReadFromWorkspace(principal, target);
        if (!outcome.ok) {
            writeDenial(res, outcome.status ?? 403, outcome.code ?? 'workspace_forbidden', outcome.reason);
            return null;
        }
    }

    if (slot) {
        slot.target = target;
        // Widening back to a concrete workspace from '*'/operator would be a
        // scope-checked re-bind; keep the workspace lane for a concrete target.
        if (slot.lane === 'cross-workspace') slot.lane = 'workspace';
    }
    return target;
}

/* ─── bindDaemonOperatorLane — the control-plane gate ──────────── */

/**
 * The generalization of denyWorkspaceMutation (routes/workspaces/workspaceMgmt.ts).
 * For routes with daemon-wide semantics (workspace CRUD, daemon control, audit
 * export, connector/consent admin, config write) that legitimately touch
 * workspaces.json / many workspaces.
 *
 * Authorization model (copied verbatim from the fixed denyWorkspaceMutation):
 *   - null principal            → legacy/local bypass (allow); lane set if slot exists.
 *   - kind 'bootstrap'          → the human operator's daemon token; may manage
 *                                 ANY workspace. Allow; lane='daemon-operator'.
 *   - kind 'shared-secret'      → cross-workspace service principal. Allow;
 *                                 lane='daemon-operator'.
 *   - kind 'app', requested IS   a concrete workspace (workspace CRUD:
 *                                 delete/rename/retention on a NAMED workspace)
 *                                 → requireWriteToWorkspace(principal, requested):
 *                                 confined to own workspace, or crosses only with
 *                                 cross-workspace-write.
 *   - kind 'app', requested IS   undefined (a daemon-WIDE op that names NO
 *                                 workspace — daemon restart, daemon logs, audit
 *                                 export, admin stats, config write) → DENY unless
 *                                 the token holds cross-workspace-write. A
 *                                 workspace-less daemon-wide op is inherently
 *                                 cross-workspace/operator, so it must NOT
 *                                 self-authorize against the token's OWN
 *                                 workspace (that check trivially passes and would
 *                                 let a plain app token act as a daemon operator).
 *
 * Returns true on success (caller proceeds). On denial writes the {code, message}
 * envelope and returns false (caller must `return true`).
 */
export function bindDaemonOperatorLane(
    res: ServerResponse,
    opts: { intent: 'read' | 'write'; requested?: string },
): boolean {
    const principal = getCurrentPrincipal();
    const slot = getRouteBinding();

    // null principal — legacy/local bypass preserved.
    if (!principal) {
        if (slot) slot.lane = 'daemon-operator';
        return true;
    }

    if (principal.kind === 'bootstrap' || principal.kind === 'shared-secret') {
        if (slot) slot.lane = 'daemon-operator';
        return true;
    }

    // app token — a workspace-LESS daemon-wide op (no requested target) names no
    // workspace and is therefore inherently cross-workspace/operator: it must NOT
    // be self-authorized against the token's OWN workspace (that scope check
    // trivially passes and would let a plain app token restart the daemon, read
    // daemon logs, export the daemon-wide audit log, or enumerate every
    // workspace). Only a token holding cross-workspace-write may run it; bootstrap
    // and shared-secret operators are already handled above.
    if (opts.requested === undefined) {
        if (!principal.scopes.includes('cross-workspace-write')) {
            writeDenial(
                res,
                403,
                'workspace_forbidden',
                `token is scoped to workspace "${principal.workspace}", cannot run a daemon-wide operator operation (missing 'cross-workspace-write' scope)`,
            );
            return false;
        }
        if (slot) slot.lane = 'daemon-operator';
        return true;
    }

    // app token, concrete requested workspace (workspace CRUD) — confined to the
    // named workspace, crosses only with cross-workspace-write.
    const target = opts.requested;
    const outcome =
        opts.intent === 'write'
            ? requireWriteToWorkspace(principal, target)
            : requireReadFromWorkspace(principal, target);
    if (!outcome.ok) {
        writeDenial(res, outcome.status ?? 403, outcome.code ?? 'workspace_forbidden', outcome.reason);
        return false;
    }
    // An app token that passed for its OWN workspace stays workspace-laned; it
    // may only touch its own target. One that passed via cross-workspace-write
    // gets the operator lane so multi-workspace control ops are admitted.
    if (slot) {
        if (target !== principal.workspace) slot.lane = 'daemon-operator';
    }
    return true;
}

/* ─── authorizeExtraTarget — enumeration fan-out ───────────────── */

/**
 * For enumeration routes that per-item requireReadFromWorkspace then open each
 * authorized workspace (the diagnostic/storage.ts pattern). The route filters
 * the workspace list itself, then calls this for each workspace that passed —
 * the substrate guard then admits exactly that filtered set, never the full
 * registry.
 *
 * No-op when there is no slot (direct-call harness): the guard already
 * allows-when-slotless.
 */
export function authorizeExtraTarget(workspace: string): void {
    const slot = getRouteBinding();
    if (!slot) return;
    (slot.extraTargets ??= new Set<string>()).add(workspace);
}

/**
 * canPrincipalReadWorkspace — a PURE, non-mutating scope check for the
 * enumeration-filter half of the pattern above (routes filter a workspace
 * list with this, then call authorizeExtraTarget on each survivor). Unlike
 * bindRouteTarget, this does NOT touch the request's binding slot — running
 * it once per item in a filter callback must not corrode the bound target
 * partway through iteration. This is the one place a route-adjacent helper
 * wraps the raw requireReadFromWorkspace gate, keeping route files off the
 * D-021(b) banned-import list.
 */
export function canPrincipalReadWorkspace(principal: Parameters<typeof requireReadFromWorkspace>[0], workspace: string): boolean {
    return requireReadFromWorkspace(principal, workspace).ok;
}

/* ─── assertWorkspaceOpenAllowed — the substrate guard ─────────── */

/**
 * The SUBSTRATE guard, called as the first statement of every
 * workspace-addressed substrate open:
 *   - LocalGraphRegistry.getOrOpen (withGraph delegates to it)
 *   - WorkspaceVerbatimResolver.getOrOpen
 *   - LocalGraph write surface (upsertNode/addEdge/deleteNode/deleteEdge/
 *     supersede/unsupersede) via its own this.workspaceId.
 *
 * Semantics:
 *   - NO slot (daemon boot, timers, outbox replicator, SyncPoller, CLI, stdio
 *     MCP, embedded, direct-call unit harnesses) → ALLOW. By construction this
 *     means the caller is not an authenticated local HTTP request.
 *   - Slot present → ALLOW iff
 *       workspace === binding.target
 *       || binding.extraTargets?.has(workspace)
 *       || binding.lane !== 'workspace'
 *     else THROW WorkspaceAccessDeniedError (403 workspace_forbidden).
 */
export function assertWorkspaceOpenAllowed(workspace: string): void {
    const binding = getRouteBinding();
    if (!binding) return; // slotless caller — not a gated local HTTP request.
    if (workspace === binding.target) return;
    if (binding.extraTargets?.has(workspace)) return;
    if (binding.lane !== 'workspace') return; // cross-workspace / daemon-operator lane.
    throw new WorkspaceAccessDeniedError(binding.target, workspace);
}
