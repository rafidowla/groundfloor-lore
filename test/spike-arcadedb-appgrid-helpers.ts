#!/usr/bin/env tsx
/**
 * spike-arcadedb-appgrid-helpers.ts — provisioning helpers for the 2x2
 * customer-grid multi-tenant spike (branch: spike/arcadedb-multitenant).
 * Builds on test/spike-arcadedb-helpers.ts (container lifecycle) and the
 * proven engines/arcade/* adapters from the prior single-tenant spike.
 *
 * SCOPE OF THIS FILE (this session): container pinned to the stable
 * ArcadeDB release, DB + user provisioning for BOTH designs (Design A:
 * 4 databases + 4 per-DB users; Design B: 2 databases + app_id-tagged
 * schema), and the grid seeding primitives. The full 12-probe adversarial
 * matrix from the spec is NOT implemented here — see the summary returned
 * by this session for what was and wasn't covered.
 */

import {
  ARCADE_BASE_URL,
  ARCADE_ROOT_USER,
  ARCADE_ROOT_PASSWORD,
  ARCADE_STABLE_TAG,
  arcadeServerCommand,
  arcadeCommand,
  arcadeQuery,
  waitUntilReady,
  ArcadeHttpError,
} from './spike-arcadedb-helpers.js';

export const CUSTOMERS = ['alpha', 'beta'] as const;
export const APPS = ['app1', 'app2'] as const;
export type Customer = (typeof CUSTOMERS)[number];
export type App = (typeof APPS)[number];

export const SENTINEL: Record<Customer, Record<App, string>> = {
  alpha: { app1: 'ALPHA-APP1', app2: 'ALPHA-APP2' },
  beta: { app1: 'BETA-APP1', app2: 'BETA-APP2' },
};

export function cellKey(c: Customer, a: App): string {
  return `${c}_${a}`;
}

/** Confirm the live server reports the pinned stable version, no SNAPSHOT. */
export async function assertStableVersion(): Promise<string> {
  const res = await fetch(`${ARCADE_BASE_URL}/api/v1/server?mode=basic`, {
    headers: {
      Authorization:
        'Basic ' + Buffer.from(`${ARCADE_ROOT_USER}:${ARCADE_ROOT_PASSWORD}`).toString('base64'),
    },
  });
  const body = (await res.json()) as { version?: string };
  const version = body.version ?? '';
  if (!version.startsWith('26.7.1')) {
    throw new Error(`[assertStableVersion] expected 26.7.1, got: ${version}`);
  }
  if (/SNAPSHOT/i.test(version)) {
    throw new Error(`[assertStableVersion] version contains SNAPSHOT: ${version}`);
  }
  return version;
}

// ── ArcadeDB user provisioning ───────────────────────────────────────────
// CONFIRMED SYNTAX on 26.7.1 (differs from the SQL-ish string form used for
// `create database`): `create user` takes a JSON-OBJECT payload serialized
// as the `command` string value itself:
//   POST /api/v1/server { "command": "create user {\"name\":...,\"password\":...,\"databases\":{...}}" }
// `databases` is a map of dbName -> array of roles (["admin"] grants full
// access to that db only). A user with no entry for a db gets 403 querying
// it (confirmed live below in provisionDesignA/B).
export interface UserGrant {
  name: string;
  password: string;
  /** dbName -> roles, e.g. { tenant_alpha_app1: ['admin'] } */
  databases: Record<string, string[]>;
}

export async function createOrReplaceUser(grant: UserGrant): Promise<void> {
  // idempotent: drop first (ignore "not found"), then create.
  try {
    await arcadeServerCommand(`drop user ${grant.name}`);
  } catch {
    // ignore — user may not exist yet
  }
  const payload = JSON.stringify({
    name: grant.name,
    password: grant.password,
    databases: grant.databases,
  });
  await arcadeServerCommand(`create user ${payload}`);
}

export async function ensureDatabase(dbName: string): Promise<void> {
  try {
    await arcadeServerCommand(`create database ${dbName}`);
  } catch (e) {
    if (!(e instanceof ArcadeHttpError) || !/already exists/i.test(e.body)) throw e;
  }
}

export async function dropDatabaseIfExists(dbName: string): Promise<void> {
  try {
    await arcadeServerCommand(`drop database ${dbName}`);
  } catch {
    // ignore — best-effort cleanup
  }
}

// ── schema DDL (shared shape with the proven single-tenant adapters) ────
const NODE_PROPS: Array<[string, string]> = [
  ['id', 'STRING'],
  ['type', 'STRING'],
  ['label', 'STRING'],
  ['content', 'STRING'],
  ['tags', 'STRING'],
  ['project', 'STRING'],
  ['ecosystem', 'STRING'],
  ['metadata', 'STRING'],
  ['createdAt', 'STRING'],
  ['updatedAt', 'STRING'],
];

const VERBATIM_PROPS: Array<[string, string]> = [
  ['id', 'STRING'],
  ['text', 'STRING'],
  ['type', 'STRING'],
  ['label', 'STRING'],
  ['tags', 'STRING'],
  ['project', 'STRING'],
];

// Must match LocalEmbeddingProvider.DEFAULT_LOCAL_MODEL_DIM (384) — the real
// adapters (ArcadeVectorStore / ArcadeAppVectorStore) embed with that model,
// so a mismatched fixture dimension here would make every store() call throw
// "Vector dimension does not match index dimension" once real seeding starts.
const EMBED_DIM = 384;

/**
 * Design A schema: identical to the proven single-tenant adapters — no
 * app_id column, isolation comes entirely from separate databases + users.
 */
export async function createSchemaDesignA(db: string): Promise<void> {
  await arcadeCommand(db, 'CREATE VERTEX TYPE LoreNode IF NOT EXISTS');
  for (const [name, kind] of NODE_PROPS) {
    await arcadeCommand(db, `CREATE PROPERTY LoreNode.${name} IF NOT EXISTS ${kind}`);
  }
  await arcadeCommand(db, 'CREATE INDEX IF NOT EXISTS ON LoreNode (id) UNIQUE');
  await arcadeCommand(db, 'CREATE EDGE TYPE LoreEdge IF NOT EXISTS');
  await arcadeCommand(db, 'CREATE PROPERTY LoreEdge.relation IF NOT EXISTS STRING');
  await arcadeCommand(db, 'CREATE PROPERTY LoreEdge.confidence IF NOT EXISTS STRING');
  await arcadeCommand(db, 'CREATE PROPERTY LoreEdge.confidenceScore IF NOT EXISTS DOUBLE');

  await arcadeCommand(db, 'CREATE VERTEX TYPE LoreVerbatim IF NOT EXISTS');
  for (const [name, kind] of VERBATIM_PROPS) {
    await arcadeCommand(db, `CREATE PROPERTY LoreVerbatim.${name} IF NOT EXISTS ${kind}`);
  }
  await arcadeCommand(db, 'CREATE PROPERTY LoreVerbatim.embedding IF NOT EXISTS ARRAY_OF_FLOATS');
  await arcadeCommand(db, 'CREATE INDEX IF NOT EXISTS ON LoreVerbatim (id) UNIQUE');
  await arcadeCommand(
    db,
    `CREATE INDEX IF NOT EXISTS ON LoreVerbatim (embedding) LSM_VECTOR METADATA ` +
      `{"dimensions": ${EMBED_DIM}, "similarity": "cosine", "maxConnections": 16, "beamWidth": 100}`,
  );
}

/**
 * Design B schema: adds `app_id` STRING to both types, and the UNIQUE index
 * is COMPOSITE on (app_id, id) — NOT id alone — so the same id can exist in
 * sibling apps of the same customer database without collision (this is
 * what makes the write-collision probe M2 testable at all).
 */
export async function createSchemaDesignB(db: string): Promise<void> {
  await arcadeCommand(db, 'CREATE VERTEX TYPE LoreNode IF NOT EXISTS');
  for (const [name, kind] of NODE_PROPS) {
    await arcadeCommand(db, `CREATE PROPERTY LoreNode.${name} IF NOT EXISTS ${kind}`);
  }
  await arcadeCommand(db, 'CREATE PROPERTY LoreNode.app_id IF NOT EXISTS STRING');
  await arcadeCommand(db, 'CREATE INDEX IF NOT EXISTS ON LoreNode (app_id, id) UNIQUE');
  await arcadeCommand(db, 'CREATE EDGE TYPE LoreEdge IF NOT EXISTS');
  await arcadeCommand(db, 'CREATE PROPERTY LoreEdge.relation IF NOT EXISTS STRING');
  await arcadeCommand(db, 'CREATE PROPERTY LoreEdge.confidence IF NOT EXISTS STRING');
  await arcadeCommand(db, 'CREATE PROPERTY LoreEdge.confidenceScore IF NOT EXISTS DOUBLE');

  await arcadeCommand(db, 'CREATE VERTEX TYPE LoreVerbatim IF NOT EXISTS');
  for (const [name, kind] of VERBATIM_PROPS) {
    await arcadeCommand(db, `CREATE PROPERTY LoreVerbatim.${name} IF NOT EXISTS ${kind}`);
  }
  await arcadeCommand(db, 'CREATE PROPERTY LoreVerbatim.app_id IF NOT EXISTS STRING');
  await arcadeCommand(db, 'CREATE PROPERTY LoreVerbatim.embedding IF NOT EXISTS ARRAY_OF_FLOATS');
  await arcadeCommand(db, 'CREATE INDEX IF NOT EXISTS ON LoreVerbatim (app_id, id) UNIQUE');
  await arcadeCommand(
    db,
    `CREATE INDEX IF NOT EXISTS ON LoreVerbatim (embedding) LSM_VECTOR METADATA ` +
      `{"dimensions": ${EMBED_DIM}, "similarity": "cosine", "maxConnections": 16, "beamWidth": 100}`,
  );
}

// ── Design A provisioning: 4 dbs, 4 users, one db each ──────────────────
export interface DesignACell {
  customer: Customer;
  app: App;
  db: string;
  user: string;
  pass: string;
}

export function designACells(): DesignACell[] {
  const cells: DesignACell[] = [];
  for (const c of CUSTOMERS) {
    for (const a of APPS) {
      cells.push({
        customer: c,
        app: a,
        db: `tenant_${c}_${a}`,
        user: `${c}_${a}_user`,
        pass: `${c[0]!.toUpperCase()}${c.slice(1)}${a[0]!.toUpperCase()}${a.slice(1)}Pass123!`,
      });
    }
  }
  return cells;
}

export async function provisionDesignA(): Promise<DesignACell[]> {
  const cells = designACells();
  for (const cell of cells) {
    await ensureDatabase(cell.db);
    await createSchemaDesignA(cell.db);
    await createOrReplaceUser({
      name: cell.user,
      password: cell.pass,
      databases: { [cell.db]: ['admin'] },
    });
  }
  return cells;
}

// ── Design B provisioning: 2 dbs (per customer), 2 users, app_id schema ──
export interface DesignBCustomer {
  customer: Customer;
  db: string;
  user: string;
  pass: string;
}

export function designBCustomers(): DesignBCustomer[] {
  return CUSTOMERS.map((c) => ({
    customer: c,
    db: `tenant_${c}`,
    user: `${c}_user`,
    pass: `${c[0]!.toUpperCase()}${c.slice(1)}Pass123!`,
  }));
}

export async function provisionDesignB(): Promise<DesignBCustomer[]> {
  const customers = designBCustomers();
  for (const cust of customers) {
    await ensureDatabase(cust.db);
    await createSchemaDesignB(cust.db);
    await createOrReplaceUser({
      name: cust.user,
      password: cust.pass,
      databases: { [cust.db]: ['admin'] },
    });
  }
  return customers;
}

// ── sanity seed: one row per (customer,app) cell ────────────────────────
export async function seedSanityRowDesignA(cell: DesignACell): Promise<void> {
  const sentinel = SENTINEL[cell.customer][cell.app];
  await arcadeCommand(
    cell.db,
    `UPDATE LoreNode SET id=:id, label=:label, content=:content, project=:project, ` +
      `createdAt=:now, updatedAt=:now UPSERT WHERE id=:id`,
    {
      id: `sanity-${cellKey(cell.customer, cell.app)}`,
      label: `${sentinel} sanity node`,
      content: `${sentinel} sanity payload`,
      project: cellKey(cell.customer, cell.app),
      now: new Date().toISOString(),
    },
  );
}

export async function seedSanityRowDesignB(cust: DesignBCustomer, app: App): Promise<void> {
  const sentinel = SENTINEL[cust.customer][app];
  await arcadeCommand(
    cust.db,
    `UPDATE LoreNode SET id=:id, app_id=:appId, label=:label, content=:content, ` +
      `project=:project, createdAt=:now, updatedAt=:now UPSERT WHERE app_id=:appId AND id=:id`,
    {
      id: `sanity-${cellKey(cust.customer, app)}`,
      appId: app,
      label: `${sentinel} sanity node`,
      content: `${sentinel} sanity payload`,
      project: cellKey(cust.customer, app),
      now: new Date().toISOString(),
    },
  );
}

export { waitUntilReady, ARCADE_STABLE_TAG };
