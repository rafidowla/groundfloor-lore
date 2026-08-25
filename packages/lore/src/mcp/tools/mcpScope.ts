/**
 * mcpScope.ts — SP-01 principal/workspace scope gate for MCP tools.
 *
 * Per-app tokens are bound to a single workspace at the HTTP-route level
 * (Phase 6 P3, `auth/principal.ts`). The HTTP routes enforce that binding
 * via `requireWriteToWorkspace` / `requireReadFromWorkspace` (see
 * `http/routes/nodes/postNode.ts`). The MCP tool handlers, however, read
 * `args.workspace` and act on it WITHOUT consulting the bound principal —
 * so a token issued via `lore auth issue --workspace developer` could
 * read or modify ANY registered workspace (or `workspace:"*"`) through the
 * MCP surface. SP-01 closes that hole.
 *
 * `assertMcpScope` mirrors the established HTTP pattern exactly:
 *
 *   1. Resolve the current request principal via `getCurrentPrincipal()`
 *      (bound in AsyncLocalStorage by `withPrincipalIfAny` in
 *      `http/dispatcher.ts`; the MCP transport at `/mcp` runs inside that
 *      same ALS context, so tool handlers can read it without threading).
 *   2. `principal === null` means NO auth was performed — the legacy /
 *      test bypass. We keep current behavior so existing fixtures (and the
 *      local single-token, single-workspace happy path) are untouched.
 *      This is the SAME convention `postNode.ts:72` uses.
 *   3. Otherwise run the matching scope guard. A scoped principal hitting
 *      a different workspace — or `workspace:"*"` without
 *      `cross-workspace-*` — is refused with a `workspace_forbidden`
 *      envelope. Bootstrap / shared-secret / cross-workspace-scoped /
 *      admin principals are unaffected.
 *
 * The return contract matches `workspaceRequiredEnvelope`: `null` when the
 * call is allowed (handler proceeds), or an `isError: true` MCP envelope to
 * be returned immediately when it is not.
 */

import {
    getCurrentPrincipal,
    requireReadFromWorkspace,
    requireWriteToWorkspace,
} from '../../auth/principal.js';

export type McpScopeMode = 'read' | 'write';

/**
 * Error envelope shape returned to the MCP caller on refusal.
 *
 * The index signature keeps this structurally assignable to the MCP SDK's
 * `CallToolResult` return type (which carries `[x: string]: unknown` for
 * the `_meta` passthrough), so a handler can `return assertMcpScope(...)`
 * directly without a cast.
 */
export interface McpScopeDenied {
    [x: string]: unknown;
    content: Array<{ type: 'text'; text: string }>;
    isError: true;
}

function forbiddenEnvelope(
    code: string,
    reason: string | undefined,
    tokenWorkspace: string,
): McpScopeDenied {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify({
                error: code,
                reason,
                token_workspace: tokenWorkspace,
            }, null, 2),
        }],
        isError: true,
    };
}

/**
 * Gate an MCP tool call against the bound principal's workspace scope.
 *
 * @param requestedWorkspace the `workspace` argument the caller passed
 *        (may be `'*'`, a name, or undefined/empty — undefined defers to
 *        the principal's own binding and is always allowed).
 * @param mode `'read'` for read tools, `'write'` for mutating tools.
 * @returns `null` when the call is permitted; otherwise an MCP error
 *          envelope the handler must return as-is.
 */
export function assertMcpScope(
    requestedWorkspace: string | undefined,
    mode: McpScopeMode,
): McpScopeDenied | null {
    const principal = getCurrentPrincipal();
    // No principal bound → no auth was performed (legacy / test / local
    // single-workspace boot). Preserve existing behavior, exactly as the
    // HTTP gate does (postNode.ts:72). The workspace-required and
    // workspace-not-found checks still run downstream in the handler.
    //
    // F-LOW-T13: this null-principal bypass is the documented LOCAL/legacy
    // path and fails OPEN. mcpScope is a pure gate with no deployment-mode
    // dependency threaded in, so the only mode signal reachable here without
    // a risky refactor is the LORE_DEPLOYMENT_MODE env var. When it
    // explicitly says 'cloud', a missing principal is a genuine auth gap, so
    // fail CLOSED. For every other case (unset / 'local' / 'embedded' / can't
    // tell) behavior is unchanged — the local happy path keeps its bypass.
    //
    // RESIDUAL: cloud configured purely via config.json (deploymentMode:
    // 'cloud') WITHOUT the env var is NOT detected here and still fails open.
    // Closing that requires threading the resolved deployment mode into this
    // gate (out of scope for a conservative defense-in-depth change); the
    // HTTP layer is the primary auth boundary in cloud mode regardless.
    if (!principal) {
        const envMode = process.env['LORE_DEPLOYMENT_MODE']?.trim().toLowerCase();
        if (envMode === 'cloud') {
            return forbiddenEnvelope('workspace_forbidden', 'no authenticated principal (cloud mode)', '');
        }
        return null;
    }

    const target =
        typeof requestedWorkspace === 'string' && requestedWorkspace.length > 0
            ? requestedWorkspace
            : undefined;

    const outcome = mode === 'write'
        ? requireWriteToWorkspace(principal, target)
        : requireReadFromWorkspace(principal, target);

    if (outcome.ok) return null;
    return forbiddenEnvelope(
        outcome.code ?? 'workspace_forbidden',
        outcome.reason,
        principal.workspace,
    );
}
