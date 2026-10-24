/**
 * ingestion/ingestionHost.ts - the daemon-side owner of ingestion: one store + coordinator PER WORKSPACE,
 * the (optional) hardened callback listener, and the scheduler.
 *
 * Isolation: a coordinator only ever writes into its own workspace. Its memory and table ports refuse any
 * other workspace id, and the callback resolver hands a job to a coordinator only if the stored job names
 * that coordinator's workspace. Job ids embed the workspace, so a callback signed for workspace A's job
 * cannot be steered into B. Unknown job and bad signature are indistinguishable (401).
 *
 * The listener opens ONLY when: a callback port is configured, a hosted structurer is configured, at least
 * one workspace is `hosted-allowed`, the master secret is >= 32 bytes, and the public URL is valid. If any of
 * that fails the listener stays closed AND the hosted processor is not registered (fail closed); local
 * ingestion keeps working. Secrets never reach a log line or an error message.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { log } from '../logger.js';
import { resolveWorkspaceGraphEngine } from '../engines/graphEngineSelector.js';
import { FsBlobStore } from './blobStore.js';
import { startCallbackListener, type CallbackListener } from './callbackListener.js';
import { MIN_SECRET_BYTES, type IngestHostConfig } from './hostConfig.js';
import { makeAllowlist } from './endpointAllowlist.js';
import { IngestionCoordinator } from './coordinator.js';
import { loreMemoryPort, type MemoryWritePort } from './memoryWriter.js';
import { StaticPolicyProvider } from './policy.js';
import { buildSovereignExtractor, type SovereignExtractor } from './localExtractorFactory.js';
import { StructuringV2Processor } from './processors/hosted.js';
import { isLoopbackHost, LocalStructureProcessor } from './processors/localStructurer.js';
import { ProcessorRegistry } from './registry.js';
import { createIngestionStore } from './storeFactory.js';
import { DEFAULT_PURGE_BATCH, type IIngestionStore } from './store.js';
import type { TablePort } from './tableWriter.js';
import { TickLoop } from './tickLoop.js';

export const HOSTED_STRUCTURER_ID = 'hosted-structuring-v2';
export const LOCAL_STRUCTURER_ID = 'local-structuring';

export interface IngestionHostDeps {
    config: IngestHostConfig;
    lore: { nodeUpsert(a: any): Promise<any> };
    tableStorageFor?: (workspace: string) => Promise<Awaited<ReturnType<TablePort['forWorkspace']>>>;
    deploymentMode: string;
    /** The main daemon port: the callback listener refuses to share it. */
    mainPort?: number;
    /** LORE_HOME override (tests). */
    home?: string;
    listWorkspaces: () => string[];
    workspacePath: (workspace: string) => string;
    engineFor?: (workspace: string) => 'postgres' | 'sqlite';
    createStore?: typeof createIngestionStore;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    /**
     * Embedded hosts only (`createLore({ ingestion })`): false builds the coordinators but never starts the TickLoop, so
     * nothing runs in the background and the host drives `runDue` itself. Undefined (the daemon) starts the scheduler.
     */
    autoRun?: boolean;
    /**
     * Embedded hosts only: when no explicit workspace list is configured, a workspace is eligible if it is registered
     * NOW (an embedded app creates workspaces after boot), not only if it was registered at start. The daemon leaves
     * this unset and keeps its start-time set.
     */
    dynamicEligibility?: boolean;
}

export type ListenerState =
    | { state: 'off'; reason: string }
    | { state: 'refused'; reason: string }
    | { state: 'listening'; port: number; bind: string };

interface Plan { ok: boolean; reason: string; masterSecret?: Buffer; baseUrl?: string; hostedUrl?: URL }

function errClass(e: unknown): string { return e instanceof Error ? e.constructor.name : typeof e; }

export class IngestionHost {
    private readonly coordinators = new Map<string, IngestionCoordinator>();
    private readonly opening = new Map<string, Promise<IngestionCoordinator>>();
    private readonly eligible: Set<string>;
    private readonly policy = new StaticPolicyProvider();
    private readonly registry = new ProcessorRegistry();
    private readonly tick: TickLoop;
    private listener: CallbackListener | null = null;
    private listenerState: ListenerState = { state: 'off', reason: 'not configured' };
    private stopping = false;
    private masterSecret: Buffer = randomBytes(32); // replaced when the listener plan is valid; a throwaway otherwise (never used: no hosted processor is registered)
    private baseUrl = 'http://127.0.0.1:1';
    private extractor: SovereignExtractor | null = null;

    private constructor(private readonly d: IngestionHostDeps) {
        const c = d.config;
        const names = c.workspaces ?? (d.deploymentMode === 'local' ? d.listWorkspaces() : []);
        this.eligible = new Set(names);
        for (const ws of c.hostedWorkspaces) this.policy.set(ws, 'hosted-allowed');
        this.tick = new TickLoop({ onError: (task, cls) => log.warn(`[Ingest] scheduler task '${task}' failed (${cls}); will retry next interval`) });
    }

    static async start(d: IngestionHostDeps): Promise<IngestionHost> {
        const h = new IngestionHost(d);
        await h.init();
        return h;
    }

    status(): { workspaces: string[]; listener: ListenerState; hostedProcessor: boolean; extractor: { mode: 'in-process' | 'child' | 'url'; vision: boolean } } {
        const c = this.d.config;
        return {
            workspaces: [...this.coordinators.keys()], listener: this.listenerState, hostedProcessor: this.registry.getStructure(HOSTED_STRUCTURER_ID) !== undefined,
            extractor: { mode: c.extract.mode, vision: c.vision !== null },
        };
    }

    /**
     * Where a workspace stands for ingestion: `unknown` (not a registered workspace), `not_enabled` (registered but
     * not eligible for this host) or `enabled`. The enqueue route uses this to answer 404 vs 409 without opening a store.
     */
    workspaceState(ws: string): 'unknown' | 'not_enabled' | 'enabled' {
        let registered = false;
        try { registered = this.d.listWorkspaces().includes(ws); } catch { registered = false; }
        if (!registered) return 'unknown';
        return this.isEligible(ws) ? 'enabled' : 'not_enabled';
    }

    private isEligible(ws: string): boolean {
        if (this.eligible.has(ws)) return true;
        if (!this.d.dynamicEligibility || this.d.config.workspaces !== null || this.d.deploymentMode !== 'local') return false;
        try { return this.d.listWorkspaces().includes(ws); } catch { return false; }
    }

    /** Largest decoded file the admin enqueue route accepts (LORE_INGEST_ENQUEUE_MAX_BYTES). */
    enqueueMaxBytes(): number { return this.d.config.enqueue.maxBytes; }

    private plan(): Plan {
        const c = this.d.config;
        const cb = c.callback;
        if (cb.port === null) return { ok: false, reason: 'LORE_INGEST_CALLBACK_PORT not set' };
        if (!c.hostedStructuring) return { ok: false, reason: 'no hosted processor configured' };
        if (c.hostedWorkspaces.length === 0) return { ok: false, reason: 'no workspace is hosted-allowed' };
        if (!cb.masterSecret || cb.masterSecret.byteLength < MIN_SECRET_BYTES) {
            return { ok: false, reason: `callback master secret missing or shorter than ${MIN_SECRET_BYTES} bytes` };
        }
        if (cb.scheme === 'standard-webhooks' && !cb.webhookSecret) return { ok: false, reason: 'scheme standard-webhooks needs a webhook secret' };
        let base: URL;
        try { base = new URL(cb.publicBaseUrl ?? ''); } catch { return { ok: false, reason: 'LORE_INGEST_CALLBACK_PUBLIC_URL missing or invalid' }; }
        if (base.protocol !== 'https:' && base.protocol !== 'http:') return { ok: false, reason: 'callback public URL must be http(s)' };
        let hosted: URL;
        try { hosted = new URL(c.hostedStructuring.url); } catch { return { ok: false, reason: 'hosted structuring URL is invalid' }; }
        if (hosted.protocol !== 'https:' && !(hosted.protocol === 'http:' && isLoopbackHost(hosted.hostname))) {
            return { ok: false, reason: 'hosted structuring URL must be https (http only for loopback)' };
        }
        return { ok: true, reason: '', masterSecret: Buffer.from(cb.masterSecret.reveal(), 'utf8'), baseUrl: base.toString().replace(/\/+$/, ''), hostedUrl: hosted };
    }

    private async init(): Promise<void> {
        const c = this.d.config;
        const plan = this.plan();
        const wantsListener = c.callback.port !== null && c.hostedStructuring !== null;
        if (plan.ok) {
            try {
                this.listener = await startCallbackListener({
                    resolve: (jobId) => this.resolveJob(jobId),
                    port: c.callback.port!, bind: c.callback.bind, ...(this.d.mainPort !== undefined ? { mainPort: this.d.mainPort } : {}),
                    maxConcurrent: c.callback.maxConcurrent, perIpPerMin: c.callback.perIpPerMin,
                    headersTimeoutMs: c.callback.headersTimeoutMs, requestTimeoutMs: c.callback.requestTimeoutMs,
                });
                this.masterSecret = plan.masterSecret!;
                this.baseUrl = plan.baseUrl!;
                this.listenerState = { state: 'listening', port: this.listener.port, bind: this.listener.bind };
                this.registerHosted(plan.hostedUrl!);
                log.info(`[Ingest] callback listener on ${this.listener.bind}:${this.listener.port}`);
            } catch (e) {
                const reason = e instanceof Error && e.name === 'CallbackListenerConfigError' ? e.message : `could not listen (${errClass(e)})`;
                this.listenerState = { state: 'refused', reason };
                log.error(`[Ingest] callback listener NOT started: ${reason}. Hosted processing is disabled; local ingestion continues.`);
            }
        } else if (wantsListener) {
            this.listenerState = { state: 'refused', reason: plan.reason };
            log.error(`[Ingest] callback listener NOT started: ${plan.reason}. Hosted processing is disabled; local ingestion continues.`);
        } else {
            this.listenerState = { state: 'off', reason: plan.reason };
        }
        this.extractor = buildSovereignExtractor(c, { ...(this.d.home ? { home: this.d.home } : {}), ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {}) });
        this.registry.registerExtract(this.extractor);
        this.registerLocalStructurer();

        for (const ws of this.eligible) {
            if (this.shouldOpenEagerly(ws)) {
                try { await this.coordinatorFor(ws); } catch (e) { log.error(`[Ingest] workspace '${ws}' not opened (${errClass(e)})`); }
            }
        }
        for (const co of this.coordinators.values()) await this.safeReclaim(co);
        this.startScheduler();
        log.info(`[Ingest] started: workspaces=${this.coordinators.size} hosted=${this.registry.getStructure(HOSTED_STRUCTURER_ID) ? 'yes' : 'no'} listener=${this.listenerState.state}`);
    }

    private registerHosted(url: URL): void {
        const c = this.d.config.hostedStructuring!;
        this.registry.registerStructure(new StructuringV2Processor({
            id: HOSTED_STRUCTURER_ID, endpoint: url.toString(), engineVersion: '2',
            ...(c.token ? { serviceToken: c.token.reveal() } : {}),
            http: { allowlist: makeAllowlist([url.origin]), ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {}) },
        }), { callbackScheme: this.d.config.callback.scheme });
    }

    private registerLocalStructurer(): void {
        const l = this.d.config.localLlm;
        if (!l) return;
        try {
            const u = new URL(l.url);
            this.registry.registerStructure(new LocalStructureProcessor({
                id: LOCAL_STRUCTURER_ID, baseUrl: l.url, model: l.model,
                http: { allowlist: makeAllowlist([u.origin]), ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {}) },
            }));
        } catch (e) { log.error(`[Ingest] local structurer not registered (${errClass(e)}): its URL must be a loopback http(s) URL`); }
    }

    private engineOf(ws: string): 'postgres' | 'sqlite' {
        return this.d.engineFor ? this.d.engineFor(ws) : (resolveWorkspaceGraphEngine(ws, this.d.home) === 'postgres' ? 'postgres' : 'sqlite');
    }

    /** SQLite stores open at boot only if their file already exists (a workspace nobody ingests into costs nothing). Postgres opens eagerly. */
    private shouldOpenEagerly(ws: string): boolean {
        if (this.engineOf(ws) === 'postgres') return true;
        try { return fs.existsSync(path.join(this.d.workspacePath(ws), 'ingestion.sqlite')); } catch { return false; }
    }

    /** The coordinator for a workspace, opened on first use. This is how an embedding caller enqueues. */
    coordinatorFor(ws: string): Promise<IngestionCoordinator> {
        if (this.stopping) return Promise.reject(new Error('ingestion host is stopping'));
        if (!this.isEligible(ws)) return Promise.reject(new Error(`workspace '${ws}' is not enabled for ingestion`));
        const have = this.coordinators.get(ws);
        if (have) return Promise.resolve(have);
        let p = this.opening.get(ws);
        if (!p) {
            p = this.open(ws).finally(() => { this.opening.delete(ws); });
            this.opening.set(ws, p);
        }
        return p;
    }

    private async open(ws: string): Promise<IngestionCoordinator> {
        const dir = this.d.workspacePath(ws);
        const engine = this.engineOf(ws);
        const store: IIngestionStore = await (this.d.createStore ?? createIngestionStore)({
            workspace: ws, sqlitePath: path.join(dir, 'ingestion.sqlite'), engine, ...(this.d.home ? { home: this.d.home } : {}),
        });
        const base = loreMemoryPort(this.d.lore);
        const memory: MemoryWritePort = {
            upsert: async (a) => a.workspace === ws ? base.upsert(a) : { ok: false, error: 'workspace_mismatch' },
        };
        const tables: TablePort = {
            forWorkspace: async (w) => (w === ws && this.d.tableStorageFor ? this.d.tableStorageFor(w) : null),
        };
        const sch = this.d.config.scheduler;
        const co = new IngestionCoordinator({
            store, registry: this.registry, policy: this.policy, blobs: new FsBlobStore(path.join(dir, 'ingestion-blobs')),
            memory, tables, callbackBaseUrl: this.baseUrl,
            callbackAuth: { masterSecret: this.masterSecret, ...(this.d.config.callback.webhookSecret ? { webhookSecret: this.d.config.callback.webhookSecret.reveal() } : {}), replayWindowSec: this.d.config.callback.replayWindowSec },
            leaseMs: sch.leaseMs, ...(this.d.now ? { now: this.d.now } : {}),
        });
        if (this.stopping) { await store.close().catch(() => undefined); throw new Error('ingestion host is stopping'); }
        this.coordinators.set(ws, co);
        return co;
    }

    /** Finds the coordinator owning a job. Unknown job => undefined (callers answer 401, same as a bad signature). */
    async resolveJob(jobId: string): Promise<IngestionCoordinator | undefined> {
        for (const [ws, co] of this.coordinators) {
            try {
                const job = await co.deps.store.getJob(jobId);
                if (job && job.workspace === ws) return co;
            } catch (e) { log.warn(`[Ingest] job lookup failed in workspace '${ws}' (${errClass(e)})`); }
        }
        return undefined;
    }

    private async safeReclaim(co: IngestionCoordinator): Promise<void> {
        try {
            const n = await co.reclaimStuck();
            if (n > 0) log.warn(`[Ingest] reclaimed ${n} job(s) whose worker stopped mid-run`);
        } catch (e) { log.warn(`[Ingest] reclaim failed (${errClass(e)})`); }
    }

    /** Run `fn` on every open coordinator; one workspace failing never starves the others. */
    private async each(fn: (co: IngestionCoordinator) => Promise<void>): Promise<void> {
        let firstErr: unknown;
        for (const [ws, co] of [...this.coordinators]) {
            if (this.stopping) return;
            try { await fn(co); } catch (e) { log.warn(`[Ingest] scheduled work failed in workspace '${ws}' (${errClass(e)})`); firstErr ??= e; }
        }
        if (firstErr !== undefined) throw firstErr instanceof Error ? firstErr : new Error('scheduled work failed');
    }

    private startScheduler(): void {
        const s = this.d.config.scheduler;
        this.tick.add({ name: 'run-due', intervalMs: s.runIntervalMs, run: () => this.each(async (co) => {
            for (let i = 0; i < 20 && !this.stopping; i++) { if ((await co.runDue(s.batch)).claimed < s.batch) break; }
        }) });
        this.tick.add({ name: 'reap-stale', intervalMs: s.reapIntervalMs, run: () => this.each(async (co) => { await co.reapStale(s.reapMaxAgeMs); }) });
        this.tick.add({ name: 'reclaim', intervalMs: s.reclaimIntervalMs, run: () => this.each(async (co) => { await this.safeReclaim(co); }) });
        this.tick.add({ name: 'purge-deliveries', intervalMs: s.purgeIntervalMs, run: () => this.each(async (co) => {
            for (let i = 0; i < 20 && !this.stopping; i++) { if ((await co.deps.store.purgeOldDeliveries(co.now())) < DEFAULT_PURGE_BATCH) break; }
        }) });
        if (this.d.autoRun !== false) this.tick.start();
    }

    /** Scheduler, then listener, then stores - all bounded by `drainMs`. Never throws. */
    async stop(): Promise<void> {
        if (this.stopping) return;
        this.stopping = true;
        const drain = this.d.config.scheduler.drainMs;
        try { if (!(await this.tick.stop(Math.floor(drain / 2)))) log.warn('[Ingest] scheduler did not drain before the deadline'); } catch (e) { log.warn(`[Ingest] scheduler stop failed (${errClass(e)})`); }
        try { await this.listener?.close(Math.floor(drain / 2)); } catch (e) { log.warn(`[Ingest] listener close failed (${errClass(e)})`); }
        for (const p of [...this.opening.values()]) { try { await p; } catch { /* open failed or was refused: nothing to close */ } }
        for (const [ws, co] of this.coordinators) {
            try { await co.deps.store.close(); } catch (e) { log.warn(`[Ingest] store close failed for '${ws}' (${errClass(e)})`); }
        }
        this.coordinators.clear();
        // After the scheduler has drained: nothing can be mid-extraction, so a child worker is stopped and reaped here.
        try { await this.extractor?.dispose?.(); } catch (e) { log.warn(`[Ingest] extractor stop failed (${errClass(e)})`); }
    }
}
