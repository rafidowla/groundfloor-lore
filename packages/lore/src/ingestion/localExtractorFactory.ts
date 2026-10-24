/**
 * ingestion/localExtractorFactory.ts - picks the sovereign extract processor for the host from its config.
 *
 *   extract.mode 'in-process' (default), no vision -> LocalExtractProcessor, exactly as before
 *   extract.mode 'in-process' + vision             -> same, plus the local vision engine and the size cap
 *   extract.mode 'child'                           -> WorkerExtractProcessor over a forked child this instance owns
 *   extract.mode 'url'                             -> WorkerExtractProcessor over a loopback worker URL
 *
 * Every variant registers under the same processor id, so queued jobs survive a setting change. A misconfiguration
 * (non-loopback vision or worker URL) never takes ingestion down: it is logged and the in-process path is used.
 */
import { log } from '../logger.js';
import type { IngestHostConfig } from './hostConfig.js';
import { LocalExtractProcessor } from './processors/localExtractor.js';
import { OpenAiVisionEngine } from './processors/localVision.js';
import { WorkerExtractProcessor } from './processors/workerExtractor.js';
import { ExtractWorkerClient } from './worker/extractWorkerClient.js';
import { HttpExtractWorkerClient } from './worker/httpExtractWorkerClient.js';
import type { WireVisionConfig } from './worker/extractWorkerProtocol.js';
import type { IExtractProcessor } from './contracts.js';

export type SovereignExtractor = IExtractProcessor & { dispose?(): Promise<void> };

function describeError(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export function buildSovereignExtractor(cfg: Pick<IngestHostConfig, 'extract' | 'vision'>, deps: { home?: string; fetchImpl?: typeof fetch } = {}): SovereignExtractor {
    const wire: WireVisionConfig | null = cfg.vision ? { baseUrl: cfg.vision.url, model: cfg.vision.model, maxPages: cfg.vision.maxPages, timeoutMs: cfg.vision.timeoutMs } : null;
    let vision: OpenAiVisionEngine | null = null;
    let usableWire = wire;
    if (wire) {
        try { vision = new OpenAiVisionEngine({ baseUrl: wire.baseUrl, model: wire.model, ...(wire.timeoutMs ? { timeoutMs: wire.timeoutMs } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }); }
        catch (e) { log.error(`[Ingest] local vision NOT enabled: ${describeError(e)}`); usableWire = null; }
    }
    const x = cfg.extract;
    if (x.mode === 'child') {
        return new WorkerExtractProcessor(new ExtractWorkerClient({
            vision: usableWire, maxFileBytes: x.maxFileBytes, maxMemoryMb: x.maxMemoryMb, timeoutMs: x.timeoutMs, ...(deps.home ? { home: deps.home } : {}),
        }));
    }
    if (x.mode === 'url' && x.url) {
        try { return new WorkerExtractProcessor(new HttpExtractWorkerClient({ url: x.url, timeoutMs: x.timeoutMs, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })); }
        catch (e) { log.error(`[Ingest] extract worker URL refused (${describeError(e)}); using the in-process extractors`); }
    }
    return vision ? new LocalExtractProcessor(undefined, { vision, visionMaxPages: usableWire?.maxPages ?? 25, maxFileBytes: x.maxFileBytes }) : new LocalExtractProcessor();
}
