/**
 * versionPolicy.ts — no-op detection + per-type history policy for
 * `node_versions` (storage-growth fix 1/3, R1 + R2).
 *
 * ## R1 — why every upsert produced a version row
 *
 * `providers/types.ts`'s `GraphProvider.upsertNode` signature is
 * `Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>` — the provider
 * itself stamps those three fields on every write, so they differ on
 * literally every upsert regardless of whether the caller changed anything
 * real. `core/nodeService.ts` step 5 recorded a version unconditionally, so
 * those three guaranteed-to-differ fields alone were enough to write a new
 * row every time. Measured on Atlas's live store: one `code-symbol` node had
 * 131 version rows but only 4 distinct contents once they're ignored.
 *
 * `lastAccessedAt` / `last_retrieved_at` are the other bookkeeping fields
 * flagged in `LoreNode`'s own doc comment ("Access-time coldness signal…
 * null = never recorded") — read-path telemetry, not upsert-caller intent.
 * They are included in the ignore list defensively even though they are not
 * normally present in caller-supplied `nodeData`.
 *
 * ## R2 — per-type history policy
 *
 * `skipTypes`, `retentionDaysByType` and the opt-in `pruning` switch are
 * validated and carried here. Age-based deletion is OFF unless
 * `pruning.enabled` (see `versionPruningPolicy.ts` for resolution).
 *
 * ## Correctness fix (2026-09-28, PR #157 review): omitted fields are not
 * ## all "provably unchanged"
 *
 * The first version of `isNoOpVersion` treated ANY key present in
 * `previousState` but absent from `newState` as untouched by the write,
 * citing SQLite's prior-value fallback. That is false on Surreal
 * (`DEFAULT_GRAPH_ENGINE`, the engine Atlas runs): its write layer
 * (`engines/surreal/surrealGraphWrites.ts` `toNodeDocument()`) writes
 * `type`/`label`/`project`/`ecosystem`/`metadata` straight from the caller
 * value with no fallback, and BOTH local engines write `tags` the same way —
 * omitting one of these six fields on an upsert CLEARS the stored value,
 * even though the no-op check said "unchanged". See
 * `FIELDS_CLEARED_ON_OMISSION` and `isNoOpVersion`'s doc comment below for
 * the full per-field audit and the fix.
 */

/**
 * Fields stamped or mutated by the storage layer itself rather than
 * reflecting caller intent. Ignored (top-level only) when deciding whether
 * a version is a no-op. See file header for the per-field justification.
 */
export const DEFAULT_IGNORED_VERSION_FIELDS: readonly string[] = [
    'createdAt',
    'updatedAt',
    'syncedAt',
    'lastAccessedAt',
    'last_retrieved_at',
];

/**
 * Opt-in age-based deletion of version history (owner decision 2026-09-29).
 * Absent, or `enabled: false`, means version rows are NEVER deleted by age
 * (and existing rows of a `skipTypes` type are never deleted either) — this
 * is the default for every host, embedded or daemon.
 */
export interface VersionPruningPolicy {
    /** Master switch. Nothing below has any effect unless this is `true`. */
    enabled: boolean;
    /** Retention window in days when enabled. Default 2557 (7 years). */
    retentionDays?: number;
}

/** Per-type version-history policy — `createLore({ versionHistory })`. */
export interface VersionHistoryPolicy {
    /** Node types for which no version row is ever recorded. Rows of these
     *  types that already exist are deleted ONLY when `pruning.enabled`. */
    skipTypes?: string[];
    /**
     * Retention window (days) per node type, overriding `pruning.retentionDays`
     * for that type. Applies ONLY when `pruning.enabled` is true; ignored
     * otherwise. See `VersionStore.setHistoryPolicy`.
     */
    retentionDaysByType?: Record<string, number>;
    /** Opt-in age-based deletion. Absent = keep history forever. */
    pruning?: VersionPruningPolicy;
}

/** Throws on malformed input. Absent policy is always valid (no-op). */
export function validateVersionHistoryPolicy(policy: VersionHistoryPolicy | undefined): void {
    if (policy == null) return;
    if (policy.skipTypes !== undefined) {
        if (!Array.isArray(policy.skipTypes) || !policy.skipTypes.every((t) => typeof t === 'string' && t.length > 0)) {
            throw new Error('versionHistory.skipTypes must be an array of non-empty strings');
        }
    }
    if (policy.pruning !== undefined) {
        const pr = policy.pruning;
        if (typeof pr !== 'object' || pr === null || Array.isArray(pr) || typeof pr.enabled !== 'boolean') {
            throw new Error('versionHistory.pruning must be an object with a boolean `enabled`');
        }
        if (pr.retentionDays !== undefined && (typeof pr.retentionDays !== 'number' || !Number.isFinite(pr.retentionDays) || pr.retentionDays <= 0)) {
            throw new Error('versionHistory.pruning.retentionDays must be a positive finite number of days');
        }
    }
    if (policy.retentionDaysByType !== undefined) {
        if (typeof policy.retentionDaysByType !== 'object' || policy.retentionDaysByType === null || Array.isArray(policy.retentionDaysByType)) {
            throw new Error('versionHistory.retentionDaysByType must be an object mapping node type -> days');
        }
        for (const [type, days] of Object.entries(policy.retentionDaysByType)) {
            if (!type) throw new Error('versionHistory.retentionDaysByType keys must be non-empty node type strings');
            if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
                throw new Error(`versionHistory.retentionDaysByType['${type}'] must be a positive finite number of days`);
            }
        }
    }
}

/**
 * Recursively sort object keys so two values that differ only in key order
 * compare equal via JSON.stringify. Arrays keep their order (order is
 * semantically meaningful there); only plain-object key order is normalized.
 */
export function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === 'object') {
        const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
        const out: Record<string, unknown> = {};
        for (const key of sortedKeys) {
            out[key] = canonicalize((value as Record<string, unknown>)[key]);
        }
        return out;
    }
    return value;
}

/**
 * True when `newState` is identical to `previousState` once the ignored
 * (volatile/bookkeeping) top-level fields are stripped and the remainder is
 * compared canonically (key order independent).
 *
 * Callers must treat a missing/null `previousState` as "always record" —
 * this function is not asked to make that call; it assumes both states are
 * present objects.
 *
 * ## Asymmetric shapes: only `newState`'s keys are compared — EXCEPT the
 * ## fields that a write layer clears on omission (corrected 2026-09-28)
 *
 * `previousState` (from a `getNode()` pre-read) is a full DB row — every
 * schema field, including ones the caller never mentioned. `newState` (the
 * `GraphProvider.upsertNode()` return value the caller receives back) is
 * only an echo of the fields the caller actually supplied, plus the three
 * stamped fields already in `ignoreFields`. For MOST fields, a key present
 * in `previousState` but absent from `newState` really was never touched by
 * this write: the SQLite write layer (`engines/sqlite/sqliteGraphRow.ts`
 * `toNodeRow()`) resolves most omitted fields as
 * `node.field ?? priorStr('field') ?? default`, reading the pre-fetched
 * existing row — so for those fields an omitted key's persisted value is
 * provably unchanged. Comparing the full key set of `previousState` against
 * `newState`'s partial echo would treat every such untouched bookkeeping
 * field (status, counters, …) as a spurious "difference" on literally every
 * upsert, which is exactly the bug this function exists to avoid. So the
 * diff is keyed off `newState`'s own (post-ignore-list) keys only, for
 * fields where that fallback genuinely holds.
 *
 * ## Correction: this is FALSE for `FIELDS_CLEARED_ON_OMISSION`
 *
 * The original version of this comment claimed the prior-value fallback
 * holds for EVERY omitted field, on the strength of the SQLite write layer
 * alone. That is wrong on two counts, found auditing both local write
 * layers field-by-field (`engines/surreal/surrealGraphWrites.ts`
 * `toNodeDocument()`, `engines/sqlite/sqliteGraphRow.ts` `toNodeRow()`):
 *
 *   - **Surreal** (`DEFAULT_GRAPH_ENGINE`, the engine Atlas runs) writes
 *     `type`, `label`, `project`, `ecosystem` and `metadata` straight from
 *     `node.*` with NO prior-value fallback (`surrealGraphWrites.ts`
 *     ~98-110) — omitting any of them clears the stored value.
 *   - **Both** local engines write `tags` with no fallback —
 *     `tagsToArray(node.tags)` on Surreal, `JSON.stringify(tagsToArray(
 *     node.tags))` on SQLite — so an omitted `tags` field clears to `[]` on
 *     either engine (`surrealGraphWrites.ts` ~107, `sqliteGraphRow.ts`
 *     ~104).
 *
 * (SQLite's `toNodeRow` DOES fall back to the prior value for `type`,
 * `label`, `project`, `ecosystem` and `metadata` — only `tags` is unsafe
 * there. But `isNoOpVersion` has no engine context to know which backend
 * produced `newState`, and the record-conservatively rule — "when in doubt,
 * record" — means it cannot assume the safer engine.)
 *
 * `FIELDS_CLEARED_ON_OMISSION` lists exactly these fields. `isNoOpVersion`
 * treats an omission of one of them as a real change whenever
 * `previousState` held a non-empty value for it (see
 * `isFieldOmissionEmpty` for the per-field empty sentinel, matching
 * `loreNodeRow.ts`'s `rowToLoreNode` defaults) — never silently skipping a
 * write that would actually clear stored content.
 */
export const FIELDS_CLEARED_ON_OMISSION: readonly string[] = [
    'type',
    'label',
    'tags',
    'project',
    'ecosystem',
    'metadata',
];

/**
 * True when `value` is field `field`'s "nothing here" sentinel, matching
 * `loreNodeRow.ts`'s `rowToLoreNode` defaults — the shape `previousState`
 * arrives in (a `getNode()` result, i.e. a full `LoreNode`):
 *   - `tags` defaults to `[]`.
 *   - `project` / `ecosystem` default to `'*'` (the "no project/ecosystem"
 *     sentinel — see `rowToLoreNode`).
 *   - `metadata` defaults to `'{}'`, stored/returned as a JSON STRING, never
 *     parsed to an object (`loreNodeRow.ts` ~108) — but an object form is
 *     also accepted defensively, in case a caller passes one directly.
 *   - `type` / `label` default to `''`.
 *   - `null`/`undefined` are always empty, regardless of field.
 * Used only so that omitting an already-empty field never triggers a
 * spurious record — e.g. omitting `tags` on a node that never had any tags
 * is still a true no-op.
 */
export function isFieldOmissionEmpty(field: string, value: unknown): boolean {
    if (value === null || value === undefined) return true;
    switch (field) {
        case 'tags':
            return Array.isArray(value) && value.length === 0;
        case 'metadata':
            if (typeof value === 'string') return value === '' || value === '{}';
            if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
            return false;
        case 'project':
        case 'ecosystem':
            return value === '' || value === '*';
        case 'type':
        case 'label':
        default:
            return value === '';
    }
}

export function isNoOpVersion(
    previousState: unknown,
    newState: unknown,
    ignoreFields: readonly string[] = DEFAULT_IGNORED_VERSION_FIELDS,
): boolean {
    if (previousState === newState) return true;
    if (
        previousState === null || typeof previousState !== 'object' ||
        newState === null || typeof newState !== 'object'
    ) {
        return false;
    }
    const prevObj = previousState as Record<string, unknown>;
    const newObj = newState as Record<string, unknown>;
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = {};
    for (const key of Object.keys(newObj)) {
        if (ignoreFields.includes(key)) continue;
        a[key] = prevObj[key];
        b[key] = newObj[key];
    }
    // A key `newState` doesn't mention at all is usually safe to exclude
    // (see the file/class doc comments above) — EXCEPT for
    // `FIELDS_CLEARED_ON_OMISSION`, where at least one local write layer
    // clears the stored value on omission instead of preserving it. When
    // `newState` omits one of those fields and `previousState` held a
    // genuinely non-empty value for it, that omission IS a real change —
    // record rather than silently skip.
    for (const field of FIELDS_CLEARED_ON_OMISSION) {
        if (ignoreFields.includes(field)) continue;
        if (field in newObj) continue; // already compared above
        if (!isFieldOmissionEmpty(field, prevObj[field])) return false;
    }
    return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/**
 * The single gate `nodeService.ts` step 5 calls before recording a version.
 *
 * - `skipTypes` wins outright (type-level opt-out, independent of content).
 * - Missing/null `previousState` ALWAYS records — never skip on missing
 *   data (new node, or a caller that didn't pre-read).
 * - Otherwise, record unless the states are a no-op under `isNoOpVersion`.
 */
/**
 * Daemon/MCP-mode exposure (R2's "expose it for daemon/MCP mode only if
 * trivial via existing config"). The daemon boots via
 * `createLore({ ownsProcess: true })` with no per-call options surface for
 * an operator — env vars are the existing config channel for that mode
 * (mirrors `resolveHostSupersessionDefault`'s `LORE_SUPERSESSION_ENFORCE`
 * pattern in core/supersessionPolicy.ts). `LORE_VERSION_SKIP_TYPES` is a
 * comma-separated list of node types; it only fills `skipTypes` when the
 * `createLore()` caller didn't already set it explicitly (explicit option >
 * env > unset), so an embedding host's own configuration always wins.
 * `retentionDaysByType` has no env equivalent — it is a per-type map, not a
 * scalar, and doesn't fit a single env var without inventing a serialization
 * format; left as a `createLore()`-only option.
 */
export function resolveVersionHistoryPolicy(createLoreOption?: VersionHistoryPolicy): VersionHistoryPolicy | undefined {
    if (createLoreOption?.skipTypes !== undefined) return createLoreOption;
    const raw = process.env['LORE_VERSION_SKIP_TYPES'];
    if (!raw) return createLoreOption;
    const skipTypes = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (skipTypes.length === 0) return createLoreOption;
    return { ...createLoreOption, skipTypes };
}

export function shouldRecordVersion(
    nodeType: string | undefined,
    previousState: unknown,
    newState: unknown,
    policy?: VersionHistoryPolicy,
    ignoreFields: readonly string[] = DEFAULT_IGNORED_VERSION_FIELDS,
): boolean {
    if (nodeType !== undefined && policy?.skipTypes?.includes(nodeType)) return false;
    if (previousState === null || previousState === undefined) return true;
    return !isNoOpVersion(previousState, newState, ignoreFields);
}
