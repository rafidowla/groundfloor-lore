/**
 * modelServer/hostWiring.ts — Lore 3.24 review fix SF12.
 *
 * `mcp/server.ts`'s `createLore()` is at its ~1810-line size cap
 * (CLAUDE.md's per-file budget), and the 3.24 review (review-324.md,
 * finding SF12) found the model-server wiring there packed into a handful
 * of ~600-char lines to stay under that cap instead of being properly
 * formatted call sites — which games the size budget rather than meeting
 * its intent.
 *
 * This module is the fix: it wraps `applicability.ts`'s
 * `attachModelServer()` / `withModelStatusMeta()` into ONE call
 * (`attachHostModelServer`) that `createLore()` can invoke as a normal,
 * short call site. The previously-inline rerank-backend fallback
 * (`opts.rerankBackend ?? modelServerAttachment.rerankBackend ??
 * localRerankBackend`) and the dispose-hook try/catch move here too, since
 * both are part of the same "attach" concern.
 *
 * Pure packaging — no new behavior. See `applicability.ts` for the actual
 * eligibility gate and attach/dispose logic this only assembles.
 */

import type { EmbeddingProvider } from '../providers/types.js';
import { attachModelServer, withModelStatusMeta, type PublicModelStatus } from './applicability.js';
import { localRerankBackend, type RerankBackend } from '../recall/rerankBackend.js';
import { loreHome } from '../config/loreHome.js';

export interface HostModelWiringOptions {
    deploymentMode: 'local' | 'cloud';
    embeddingProvider: EmbeddingProvider;
    injectedEmbeddingProvider: boolean;
    /** `CreateLoreOptions.modelServer` passthrough — `false` opts this
     *  instance out regardless of env. */
    modelServer?: boolean;
    onModelStatus?: (status: PublicModelStatus) => void;
    /** `CreateLoreOptions.rerankBackend` — an explicit host override always
     *  wins over the shared backend (see applicability.ts's header). */
    rerankBackendOverride?: RerankBackend;
    log?: { warn(msg: string): void; error(msg: string): void; info(msg: string, ctx?: Record<string, unknown>): void; debug?(msg: string): void };
}

export interface HostModelWiring {
    /** Original provider (ineligible/disabled) or a `SharedEmbeddingProvider`
     *  wrapping it (eligible). */
    embeddingProvider: EmbeddingProvider;
    /** Resolved once: `rerankBackendOverride ?? (shared attach's backend) ??
     *  localRerankBackend`. Never reassigned by callers. */
    rerankBackend: RerankBackend;
    modelStatus(): PublicModelStatus;
    /** Wraps an `inProcessRecall`-shaped call so `_meta.models` is added
     *  while degraded (applicability.ts's `withModelStatusMeta`, pre-bound
     *  to this attachment's `modelStatus()`). */
    wrapRecall<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R>;
    /** Never throws — internal errors are swallowed (never a shared server
     *  process to worry about outliving this host, only this host's own
     *  client connection/probe timer). Safe to await unconditionally. */
    dispose(): Promise<void>;
}

/**
 * ONE call site for `createLore()` to attach the shared local model server
 * (or get a no-op passthrough when ineligible/disabled — see
 * `applicability.ts`). Reads `loreHome()` — the MACHINE-level home (same as
 * the models cache, CLI, search worker) — deliberately NOT `dataHome`:
 * per-dataDir keys would mean one server per embedder, defeating the point
 * of a shared server.
 */
export function attachHostModelServer(opts: HostModelWiringOptions): HostModelWiring {
    const modelServerAttachment = attachModelServer({
        loreHome: loreHome(),
        deploymentMode: opts.deploymentMode,
        embeddingProvider: opts.embeddingProvider,
        injectedEmbeddingProvider: opts.injectedEmbeddingProvider,
        modelServer: opts.modelServer,
        onModelStatus: opts.onModelStatus,
        log: opts.log,
    });
    // D8d/3.24 Part C: an explicit host-supplied rerankBackend always wins
    // over the shared attachment's backend, which in turn wins over the
    // plain local default.
    const rerankBackend = opts.rerankBackendOverride ?? modelServerAttachment.rerankBackend ?? localRerankBackend;
    return {
        embeddingProvider: modelServerAttachment.embeddingProvider,
        rerankBackend,
        modelStatus: modelServerAttachment.modelStatus,
        wrapRecall: (fn) => withModelStatusMeta(fn, modelServerAttachment.modelStatus),
        dispose: async () => {
            try {
                await modelServerAttachment.dispose();
            } catch {
                /* non-fatal — never a shared server process, only this
                 * host's client connection/probe timer. */
            }
        },
    };
}
