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
 *   - UI fetches the token once via /api/auth/bootstrap. The endpoint
 *     itself requires a one-time nonce (see ensureBootstrapNonce /
 *     consumeBootstrapNonce below) proving the caller can read
 *     <LORE_HOME> — the same trust tier as reading auth.token directly —
 *     rather than merely reaching the TCP socket with an acceptable
 *     Host/Origin. No Authorization header is required for bootstrap
 *     itself (there is no bearer yet at that point).
 *   - Programmatic clients (CLI, MCP, test scripts) read the token file
 *     directly (since only the owning user can, by perms) and pass it
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
    // D2-hygiene-3: create the data-home dir with an explicit 0700 mode and
    // chmod it, mirroring the 0600 treatment of the token file. Without this
    // the dir is created under the default umask, leaving a narrow window
    // where it (and a freshly-written token inside) is group/world-traversable.
    const tokenDir = path.dirname(tokenPath);
    fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(tokenDir, 0o700);
    } catch {
        // non-fatal; perms are best-effort on non-POSIX
    }
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

const NONCE_FILENAME = 'bootstrap.nonce';
const NONCE_BYTES = 32;

/**
 * ensureBootstrapNonce — mint a fresh one-time nonce for GET
 * /api/auth/bootstrap and persist it (0600) alongside auth.token.
 *
 * Call once per daemon boot, after ensureAuthToken. A stale nonce left
 * over from a killed daemon's prior boot must never authorize a
 * bootstrap call against the CURRENT daemon instance, so this always
 * overwrites rather than reusing an existing file.
 *
 * Why a nonce instead of trusting Host+Origin alone: Host/Origin only
 * prove the caller can reach the daemon's TCP socket on localhost with
 * an acceptable browser-style header pair — a sandboxed or
 * network-only local process can satisfy both while never having
 * touched the filesystem. Requiring the current nonce (readable only
 * by the owning OS user, same 0600 tier as auth.token) closes that gap
 * without changing anything for a legitimate same-user caller, which
 * already has filesystem access by construction.
 */
export function ensureBootstrapNonce(dataHome: string): string {
    const noncePath = getBootstrapNoncePath(dataHome);
    const nonce = crypto.randomBytes(NONCE_BYTES).toString('hex');
    fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(noncePath, nonce + '\n', { mode: 0o600 });
    try {
        fs.chmodSync(noncePath, 0o600);
    } catch {
        // non-fatal; perms are best-effort on non-POSIX
    }
    return nonce;
}

/**
 * getBootstrapNoncePath — return the nonce file location without reading it.
 */
export function getBootstrapNoncePath(dataHome: string): string {
    return path.join(dataHome, NONCE_FILENAME);
}

/**
 * consumeBootstrapNonce — validate `presented` against the on-disk nonce
 * and, on a match, delete the file so it can never be replayed
 * (one-time use: a captured request can't be reissued after the
 * legitimate caller has already bootstrapped this boot).
 *
 * Any mismatch — wrong value, empty presented value, or a missing file
 * (never minted, or already consumed) — returns false and leaves the
 * file untouched.
 */
export function consumeBootstrapNonce(dataHome: string, presented: string): boolean {
    const noncePath = getBootstrapNoncePath(dataHome);
    let current: string;
    try {
        current = fs.readFileSync(noncePath, 'utf-8').trim();
    } catch {
        return false;
    }
    if (!current || !presented || !constantTimeEqStr(presented, current)) {
        return false;
    }
    try {
        fs.unlinkSync(noncePath);
    } catch {
        // best-effort — still authorize this call even if the unlink races
    }
    return true;
}

/**
 * Constant-time string equality, mirroring httpAuth.ts's
 * constantTimeEqHex. Length mismatch short-circuits (leaks length only,
 * which is not secret — nonces are a fixed 64-char hex shape).
 */
function constantTimeEqStr(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
