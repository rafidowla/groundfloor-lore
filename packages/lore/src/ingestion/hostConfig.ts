/**
 * ingestion/hostConfig.ts - daemon settings for the ingestion host (env driven, like link/linkConfig.ts).
 *
 * Everything is behind `LORE_INGEST_ENABLED` (default OFF). With the flag off nothing else here is read
 * and no ingestion module is loaded by the daemon. Secrets are wrapped in {@link Secret} so a stray
 * `log.info(config)` / `JSON.stringify(config)` / `util.inspect(config)` prints `[redacted]`, and a secret
 * may be supplied as a file (`..._FILE`) so it need not live in the process environment.
 */
import * as fs from 'node:fs';
import { inspect } from 'node:util';
import { DEFAULT_REPLAY_WINDOW_SEC, type CallbackScheme } from './callbackAuth.js';
import { DEFAULT_LEASE_MS } from './coordinator.js';

export const INGEST_FLAG_ENV = 'LORE_INGEST_ENABLED';
/** Master secret floor (bytes). Matches assertConfig() in callbackAuth.ts. */
export const MIN_SECRET_BYTES = 32;

/** A string that refuses to be printed. Use `.reveal()` at the single point of use. */
export class Secret {
    readonly #v: string;
    constructor(v: string) { this.#v = v; }
    reveal(): string { return this.#v; }
    get byteLength(): number { return Buffer.byteLength(this.#v, 'utf8'); }
    toString(): string { return '[redacted]'; }
    toJSON(): string { return '[redacted]'; }
    [inspect.custom](): string { return '[redacted]'; }
}

export interface IngestHostConfig {
    enabled: boolean;
    /** Explicit workspace list; null = every registered workspace (local mode only). */
    workspaces: string[] | null;
    /** Workspaces whose policy is `hosted-allowed`. Everything else stays `local-only`. */
    hostedWorkspaces: string[];
    localLlm: { url: string; model: string } | null;
    hostedStructuring: { url: string; token: Secret | null } | null;
    callback: {
        /** null = the callback listener is off. 0 = ephemeral port (tests). */
        port: number | null;
        bind: string;
        publicBaseUrl: string | null;
        masterSecret: Secret | null;
        webhookSecret: Secret | null;
        scheme: CallbackScheme;
        replayWindowSec: number;
        maxConcurrent: number;
        perIpPerMin: number;
        headersTimeoutMs: number;
        requestTimeoutMs: number;
    };
    scheduler: {
        runIntervalMs: number;
        reapIntervalMs: number;
        reapMaxAgeMs: number;
        purgeIntervalMs: number;
        reclaimIntervalMs: number;
        batch: number;
        leaseMs: number;
        drainMs: number;
    };
    /** Admin HTTP enqueue route (mcp/http/routes/ingestEnqueue.ts). */
    enqueue: {
        /** Largest decoded file the route accepts, in bytes. */
        maxBytes: number;
    };
    /**
     * Sovereign extraction (contract A, step 2). OFF by default: `mode: 'in-process'` keeps today's behaviour exactly.
     * `child` runs the extractors in a separate process owned by this Lore instance; `url` talks to a separately run
     * worker over a loopback URL.
     */
    extract: {
        mode: 'in-process' | 'child' | 'url';
        /** Worker URL (mode `url`). Loopback only. */
        url: string | null;
        /** Deadline for one extraction attempt. A hung child is killed at this point. */
        timeoutMs: number;
        /** Largest file the extractor will read (bytes). */
        maxFileBytes: number;
        /** V8 old-space limit of the child, in MB. */
        maxMemoryMb: number;
    };
    /**
     * Local vision for scanned pages and images: an OpenAI-compatible chat/vision endpoint on loopback that the host
     * operator runs. null = off (no vision; scans and images behave as today).
     */
    vision: { url: string; model: string; maxPages: number; timeoutMs: number } | null;
}

/** Default cap on one file submitted through the admin enqueue route (25 MiB). */
export const DEFAULT_ENQUEUE_MAX_BYTES = 25 * 1024 * 1024;

/** [min, max] for every scheduler setting. Shared by the env loader and the embedded `createLore({ ingestion })` validator. */
export const SCHEDULER_BOUNDS = {
    runIntervalMs: [100, 3_600_000], reapIntervalMs: [100, 86_400_000], reapMaxAgeMs: [1_000, 30 * 86_400_000],
    purgeIntervalMs: [1_000, 30 * 86_400_000], reclaimIntervalMs: [100, 86_400_000], batch: [1, 500],
    leaseMs: [1_000, 24 * 3_600_000], drainMs: [0, 120_000],
} as const satisfies Record<keyof IngestHostConfig['scheduler'], readonly [number, number]>;

/** [min, max] for the extractor worker / vision settings. Shared by the env loader and the embedded validator. */
export const EXTRACT_BOUNDS = {
    timeoutMs: [1_000, 3_600_000], maxFileBytes: [1_024, 1024 * 1024 * 1024], maxMemoryMb: [128, 65_536],
    visionMaxPages: [1, 500], visionTimeoutMs: [1_000, 3_600_000],
} as const;
export const DEFAULT_EXTRACT = { timeoutMs: 120_000, maxFileBytes: 100 * 1024 * 1024, maxMemoryMb: 2_048, visionMaxPages: 25, visionTimeoutMs: 120_000 } as const;

function num(raw: string | undefined, fallback: number, min: number, max: number): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

/** Unset/blank/invalid => null (listener off). A set-but-invalid port never silently becomes a different port. */
function parsePort(raw: string | undefined): number | null {
    if (raw === undefined || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 65_535 ? n : null;
}

function list(raw: string | undefined): string[] {
    return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function isIngestionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = env[INGEST_FLAG_ENV];
    return v === '1' || v === 'true' || v === 'on';
}

/** `NAME` (value) or `NAME_FILE` (path to a file holding the value). A file that cannot be read yields null. */
function secret(env: NodeJS.ProcessEnv, name: string): Secret | null {
    const direct = env[name];
    if (direct !== undefined && direct !== '') return new Secret(direct);
    const file = env[`${name}_FILE`];
    if (file !== undefined && file !== '') {
        try { return new Secret(fs.readFileSync(file, 'utf8').replace(/[\r\n]+$/, '')); } catch { return null; }
    }
    return null;
}

const SCHEMES: readonly CallbackScheme[] = ['bearer', 'lore-hmac', 'standard-webhooks'];

export function loadIngestHostConfig(env: NodeJS.ProcessEnv = process.env): IngestHostConfig {
    const explicit = list(env['LORE_INGEST_WORKSPACES']);
    const llmUrl = env['LORE_INGEST_LOCAL_LLM_URL']?.trim();
    const llmModel = env['LORE_INGEST_LOCAL_LLM_MODEL']?.trim();
    const hostedUrl = env['LORE_INGEST_HOSTED_STRUCTURING_URL']?.trim();
    const portRaw = env['LORE_INGEST_CALLBACK_PORT'];
    const scheme = env['LORE_INGEST_CALLBACK_SCHEME']?.trim() as CallbackScheme | undefined;
    return {
        enabled: isIngestionEnabled(env),
        workspaces: explicit.length > 0 ? explicit : null,
        hostedWorkspaces: list(env['LORE_INGEST_HOSTED_WORKSPACES']),
        localLlm: llmUrl && llmModel ? { url: llmUrl, model: llmModel } : null,
        hostedStructuring: hostedUrl ? { url: hostedUrl, token: secret(env, 'LORE_INGEST_HOSTED_STRUCTURING_TOKEN') } : null,
        callback: {
            port: parsePort(portRaw),
            bind: env['LORE_INGEST_CALLBACK_BIND']?.trim() || '127.0.0.1',
            publicBaseUrl: env['LORE_INGEST_CALLBACK_PUBLIC_URL']?.trim() || null,
            masterSecret: secret(env, 'LORE_INGEST_CALLBACK_SECRET'),
            webhookSecret: secret(env, 'LORE_INGEST_CALLBACK_WEBHOOK_SECRET'),
            scheme: scheme && SCHEMES.includes(scheme) ? scheme : 'bearer',
            replayWindowSec: num(env['LORE_INGEST_CALLBACK_REPLAY_WINDOW_SEC'], DEFAULT_REPLAY_WINDOW_SEC, 30, 3600),
            maxConcurrent: num(env['LORE_INGEST_CALLBACK_MAX_CONCURRENT'], 32, 1, 1024),
            perIpPerMin: num(env['LORE_INGEST_CALLBACK_RATE_PER_MIN'], 120, 1, 100_000),
            headersTimeoutMs: num(env['LORE_INGEST_CALLBACK_HEADERS_TIMEOUT_MS'], 10_000, 100, 120_000),
            requestTimeoutMs: num(env['LORE_INGEST_CALLBACK_REQUEST_TIMEOUT_MS'], 30_000, 100, 600_000),
        },
        scheduler: {
            runIntervalMs: num(env['LORE_INGEST_RUN_INTERVAL_MS'], 5_000, ...SCHEDULER_BOUNDS.runIntervalMs),
            reapIntervalMs: num(env['LORE_INGEST_REAP_INTERVAL_MS'], 60_000, ...SCHEDULER_BOUNDS.reapIntervalMs),
            reapMaxAgeMs: num(env['LORE_INGEST_REAP_MAX_AGE_MS'], 30 * 60_000, ...SCHEDULER_BOUNDS.reapMaxAgeMs),
            purgeIntervalMs: num(env['LORE_INGEST_PURGE_INTERVAL_MS'], 6 * 3_600_000, ...SCHEDULER_BOUNDS.purgeIntervalMs),
            reclaimIntervalMs: num(env['LORE_INGEST_RECLAIM_INTERVAL_MS'], 60_000, ...SCHEDULER_BOUNDS.reclaimIntervalMs),
            batch: num(env['LORE_INGEST_BATCH'], 10, ...SCHEDULER_BOUNDS.batch),
            leaseMs: num(env['LORE_INGEST_LEASE_MS'], DEFAULT_LEASE_MS, ...SCHEDULER_BOUNDS.leaseMs),
            drainMs: num(env['LORE_INGEST_DRAIN_MS'], 5_000, ...SCHEDULER_BOUNDS.drainMs),
        },
        enqueue: {
            maxBytes: num(env['LORE_INGEST_ENQUEUE_MAX_BYTES'], DEFAULT_ENQUEUE_MAX_BYTES, 1_024, 512 * 1024 * 1024),
        },
        extract: loadExtract(env),
        vision: loadVision(env),
    };
}

function loadExtract(env: NodeJS.ProcessEnv): IngestHostConfig['extract'] {
    const url = env['LORE_INGEST_EXTRACT_WORKER_URL']?.trim() || null;
    const flag = env['LORE_INGEST_EXTRACT_WORKER']?.trim().toLowerCase();
    const on = flag === '1' || flag === 'true' || flag === 'on' || flag === 'child';
    return {
        // A URL means "use that worker"; the flag alone means "run one as a child"; neither means today's in-process path.
        mode: url ? 'url' : on ? 'child' : 'in-process',
        url,
        timeoutMs: num(env['LORE_INGEST_EXTRACT_TIMEOUT_MS'], DEFAULT_EXTRACT.timeoutMs, ...EXTRACT_BOUNDS.timeoutMs),
        maxFileBytes: num(env['LORE_INGEST_EXTRACT_MAX_BYTES'], DEFAULT_EXTRACT.maxFileBytes, ...EXTRACT_BOUNDS.maxFileBytes),
        maxMemoryMb: num(env['LORE_INGEST_EXTRACT_MAX_MEMORY_MB'], DEFAULT_EXTRACT.maxMemoryMb, ...EXTRACT_BOUNDS.maxMemoryMb),
    };
}

function loadVision(env: NodeJS.ProcessEnv): IngestHostConfig['vision'] {
    const url = env['LORE_INGEST_VISION_URL']?.trim();
    const model = env['LORE_INGEST_VISION_MODEL']?.trim();
    if (!url || !model) return null;
    return { url, model, maxPages: num(env['LORE_INGEST_VISION_MAX_PAGES'], DEFAULT_EXTRACT.visionMaxPages, ...EXTRACT_BOUNDS.visionMaxPages), timeoutMs: DEFAULT_EXTRACT.visionTimeoutMs };
}
