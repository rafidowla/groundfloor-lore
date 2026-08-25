/**
 * arcadeAppTenantMap.ts — DESIGN-B SPIKE TEST FIXTURE ONLY (retained, NOT a
 * production path). spike/arcadedb-multitenant.
 *
 * ⚠️ SUPERSEDED IN PRODUCTION by arcadeAuthResolver.ts (Phase 5). This file's
 * hardcoded 8-entry ARCADE_APP_TOKEN_MAP — with derivable "<Cap>Pass123!"
 * passwords and compiled-in cells — is exactly the anti-pattern the real
 * resolver replaces (persisted token-hash -> cell binding, secrets out of
 * source, deny-by-default). It is KEPT solely as the fixture the Design-B
 * comparison spike (test/spike-arcadedb-appgrid-e2e.ts) still exercises. NO
 * production code imports this module — arcadeAuthResolver.ts is the single
 * production token→adapter binding path. Do not wire this into any daemon route.
 *
 * The 2x2 customer-grid token map + client factories. This is the binding layer
 * that turns a workspace-scoped token into a fully-bound, scope-guarded adapter
 * pair for exactly one (customer, app) cell — under EITHER design. It does NOT
 * modify the proven single-tenant arcadeTenantMap.ts.
 *
 * GRID: 2 customers x 2 apps = 4 cells: (alpha,app1) (alpha,app2) (beta,app1)
 * (beta,app2). Each cell has a WRITE token and a READ-ONLY (`-ro`) token — 8
 * tokens total. `scopes` gates verbs (read|write); it NEVER widens reach —
 * reach is fixed by the cell binding below, per the coarse-RBAC decision.
 *
 * ── DESIGN A binding (db-per-app) ───────────────────────────────────────────
 *   token -> { db: tenant_<customer>_<app>, user: <customer>_<app>_user }.
 *   The per-DB user is granted ONLY its own database (provisioned in the
 *   appgrid helpers), so ArcadeDB itself enforces BOTH the app wall and the
 *   customer wall. Uses the PROVEN ArcadeGraphStore/ArcadeVectorStore verbatim
 *   (zero engine changes) — they already prove db-per-X isolation.
 *
 * ── DESIGN B binding (shared-customer-db + app_id tag) ──────────────────────
 *   token -> { db: tenant_<customer>, user: <customer>_user, boundAppId: <app> }.
 *   The customer user sees the whole customer DB (app wall is OPEN at the raw
 *   DB layer — B's documented residual risk); the app wall rides entirely on
 *   ArcadeAppGraphStore/ArcadeAppVectorStore applying app_id = :boundApp on
 *   every op. boundAppId comes ONLY from this map, never a payload.
 *
 * The db name and boundAppId are derived ONLY here (from the token entry),
 * NEVER from request payloads, and are captured immutably into the adapters at
 * construction — so a token-alpha-app1 client can never be re-pointed.
 */

import { ArcadeHttp } from './arcadeHttp.js';
import { ArcadeGraphStore } from './arcadeGraphStore.js';
import { ArcadeVectorStore } from './arcadeVectorStore.js';
import { ArcadeAppGraphStore } from './arcadeAppGraphStore.js';
import { ArcadeAppVectorStore } from './arcadeAppVectorStore.js';
import {
  scopeGuardPair,
  ScopeGuardedGraph,
  ScopeGuardedVector,
  type Scope,
} from './arcadeScopeGuard.js';

export type Customer = 'alpha' | 'beta';
export type App = 'app1' | 'app2';

export interface ArcadeAppTokenEntry {
  customerId: Customer;
  appId: App;
  /** coarse RBAC — read gates reads through, write additionally gates writes. */
  scopes: Scope[];
  // ── Design A credentials (per-cell DB + per-cell user) ──
  /** tenant_<customer>_<app> */
  dbA: string;
  /** <customer>_<app>_user */
  userA: string;
  passA: string;
  // ── Design B credentials (per-customer DB + per-customer user) ──
  /** tenant_<customer> */
  dbB: string;
  /** <customer>_user */
  userB: string;
  passB: string;
  /** the immutable app_id filter value for Design B (matches provisioning) */
  boundAppId: App;
}

const CUSTOMERS: Customer[] = ['alpha', 'beta'];
const APPS: App[] = ['app1', 'app2'];

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build the 8-token map. Passwords mirror the appgrid helpers' derivation
 * exactly (designACells / designBCustomers) so the tokens authenticate against
 * the provisioned users.
 */
function buildTokenMap(): Record<string, ArcadeAppTokenEntry> {
  const map: Record<string, ArcadeAppTokenEntry> = {};
  for (const c of CUSTOMERS) {
    for (const a of APPS) {
      // Design A user/pass: <c>_<a>_user / <Cap(c)><Cap(a)>Pass123!
      const passA = `${cap(c)}${cap(a)}Pass123!`;
      // Design B user/pass: <c>_user / <Cap(c)>Pass123!
      const passB = `${cap(c)}Pass123!`;
      const base: Omit<ArcadeAppTokenEntry, 'scopes'> = {
        customerId: c,
        appId: a,
        dbA: `tenant_${c}_${a}`,
        userA: `${c}_${a}_user`,
        passA,
        dbB: `tenant_${c}`,
        userB: `${c}_user`,
        passB,
        boundAppId: a,
      };
      // write token
      map[`token-${c}-${a}`] = { ...base, scopes: ['read', 'write'] };
      // read-only token
      map[`token-${c}-${a}-ro`] = { ...base, scopes: ['read'] };
    }
  }
  return map;
}

export const ARCADE_APP_TOKEN_MAP: Record<string, ArcadeAppTokenEntry> = buildTokenMap();

export interface ArcadeAppClient {
  customerId: Customer;
  appId: App;
  design: 'A' | 'B';
  db: string;
  scopes: Scope[];
  graph: ScopeGuardedGraph;
  vector: ScopeGuardedVector;
}

/** Resolve a token entry or throw BEFORE any HTTP call. */
function resolveEntry(token: string): ArcadeAppTokenEntry {
  const entry = ARCADE_APP_TOKEN_MAP[token];
  if (!entry) {
    throw new Error(`[arcadeAppClientForToken] unknown token: ${token}`);
  }
  return entry;
}

/**
 * Design A factory — binds the PROVEN stores to tenant_<customer>_<app> under
 * the cell's per-DB user, then scope-guards the pair. Isolation is
 * ArcadeDB-enforced (separate DB + per-DB user); the guard only gates verbs.
 */
export function arcadeAppClientForTokenA(
  token: string,
  baseUrl = 'http://localhost:2480',
): ArcadeAppClient {
  const entry = resolveEntry(token);
  const http = new ArcadeHttp({ user: entry.userA, pass: entry.passA }, baseUrl);
  const graph = new ArcadeGraphStore({ tenantDb: entry.dbA, http });
  const vector = new ArcadeVectorStore({ tenantDb: entry.dbA, http });
  const guarded = scopeGuardPair(graph, vector, entry.scopes);
  return {
    customerId: entry.customerId,
    appId: entry.appId,
    design: 'A',
    db: entry.dbA,
    scopes: entry.scopes,
    graph: guarded.graph,
    vector: guarded.vector,
  };
}

/**
 * Design B factory — binds the APP-SCOPED stores to tenant_<customer> + the
 * cell's immutable boundAppId, under the per-CUSTOMER user, then scope-guards
 * the pair. The customer wall is ArcadeDB-enforced; the app wall rides on the
 * app_id predicate inside the app-scoped stores.
 */
export function arcadeAppClientForTokenB(
  token: string,
  baseUrl = 'http://localhost:2480',
): ArcadeAppClient {
  const entry = resolveEntry(token);
  const http = new ArcadeHttp({ user: entry.userB, pass: entry.passB }, baseUrl);
  const graph = new ArcadeAppGraphStore({
    tenantDb: entry.dbB,
    boundAppId: entry.boundAppId,
    http,
  });
  const vector = new ArcadeAppVectorStore({
    tenantDb: entry.dbB,
    boundAppId: entry.boundAppId,
    http,
  });
  const guarded = scopeGuardPair(graph, vector, entry.scopes);
  return {
    customerId: entry.customerId,
    appId: entry.appId,
    design: 'B',
    db: entry.dbB,
    scopes: entry.scopes,
    graph: guarded.graph,
    vector: guarded.vector,
  };
}

/** Design-agnostic dispatcher for the matrix runner. */
export function arcadeAppClientForToken(
  token: string,
  design: 'A' | 'B',
  baseUrl = 'http://localhost:2480',
): ArcadeAppClient {
  return design === 'A'
    ? arcadeAppClientForTokenA(token, baseUrl)
    : arcadeAppClientForTokenB(token, baseUrl);
}
