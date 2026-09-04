/**
 * loreGraphError.ts — error type for graph operations.
 *
 * Extracted from localGraph.ts (Wave 4 god-class split) so sibling graph
 * modules (e.g. graphTopology.ts) can throw it without importing localGraph
 * and creating a cycle. localGraph.ts re-exports it for existing imports.
 */

/**
 * LoreGraphError — generic error type for graph operations, wrapping the
 * underlying engine's error with context about the operation that failed.
 * Engine-agnostic despite the name's origin in the graph engine that
 * preceded SurrealDB — used identically by every graph engine. This file
 * is shared infrastructure, not a wrapper for one engine only.
 */
export class LoreGraphError extends Error {
    constructor(
        message: string,
        public readonly operation: string,
        public readonly cause?: unknown,
    ) {
        // NW-BULK — surface the underlying cause in the message, not just on
        // `.cause`. Callers (Atlas, CLI, logs) read `.message`; hiding the
        // real underlying engine error (e.g. "connection pool: waiter queue full") behind
        // a generic "Failed to upsert" wrapper turned a diagnosable backpressure
        // signal into an opaque failure. The cause is now visible everywhere a
        // LoreGraphError surfaces, while `.cause` stays available for
        // programmatic inspection.
        const causeMsg =
            cause instanceof Error ? cause.message
            : cause != null ? String(cause)
            : '';
        super(`[LoreGraph:${operation}] ${message}${causeMsg ? `: ${causeMsg}` : ''}`);
        this.name = 'LoreGraphError';
    }
}
