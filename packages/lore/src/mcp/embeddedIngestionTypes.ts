/**
 * mcp/embeddedIngestionTypes.ts - types only for `createLore({ ingestion })` and `lore.ingestion`.
 *
 * Kept separate from embeddedIngestion.ts so server.ts (size-baselined) can name the option type without importing
 * any ingestion code: with ingestion off nothing under src/ingestion is loaded.
 */
import type { CallbackScheme } from '../ingestion/callbackAuth.js';
import type { IngestionCoordinator, RunSummary } from '../ingestion/coordinator.js';
import type { IngestionJob } from '../ingestion/store.js';

/** Scheduler settings for an embedded host. Same names and ranges as the `LORE_INGEST_*` interval/batch env vars. */
export interface EmbeddedIngestionScheduler {
    /** false = never start the background TickLoop; the app drives `lore.ingestion.runDue(ws)` itself. Default true. */
    autoRun?: boolean;
    runIntervalMs?: number;
    reapIntervalMs?: number;
    reapMaxAgeMs?: number;
    purgeIntervalMs?: number;
    reclaimIntervalMs?: number;
    batch?: number;
    leaseMs?: number;
    drainMs?: number;
}

/**
 * The hosted-processor callback listener. EXPLICIT ONLY: an embedded host never opens a socket because of an
 * environment variable, so `LORE_INGEST_CALLBACK_*` is ignored here. It still opens only if a hosted structurer, at
 * least one `hostedWorkspaces` entry, a >= 32 byte secret and a valid public URL are all present.
 */
export interface EmbeddedIngestionCallback {
    /** 0 = ephemeral port. */
    port: number;
    publicBaseUrl: string;
    masterSecret: string;
    webhookSecret?: string;
    scheme?: CallbackScheme;
    /** Default 127.0.0.1. */
    bind?: string;
}

/** The local file-content extractor as its own worker process. OFF by default (the in-process extractors stay as they are). */
export interface EmbeddedExtractWorker {
    /** A separately run worker (loopback http URL). Omit = a child process owned by this instance. */
    url?: string;
    /** Deadline for one extraction attempt; a hung child is killed. Default 120000. */
    timeoutMs?: number;
    /** Largest file the extractor reads, in bytes. Default 100 MiB. */
    maxFileBytes?: number;
    /** V8 old-space limit of the child in MB. Default 2048. */
    maxMemoryMb?: number;
}

/** A local OpenAI-compatible chat/vision endpoint on loopback, run by the host operator, for scanned pages and images. */
export interface EmbeddedLocalVision {
    /** e.g. http://127.0.0.1:1234/v1 - loopback only. */
    url: string;
    model: string;
    /** Scanned PDFs: read at most this many pages. Default 25. */
    maxPages?: number;
    timeoutMs?: number;
}

export interface EmbeddedIngestionOptions {
    /** Default true when an options object is given. `false` is the same as passing `ingestion: false`. */
    enabled?: boolean;
    /** Workspaces eligible for ingestion. Omit = every workspace registered at the time of use (local mode). */
    workspaces?: string[];
    /** Workspaces whose policy is `hosted-allowed`. Every other workspace stays `local-only`. */
    hostedWorkspaces?: string[];
    localLlm?: { url: string; model: string };
    /** `true` = run the extractors in a child process; an object tunes it or points at a loopback worker URL; `false` forces in-process. */
    extractWorker?: boolean | EmbeddedExtractWorker;
    /** Local vision for scans and images. `false` forces it off. */
    vision?: false | EmbeddedLocalVision;
    hostedStructuring?: { url: string; token?: string };
    callback?: EmbeddedIngestionCallback;
    scheduler?: EmbeddedIngestionScheduler;
    /** Largest file `enqueueFile` accepts through the admin route; carried for parity, default 25 MiB. */
    enqueueMaxBytes?: number;
}

/**
 * `createLore({ ingestion })`. OFF by default. `true` / an options object turns it on, `false` forces it off even when
 * `LORE_INGEST_ENABLED=1` is set; `undefined` falls back to `LORE_INGEST_ENABLED`. Options win over `LORE_INGEST_*` env.
 */
export type EmbeddedIngestionOption = boolean | EmbeddedIngestionOptions;

/** `lore.ingestion` - null when ingestion is off. */
export interface IngestionHandle {
    /** The workspace's coordinator (opens its store on first use). Rejects for a workspace that is not enabled. */
    coordinatorFor(workspace: string): Promise<IngestionCoordinator>;
    /** Job status. Undefined when the id is unknown or belongs to another workspace. */
    getJob(workspace: string, jobId: string): Promise<IngestionJob | undefined>;
    /** Claim and process due jobs now (what the background TickLoop does, on demand). */
    runDue(workspace: string, limit?: number): Promise<RunSummary>;
    /** Open workspaces, callback listener state and whether a hosted processor is registered. */
    status(): {
        workspaces: string[]; listener: { state: 'off' | 'refused' | 'listening'; reason?: string; port?: number; bind?: string }; hostedProcessor: boolean;
        extractor: { mode: 'in-process' | 'child' | 'url'; vision: boolean };
    };
}

/** The member added to a `LoreInstance` by `createLore` in src/index.ts. */
export interface IngestionApi {
    readonly ingestion: IngestionHandle | null;
}
