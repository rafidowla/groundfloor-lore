/**
 * modelServer/applicability.ts — Lore 3.24 slice C2a. The host-wiring layer
 * between `mcp/server.ts`'s `createLore()` and the client pieces built
 * elsewhere in this directory (`client.ts`, `sharedEmbeddingProvider.ts`,
 * `recall/rerankBackend.ts`'s `sharedRerankBackend`).
 *
 * Kept as its own module (not inline in `mcp/server.ts`, which is at its
 * 1810-line cap) per D9 §5.6: this is where the "is the shared model
 * server even applicable to THIS instance" gate lives, plus the thin
 * orchestration that constructs a `ModelServerClient` and swaps it into
 * the embedding-provider / rerank-backend slots `createLore()` already has.
 *
 * Eligibility (D9 §5.6), ALL of the following must hold:
 *   - `deploymentMode === 'local'` (covers local + embedded runMode; cloud
 *     is out of scope for a machine-local model server).
 *   - The host did not inject its own `embeddingProvider` — only Lore's own
 *     `LocalEmbeddingProvider` is served; an injected provider is the
 *     host's own concern, and `strictFingerprintCheck` already treats it
 *     as untouchable.
 *   - `LORE_LOCAL_EMBEDDING_DEVICE` is unset or explicitly `cpu` — GPU/
 *     CoreML/WebGPU devices aren't process-shareable the way a CPU ONNX
 *     session is (see `providers/localEmbeddingProvider.ts`'s `LoadDevice`
 *     doc); NOTE that type isn't exported, so this checks the SAME env var
 *     `embeddingProviderFactory.ts` reads to build the option, not the
 *     provider instance's own (private) `device` field.
 *   - Not a test process (`isTestProcess()`), UNLESS `LORE_MODEL_SERVER=1`
 *     explicitly opts a test run in (this slice's own tests do that).
 *   - Not explicitly disabled: `opts.modelServer !== false` and
 *     `LORE_MODEL_SERVER !== '0'`.
 *
 * When any of these fails, `attachModelServer()` is a no-op passthrough:
 * the original embedding provider, no rerank-backend override (caller
 * falls through to `localRerankBackend`), and a `modelStatus()` that
 * always reports `{mode:'in_process'}` — no `ModelServerClient` is ever
 * constructed, so no lock file, no spawn attempt, nothing observable.
 */

import { LocalEmbeddingProvider } from '../providers/localEmbeddingProvider.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { isTestProcess } from '../config/loreHome.js';
import { ModelServerClient, type ModelServerClientOptions } from './client.js';
import { SharedEmbeddingProvider } from './sharedEmbeddingProvider.js';
import { sharedRerankBackend, type RerankBackend } from '../recall/rerankBackend.js';

/** Duplicated (not shared) — see modelServer/config.ts's identical
 *  `parseEnvInt` and this repo's "no misc.ts/utils.ts" file-size rule. */
function parseEnvInt(name: string, fallback: number, min: number): number {
    const raw = process.env[name];
    if (!raw || raw.trim() === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
}

/** ms budget for one spawn-or-connect attempt (first connect, and each
 *  reconnect). */
export const MODEL_SERVER_CLIENT_READY_MS = parseEnvInt('LORE_MODEL_SERVER_READY_MS', 10_000, 1);
/** Max reconnect attempts within one `ensureConnected()` call. */
export const MODEL_SERVER_CLIENT_RESTARTS = parseEnvInt('LORE_MODEL_SERVER_RESTARTS', 3, 1);
/** ms budget across retried reconnect attempts before falling back. */
export const MODEL_SERVER_CLIENT_RESTART_BUDGET_MS = parseEnvInt('LORE_MODEL_SERVER_RESTART_BUDGET_MS', 10_000, 1);
/** ms base interval for the background recovery probe once in fallback
 *  (doubles up to a 10-minute cap — see client.ts). */
export const MODEL_SERVER_CLIENT_PROBE_MS = parseEnvInt('LORE_MODEL_SERVER_PROBE_MS', 60_000, 1);
/** ms per-call deadline applied to embed calls (not rerank — see client.ts
 *  header). Default matches this slice's task spec verbatim. */
export const MODEL_SERVER_CLIENT_CALL_MS = parseEnvInt('LORE_MODEL_SERVER_CALL_MS', 120_000, 1);

/** Public status shape returned by `LoreInstance.modelStatus()` — a
 *  superset of `client.ts`'s `ModelStatus` adding the `'in_process'` mode
 *  for when no `ModelServerClient` was ever constructed (ineligible or
 *  disabled), which that narrower internal type has no reason to express. */
export interface PublicModelStatus {
    mode: 'shared' | 'fallback' | 'in_process';
    reason?: string;
    since: number;
    server?: { pid: number | null; key: string; socket: string };
}

export interface ModelServerAttachOptions {
    loreHome: string;
    deploymentMode: 'local' | 'cloud';
    embeddingProvider: EmbeddingProvider;
    injectedEmbeddingProvider: boolean;
    /** `CreateLoreOptions.modelServer` — `false` opts this instance out
     *  regardless of env. `undefined` defers to env/eligibility. */
    modelServer?: boolean;
    onModelStatus?: (status: PublicModelStatus) => void;
    log?: { warn(msg: string): void; error(msg: string): void; info?(msg: string, ctx?: Record<string, unknown>): void; debug?(msg: string): void };
    clientId?: string;
}

export interface ModelServerAttachment {
    /** Original provider (ineligible/disabled) or a `SharedEmbeddingProvider`
     *  wrapping it (eligible). Always safe to use as-is. */
    embeddingProvider: EmbeddingProvider;
    /** `undefined` when not attached — callers fall through to their own
     *  default (`localRerankBackend`), matching pre-3.24 behavior exactly. */
    rerankBackend: RerankBackend | undefined;
    modelStatus(): PublicModelStatus;
    dispose(): Promise<void>;
}

/**
 * Eligibility gate (D9 §5.6). Pure and side-effect-free — safe to call
 * before deciding whether to construct anything.
 */
export function isEligibleForSharedModelServer(opts: Pick<ModelServerAttachOptions, 'deploymentMode' | 'embeddingProvider' | 'injectedEmbeddingProvider' | 'modelServer'>): boolean {
    if (opts.modelServer === false) return false;
    if (process.env['LORE_MODEL_SERVER'] === '0') return false;
    if (opts.deploymentMode !== 'local') return false;
    if (opts.injectedEmbeddingProvider) return false;
    if (!(opts.embeddingProvider instanceof LocalEmbeddingProvider)) return false;
    const deviceRaw = (process.env['LORE_LOCAL_EMBEDDING_DEVICE'] ?? '').trim().toLowerCase();
    if (deviceRaw !== '' && deviceRaw !== 'cpu') return false;
    if (isTestProcess() && process.env['LORE_MODEL_SERVER'] !== '1') return false;
    return true;
}

const IN_PROCESS_SINCE = Date.now();

/**
 * Orchestrates the client-side attach: when ineligible/disabled, a no-op
 * passthrough (see file header); when eligible, constructs ONE
 * `ModelServerClient` for this Lore instance and wraps the embedding
 * provider + rerank backend around it.
 *
 * Never throws — `ModelServerClient` itself starts in `shared` mode
 * optimistically and only fails over lazily on first real call, so there
 * is nothing to await/fail here at attach time.
 */
export function attachModelServer(opts: ModelServerAttachOptions): ModelServerAttachment {
    if (!isEligibleForSharedModelServer(opts)) {
        return {
            embeddingProvider: opts.embeddingProvider,
            rerankBackend: undefined,
            modelStatus: () => ({ mode: 'in_process', since: IN_PROCESS_SINCE }),
            dispose: async () => { /* no client was ever constructed */ },
        };
    }
    const local = opts.embeddingProvider as LocalEmbeddingProvider;
    // SF10 (3.24 review, D9 §5.5.3): `shared` is declared before
    // `clientOpts` so the wrapped `onStatus` below can close over it —
    // `ModelServerClient` may invoke `onStatus` before `new
    // ModelServerClient(...)` even returns (see client.ts), so this can't
    // be sequenced the other way around.
    let shared: SharedEmbeddingProvider;
    let lastMode: PublicModelStatus['mode'] = 'shared';
    const clientOpts: ModelServerClientOptions = {
        loreHome: opts.loreHome,
        readyMs: MODEL_SERVER_CLIENT_READY_MS,
        restartBudgetMs: MODEL_SERVER_CLIENT_RESTART_BUDGET_MS,
        maxRestarts: MODEL_SERVER_CLIENT_RESTARTS,
        callMs: MODEL_SERVER_CLIENT_CALL_MS,
        probeMs: MODEL_SERVER_CLIENT_PROBE_MS,
        clientId: opts.clientId,
        log: opts.log,
        onStatus: (status) => {
            // Fallback→shared recovery: release the in-process fallback
            // model this instance lazily loaded while degraded. Guarded so
            // this only fires on the actual transition, not on every
            // status ping while already recovered.
            if (lastMode === 'fallback' && status.mode === 'shared') shared.releaseFallback();
            lastMode = status.mode;
            opts.onModelStatus?.(status);
        },
    };
    const client = new ModelServerClient(clientOpts);
    shared = new SharedEmbeddingProvider({
        modelId: local.modelId,
        dimension: local.dimension,
        dtype: local.dtype,
        // device intentionally omitted: eligibility already requires cpu
        // (unset/'cpu'), and SharedEmbeddingProvider only uses this for its
        // OWN local-fallback instance, which should load the same way any
        // other CPU-mode LocalEmbeddingProvider on this host would.
        client,
        log: opts.log,
    });
    return {
        embeddingProvider: shared,
        rerankBackend: sharedRerankBackend(client),
        modelStatus: () => client.status(),
        dispose: () => client.dispose(),
    };
}

/**
 * Wraps an `inProcessRecall`-shaped call so that, only while the given
 * `modelStatus()` reports `fallback`, the resolved result gets
 * `_meta.models = {served_by:'in_process_fallback', reason, since}` merged
 * in — absent entirely otherwise (byte-identical to pre-3.24 output), per
 * the established `RecallMeta` "present only when X" convention
 * (recall/recallPreset.ts). Deliberately a thin post-hoc wrapper rather
 * than threading a model-status dependency through `inProcessRecall.ts`'s
 * two internal paths (single-workspace / cross-workspace `runCrossWorkspaceRecall`)
 * — keeps this slice's diff out of that file entirely.
 */
export function withModelStatusMeta<A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
    modelStatus: () => PublicModelStatus,
): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
        const result = await fn(...args);
        const status = modelStatus();
        if (status.mode !== 'fallback' || result === null || typeof result !== 'object') return result;
        const withMeta = result as R & { _meta?: Record<string, unknown> };
        // Generic `R` has no concrete shape to excess-property-check against
        // here, so the merged object is cast back to `R` explicitly — safe
        // because every real caller's `R` (RecallResult) declares `_meta` as
        // an open-ended object (RecallMeta), and this only ever ADDS a key.
        return {
            ...withMeta,
            _meta: {
                ...(withMeta._meta ?? {}),
                models: { served_by: 'in_process_fallback', reason: status.reason, since: status.since },
            },
        } as R;
    };
}
