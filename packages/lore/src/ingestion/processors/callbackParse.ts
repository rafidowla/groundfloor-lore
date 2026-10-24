/**
 * ingestion/processors/callbackParse.ts — validate processor callback bodies
 * (ai-api response envelope) into contract A / B results.
 *
 * Envelope: { data: { requestID, values: { content, annotations?, ... }, format }, status, statusCode, message }
 * The body is untrusted until the signature has been verified AND the
 * requestID matches the job; this module additionally bounds every shape it
 * accepts so a signed-but-buggy processor cannot corrupt the result writer.
 */
import {
    CONTRACT_A_VERSION, CONTRACT_B_VERSION, ProcessorError,
    type ExtractResult, type ItemAnnotation, type ProcessorInfo, type StructureAnnotations, type StructureResult,
} from '../contracts.js';
import { splitPages } from '../pages.js';
import { isRetryableStatus } from './http.js';

const isObj = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const MAX_TEXT_CHARS = 20_000_000;
export const MAX_ANNOTATION_ITEMS = 10_000;

function envelope(body: unknown, jobId: string): { values: Record<string, any>; format: unknown } {
    if (!isObj(body) || !isObj(body.data)) throw new ProcessorError('callback body has no data envelope', false);
    const statusCode = typeof body.statusCode === 'number' ? body.statusCode : 200;
    // A processor-reported failure. Keep the processor's own message short; never echo into logs unbounded.
    if (body.status === 'error' || statusCode >= 400) {
        // A structuring "incomplete" 422 still carries content: surfaced by the caller via allowPartial.
        throw new ProcessorError(`processor reported error ${statusCode}: ${String(body.message ?? '').slice(0, 300)}`, isRetryableStatus(statusCode), statusCode);
    }
    if (body.data.requestID !== jobId) throw new ProcessorError('callback requestID does not match job', false);
    if (!isObj(body.data.values)) throw new ProcessorError('callback has no values', false);
    return { values: body.data.values, format: body.data.format };
}

export function parseExtractCallback(body: unknown, jobId: string, processor: ProcessorInfo): ExtractResult {
    const { values } = envelope(body, jobId);
    const content = values.content;
    if (typeof content !== 'string') throw new ProcessorError('extract callback content is not a string', false);
    if (content.length > MAX_TEXT_CHARS) throw new ProcessorError('extract callback content too large', false);
    return {
        contractVersion: CONTRACT_A_VERSION, jobId, text: content, chunks: splitPages(content),
        confidence: 0.8, mimeType: 'text/plain', processor,
        metadata: { words: typeof values.totalWords === 'number' ? values.totalWords : undefined },
    };
}

function parseAnnotations(v: unknown): StructureAnnotations | null {
    if (v === null || v === undefined) return null;
    if (!isObj(v) || !Array.isArray(v.items)) throw new ProcessorError('annotations malformed', false);
    if (v.items.length > MAX_ANNOTATION_ITEMS) throw new ProcessorError('too many annotation items', false);
    const items: ItemAnnotation[] = v.items.map((a: unknown, n: number) => {
        if (!isObj(a) || !Number.isInteger(a.index) || a.index < 0) throw new ProcessorError(`annotation ${n} has no valid index`, false);
        const c = a.confidence;
        const score = isObj(c) && typeof c.score === 'number' ? Math.min(1, Math.max(0, c.score)) : 0;
        const level = isObj(c) && (c.level === 'High' || c.level === 'Medium' || c.level === 'Low') ? c.level : 'Low';
        return {
            index: a.index,
            source_page: Number.isInteger(a.source_page) ? a.source_page : null,
            source_quote: typeof a.source_quote === 'string' ? a.source_quote.slice(0, 2000) : null,
            quote_verified: typeof a.quote_verified === 'boolean' ? a.quote_verified : undefined,
            confidence: { score, level, reasons: isObj(c) && Array.isArray(c.reasons) ? c.reasons.filter((r: unknown) => typeof r === 'string').slice(0, 10) : [] },
            needs_review: a.needs_review !== false,
        };
    });
    return { items, rejected: Array.isArray(v.rejected) ? v.rejected.slice(0, 1000) : [], document: isObj(v.document) ? v.document : {} };
}

export function parseStructureCallback(body: unknown, jobId: string, processor: ProcessorInfo): StructureResult {
    const { values } = envelope(body, jobId);
    if (!isObj(values.content)) throw new ProcessorError('structure callback content is not an object', false);
    const annotations = parseAnnotations(values.annotations);
    return {
        contractVersion: CONTRACT_B_VERSION, jobId, content: values.content, annotations,
        incomplete: annotations?.document?.incomplete === true, processor,
    };
}
