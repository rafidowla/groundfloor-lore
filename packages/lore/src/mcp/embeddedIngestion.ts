/**
 * mcp/embeddedIngestion.ts - `createLore({ ingestion })` and `lore.ingestion`.
 *
 * The ingestion pipeline (ingestion/ingestionHost.ts) normally boots in the daemon only. This attaches the same host
 * to an embedded instance, built through the daemon's own construction path (ingestionBoot.startIngestionHostWith).
 * Attached from src/index.ts's createLore (server.ts is frozen), like nodeDeleteMany and getVectors.
 *
 * An embedded host does not own the process, so this adds no signal or process-wide handlers, never mutates
 * process.env, and opens no socket unless `ingestion.callback` is passed explicitly. The TickLoop timers are unref'd
 * and `dispose()` stops the host (scheduler, listener, stores) BEFORE the instance's own drain, because ingestion
 * writes through `lore.nodeUpsert`. With ingestion off, no ingestion module is imported.
 */
import { log } from '../logger.js';
import { getWorkspacePath, listWorkspaceNames } from '../config/workspaces.js';
import { isIngestionEnabled, loadIngestHostConfig, Secret, SCHEDULER_BOUNDS, type IngestHostConfig } from '../ingestion/hostConfig.js';
import type { IngestionHost } from '../ingestion/ingestionHost.js';
import { startIngestionHostWith } from './ingestionBoot.js';
import type { LoreInstance } from './server.js';
import { applyExtractOptions } from './embeddedIngestionWorker.js';
import type { EmbeddedIngestionOption, EmbeddedIngestionOptions, IngestionApi, IngestionHandle } from './embeddedIngestionTypes.js';

export interface ResolvedEmbeddedIngestion {
    config: IngestHostConfig;
    autoRun: boolean;
    /** True when only the env flag asked for ingestion (no option): a start failure then degrades instead of throwing. */
    envOnly: boolean;
}

function bad(name: string, why: string): never { throw new RangeError(`createLore({ ingestion }): ${name} ${why}`); }

function checkStrings(name: string, v: unknown): string[] {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) bad(name, 'must be an array of non-empty strings');
    return (v as string[]).map((x) => x.trim());
}

/** Pure: option + env -> config (null = ingestion off). Options win over env; callback env is never read. */
export function resolveEmbeddedIngestion(opt: EmbeddedIngestionOption | undefined, env: NodeJS.ProcessEnv = process.env): ResolvedEmbeddedIngestion | null {
    if (opt === false) return null;
    const o: EmbeddedIngestionOptions | undefined = typeof opt === 'object' && opt !== null ? opt : undefined;
    if (o && o.enabled === false) return null;
    const explicit = opt === true || o !== undefined;
    if (!explicit && !isIngestionEnabled(env)) return null;

    const base = loadIngestHostConfig(env);
    const defaults = loadIngestHostConfig({});
    const c: IngestHostConfig = {
        ...base,
        enabled: true,
        // The listener is explicit-only for an embedded host: drop everything the env supplied for it.
        callback: { ...defaults.callback },
    };
    let autoRun = true;
    if (o) {
        if (o.workspaces !== undefined) c.workspaces = checkStrings('workspaces', o.workspaces);
        if (o.hostedWorkspaces !== undefined) c.hostedWorkspaces = checkStrings('hostedWorkspaces', o.hostedWorkspaces);
        if (o.localLlm !== undefined) {
            if (typeof o.localLlm?.url !== 'string' || typeof o.localLlm?.model !== 'string' || !o.localLlm.url || !o.localLlm.model) bad('localLlm', 'needs a url and a model');
            c.localLlm = { url: o.localLlm.url, model: o.localLlm.model };
        }
        applyExtractOptions(c, o);
        if (o.hostedStructuring !== undefined) {
            if (typeof o.hostedStructuring?.url !== 'string' || !o.hostedStructuring.url) bad('hostedStructuring', 'needs a url');
            c.hostedStructuring = { url: o.hostedStructuring.url, token: o.hostedStructuring.token ? new Secret(o.hostedStructuring.token) : null };
        }
        if (o.enqueueMaxBytes !== undefined) {
            const n = o.enqueueMaxBytes;
            if (!Number.isInteger(n) || n < 1_024 || n > 512 * 1024 * 1024) bad('enqueueMaxBytes', 'must be an integer in [1024, 536870912]');
            c.enqueue = { maxBytes: n };
        }
        if (o.scheduler !== undefined) {
            const { autoRun: ar, ...rest } = o.scheduler;
            if (ar !== undefined) { if (typeof ar !== 'boolean') bad('scheduler.autoRun', 'must be a boolean'); autoRun = ar; }
            const sch = { ...c.scheduler };
            for (const [k, v] of Object.entries(rest) as [keyof typeof SCHEDULER_BOUNDS, unknown][]) {
                if (v === undefined) continue;
                const b = SCHEDULER_BOUNDS[k];
                if (!b) bad(`scheduler.${String(k)}`, 'is not a known scheduler setting');
                if (typeof v !== 'number' || !Number.isFinite(v) || v < b[0] || v > b[1]) bad(`scheduler.${k}`, `must be a number in [${b[0]}, ${b[1]}]`);
                sch[k] = v;
            }
            c.scheduler = sch;
        }
        if (o.callback !== undefined) {
            const cb = o.callback;
            if (!Number.isInteger(cb.port) || cb.port < 0 || cb.port > 65_535) bad('callback.port', 'must be an integer in [0, 65535]');
            if (typeof cb.masterSecret !== 'string' || cb.masterSecret === '') bad('callback.masterSecret', 'is required');
            if (typeof cb.publicBaseUrl !== 'string' || cb.publicBaseUrl === '') bad('callback.publicBaseUrl', 'is required');
            if (cb.scheme !== undefined && !['bearer', 'lore-hmac', 'standard-webhooks'].includes(cb.scheme)) bad('callback.scheme', 'is not a known scheme');
            c.callback = {
                ...defaults.callback, port: cb.port, bind: cb.bind?.trim() || defaults.callback.bind, publicBaseUrl: cb.publicBaseUrl,
                masterSecret: new Secret(cb.masterSecret), webhookSecret: cb.webhookSecret ? new Secret(cb.webhookSecret) : null,
                scheme: cb.scheme ?? defaults.callback.scheme,
            };
        }
    }
    return { config: c, autoRun, envOnly: !explicit };
}

function toHandle(host: IngestionHost): IngestionHandle {
    return {
        coordinatorFor: (ws) => host.coordinatorFor(ws),
        async getJob(ws, jobId) {
            if (host.workspaceState(ws) !== 'enabled') return undefined; // unknown / not-enabled workspace: no job to show, no store opened
            const job = await (await host.coordinatorFor(ws)).deps.store.getJob(jobId);
            return job && job.workspace === ws ? job : undefined;
        },
        async runDue(ws, limit) { return (await host.coordinatorFor(ws)).runDue(limit); },
        status: () => host.status() as ReturnType<IngestionHandle['status']>,
    };
}

function define(lore: object, key: string, value: unknown): void {
    Object.defineProperty(lore, key, { configurable: true, writable: true, enumerable: true, value });
}

/** Add `ingestion` (null when off) to an embedded instance and make its `dispose()` stop the host first. */
export async function attachIngestion<T extends LoreInstance>(lore: T, opt: EmbeddedIngestionOption | undefined, env: NodeJS.ProcessEnv = process.env): Promise<T & IngestionApi> {
    if ('ingestion' in lore) return lore as T & IngestionApi;
    let resolved: ResolvedEmbeddedIngestion | null;
    try { resolved = resolveEmbeddedIngestion(opt, env); } catch (e) { await lore.dispose('ingestion option rejected'); throw e; }
    if (!resolved) { define(lore, 'ingestion', null); return lore as T & IngestionApi; }

    let host: IngestionHost;
    try {
        host = await startIngestionHostWith(resolved.config, {
            lore: { nodeUpsert: (a) => lore.nodeUpsert(a) },
            graphRegistry: lore._daemon.getGraphRegistry(),
            deploymentMode: lore.deploymentMode,
            home: lore.dataHome,
            listWorkspaces: () => listWorkspaceNames(lore.dataHome),
            workspacePath: (ws) => getWorkspacePath(ws, lore.dataHome),
            autoRun: resolved.autoRun,
            dynamicEligibility: true,
        });
    } catch (e) {
        if (!resolved.envOnly) { await lore.dispose('ingestion failed to start'); throw e; }
        log.error(`[Ingest] failed to start (${e instanceof Error ? e.constructor.name : typeof e}); this instance continues without ingestion`);
        define(lore, 'ingestion', null);
        return lore as T & IngestionApi;
    }

    const baseDispose = lore.dispose.bind(lore);
    let stopped: Promise<void> | null = null;
    define(lore, 'dispose', async (reason?: string) => {
        stopped ??= host.stop(); // never throws; idempotent
        await stopped;
        await baseDispose(reason);
    });
    define(lore, 'ingestion', toHandle(host));
    return lore as T & IngestionApi;
}
