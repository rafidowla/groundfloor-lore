/**
 * createLinkService.ts - flag-gated factory for the link-on-arrival service.
 *
 * Returns null unless LORE_LINK_ON_ARRIVAL is on, so every host wires it with
 * one call and the flag-off path allocates nothing and opens no file. The queue
 * lives in its own SQLite file beside the other `.lore` stores - deliberately
 * not the outbox, so link backlog can never trip the `outbox_lag` write gate.
 */
import path from 'node:path';
import { applyDiscoveryOverrides, loadDiscoveryConfig, type LinkDiscoveryOption } from './discoveryConfig.js';
import { LinkDiscovery } from './discoveryRunner.js';
import { SqliteDiscoveryStore } from './discoveryStore.js';
import { LlmJudgeTyper, OpenAiCompatibleJudgeClient } from './judgeTyper.js';
import { NliTyper } from './nliTyper.js';
import { SqliteProposalStore } from './proposalStore.js';
import { RulesTyper, TypingCascade, type IRelationTyper } from './relationTyper.js';
import { listWorkspaceNames } from '../config/workspaces.js';
import { resolveWorkspaceGraphEngine } from '../engines/graphEngineSelector.js';
import type { OutboxStore } from '../outbox/types.js';
import { applyLinkOverrides, isLinkOnArrivalEnabled, loadLinkConfig, rebuildIdleYieldFor, type LinkRuntimeConfig } from './linkConfig.js';
import { LinkPruner } from './linkPruner.js';
import { SqlitePruneStore } from './linkPruneStore.js';
import { LinkRebuilder } from './linkRebuilder.js';
import { SqliteRebuildStore } from './linkRebuildStore.js';
import { LinkService } from './linkService.js';
import { drainLinkSpool } from './linkSpool.js';
import { SqliteLinkQueue } from './sqliteLinkQueue.js';
import { StoredVectorLinker, type LinkHandleResolver } from './storedVectorLinker.js';
import { embeddingProviderFingerprint } from '../providers/localEmbeddingProvider.js';
import type { EmbeddingProvider } from '../providers/types.js';

export const LINK_QUEUE_FILE = 'link-queue.sqlite';

export interface CreateLinkServiceOptions {
    /** The host's `.lore` directory (the queue file lives directly in it). */
    loreDir: string;
    /** Per-workspace graph + verbatim handles; null when the workspace cannot be opened. */
    resolveHandles: LinkHandleResolver;
    isBusy?: () => boolean;
    onError?: (message: string) => void;
    /** The provider whose vectors the Linker reads; its fingerprint is stamped on every inferred edge. */
    embeddingProvider?: Pick<EmbeddingProvider, 'modelId' | 'dtype'>;
    /** Overrides for tests; defaults come from the environment. */
    config?: LinkRuntimeConfig;
    env?: NodeJS.ProcessEnv;
    /**
     * Embedded hosts (`createLore({ linkOnArrival })`): an explicit on/off that WINS over `LORE_LINK_ON_ARRIVAL`.
     * Undefined (the daemon, and an embedded host that passed nothing) defers to the env flag, byte-identically.
     */
    enabled?: boolean;
    /** Embedded hosts: settings merged over the env-derived config (validated; see {@link applyLinkOverrides}). */
    overrides?: Partial<LinkRuntimeConfig>;
    /**
     * Links Loop D (discovery + relation typing). Undefined defers to `LORE_LINK_DISCOVERY` (default OFF). With it off no
     * discovery object, timer, table or file handle exists. Discovery can run with arrival linking OFF (that is its
     * main use: closing the gap Loop A left); then the service exists but `signal()` queues nothing.
     */
    discovery?: LinkDiscoveryOption;
    /** Discovery: the host's workspaces (a sweep visits these plus any it has seen). */
    listWorkspaces?: () => string[];
    /**
     * Async busy check per workspace (embed queue, outbox backlog...) on top of `isBusy` and the link queue. It gates BOTH Loop D
     * discovery and the Loop C rebuild's pause: with it, a host that is ingesting (embedding not yet on the link queue) is busy.
     * Absent => only the link queue and `isBusy` count.
     */
    discoveryBusy?: (workspace: string) => boolean | Promise<boolean>;
    /** Graph engine name of a workspace ('sqlite' | 'postgres' | ...), so the rebuild picks its per-engine idle pause. Absent = the base pause. */
    graphEngineOf?: (workspace: string) => string | null | undefined;
    /** Late-bound outbox of the host, used when a typing proposal is accepted (the outbox is built after this service). */
    getOutbox?: () => OutboxStore | null | undefined;
}

/** The slice of `CreateLoreOptions.linkOnArrival` this factory consumes: `true`/`false`, or an object (`enabled` defaults to true). */
export type LinkOnArrivalOption = boolean | (Partial<LinkRuntimeConfig> & { enabled?: boolean });

/** Maps the public `linkOnArrival` option onto the factory's `enabled` + `overrides` fields (one mapping for every host). */
export function linkServiceOptionFields(opt: LinkOnArrivalOption | undefined): Pick<CreateLinkServiceOptions, 'enabled' | 'overrides'> {
    if (opt === undefined) return {};
    if (typeof opt === 'boolean') return { enabled: opt };
    const { enabled, ...overrides } = opt;
    return { enabled: enabled ?? true, overrides };
}

/**
 * Host wiring for Links Loop D (shared by every host that builds a link service, keeps server.ts small): the discovery option,
 * the workspaces to sweep, a busy check over the embed queue + outbox (both are constructed AFTER the link service, so they
 * are read lazily; before they exist the host counts as busy) and the outbox used when a proposal is accepted.
 */
export function discoveryHostFields(
    option: LinkDiscoveryOption | undefined,
    dataHome: string,
    embedQueue: () => { depth(): number; hasPendingForWorkspace(ws: string): boolean },
    outboxStore: () => { listPendingForWorkspace?: (ws: string, limit: number) => Promise<unknown[]> } | undefined,
): Pick<CreateLinkServiceOptions, 'discovery' | 'listWorkspaces' | 'discoveryBusy' | 'getOutbox' | 'graphEngineOf'> {
    return {
        ...(option !== undefined ? { discovery: option } : {}),
        listWorkspaces: () => { try { return listWorkspaceNames(dataHome); } catch { return []; } },
        graphEngineOf: (ws) => resolveWorkspaceGraphEngine(ws, dataHome),
        discoveryBusy: async (ws) => {
            try {
                const q = embedQueue();
                if (q.depth() > 0 || q.hasPendingForWorkspace(ws)) return true;
                return !!(await outboxStore()?.listPendingForWorkspace?.(ws, 1))?.length;
            } catch { return true; }
        },
        getOutbox: () => { try { return outboxStore() as OutboxStore | undefined; } catch { return null; } },
    };
}

export function createLinkService(o: CreateLinkServiceOptions): LinkService | null {
    const env = o.env ?? process.env;
    const arrival = o.enabled ?? isLinkOnArrivalEnabled(env);
    const discoveryCfg = applyDiscoveryOverrides(loadDiscoveryConfig(env), o.discovery);
    if (!arrival && !discoveryCfg.enabled) return null;
    const fingerprint = o.embeddingProvider ? embeddingProviderFingerprint(o.embeddingProvider) : null;
    const config = o.config ?? applyLinkOverrides(loadLinkConfig(env, fingerprint, o.onError ? (m) => o.onError!(m) : undefined), o.overrides);
    const file = path.join(o.loreDir, LINK_QUEUE_FILE);
    const queue = new SqliteLinkQueue(file);
    const linker = new StoredVectorLinker(o.resolveHandles, config, fingerprint);
    const busy = (): boolean => { const c = queue.counts(); return c.ready > 0 || c.claimed > 0 || (o.isBusy?.() ?? false); };
    const rebuilder = new LinkRebuilder({
        store: new SqliteRebuildStore(file),
        substrate: linker,
        batchSize: config.rebuildBatchSize,
        yieldMs: config.rebuildYieldMs,
        idleYieldMs: (ws) => rebuildIdleYieldFor(config, o.graphEngineOf?.(ws)),
        maxWaitMs: config.rebuildMaxWaitMs,
        // Yield to arrival linking and to ingestion: queued / in-flight link work, a busy host, or embed / outbox work for the workspace.
        isBusy: async (ws) => busy() || (await o.discoveryBusy?.(ws)) === true,
        ...(o.onError ? { onError: o.onError } : {}),
        onWrote: (ws) => pruner.markDirty(ws),
    });
    // Soft per-node cap (off while maxLinksPerNode = 0): a background sweep trims over-cap nodes, yielding to ingestion.
    const pruner = new LinkPruner({
        store: new SqlitePruneStore(file),
        resolveHandles: o.resolveHandles,
        cap: () => config.maxLinksPerNode,
        batchSize: config.pruneBatchSize,
        isBusy: () => { const c = queue.counts(); return c.ready > 0 || c.claimed > 0 || (o.isBusy?.() ?? false); },
        ...(o.onError ? { onError: o.onError } : {}),
    });
    let discovery: LinkDiscovery | undefined;
    let proposals: SqliteProposalStore | undefined;
    if (discoveryCfg.enabled) {
        proposals = new SqliteProposalStore(file);
        const rules = new RulesTyper(discoveryCfg.supersedeSim);
        const typers: IRelationTyper[] = [rules];
        const nli = discoveryCfg.nli;
        if (nli.enabled && nli.model) typers.push(new NliTyper({ model: nli.model, minConfidence: nli.minConfidence, allowDownload: nli.allowDownload }));
        const j = discoveryCfg.judge;
        if (j.endpoint && j.model && j.budgetPerRun > 0) {
            try {
                const client = new OpenAiCompatibleJudgeClient({ endpoint: j.endpoint, model: j.model, hosted: j.hosted, timeoutMs: j.timeoutMs, apiKey: env.LORE_LINK_JUDGE_API_KEY?.trim() || null });
                typers.push(new LlmJudgeTyper({ client, model: j.model, minConfidence: j.minConfidence }));
            } catch (err) {
                o.onError?.(`link judge disabled: ${(err as Error).message}`);
            }
        }
        discovery = new LinkDiscovery({
            config: discoveryCfg,
            linkConfig: config,
            linker,
            store: new SqliteDiscoveryStore(file),
            proposals,
            cascade: new TypingCascade(typers, o.onError ? { onError: o.onError } : {}),
            rules,
            policyVersion: linker.currentStamp().policyVersion,
            addDuplicates: (ws, dups, now) => queue.addDuplicates(ws, dups, now),
            isBusy: async (ws) => busy() || (await o.discoveryBusy?.(ws)) === true,
            prepare: (ws) => svcRef!.ensureOptOutsReady(ws),
            ...(o.listWorkspaces ? { workspaces: o.listWorkspaces } : {}),
            onWrote: (ws) => pruner.markDirty(ws),
            ...(o.onError ? { onError: o.onError } : {}),
        });
    }
    let svcRef: LinkService | undefined;
    const svc = new LinkService({
        arrival,
        ...(discovery ? { discovery, discoveryIntervalMs: discoveryCfg.intervalMs } : {}),
        ...(proposals ? { proposals } : {}),
        ...(o.getOutbox ? { getOutbox: o.getOutbox } : {}),
        pruner,
        currentStamp: () => linker.currentStamp(),
        queue,
        linker,
        rebuilder,
        config,
        resolveGraph: async (workspace) => (await o.resolveHandles(workspace))?.graph ?? null,
        ...(o.isBusy ? { isBusy: o.isBusy } : {}),
        ...(o.onError ? { onError: o.onError } : {}),
    });
    svcRef = svc;
    svc.start();
    // Ids handed over by short-lived CLI processes (`lore migrate`): replay through signal() so opt-outs apply.
    drainLinkSpool(o.loreDir, svc, o.onError);
    return svc;
}
