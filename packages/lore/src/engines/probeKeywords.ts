/**
 * probeKeywords.ts — keyword candidates shared by the migration read probes
 * (migrateVectorsProbes.ts bm25 probe, migrateGraphToSqlite.ts search probe).
 * Dependency-free on purpose.
 */

const MAX_KEYWORD_CANDIDATES = 5;
/** A maximal run of letters (+ combining marks), not touching another letter,
 *  mark, digit or underscore: `item12345` and `Zürich` yield no `item` / `rich`. */
const WORD_RUN = /(?<![\p{L}\p{M}\p{N}_])\p{L}[\p{L}\p{M}]*(?![\p{L}\p{M}\p{N}_])/gu;
/** Scripts written without spaces: a 3-character run is already a word-sized
 *  unit (and the trigram tokenizer cannot look up anything shorter). */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/**
 * Keyword candidates for the bm25 probe: whole-word letter runs in any
 * script (>= 4 characters; >= 3 for CJK / Thai), in text order, de-duplicated,
 * at most 5, from the text with any `[TOMBSTONED...]` prefix stripped.
 */
export function keywordCandidates(text: string): string[] {
    const out: string[] = [];
    for (const m of text.replace(/^\[TOMBSTONED[^\]]*\]/, '').matchAll(WORD_RUN)) {
        const word = m[0];
        const min = UNSPACED_SCRIPT.test(word) ? 3 : 4;
        if ([...word].length < min) continue;
        const kw = word.toLowerCase();
        if (out.includes(kw)) continue;
        out.push(kw);
        if (out.length >= MAX_KEYWORD_CANDIDATES) break;
    }
    return out;
}
