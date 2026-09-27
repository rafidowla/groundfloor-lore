/**
 * rerankBackend.ts — 3.24 Part B: the `RerankBackend` seam.
 *
 * Before this file, `rerankStage.ts`'s `applyRerankStageIfEnabled` inline-
 * constructed a `LocalRerankProvider` on every enabled call (see
 * docs/design/D9-shared-model-server.md §4). That's the ONLY thing this
 * file changes the shape of: `rerankStage.ts` now asks a `RerankBackend` for
 * a scorer instead of `new`-ing the provider itself. Every other part of the
 * existing fail-open contract — the `model_absent` filesystem pre-check
 * (`rerankModelCached`), the `testScorer` override, the timeout/abort
 * wrapping in `withTimeout`, `RerankBusyError`/`RerankIntegrityError`
 * mapping to `reason:'busy'`/`'integrity_failed'` — stays exactly where it
 * already lived, in `rerankStage.ts`. This module only owns *which*
 * `RerankScorer` function `rerankStage.ts` gets for a given call.
 *
 * Two backends exist today:
 *   - `local` (the default): wraps `LocalRerankProvider` exactly as
 *     `rerankStage.ts` used to construct it inline — same options, same
 *     `.score()` call, no behavior change.
 *   - test override (`setRerankScorerForTest`, unchanged, lives in
 *     `rerankStage.ts`): still takes precedence over any backend, checked
 *     before this module is ever consulted.
 *
 * A later 3.24 slice (Part C, the shared model server) adds a `shared`
 * backend here that RPCs a scorer request to the model server process
 * instead of loading `LocalRerankProvider` in-process. This module is
 * shaped for that addition: `RerankBackend` is a plain `{ scorer(cfg) }`
 * factory interface (not tied to `LocalRerankProvider`'s constructor shape),
 * so a `shared` implementation only needs to satisfy the same interface —
 * nothing in `rerankStage.ts` or the per-instance selection plumbing below
 * needs to change when that lands. Not built here per this slice's scope.
 *
 * Per-instance selection: `RerankBackend` is threaded from
 * `CreateLoreOptions.rerankBackend` (mcp/server.ts's `createLore()`) through
 * the same per-instance deps path `workspaceVerbatimResolver` already uses
 * — `DaemonWiring` → `SearchToolsDeps` / `InProcessRecallDeps` →
 * `RetrieveContext` → `retrieve.ts` → `applyRerankStageIfEnabled`. A Lore
 * instance created with no `rerankBackend` option gets `localRerankBackend`
 * (this file's default export const), matching pre-3.24 behavior exactly.
 */

import { LocalRerankProvider, RerankBusyError, RerankIntegrityError } from '../providers/localRerankProvider.js';
import type { RerankConfig } from './rerankConfig.js';
import type { RerankScorer } from './rerankStage.js';
import { ModelServerError } from '../modelServer/protocol.js';
import type { ModelServerClient } from '../modelServer/client.js';
import { ModelServerUnavailableError } from '../modelServer/client.js';

/**
 * A `RerankBackend` hands `rerankStage.ts` a `RerankScorer` for one call,
 * given the resolved config (model/dtype/cacheDir-relevant fields). It does
 * NOT perform the `model_absent` cache check or timeout/error-taxonomy
 * mapping — those stay in `rerankStage.ts` and apply uniformly regardless
 * of backend, since a `shared` backend will fail with the same
 * busy/timeout/error shapes a caller already knows how to fail open on.
 */
export interface RerankBackend {
    /** Human-readable id for logs — `'local'` today, `'shared'` in a later
     *  slice. Not part of any wire contract. */
    readonly kind: string;
    /**
     * Build (or fetch) a scorer for this call. `cacheDir` is the resolved
     * on-disk model cache root (`loreHomePath('models')`) — only meaningful
     * to a `local`-shaped backend; a future `shared` backend ignores it
     * (the model server owns its own cache).
     */
    scorer(cfg: Pick<RerankConfig, 'model' | 'dtype'>, cacheDir: string): RerankScorer;
}

/**
 * Default backend — wraps `LocalRerankProvider` exactly as `rerankStage.ts`
 * constructed it inline before this file existed:
 *   `new LocalRerankProvider({ modelId: cfg.model, dtype: cfg.dtype, cacheDir })`
 * then `(q, passages, signal) => provider.score(q, passages, signal)`.
 * `LocalRerankProvider`'s own constructor is cheap (the actual tokenizer/
 * model load is lazy + cached inside `score()`, per that file's
 * `providerCache`) — building a fresh instance per call, same as before,
 * is not a behavior change.
 */
export const localRerankBackend: RerankBackend = {
    kind: 'local',
    scorer(cfg, cacheDir) {
        const provider = new LocalRerankProvider({ modelId: cfg.model, dtype: cfg.dtype, cacheDir });
        return (q, passages, signal) => provider.score(q, passages, signal);
    },
};

/**
 * 3.24 Part C (slice C2a) — RPCs a scorer request to the shared model
 * server instead of loading `LocalRerankProvider` in-process. Per this
 * file's own header, `rerankStage.ts` needs ZERO changes: this backend
 * maps the wire-level `ModelServerError.code` back onto the SAME error
 * classes `rerankStage.ts` already pattern-matches on
 * (`RerankBusyError`/`RerankIntegrityError`), so its existing
 * catch/fail-open logic keeps working unmodified. The `model_absent`
 * pre-check stays local (unchanged, in `rerankStage.ts`, via
 * `rerankModelCached()` against the shared on-disk model cache) — this
 * backend is only reached once that check has already passed.
 *
 * On `ModelServerUnavailableError` (the client is in fallback mode) this
 * falls back to a fresh `LocalRerankProvider` for that one call — same
 * fail-open posture as every other rerank error, just sourced from the
 * client's own state instead of a wire-level error code.
 */
export function sharedRerankBackend(client: ModelServerClient): RerankBackend {
    return {
        kind: 'shared',
        scorer(cfg, cacheDir) {
            return async (query, passages, signal) => {
                try {
                    return await client.rerank({ modelId: cfg.model, dtype: cfg.dtype, cacheDir, query, passages }, signal);
                } catch (err) {
                    if (err instanceof ModelServerUnavailableError) {
                        const provider = new LocalRerankProvider({ modelId: cfg.model, dtype: cfg.dtype, cacheDir });
                        return provider.score(query, passages, signal);
                    }
                    if (err instanceof ModelServerError) {
                        if (err.code === 'busy') throw new RerankBusyError();
                        if (err.code === 'integrity_failed') throw new RerankIntegrityError(cfg.model, 'model-server');
                    }
                    throw err;
                }
            };
        },
    };
}
