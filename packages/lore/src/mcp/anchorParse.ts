/**
 * anchorParse.ts — shared parser for a node's anchor-metadata string.
 *
 * Anchors are stored as a JSON array of `{ type, ref }` objects on a node.
 * Both the MCP tool (mcp/tools/anchors.ts) and its HTTP mirror
 * (mcp/http/routes/anchors.ts) need to read that string back into typed
 * entries with identical validation, so the logic lives here once. Keeping
 * a single parser guarantees the two surfaces can never drift on what
 * counts as a valid anchor.
 */

export interface ParsedAnchor {
    type: string;
    ref: string;
}

/**
 * parseAnchors — decode a node's anchor string into validated entries.
 * Returns [] for empty/absent input or malformed JSON; silently drops any
 * array element that isn't a `{ type: string, ref: string }` object.
 */
export function parseAnchors(raw: string | null | undefined): ParsedAnchor[] {
    if (!raw || raw.trim() === '' || raw.trim() === '[]') return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (a): a is ParsedAnchor =>
                a && typeof a === 'object' &&
                typeof a.type === 'string' &&
                typeof a.ref === 'string',
        );
    } catch {
        return [];
    }
}
