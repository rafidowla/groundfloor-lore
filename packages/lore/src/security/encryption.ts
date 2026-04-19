/**
 * encryption.ts — AES-256-GCM primitives for at-rest encryption (S6).
 *
 * Scope note: S6 ships the primitives — symmetric encrypt/decrypt with
 * per-record IV — and the keyring that hands them a per-workspace key.
 * Auto-migration of the live graph + verbatim store is NOT in S6;
 * encryption-breaks-search trade-offs need their own iteration (see the
 * README below). S6 makes the tools available.
 *
 * Shape:
 *   const key = await getWorkspaceKey(workspaceName);
 *   const payload = encrypt(plaintext, key);
 *     → { alg: 'aes-256-gcm', iv: hex, ciphertext: hex, tag: hex }
 *   const plain = decrypt(payload, key);
 *
 * Why AES-256-GCM:
 *   - Authenticated encryption (detects tampering — important when
 *     ciphertext sits in a file another process could modify).
 *   - Supported natively by node's crypto module since v16, no deps.
 *   - Industry-standard for at-rest encryption.
 *
 * Why per-record IV:
 *   - Two identical verbatim strings produce different ciphertexts.
 *   - Prevents an attacker who sees the on-disk database from
 *     identifying "which records have the same content".
 *
 * Why GCM's 12-byte IV:
 *   - NIST-recommended for GCM (96 bits gives a large-enough uniqueness
 *     space for a very long workspace lifetime).
 *   - Random IV per record is safer than a counter we'd have to
 *     persist alongside the key.
 *
 * TRADE-OFF (not solved in S6):
 *   - Encrypted fields can't be searched with `CONTAINS` or full-text
 *     search. If the verbatim text column is encrypted, the UI's
 *     textual search (`/api/search`) can't find matches there. Solutions
 *     involve searchable encryption (deterministic per-token), searchable
 *     symmetric encryption (expensive), or moving the search to vector
 *     similarity only (cheap — we already compute embeddings). The right
 *     path depends on what the Personal plugin demands and is a Phase 5
 *     concern.
 *
 * Integration status:
 *   - S6 (Phase 3): primitives + keyring + verbatim-store opt-in flag
 *     that, when true, stores ciphertext. Flag defaults false; no
 *     backward-incompatibility.
 *   - Phase 5 (Personal launch): decide on the search strategy over
 *     encrypted content, flip the flag workspace-wide, one-time migration.
 */

import * as crypto from 'crypto';

const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export interface EncryptedPayload {
    alg: 'aes-256-gcm';
    iv: string;          // hex-encoded IV
    ciphertext: string;  // hex-encoded ciphertext
    tag: string;         // hex-encoded GCM auth tag
}

/**
 * Format on disk / over the wire: JSON-serializable object. We don't
 * use a packed binary format because the overhead is tiny and
 * human-debuggable encrypted payloads are worth a lot during incident
 * response.
 */
export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
    if (key.length !== KEY_BYTES) {
        throw new Error(`encryption key must be ${KEY_BYTES} bytes`);
    }
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALG, key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        alg: 'aes-256-gcm',
        iv: iv.toString('hex'),
        ciphertext: enc.toString('hex'),
        tag: tag.toString('hex'),
    };
}

/**
 * decrypt — inverse of encrypt. Throws on auth-tag mismatch (tampered
 * ciphertext, wrong key, truncation). Callers should treat the throw as
 * "record unreadable" and continue — a single bad row shouldn't crash
 * the daemon.
 */
export function decrypt(payload: EncryptedPayload, key: Buffer): string {
    if (key.length !== KEY_BYTES) {
        throw new Error(`encryption key must be ${KEY_BYTES} bytes`);
    }
    if (payload.alg !== ALG) {
        throw new Error(`unsupported alg: ${payload.alg}`);
    }
    const iv = Buffer.from(payload.iv, 'hex');
    const ct = Buffer.from(payload.ciphertext, 'hex');
    const tag = Buffer.from(payload.tag, 'hex');
    const decipher = crypto.createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(ct), decipher.final()]);
    return dec.toString('utf-8');
}

/** Generate a fresh 256-bit key (used by the keyring on first request). */
export function generateKey(): Buffer {
    return crypto.randomBytes(KEY_BYTES);
}

/**
 * isEncryptedPayload — structural type guard for deserialized JSON.
 *
 * When reading a verbatim record that MIGHT be ciphertext or plaintext
 * (during migration), callers use this to decide which path to take.
 */
export function isEncryptedPayload(value: unknown): value is EncryptedPayload {
    if (!value || typeof value !== 'object') return false;
    const v = value as Partial<EncryptedPayload>;
    return v.alg === 'aes-256-gcm'
        && typeof v.iv === 'string'
        && typeof v.ciphertext === 'string'
        && typeof v.tag === 'string';
}
