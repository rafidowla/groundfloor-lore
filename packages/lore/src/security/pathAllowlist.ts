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
import { loreHome, loreHomePath } from '../config/loreHome.js';

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
        loreHome(),
        path.join(home, 'Library', 'Keychains'),
        path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Login Data'),
        // NW-1a defense in depth — credential / config paths a settings UI
        // root injection could otherwise expose.
        '/etc',
        '/private/etc',
        path.join(home, '.config'),
        path.join(home, '.docker'),
        path.join(home, '.netrc'),
        path.join(home, '.npmrc'),
        path.join(home, '.pypirc'),
        path.join(home, '.git-credentials'),
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
    if (cfg.workspaceRoot && cfg.workspaceRoot !== loreHome()) {
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

/**
 * F-E05 — Resolve symlinks on a directory root so containment checks compare
 * real targets, not symlinked names. A root that is itself a symlink (e.g.
 * ~/Documents → /Volumes/ext/Docs), or that contains a symlinked subdir,
 * could otherwise widen what is readable beyond the intended directory: the
 * candidate's realpath would never test as "under" the un-resolved root name.
 *
 * Fails CLOSED: if the root cannot be realpath-resolved (does not exist yet,
 * permission denied, broken symlink) we return null so the caller drops it
 * from the allow-set rather than honoring a path we cannot vouch for.
 */
function realRootOrNull(root: string): string | null {
    try {
        return fs.realpathSync(root);
    } catch {
        // F-E05: non-existent / unresolvable root → not allowed (fail closed).
        return null;
    }
}

/**
 * F-E05 — Containment check against an allow-root using realpaths on BOTH
 * sides. `resolvedCandidate` is already the realpath of the requested file.
 * We realpath the root too, then apply the relative-path boundary guard so
 * /a/bc is never treated as under /a/b. Returns false if the root cannot be
 * resolved (fail closed).
 */
function isUnderRealRoot(resolvedCandidate: string, root: string): boolean {
    const realRoot = realRootOrNull(root);
    if (realRoot === null) return false;
    return isUnder(resolvedCandidate, realRoot);
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

    // 4. Must be under an allowed root. F-E05: the roots themselves are
    //    realpath-resolved before the containment check, so a symlinked root
    //    (or a symlink inside one) cannot widen access — we compare the
    //    candidate's realpath against each root's realpath, with the
    //    relative-path boundary guard (isUnder) so /a/bc never matches /a/b.
    //    Roots that fail to realpath (missing / broken symlink / EACCES) are
    //    dropped from the allow-set (fail closed). We still also test the
    //    un-resolved `requested` against the resolved roots to preserve the
    //    "user asked directly for an in-root path" case where the file's own
    //    realpath might land elsewhere (e.g. the file is itself a symlink the
    //    blocklist already cleared).
    const allowedRoots = defaultAllowedRoots(cfg);
    const underAllowed =
        allowedRoots.some((r) => isUnderRealRoot(resolved, r)) ||
        allowedRoots.some((r) => isUnderRealRoot(requested, r));
    if (!underAllowed) {
        // R4-LEAK-01 — do NOT enumerate the allowed roots in the error: this
        // message is echoed verbatim to the caller (HTTP + MCP ingestion), so
        // listing them disclosed the full server-side ingestion allow-config on
        // a single out-of-allowlist attempt. The operator can inspect the roots
        // via config; the caller only needs to know the path was rejected.
        throw new PathAllowlistError(
            `Path is not under an allowed ingestion root.`,
            'not-allowed',
        );
    }

    return resolved;
}

/**
 * loadExtraIngestionRoots — read user-configured additional roots from
 * ~/.groundfloor/ingestion.json. Returns [] if missing or malformed.
 *
 * 2026-05-14 model change: the config file is now the single source of
 * truth for the user's chosen roots. Previously this returned just the
 * "additions" on top of hardcoded defaults; now an empty list from a
 * saved file means "user explicitly indexed nothing." The daemon's
 * filesystem connector still falls back to Documents/Downloads/Desktop
 * when the file doesn't exist at all (first-run).
 *
 * Field accepted: `roots` (new) or `allowedRoots` (legacy, still read).
 */
export function loadExtraIngestionRoots(dataHome: string): string[] {
    const cfgPath = path.join(dataHome, 'ingestion.json');
    try {
        const raw = fs.readFileSync(cfgPath, 'utf-8');
        const parsed = JSON.parse(raw) as { roots?: unknown; allowedRoots?: unknown };
        // Prefer the new field; fall back to the legacy one so we don't lose
        // already-configured installs.
        const list = Array.isArray(parsed.roots) ? parsed.roots
            : Array.isArray(parsed.allowedRoots) ? parsed.allowedRoots
            : null;
        if (list) {
            // NW-1a: filter at read-time too, so a pre-existing or
            // hand-edited ingestion.json entry that names a system root or a
            // path outside the user's home cannot widen the allowlist. The
            // write-side guard (saveExtraIngestionRoots) already rejects
            // these, but read-side filtering closes the gap for installs
            // that predate this fix and for direct file edits that bypass
            // the admin API.
            return list
                .filter((s): s is string => typeof s === 'string')
                .filter((s) => isWatchRootSafe(s));
        }
    } catch {
        // missing or malformed — empty list
    }
    return [];
}

/**
 * System roots that must never become ingestion allow-roots, even if the
 * user (or a misconfigured supervisor) sets LORE_WATCH_PATHS to one of
 * them. Granting `/` or `/etc` as a readable root would let the ingestion
 * tools read the entire filesystem subject only to the static secret-file
 * blocklist — which is far weaker than "under an intentional root."
 *
 * We reject any watch path that IS one of these, or that lies OUTSIDE the
 * user's home directory. A watch path equal to `os.homedir()` itself is
 * also refused — it's effectively "read everything the user owns," which
 * defeats the allowlist. Legitimate use (~/Documents, ~/Notes, a project
 * checkout under ~/code) is preserved.
 */
const SYSTEM_ROOTS = [
    '/', '/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64',
    '/var', '/opt', '/boot', '/dev', '/proc', '/sys', '/root',
    '/private', '/private/etc', '/private/var', '/System', '/Library',
];

/**
 * isWatchRootSafe — true iff `root` is an absolute path that is strictly
 * under the user's home directory and is not a known system root. Mirrors
 * the robustness of assertPathAllowed: uses path.normalize + isUnder
 * (relative-based containment) rather than string-prefix matching, so
 * `/etc-ish` is not mistaken for `/etc`.
 */
export function isWatchRootSafe(root: string, home: string = os.homedir()): boolean {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return false;
    if (root.includes('\0')) return false;
    const norm = path.normalize(root).replace(/\/+$/, '') || '/';
    // Reject exact system roots.
    for (const sys of SYSTEM_ROOTS) {
        if (norm === sys) return false;
    }
    // Must be strictly under home — equal-to-home is refused (too broad),
    // and anything outside home is refused.
    const homeNorm = path.normalize(home).replace(/\/+$/, '') || '/';
    if (norm === homeNorm) return false;
    return isUnder(norm, homeNorm);
}

/**
 * loadWatchPathsAsRoots — read LORE_WATCH_PATHS env var as extra
 * ingestion-allowed roots. Entries are colon-separated absolute paths.
 * Non-absolute entries are silently dropped for safety.
 *
 * Rationale: a user who configured LORE_WATCH_PATHS already declared
 * intent to read those directories. Requiring a separate ingestion.json
 * entry is redundant friction that causes unexpected path_not_allowed
 * errors when the auto-ingest callback tries to read a watched file.
 *
 * SW-15 (A5): each entry is now validated by isWatchRootSafe — a watch
 * path that is a system root (`/`, `/etc`, …) or lies outside the user's
 * home is dropped, not silently honored as a readable ingestion root.
 * Previously `LORE_WATCH_PATHS=/` would widen the allowlist to the whole
 * filesystem behind the back of the ingestion.json policy.
 */
export function loadWatchPathsAsRoots(): string[] {
    const raw = process.env.LORE_WATCH_PATHS ?? '';
    return raw
        .split(':')
        .map((p) => p.trim())
        .filter((p) => path.isAbsolute(p) && isWatchRootSafe(p));
}

/**
 * loadAllExtraRoots — merge ingestion.json roots + LORE_WATCH_PATHS.
 * Use this in place of loadExtraIngestionRoots wherever the source-watcher
 * pipeline may have queued files for ingestion.
 */
export function loadAllExtraRoots(dataHome: string): string[] {
    const fromConfig = loadExtraIngestionRoots(dataHome);
    const fromWatchPaths = loadWatchPathsAsRoots();
    // Deduplicate — LORE_WATCH_PATHS may overlap with ingestion.json entries.
    const seen = new Set(fromConfig);
    for (const p of fromWatchPaths) {
        if (!seen.has(p)) { seen.add(p); fromConfig.push(p); }
    }
    return fromConfig;
}

/**
 * isIngestionConfigured — true when the user has saved any explicit
 * filesystem roots config, even an empty list. Used by the UI to
 * distinguish "first-run, here are suggestions" from "user explicitly
 * chose nothing."
 */
export function isIngestionConfigured(dataHome: string): boolean {
    return fs.existsSync(path.join(dataHome, 'ingestion.json'));
}

/**
 * saveExtraIngestionRoots — write the user-configured roots back to
 * ~/.groundfloor/ingestion.json. Atomic via tmp-file + rename so a
 * crash mid-write can't leave a half-truncated file. Validates each
 * entry: must be a non-empty absolute string with no NUL bytes; does
 * NOT enforce path existence (user may type a path that exists in
 * another window later).
 *
 * Added 2026-05-14 for the Settings → Connectors → Filesystem UI.
 */
export function saveExtraIngestionRoots(dataHome: string, roots: string[]): void {
    const cleaned: string[] = [];
    const seen = new Set<string>();
    for (const r of roots) {
        if (typeof r !== 'string') continue;
        const trimmed = r.trim();
        if (!trimmed) continue;
        if (trimmed.includes('\0')) {
            throw new Error('path must not contain NUL bytes');
        }
        if (!path.isAbsolute(trimmed)) {
            throw new Error(`path must be absolute: "${trimmed}"`);
        }
        // NW-1a: enforce the same containment guard SW-15 added for
        // LORE_WATCH_PATHS. Previously this only checked absoluteness, so
        // an authenticated PATCH to /api/connectors/filesystem/paths could
        // persist "/" or "/etc" as a readable ingestion root and turn
        // read_document_for_ingestion into a local-file exfil primitive.
        if (!isWatchRootSafe(trimmed)) {
            throw new Error(`path is not a safe ingestion root: "${trimmed}"`);
        }
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        cleaned.push(trimmed);
    }
    const cfgPath = path.join(dataHome, 'ingestion.json');
    const tmpPath = cfgPath + '.tmp';
    // 2026-05-14: write the new `roots` field name. Legacy `allowedRoots`
    // readers (none in core anymore — loadExtraIngestionRoots() reads both)
    // are preserved by accepting either field on read.
    const body = JSON.stringify({ roots: cleaned }, null, 2);
    fs.writeFileSync(tmpPath, body, { mode: 0o600 });
    fs.renameSync(tmpPath, cfgPath);
}
