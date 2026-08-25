/**
 * arcadeMaintenance.ts — node-lifecycle + maintenance ops for the ArcadeDB
 * db-per-app adapter (branch: spike/arcadedb-multitenant, slice 2).
 *
 * Extracted from arcadeGraphStore.ts to keep that file near the 500-line target
 * (mirrors LocalGraph's nodeLifecycle.ts / retentionSweep split). Every function
 * takes the (tenantDb, http) pair explicitly — never `this` — so it can't smuggle
 * in a db other than the one ArcadeGraphStore passes, preserving the "tenantDb
 * only ever comes from the constructor" isolation invariant.
 *
 * Contract parity target: LocalGraph's nodeLifecycle.supersedeNode /
 * unsupersedeNode and localGraph.markStaleByTags / pruneEphemeralNodes.
 *
 * TRAP POSTURE: every statement here is a plain parameterized SELECT / UPDATE /
 * DELETE VERTEX on the LoreNode vertex table — NONE use both()/expand-of-expand,
 * so the T1 (both()-projection filter) and T2 (WHERE-atop-expand-of-expand)
 * traps do not apply. The one place a naïve SQL predicate would be silently
 * wrong is tag membership (a `LIKE '%auth%'` would match "authentication"),
 * which markStaleByTags handles with a two-step SELECT-candidates → client-side
 * exact-membership confirm, exactly as the plan requires.
 */

import type { LoreNode } from '../../providers/types.js';
import type { ArcadeHttp } from './arcadeHttp.js';
import { NODE_TYPE } from './arcadeSchema.js';

type NodeRow = Record<string, unknown>;
type GetNode = (id: string) => Promise<LoreNode | null>;

/** Bounded fetch cap for the ephemeral scan (mirrors LocalGraph's DEFAULT_LIST_NODES_CAP). */
const EPHEMERAL_SCAN_CAP = 10_000;

/**
 * supersedeNode — mark `oldId` superseded by `newId`. The node stays in the
 * graph (edges intact); default reads filter it out. Returns {ok:false,reason}
 * for self / old-not-found / new-not-found — byte-for-byte the same reason
 * codes LocalGraph/nodeLifecycle returns. Plain parameterized UPDATE.
 */
export async function supersedeNode(
  tenantDb: string,
  http: ArcadeHttp,
  getNode: GetNode,
  oldId: string,
  newId: string,
  reason?: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (oldId === newId) return { ok: false, reason: 'self' };
  const oldNode = await getNode(oldId);
  if (!oldNode) return { ok: false, reason: 'old-not-found' };
  const newNode = await getNode(newId);
  if (!newNode) return { ok: false, reason: 'new-not-found' };
  const at = new Date().toISOString();
  // NOTE: the bound param cannot be named `by` — ArcadeDB 26.7.1's SQL parser
  // treats a `:by` placeholder as the `BY` keyword and throws
  // CommandSQLParsingException ("no viable alternative at input 'by'"). Use a
  // non-reserved param name (`newid`). Confirmed live.
  await http.command(
    tenantDb,
    `UPDATE ${NODE_TYPE} SET supersededBy = :newid, supersededAt = :at, ` +
      `supersededReason = :reason WHERE id = :id`,
    { id: oldId, newid: newId, at, reason: reason ?? '' },
  );
  return { ok: true };
}

/**
 * unsupersedeNode — reverse a prior supersession. Clears the three columns to
 * empty strings (schema-default "current"). Returns true iff the node existed
 * (existence-gated, like LocalGraph). Idempotent.
 */
export async function unsupersedeNode(
  tenantDb: string,
  http: ArcadeHttp,
  getNode: GetNode,
  id: string,
): Promise<boolean> {
  const node = await getNode(id);
  if (!node) return false;
  await http.command(
    tenantDb,
    `UPDATE ${NODE_TYPE} SET supersededBy = '', supersededAt = '', ` +
      `supersededReason = '' WHERE id = :id`,
    { id },
  );
  return true;
}

/**
 * markStaleByTags — mark stale every LoreNode whose tags include ANY of the
 * provided tags (EXACT membership, case-insensitive). Returns the count marked.
 *
 * TWO-STEP to stay both trap-safe AND JSON-tags-correct (the plan's exact
 * shape): tags are stored as a JSON-encoded string[] text column, so a raw
 * `tags LIKE '%auth%'` would wrongly match "authentication". Step 1 issues a
 * bounded candidate SELECT per tag using the quoted-literal LIKE proxy
 * (`%"auth"%`) — a coarse prefilter. Step 2 parses each candidate's JSON tags
 * client-side and confirms EXACT membership before including it. Step 3 issues
 * ONE batched UPDATE ... WHERE id IN :ids. All plain scalar SQL — no
 * expand()/both(), so traps T1/T2 don't apply.
 */
export async function markStaleByTags(
  tenantDb: string,
  http: ArcadeHttp,
  tags: string[],
): Promise<number> {
  const wanted = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return 0;
  const wantedSet = new Set(wanted);

  // Step 1 — bounded candidate prefilter. One LIKE branch per tag ORed
  // together; each matches the quoted tag literal inside the JSON text. Params
  // bound, never interpolated.
  const likeParts: string[] = [];
  const params: Record<string, unknown> = {};
  wanted.forEach((t, i) => {
    likeParts.push(`tags LIKE :t${i}`);
    params[`t${i}`] = `%"${t}"%`;
  });
  const candRes = await http.query(
    tenantDb,
    `SELECT id, tags FROM ${NODE_TYPE} WHERE (${likeParts.join(' OR ')}) LIMIT ${EPHEMERAL_SCAN_CAP}`,
    params,
  );

  // Step 2 — confirm exact membership by parsing the JSON tags column.
  const ids: string[] = [];
  for (const row of (candRes.result ?? []) as NodeRow[]) {
    const id = String(row['id'] ?? '');
    if (!id) continue;
    let parsed: unknown = [];
    const raw = row['tags'];
    if (Array.isArray(raw)) parsed = raw;
    else if (typeof raw === 'string' && raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = [];
      }
    }
    const rowTags = Array.isArray(parsed) ? parsed.map((x) => String(x).toLowerCase()) : [];
    if (rowTags.some((t) => wantedSet.has(t))) ids.push(id);
  }
  if (ids.length === 0) return 0;

  // Step 3 — one batched UPDATE over the confirmed id set.
  const at = new Date().toISOString();
  await http.command(
    tenantDb,
    `UPDATE ${NODE_TYPE} SET stale = true, staleAt = :at WHERE id IN :ids`,
    { at, ids },
  );
  return ids.length;
}

/**
 * pruneEphemeralNodes — delete expired ephemeral scratchpad nodes. Expiry math
 * is done CLIENT-SIDE (per-row ttl_ms ?? default, measured from createdAt) — we
 * deliberately never ask ArcadeDB to do date arithmetic, which is exactly the
 * kind of silent-wrong-results surface the traps taught us to distrust. The
 * delete is one batched `DELETE VERTEX ... WHERE id IN :ids` (vertex delete
 * detaches incident edges, proven in slice 1). Returns the count deleted.
 * Non-fatal on error (mirrors LocalGraph): a prune failure never propagates.
 */
export async function pruneEphemeralNodes(
  tenantDb: string,
  http: ArcadeHttp,
  defaultTtlMs = 3_600_000,
): Promise<number> {
  try {
    const res = await http.query(
      tenantDb,
      `SELECT id, createdAt, ttl_ms FROM ${NODE_TYPE} WHERE ephemeral = true LIMIT ${EPHEMERAL_SCAN_CAP}`,
    );
    const now = Date.now();
    const expired: string[] = [];
    for (const row of (res.result ?? []) as NodeRow[]) {
      const id = String(row['id'] ?? '');
      const createdAt = String(row['createdAt'] ?? '');
      if (!id || !createdAt) continue;
      const ttlRaw = row['ttl_ms'];
      const ttl = typeof ttlRaw === 'number' && ttlRaw > 0 ? ttlRaw : defaultTtlMs;
      const createdMs = new Date(createdAt).getTime();
      if (!Number.isFinite(createdMs)) continue;
      if (now - createdMs > ttl) expired.push(id);
    }
    if (expired.length === 0) return 0;
    await http.command(
      tenantDb,
      `DELETE VERTEX FROM ${NODE_TYPE} WHERE id IN :ids`,
      { ids: expired },
    );
    return expired.length;
  } catch (error) {
    // Non-fatal — prune failure should never block the daemon (LocalGraph parity).
    console.error(
      `[ArcadeMaintenance] pruneEphemeralNodes failed (non-fatal): ${(error as Error).message}`,
    );
    return 0;
  }
}
