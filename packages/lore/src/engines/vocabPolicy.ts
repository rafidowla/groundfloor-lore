/**
 * vocabPolicy.ts — Phase 6 P2 vocab-policy engine.
 *
 * Pure functions that decide what to do with a store_node write when:
 *   1. The request carries a field that isn't in the known schema
 *      ("unknown_field" — `additionalProperties: false` was a lie
 *      because the runtime silently dropped extras; this surfaces the
 *      bug to the caller).
 *   2. The node's type doesn't satisfy the workspace's vocabPolicy
 *      ("type_not_allowed" or routed to HITL / warning).
 *
 * Both checks are workspace-scoped at the call site. This module owns
 * only the decision; routing (HTTP 400 / 202 / 200+header, MCP error
 * envelope) lives in the call sites (HTTP route + MCP tool).
 *
 * No external state. Tests can call these directly with literal
 * arguments — no daemon, no Kùzu.
 */

import type { WorkspaceVocabPolicy } from '../config/workspaces.js';

/* ─── unknown-field check ───────────────────────────────────────── */

/**
 * The store_node tool's documented input fields. Strict-mode rejects
 * anything else with a "Did you mean" hint pointing at the closest
 * known field by Levenshtein distance.
 *
 * Kept in sync with the Zod schema in mcp/tools/memory.ts: any field
 * accepted by the tool MUST appear in this list, and vice versa.
 */
export const STORE_NODE_KNOWN_FIELDS: ReadonlyArray<string> = Object.freeze([
    'id',
    'type',
    'label',
    'content',
    'tags',
    'metadata',
    'workspace',
    'ecosystem',
    'language',
    'ephemeral',
    'ttl_ms',
    'async_embed',
    // W1 (Sprint W) — opt-out of embedding entirely. Default true =
    // current behavior (kuzu write + lancedb embed). `embed: false`
    // writes the graph row only; no lancedb row, no recall surface.
    // Distinct from `async_embed` which still writes (just later).
    'embed',
    // Feature 4 (2026-05-26) — evidence/provenance string. JSON or
    // free-text source attribution. Redactable via redact_evidence.
    'evidence',
    // Feature 6 (2026-05-26) — anchor references. JSON array of
    // {type, ref} objects representing external ground-truth references.
    'anchors',
    // Feature 8 (2026-05-26) — changeset id. When provided, the write is
    // buffered into the open changeset instead of applied immediately.
    'changeset_id',
    // Bi-temporal valid-time window — caller-supplied real-world truth-time
    // (distinct from createdAt/updatedAt). See LoreNode.validFrom in
    // providers/types.ts. Core never sets these; it only stores/filters them.
    'validFrom',
    'validUntil',
]);

// store_edge / recall strict-field arrays land in a follow-up slice
// once their tool surfaces opt in. P2 ships strict only for store_node.

export interface UnknownFieldsResult {
    /** True when the caller's payload has no surprise keys. */
    ok: boolean;
    /** Names of the rejected fields, in caller-input order. */
    rejected: string[];
    /**
     * For the first rejected field, the closest known field by edit
     * distance (or null when nothing is within reasonable similarity).
     * The classic "project → workspace" case lands here.
     */
    hint: string | null;
}

/**
 * Strict additionalProperties:false check. Returns the verdict + the
 * "Did you mean" hint so callers can build a single error envelope.
 *
 * Implementation note: callers pass `input` as a JSON-decoded object.
 * `null`, arrays, and non-objects short-circuit with `ok: true` —
 * upstream validation is responsible for shape rejection.
 */
export function checkUnknownFields(
    input: unknown,
    known: ReadonlyArray<string>,
): UnknownFieldsResult {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { ok: true, rejected: [], hint: null };
    }
    const knownSet = new Set(known);
    const rejected: string[] = [];
    for (const k of Object.keys(input as Record<string, unknown>)) {
        if (!knownSet.has(k)) rejected.push(k);
    }
    if (rejected.length === 0) return { ok: true, rejected: [], hint: null };
    const first = rejected[0]!;
    const hint = closestField(first, known);
    return { ok: false, rejected, hint };
}

/** Plain Damerau-Levenshtein distance — small inputs, no dep. */
export function editDistance(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    // 2-row tabulation; classic.
    let prev: number[] = new Array(n + 1).fill(0).map((_, i) => i);
    let curr: number[] = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(
                curr[j - 1]! + 1,           // insertion
                prev[j]! + 1,               // deletion
                prev[j - 1]! + cost,        // substitution
            );
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n]!;
}

/**
 * Known-legacy field aliases. These exist because the field was renamed
 * (e.g. `project` → `workspace` in Phase 6 P1.A) and callers carrying
 * the old name should be pointed at the new one even though edit
 * distance won't find it. Edit-distance fallback handles plain typos
 * ("workspce", "tagss") that aren't in this map.
 */
const LEGACY_ALIASES: Record<string, string> = Object.freeze({
    project: 'workspace',
    proj: 'workspace',
    projects: 'workspace',
    ws: 'workspace',
    eco: 'ecosystem',
    tag: 'tags',
    meta: 'metadata',
    lang: 'language',
    relationship: 'relation',
});

/**
 * Pick the closest known field for the "Did you mean" hint.
 *
 * Priority:
 *   1. Explicit LEGACY_ALIASES match — surfaces renames the schema
 *      survived (e.g. `project` → `workspace`).
 *   2. Edit-distance fallback within 1/2 of the rejected field's
 *      length — catches plain typos. Falls back to null on weak
 *      matches so the error doesn't surface noise as a "suggestion".
 *
 * The alias is only surfaced when the new field is in the caller's
 * accepted vocabulary (`known`) — otherwise we'd point them at a
 * field this tool surface doesn't itself accept.
 */
export function closestField(rejected: string, known: ReadonlyArray<string>): string | null {
    const lower = rejected.toLowerCase();
    const aliased = LEGACY_ALIASES[lower];
    if (aliased && known.includes(aliased)) return aliased;

    let best: { field: string; dist: number } | null = null;
    for (const k of known) {
        const d = editDistance(lower, k.toLowerCase());
        if (best === null || d < best.dist) best = { field: k, dist: d };
    }
    if (!best) return null;
    const limit = Math.max(2, Math.floor(rejected.length / 2));
    return best.dist <= limit ? best.field : null;
}

/* ─── vocab-policy check ────────────────────────────────────────── */

export type VocabDecision = 'accept' | 'reject' | 'hitl' | 'warn';

export interface VocabCheckResult {
    decision: VocabDecision;
    /** Human-readable reason. Surface in error envelopes / warning headers. */
    reason?: string;
    /** Actionable hint for the caller (e.g. how to amend the workspace policy). */
    hint?: string;
}

export interface VocabCheckInput {
    /** Workspace's effective policy (`{mode:'open'}` for the default). */
    policy: WorkspaceVocabPolicy;
    /** The node's `type` field. */
    type: string;
    /** Types known to the runtime (the core node-type set). */
    coreTypes: ReadonlyArray<string>;
}

/**
 * Decide what to do with `type` for a workspace, using the
 * per-workspace vocabPolicy:
 *
 *   - mode='open'      → accept
 *   - mode='allowlist' → if type in types, accept; else onMismatch
 *   - mode='denylist'  → if type NOT in types, accept; else onMismatch
 *
 * Anything not in `coreTypes` is treated as out-of-vocabulary; the
 * policy's onMismatch decides. Empty allowlist/denylist degrades to
 * "everything is out" / "nothing is out" respectively.
 */
export function checkVocab(input: VocabCheckInput): VocabCheckResult {
    const { policy, type, coreTypes } = input;

    const inAllowDenyList = (policy.types ?? []).includes(type);
    const isKnownInRuntime = coreTypes.includes(type);

    switch (policy.mode) {
        case 'open':
            return { decision: 'accept' };
        case 'allowlist': {
            if (inAllowDenyList) return { decision: 'accept' };
            return policyMismatch(policy, type, isKnownInRuntime);
        }
        case 'denylist': {
            if (!inAllowDenyList) return { decision: 'accept' };
            return policyMismatch(policy, type, isKnownInRuntime);
        }
        default:
            return { decision: 'accept' };
    }
}

function policyMismatch(
    policy: WorkspaceVocabPolicy,
    type: string,
    isKnownInRuntime: boolean,
): VocabCheckResult {
    const tag = isKnownInRuntime ? 'type_not_allowed' : 'type_unknown';
    const reason =
        policy.mode === 'allowlist'
            ? `${tag}: type '${type}' is not in the workspace's allowlist (${(policy.types ?? []).join(', ') || 'empty'}).`
            : `${tag}: type '${type}' is in the workspace's denylist.`;
    switch (policy.onMismatch) {
        case 'reject':
            return { decision: 'reject', reason };
        case 'hitl':
            return { decision: 'hitl', reason };
        case 'warn':
            return { decision: 'warn', reason };
        default:
            return { decision: 'reject', reason };
    }
}
