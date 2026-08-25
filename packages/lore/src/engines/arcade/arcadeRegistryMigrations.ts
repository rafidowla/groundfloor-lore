/**
 * arcadeRegistryMigrations.ts — versioned migration runner for the
 * daemon-local `arcade-provisioning.sqlite` registry.
 * (branch: spike/arcadedb-multitenant, slice 2 W4/W6 — secrets portion)
 *
 * The provisioner (`tenant_apps`) and the auth resolver (`arcade_tokens`) both
 * live in one SQLite file. Slice 1 created their tables inline with
 * CREATE TABLE IF NOT EXISTS. Slice 2 needs additive schema evolution that a
 * plain IF-NOT-EXISTS cannot express (making a NOT-NULL column nullable, adding
 * columns), so this module owns a PRAGMA user_version-based runner — the same
 * precedent the outbox store uses.
 *
 * Versions (single source of truth):
 *   v0 → v1  baseline: tenant_apps + arcade_tokens exactly as slice 1 shipped
 *            (this runner is idempotent with the inline IF-NOT-EXISTS creates,
 *            so a DB created either way lands at v1).
 *   v1 → v2  secrets + token lifecycle:
 *              - tenant_apps.db_pass becomes NULLABLE (secret may live in an
 *                external store, e.g. keychain, leaving the column NULL).
 *              - tenant_apps.schema_version INTEGER (per-cell ArcadeDB schema
 *                stamp; defaults 0 for pre-existing cells).
 *              - arcade_tokens.expires_at TEXT NULL (token TTL; NULL = never).
 *   v2 → v3  Slice-4 token-lifecycle-contract + cell policy + migration
 *            bookkeeping (all additive, idempotent, forward-only):
 *              - arcade_tokens.label TEXT NULL — operator-facing label so
 *                `list-tokens` carries the same fields as `lore auth list`.
 *              - arcade_tokens.last_used_at TEXT NULL — throttled last-use
 *                stamp (parity with local tokens.ts LAST_USED_THROTTLE_MS).
 *              - cell_policies (tenant_id, app_id, vocab_policy JSON,
 *                updated_at) — per-cell vocab policy in the relational lane
 *                (never inside ArcadeDB); the arcade analogue of a workspace's
 *                vocabPolicy.
 *              - cell_imports (tenant_id, app_id, manifest_hash, counts_json,
 *                completed_at) — migration idempotency + observability.
 *
 *   v3 → v4  Slice-5 GA hardening (all additive, idempotent, forward-only):
 *              - arcade_secrets — envelope-encrypted service passwords for the
 *                'kms' secret backend (ciphertext + wrapped DEK; never plaintext).
 *              - cell_leases — cross-daemon (multi-process) provisioning lock
 *                keyed (tenant_id, app_id) with a monotonic fencing_token.
 *              - cell_backups — logical-backup manifest_hash + counts ledger.
 *
 * Every step is idempotent and forward-only. Downgrades are not supported (a
 * newer daemon must not silently run against an older-shaped file — but an
 * older column simply being present is harmless).
 */

import type { Database as DatabaseType } from 'better-sqlite3';

export const ARCADE_REGISTRY_SCHEMA_VERSION = 4;

function userVersion(db: DatabaseType): number {
  const row = db.pragma('user_version', { simple: true });
  return typeof row === 'number' ? row : Number(row) || 0;
}

function setUserVersion(db: DatabaseType, v: number): void {
  db.pragma(`user_version = ${v}`);
}

function columnExists(db: DatabaseType, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function tableExists(db: DatabaseType, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return row !== undefined;
}

// ── v1: baseline (matches slice-1 inline CREATE TABLEs) ─────────────────────

function migrateTo1(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_apps (
      tenant_id   TEXT NOT NULL,
      app_id      TEXT NOT NULL,
      db          TEXT NOT NULL,
      db_user     TEXT NOT NULL,
      db_pass     TEXT NOT NULL,
      secret_ref  TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('active','disabled','destroying')),
      created_at  TEXT NOT NULL,
      disabled_at TEXT,
      PRIMARY KEY (tenant_id, app_id)
    );
    CREATE TABLE IF NOT EXISTS arcade_tokens (
      token_hash TEXT PRIMARY KEY,
      tenant_id  TEXT NOT NULL,
      app_id     TEXT NOT NULL,
      scopes     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
  `);
}

// ── v2: secrets + token lifecycle ───────────────────────────────────────────

function migrateTo2(db: DatabaseType): void {
  // (a) tenant_apps.db_pass → NULLABLE. SQLite cannot ALTER a column's
  //     nullability in place, so rebuild the table (12-step table-rebuild,
  //     wrapped by the caller's transaction). Only done once when the live
  //     table still has the NOT NULL constraint.
  const passIsNotNull = (() => {
    const cols = db.prepare(`PRAGMA table_info(tenant_apps)`).all() as Array<{
      name: string;
      notnull: number;
    }>;
    const c = cols.find((x) => x.name === 'db_pass');
    return c ? c.notnull === 1 : false;
  })();

  if (passIsNotNull) {
    db.exec(`
      CREATE TABLE tenant_apps__v2 (
        tenant_id      TEXT NOT NULL,
        app_id         TEXT NOT NULL,
        db             TEXT NOT NULL,
        db_user        TEXT NOT NULL,
        db_pass        TEXT,                 -- now NULLABLE
        secret_ref     TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('active','disabled','destroying')),
        created_at     TEXT NOT NULL,
        disabled_at    TEXT,
        schema_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, app_id)
      );
      INSERT INTO tenant_apps__v2
        (tenant_id, app_id, db, db_user, db_pass, secret_ref, status, created_at, disabled_at, schema_version)
        SELECT tenant_id, app_id, db, db_user, db_pass, secret_ref, status, created_at, disabled_at, 0
        FROM tenant_apps;
      DROP TABLE tenant_apps;
      ALTER TABLE tenant_apps__v2 RENAME TO tenant_apps;
    `);
  } else if (!columnExists(db, 'tenant_apps', 'schema_version')) {
    // Table was already nullable (fresh DB path won't hit this, but be safe):
    // just add the schema_version column.
    db.exec(`ALTER TABLE tenant_apps ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0`);
  }

  // (b) arcade_tokens.expires_at TEXT NULL — additive, idempotent.
  if (tableExists(db, 'arcade_tokens') && !columnExists(db, 'arcade_tokens', 'expires_at')) {
    db.exec(`ALTER TABLE arcade_tokens ADD COLUMN expires_at TEXT`);
  }
}

// ── v3: token-lifecycle-contract alignment + cell policy + migration ledger ──

function migrateTo3(db: DatabaseType): void {
  // (a) arcade_tokens.label + last_used_at — additive, idempotent. These bring
  //     the operator-facing `list-tokens` summary shape to parity with local's
  //     `lore auth list` ({prefix, scopes, label, createdAt, lastUsedAt,
  //     revokedAt, expiresAt, active}).
  if (tableExists(db, 'arcade_tokens')) {
    if (!columnExists(db, 'arcade_tokens', 'label')) {
      db.exec(`ALTER TABLE arcade_tokens ADD COLUMN label TEXT`);
    }
    if (!columnExists(db, 'arcade_tokens', 'last_used_at')) {
      db.exec(`ALTER TABLE arcade_tokens ADD COLUMN last_used_at TEXT`);
    }
  }

  // (b) cell_policies — the per-cell vocab policy, the arcade analogue of a
  //     workspace's vocabPolicy. Lives in the daemon relational lane, NEVER
  //     inside ArcadeDB (relationalLaneDecision). Absent row = the documented
  //     open default (same as a local workspace without an explicit policy).
  db.exec(`
    CREATE TABLE IF NOT EXISTS cell_policies (
      tenant_id    TEXT NOT NULL,
      app_id       TEXT NOT NULL,
      vocab_policy TEXT NOT NULL,   -- JSON WorkspaceVocabPolicy
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (tenant_id, app_id)
    );
  `);

  // (c) cell_imports — migration idempotency + observability. A completed
  //     import of a given bundle (manifest_hash) is recorded so re-imports are
  //     observable; concurrency is guarded by the provisioner's withCellLock.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cell_imports (
      tenant_id    TEXT NOT NULL,
      app_id       TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      counts_json  TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, app_id, manifest_hash)
    );
  `);
}

// ── v4: slice-5 GA hardening (kms secrets + cross-daemon leases + backups) ───

function migrateTo4(db: DatabaseType): void {
  // (a) arcade_secrets — envelope-encrypted ArcadeDB service passwords for the
  //     'kms' backend. tenant_apps.db_pass stays NULL under kms; the ciphertext
  //     + wrapped DEK live here. Never contains plaintext. secret_ref PK mirrors
  //     the sqlite column's keying so the store seam is a drop-in.
  db.exec(`
    CREATE TABLE IF NOT EXISTS arcade_secrets (
      secret_ref  TEXT PRIMARY KEY,
      ciphertext  BLOB NOT NULL,
      iv          BLOB NOT NULL,
      tag         BLOB NOT NULL,
      wrapped_dek BLOB NOT NULL,
      dek_iv      BLOB NOT NULL,
      dek_tag     BLOB NOT NULL,
      key_id      TEXT NOT NULL,
      provider    TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      rotated_at  TEXT
    );
  `);

  // (b) cell_leases — cross-daemon (multi-process) provisioning lock. The
  //     durable Layer-2 lease keyed (tenant_id, app_id). fencing_token is
  //     monotonic per cell (epoch stamp for audit / zombie-writer detection).
  db.exec(`
    CREATE TABLE IF NOT EXISTS cell_leases (
      tenant_id     TEXT NOT NULL,
      app_id        TEXT NOT NULL,
      owner_id      TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      acquired_at   INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, app_id)
    );
  `);

  // (c) cell_backups — logical-backup bookkeeping (manifest_hash + counts) so a
  //     backup→restore round-trip is observable and a manifest can be verified.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cell_backups (
      tenant_id     TEXT NOT NULL,
      app_id        TEXT NOT NULL,
      manifest_hash TEXT NOT NULL,
      counts_json   TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      PRIMARY KEY (tenant_id, app_id, manifest_hash)
    );
  `);
}

// ── runner ───────────────────────────────────────────────────────────────────

/**
 * runArcadeRegistryMigrations — bring the registry file up to the daemon's
 * required schema version. Idempotent; safe to call on every open. Each step
 * runs in its own transaction so a crash mid-migration leaves the file at a
 * clean version boundary.
 */
export function runArcadeRegistryMigrations(db: DatabaseType): void {
  let v = userVersion(db);

  // A brand-new file reports user_version 0. A slice-1 file created inline also
  // reports 0 (the inline creates never stamped a version) but already has the
  // baseline tables — migrateTo1's IF-NOT-EXISTS makes that a no-op.
  if (v < 1) {
    db.transaction(() => {
      migrateTo1(db);
      setUserVersion(db, 1);
    })();
    v = 1;
  }
  if (v < 2) {
    db.transaction(() => {
      migrateTo2(db);
      setUserVersion(db, 2);
    })();
    v = 2;
  }
  if (v < 3) {
    db.transaction(() => {
      migrateTo3(db);
      setUserVersion(db, 3);
    })();
    v = 3;
  }
  if (v < 4) {
    db.transaction(() => {
      migrateTo4(db);
      setUserVersion(db, 4);
    })();
    v = 4;
  }
}
