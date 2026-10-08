/**
 * arcadeNodeScopes.ts — LoreNode.security_scopes on the Arcade vertex (schema v4).
 *
 * WHY: security/itemScopes.ts resolves an item's labels from the LIVE GRAPH NODE
 * first and returns on the first source that has the item. Until v4 the Arcade
 * LoreNode vertex had no scopes column, so every Arcade node read back as public
 * and the 3.29 read gates / 3.30 write gates let a bound actor see and mutate
 * hidden items (the canonical `lore:<id>` verbatim row held the labels, but was
 * never consulted). v4 stores the labels on the node, as SQLite does.
 *
 * ENCODING: JSON-encoded string[] in a STRING column (same as `tags`). NULL means
 * "pre-v4 row, not backfilled yet" and is NEVER served: ArcadeGraphStore.initialize
 * runs upgradeNodeScopes before it marks the schema ready, and a failed backfill
 * throws, so a half-upgraded cell cannot serve.
 *
 * WRITE SEMANTICS (parity with SQLite toNodeRow): an explicit array — including
 * [] — wins; scopes omitted on a re-store keep the prior value; a new node with
 * scopes omitted is [] (public).
 */

import type { ArcadeHttp } from './arcadeHttp.js';
import { NODE_TYPE, VERBATIM_TYPE } from './arcadeSchema.js';
import { isDamagedScopes } from '../../security/itemScopes.js';
import { normalizeScopes } from '../../security/scopeFilter.js';

/** Column value for a node's labels. */
export function encodeNodeScopes(scopes: readonly string[]): string {
  return JSON.stringify(scopes);
}

/**
 * Decode a stored value. null/undefined/'' -> [] (public; only reachable on a
 * pre-v4 row, which the upgrade backfills before it can be served). A value that
 * is not valid JSON is read as a comma list (the verbatim encoding) rather than
 * dropped: an unreadable label must stay a restriction, never become public.
 */
export function parseNodeScopes(raw: unknown): string[] {
  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return normalizeScopes(raw.map(String));
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeScopes(parsed.map(String));
    } catch {
      /* fall through to the comma form */
    }
  }
  return normalizeScopes(raw);
}

/** Labels to persist: explicit array (incl. []) wins; omitted keeps the prior row's; else []. */
export function resolveNodeScopes(incoming: unknown, existing: unknown): string[] {
  if (Array.isArray(incoming)) return normalizeScopes(incoming.map(String));
  return parseNodeScopes(existing);
}

export interface NodeScopesUpgradeResult {
  /** Nodes whose labels were copied from their canonical `lore:<id>` verbatim row. */
  backfilledFromVerbatim: number;
  /** Nodes given [] (no verbatim row) - SQLite's default for a node stored without scopes. */
  defaultedPublic: number;
  /**
   * Nodes whose verbatim row holds damaged ('undefined') labels. The damaged labels are
   * copied as-is so the node stays fail-closed, like the row; never widened to [].
   */
  damagedVerbatim: number;
}

const PAGE = 200;

/**
 * upgradeNodeScopes — idempotent v3 -> v4 data step. Backfills every LoreNode whose
 * security_scopes is NULL from verbatim row `lore:<id>` (damaged labels are copied
 * as-is, staying fail-closed), else []. Paged (no per-node round trip); each UPDATE is guarded by `IS NULL`, so a
 * concurrent write that set the column wins. Re-running is a no-op. Throws on any
 * failure (including no forward progress) - the caller must then treat the cell as
 * stale. Requires the `security_scopes` property to already exist (graphSchemaDdl).
 */
export async function upgradeNodeScopes(tenantDb: string, http: ArcadeHttp): Promise<NodeScopesUpgradeResult> {
  const out: NodeScopesUpgradeResult = { backfilledFromVerbatim: 0, defaultedPublic: 0, damagedVerbatim: 0 };
  const done = new Set<string>();
  let verbatimExists: boolean | undefined;
  for (;;) {
    const page = await http.query(tenantDb, `SELECT id FROM ${NODE_TYPE} WHERE security_scopes IS NULL LIMIT ${PAGE}`);
    const ids = ((page.result ?? []) as Array<Record<string, unknown>>).map((r) => String(r['id'] ?? ''));
    if (ids.length === 0) return out;
    for (const id of ids) {
      if (done.has(id)) throw new Error(`[arcadeNodeScopes] backfill made no progress on node ${id}`);
      done.add(id);
    }
    if (verbatimExists === undefined) {
      // A graph-only cell (adapter used without the vector store) has no verbatim type yet.
      const t = await http.query(tenantDb, 'SELECT name FROM schema:types WHERE name = :n', { n: VERBATIM_TYPE });
      verbatimExists = (t.result ?? []).length > 0;
    }
    const fromVerbatim = new Map<string, string[]>();
    const damaged = new Map<string, string[]>();
    if (verbatimExists) {
      const v = await http.query(
        tenantDb,
        `SELECT id, security_scopes FROM ${VERBATIM_TYPE} WHERE id IN :vids`,
        { vids: ids.map((id) => `lore:${id}`) },
      );
      for (const row of (v.result ?? []) as Array<Record<string, unknown>>) {
        const id = String(row['id'] ?? '').slice('lore:'.length);
        const scopes = normalizeScopes(row['security_scopes']);
        if (isDamagedScopes(scopes)) damaged.set(id, scopes);
        else fromVerbatim.set(id, scopes);
      }
    }
    const params: Record<string, unknown> = {};
    const stmts: string[] = [];
    ids.forEach((id, i) => {
      const scopes = fromVerbatim.get(id);
      const bad = damaged.get(id);
      params[`i${i}`] = id;
      params[`s${i}`] = encodeNodeScopes(scopes ?? bad ?? []);
      stmts.push(`UPDATE ${NODE_TYPE} SET security_scopes = :s${i} WHERE id = :i${i} AND security_scopes IS NULL;`);
      if (scopes) out.backfilledFromVerbatim++;
      else if (bad) out.damagedVerbatim++;
      else out.defaultedPublic++;
    });
    await http.commandScript(tenantDb, stmts.join('\n'), params);
  }
}
