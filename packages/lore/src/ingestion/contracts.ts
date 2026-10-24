/**
 * ingestion/contracts.ts — versioned processor contracts for the ingestion
 * coordinator (slice 1).
 *
 * Lore does not extract or structure documents itself as a database concern.
 * It stores, indexes, links and COORDINATES. Separate processors do the work:
 *
 *   contract A  (extract)    file bytes/reference  -> text
 *   contract B  (structure)  text + schema/profile -> structured fields
 *
 * Every processor has a local (sovereign) engine as the default; hosted
 * engines are opt-in per workspace (see policy.ts). Contract B matches the
 * response shape of ai-api "Structuring V2" (`data.values.content` is the
 * schema-shaped object, `data.values.annotations` carries per-item
 * provenance + confidence).
 *
 * Versioning: every request and result carries `contractVersion`. A change
 * that removes or re-types a field bumps the major; additive fields do not.
 * The coordinator refuses a processor that reports a different major.
 */

export const CONTRACT_A_VERSION = 'extract.v1' as const;
export const CONTRACT_B_VERSION = 'structure.v1' as const;

export type ProcessorKind = 'extract' | 'structure';

/** `local` runs on this machine / in-process; `hosted` leaves the machine. */
export type ProcessorLocality = 'local' | 'hosted';

export interface ProcessorInfo {
    /** Stable registry id, e.g. `lore-local-extractors`, `ai-api-extractor`. */
    id: string;
    kind: ProcessorKind;
    locality: ProcessorLocality;
    /** Engine/model version string recorded in provenance. */
    version: string;
}

/* ------------------------------------------------------------------ */
/*  Contract A — extract                                               */
/* ------------------------------------------------------------------ */

export interface ExtractRequest {
    contractVersion: typeof CONTRACT_A_VERSION;
    /** Coordinator job id. Echoed by the processor; the callback is bound to it. */
    jobId: string;
    workspace: string;
    sourceId: string;
    fileName: string;
    mimeType: string;
    /** The bytes. Local processors read these; hosted ones are given a fetch URL instead. */
    bytes?: Buffer;
    /** Hosted processors fetch the file from here (presigned, short lived). */
    fileUrl?: string;
    /** Where an async processor posts its result. Always a Lore-owned URL. */
    callbackUrl?: string;
    /** Per-job bearer token the processor must present on its callback (bearer scheme). */
    callbackBearer?: string;
    /** Optional free-text instruction for LLM based extractors. */
    prompt?: string;
}

/** One unit of extracted text with where it came from in the source. */
export interface TextChunk {
    text: string;
    /** 1-based page, when the source has pages. */
    page?: number;
    /** Seconds from start, for audio/video sources. */
    startSeconds?: number;
    endSeconds?: number;
}

export interface ExtractResult {
    contractVersion: typeof CONTRACT_A_VERSION;
    jobId: string;
    /** Whole-document text. Page-aware processors insert `Page_Number: N` markers. */
    text: string;
    /** Page/time aware pieces. Empty means: use `text` as a single chunk. */
    chunks: TextChunk[];
    /** 0..1. */
    confidence: number;
    mimeType: string;
    processor: ProcessorInfo;
    /** Tables found inside the document, ready for the tables write path. */
    tables?: Array<{ headers: string[]; rows: Array<Record<string, string>>; position: number; confidence: number; caption?: string }>;
    metadata?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Contract B — structure (shape of ai-api Structuring V2)           */
/* ------------------------------------------------------------------ */

export interface StructureRequest {
    contractVersion: typeof CONTRACT_B_VERSION;
    jobId: string;
    workspace: string;
    sourceId: string;
    /** Extracted text, with `Page_Number: N` markers when pages are known. */
    text: string;
    /** Named profile known to the processor, or an inline JSON Schema. */
    profile?: string;
    outputSchema?: Record<string, unknown>;
    /** Dotted path to the array of items inside the schema-shaped content. */
    itemPath?: string;
    itemKey?: string[];
    sourceRefs?: boolean;
    reviewThreshold?: number;
    instructions?: string;
    callbackUrl?: string;
    callbackBearer?: string;
}

export interface ConfidenceBlock {
    score: number;
    level: 'High' | 'Medium' | 'Low';
    reasons: string[];
}

/** Per-item annotation (Structuring V2 `annotations.items[]`). */
export interface ItemAnnotation {
    /** Index of the item inside the array at `itemPath`. */
    index: number;
    source_page: number | null;
    source_quote: string | null;
    quote_verified?: boolean;
    confidence: ConfidenceBlock;
    field_confidence?: Record<string, number>;
    needs_review: boolean;
    occurrences?: number;
    conflicts?: unknown[];
}

export interface StructureAnnotations {
    items: ItemAnnotation[];
    rejected: unknown[];
    document: Record<string, unknown>;
}

export interface StructureResult {
    contractVersion: typeof CONTRACT_B_VERSION;
    jobId: string;
    /** Schema-shaped object. */
    content: Record<string, unknown>;
    annotations: StructureAnnotations | null;
    /** Items the processor flagged `incomplete` (cap hit, rejected items). */
    incomplete: boolean;
    processor: ProcessorInfo;
}

/* ------------------------------------------------------------------ */
/*  Ports                                                              */
/* ------------------------------------------------------------------ */

/**
 * A processor either answers inline (`done`) or accepts the work and will
 * deliver the result later to the signed callback (`accepted`).
 */
export type ProcessorOutcome<R> =
    | { status: 'done'; result: R }
    | { status: 'accepted'; remoteRequestId?: string };

export class ProcessorError extends Error {
    constructor(
        message: string,
        /** Retryable = transient (5xx, timeout, 429). Not retryable = permanent (4xx, bad contract). */
        public readonly retryable: boolean,
        public readonly statusCode?: number,
    ) {
        super(message);
        this.name = 'ProcessorError';
    }
}

export interface IExtractProcessor {
    readonly info: ProcessorInfo & { kind: 'extract' };
    supports(mimeType: string): boolean;
    extract(req: ExtractRequest): Promise<ProcessorOutcome<ExtractResult>>;
}

export interface IStructureProcessor {
    readonly info: ProcessorInfo & { kind: 'structure' };
    structure(req: StructureRequest): Promise<ProcessorOutcome<StructureResult>>;
}

export type AnyProcessor = IExtractProcessor | IStructureProcessor;

/** Major part of a contract version string: `extract.v1` -> 1. */
export function contractMajor(version: string): number {
    const m = /\.v(\d+)$/.exec(version);
    return m ? Number(m[1]) : NaN;
}
