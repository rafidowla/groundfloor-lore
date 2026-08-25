/**
 * arcadeTenantMap.ts — EXPERIMENTAL SPIKE CODE (spike/arcadedb-multitenant).
 *
 * token -> tenant resolution + a factory that returns a FULLY-BOUND
 * { graph, vector } adapter pair for exactly one tenant. This is the cloud
 * analogue of Lore's local-mode workspace-token model: in production, a
 * workspace-scoped token resolves (via routeWorkspaceBinding.ts) to exactly
 * one workspace BEFORE any route runs. Here: token -> tenantId -> ArcadeDB
 * database name, resolved once at construction and then immutable.
 *
 * DB naming convention: `tenant_<tenantId>`, derived ONLY inside this map,
 * NEVER from request payloads.
 *
 * SECOND WALL: each tenant authenticates as its own per-DB ArcadeDB user
 * (alpha_user / beta_user) so ArcadeDB itself rejects a cross-database request
 * even if the adapter were bypassed. During bring-up the map may point at root;
 * the isolation test battery flags which wall(s) are active.
 */

import { ArcadeHttp } from './arcadeHttp.js';
import { ArcadeGraphStore } from './arcadeGraphStore.js';
import { ArcadeVectorStore } from './arcadeVectorStore.js';

export interface ArcadeTenantEntry {
  tenantId: string;
  db: string;
  user: string;
  pass: string;
}

/**
 * Static token -> tenant map. The `db` is `tenant_<tenantId>` and is the ONLY
 * source of the database name; request payloads never contribute to it.
 *
 * Per-DB users (alpha_user / beta_user) are the second isolation wall. If user
 * creation was cut in the spike window, swap these to root — the (still-real)
 * database wall + immutable-constructor adapter wall remain.
 */
export const ARCADE_TENANT_MAP: Record<string, ArcadeTenantEntry> = {
  'token-alpha': {
    tenantId: 'alpha',
    db: 'tenant_alpha',
    user: 'alpha_user',
    pass: 'AlphaPass123!',
  },
  'token-beta': {
    tenantId: 'beta',
    db: 'tenant_beta',
    user: 'beta_user',
    pass: 'BetaPass123!',
  },
};

export interface ArcadeTenantClient {
  tenantId: string;
  db: string;
  graph: ArcadeGraphStore;
  vector: ArcadeVectorStore;
}

/**
 * arcadeClientForToken — resolve a token to a fully-bound, tenant-scoped
 * adapter pair. Unknown token throws BEFORE any HTTP call is made.
 *
 * Mirrors LoreStorageClient.fromLocal({ graph, verbatim }) in shape: the
 * returned graph/vector can be wrapped by the facade unchanged.
 *
 * The tenant database name is captured into each adapter at construction and
 * is `private readonly` — there is no setter, so a token-alpha client can
 * NEVER be re-pointed at tenant_beta after construction.
 */
export function arcadeClientForToken(
  token: string,
  baseUrl = 'http://localhost:2480',
): ArcadeTenantClient {
  const entry = ARCADE_TENANT_MAP[token];
  if (!entry) {
    throw new Error(`[arcadeClientForToken] unknown token: ${token}`);
  }
  const http = new ArcadeHttp({ user: entry.user, pass: entry.pass }, baseUrl);
  return {
    tenantId: entry.tenantId,
    db: entry.db,
    graph: new ArcadeGraphStore({ tenantDb: entry.db, http }),
    vector: new ArcadeVectorStore({ tenantDb: entry.db, http }),
  };
}
