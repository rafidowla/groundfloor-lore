/**
 * toolMeta.ts — v1.1.1 P2 — `_meta.confidence` + negative_evidence envelope.
 *
 * Why this exists
 * ───────────────
 * Agents loop when a tool returns an empty result. The agent calls
 * `recall({topic: "x"})`, gets back `{nodes: []}`, doesn't know whether
 * the empty array means "really nothing here" or "I asked the wrong way",
 * and tries again with a different phrasing. Then again. Then again.
 *
 * The fix is to make the absence informative: when a tool's result is
 * empty, return a small envelope that EXPLICITLY says "this is a no, not
 * a hint to retry". The agent prompt teaches "respect confidence: 0 +
 * negative_evidence — do not retry the same kind of search."
 *
 * Envelope shape
 * ──────────────
 * Every tool that opts in returns its payload wrapped:
 *
 *   {
 *     ok: true,
 *     data: <whatever the tool would have returned before>,
 *     _meta: {
 *       confidence: 0..1,      // 1 = certain this represents reality;
 *                              //  0 = certain there is nothing here;
 *                              //  middle values for partial evidence.
 *       negative_evidence?: string,  // human-readable "what does empty mean here"
 *       sources_consulted?: number,  // how many indices/columns/tables
 *                                    //  the tool actually checked
 *     }
 *   }
 *
 * Default behaviour: tools that don't opt in return their existing shape
 * unchanged. Opt-in is per-tool, additive, and free of breaking
 * consumers — agents that don't read `_meta` see the same `data` payload
 * they used to see at the top level.
 *
 * What goes in `_meta.confidence`
 * ───────────────────────────────
 * Domain-specific. Examples we ship in v1.1.1:
 *
 *   - `recall` with zero hits: confidence 0, negative_evidence
 *     "no nodes in the graph match this topic; absence of memory is
 *     informative — do not retry with rephrasings."
 *   - `recall` with hits below the score floor: confidence ~0.3,
 *     negative_evidence "matches exist but quality is low; consider
 *     storing a node before retrying."
 *   - `search` with zero hits: same shape as recall.
 *   - `recall_decisions` for an unknown topic: confidence 0,
 *     negative_evidence "no decision nodes match this topic; store a
 *     node first or widen the search scope before retrying."
 *
 * Each tool's handler decides its own confidence model. There's no
 * centralized scoring — different tools have different uncertainty
 * sources, and forcing a uniform calibration would be worse than no
 * signal at all.
 *
 * License: original work for groundfloor-lore.
 */

export interface ToolMeta {
    /** [0,1] how confident the result represents reality. */
    confidence: number;
    /**
     * Plain-English description of what the empty / weak result means.
     * Read by the agent prompt; absent when confidence is high.
     */
    negative_evidence?: string;
    /**
     * How many indices / columns / sources the tool actually checked.
     * Useful for the agent to know "did the tool look in 1 place or 5?"
     */
    sources_consulted?: number;
    /** Wall-clock handler time. Optional; the dispatch log already has it. */
    elapsed_ms?: number;
}

export interface ToolEnvelope<T> {
    ok: boolean;
    data: T;
    _meta: ToolMeta;
}

/**
 * Build an envelope around a successful tool result. Helper for the
 * common "I have data, here's how confident I am" case.
 */
export function envelope<T>(
    data: T,
    meta: ToolMeta,
): ToolEnvelope<T> {
    return { ok: true, data, _meta: meta };
}

/**
 * Build a "no results found" envelope. Helper for the negative-evidence
 * case — the most common reason agents loop. The `negative_evidence`
 * string is what the agent prompt teaches to respect.
 *
 *   return negativeEvidence({
 *       reason: 'no nodes in the graph match this topic',
 *       sources_consulted: 1,
 *   });
 */
export function negativeEvidence<T = { results: never[] }>(args: {
    reason: string;
    sources_consulted?: number;
    /** Optional empty data payload. Defaults to `{ results: [] }`. */
    data?: T;
}): ToolEnvelope<T> {
    return {
        ok: true,
        data: (args.data ?? ({ results: [] } as unknown as T)),
        _meta: {
            confidence: 0,
            negative_evidence: args.reason,
            ...(args.sources_consulted !== undefined ? { sources_consulted: args.sources_consulted } : {}),
        },
    };
}

/**
 * Build a low-confidence envelope. Useful when results exist but the
 * tool is uncertain whether they're useful — e.g., similarity search
 * returned matches but they're below the typical score floor.
 */
export function lowConfidence<T>(args: {
    data: T;
    confidence: number; // expected in (0, 0.5]
    reason: string;
    sources_consulted?: number;
}): ToolEnvelope<T> {
    return {
        ok: true,
        data: args.data,
        _meta: {
            confidence: args.confidence,
            negative_evidence: args.reason,
            ...(args.sources_consulted !== undefined ? { sources_consulted: args.sources_consulted } : {}),
        },
    };
}

/**
 * Stringify a tool envelope into the `{ content: [{ type: 'text', text }] }`
 * shape the MCP SDK expects. Use this at the end of a tool handler:
 *
 *   return toMcpReply(negativeEvidence({ reason: '...' }));
 *
 * Convenience: if you already have a non-envelope payload and want to
 * skip the envelope (for tools that haven't opted into _meta yet), just
 * keep the existing JSON.stringify(...) pattern at the call site.
 */
export function toMcpReply<T>(envelopeValue: ToolEnvelope<T>): {
    content: Array<{ type: 'text'; text: string }>;
} {
    return {
        content: [{
            type: 'text' as const,
            text: JSON.stringify(envelopeValue, null, 2),
        }],
    };
}
