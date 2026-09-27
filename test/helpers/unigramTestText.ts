/**
 * Deterministic long texts for the Unigram tokenizer timing test
 * (embed-chunking-linear-time-unit.ts).
 */

const WORDS = [
    'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet',
    'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango',
    'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu', 'Lore', 'memory', 'graph', 'vector',
    'recall', 'the', 'and', 'of', 'to', 'in', 'supersedes', 'workspace', '2026-09-26', 'v3.24.0',
];

/** Mixed-script tokens: surrogate pairs (emoji, math letters), CJK, RTL,
 *  combining marks, NBSP / runs of spaces (the normalizer collapses them),
 *  and characters unlikely to be in the vocab (unk path). */
const UNICODE = [
    'naïve', 'café', 'é', 'Straße', 'Ωμέγα', 'Привет', 'مرحبا', 'שלום', '日本語のテキスト',
    '中文分词', '한국어', 'ภาษาไทย', '😀', '👩‍💻', '🇨🇦', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢', ' ', '   ', '\t', '\n\n',
    ' ', '�', '\u{10ffff}', '\u{1d11e}', '∑∫√', '«»', '…',
];

function rng(seed: number): () => number {
    let s = seed >>> 0 || 1;
    return () => (s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
}

/** ~English word salad of exactly `len` UTF-16 code units. */
export function longText(len: number, seed: number): string {
    const r = rng(seed);
    let out = '';
    while (out.length < len) out += WORDS[Math.floor(r() * WORDS.length)] + (r() < 0.1 ? '. ' : ' ');
    return out.slice(0, len);
}

/** Word salad interleaved with mixed-script tokens; never ends mid surrogate pair. */
export function mixedUnicodeText(len: number, seed: number): string {
    const r = rng(seed);
    let out = '';
    while (out.length < len) {
        out += r() < 0.35 ? UNICODE[Math.floor(r() * UNICODE.length)] : WORDS[Math.floor(r() * WORDS.length)];
        out += r() < 0.5 ? ' ' : '';
    }
    return Array.from(out).slice(0, len).join('');
}
