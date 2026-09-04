/**
 * normalizeTags.ts — single source of truth for the tags representation.
 *
 * Migration history:
 *   - Pass 1: API boundary accepted string | string[], coerced to a
 *     comma-joined string (column stayed STRING).
 *   - Pass 2: graph column flipped to STRING[]; readers joined back to a
 *     string so the public LoreNode.tags shape stayed a string.
 *   - Pass 3 (2026-06-24): LoreNode.tags IS now string[] — the canonical
 *     in-memory + graph shape is an array. The only places that still
 *     want a comma string are the LanceDB verbatim metadata field (a
 *     separate substrate whose schema stays STRING) and the embedding
 *     text. tagsToString() serves those.
 *
 * Normalization policy (tagsToArray):
 *   1. Comma is the separator; array elements containing commas are split.
 *   2. Trim + lowercase per element (lowercase-on-store, case-insensitive
 *      matching everywhere — see DECISIONS.md DEC-TAG-MATCH).
 *   3. Drop empties.
 *   4. Cap each tag at MAX_TAG_LENGTH chars so a 10KB tag can't drown the
 *      embedding window (BGE/MiniLM tokenizers truncate around 512 tokens).
 *   5. Dedupe — a tags list is not a set; without this a node could store
 *      ['foo','foo'] and pollute the embedding text + skew the vector.
 *      First occurrence wins (stable order).
 */

const MAX_TAG_LENGTH = 64;

function finalize(parts: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of parts) {
        const t = raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

/**
 * Coerce a wire- or storage-shaped tags value (string, string[], or a
 * legacy comma-joined graph/cloud STRING) into the canonical normalized
 * string[]. Idempotent: re-normalizing an already-normalized array is a
 * no-op. This is the boundary normalizer for every write AND the reader
 * for every substrate row.
 */
export function tagsToArray(tags: unknown): string[] {
    if (tags == null) return [];
    let raw: string[];
    if (Array.isArray(tags)) {
        raw = tags.filter((t): t is string => typeof t === 'string').flatMap(t => t.split(','));
    } else if (typeof tags === 'string') {
        raw = tags.split(',');
    } else {
        return [];
    }
    return finalize(raw);
}

/**
 * Produce the canonical comma string the LanceDB verbatim metadata field
 * (a STRING column) and the embedding text expect. Same normalization as
 * tagsToArray (lowercase/dedupe/cap/split) then joined — so a raw caller
 * value and an already-normalized array both yield the identical string.
 */
export function tagsToString(tags: string[] | string | null | undefined): string {
    return tagsToArray(tags).join(',');
}
