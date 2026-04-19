/**
 * types.ts — Extractor contract (Phase 2 / C3).
 *
 * An Extractor turns the bytes of one file into structured text +
 * metadata that the rest of Lore (embedding, graph, retrieval) can
 * work with uniformly. The contract deliberately treats every format
 * identically from the caller's perspective:
 *
 *   Bytes + mime → { text, metadata, confidence }
 *
 * Core ships extractors for common text-bearing formats (markdown,
 * PDF, DOCX, email). Plugins may register additional ones via
 * ExtractorRegistry.register() during boot — useful for domain-
 * specific formats (an accounting plugin could register an XLSX
 * extractor that preserves sheet/row structure in metadata).
 *
 * Why both `text` and `metadata`:
 *   - `text` is the flattened corpus used for embedding + fulltext.
 *   - `metadata` preserves format-specific structure the text loses
 *     (e.g. email From/To/Subject/Date, PDF author/creation date,
 *     DOCX style hints). Downstream plugins decide what to do with it.
 *
 * Why `confidence`:
 *   - PDF with selectable text → ~1.0 (direct extraction).
 *   - PDF that needed OCR → might be ~0.7 (character-level errors).
 *   - Future-proofing for the C9 vision fallback which will produce
 *     extracted text with real uncertainty.
 */

/**
 * ExtractedContent — the normalized output format every extractor returns.
 */
export interface ExtractedContent {
    /** Flattened text content. Required, may be empty for image-only files. */
    text: string;
    /** Format-specific structured data the text flattening drops. */
    metadata: Record<string, unknown>;
    /**
     * Confidence in [0, 1]. 1.0 = direct structured extraction, lower
     * means heuristic / OCR / inferred. Downstream can fold this into
     * C1 edge confidence when the extracted content becomes a node.
     */
    confidence: number;
    /** MIME type the extractor accepted this as. */
    mimeType: string;
    /** Byte size of the source — tracked for storage-budget reporting. */
    sourceBytes: number;
}

/**
 * IExtractor — the contract every concrete extractor implements.
 *
 * Extractors are pure functions at the edge — they take bytes + mime,
 * return content. They MUST NOT read from disk outside the buffer
 * handed in (callers like the read_document_for_ingestion tool apply
 * the path-allowlist BEFORE the extractor sees anything), and they
 * MUST NOT make network calls. Pure-in-process so ingestion is
 * predictable, auditable, and fast.
 */
export interface IExtractor {
    /** Human-readable name for logging ("pdf", "docx", ...). */
    readonly name: string;
    /**
     * MIME types this extractor claims. First-wins in the registry,
     * so list the most specific types first. Wildcards like `text/*`
     * are supported as a fallback pattern.
     */
    readonly mimeTypes: readonly string[];
    /**
     * Extract content from the buffer. Throws ExtractorError on
     * recoverable format problems (corrupt file, unsupported
     * sub-feature); throws anything else for unexpected failures
     * the registry will wrap.
     */
    extract(input: Buffer, mimeType: string): Promise<ExtractedContent>;
}

/**
 * ExtractorError — thrown by extractors for recoverable format problems.
 *
 * Callers (the ingestion tool, connectors) can catch this and report a
 * user-readable error without treating it as a fatal exception. Any
 * error a registered extractor can legitimately produce should be one
 * of these; anything else is a bug worth surfacing.
 */
export class ExtractorError extends Error {
    readonly code: 'corrupt' | 'unsupported' | 'empty' | 'too-large';
    constructor(message: string, code: 'corrupt' | 'unsupported' | 'empty' | 'too-large') {
        super(message);
        this.name = 'ExtractorError';
        this.code = code;
    }
}
