/**
 * ingestion/processors/workerExtractor.ts - contract A adapter that runs the sovereign extractors in a SEPARATE
 * process: a child owned by this Lore instance, or a separately run worker over a loopback URL.
 *
 * It keeps the in-process extractor's id (`lore-local-extractors`), so jobs queued before the setting was turned on
 * or off still find their processor. Only `info.version` tells the paths apart. Locality is `local`: the bytes never
 * leave this machine (a loopback worker is on this host; a vision model is a loopback endpoint too).
 */
import { buildDefaultRegistry } from '../../engines/extractors/index.js';
import type { ExtractorRegistry } from '../../engines/extractors/registry.js';
import { ProcessorError, type ExtractRequest, type ExtractResult, type IExtractProcessor, type ProcessorOutcome } from '../contracts.js';
import type { ExtractTransport } from '../worker/extractWorkerProtocol.js';
import { LOCAL_EXTRACTOR_ID, toExtractResult } from './localExtractor.js';

export class WorkerExtractProcessor implements IExtractProcessor {
    readonly info: IExtractProcessor['info'];
    /** Only used to answer `supports()` without a round trip; the worker owns the real extraction. */
    constructor(private readonly transport: ExtractTransport, private readonly registry: ExtractorRegistry = buildDefaultRegistry()) {
        this.info = { id: LOCAL_EXTRACTOR_ID, kind: 'extract', locality: 'local', version: `worker-${transport.kind}.1` };
    }

    supports(mimeType: string): boolean { return this.registry.findByMime(mimeType) !== null; }

    async extract(req: ExtractRequest): Promise<ProcessorOutcome<ExtractResult>> {
        if (!req.bytes) throw new ProcessorError('local extractor needs file bytes', false);
        const out = await this.transport.extract({ jobId: req.jobId, mimeType: req.mimeType, fileName: req.fileName, bytes: req.bytes });
        return { status: 'done', result: toExtractResult(req, out, this.info) };
    }

    dispose(): Promise<void> { return this.transport.dispose(); }
}
