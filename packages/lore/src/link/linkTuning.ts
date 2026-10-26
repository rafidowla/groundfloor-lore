/**
 * linkTuning.ts - internal speed-ups of the link rebuild (Loop C, lane e3). Each one is result-neutral: the rebuild
 * produces the same edges, invalidations and counters with every flag on or off (test/link-rebuild-parity-unit.ts).
 *
 * The flags exist so the parity test and the benches can run the pre-e3 behaviour side by side with the new one. They
 * are programmatic only (no env var): production always runs with everything on.
 */
export interface RebuildTuning {
    /** kNN returns only the columns the linker reads (id, score, ecosystem, security_scopes), not the row text. */
    narrowRows: boolean;
    /** One batched row read (`getByIds`) per batch instead of one `getById` round trip per node, where the engine has it. */
    batchLookups: boolean;
    /** An outside endpoint whose link set was already computed in this run (current / previous / prefetched batch) is not recomputed. */
    reuseComputed: boolean;
    /** The next batch's read-only compute runs while the current batch reconciles and writes. */
    prefetch: boolean;
}

export const FAST_TUNING: RebuildTuning = { narrowRows: true, batchLookups: true, reuseComputed: true, prefetch: true };
export const LEGACY_TUNING: RebuildTuning = { narrowRows: false, batchLookups: false, reuseComputed: false, prefetch: false };

export function resolveTuning(t: Partial<RebuildTuning> | undefined): RebuildTuning {
    return { ...FAST_TUNING, ...(t ?? {}) };
}
