/**
 * ingestion/worker/extractWorkerProtocol.ts - wire shapes shared by the extractor worker's front doors: the forked
 * child (IPC), the loopback HTTP worker, and the in-process path. The payload in both directions is the existing
 * `ExtractedContent` (engines/extractors/types.ts), so the parent maps a worker answer onto contract A with exactly
 * the code the in-process path uses.
 */
import type { ExtractedContent } from '../../engines/extractors/types.js';

/** Vision engine settings the worker needs. A local OpenAI-compatible chat/vision endpoint; loopback only. */
export interface WireVisionConfig {
    /** e.g. http://127.0.0.1:1234/v1 */
    baseUrl: string;
    model: string;
    /** Scanned PDFs: render and read at most this many pages. */
    maxPages: number;
    /** Per call timeout against the vision server. */
    timeoutMs?: number;
}

/** Config travels in this first IPC message, never in the child's environment. */
export interface WorkerInit {
    type: 'init';
    vision: WireVisionConfig | null;
    /** Refuse any file larger than this before an extractor sees it. */
    maxFileBytes: number;
    /** The child exits (after answering) once its RSS passes this, so a leaking native extractor cannot grow forever. 0 = never. */
    recycleRssMb: number;
}

export interface WireExtractRequest {
    type: 'extract';
    id: number;
    jobId: string;
    mimeType: string;
    fileName: string;
    bytes: Uint8Array;
}

export interface WireError { message: string; retryable: boolean; code?: string }

export type WireExtractResponse =
    | { type: 'result'; id: number; content: ExtractedContent }
    | { type: 'error'; id: number; error: WireError };

export type ParentToChild = WorkerInit | WireExtractRequest | { type: 'shutdown' };
export type ChildToParent = { type: 'ready' } | { type: 'init-error'; message: string } | WireExtractResponse;

export const WORKER_READY_TIMEOUT_MS = 30_000;

/** What the processor talks to: a forked child, or a separately run worker over loopback HTTP. */
export interface ExtractTransport {
    readonly kind: 'child' | 'url';
    /** Rejects with ProcessorError; `retryable` is true for crashes, hangs and busy workers. */
    extract(req: { jobId: string; mimeType: string; fileName: string; bytes: Buffer }): Promise<ExtractedContent>;
    /** Stops anything this transport owns. Idempotent, never throws. */
    dispose(): Promise<void>;
}
