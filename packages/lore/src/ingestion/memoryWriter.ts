/**
 * ingestion/memoryWriter.ts — extracted text -> memories through the NORMAL
 * write path (`LoreInstance.nodeUpsert`), so every chunk flows into embedding,
 * the outbox and autolinking exactly like any other write.
 *
 * Ids are deterministic (job id + chunk index): a retry or a duplicate
 * callback rewrites the same nodes instead of multiplying them.
 *
 * Provenance lives in node metadata: source file id + name + hash, page or
 * timestamp range, processor id + version + locality, job id, contract version.
 */
import { createHash } from 'node:crypto';
import type { ExtractResult, TextChunk } from './contracts.js';
import type { SourceRecord } from './store.js';

export interface MemoryWritePort {
    upsert(a: { id: string; workspace: string; ecosystem: string; nodeData: Record<string, unknown> }): Promise<{ ok: boolean; error?: string }>;
}

/** Adapt a LoreInstance (or anything with the same nodeUpsert) to the port. */
export function loreMemoryPort(lore: { nodeUpsert(a: any): Promise<any> }, opts: { asyncEmbed?: boolean } = {}): MemoryWritePort {
    return {
        async upsert(a) {
            const r = await lore.nodeUpsert({ ...a, asyncEmbed: opts.asyncEmbed ?? true });
            return r?.ok === false ? { ok: false, error: String(r.error?.message ?? r.code ?? 'nodeUpsert failed') } : { ok: true };
        },
    };
}

export const MAX_MEMORY_CHARS = 8000;

/** Split on paragraph boundaries into pieces no longer than `max` (hard split as a last resort). */
export function splitForMemory(text: string, max = MAX_MEMORY_CHARS): string[] {
    const t = text.trim();
    if (!t) return [];
    if (t.length <= max) return [t];
    const out: string[] = []; let cur = '';
    const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
    for (const para of t.split(/\n{2,}/)) {
        if (para.length > max) {
            push();
            for (let i = 0; i < para.length; i += max) out.push(para.slice(i, i + max));
        } else if (cur.length + para.length + 2 > max) { push(); cur = para; } else { cur = cur ? cur + '\n\n' + para : para; }
    }
    push();
    return out;
}

export function memoryNodeId(jobId: string, index: number): string {
    return 'ingest_' + createHash('sha256').update(`${jobId}\0${index}`).digest('hex').slice(0, 32);
}

export interface MemoryWriteResult { written: number; failed: number; nodeIds: string[] }

export async function writeExtractedMemories(opts: {
    port: MemoryWritePort; ecosystem: string; source: SourceRecord; jobId: string; result: ExtractResult;
}): Promise<MemoryWriteResult> {
    const { port, ecosystem, source, jobId, result } = opts;
    const base: TextChunk[] = result.chunks.length > 0 ? result.chunks : [{ text: result.text }];
    const pieces: Array<{ text: string; chunk: TextChunk }> = [];
    for (const c of base) for (const p of splitForMemory(c.text)) pieces.push({ text: p, chunk: c });

    const nodeIds: string[] = []; let failed = 0;
    for (let i = 0; i < pieces.length; i++) {
        const { text, chunk } = pieces[i]!;
        const id = memoryNodeId(jobId, i);
        const where = chunk.page !== undefined ? ` p.${chunk.page}` : chunk.startSeconds !== undefined ? ` @${Math.round(chunk.startSeconds)}s` : '';
        const provenance = {
            ingestion: {
                sourceId: source.sourceId, sourceFileName: source.fileName, sourceSha256: source.sha256, mimeType: source.mimeType,
                page: chunk.page ?? null, startSeconds: chunk.startSeconds ?? null, endSeconds: chunk.endSeconds ?? null,
                chunkIndex: i, chunkCount: pieces.length, jobId, contractVersion: result.contractVersion,
                processor: { id: result.processor.id, version: result.processor.version, locality: result.processor.locality },
                extractorConfidence: result.confidence,
            },
        };
        const r = await port.upsert({
            id, workspace: source.workspace, ecosystem,
            nodeData: {
                id, ecosystem, type: 'document_chunk', label: `${source.fileName}${where} [${i + 1}/${pieces.length}]`,
                content: text, tags: ['ingested', 'source:' + source.sourceId], project: source.workspace,
                metadata: JSON.stringify(provenance),
            },
        });
        if (r.ok) nodeIds.push(id); else failed++;
    }
    return { written: nodeIds.length, failed, nodeIds };
}
