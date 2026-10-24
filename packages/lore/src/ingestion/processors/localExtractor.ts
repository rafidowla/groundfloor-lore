/**
 * ingestion/processors/localExtractor.ts - contract A adapter over Lore's existing in-process extractors
 * (engines/extractors). Current behaviour is preserved: the same registry, same extractors, same output; this only
 * maps `ExtractedContent` onto `ExtractResult`.
 *
 * Optionally (`opts`, default off) the same in-process path adds a local vision engine and a file-size cap, through
 * the shared extraction core. With no `opts` the registry is called directly, exactly as before.
 */
import { buildDefaultRegistry } from '../../engines/extractors/index.js';
import type { ExtractorRegistry } from '../../engines/extractors/registry.js';
import type { ExtractedContent } from '../../engines/extractors/types.js';
import { CONTRACT_A_VERSION, ProcessorError, type ExtractRequest, type ExtractResult, type IExtractProcessor, type ProcessorInfo, type ProcessorOutcome } from '../contracts.js';
import { splitPages } from '../pages.js';
import { extractCore, makeCoreDeps, type ExtractCoreDeps } from '../worker/extractWorkerCore.js';
import type { VisionEngine } from './localVision.js';

export const LOCAL_EXTRACTOR_ID = 'lore-local-extractors';

/** Map an extractor's output onto contract A. Shared by the in-process path and the worker path, so both produce identical results. */
export function toExtractResult(req: ExtractRequest, out: ExtractedContent, processor: ProcessorInfo): ExtractResult {
    return {
        contractVersion: CONTRACT_A_VERSION,
        jobId: req.jobId,
        text: out.text,
        chunks: splitPages(out.text),
        confidence: out.confidence,
        mimeType: out.mimeType,
        processor,
        tables: out.tables?.map((t) => ({ headers: t.headers, rows: t.rows, position: t.position, confidence: t.confidence, caption: t.caption })),
        metadata: out.metadata,
    };
}

export interface LocalExtractOptions { vision?: VisionEngine | null; visionMaxPages?: number; maxFileBytes?: number }

export class LocalExtractProcessor implements IExtractProcessor {
    readonly info = { id: LOCAL_EXTRACTOR_ID, kind: 'extract' as const, locality: 'local' as const, version: 'in-process.1' };
    private readonly core: ExtractCoreDeps | null;
    constructor(private readonly registry: ExtractorRegistry = buildDefaultRegistry(), opts: LocalExtractOptions = {}) {
        this.core = opts.vision || opts.maxFileBytes ? makeCoreDeps({ registry, ...opts }) : null;
    }

    supports(mimeType: string): boolean { return this.registry.findByMime(mimeType) !== null; }

    async extract(req: ExtractRequest): Promise<ProcessorOutcome<ExtractResult>> {
        if (!req.bytes) throw new ProcessorError('local extractor needs file bytes', false);
        let out;
        try { out = this.core ? await extractCore(this.core, req.bytes, req.mimeType) : await this.registry.extract(req.bytes, req.mimeType); }
        catch (err) {
            if (err instanceof ProcessorError) throw err; // vision/HTTP failures carry their own retryable flag
            // Extractor failures on a given file are deterministic: retrying will not help.
            throw new ProcessorError(`extraction failed: ${(err as Error).message}`, false);
        }
        return { status: 'done', result: toExtractResult(req, out, this.info) };
    }
}
