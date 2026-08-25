/**
 * arcadeRootTransport.ts — the root-authed ArcadeDB transport used ONLY by the
 * provisioner control plane (split out of arcadeProvisioner.ts for the file-size
 * budget + slice-5 TLS consolidation).
 * (branch: spike/arcadedb-multitenant, slice 5 GA hardening)
 *
 * WHY THIS FILE EXISTS (the slice-5 TLS fix):
 *   Slice-2/3 shipped `rootPost` in arcadeProvisioner.ts as a RAW global
 *   `fetch`. That transport BYPASSED both hardening walls that arcadeHttp.ts
 *   already enforces for tenant traffic:
 *     (a) the private-CA wiring (LORE_ARCADE_CA_FILE), and
 *     (b) the plaintext-to-non-localhost refusal (http:// only for localhost).
 *   The provisioner's DDL (create/drop db + user) is exactly the traffic that
 *   MUST use TLS to a managed/remote ArcadeDB, yet it was the ONE lane that
 *   skipped the wall. This module routes the provisioner's root calls through
 *   a root-authed `ArcadeHttp` instance so the WHOLE system has ONE TLS posture:
 *   there is no `rejectUnauthorized:false` anywhere, and a non-localhost http://
 *   base URL fails LOUD at construction for the root lane too.
 *
 * OWNERSHIP BOUNDARY (unchanged): root/service credentials for ArcadeDB are held
 * ONLY behind this transport (constructed from the root secret store). Tenant
 * adapters build their own per-app db-scoped ArcadeHttp and never call
 * `.serverCommand()`. This module is the ONLY production caller of
 * `.serverCommand()`.
 *
 * NOTE ON CREDENTIAL FRESHNESS: the root password can rotate (secret store), so
 * we resolve it on EVERY call and rebuild the ArcadeHttp's captured auth via
 * `updateCredentials` — the shared socket pool is unaffected (auth is a
 * per-request header). Never logs the resolved password.
 */

import { ArcadeHttp } from './arcadeHttp.js';
import {
  getRootSecretStore,
  resolveRootPasswordSync,
} from './arcadeSecretStore.js';

// Defaults match the pinned spike container so the same running container works
// for both test and provisioner callers; override via env for any deployment.
export const ARCADE_BASE_URL = process.env['ARCADE_BASE_URL'] ?? 'http://localhost:2480';
export const ARCADE_ROOT_USER = process.env['ARCADE_ROOT_USER'] ?? 'root';

// ARCADE_ROOT_PASSWORD is retained as an EXPORTED symbol for the local test /
// spike-container path (tests build a root ArcadeHttp with it). It reflects the
// env override when present, else the spike default. It is NO LONGER the value
// the provisioner authenticates with in arcade deployment mode — that resolves
// through the secret store (fail-closed if absent), see rootPassword() below.
export const ARCADE_ROOT_PASSWORD = process.env['ARCADE_ROOT_PASSWORD'] ?? 'SpikeRoot123!';

/**
 * rootPassword — the credential the provisioner's root transport actually uses.
 * Resolves via the secret store: ARCADE_ROOT_PASSWORD env > store 'arcade-root'
 * (sync backends) > spike default. In arcade deployment mode
 * (LORE_DEPLOYMENT_MODE=arcade) the spike default is DEAD — resolution throws
 * if neither env nor store yields a root password (fail-closed). Never logged.
 */
export function rootPassword(): string {
  // Root resolves via an env/keychain store that NEVER touches the registry DB
  // (see getRootSecretStore) — so resolving it mid-provision cannot close the
  // caller's registry handle.
  return resolveRootPasswordSync(getRootSecretStore());
}

// ── the single root-authed ArcadeHttp (TLS-hardened, same as tenant lane) ────
//
// ONE ArcadeHttp per base URL, lazily built. Constructing it runs arcadeHttp's
// plaintext-to-non-localhost wall + CA wiring — so a misconfigured non-localhost
// http:// ARCADE_BASE_URL fails LOUD here, exactly like a tenant adapter.

let cachedRootHttp: ArcadeHttp | null = null;
let cachedRootHttpBase: string | null = null;

function rootHttp(): ArcadeHttp {
  const base = ARCADE_BASE_URL;
  if (!cachedRootHttp || cachedRootHttpBase !== base) {
    // Construction validates protocol/host (throws for non-localhost http://).
    cachedRootHttp = new ArcadeHttp({ user: ARCADE_ROOT_USER, pass: rootPassword() }, base);
    cachedRootHttpBase = base;
  } else {
    // Refresh the captured credential in case the root secret rotated; auth is
    // a per-request header so the socket pool is untouched.
    cachedRootHttp.updateCredentials({ user: ARCADE_ROOT_USER, pass: rootPassword() });
  }
  return cachedRootHttp;
}

/** Test/ops hook — drop the cached root transport (e.g. after a base-URL/env change). */
export function resetRootTransportForTests(): void {
  cachedRootHttp = null;
  cachedRootHttpBase = null;
}

/**
 * spikeArcadeServerCommand — POST /api/v1/server, server-level commands
 * (create/drop db, users). Root only. Now goes through the TLS-hardened
 * ArcadeHttp (same wall as tenant traffic), NOT a raw fetch.
 */
export function spikeArcadeServerCommand(command: string): Promise<{ result: unknown[] }> {
  return rootHttp().serverCommand(command);
}

/**
 * spikeArcadeCommand — POST /api/v1/command/{db}, mutations (schema DDL),
 * root-authed, this module + provisioner only. TLS-hardened via ArcadeHttp.
 */
export function spikeArcadeCommand(
  db: string,
  sql: string,
  params?: Record<string, unknown>,
): Promise<{ result: unknown[] }> {
  return rootHttp().command(db, sql, params);
}
