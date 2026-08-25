/**
 * policy.ts — Config-driven policy resolution for `lore maintain`.
 *
 * The maintain capability is driven entirely by config: there are NO
 * hardcoded thresholds in the operations themselves. This module is the
 * single place that turns (defaults → env → caller overrides) into a
 * fully-resolved `MaintainPolicy`. Everything downstream consumes the
 * resolved object and never reads `process.env` again.
 *
 * Precedence (lowest → highest):
 *   1. DEFAULTS (below)
 *   2. environment variables (LORE_MAINTAIN_*)
 *   3. explicit overrides passed by the caller (CLI flags / MCP args)
 *
 * Defaults (from the capacity-management spec):
 *   retention_days                 90
 *   cleanup_versions_older_than    7d
 *   compact_fragment_threshold     200
 *   ephemeral_workspace_ttl_days   14
 *   ephemeral_workspace_patterns   e2e-*,*-smoke,*-test
 *   protect_tags                   pinned,protected
 *   per-operation enable flags     all on
 *   node retention action          archive (non-destructive)
 */

/** A single maintenance operation that can be independently toggled. */
export type MaintainOperation =
    | 'compaction'
    | 'versionCleanup'
    | 'nodeRetention'
    | 'ephemeralExpiry';

export type NodeRetentionAction = 'archive' | 'delete';

/**
 * Which recency clock decides "cold" for node retention:
 *   'retrieval' — last_retrieved_at (intentional recall/search/get_full).
 *                 DEFAULT: browsing the graph never saves a node from
 *                 cleanup; only deliberate retrieval keeps it warm. This is
 *                 the only signal that reliably reclaims space.
 *   'access'    — lastAccessedAt (ANY read, incl. graph-view loads). Warmer.
 *   'update'    — updatedAt (legacy proxy; pre-access-tracking behavior).
 * All three fall back to updatedAt → createdAt when the chosen field is empty
 * (e.g. nodes never read since the access columns shipped).
 */
export type ColdSignal = 'retrieval' | 'access' | 'update';

export interface MaintainPolicy {
    /** Nodes whose recency timestamp is older than this are retention candidates. */
    retentionDays: number;
    /** LanceDB versions older than this many milliseconds are eligible for cleanup. */
    cleanupVersionsOlderThanMs: number;
    /** Compact a table only when its fragment count reaches this threshold. */
    compactFragmentThreshold: number;
    /** Ephemeral workspaces older than this many days are eligible for expiry. */
    ephemeralWorkspaceTtlDays: number;
    /** Glob-ish patterns identifying ephemeral workspaces (e.g. `e2e-*`). */
    ephemeralWorkspacePatterns: string[];
    /** Nodes carrying ANY of these tags are never archived or deleted. */
    protectTags: string[];
    /** Whether cold retention candidates are archived or hard-deleted. */
    nodeRetentionAction: NodeRetentionAction;
    /** Which recency clock decides coldness (default 'retrieval'). */
    coldSignal: ColdSignal;
    /** Per-operation enable flags. */
    enabled: Record<MaintainOperation, boolean>;
}

export const MAINTAIN_DEFAULTS: MaintainPolicy = {
    retentionDays: 90,
    cleanupVersionsOlderThanMs: 7 * 24 * 60 * 60 * 1000,
    compactFragmentThreshold: 200,
    ephemeralWorkspaceTtlDays: 14,
    ephemeralWorkspacePatterns: ['e2e-*', '*-smoke', '*-test'],
    protectTags: ['pinned', 'protected'],
    nodeRetentionAction: 'archive',
    coldSignal: 'retrieval',
    enabled: {
        compaction: true,
        versionCleanup: true,
        nodeRetention: true,
        ephemeralExpiry: true,
    },
};

/** Caller-supplied overrides — every field optional; undefined = "don't override". */
export interface MaintainPolicyOverrides {
    retentionDays?: number;
    cleanupVersionsOlderThanMs?: number;
    compactFragmentThreshold?: number;
    ephemeralWorkspaceTtlDays?: number;
    ephemeralWorkspacePatterns?: string[];
    protectTags?: string[];
    nodeRetentionAction?: NodeRetentionAction;
    coldSignal?: ColdSignal;
    enabled?: Partial<Record<MaintainOperation, boolean>>;
}

/**
 * parseDuration — Turn a human duration into milliseconds.
 *
 * Accepts an integer suffixed with `d` (days), `h` (hours), `m`
 * (minutes), or `s` (seconds). A bare integer is interpreted as DAYS
 * (the most common knob in this domain). Throws on anything else so a
 * typo never silently resolves to 0ms (which would purge everything).
 */
export function parseDuration(raw: string): number {
    const s = raw.trim().toLowerCase();
    const m = /^(\d+)\s*(d|h|m|s)?$/.exec(s);
    if (!m) throw new Error(`Invalid duration "${raw}" (expected e.g. 7d, 168h, 30m, 604800s)`);
    const n = Number(m[1]);
    const unit = m[2] ?? 'd';
    const factor = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000;
    return n * factor;
}

/** Split a comma/space separated list into trimmed non-empty tokens. */
export function parseList(raw: string): string[] {
    return raw
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
}

function envNum(name: string): number | undefined {
    const v = process.env[name];
    if (v === undefined || v.trim() === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${name}="${v}" is not a number`);
    return n;
}

function envBool(name: string): boolean | undefined {
    const v = process.env[name];
    if (v === undefined || v.trim() === '') return undefined;
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(s)) return true;
    if (['0', 'false', 'off', 'no'].includes(s)) return false;
    throw new Error(`${name}="${v}" is not a boolean`);
}

/** Read the env layer into an overrides object (no defaults applied here). */
function readEnvOverrides(): MaintainPolicyOverrides {
    const out: MaintainPolicyOverrides = {};
    const rd = envNum('LORE_MAINTAIN_RETENTION_DAYS');
    if (rd !== undefined) out.retentionDays = rd;

    const cv = process.env['LORE_MAINTAIN_CLEANUP_VERSIONS_OLDER_THAN'];
    if (cv && cv.trim() !== '') out.cleanupVersionsOlderThanMs = parseDuration(cv);

    const cft = envNum('LORE_MAINTAIN_COMPACT_FRAGMENT_THRESHOLD');
    if (cft !== undefined) out.compactFragmentThreshold = cft;

    const ttl = envNum('LORE_MAINTAIN_EPHEMERAL_TTL_DAYS');
    if (ttl !== undefined) out.ephemeralWorkspaceTtlDays = ttl;

    const pats = process.env['LORE_MAINTAIN_EPHEMERAL_PATTERNS'];
    if (pats && pats.trim() !== '') out.ephemeralWorkspacePatterns = parseList(pats);

    const tags = process.env['LORE_MAINTAIN_PROTECT_TAGS'];
    if (tags && tags.trim() !== '') out.protectTags = parseList(tags);

    const action = process.env['LORE_MAINTAIN_NODE_ACTION'];
    if (action && action.trim() !== '') {
        const a = action.trim().toLowerCase();
        if (a !== 'archive' && a !== 'delete') throw new Error(`LORE_MAINTAIN_NODE_ACTION="${action}" (expected archive|delete)`);
        out.nodeRetentionAction = a;
    }

    const cold = process.env['LORE_MAINTAIN_COLD_SIGNAL'];
    if (cold && cold.trim() !== '') {
        const c = cold.trim().toLowerCase();
        if (c !== 'retrieval' && c !== 'access' && c !== 'update') throw new Error(`LORE_MAINTAIN_COLD_SIGNAL="${cold}" (expected retrieval|access|update)`);
        out.coldSignal = c;
    }

    const enabled: Partial<Record<MaintainOperation, boolean>> = {};
    const c = envBool('LORE_MAINTAIN_COMPACTION'); if (c !== undefined) enabled.compaction = c;
    const v = envBool('LORE_MAINTAIN_VERSION_CLEANUP'); if (v !== undefined) enabled.versionCleanup = v;
    const n = envBool('LORE_MAINTAIN_NODE_RETENTION'); if (n !== undefined) enabled.nodeRetention = n;
    const e = envBool('LORE_MAINTAIN_EPHEMERAL_EXPIRY'); if (e !== undefined) enabled.ephemeralExpiry = e;
    if (Object.keys(enabled).length > 0) out.enabled = enabled;

    return out;
}

function validate(p: MaintainPolicy): void {
    if (!(p.retentionDays >= 0)) throw new Error(`retentionDays must be >= 0 (got ${p.retentionDays})`);
    if (!(p.cleanupVersionsOlderThanMs >= 0)) throw new Error(`cleanupVersionsOlderThanMs must be >= 0`);
    if (!(p.compactFragmentThreshold >= 1)) throw new Error(`compactFragmentThreshold must be >= 1 (got ${p.compactFragmentThreshold})`);
    if (!(p.ephemeralWorkspaceTtlDays >= 0)) throw new Error(`ephemeralWorkspaceTtlDays must be >= 0`);
}

/**
 * resolveMaintainPolicy — Build the effective policy from defaults, env,
 * and explicit overrides. `opts.skipEnv` resolves from defaults + overrides
 * only (used by tests that don't want ambient env leaking in).
 */
export function resolveMaintainPolicy(
    overrides: MaintainPolicyOverrides = {},
    opts: { skipEnv?: boolean } = {},
): MaintainPolicy {
    const env = opts.skipEnv ? {} : readEnvOverrides();
    // Layer order: defaults < env < explicit overrides.
    const merged: MaintainPolicy = {
        ...MAINTAIN_DEFAULTS,
        ...stripUndefined(env),
        ...stripUndefined(overrides),
        enabled: {
            ...MAINTAIN_DEFAULTS.enabled,
            ...(env.enabled ?? {}),
            ...(overrides.enabled ?? {}),
        },
    };
    validate(merged);
    return merged;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
    const out: Partial<T> = {};
    for (const k of Object.keys(o) as (keyof T)[]) {
        if (o[k] !== undefined && k !== ('enabled' as keyof T)) out[k] = o[k];
    }
    return out;
}
