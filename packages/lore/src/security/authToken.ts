/**
 * authToken.ts — Persistent localhost auth token for the HTTP daemon.
 *
 * Why: before Phase 0 / S3, Lore's /api/* HTTP routes had no auth. Any
 * local process, any visited browser tab, any curl from the same machine
 * could delete workspaces, send arbitrary chat prompts, or exfiltrate the
 * graph via /api/node. Localhost-bind was the only barrier.
 *
 * What: on daemon start, ensure ~/.groundfloor/auth.token exists with a
 * high-entropy random token (32 bytes = 256 bits, hex-encoded). Persist
 * across restarts so the UI keeps working without re-bootstrapping every
 * launch. File perms locked to 0600 (S1 lockdown also runs over the dir,
 * but we also explicitly chmod the token file at write time — defense in
 * depth).
 *
 * Token consumers:
 *   - UI fetches the token once via /api/auth/bootstrap (Host+Origin gated,
 *     no Authorization required for bootstrap itself).
 *   - Programmatic clients (CLI, MCP, test scripts) read the token file
 *     directly (since only the owning user can, by perms) and pass it
 *     as `Authorization: Bearer <token>`.
 *
 * Rotation: delete the file; next daemon start generates a new one. UI
 * will re-bootstrap on next load. CLI needs to re-read the file.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const TOKEN_FILENAME = 'auth.token';
const TOKEN_BYTES = 32;

/**
 * ensureAuthToken — read existing token, or generate and persist a new one.
 *
 * @param dataHome  ~/.groundfloor (or equivalent data root)
 * @returns         The 64-char hex token.
 *
 * Idempotent: re-running after boot returns the same token. Safe to call
 * multiple times (e.g. on daemon restart).
 */
export function ensureAuthToken(dataHome: string): string {
    const tokenPath = path.join(dataHome, TOKEN_FILENAME);

    try {
        const existing = fs.readFileSync(tokenPath, 'utf-8').trim();
        // Basic shape check — a 64-char hex token. If the file is corrupt
        // (empty, wrong length, non-hex), regenerate rather than fail open.
        if (/^[0-9a-f]{64}$/.test(existing)) {
            return existing;
        }
        // fall through to regenerate
    } catch {
        // file doesn't exist or unreadable — generate fresh
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token + '\n', { mode: 0o600 });
    // chmod explicitly in case the file already existed with wrong perms
    // and writeFileSync didn't re-apply them.
    try {
        fs.chmodSync(tokenPath, 0o600);
    } catch {
        // non-fatal; perms are best-effort on non-POSIX
    }
    return token;
}

/**
 * getAuthTokenPath — return the token file location without reading it.
 *
 * For CLI/docs that want to tell the user where the token lives.
 */
export function getAuthTokenPath(dataHome: string): string {
    return path.join(dataHome, TOKEN_FILENAME);
}
