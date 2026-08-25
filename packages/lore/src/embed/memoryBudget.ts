/**
 * embed/memoryBudget.ts — adaptive, %-of-RAM memory controls for the embed
 * pipeline (MVP-mem, 2026-06-28).
 *
 * Embedding is the dominant memory consumer at scale (the in-process ONNX
 * runtime's arena grows during a sustained bulk embed). Hard-coded limits
 * don't fit hardware that ranges from an 8 GB laptop to a 128 GB workstation,
 * so both knobs here scale to the machine's TOTAL RAM (and stay env-overridable):
 *
 *   embedBatchCap()             — per-call batch sizes itself to RAM, so a small
 *                                 machine never runs a giant forward pass that
 *                                 OOMs outright; a big machine keeps full speed.
 *   awaitEmbedMemoryHeadroom()  — BACK-PRESSURE: pause embedding while this
 *                                 process's footprint exceeds a % of total RAM,
 *                                 so a large initial bulk-embed self-throttles on
 *                                 a constrained host (the OS/allocator reclaims
 *                                 during the pause). Times out → it THROTTLES,
 *                                 never deadlocks.
 */

import * as os from 'node:os';

const TOTAL_BYTES = os.totalmem();
const TOTAL_GB = TOTAL_BYTES / 2 ** 30;

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

/**
 * Per-call embed batch (number of texts per ONNX forward pass), scaled to RAM
 * at ~8 texts/GB, clamped to [8, 256]. `LORE_EMBED_BATCH_MAX` (any value > 0)
 * overrides. Examples: 4 GB→32, 8 GB→64, 16 GB→128, ≥32 GB→256.
 */
export function embedBatchCap(): number {
    const env = Number(process.env.LORE_EMBED_BATCH_MAX);
    if (Number.isFinite(env) && env > 0) return Math.floor(env);
    return clamp(Math.round(TOTAL_GB * 8), 8, 256);
}

// Back-pressure threshold: pause embedding while RSS exceeds this % of total RAM.
const MEM_PCT = clamp(Number(process.env.LORE_EMBED_MEM_PCT) || 70, 5, 95);
const STEP_MS = 250;
const MAX_WAIT_MS = (() => {
    const n = Number(process.env.LORE_EMBED_MEM_WAIT_MS);
    return Number.isFinite(n) && n >= 0 ? n : 15_000;
})();

let warnedThisProcess = false;

/**
 * Pause until this process's RSS is back under MEM_PCT% of total RAM, polling
 * every STEP_MS (nudging GC when --expose-gc is on). After MAX_WAIT_MS it
 * RETURNS anyway and proceeds — the goal is to THROTTLE a memory-heavy bulk
 * embed on a constrained host, not to block forever. No-op on roomy hosts
 * (RSS is well under budget, the loop never runs).
 */
export async function awaitEmbedMemoryHeadroom(log?: (m: string) => void): Promise<void> {
    const budget = TOTAL_BYTES * (MEM_PCT / 100);
    const start = Date.now();
    while (process.memoryUsage().rss > budget) {
        if (Date.now() - start > MAX_WAIT_MS) {
            if (!warnedThisProcess) {
                warnedThisProcess = true;
                log?.(`[embed] memory back-pressure: RSS over ${MEM_PCT}% of ${TOTAL_GB.toFixed(0)}GB RAM for >${MAX_WAIT_MS}ms — proceeding throttled`);
            }
            return;
        }
        const g = (globalThis as { gc?: () => void }).gc;
        if (g) g();
        await new Promise((r) => setTimeout(r, STEP_MS));
    }
}
