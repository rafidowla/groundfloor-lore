/**
 * typeRetention.ts — W6a (Sprint W) per-type retention plan computation.
 *
 * Pure function. Given a workspace's `typePolicies` config + a list of
 * nodes-with-ages, returns the {toWarm, toDelete} sets that an
 * enforcement pass would act on. No I/O — caller decides whether to
 * dry-run (preview CLI) or apply (daily sweep wiring, deferred to
 * W6b).
 *
 * Scope: warm + delete only this slice. Cold tier (tarball archive)
 * lands in W6b alongside the archive CLI. Recall `includeTiers`
 * integration also W6b.
 *
 * Backward-compat: the existing WorkspaceRetentionPolicy continues to
 * carry hideSupersededInRecall / hideSupersededInGraph /
 * autoArchiveSupersededAfterDays for soft-supersession. This adds an
 * orthogonal `typePolicies` keyed by node `type`. Workspaces without
 * `typePolicies` see zero behavior change (the existing
 * RetentionSweeper continues to drive the supersession-side
 * cleanups).
 */

/**
 * Retention mode for one node type.
 *
 *   keep         — never expire (default; absence = keep).
 *   warm-after   — after `days` since updatedAt, move bytes (verbatim
 *                  + lancedb) to a gzipped JSONL warm-tier file; the
 *                  graph node + edges remain.
 *   delete-after — after `days`, hard-delete the node from every
 *                  store. Destructive; audited.
 *
 * Cold-after (tarball archive) is deliberately not in this enum
 * yet — it lands in W6b together with the archive CLI + restore
 * flow. Operators who want cold semantics today can layer the
 * existing `lore archive` infrastructure on top of `delete-after`.
 */
export type TypeRetentionMode = 'keep' | 'warm-after' | 'delete-after';

export interface TypeRetentionRule {
    mode: TypeRetentionMode;
    /** Required when mode is warm-after or delete-after. Days since
     *  the node's updatedAt before the action applies. */
    days?: number;
}

/** Per-type rules under a workspace's retention config. Map from node
 *  `type` string to its rule. Missing entries default to `keep`. */
export type TypePoliciesMap = Record<string, TypeRetentionRule>;

export interface RetentionCandidate {
    id: string;
    type: string;
    /** ISO 8601 string from the graph row. */
    updatedAt: string;
}

export interface RetentionPlan {
    toWarm: RetentionCandidate[];
    toDelete: RetentionCandidate[];
    /** Nodes that match a non-keep policy but are still inside the
     *  age window. Useful for the preview CLI to show "X candidates
     *  will be moved Y days from now". */
    pending: Array<RetentionCandidate & { mode: TypeRetentionMode; eligibleInDays: number }>;
    /** Nodes whose type has no policy or is explicitly keep. */
    kept: number;
}

/**
 * Compute the retention plan for a set of candidate nodes against a
 * workspace's typePolicies map. Pure function — caller owns I/O.
 *
 * `now` is injectable so the preview CLI + tests can fix the clock.
 * Defaults to `Date.now()` when omitted.
 */
export function computeRetentionPlan(
    candidates: RetentionCandidate[],
    typePolicies: TypePoliciesMap | undefined,
    now: number = Date.now(),
): RetentionPlan {
    const plan: RetentionPlan = {
        toWarm: [],
        toDelete: [],
        pending: [],
        kept: 0,
    };
    if (!typePolicies || Object.keys(typePolicies).length === 0) {
        plan.kept = candidates.length;
        return plan;
    }
    for (const node of candidates) {
        const rule = typePolicies[node.type];
        if (!rule || rule.mode === 'keep') {
            plan.kept += 1;
            continue;
        }
        const ageDays = ageInDays(node.updatedAt, now);
        if (ageDays === null) {
            // Unparseable updatedAt — leave the node alone. The
            // alternative (delete-on-error) is a footgun.
            plan.kept += 1;
            continue;
        }
        const threshold = rule.days ?? 0;
        if (threshold <= 0) {
            // A policy without `days` is a configuration error; treat
            // as keep rather than execute it. The retention CLI's
            // validation rejects this shape on `set` so it can only
            // arrive here via hand-edited workspaces.json.
            plan.kept += 1;
            continue;
        }
        if (ageDays >= threshold) {
            if (rule.mode === 'warm-after') plan.toWarm.push(node);
            else plan.toDelete.push(node);
        } else {
            plan.pending.push({
                ...node,
                mode: rule.mode,
                eligibleInDays: Math.ceil(threshold - ageDays),
            });
        }
    }
    return plan;
}

function ageInDays(isoUpdatedAt: string, now: number): number | null {
    const t = Date.parse(isoUpdatedAt);
    if (!Number.isFinite(t)) return null;
    const diffMs = now - t;
    if (diffMs < 0) return 0; // future-dated row — treat as brand new.
    return diffMs / (1000 * 60 * 60 * 24);
}

/**
 * Validation: ensure a TypeRetentionRule is well-formed before writing
 * it to workspaces.json. Returns null when valid, an error message
 * otherwise. Used by the `lore retention set` CLI.
 */
export function validateRule(rule: TypeRetentionRule): string | null {
    if (rule.mode !== 'keep' && rule.mode !== 'warm-after' && rule.mode !== 'delete-after') {
        return `mode must be one of: keep, warm-after, delete-after (got ${JSON.stringify(rule.mode)})`;
    }
    if (rule.mode === 'keep') {
        if (rule.days !== undefined) {
            return `mode=keep does not take a days argument; got days=${rule.days}`;
        }
        return null;
    }
    if (typeof rule.days !== 'number' || !Number.isFinite(rule.days) || rule.days <= 0 || rule.days > 36500) {
        return `mode=${rule.mode} requires a positive integer days (1..36500); got ${rule.days}`;
    }
    if (!Number.isInteger(rule.days)) {
        return `days must be an integer; got ${rule.days}`;
    }
    return null;
}
