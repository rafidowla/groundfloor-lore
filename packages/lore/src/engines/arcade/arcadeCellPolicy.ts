/**
 * arcadeCellPolicy.ts — per-cell vocab policy, the arcade analogue of a local
 * workspace's `vocabPolicy` (spike/arcadedb-multitenant, Slice 4).
 *
 * ── WHY THIS EXISTS (the bug it fixes) ───────────────────────────────────────
 * In arcade mode, POST /api/node's vocab gate resolves the policy via
 * getWorkspaceVocabPolicy(cellWorkspace = appId), which reads workspaces.json —
 * a file that has NO cell entries in arcade mode. So the lookup THROWS
 * "Unknown workspace <appId>", the gate's catch logs "vocab policy lookup
 * failed" and DEFAULT-ACCEPTS. Net effect: per-write log noise + a
 * structurally-unreachable policy = a silent policy bypass.
 *
 * The fix is a SEAM (GateDeps.getVocabPolicy in storeNodeGates.ts) backed by
 * this module, which reads the policy from the daemon relational lane
 * (`cell_policies` in arcade-provisioning.sqlite) — NEVER inside ArcadeDB
 * (relationalLaneDecision). Cells are registry rows, not workspaces.json
 * entries; teaching workspaces.json about cells would be the wrong layer.
 *
 * ── THE DEFAULT ──────────────────────────────────────────────────────────────
 * No row → {mode:'open', onMismatch:'warn'} — EXACTLY the default a local
 * workspace without an explicit policy gets (config/workspaces.ts
 * getWorkspaceVocabPolicy). So "no policy configured" is an intentional,
 * documented open-mode default in BOTH modes, not a bypass.
 */

import type { WorkspaceVocabPolicy } from '../../config/workspaces.js';
import { openTokenDbForLifecycle } from './arcadeAuthResolver.js';

/** The documented default when no policy row exists — parity with a local
 *  workspace that has no explicit vocabPolicy. */
export const DEFAULT_CELL_VOCAB_POLICY: WorkspaceVocabPolicy = Object.freeze({
  mode: 'open',
  onMismatch: 'warn',
});

/**
 * getCellVocabPolicy — resolve a cell's vocab policy from `cell_policies`, or
 * the documented open default when no row exists. A genuine SQLite read error
 * propagates (the caller's soft-fail catch treats it as an I/O fault + default-
 * accept, matching local's soft-fail on a mid-edit workspaces.json) — but that
 * is now an I/O fault, NOT the structural every-request miss it was before.
 */
export function getCellVocabPolicy(
  tenantId: string,
  appId: string,
  opts?: { registryDbPath?: string },
): WorkspaceVocabPolicy {
  const db = openTokenDbForLifecycle(opts?.registryDbPath);
  const row = db
    .prepare(`SELECT vocab_policy FROM cell_policies WHERE tenant_id = ? AND app_id = ?`)
    .get(tenantId, appId) as { vocab_policy: string } | undefined;
  if (!row) return { ...DEFAULT_CELL_VOCAB_POLICY };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.vocab_policy);
  } catch {
    // A corrupt stored policy is an I/O-class fault: fall back to the open
    // default rather than throwing per-request. (setCellVocabPolicy validates
    // on write, so this is defense in depth, not the happy path.)
    return { ...DEFAULT_CELL_VOCAB_POLICY };
  }
  return coercePolicy(parsed);
}

/** Narrow a parsed JSON blob to a WorkspaceVocabPolicy, defaulting unknown
 *  fields to the open default. */
function coercePolicy(raw: unknown): WorkspaceVocabPolicy {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const mode = obj['mode'];
  const onMismatch = obj['onMismatch'];
  const modeOk = mode === 'allowlist' || mode === 'denylist' || mode === 'open';
  const onMismatchOk = onMismatch === 'reject' || onMismatch === 'hitl' || onMismatch === 'warn';
  const types = Array.isArray(obj['types'])
    ? (obj['types'] as unknown[]).filter((t): t is string => typeof t === 'string')
    : undefined;
  return {
    mode: modeOk ? (mode as WorkspaceVocabPolicy['mode']) : 'open',
    ...(types && types.length > 0 ? { types } : {}),
    onMismatch: onMismatchOk ? (onMismatch as WorkspaceVocabPolicy['onMismatch']) : 'warn',
  };
}

/** Thrown by setCellVocabPolicy when the requested policy cannot be honored in
 *  arcade v1 (onMismatch:'hitl' — the arcade daemon wires no PendingOpsStore).
 *  Mapped by the policy route to 400 policy_mode_not_supported. */
export class CellPolicyUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CellPolicyUnsupportedError';
  }
}

/**
 * setCellVocabPolicy — persist (upsert) a cell's vocab policy. Validates
 * mode/onMismatch with the SAME rules as setWorkspaceVocabPolicy, and REJECTS
 * onMismatch:'hitl' at SET time (arcade v1 has no pending-ops store — reject the
 * unsupported mode loudly rather than let a hitl policy 503 every write later).
 */
export function setCellVocabPolicy(
  tenantId: string,
  appId: string,
  policy: WorkspaceVocabPolicy,
  opts?: { registryDbPath?: string },
): WorkspaceVocabPolicy {
  if (policy.mode !== 'allowlist' && policy.mode !== 'denylist' && policy.mode !== 'open') {
    throw new Error(`Invalid vocabPolicy.mode "${policy.mode}" (expected allowlist|denylist|open)`);
  }
  if (policy.onMismatch === 'hitl') {
    throw new CellPolicyUnsupportedError(
      'onMismatch:"hitl" requires a pending-ops store; arcade v1 supports reject|warn',
    );
  }
  if (policy.onMismatch !== 'reject' && policy.onMismatch !== 'warn') {
    throw new Error(`Invalid vocabPolicy.onMismatch "${policy.onMismatch}" (expected reject|warn in arcade)`);
  }
  const normalized: WorkspaceVocabPolicy = {
    mode: policy.mode,
    ...(policy.types && policy.types.length > 0 ? { types: policy.types.slice() } : {}),
    onMismatch: policy.onMismatch,
  };
  const db = openTokenDbForLifecycle(opts?.registryDbPath);
  db.prepare(
    `INSERT INTO cell_policies (tenant_id, app_id, vocab_policy, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id, app_id) DO UPDATE SET vocab_policy = excluded.vocab_policy, updated_at = excluded.updated_at`,
  ).run(tenantId, appId, JSON.stringify(normalized), new Date().toISOString());
  return normalized;
}

/** Delete a cell's policy row (revert to the open default). Idempotent. */
export function deleteCellVocabPolicy(
  tenantId: string,
  appId: string,
  opts?: { registryDbPath?: string },
): void {
  const db = openTokenDbForLifecycle(opts?.registryDbPath);
  db.prepare(`DELETE FROM cell_policies WHERE tenant_id = ? AND app_id = ?`).run(tenantId, appId);
}
