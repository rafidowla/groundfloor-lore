/**
 * tokens.ts — Phase 6 P3 per-app workspace-scoped auth tokens.
 *
 * Issue, lookup, list, and revoke tokens that bind a connected app
 * (Claude Code, Antigravity, Loom, …) to a specific workspace. Each
 * token also carries a scope set (`read`, `write`, optionally
 * `cross-workspace-read` / `cross-workspace-write`) so an operator can
 * mint a token that's powerful enough for an integration without
 * granting daemon-wide control.
 *
 * Token format
 *   `lore_<workspace>_<32-bytes-base64url>`
 *
 *   The `<workspace>` prefix is informational only — the registry is
 *   the source of truth, and the lookup ignores the prefix. The prefix
 *   exists so an operator can eyeball a token and tell which app it
 *   belongs to without leaking the random suffix.
 *
 * Registry on-disk
 *   `<loreHome>/auth/registry.json`, 0600 perms.
 *
 *   The file stores SHA-256 hashes of plaintext tokens, never the
 *   plaintext, so a stolen registry doesn't equal stolen tokens.
 *   Format:
 *     { version: 1, entries: { [hashHex]: TokenRecord } }
 *
 * Local-only — never synced to cloud, never committed. The .gitignore
 * is defensive in case an operator points LORE_HOME at a repo-local
 * dir for testing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { loreHome, loreHomePath } from '../config/loreHome.js';

export type TokenScope =
    | 'read'
    | 'write'
    | 'cross-workspace-read'
    | 'cross-workspace-write';

export const ALL_SCOPES: ReadonlyArray<TokenScope> = Object.freeze([
    'read', 'write', 'cross-workspace-read', 'cross-workspace-write',
]);

export interface TokenRecord {
    /** SHA-256 hex of the plaintext token. Used as the registry key. */
    hash: string;
    /**
     * First 12 chars of the plaintext, kept for display + revoke-by-prefix.
     * Same exposure as keeping the token's `lore_<workspace>_` prefix —
     * it doesn't enable login, since the registry stores the SHA-256
     * hash and verification is constant-time on the hash.
     */
    prefix: string;
    /** Bound workspace name. */
    workspace: string;
    /** Free-text label set by the operator at issue time. */
    label: string;
    /** Scope set granted to this token. */
    scopes: TokenScope[];
    /** ISO 8601 timestamp when the token was issued. */
    issuedAt: string;
    /** ISO 8601 timestamp last touched by an auth check; null when unused. */
    lastUsedAt: string | null;
    /** Set to ISO 8601 when revoked; null while active. */
    revokedAt: string | null;
    /**
     * Sprint 8 — ephemeral tokens: set to ISO 8601 expiry when the
     * token is short-lived (perf scripts, scratch workspaces). When
     * present and in the past, the auth gate returns 401 token_expired
     * and the periodic sweeper drops the entry from the registry.
     * Bootstrap-equivalent app tokens (long-lived) leave this null.
     */
    expiresAt?: string | null;
    /**
     * Sprint 8 — marks a token issued with --admin (cross-workspace-write).
     * Persisted purely for operator visibility in `lore auth list`; the
     * effective scope set on `scopes` is still the authoritative gate.
     */
    admin?: boolean;
}

interface RegistryFile {
    version: 1;
    entries: Record<string, TokenRecord>;
}

const REGISTRY_VERSION = 1;
const REGISTRY_REL_PATH = path.join('auth', 'registry.json');
/** re-audit 2026-06-25 — touchLastUsed persists at most once per token per window. */
const LAST_USED_THROTTLE_MS = 60_000;

/* ─── On-disk registry IO ──────────────────────────────────────── */

function registryPath(): string {
    return loreHomePath(REGISTRY_REL_PATH);
}

function ensureRegistry(): RegistryFile {
    const p = registryPath();
    if (fs.existsSync(p)) {
        let parsed: RegistryFile | null = null;
        let badReason = '';
        try {
            parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as RegistryFile;
        } catch (err) {
            badReason = `unparseable (${(err as Error).constructor.name})`;
        }
        if (parsed && parsed.version === REGISTRY_VERSION && parsed.entries) return parsed;
        // L-037 + re-audit 2026-06-25 — a registry that is corrupt/unparseable
        // OR parseable-but-wrong-version/shape must NOT be silently overwritten
        // with an empty one (that destroys every issued token). The L-037 fix
        // only backed up the parse-ERROR case; a downgrade/version-bump that
        // leaves a valid-JSON-but-wrong-version file fell through to a silent
        // wipe. Back the bad file aside (recoverable) + loud signal in BOTH
        // cases before rebuilding.
        if (!badReason) {
            const v = (parsed as { version?: unknown } | null)?.version;
            badReason = parsed ? `wrong version/shape (version=${JSON.stringify(v)})` : 'empty/null';
        }
        try {
            fs.renameSync(p, `${p}.corrupt.${Date.now()}`);
        } catch { /* best-effort — if rename fails the rebuild still proceeds */ }
        console.error(`[Lore auth] unusable token registry at ${p} (${badReason}); renamed aside and rebuilding empty`);
    }
    const fresh: RegistryFile = { version: REGISTRY_VERSION, entries: {} };
    writeRegistry(fresh);
    return fresh;
}

function writeRegistry(reg: RegistryFile): void {
    const p = registryPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Atomic write-tmp-then-rename (mirrors config/workspaceRegistry.ts) so a
    // concurrent reader never observes a torn registry and a stale snapshot
    // can't clobber a just-persisted revocation: rename() is atomic on the
    // same filesystem. Tmp lives in the SAME dir as registry.json (auth/) so
    // renameSync never crosses filesystems (EXDEV).
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
    try { fs.chmodSync(p, 0o600); } catch { /* best-effort */ }
}

function sleepSync(ms: number): void {
    // Sync sleep without a busy-spin (the mutations are sync). SharedArrayBuffer
    // + Atomics.wait is available on Node 20; fall back to a no-op if absent.
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
    catch { /* unavailable — proceed without the wait */ }
}

/**
 * RA2-reaudit2 — inter-process lock around a registry read→modify→write. The
 * daemon AND the `lore token` CLI both mutate registry.json from separate
 * processes; without serialization a stale in-memory snapshot clobbers a
 * concurrent change — a just-issued token is silently dropped, or (worse) a
 * just-revoked token is RESURRECTED. writeRegistry's atomic rename only prevents
 * torn READS, never lost UPDATES.
 *
 * Sync + best-effort: bounded wait, steals a stale lock (crashed holder), and
 * proceeds WITHOUT the lock past the deadline so a wedged lock can never
 * deadlock token issuance/auth. Reads (lookup/resolve/list) stay lock-free —
 * the atomic rename already gives them a clean snapshot.
 */
function withRegistryLock<T>(fn: () => T): T {
    const lockPath = registryPath() + '.lock';
    const STALE_MS = 10_000;
    const deadline = Date.now() + 2_000;
    for (;;) {
        try {
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            fs.closeSync(fs.openSync(lockPath, 'wx', 0o600)); // O_EXCL — EEXIST if held
            break;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            let ageMs = 0;
            try { ageMs = Date.now() - fs.statSync(lockPath).mtimeMs; }
            catch { continue; } // lock vanished between open + stat → retry acquire
            if (ageMs > STALE_MS) { try { fs.unlinkSync(lockPath); } catch { /* raced */ } continue; }
            if (Date.now() > deadline) {
                console.error('[Lore auth] registry lock wait timed out; proceeding without lock (best-effort)');
                return fn();
            }
            sleepSync(20);
        }
    }
    try { return fn(); }
    finally { try { fs.unlinkSync(lockPath); } catch { /* best-effort */ } }
}

function sha256Hex(plaintext: string): string {
    return crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/* ─── Token format ─────────────────────────────────────────────── */

const TOKEN_PREFIX = 'lore_';
const TOKEN_SECRET_BYTES = 32;
/** Workspace slug regex — same alphabet as kebabCase output. */
const WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Bound to TOKEN_PREFIX + slug + '_' + 43 base64url chars (32 bytes). */
const TOKEN_RE = /^lore_([a-z0-9][a-z0-9-]{0,39})_([A-Za-z0-9_-]{43})$/;

export function isPlausibleToken(plaintext: string): boolean {
    return TOKEN_RE.test(plaintext);
}

/** Extract the workspace prefix from a well-formed token. */
export function tokenWorkspacePrefix(plaintext: string): string | null {
    const m = TOKEN_RE.exec(plaintext);
    return m ? m[1]! : null;
}

function mintTokenPlaintext(workspace: string): string {
    if (!WORKSPACE_SLUG_RE.test(workspace)) {
        throw new Error(`invalid workspace slug "${workspace}" — expected [a-z0-9][a-z0-9-]{0,39}`);
    }
    // 32 random bytes encoded with URL-safe base64 (no padding) yields
    // a 43-char suffix that survives shell + URL + config files.
    const random = crypto.randomBytes(TOKEN_SECRET_BYTES).toString('base64url');
    return `${TOKEN_PREFIX}${workspace}_${random}`;
}

/* ─── Public API ───────────────────────────────────────────────── */

export interface IssueOptions {
    workspace: string;
    label: string;
    scopes: TokenScope[];
    /**
     * Sprint 8 — when set (ms in the future from now), persist
     * `expiresAt` on the record. Past values are rejected.
     */
    ttlMs?: number;
    /** Sprint 8 — annotate the record as operator-recovery (--admin). */
    admin?: boolean;
}

export interface IssueResult {
    /** The plaintext — caller MUST surface this once; the daemon never stores it. */
    token: string;
    record: TokenRecord;
}

/**
 * Mint a new token bound to `workspace` with `scopes`. Returns the
 * plaintext (display once) plus the persisted registry record. The
 * caller is responsible for showing the plaintext to the operator
 * exactly once.
 */
export function issueToken(opts: IssueOptions): IssueResult {
    const dedupedScopes = Array.from(new Set(opts.scopes));
    for (const s of dedupedScopes) {
        if (!ALL_SCOPES.includes(s)) {
            throw new Error(`unknown scope "${s}" — expected one of ${ALL_SCOPES.join(', ')}`);
        }
    }
    if (!opts.label.trim()) throw new Error('issueToken: label is required');

    const plaintext = mintTokenPlaintext(opts.workspace);
    const hash = sha256Hex(plaintext);
    let expiresAt: string | null = null;
    if (typeof opts.ttlMs === 'number') {
        if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
            throw new Error(`issueToken: ttlMs must be a positive finite number (got ${opts.ttlMs})`);
        }
        expiresAt = new Date(Date.now() + opts.ttlMs).toISOString();
    }
    const record: TokenRecord = {
        hash,
        prefix: plaintext.slice(0, 12),
        workspace: opts.workspace,
        label: opts.label.trim(),
        scopes: dedupedScopes,
        issuedAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
        expiresAt,
        admin: opts.admin === true ? true : undefined,
    };
    withRegistryLock(() => {
        // RA2-reaudit2 — locked read→modify→write so a concurrent revoke/issue
        // from another process can't be clobbered by this stale snapshot.
        const reg = ensureRegistry();
        reg.entries[hash] = record;
        writeRegistry(reg);
    });
    return { token: plaintext, record };
}

/**
 * Look up the active record for `plaintext`. Returns null when the
 * token isn't well-formed, isn't in the registry, or has been revoked.
 * Constant-time on the hash equality (Node's hash compare is constant-
 * time per-byte; the wider lookup is map-by-hash so attacker can't
 * time-side-channel which token matched).
 */
export function lookupByPlaintext(plaintext: string): TokenRecord | null {
    if (!isPlausibleToken(plaintext)) return null;
    const hash = sha256Hex(plaintext);
    const reg = ensureRegistry();
    const record = reg.entries[hash];
    if (!record || record.revokedAt) return null;
    if (isExpired(record)) return null;
    return record;
}

/**
 * Sprint 8 — richer lookup that distinguishes "no such token" from
 * "expired token". Callers (the HTTP middleware) use this to return
 * a 401 `token_expired` instead of generic `auth required`.
 */
export type LookupOutcome =
    | { kind: 'ok'; record: TokenRecord }
    | { kind: 'missing' }
    | { kind: 'revoked'; record: TokenRecord }
    | { kind: 'expired'; record: TokenRecord };

export function resolveByPlaintext(plaintext: string): LookupOutcome {
    if (!isPlausibleToken(plaintext)) return { kind: 'missing' };
    const hash = sha256Hex(plaintext);
    const reg = ensureRegistry();
    const record = reg.entries[hash];
    if (!record) return { kind: 'missing' };
    if (record.revokedAt) return { kind: 'revoked', record };
    if (isExpired(record)) return { kind: 'expired', record };
    return { kind: 'ok', record };
}

/** True iff the record carries a non-null expiresAt that is in the past.
 *  A missing expiresAt means a non-expiring token (legitimate) → not expired.
 *  A PRESENT-but-unparseable expiresAt is corrupt and must FAIL CLOSED →
 *  treated as expired, so a garbled expiry can't make a token live forever
 *  (re-audit 2026-06-25, was `return false` here = fail-open). */
export function isExpired(record: TokenRecord, nowMs: number = Date.now()): boolean {
    if (!record.expiresAt) return false;
    const t = Date.parse(record.expiresAt);
    if (!Number.isFinite(t)) return true;
    return t <= nowMs;
}

/** Mark the token's lastUsedAt = now. No-op when the hash is unknown. */
export function touchLastUsed(plaintext: string): void {
    if (!isPlausibleToken(plaintext)) return;
    const hash = sha256Hex(plaintext);
    // Read the registry immediately before mutating — do NOT trust any earlier
    // snapshot. The read→recheck→mutate→atomic-write below is a tight synchronous
    // block with no awaits, so it cannot interleave with a concurrent revoke
    // within this process. The revoke-recheck AFTER the read ensures a token
    // revoked between auth-resolve and this touch is never resurrected, and
    // writeRegistry's atomic rename keeps the narrowed cross-process window from
    // producing a torn file. Even if a revoke lands between this read and the
    // rename, the next revoke is idempotent and lookupByPlaintext fail-closes on
    // the freshest read.
    const reg = ensureRegistry();
    const record = reg.entries[hash];
    if (!record || record.revokedAt || isExpired(record)) return;
    // re-audit 2026-06-25 (scalability) — this runs on EVERY authenticated
    // request and each call synchronously rewrites the whole registry
    // (read+serialize+writeFile+rename+chmod) just to refresh a coarse
    // observability stamp. Throttle: skip the write when lastUsedAt is already
    // within LAST_USED_THROTTLE_MS, so a token persists its stamp at most once
    // per window instead of once per request. (The fresh read above is kept so
    // a concurrent revoke is still honored.)
    const now = Date.now();
    const prev = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
    if (Number.isFinite(prev) && now - prev < LAST_USED_THROTTLE_MS) return;
    // RA2-reaudit2 — the throttle pre-check above is lock-free (this runs on the
    // auth hot path). Only the actual write takes the inter-process lock, with a
    // FRESH read so a revoke that landed since the pre-check is honored (never
    // resurrected by this stamp).
    withRegistryLock(() => {
        const fresh = ensureRegistry();
        const rec = fresh.entries[hash];
        if (!rec || rec.revokedAt || isExpired(rec)) return;
        rec.lastUsedAt = new Date(now).toISOString();
        writeRegistry(fresh);
    });
}

/**
 * Sprint 8 — drop every entry whose expiresAt is in the past. Returns
 * the count removed. Idempotent. Copy-on-cleanup pattern: builds a
 * fresh entries map and only rewrites the file when at least one
 * record is dropped, so in-flight `lookupByPlaintext` calls never
 * observe a torn registry.
 */
export function sweepExpiredTokens(nowMs: number = Date.now()): number {
    return withRegistryLock(() => {  // RA2-reaudit2 — locked read→modify→write
    const reg = ensureRegistry();
    let removed = 0;
    const kept: Record<string, TokenRecord> = {};
    for (const [hash, record] of Object.entries(reg.entries)) {
        if (isExpired(record, nowMs)) {
            removed += 1;
            continue;
        }
        kept[hash] = record;
    }
    if (removed > 0) {
        writeRegistry({ version: REGISTRY_VERSION, entries: kept });
    }
    return removed;
    });
}

/**
 * Sprint 8 — wire a periodic sweeper. Returns a stop() handle so the
 * daemon shutdown hook can clear the interval. Default cadence: 5 min.
 * No-ops in test mode (NODE_ENV=test) so unit suites stay deterministic.
 */
export interface TokenSweeperHandle {
    stop: () => void;
}

export function startTokenSweeper(opts: {
    intervalMs?: number;
    onSweep?: (removed: number) => void;
} = {}): TokenSweeperHandle {
    const intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
    if (process.env['NODE_ENV'] === 'test') {
        return { stop: () => undefined };
    }
    const handle = setInterval(() => {
        try {
            const n = sweepExpiredTokens();
            if (n > 0) {
                console.error(`[Lore auth] swept ${n} expired token(s)`);
                opts.onSweep?.(n);
            }
        } catch (err) {
            console.error(`[Lore auth] sweep failed (non-fatal): ${(err as Error).message}`);
        }
    }, intervalMs);
    // Avoid blocking event-loop shutdown if the daemon stops without
    // calling stop() (e.g. uncaught at boot).
    if (typeof handle.unref === 'function') handle.unref();
    return { stop: () => clearInterval(handle) };
}

export interface TokenListEntry {
    prefix: string;
    workspace: string;
    label: string;
    scopes: TokenScope[];
    issuedAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
    /** Sprint 8 — null/absent for long-lived tokens. */
    expiresAt?: string | null;
    /** Sprint 8 — true when minted with --admin. */
    admin?: boolean;
}

/**
 * List every registered token (active + revoked). Plaintext is never
 * returned — the registry doesn't have it.
 */
export function listTokens(): TokenListEntry[] {
    const reg = ensureRegistry();
    return Object.values(reg.entries)
        .map((r) => ({
            prefix: r.prefix,
            workspace: r.workspace,
            label: r.label,
            scopes: r.scopes,
            issuedAt: r.issuedAt,
            lastUsedAt: r.lastUsedAt,
            revokedAt: r.revokedAt,
            expiresAt: r.expiresAt ?? null,
            admin: r.admin === true ? true : undefined,
        }))
        .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
}

/**
 * Revoke every active token whose prefix matches the supplied prefix
 * (matched against `record.prefix`, NOT the operator's input — so
 * passing the first 8–12 chars of a token plaintext works). Returns
 * the count of records updated. Idempotent: revoking a revoked token
 * is a no-op for that entry but still counts other matches.
 */
export function revokeByPrefix(prefix: string): number {
    if (!prefix.trim()) return 0;
    return withRegistryLock(() => {  // RA2-reaudit2 — locked read→modify→write
    const reg = ensureRegistry();
    const now = new Date().toISOString();
    let n = 0;
    // re-audit 2026-06-25 (auth) — the old bidirectional match also matched
    // `prefix.startsWith(record.prefix)`, so passing a FULL token plaintext (or
    // any string longer than the stored prefix) revoked EVERY sibling token
    // sharing the workspace-derived prefix — a mass-revoke footgun. Now: a full
    // plaintext revokes exactly that one token (by hash); a short prefix does a
    // forward prefix match only.
    if (isPlausibleToken(prefix)) {
        const rec = reg.entries[sha256Hex(prefix)];
        if (rec && !rec.revokedAt) { rec.revokedAt = now; n = 1; }
    } else {
        for (const record of Object.values(reg.entries)) {
            if (record.revokedAt) continue;
            if (record.prefix.startsWith(prefix)) {
                record.revokedAt = now;
                n += 1;
            }
        }
    }
    if (n > 0) writeRegistry(reg);
    return n;
    });
}

/* ─── Testing / fixture helpers ────────────────────────────────── */

/** Drop all entries — only used by tests. Touches disk. */
export function _resetForTests(): void {
    writeRegistry({ version: REGISTRY_VERSION, entries: {} });
}

/** Direct registry path getter — useful for diagnostics + tests. */
export function getRegistryPath(): string {
    return registryPath();
}

/** Force re-initialization if the file was edited externally. */
export function reloadRegistry(): void {
    ensureRegistry();
}

/** Number of active (non-revoked) tokens — used by the bootstrap path. */
export function activeTokenCount(): number {
    const reg = ensureRegistry();
    return Object.values(reg.entries).filter((r) => !r.revokedAt).length;
}

/** Reference to loreHome() for callers that want the parent dir. */
export function authHomeDir(): string {
    return path.join(loreHome(), 'auth');
}
