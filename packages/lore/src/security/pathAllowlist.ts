/**
 * pathAllowlist.ts — Filesystem allow/deny policy for ingestion (S4).
 *
 * Before this existed, the `read_document_for_ingestion` MCP tool would
 * read any absolute path and pass the content to an LLM. A prompt-injected
 * or malicious session could instruct the LLM to call this tool on
 * ~/.ssh/id_rsa or ~/.aws/credentials; the content then lands in a chat
 * response or gets stored as a node — either path is trivially exfiltrable.
 *
 * Two-layer policy:
 *
 *   1. Blocklist (always denied, regardless of allow-root match):
 *      - ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube — credential stores
 *      - ~/.groundfloor — Lore's own data, includes auth.token
 *      - ~/Library/Keychains — macOS keychain databases
 *      - Any path whose basename looks like a secret file (id_rsa*,
 *        *.pem, *.key, *.p12, credentials)
 *
 *   2. Allowlist (must match one):
 *      - ~/Documents, ~/Downloads, ~/Desktop — user-intentional dirs
 *      - The workspace root if it's a git repo (not ~/.groundfloor)
 *      - User-configured extras from ~/.groundfloor/ingestion.json
 *
 * Resolution order:
 *   - We realpath the requested path (follow symlinks) and check BOTH
 *     the resolved path and the original. A symlink from ~/Documents/foo
 *     to ~/.ssh/id_rsa is rejected because the resolved path lands in a
 *     blocklisted root.
 *
 * Size cap:
 *   - 50 MB hard limit. Reasonable upper bound for documents users want
 *     to ingest; prevents an attacker from pinning a worker on a huge file
 *     and prevents accidentally feeding a binary blob to the LLM.
 *
 * Future (deferred for S4): make the allowlist configurable via a UI,
 * add a "request-new-root" approval flow tied to the S6 consent gate,
 * and record every ingestion read to the audit log.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const MAX_INGESTION_BYTES = 50 * 1024 * 1024; // 50 MB

export interface AllowlistConfig {
    /** The current workspace root. Allowed iff it isn't ~/.groundfloor. */
    workspaceRoot?: string;
    /** Extra roots from ~/.groundfloor/ingestion.json. */
    extraRoots?: string[];
}

/** Blocklisted directory roots — always denied. */
function defaultBlockedRoots(): string[] {
    const home = os.homedir();
    return [
        path.join(home, '.ssh'),
        path.join(home, '.aws'),
        path.join(home, '.gnupg'),
        path.join(home, '.kube'),
        path.join(home, '.groundfloor'),
        path.join(home, 'Library', 'Keychains'),
        path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Login Data'),
    ];
}

/** Allowlisted roots — at least one must be a prefix. */
function defaultAllowedRoots(cfg: AllowlistConfig): string[] {
    const home = os.homedir();
    const roots = [
        path.join(home, 'Documents'),
        path.join(home, 'Downloads'),
        path.join(home, 'Desktop'),
    ];
    // Workspace root is allowed IFF it isn't ~/.groundfloor (that's the
    // Lore data dir — always blocklisted).
    if (cfg.workspaceRoot && cfg.workspaceRoot !== path.join(home, '.groundfloor')) {
        roots.push(cfg.workspaceRoot);
    }
    for (const r of cfg.extraRoots ?? []) {
        if (typeof r === 'string' && r.startsWith('/')) {
            roots.push(r);
        }
    }
    return roots;
}

/** Basename patterns that look like secrets — denied regardless of path. */
function looksLikeSecretFile(filePath: string): boolean {
    const base = path.basename(filePath).toLowerCase();
    if (base.startsWith('id_rsa') || base.startsWith('id_ed25519') || base.startsWith('id_ecdsa') || base.startsWith('id_dsa')) {
        return true;
    }
    if (base === 'credentials' || base === '.env' || base === '.env.local' || base === 'auth.token') {
        return true;
    }
    if (/\.(pem|key|p12|pfx|keystore)$/.test(base)) {
        return true;
    }
    return false;
}

/**
 * Is `candidate` equal to or a descendant of `root`?
 *
 * Uses path.relative to avoid prefix-string pitfalls (`/foo/bar` vs
 * `/foo/barbaz`). A relative path that starts with `..` means candidate
 * is outside root.
 */
function isUnder(candidate: string, root: string): boolean {
    const rel = path.relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export class PathAllowlistError extends Error {
    readonly code: 'blocked' | 'not-allowed' | 'too-large' | 'not-found' | 'not-a-file';
    constructor(message: string, code: 'blocked' | 'not-allowed' | 'too-large' | 'not-found' | 'not-a-file') {
        super(message);
        this.name = 'PathAllowlistError';
        this.code = code;
    }
}

/**
 * assertPathAllowed — throws PathAllowlistError if the path violates policy.
 *
 * Checks (in order):
 *   1. File exists and is a regular file (not device/socket/directory).
 *   2. Not under any blocklisted root (both original AND realpath).
 *   3. Basename doesn't match a secret-file pattern.
 *   4. Under at least one allowlisted root (both original AND realpath).
 *   5. Size <= MAX_INGESTION_BYTES.
 *
 * Returns the resolved (realpath) path so the caller can read it.
 */
export function assertPathAllowed(requested: string, cfg: AllowlistConfig): string {
    if (!path.isAbsolute(requested)) {
        throw new PathAllowlistError(`Path must be absolute: ${requested}`, 'not-allowed');
    }

    // 1. Must exist, must be a regular file.
    let stat: fs.Stats;
    try {
        stat = fs.statSync(requested);
    } catch {
        throw new PathAllowlistError(`File not found: ${requested}`, 'not-found');
    }
    if (!stat.isFile()) {
        throw new PathAllowlistError(`Not a regular file: ${requested}`, 'not-a-file');
    }
    if (stat.size > MAX_INGESTION_BYTES) {
        throw new PathAllowlistError(
            `File exceeds ${MAX_INGESTION_BYTES}-byte ingestion cap: ${requested}`,
            'too-large',
        );
    }

    // 2. Resolve symlinks so we evaluate the real target, not a path
    //    that happens to live under an allowed root.
    let resolved: string;
    try {
        resolved = fs.realpathSync(requested);
    } catch {
        // shouldn't happen after statSync succeeded, but be safe
        throw new PathAllowlistError(`Cannot resolve: ${requested}`, 'not-found');
    }

    const blockedRoots = defaultBlockedRoots();
    for (const b of blockedRoots) {
        if (isUnder(requested, b) || isUnder(resolved, b)) {
            throw new PathAllowlistError(
                `Path resolves under blocklisted root ${b}: ${requested}`,
                'blocked',
            );
        }
    }

    // 3. Secret-file basename check — catches id_rsa tucked into ~/Documents.
    if (looksLikeSecretFile(requested) || looksLikeSecretFile(resolved)) {
        throw new PathAllowlistError(
            `Path looks like a credential file: ${requested}`,
            'blocked',
        );
    }

    // 4. Must be under an allowed root (either the original or the resolved
    //    target — covers both "user asked directly for /etc/..." and "user
    //    asked for ~/Documents/link-to-/etc/...").
    const allowedRoots = defaultAllowedRoots(cfg);
    const underAllowed =
        allowedRoots.some((r) => isUnder(requested, r)) ||
        allowedRoots.some((r) => isUnder(resolved, r));
    if (!underAllowed) {
        throw new PathAllowlistError(
            `Path is not under an allowed ingestion root. Allowed: ${allowedRoots.join(', ')}`,
            'not-allowed',
        );
    }

    return resolved;
}

/**
 * loadExtraIngestionRoots — read user-configured additional roots from
 * ~/.groundfloor/ingestion.json. Returns [] if missing or malformed.
 */
export function loadExtraIngestionRoots(dataHome: string): string[] {
    const cfgPath = path.join(dataHome, 'ingestion.json');
    try {
        const raw = fs.readFileSync(cfgPath, 'utf-8');
        const parsed = JSON.parse(raw) as { allowedRoots?: unknown };
        if (Array.isArray(parsed.allowedRoots)) {
            return parsed.allowedRoots.filter((s): s is string => typeof s === 'string');
        }
    } catch {
        // missing or malformed — empty list
    }
    return [];
}
