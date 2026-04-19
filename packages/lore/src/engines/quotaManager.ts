/**
 * quotaManager.ts — Workspace quota + ingestion gate (Phase 2 / C5.5).
 *
 * The "bound" pillar of the three-pillar storage strategy. Given the
 * observation data from StorageInspector, decide:
 *
 *   - Green (< 70% of budget):   unrestricted
 *   - Yellow (70–85%):           UI shows banner, warn user
 *   - Orange (85–95%):           ingestion is throttled (processed slower)
 *   - Red (>= 95%):              ingestion paused until user acts
 *
 * The quota itself is hardware-aware by default:
 *   budget = min(50 GB, 20% of currently-free disk)
 *   clamped to a floor of 1 GB (below that, Lore isn't viable).
 *
 * Per-workspace quota overrides live in
 *   ~/.groundfloor/workspaces.json  →  each entry's optional `quotaBytes`.
 * (Kept in the workspaces registry rather than a separate file so a
 * user operating on workspaces sees budget alongside everything else.)
 *
 * This module is PURE policy — it reads inspector output, returns a
 * decision. Actual enforcement happens at the ingestion call sites.
 * C5.5 ships the policy; integration-with-ingestion is a one-liner at
 * each call site, done in the same commit.
 */

import type { StorageBreakdown } from './storageInspector.js';

const GB = 1024 * 1024 * 1024;

/** Quota tiers with human-meaningful thresholds. */
export type QuotaState = 'green' | 'yellow' | 'orange' | 'red';

export interface QuotaDecision {
    state: QuotaState;
    /** Bytes currently used (across the workspace). */
    usedBytes: number;
    /** Effective budget for this workspace. */
    budgetBytes: number;
    /** used / budget, clamped to [0, 1.2]. */
    ratio: number;
    /** Is ingestion allowed to proceed? */
    allowIngestion: boolean;
    /** Should ingestion slow down? (orange tier) */
    throttleIngestion: boolean;
    /** User-facing one-liner for UI / log. */
    message: string;
}

export interface QuotaInput {
    /** What StorageInspector already measured for the workspace. */
    breakdown: StorageBreakdown;
    /** Optional per-workspace budget override in bytes. */
    explicitBudgetBytes?: number;
}

/**
 * computeBudget — hardware-aware default.
 *
 * Min(50 GB, 20% of currently-free disk), floor 1 GB. The 20% cap
 * means a laptop with only 10 GB free won't let Lore eat 8 of them —
 * it caps at 2. The 50 GB absolute cap means a machine with a terabyte
 * free doesn't turn Lore into an uncapped data hoard.
 */
export function computeBudget(breakdown: StorageBreakdown): number {
    const diskFree = breakdown.diskFreeBytes;
    const diskTotal = breakdown.diskTotalBytes;

    // If we can't read the disk (older Node, unusual FS), fall back to
    // a conservative 5 GB default. Better to be annoying than to
    // quietly eat disk the user didn't expect.
    if (diskFree === 0 && diskTotal === 0) return 5 * GB;

    const pctCap = Math.floor(diskFree * 0.20);
    const absCap = 50 * GB;
    const budget = Math.min(absCap, pctCap);
    return Math.max(GB, budget);
}

export function decideQuota(input: QuotaInput): QuotaDecision {
    const budget = input.explicitBudgetBytes ?? computeBudget(input.breakdown);
    const used = input.breakdown.totalBytes;
    const ratio = budget > 0 ? used / budget : 1;

    let state: QuotaState;
    let allowIngestion = true;
    let throttleIngestion = false;
    let message: string;

    if (ratio < 0.70) {
        state = 'green';
        message = `Workspace at ${Math.round(ratio * 100)}% of budget — unrestricted.`;
    } else if (ratio < 0.85) {
        state = 'yellow';
        message = `Workspace at ${Math.round(ratio * 100)}% of budget. Consider archiving old content or raising the quota.`;
    } else if (ratio < 0.95) {
        state = 'orange';
        throttleIngestion = true;
        message = `Workspace at ${Math.round(ratio * 100)}% of budget. Ingestion throttled. Archive, raise quota, or switch workspace.`;
    } else {
        state = 'red';
        allowIngestion = false;
        message = `Workspace at ${Math.round(ratio * 100)}% of budget — INGESTION PAUSED. Raise quota, archive content, or switch workspace before adding new data.`;
    }

    return {
        state,
        usedBytes: used,
        budgetBytes: budget,
        ratio: Math.min(ratio, 1.2),
        allowIngestion,
        throttleIngestion,
        message,
    };
}
