/**
 * arcadeKmsSecretStore.ts — envelope-encryption secret backend for ArcadeDB
 * per-app service passwords. (branch: spike/arcadedb-multitenant, slice 5 GA)
 *
 * WHY: the sqlite backend keeps the service password as plaintext in the
 * tenant_apps.db_pass column. This backend takes passwords OFF plaintext at
 * rest: each write mints a fresh 32-byte DEK, encrypts the secret AES-256-GCM
 * under the DEK, and WRAPS the DEK via a pluggable `KmsKeyProvider`. Ciphertext
 * lands in the registry `arcade_secrets` table (migration v4); tenant_apps.db_pass
 * stays NULL under kms.
 *
 * THE DROP-IN SEAM (real AWS/GCP KMS):
 *   `KmsKeyProvider` is EXACTLY the AWS KMS GenerateDataKey/Decrypt and GCP KMS
 *   encrypt/decrypt call shape — 3 members:
 *     generateDataKey(): {plaintextKey, wrappedKey, keyId}
 *     decryptDataKey(wrappedKey, keyId): Buffer
 *     providerId: string
 *   So a real cloud provider is a drop-in impl of these 3 members. SDKs load
 *   lazily (like security/keytarLoader.ts) so core carries no hard KMS dep;
 *   D-017 untouched (KMS SDKs are not DB drivers, kept optional).
 *
 *   ⚠ NEEDS-REAL-CLOUD VALIDATION: the AWS/GCP provider impls (IAM key policies,
 *   API throttling, multi-region keys, grant semantics) cannot be proven in this
 *   sandbox. The seam + envelope format are proven end-to-end via LocalKekKmsProvider.
 *
 * LOCAL-TESTABLE STUB — LocalKekKmsProvider: KEK is 32 bytes from
 * LORE_ARCADE_KMS_KEK (base64) or LORE_ARCADE_KMS_KEK_FILE (must be 0600, fail
 * loud otherwise). generateDataKey wraps the DEK AES-256-GCM under the KEK;
 * providerId 'local-kek'. Proves the seam + envelope with zero cloud.
 *
 * NEVER-LOG RULE: only secret_ref, key_id, provider ever appear in logs/errors.
 * A GCM tag failure throws a typed error containing the ref only. The plaintext
 * secret and the DEK never appear in any log line, audit entry, or error message.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { Database as DatabaseType } from 'better-sqlite3';

import type { ArcadeSecretStore } from './arcadeSecretStore.js';

// ── KmsKeyProvider seam (AWS/GCP call shape) ─────────────────────────────────

export interface GeneratedDataKey {
  /** 32-byte plaintext DEK — used immediately, never persisted. */
  plaintextKey: Buffer;
  /** the DEK wrapped by the KEK — persisted (safe at rest without the KEK). */
  wrappedKey: Buffer;
  /** the KEK/CMK id used to wrap (for multi-key / rotation bookkeeping). */
  keyId: string;
}

export interface KmsKeyProvider {
  /** AWS KMS GenerateDataKey / GCP: fresh DEK + its wrapped form. */
  generateDataKey(): Promise<GeneratedDataKey>;
  /** AWS KMS Decrypt / GCP decrypt: unwrap a persisted DEK. */
  decryptDataKey(wrappedKey: Buffer, keyId: string): Promise<Buffer>;
  /** stable non-secret provider id ('local-kek', 'aws-kms', 'gcp-kms'). */
  readonly providerId: string;
}

/** Typed error carrying ONLY the ref (never secret material). */
export class ArcadeKmsError extends Error {
  constructor(
    public readonly ref: string,
    reason: string,
  ) {
    super(`[arcadeKmsSecretStore] ${reason} (ref=${ref})`);
    this.name = 'ArcadeKmsError';
  }
}

// ── LocalKekKmsProvider (local-testable stub; proves the envelope end-to-end) ─

const KEK_LEN = 32;

/** Resolve the 32-byte KEK from env, fail-closed. base64 env var OR a 0600 file. */
export function resolveLocalKek(): Buffer {
  const b64 = process.env['LORE_ARCADE_KMS_KEK'];
  if (b64 && b64.length > 0) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== KEK_LEN) {
      throw new Error(
        `[arcadeKmsSecretStore] LORE_ARCADE_KMS_KEK must decode to ${KEK_LEN} bytes (got ${buf.length})`,
      );
    }
    return buf;
  }
  const file = process.env['LORE_ARCADE_KMS_KEK_FILE'];
  if (file && file.length > 0) {
    const st = fs.statSync(file);
    // Fail LOUD if the KEK file is group/other-readable (must be 0600).
    const mode = st.mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `[arcadeKmsSecretStore] KEK file ${file} has mode ${mode.toString(8)} — must be 0600 ` +
          `(owner-only). Refusing to read a group/other-accessible key.`,
      );
    }
    const raw = fs.readFileSync(file);
    // Accept either raw 32 bytes or a base64 line.
    const buf = raw.length === KEK_LEN ? raw : Buffer.from(raw.toString('utf8').trim(), 'base64');
    if (buf.length !== KEK_LEN) {
      throw new Error(
        `[arcadeKmsSecretStore] KEK file ${file} must contain ${KEK_LEN} raw bytes or a base64 ` +
          `encoding of them (got ${buf.length} bytes)`,
      );
    }
    return buf;
  }
  throw new Error(
    `[arcadeKmsSecretStore] kms backend requires a KEK: set LORE_ARCADE_KMS_KEK (base64, 32 bytes) ` +
      `or LORE_ARCADE_KMS_KEK_FILE (0600 file). Fail-closed.`,
  );
}

/**
 * LocalKekKmsProvider — wraps/unwraps the DEK with a locally-held KEK using
 * AES-256-GCM. Wrapped-key format: [12-byte iv][16-byte tag][ciphertext DEK].
 * providerId 'local-kek', keyId 'local-kek/v1'.
 */
export class LocalKekKmsProvider implements KmsKeyProvider {
  readonly providerId = 'local-kek';
  private static readonly KEY_ID = 'local-kek/v1';
  constructor(private readonly kek: Buffer = resolveLocalKek()) {}

  generateDataKey(): Promise<GeneratedDataKey> {
    const plaintextKey = crypto.randomBytes(KEK_LEN);
    const { wrappedKey, keyId } = this.wrapDek(plaintextKey);
    return Promise.resolve({ plaintextKey, wrappedKey, keyId });
  }

  /** Wrap an arbitrary DEK under the KEK in the [iv][tag][ct] format read()
   *  expects. Used by generateDataKey and by KEK-rotation rewrap. */
  wrapDek(dek: Buffer): { wrappedKey: Buffer; keyId: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.kek, iv);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { wrappedKey: Buffer.concat([iv, tag, ct]), keyId: LocalKekKmsProvider.KEY_ID };
  }

  decryptDataKey(wrappedKey: Buffer, _keyId: string): Promise<Buffer> {
    const iv = wrappedKey.subarray(0, 12);
    const tag = wrappedKey.subarray(12, 28);
    const ct = wrappedKey.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAuthTag(tag);
    const dek = Buffer.concat([decipher.update(ct), decipher.final()]);
    return Promise.resolve(dek);
  }
}

/**
 * loadKmsKeyProvider — lazily selects the provider by LORE_ARCADE_KMS_PROVIDER.
 * Default 'local-kek'. Real 'aws-kms'/'gcp-kms' are the drop-in point — they
 * lazy-import the vendor SDK (mirrors keytarLoader) so core has no hard dep.
 * Those impls are NOT included in this slice (needs-real-cloud); requesting them
 * fails loud so no silent fallback to the local KEK for a cloud deploy.
 */
export function loadKmsKeyProvider(): KmsKeyProvider {
  const which = (process.env['LORE_ARCADE_KMS_PROVIDER'] ?? 'local-kek').toLowerCase();
  if (which === 'local-kek') return new LocalKekKmsProvider();
  // NEEDS-REAL-CLOUD: aws-kms / gcp-kms providers are a drop-in impl of
  // KmsKeyProvider (lazy-import @aws-sdk/client-kms / @google-cloud/kms). Not
  // shipped here — fail loud rather than silently use the local KEK.
  throw new Error(
    `[arcadeKmsSecretStore] LORE_ARCADE_KMS_PROVIDER='${which}' requires a real-cloud KMS provider ` +
      `impl (drop-in of KmsKeyProvider — requires real-infra validation, not in this build). ` +
      `Only 'local-kek' is available locally.`,
  );
}

// ── arcade_secrets row shape (registry migration v4) ─────────────────────────

interface ArcadeSecretRow {
  secret_ref: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  wrapped_dek: Buffer;
  dek_iv: Buffer;
  dek_tag: Buffer;
  key_id: string;
  provider: string;
  created_at: string;
  rotated_at: string | null;
}

// ── KmsSecretStore ────────────────────────────────────────────────────────────

/**
 * KmsSecretStore — envelope-encryption ArcadeSecretStore. Async-only (like
 * keychain): readSync is intentionally ABSENT, so the sync fast-path returns
 * undefined and callers MUST use the async read path (getOrBuild becomes async
 * under kms — see arcadeCellPool).
 */
export class KmsSecretStore implements ArcadeSecretStore {
  readonly kind = 'kms' as const;
  constructor(
    private readonly dbSupplier: () => DatabaseType,
    private readonly provider: KmsKeyProvider = loadKmsKeyProvider(),
  ) {}

  // readSync intentionally absent → callers fall back to async read (same
  // contract as keychain). This is what forces the async cell-build path.

  async read(ref: string): Promise<string | undefined> {
    const row = this.dbSupplier()
      .prepare(`SELECT * FROM arcade_secrets WHERE secret_ref = ?`)
      .get(ref) as ArcadeSecretRow | undefined;
    if (!row) return undefined;
    // Unwrap the DEK, then AES-256-GCM decrypt the secret. A tampered ciphertext
    // or tag makes the GCM final() throw — we surface a typed error carrying the
    // REF ONLY (never the secret). This is criterion (d): a flipped byte throws,
    // never returns garbage.
    let dek: Buffer;
    try {
      dek = await this.provider.decryptDataKey(row.wrapped_dek, row.key_id);
    } catch {
      throw new ArcadeKmsError(ref, 'DEK unwrap failed (KEK mismatch or wrapped-DEK tampered)');
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', dek, row.iv);
      decipher.setAuthTag(row.tag);
      const pt = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      return pt.toString('utf8');
    } catch {
      throw new ArcadeKmsError(ref, 'ciphertext GCM authentication failed (tampered or wrong DEK)');
    }
  }

  async write(ref: string, value: string): Promise<void> {
    const { plaintextKey, wrappedKey, keyId } = await this.provider.generateDataKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', plaintextKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // The wrappedKey from LocalKekKmsProvider is [iv][tag][ct]; we persist the
    // whole blob as wrapped_dek and keep dek_iv/dek_tag as its leading slices so
    // the schema is provider-agnostic (a real KMS returns an opaque wrappedKey —
    // stored whole in wrapped_dek, dek_iv/dek_tag then empty). We store the whole
    // blob in wrapped_dek and empty buffers in dek_iv/dek_tag; decrypt reads
    // wrapped_dek only. Kept as columns for forward-compat/observability.
    const now = new Date().toISOString();
    this.dbSupplier()
      .prepare(
        `INSERT INTO arcade_secrets
           (secret_ref, ciphertext, iv, tag, wrapped_dek, dek_iv, dek_tag, key_id, provider, created_at, rotated_at)
         VALUES (@ref, @ct, @iv, @tag, @wdek, @dekIv, @dekTag, @keyId, @provider, @now, NULL)
         ON CONFLICT(secret_ref) DO UPDATE SET
           ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
           wrapped_dek = excluded.wrapped_dek, dek_iv = excluded.dek_iv, dek_tag = excluded.dek_tag,
           key_id = excluded.key_id, provider = excluded.provider, rotated_at = @now`,
      )
      .run({
        ref,
        ct: ciphertext,
        iv,
        tag,
        wdek: wrappedKey,
        dekIv: Buffer.alloc(0),
        dekTag: Buffer.alloc(0),
        keyId,
        provider: this.provider.providerId,
        now,
      });
  }

  async delete(ref: string): Promise<void> {
    this.dbSupplier().prepare(`DELETE FROM arcade_secrets WHERE secret_ref = ?`).run(ref);
    return Promise.resolve();
  }

  /**
   * rewrapAllSecrets — KEK-rotation verb. Walks arcade_secrets, unwraps each DEK
   * with `oldProvider`, re-wraps with `newProvider`, updates key_id/provider/
   * rotated_at. NEVER touches ciphertext or the plaintext secret — the decrypted
   * value is unchanged (criterion (h)). Returns the count re-wrapped.
   */
  async rewrapAllSecrets(
    oldProvider: KmsKeyProvider,
    newProvider: KmsKeyProvider,
  ): Promise<number> {
    const db = this.dbSupplier();
    const rows = db.prepare(`SELECT * FROM arcade_secrets`).all() as ArcadeSecretRow[];
    let count = 0;
    for (const row of rows) {
      const dek = await oldProvider.decryptDataKey(row.wrapped_dek, row.key_id);
      // Re-wrap the SAME dek under the new KEK. For LocalKekKmsProvider we mint a
      // fresh wrap by encrypting the dek — provider-specific, so we wrap via a
      // generateDataKey-shaped path: encrypt the existing dek under the new KEK.
      const rewrapped = await rewrapDek(newProvider, dek);
      db.prepare(
        `UPDATE arcade_secrets SET wrapped_dek = @wdek, key_id = @keyId, provider = @provider, rotated_at = @now
         WHERE secret_ref = @ref`,
      ).run({
        wdek: rewrapped.wrappedKey,
        keyId: rewrapped.keyId,
        provider: newProvider.providerId,
        now: new Date().toISOString(),
        ref: row.secret_ref,
      });
      count++;
    }
    return count;
  }
}

/**
 * rewrapDek — wrap an EXISTING dek under a provider's KEK. For LocalKekKmsProvider
 * we reach through its generateDataKey envelope shape by encrypting the given dek
 * directly. A real KMS exposes an `Encrypt` call for arbitrary plaintext; that is
 * the drop-in point. Here we special-case LocalKekKmsProvider (the only local
 * provider) so rewrap uses the SAME wrap format read() expects.
 */
async function rewrapDek(
  provider: KmsKeyProvider,
  dek: Buffer,
): Promise<{ wrappedKey: Buffer; keyId: string }> {
  if (provider instanceof LocalKekKmsProvider) {
    // Wrap the provided dek under the provider's KEK using the same
    // [iv][tag][ct] format generateDataKey / read() use.
    return Promise.resolve(provider.wrapDek(dek));
  }
  // NEEDS-REAL-CLOUD: a real KMS provider re-wraps via its Encrypt API.
  throw new Error(
    `[arcadeKmsSecretStore] rewrapDek for provider '${provider.providerId}' requires a real-cloud ` +
      `Encrypt call (not available in this build)`,
  );
}
