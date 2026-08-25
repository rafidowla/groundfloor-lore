/**
 * selection.ts — Pure selection logic for `lore maintain`.
 *
 * These functions decide WHAT a maintenance run would touch. They are
 * deliberately side-effect-free and clock-injected so they can be unit
 * tested exhaustively without a graph, a vector store, or a filesystem.
 * The orchestrator (maintain.ts) calls these, then applies the results
 * through the real ports.
 */

import type { MaintainPolicy, ColdSignal } from './policy.js';

/** Convert a single glob token (only `*` wildcard) to a RegExp. */
function globToRegExp(glob: string): RegExp {
    const escaped = glob
        .split('*')
        .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
    return new RegExp(`^${escaped}$`, 'i');
}

/** True when `name` matches ANY of the `*`-glob patterns (case-insensitive). */
export function matchesAnyPattern(name: string, patterns: string[]): boolean {
    return patterns.some((p) => globToRegExp(p).test(name));
}

/**
 * Parse a node's `tags` field (stored as a comma/space joined string)
 * into a lowercased set. Tolerant of JSON-array strings too, since some
 * older writers stored tags as `["a","b"]`.
 */
export function parseTags(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return [];
    if (s.startsWith('[')) {
        try {
            const arr = JSON.parse(s);
            if (Array.isArray(arr)) return arr.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
        } catch { /* fall through to delimiter split */ }
    }
    return s.split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/** A node has protection if it carries any protect_tag, or is explicitly held. */
export function isProtected(node: NodeForSelection, protectTags: string[]): boolean {
    if (node.legalHold === true) return true;
    if (node.status === 'protected') return true;
    const tags = parseTags(node.tags);
    const protectSet = new Set(protectTags.map((t) => t.trim().toLowerCase()).filter(Boolean));
    return tags.some((t) => protectSet.has(t));
}

/** The minimal node shape the selection logic needs. */
export interface NodeForSelection {
    id: string;
    tags?: unknown;
    status?: string | null;
    legalHold?: boolean | null;
    updatedAt?: string | null;
    createdAt?: string | null;
    /** Most recent read of any kind (access cold_signal). */
    lastAccessedAt?: string | null;
    /** Most recent intentional retrieval (default cold_signal). */
    last_retrieved_at?: string | null;
}

export interface RetentionSelection {
    /** Cold + unprotected + older than cutoff — eligible for the configured action. */
    candidates: NodeForSelection[];
    /** Skipped because protected (tag / status / legal-hold). */
    protectedCount: number;
    /** Skipped because recent (within retentionDays). */
    recentCount: number;
    /** Total nodes inspected. */
    inspected: number;
}

/**
 * Best-effort recency for the chosen cold signal, in epoch ms. The signal's
 * field is preferred; an empty/missing value falls back to updatedAt →
 * createdAt (so nodes never read since the access columns shipped use the
 * legacy proxy rather than being misclassified as epoch-0 cold). Invalid
 * timestamps sort as "very old".
 */
function recencyMs(node: NodeForSelection, signal: ColdSignal): number {
    const primary =
        signal === 'retrieval' ? node.last_retrieved_at :
        signal === 'access' ? node.lastAccessedAt :
        node.updatedAt;
    const raw = primary || node.updatedAt || node.createdAt || '';
    const t = raw ? Date.parse(raw) : NaN;
    return Number.isFinite(t) ? t : 0;
}

/**
 * selectRetentionCandidates — Cold-and-unprotected node selection.
 *
 * A node is a candidate when ALL hold:
 *   - it is NOT protected (protect_tags / status:protected / legalHold)
 *   - its recency timestamp is older than `now - retentionDays`
 *
 * "Cold" is decided by `policy.coldSignal` (default 'retrieval' =
 * last_retrieved_at), falling back to updatedAt when the chosen signal is
 * empty. Protection is checked BEFORE recency so a protected node is never
 * counted as a recency skip.
 */
export function selectRetentionCandidates(
    nodes: NodeForSelection[],
    policy: MaintainPolicy,
    now: number,
): RetentionSelection {
    const cutoff = now - policy.retentionDays * 86_400_000;
    const signal: ColdSignal = policy.coldSignal;
    const sel: RetentionSelection = { candidates: [], protectedCount: 0, recentCount: 0, inspected: 0 };
    for (const node of nodes) {
        sel.inspected++;
        if (isProtected(node, policy.protectTags)) {
            sel.protectedCount++;
            continue;
        }
        if (recencyMs(node, signal) >= cutoff) {
            sel.recentCount++;
            continue;
        }
        sel.candidates.push(node);
    }
    return sel;
}

/** The minimal workspace shape the ephemeral selection needs. */
export interface WorkspaceForSelection {
    name: string;
    path: string;
    createdAt: string;
}

export interface EphemeralSelection {
    candidates: WorkspaceForSelection[];
    /** Matched a pattern but is too young to expire. */
    tooYoungCount: number;
    inspected: number;
}

/**
 * selectEphemeralWorkspaces — Workspaces matching an ephemeral pattern
 * AND older than the TTL. The active workspace and the bootstrap/legacy
 * workspace (path === loreHome) are NEVER selected, regardless of name,
 * because deleting them would orphan the daemon.
 */
export function selectEphemeralWorkspaces(
    workspaces: WorkspaceForSelection[],
    policy: MaintainPolicy,
    now: number,
    guards: { activeName: string; bootstrapPath: string },
): EphemeralSelection {
    const cutoff = now - policy.ephemeralWorkspaceTtlDays * 86_400_000;
    const sel: EphemeralSelection = { candidates: [], tooYoungCount: 0, inspected: 0 };
    for (const ws of workspaces) {
        if (ws.name === guards.activeName) continue;
        if (ws.path === guards.bootstrapPath) continue;
        if (!matchesAnyPattern(ws.name, policy.ephemeralWorkspacePatterns)) continue;
        sel.inspected++;
        const created = Date.parse(ws.createdAt);
        const createdMs = Number.isFinite(created) ? created : 0;
        if (createdMs >= cutoff) {
            sel.tooYoungCount++;
            continue;
        }
        sel.candidates.push(ws);
    }
    return sel;
}
