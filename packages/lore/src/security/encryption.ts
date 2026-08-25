/**
 * encryption.ts — key-generation primitive for the per-workspace
 * keyring.
 *
 * Honest scope (NW-7h, ent-encryption-dead-code):
 *   Previous versions of this module shipped `encrypt` / `decrypt` /
 *   `isEncryptedPayload` AES-256-GCM helpers and claimed a verbatim
 *   opt-in flag that "stores ciphertext when set". The flag never
 *   existed and no production data path ever called the helpers. The
 *   AUDIT_FINDINGS_2 finding `ent-encryption-dead-code` flagged this
 *   as a credibility risk: shipping unused crypto primitives next to a
 *   docstring that overstates coverage is worse than not shipping them
 *   at all — an enterprise reviewer would (correctly) assume the live
 *   graph and verbatim store are encrypted-at-rest by Lore. They are
 *   not.
 *
 *   We deleted the dead primitives instead of pretending. Lore Core
 *   does NOT perform application-level at-rest encryption today. The
 *   `docs/SECURITY_MODEL.md` and `docs/COMPLIANCE.md` posture is "rely
 *   on OS/disk encryption" — see those files for the operator-facing
 *   statement.
 *
 *   `generateKey` is retained because `keyring.ts` still mints a
 *   per-workspace key on first request and stores it in the OS
 *   keychain. The key is reachable via `hasWorkspaceKey` (used by
 *   `lore doctor`) so an operator can confirm keychain integration is
 *   wired before a future encrypted-substrate path is introduced.
 *   That future path will reintroduce `encrypt` / `decrypt` alongside
 *   the call site that uses them, not before.
 */

import * as crypto from 'crypto';

const KEY_BYTES = 32;

/** Generate a fresh 256-bit key (used by the keyring on first request). */
export function generateKey(): Buffer {
    return crypto.randomBytes(KEY_BYTES);
}
