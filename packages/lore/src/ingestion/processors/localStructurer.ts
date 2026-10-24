/**
 * ingestion/processors/localStructurer.ts — contract B adapter for any
 * OpenAI-compatible chat-completions server (LM Studio, vLLM, llama.cpp, ...).
 * Configuration only: base URL + model name. Synchronous (`done`).
 *
 * Sovereignty guard: this adapter declares itself `local`, so its base URL
 * must be loopback unless the operator sets `allowNonLoopback` (e.g. a GPU box
 * on the LAN). Otherwise a mis-set URL pointing at a public host would
 * silently bypass the `local-only` workspace policy.
 */
import {
    CONTRACT_B_VERSION, ProcessorError, type ItemAnnotation, type IStructureProcessor, type ProcessorOutcome,
    type StructureRequest, type StructureResult,
} from '../contracts.js';
import { postJson, type HttpConfig } from './http.js';

export interface LocalStructurerConfig {
    id: string;
    /** e.g. http://127.0.0.1:1234/v1 */
    baseUrl: string;
    model: string;
    http: HttpConfig;
    allowNonLoopback?: boolean;
    apiKey?: string;
}

export function isLoopbackHost(hostname: string): boolean {
    const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export class LocalStructureProcessor implements IStructureProcessor {
    readonly info: IStructureProcessor['info'];
    constructor(private readonly cfg: LocalStructurerConfig) {
        const u = new URL(cfg.baseUrl);
        if (!cfg.allowNonLoopback && !isLoopbackHost(u.hostname)) {
            throw new Error(`local structurer baseUrl ${u.origin} is not loopback; set allowNonLoopback to declare a LAN engine`);
        }
        this.info = { id: cfg.id, kind: 'structure', locality: 'local', version: cfg.model };
    }

    async structure(req: StructureRequest): Promise<ProcessorOutcome<StructureResult>> {
        const system = [
            'You extract structured data from a document. Answer with one JSON object only.',
            req.outputSchema ? `The object must conform to this JSON Schema:\n${JSON.stringify(req.outputSchema)}` : '',
            req.instructions ?? '',
        ].filter(Boolean).join('\n\n');
        const body = {
            model: this.cfg.model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: system }, { role: 'user', content: req.text }],
        };
        const url = this.cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
        const { json } = await postJson(this.cfg.http, url, body, this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {});
        const content = (json as any)?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new ProcessorError('local structurer returned no message content', false);
        let parsed: unknown;
        try { parsed = JSON.parse(content); } catch { throw new ProcessorError('local structurer returned non-JSON content', true); }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ProcessorError('local structurer returned a non-object', true);
        const obj = parsed as Record<string, unknown>;
        return { status: 'done', result: {
            contractVersion: CONTRACT_B_VERSION, jobId: req.jobId, content: obj,
            annotations: this.annotate(obj, req), incomplete: false, processor: this.info,
        } };
    }

    /** No quote verification here: every item is honestly flagged for review. */
    private annotate(content: Record<string, unknown>, req: StructureRequest): StructureResult['annotations'] {
        if (!req.itemPath) return null;
        let node: unknown = content;
        for (const k of req.itemPath.split('.').filter(Boolean)) node = (node as Record<string, unknown> | undefined)?.[k];
        if (!Array.isArray(node)) return null;
        const items: ItemAnnotation[] = node.slice(0, 10_000).map((_, index) => ({
            index, source_page: null, source_quote: null, quote_verified: false,
            confidence: { score: 0.5, level: 'Medium', reasons: ['local model output; quote not verified'] }, needs_review: true,
        }));
        return { items, rejected: [], document: { verifier: 'none' } };
    }
}
