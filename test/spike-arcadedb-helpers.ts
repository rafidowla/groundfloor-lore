#!/usr/bin/env tsx
/**
 * spike-arcadedb-helpers.ts — reusable helpers for the ArcadeDB multi-tenant
 * spike (branch: spike/arcadedb-multitenant). SPIKE CODE ONLY — not wired
 * into production paths. See packages/lore/src/engines/arcade/README-SPIKE.md
 * for the full evaluation.
 *
 * Provides:
 *   - startArcadeContainer() / stopArcadeContainer() — docker lifecycle
 *   - waitUntilReady() — poll /api/v1/ready until the server answers
 *   - arcadeCommand(db, sql, params) — POST /api/v1/command/{db}  (mutations)
 *   - arcadeQuery(db, sql, params)   — POST /api/v1/query/{db}    (idempotent)
 *   - arcadeServerCommand(cmd)       — POST /api/v1/server        (root only)
 *
 * Confirmed against the live container in this spike session:
 *   - Image: arcadedata/arcadedb:latest
 *   - Server version reported by GET /api/v1/server?mode=basic:
 *       "26.8.1-SNAPSHOT (build 5cc625613fcaad326903cf8bdf7d83e1eab636d7/...)"
 *   - Query languages available: js, java, sql, sqlscript, opencypher, mongo,
 *     graphql, redis, cypher, gremlin
 *   - GET /api/v1/ready returns HTTP 204 (empty body) when healthy.
 *   - Root user auth confirmed via JAVA_OPTS='-Darcadedb.server.rootPassword=...'.
 */

import { spawnSync } from "node:child_process";

export const ARCADE_CONTAINER_NAME = "arcade-spike";
export const ARCADE_BASE_URL = "http://localhost:2480";
export const ARCADE_ROOT_USER = "root";
export const ARCADE_ROOT_PASSWORD = "SpikeRoot123!";

/**
 * STABLE release pin (2026-07-03 recheck): newest numbered, non-SNAPSHOT tag
 * on Docker Hub for arcadedata/arcadedb is 26.7.1 (26.8.1 only exists as
 * 26.8.1-SNAPSHOT at this time). The appgrid spike must run on this exact
 * tag, never :latest (which resolved to 26.8.1-SNAPSHOT in the prior spike).
 */
export const ARCADE_STABLE_TAG = "arcadedata/arcadedb:26.7.1";

export interface ArcadeCommandResult {
  user?: string;
  result: unknown[];
}

export class ArcadeHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`ArcadeDB HTTP ${status}: ${body}`);
    this.name = "ArcadeHttpError";
  }
}

function basicAuthHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

/** Start the ArcadeDB container (idempotent — removes any stale container first). */
export function startArcadeContainer(image: string = ARCADE_STABLE_TAG): void {
  spawnSync("docker", ["rm", "-f", ARCADE_CONTAINER_NAME], { stdio: "ignore" });
  const run = spawnSync("docker", [
    "run",
    "-d",
    "--name",
    ARCADE_CONTAINER_NAME,
    "-p",
    "2480:2480",
    "-e",
    `JAVA_OPTS=-Darcadedb.server.rootPassword=${ARCADE_ROOT_PASSWORD}`,
    image,
  ]);
  if (run.status !== 0) {
    throw new Error(`docker run failed: ${run.stderr?.toString()}`);
  }
}

/** Stop and remove the spike container. */
export function stopArcadeContainer(): void {
  spawnSync("docker", ["rm", "-f", ARCADE_CONTAINER_NAME], { stdio: "ignore" });
}

/** Poll GET /api/v1/ready (basic-auth'd) until it responds or timeout elapses. */
export async function waitUntilReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${ARCADE_BASE_URL}/api/v1/ready`, {
        headers: { Authorization: basicAuthHeader(ARCADE_ROOT_USER, ARCADE_ROOT_PASSWORD) },
      });
      if (res.status === 204 || res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`ArcadeDB did not become ready within ${timeoutMs}ms: ${String(lastErr)}`);
}

async function post(
  path: string,
  body: unknown,
  user: string,
  pass: string,
): Promise<ArcadeCommandResult> {
  const res = await fetch(`${ARCADE_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: basicAuthHeader(user, pass),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ArcadeHttpError(res.status, text);
  }
  return text ? (JSON.parse(text) as ArcadeCommandResult) : { result: [] };
}

/** POST /api/v1/command/{db} — mutations, runs in an implicit transaction. */
export function arcadeCommand(
  db: string,
  sql: string,
  params?: Record<string, unknown>,
  auth: { user: string; pass: string } = { user: ARCADE_ROOT_USER, pass: ARCADE_ROOT_PASSWORD },
): Promise<ArcadeCommandResult> {
  return post(
    `/api/v1/command/${db}`,
    { language: "sql", command: sql, ...(params ? { params } : {}) },
    auth.user,
    auth.pass,
  );
}

/** POST /api/v1/query/{db} — idempotent queries. */
export function arcadeQuery(
  db: string,
  sql: string,
  params?: Record<string, unknown>,
  auth: { user: string; pass: string } = { user: ARCADE_ROOT_USER, pass: ARCADE_ROOT_PASSWORD },
): Promise<ArcadeCommandResult> {
  return post(
    `/api/v1/query/${db}`,
    { language: "sql", command: sql, ...(params ? { params } : {}) },
    auth.user,
    auth.pass,
  );
}

/** POST /api/v1/server — server-level commands (create/drop database, users). Root only. */
export function arcadeServerCommand(command: string): Promise<ArcadeCommandResult> {
  return post("/api/v1/server", { command }, ARCADE_ROOT_USER, ARCADE_ROOT_PASSWORD);
}

/** Convenience: create a tenant database if it doesn't already exist. */
export async function ensureDatabase(dbName: string): Promise<void> {
  try {
    await arcadeServerCommand(`create database ${dbName}`);
  } catch (e) {
    // ArcadeDB throws if the DB already exists — treat as idempotent no-op.
    if (!(e instanceof ArcadeHttpError) || !/already exists/i.test(e.body)) {
      throw e;
    }
  }
}

/**
 * The native vector-index DDL confirmed against v26.8.1-SNAPSHOT:
 *   CREATE INDEX IF NOT EXISTS ON <Type> (<prop>) LSM_VECTOR METADATA
 *     {"dimensions": <int>, "similarity": "cosine", "maxConnections": <int>, "beamWidth": <int>}
 *
 * Query side (confirmed working, self-match returns distance: 0.0):
 *   SELECT vector.neighbors("<Type>[<prop>]", <queryVectorOrKey>, <k>[, efSearch|options]) as neighbors
 *
 * NOTE: the index enforces the declared `dimensions` strictly — inserting or
 * querying a vector of a different length throws IllegalArgumentException.
 */
export const ARCADE_VECTOR_INDEX_DDL_TEMPLATE =
  'CREATE INDEX IF NOT EXISTS ON {type} ({prop}) LSM_VECTOR METADATA ' +
  '{"dimensions": {dims}, "similarity": "cosine", "maxConnections": 16, "beamWidth": 100}';
