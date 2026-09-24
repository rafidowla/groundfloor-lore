/**
 * tokenize.ts — the leakage-check tokenizer, per the task spec: lowercase,
 * strip non-alphanumeric, drop a small stopword list, strip suffixes
 * ing|ed|es|s. Originally used only for the question-vs-alias token-Jaccard
 * leakage metric documented in ../README.md (Lore does its own tokenization
 * internally, so the harness never fed this into an actual recall call) —
 * now ALSO reused (via `tokenizeList`) by referenceBm25.ts's reference BM25,
 * so the "reference" and the leakage check share one tokenizer definition
 * rather than two independently-drifting ones.
 */

const STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'about', 'as', 'into', 'through',
    'this', 'that', 'these', 'those', 'it', 'its', 'i', 'you', 'he', 'she', 'we', 'they',
    'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'their', 'our',
    'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
    'than', 'then', 'so', 'if', 'do', 'does', 'did', 'done', 'not', 'no', 'yes',
    'can', 'could', 'would', 'should', 'will', 'shall', 'have', 'has', 'had', 'am',
    'up', 'out', 'over', 'under', 'again', 'once', 'there', 'here',
    'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
]);

/** Crude suffix-stripping — checked longest-first so "running" loses "ing"
 *  (not the trailing "s" it doesn't have anyway), and a plain plural like
 *  "dentists" loses only its final "s". A short-word floor on each branch
 *  avoids mangling e.g. "is"/"as"/"gas". */
function stripSuffix(tok: string): string {
    if (tok.length > 6 && tok.endsWith('ing')) return tok.slice(0, -3);
    if (tok.length > 5 && tok.endsWith('ed')) return tok.slice(0, -2);
    if (tok.length > 5 && tok.endsWith('es')) return tok.slice(0, -2);
    if (tok.length > 4 && tok.endsWith('s')) return tok.slice(0, -1);
    return tok;
}

export function tokenize(text: string): Set<string> {
    return new Set(tokenizeList(text));
}

/**
 * Same lowercase/stopword/suffix-strip pipeline as {@link tokenize}, but
 * returns the token LIST (duplicates kept) rather than a Set — needed for
 * term-frequency-based scoring (referenceBm25.ts). Kept in this module so
 * the leakage check and the reference BM25 never drift onto two different
 * tokenizers.
 */
export function tokenizeList(text: string): string[] {
    const raw = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const out: string[] = [];
    for (const t of raw) {
        if (STOPWORDS.has(t)) continue;
        const stemmed = stripSuffix(t);
        if (stemmed.length === 0) continue;
        out.push(stemmed);
    }
    return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
}
