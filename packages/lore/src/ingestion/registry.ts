/**
 * ingestion/registry.ts — processor registry with policy-gated selection.
 */
import type { IExtractProcessor, IStructureProcessor, ProcessorInfo } from './contracts.js';
import type { CallbackScheme } from './callbackAuth.js';
import { assertProcessorAllowed, type ProcessingPolicy } from './policy.js';

export class NoProcessorError extends Error {
    readonly code = 'no_processor';
    constructor(msg: string) { super(msg); this.name = 'NoProcessorError'; }
}

interface Entry<P> { processor: P; callbackScheme?: CallbackScheme }

export class ProcessorRegistry {
    private readonly extractors = new Map<string, Entry<IExtractProcessor>>();
    private readonly structurers = new Map<string, Entry<IStructureProcessor>>();

    registerExtract(p: IExtractProcessor, opts: { callbackScheme?: CallbackScheme } = {}): void {
        if (this.extractors.has(p.info.id)) throw new Error(`extractor '${p.info.id}' already registered`);
        this.extractors.set(p.info.id, { processor: p, callbackScheme: opts.callbackScheme });
    }
    registerStructure(p: IStructureProcessor, opts: { callbackScheme?: CallbackScheme } = {}): void {
        if (this.structurers.has(p.info.id)) throw new Error(`structurer '${p.info.id}' already registered`);
        this.structurers.set(p.info.id, { processor: p, callbackScheme: opts.callbackScheme });
    }

    getExtract(id: string): IExtractProcessor | undefined { return this.extractors.get(id)?.processor; }
    getStructure(id: string): IStructureProcessor | undefined { return this.structurers.get(id)?.processor; }
    info(id: string): ProcessorInfo | undefined { return (this.extractors.get(id) ?? this.structurers.get(id))?.processor.info; }
    callbackScheme(id: string): CallbackScheme | undefined { return (this.extractors.get(id) ?? this.structurers.get(id))?.callbackScheme; }

    /**
     * Pick the extractor for a mime type. Explicit id => that processor (policy-checked).
     * Otherwise the first LOCAL supporting processor; a hosted one only when the
     * workspace allows hosted AND no local processor supports the type.
     */
    selectExtract(workspace: string, policy: ProcessingPolicy, mime: string, preferredId?: string): IExtractProcessor {
        if (preferredId) {
            const p = this.getExtract(preferredId);
            if (!p) throw new NoProcessorError(`unknown extractor '${preferredId}'`);
            assertProcessorAllowed(workspace, policy, p.info);
            return p;
        }
        const all = [...this.extractors.values()].map((e) => e.processor).filter((p) => p.supports(mime));
        const local = all.find((p) => p.info.locality === 'local');
        if (local) return local;
        const hosted = all.find((p) => p.info.locality === 'hosted');
        if (hosted) { assertProcessorAllowed(workspace, policy, hosted.info); return hosted; }
        throw new NoProcessorError(`no extractor supports ${mime}`);
    }

    selectStructure(workspace: string, policy: ProcessingPolicy, preferredId: string): IStructureProcessor {
        const p = this.getStructure(preferredId);
        if (!p) throw new NoProcessorError(`unknown structurer '${preferredId}'`);
        assertProcessorAllowed(workspace, policy, p.info);
        return p;
    }
}
