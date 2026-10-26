/**
 * discoveryConfig.ts - settings for Links Loop D (discovery + relation typing), design
 * _lore-3.25-handoff/LINK-BUILDING-AT-SCALE-DESIGN-2026-10-23.md.
 *
 * Everything is behind `LORE_LINK_DISCOVERY` (default OFF). With the flag off no discovery object is constructed,
 * no timer runs, no table is created and no recall or write path changes (proven by test/link-discovery-wireup-e2e.ts).
 *
 * The link policy (minSim / k / dupSim / policyVersion) is NOT repeated here: discovery scores with the same
 * `LinkRuntimeConfig` Loop A uses. The link policy has no per-workspace settings (it is per embedding model plus
 * global env), so these settings are global too.
 *
 * The typing cascade has three tiers (relationTyper.ts): a rules typer that is always on with discovery, a local
 * NLI typer (OFF unless `LORE_LINK_NLI=1`), and an LLM judge (OFF unless `LORE_LINK_JUDGE_URL` is set). A judge
 * endpoint that is not on this machine is refused unless `LORE_LINK_JUDGE_HOSTED=1` says so explicitly, and every
 * verdict it produces is marked NOT SOVEREIGN.
 */

export const LINK_DISCOVERY_FLAG_ENV = 'LORE_LINK_DISCOVERY';

export interface LinkNliConfig {
    /** Off by default. Turning it on makes the first typing call load the model (a download on first use). */
    enabled: boolean;
    /** Hugging Face model id of a text-pair NLI classifier. Null => the typer reports itself unavailable. */
    model: string | null;
    /** Minimum classifier score for a verdict; below it the pair falls through to the next tier. */
    minConfidence: number;
    /** Off by default: the model must already be in the local model cache. A background loop never fetches weights unasked. */
    allowDownload: boolean;
}

export interface LinkJudgeConfig {
    /** Base URL of an OpenAI-compatible server (`.../v1`). Null => no judge. */
    endpoint: string | null;
    model: string | null;
    /** Must be set explicitly for any endpoint that is not loopback; such verdicts are marked NOT SOVEREIGN. */
    hosted: boolean;
    /** Judge calls per workspace per run. 0 disables the judge. */
    budgetPerRun: number;
    /** Judge calls per workspace per UTC day (persisted). 0 = no daily cap. */
    budgetPerDay: number;
    minConfidence: number;
    timeoutMs: number;
}

export interface LinkDiscoveryConfig {
    enabled: boolean;
    /** How often the background sweep looks for discovery work. */
    intervalMs: number;
    /** Seed nodes examined per step (their live neighbours are added to the examined region). */
    seedBatch: number;
    /** Per-run budget: seed nodes, candidate pairs examined, wall time. A run that hits one stops and resumes next sweep. */
    maxNodes: number;
    maxPairs: number;
    maxMs: number;
    /** Pause between steps of one run. */
    yieldMs: number;
    /** A new pair at or above this similarity with differing timestamps becomes a supersession candidate. */
    supersedeSim: number;
    nli: LinkNliConfig;
    judge: LinkJudgeConfig;
}

export const DISCOVERY_DEFAULTS: LinkDiscoveryConfig = {
    enabled: false,
    intervalMs: 60_000,
    seedBatch: 50,
    maxNodes: 500,
    maxPairs: 200,
    maxMs: 5_000,
    yieldMs: 50,
    supersedeSim: 0.97,
    nli: { enabled: false, model: null, minConfidence: 0.8, allowDownload: false },
    judge: { endpoint: null, model: null, hosted: false, budgetPerRun: 20, budgetPerDay: 200, minConfidence: 0.7, timeoutMs: 20_000 },
};

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function flag(raw: string | undefined): boolean {
    const v = raw?.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on';
}

const str = (raw: string | undefined): string | null => (raw?.trim() ? raw.trim() : null);

export function isLinkDiscoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return flag(env[LINK_DISCOVERY_FLAG_ENV]);
}

/** Documented ranges of the numeric tunables (env falls back silently, programmatic overrides throw). */
const RANGES: Record<string, [number, number]> = {
    intervalMs: [100, 86_400_000], seedBatch: [1, 1000], maxNodes: [1, 1_000_000], maxPairs: [1, 1_000_000], maxMs: [10, 3_600_000],
    yieldMs: [0, 60_000], supersedeSim: [0, 1],
};
const JUDGE_RANGES: Record<string, [number, number]> = { budgetPerRun: [0, 100_000], budgetPerDay: [0, 10_000_000], minConfidence: [0, 1], timeoutMs: [100, 600_000] };

export function loadDiscoveryConfig(env: NodeJS.ProcessEnv = process.env): LinkDiscoveryConfig {
    const d = DISCOVERY_DEFAULTS;
    return {
        enabled: isLinkDiscoveryEnabled(env),
        intervalMs: num(env.LORE_LINK_DISCOVERY_INTERVAL_MS, d.intervalMs, ...RANGES.intervalMs!),
        seedBatch: Math.floor(num(env.LORE_LINK_DISCOVERY_BATCH_SIZE, d.seedBatch, ...RANGES.seedBatch!)),
        maxNodes: Math.floor(num(env.LORE_LINK_DISCOVERY_MAX_NODES, d.maxNodes, ...RANGES.maxNodes!)),
        maxPairs: Math.floor(num(env.LORE_LINK_DISCOVERY_MAX_PAIRS, d.maxPairs, ...RANGES.maxPairs!)),
        maxMs: Math.floor(num(env.LORE_LINK_DISCOVERY_MAX_MS, d.maxMs, ...RANGES.maxMs!)),
        yieldMs: num(env.LORE_LINK_DISCOVERY_YIELD_MS, d.yieldMs, ...RANGES.yieldMs!),
        supersedeSim: num(env.LORE_LINK_SUPERSEDE_SIM, d.supersedeSim, ...RANGES.supersedeSim!),
        nli: {
            enabled: flag(env.LORE_LINK_NLI),
            model: str(env.LORE_LINK_NLI_MODEL),
            minConfidence: num(env.LORE_LINK_NLI_MIN_CONFIDENCE, d.nli.minConfidence, 0, 1),
            allowDownload: flag(env.LORE_LINK_NLI_DOWNLOAD),
        },
        judge: {
            endpoint: str(env.LORE_LINK_JUDGE_URL),
            model: str(env.LORE_LINK_JUDGE_MODEL),
            hosted: flag(env.LORE_LINK_JUDGE_HOSTED),
            budgetPerRun: Math.floor(num(env.LORE_LINK_JUDGE_BUDGET, d.judge.budgetPerRun, ...JUDGE_RANGES.budgetPerRun!)),
            budgetPerDay: Math.floor(num(env.LORE_LINK_JUDGE_DAILY_BUDGET, d.judge.budgetPerDay, ...JUDGE_RANGES.budgetPerDay!)),
            minConfidence: num(env.LORE_LINK_JUDGE_MIN_CONFIDENCE, d.judge.minConfidence, ...JUDGE_RANGES.minConfidence!),
            timeoutMs: num(env.LORE_LINK_JUDGE_TIMEOUT_MS, d.judge.timeoutMs, ...JUDGE_RANGES.timeoutMs!),
        },
    };
}

/** `createLore({ linkDiscovery })`: `true`/`false`, or an object (`enabled` defaults to true) of overrides. */
export type LinkDiscoveryOption = boolean | (Partial<Omit<LinkDiscoveryConfig, 'nli' | 'judge'>> & { nli?: Partial<LinkNliConfig>; judge?: Partial<LinkJudgeConfig> });

function checkRange(label: string, key: string, v: unknown, range: [number, number]): number {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < range[0] || v > range[1]) throw new RangeError(`${label}.${key} must be a number in [${range[0]}, ${range[1]}]`);
    return v;
}

/** Merge programmatic settings over the env-derived config. A bad value throws a RangeError at createLore() time. */
export function applyDiscoveryOverrides(base: LinkDiscoveryConfig, opt: LinkDiscoveryOption | undefined): LinkDiscoveryConfig {
    if (opt === undefined) return base;
    if (typeof opt === 'boolean') return { ...base, enabled: opt };
    const out: LinkDiscoveryConfig = { ...base, nli: { ...base.nli }, judge: { ...base.judge }, enabled: opt.enabled ?? true };
    for (const key of Object.keys(RANGES)) {
        const v = (opt as Record<string, unknown>)[key];
        if (v === undefined) continue;
        const n = checkRange('linkDiscovery', key, v, RANGES[key]!);
        (out as unknown as Record<string, number>)[key] = ['seedBatch', 'maxNodes', 'maxPairs', 'maxMs'].includes(key) ? Math.floor(n) : n;
    }
    if (opt.nli) {
        if (opt.nli.enabled !== undefined) out.nli.enabled = opt.nli.enabled === true;
        if (opt.nli.model !== undefined) out.nli.model = opt.nli.model;
        if (opt.nli.allowDownload !== undefined) out.nli.allowDownload = opt.nli.allowDownload === true;
        if (opt.nli.minConfidence !== undefined) out.nli.minConfidence = checkRange('linkDiscovery.nli', 'minConfidence', opt.nli.minConfidence, [0, 1]);
    }
    if (opt.judge) {
        const j = opt.judge;
        if (j.endpoint !== undefined) out.judge.endpoint = j.endpoint;
        if (j.model !== undefined) out.judge.model = j.model;
        if (j.hosted !== undefined) out.judge.hosted = j.hosted === true;
        for (const key of Object.keys(JUDGE_RANGES)) {
            const v = (j as Record<string, unknown>)[key];
            if (v !== undefined) (out.judge as unknown as Record<string, number>)[key] = checkRange('linkDiscovery.judge', key, v, JUDGE_RANGES[key]!);
        }
    }
    return out;
}
