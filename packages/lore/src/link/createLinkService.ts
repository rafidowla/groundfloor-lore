/**
 * createLinkService.ts - flag-gated factory for the link-on-arrival service.
 *
 * Returns null unless LORE_LINK_ON_ARRIVAL is on, so every host wires it with
 * one call and the flag-off path allocates nothing and opens no file. The queue
 * lives in its own SQLite file beside the other `.lore` stores - deliberately
 * not the outbox, so link backlog can never trip the `outbox_lag` write gate.
 */
import path from 'node:path';
import { applyLinkOverrides, isLinkOnArrivalEnabled, loadLinkConfig, type LinkRuntimeConfig } from './linkConfig.js';
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

export function createLinkService(o: CreateLinkServiceOptions): LinkService | null {
    const env = o.env ?? process.env;
    if (!(o.enabled ?? isLinkOnArrivalEnabled(env))) return null;
    const fingerprint = o.embeddingProvider ? embeddingProviderFingerprint(o.embeddingProvider) : null;
    const config = o.config ?? applyLinkOverrides(loadLinkConfig(env, fingerprint, o.onError ? (m) => o.onError!(m) : undefined), o.overrides);
    const file = path.join(o.loreDir, LINK_QUEUE_FILE);
    const queue = new SqliteLinkQueue(file);
    const linker = new StoredVectorLinker(o.resolveHandles, config, fingerprint);
    const rebuilder = new LinkRebuilder({
        store: new SqliteRebuildStore(file),
        substrate: linker,
        batchSize: config.rebuildBatchSize,
        yieldMs: config.rebuildYieldMs,
        maxWaitMs: config.rebuildMaxWaitMs,
        // Yield to arrival linking and to ingestion: any queued / in-flight link work, or a busy host.
        isBusy: () => { const c = queue.counts(); return c.ready > 0 || c.claimed > 0 || (o.isBusy?.() ?? false); },
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
    const svc = new LinkService({
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
    svc.start();
    // Ids handed over by short-lived CLI processes (`lore migrate`): replay through signal() so opt-outs apply.
    drainLinkSpool(o.loreDir, svc, o.onError);
    return svc;
}
