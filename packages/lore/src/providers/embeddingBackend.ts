/**
 * embeddingBackend.ts — runtime probe for the ONNX execution backend.
 *
 * Why this exists:
 *   `@huggingface/transformers` v4 on Node.js routes its ONNX inference
 *   through `onnxruntime-node` (native C++) automatically — not the
 *   browser-side `onnxruntime-web` (Wasm). The picker banner used to
 *   say "Wasm CPU" because the v3 wrapper ran Wasm on Node. That label
 *   has been wrong since the v4 upgrade. This module replaces it with
 *   ground truth: probe `onnxruntime-node` once, return what's actually
 *   available, surface it on `/health`.
 *
 * Why not just rebuild a direct-ORT provider:
 *   The original v1.1 deferred item #3 ("native onnxruntime-node
 *   provider") assumed Lore was on Wasm. It isn't — has not been since
 *   the v4 transformers upgrade landed in slice 7. The remaining
 *   speedup left on the table for this layer is the CoreML execution
 *   provider on Apple Silicon (~2-5× over CPU), and that needs a
 *   prebuilt EP binary in the npm package — non-trivial scope. The
 *   current onnxruntime-node ships with CPU EP only. We surface that
 *   honestly so operators know what they're on.
 *
 * Usage:
 *   const info = await probeEmbeddingBackend();
 *   console.error(`[Lore] ORT backend: ${info.runtime} ${info.version}`);
 *   console.error(`[Lore] Available execution providers: ${info.providers.join(', ')}`);
 *
 * License: original work for groundfloor-lore.
 */

export interface EmbeddingBackendInfo {
    /** Which ORT package is actually doing inference. */
    runtime: 'onnxruntime-node' | 'onnxruntime-web' | 'unknown';
    /** Package version, e.g., "1.24.3". Empty string if unknown. */
    version: string;
    /**
     * Execution providers compiled into this build. On macOS with the
     * current onnxruntime-node 1.24.3 this is just ['cpu']. CoreML EP
     * arrives in a future onnxruntime-node release we'd need to pin.
     */
    providers: string[];
    /**
     * Friendly label for log banners + /health. Format matches the
     * style of the picker banner so the two stay readable side-by-side.
     */
    label: string;
    /** True if the probe failed and we couldn't detect anything. */
    unknown: boolean;
}

let cached: EmbeddingBackendInfo | null = null;

/**
 * Probe the ONNX runtime backend in use. Cached after the first call —
 * the answer is stable for the process lifetime.
 *
 * Always succeeds; returns `{ unknown: true }` on probe failure rather
 * than throwing. The daemon's startup path treats this as best-effort
 * telemetry, not a critical dependency.
 */
export async function probeEmbeddingBackend(): Promise<EmbeddingBackendInfo> {
    if (cached) return cached;

    try {
        // Dynamic-import via @huggingface/transformers' transitive dep on
        // onnxruntime-node, which is already loaded in the daemon process.
        // Importing it directly is fine — it's the same singleton.
        const ort = await import('onnxruntime-node');

        // Version constant lives at `version` on the module's index.
        const version = (ort as { version?: string }).version
            ?? (await import('onnxruntime-node/dist/version.js') as { version: string }).version
            ?? '';

        // listSupportedBackends() returns [{ name: 'cpu', bundled: true }, ...]
        // on the current build. Map to bare names.
        const listFn = (ort as { listSupportedBackends?: () => Array<{ name: string }> }).listSupportedBackends;
        const providers: string[] = typeof listFn === 'function'
            ? listFn().map((b) => b.name)
            : ['cpu']; // conservative fallback — onnxruntime-node always
                       // bundles CPU EP since 1.x

        cached = {
            runtime: 'onnxruntime-node',
            version,
            providers,
            label: `onnxruntime-node ${version} (${providers.join('+')})`,
            unknown: false,
        };
        return cached;
    } catch {
        // onnxruntime-node not loadable — we'd be on the browser-side
        // wasm build instead (only happens if a future rewrite changes
        // the entry point). Report honestly.
        cached = {
            runtime: 'unknown',
            version: '',
            providers: [],
            label: 'unknown ORT backend',
            unknown: true,
        };
        return cached;
    }
}

/** Synchronous accessor for the cached result. Returns null if probeEmbeddingBackend() hasn't been awaited yet. */
export function getCachedEmbeddingBackend(): EmbeddingBackendInfo | null {
    return cached;
}

/** Test-only: drop the cache so a subsequent probe re-runs. */
export function _resetEmbeddingBackendCacheForTests(): void {
    cached = null;
}
