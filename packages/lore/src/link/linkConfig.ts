/**
 * linkConfig.ts - settings for link-on-arrival (design P0,
 * _lore-3.25-handoff/LINK-BUILDING-AT-SCALE-DESIGN-2026-10-23.md).
 *
 * Everything is behind `LORE_LINK_ON_ARRIVAL` (default OFF). With the flag off
 * nothing in this directory is constructed and every write path behaves exactly
 * as it did before - proven by test/link-on-arrival-flag-off-unit.ts.
 *
 * The similarity threshold is stored PER EMBEDDING MODEL (linkModelPolicy.ts):
 * the default model (multilingual-e5-small) is asymmetric (query: / passage:
 * prefixes), so a threshold measured query-vs-passage (the old 0.65) does not
 * carry over to passage-vs-passage links built from stored vectors. The
 * calibrated value is 0.80 / k 5 (policy p0-2). Env vars override for operators.
 */

import { resolveModelLinkPolicy, UNCALIBRATED_LINK_POLICY } from './linkModelPolicy.js';

export const LINK_FLAG_ENV = 'LORE_LINK_ON_ARRIVAL';

export interface LinkPolicy {
    /** Minimum cosine similarity for a `semantic_neighbor` edge. */
    minSim: number;
    /** Max edges written per arriving node. */
    k: number;
    /** At or above this a neighbour is a near-duplicate: it ALSO goes to the supersession-candidate list. */
    dupSim: number;
    /** Stamped on queue rows and metrics so a later rebuild can tell which policy made a link. */
    policyVersion: string;
}

export interface LinkRuntimeConfig extends LinkPolicy {
    /** Nodes linked per worker batch (one batched kNN + one batched edge write). */
    batchSize: number;
    /** The worker waits this long after the LAST arrival before it runs (yields to ingestion). */
    quietMs: number;
    /** ...but never lets the oldest queued item wait longer than this (starvation guard). */
    maxDelayMs: number;
    /** Pause between batches so a long backlog never monopolises the event loop / SQLite. */
    yieldMs: number;
    /** Attempts before an item is parked as 'failed' (kept, visible in stats, not retried forever). */
    maxAttempts: number;
    /** Rebuild (Loop C): nodes recomputed per batch. */
    rebuildBatchSize: number;
    /** Rebuild: pause between batches. */
    rebuildYieldMs: number;
    /** Rebuild: longest a batch waits for the link queue / ingestion to go quiet before running anyway. */
    rebuildMaxWaitMs: number;
    /**
     * Loop B (default OFF): a node whose vector is re-committed after an edit is REFRESHED, not just re-linked:
     * links that no longer qualify are soft-invalidated (`valid_to`, never deleted) and new neighbours are linked.
     * Off = a re-committed node only adds / re-asserts links, exactly as before.
     */
    refreshOnChange: boolean;
    /**
     * Soft cap on live linker edges per node (default 0 = no cap). Arrival never evicts; a background sweep keeps
     * each node's strongest `maxLinksPerNode` linker edges and soft-invalidates the weaker ones.
     */
    maxLinksPerNode: number;
    /** Prune sweep: how often the background sweep looks for workspaces whose links changed since the last pass. */
    pruneIntervalMs: number;
    /** Prune sweep: over-cap nodes examined per step (`yieldMs` pause between steps). */
    pruneBatchSize: number;
    /** Link-health snapshot lifetime: stats / metrics scrapes inside this window reuse the last snapshot instead of querying every graph. */
    healthTtlMs: number;
}

export const LINK_DEFAULTS: LinkRuntimeConfig = {
    // Fallback only: the live value comes from the per-model table (linkModelPolicy.ts), then env.
    minSim: UNCALIBRATED_LINK_POLICY.minSim,
    k: UNCALIBRATED_LINK_POLICY.k,
    dupSim: 0.95,
    // p0-2: threshold moved 0.65 -> 0.80 (per-model calibration, 2026-10-23).
    policyVersion: 'p0-2',
    batchSize: 32,
    quietMs: 250,
    maxDelayMs: 5_000,
    yieldMs: 25,
    maxAttempts: 5,
    rebuildBatchSize: 50,
    rebuildYieldMs: 200,
    rebuildMaxWaitMs: 30_000,
    refreshOnChange: true,
    maxLinksPerNode: 0,
    pruneIntervalMs: 30_000,
    pruneBatchSize: 50,
    healthTtlMs: 30_000,
};

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Documented ranges for every tunable; the env loader falls back silently, programmatic overrides throw. */
const LINK_RANGES: { [K in keyof LinkRuntimeConfig]?: [number, number] } = {
    minSim: [0, 1], k: [1, 100], dupSim: [0, 1], batchSize: [1, 1000], quietMs: [0, 60_000], maxDelayMs: [0, 600_000],
    yieldMs: [0, 10_000], maxAttempts: [1, 100], rebuildBatchSize: [1, 1000], rebuildYieldMs: [0, 60_000], rebuildMaxWaitMs: [0, 3_600_000],
    maxLinksPerNode: [0, 10_000], pruneIntervalMs: [100, 86_400_000], pruneBatchSize: [1, 1000], healthTtlMs: [0, 3_600_000],
};

/**
 * Embedded hosts (`createLore({ linkOnArrival: { ... } })`): merge programmatic settings OVER the env-derived config.
 * An out-of-range or non-finite value throws a RangeError at createLore() time (a host's typo should not be silently
 * replaced by a default). Unset fields keep the env / per-model value. Integer settings are floored.
 */
export function applyLinkOverrides(base: LinkRuntimeConfig, overrides: Partial<LinkRuntimeConfig> | undefined): LinkRuntimeConfig {
    if (!overrides) return base;
    const out: LinkRuntimeConfig = { ...base };
    for (const key of Object.keys(overrides) as Array<keyof LinkRuntimeConfig>) {
        const v = overrides[key];
        if (v === undefined) continue;
        if (key === 'policyVersion') { if (typeof v !== 'string' || v.trim() === '') throw new RangeError('linkOnArrival.policyVersion must be a non-empty string'); out.policyVersion = v.trim(); continue; }
        if (key === 'refreshOnChange') { if (typeof v !== 'boolean') throw new RangeError('linkOnArrival.refreshOnChange must be a boolean'); out.refreshOnChange = v; continue; }
        const range = LINK_RANGES[key];
        if (!range) throw new RangeError(`linkOnArrival: unknown setting '${String(key)}'`);
        if (typeof v !== 'number' || !Number.isFinite(v) || v < range[0] || v > range[1]) throw new RangeError(`linkOnArrival.${key} must be a number in [${range[0]}, ${range[1]}]`);
        (out as unknown as Record<string, number>)[key] = ['k', 'batchSize', 'maxAttempts', 'rebuildBatchSize', 'maxLinksPerNode', 'pruneBatchSize'].includes(key) ? Math.floor(v) : v;
    }
    return out;
}

function flag(raw: string | undefined, fallback: boolean): boolean {
    if (raw === undefined || raw.trim() === '') return fallback;
    const v = raw.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' ? true : v === '0' || v === 'false' || v === 'off' ? false : fallback;
}

export function isLinkOnArrivalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = env[LINK_FLAG_ENV];
    return v === '1' || v === 'true' || v === 'on';
}

/**
 * `modelFingerprint` (embeddingProviderFingerprint of the provider that made the vectors) selects the
 * calibrated per-model minSim/k; omit it to get the uncalibrated default. Env vars always win.
 */
export function loadLinkConfig(env: NodeJS.ProcessEnv = process.env, modelFingerprint?: string | null, log?: (msg: string) => void): LinkRuntimeConfig {
    const d = LINK_DEFAULTS;
    const model = modelFingerprint === undefined ? { minSim: d.minSim, k: d.k } : resolveModelLinkPolicy(modelFingerprint, log);
    return {
        minSim: num(env.LORE_LINK_MIN_SIM, model.minSim, 0, 1),
        k: Math.floor(num(env.LORE_LINK_K, model.k, 1, 100)),
        dupSim: num(env.LORE_LINK_DUP_SIM, d.dupSim, 0, 1),
        policyVersion: env.LORE_LINK_POLICY_VERSION?.trim() || d.policyVersion,
        batchSize: Math.floor(num(env.LORE_LINK_BATCH_SIZE, d.batchSize, 1, 1000)),
        quietMs: num(env.LORE_LINK_QUIET_MS, d.quietMs, 0, 60_000),
        maxDelayMs: num(env.LORE_LINK_MAX_DELAY_MS, d.maxDelayMs, 0, 600_000),
        yieldMs: num(env.LORE_LINK_YIELD_MS, d.yieldMs, 0, 10_000),
        maxAttempts: Math.floor(num(env.LORE_LINK_MAX_ATTEMPTS, d.maxAttempts, 1, 100)),
        rebuildBatchSize: Math.floor(num(env.LORE_LINK_REBUILD_BATCH_SIZE, d.rebuildBatchSize, 1, 1000)),
        rebuildYieldMs: num(env.LORE_LINK_REBUILD_YIELD_MS, d.rebuildYieldMs, 0, 60_000),
        rebuildMaxWaitMs: num(env.LORE_LINK_REBUILD_MAX_WAIT_MS, d.rebuildMaxWaitMs, 0, 3_600_000),
        refreshOnChange: flag(env.LORE_LINK_REFRESH_ON_CHANGE, d.refreshOnChange),
        maxLinksPerNode: Math.floor(num(env.LORE_LINK_MAX_PER_NODE, d.maxLinksPerNode, 0, 10_000)),
        pruneIntervalMs: num(env.LORE_LINK_PRUNE_INTERVAL_MS, d.pruneIntervalMs, 100, 86_400_000),
        pruneBatchSize: Math.floor(num(env.LORE_LINK_PRUNE_BATCH_SIZE, d.pruneBatchSize, 1, 1000)),
        healthTtlMs: num(env.LORE_LINK_HEALTH_TTL_MS, d.healthTtlMs, 0, 3_600_000),
    };
}
