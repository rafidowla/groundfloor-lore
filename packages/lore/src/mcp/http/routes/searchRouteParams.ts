/**
 * searchRouteParams.ts — query-param parsing shared by search.ts's GET
 * /api/recall + /api/search handlers.
 *
 * Extracted from search.ts (D1) to keep that file under the repo's 800-line
 * file-size cap; pure functions only, no behavior change.
 */

import type { ServerResponse } from 'node:http';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';

/** Retrieval mode shared by /api/search + /api/recall (parity with the MCP tools). */
export type RetrievalMode = 'semantic' | 'keyword' | 'hybrid';

/**
 * P7 — parse the optional `search_mode` query param for /api/search and
 * /api/recall, bringing REST to parity with the MCP search/recall tools (which
 * have always accepted it). Absent/empty → 'hybrid' (the prior REST behaviour,
 * so existing callers are unaffected). An unrecognised value returns an error
 * marker the route maps to HTTP 400 rather than silently coercing it.
 */
export function parseSearchMode(params: URLSearchParams): RetrievalMode | { error: string } {
    const raw = params.get('search_mode');
    if (raw === null || raw === '') return 'hybrid';
    if (raw === 'semantic' || raw === 'keyword' || raw === 'hybrid') return raw;
    return { error: `invalid search_mode "${raw}" — must be one of: semantic, keyword, hybrid` };
}

/**
 * P8 — parse the optional comma-separated `tags` query param (e.g.
 * `?tags=auth,security`) for /api/search and /api/recall, matching the MCP
 * tools' `tags` filter (keep only nodes carrying ALL listed tags). Absent →
 * undefined (no filter), so existing callers are unaffected.
 */
export function parseTags(params: URLSearchParams): string[] | undefined {
    const raw = params.get('tags');
    if (!raw) return undefined;
    const arr = raw.split(',').map((t) => t.trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
}

/**
 * 3.21 step 3(f) — parse repeated `?queries=<phrasing>` query params (one
 * per phrasing, NOT comma-split — a phrasing is free text and may itself
 * contain commas, unlike `tags`/`entities`/`topics`). Absent → undefined
 * (no extra phrasings), matching the MCP tools' optional `queries[]`.
 * Caller (retrieve()) enforces the 5-extra cap; this just passes through.
 */
export function parseQueries(params: URLSearchParams): string[] | undefined {
    const arr = params.getAll('queries').map((q) => q.trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
}

/**
 * 3.21 step 3(f) — parse the optional comma-separated `entities`/`topics`
 * query params, matching the MCP tools' filters over the metadata fields
 * introduced in 3.21 step 3(e). Absent → undefined (no filter).
 */
export function parseCsvParam(params: URLSearchParams, name: string): string[] | undefined {
    const raw = params.get(name);
    if (!raw) return undefined;
    const arr = raw.split(',').map((t) => t.trim()).filter(Boolean);
    return arr.length > 0 ? arr : undefined;
}

/**
 * denyCrossWorkspaceRead — SP-04 shared read-scope gate for the
 * workspace-scoped read routes (/api/search, /api/nodes, /api/query).
 *
 * Mirrors the writer paths' bindRouteTarget wiring: when a principal is
 * bound (Bearer call), a request for a workspace other than the
 * principal's binding — or `"*"` — requires `cross-workspace-read`. When
 * NO principal is bound, the gate is a no-op so the legacy / local
 * single-workspace happy path and the existing fixtures keep working
 * (same null-principal bypass the write routes use). Returns true when it
 * wrote a 4xx response and the caller must `return` immediately; false
 * when the request may proceed.
 *
 * /api/recall is NOT routed through this helper — it has its own scope
 * gate inline in the handler. (Historic note: recall was on the public
 * allowlist until 2026-06-19; the inline handler still has a defense-in-
 * depth null-principal branch, kept for the sp04 unit tests that bypass
 * middleware.)
 */
export function denyCrossWorkspaceRead(res: ServerResponse, requestedWorkspace: string): boolean {
    return bindRouteTarget(res, { requested: requestedWorkspace, intent: 'read' }) === null;
}

/**
 * D1 review fix — `?abstain=true|false`. ABSENT must be `undefined`, not
 * `false`: retrieve() resolves `opts.abstain ?? LORE_RECALL_ABSTAIN`, so an
 * explicit `false` for a missing param silently disabled the operator's env
 * default on REST only (the MCP tools already pass `undefined`).
 */
export function parseAbstainParam(params: URLSearchParams): boolean | undefined {
    const raw = params.get('abstain');
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
}
