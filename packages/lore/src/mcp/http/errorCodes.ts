/**
 * errorCodes.ts — Canonical machine `code` strings for the `{code, message,
 * ...extras}` error envelope (see `writeError` in helpers.ts).
 *
 * Why this file exists (v1 contract-freeze error-code hygiene audit): codes
 * were invented ad hoc at each call site with no shared source of truth. The
 * auth lane in particular drifted to plain-English, space-separated strings
 * ('auth required', 'host not allowed', 'invalid actor token') while the rest
 * of the codebase had already standardized on snake_case machine codes
 * (workspace_not_found, payload_too_large, workspace_forbidden, ...).
 * `auth/principal.ts` had independently already picked `auth_required`
 * (correct) for its own 401s — proving the drift is real, not hypothetical:
 * two call sites for "you're not authenticated" emitted two different code
 * strings.
 *
 * Scope (deliberately bounded): this pass normalizes the auth-lane codes
 * that had drifted (space-separated strings) to snake_case and gives them a
 * single home. It does NOT rename codes that are already correct and widely
 * used elsewhere (workspace_forbidden, outbox_lag, payload_too_large,
 * workspace_required, workspace_not_found, ...) — those are re-exported here
 * for convenience where cheap, but their point of truth / doc comments stay
 * where they already live (helpers.ts, routeWorkspaceBinding.ts) to avoid
 * import churn across every existing call site.
 *
 * Adding a new error code: put the constant here, not inline at the call
 * site. `message` (human text) is free-form and NOT part of this registry —
 * only the stable machine `code` is.
 */

// ── Auth lane (security/httpAuth.ts, mcp/http/middleware.ts) ──
// Previously ad-hoc space-separated strings that doubled as both `code` and
// `message` (see httpAuth.ts's writeAuthFailure doc comment for why code
// and message are intentionally identical for these — the body is
// deliberately minimal / non-enumerating).
export const AUTH_REQUIRED = 'auth_required';
export const HOST_NOT_ALLOWED = 'host_not_allowed';
export const ORIGIN_NOT_ALLOWED = 'origin_not_allowed';
export const INVALID_ACTOR_TOKEN = 'invalid_actor_token';
/** Already snake_case at its one call site (middleware.ts); re-exported so
 *  every auth-lane code has one home. */
export const TOKEN_EXPIRED = 'token_expired';

// ── Re-exports of already-correct, widely-used codes ──
// Point of truth stays at the original definition site; this just gives
// callers a single `errorCodes.ts` import if they want it. Not required
// reading for AUTH_REQUIRED et al. above.
export { PAYLOAD_TOO_LARGE } from './helpers.js';

/** Workspace not found — canonical HTTP status is 404 (matches every other
 *  `*_not_found` code in routes/**: node_not_found, edge_not_found,
 *  proposal_not_found, etc.). */
export const WORKSPACE_NOT_FOUND = 'workspace_not_found';
/** Emitted by security/routeWorkspaceBinding.ts (WorkspaceAccessDeniedError,
 *  HTTP 403) when a bound request targets a workspace outside its
 *  authorized set. */
export const WORKSPACE_FORBIDDEN = 'workspace_forbidden';
/** Emitted by mcp/http/helpers.ts writeWorkspaceRequired (HTTP 400) when a
 *  route is called without an explicit `workspace` argument. */
export const WORKSPACE_REQUIRED = 'workspace_required';
/** Emitted by mcp/http/helpers.ts writeOutboxBackpressure (HTTP 503). */
export const OUTBOX_LAG = 'outbox_lag';
/** Consent-gated apply denial (routes/admin.ts, routes/ingestion.ts, HTTP 403). */
export const CONSENT_DENIED = 'consent_denied';

// ── Arcade Slice-4: workspace→cell migration + cell policy ──
/** Workspace export refused because the workspace still has un-drained outbox
 *  rows — the export would snapshot a graph ahead of its vectors
 *  (routes/workspaceExport.ts, HTTP 409). */
export const OUTBOX_NOT_DRAINED = 'outbox_not_drained';
/** Import refused because the bundle's embeddings were built with a different
 *  embedding model / dimension than the target cell provisioned — carrying
 *  them would corrupt the vector index. Caller may pass {reEmbed:true}
 *  (routes/arcadeMigrate.ts, HTTP 409). */
export const EMBEDDING_MODEL_MISMATCH = 'embedding_model_mismatch';
/** A concurrent import of the same cell is already running (guarded by the
 *  provisioner's withCellLock) — routes/arcadeMigrate.ts, HTTP 409. */
export const MIGRATION_IN_PROGRESS = 'migration_in_progress';
/** A cell vocab policy set with onMismatch:'hitl' — arcade v1 wires no
 *  pending-ops store, so it is rejected at SET time (routes/arcadePolicy.ts,
 *  HTTP 400). */
export const POLICY_MODE_NOT_SUPPORTED = 'policy_mode_not_supported';
/** The local-daemon workspace-export route has passed its gate + outbox-drain
 *  precondition but the streaming bundle body (edges + verbatim embeddings) is
 *  not yet implemented in this build — a WHOLE-response fail-loud so no caller
 *  ever receives a silently-partial NDJSON bundle (routes/workspaceExport.ts,
 *  HTTP 501). See the Slice-4 deferral note. */
export const EXPORT_NOT_IMPLEMENTED = 'export_not_implemented';

// ── Arcade Slice-5: GA hardening (leases, rate-limit, backup/restore) ──
/** A provisioner verb (provision/disable/destroy/rotate/migrate) could not
 *  acquire the cross-daemon cell lease because another live daemon holds it
 *  (engines/arcade/arcadeCellLease.ts CellLeaseHeldError, HTTP 409). Envelope
 *  carries {holder, retryAfterSec}. Consistent with MIGRATION_IN_PROGRESS. */
export const CELL_LEASE_HELD = 'cell_lease_held';
/** Operator/tenant request throttled by the arcade rate limiter
 *  (mcp/arcadeBoot.ts, HTTP 429). Envelope carries {retryAfterSec} +
 *  Retry-After / X-RateLimit-* headers. */
export const RATE_LIMITED = 'rate_limited';
/** A restore bundle failed per-section sha256 / manifest_hash verification
 *  before any write (routes/arcadeBackup.ts, HTTP 409) — zero writes applied. */
export const BUNDLE_HASH_MISMATCH = 'bundle_hash_mismatch';
/** Restore refused because the target cell is non-empty and {force:true} was
 *  not passed (routes/arcadeBackup.ts, HTTP 409). */
export const RESTORE_TARGET_NOT_EMPTY = 'restore_target_not_empty';

// ── Launch decision 2026-08-19: streaming ingest is cloud-only ──
/** POST /api/stream/connect + GET /api/stream/sessions refused at DISPATCH in
 *  any non-cloud deployment — the warm-lane streaming surface ships cloud-only
 *  for the local/embedded launch (routes/stream.ts tryStreamRoutes, HTTP 501).
 *  501 (not 404) so a caller can tell "route exists, gated in this deployment"
 *  from "unknown path". */
export const STREAM_INGEST_CLOUD_ONLY = 'stream_ingest_cloud_only';
