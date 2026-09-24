/**
 * termCoverage.ts — D1 second abstention signal: key-term coverage.
 *
 * The calibrated z-score (abstention.ts) answers "is anything stored CLOSE to
 * this query?". On an in-domain corpus a plausible-but-unanswered question
 * ("How does SSL certificate renewal work for the API gateway?") sits close
 * to plenty of related rows, so a similarity floor alone cannot separate
 * "related" from "answers it". This module adds a cheap lexical check: do
 * the query's content terms actually appear in the top-k FINAL ranked hits
 * (after lexical fusion and the D3 identifier lane)?
 *
 * Opt-in (`abstainTermCoverage` / LORE_RECALL_ABSTAIN_TERM_COVERAGE), only
 * consulted when `abstain` is on, and only for a query whose z is above the
 * floor but not comfortably so (z < floor + margin). No model, no network,
 * no extra store round-trip: it reads the ranked seed texts retrieve() already
 * has. Matching is forgiving (review round 2, §3.10.4): light stemming,
 * compound/prefix match, acronym ↔ expansion, number words, and a small
 * general-purpose synonym table (termCoverageLexicon.ts).
 *
 * Rarity weighting: no per-term document-frequency source is available on
 * the seed-store interface without an extra FTS query per term (both engines),
 * so v1 uses a fixed rule instead of IDF — question scaffolding and generic
 * verbs are dropped as stopwords, a STRONGLY code-shaped identifier (the most
 * distinctive kind of term a query can carry) counts double, and a query
 * whose strong identifiers are ALL absent from the ranked seed set scores 0.
 * Product names / prose compounds the D1 detector also flags (OAuth2, gRPC,
 * Node.js, Worker-Lease-Timeout) are ordinary words here. Queries in scripts
 * written without spaces (CJK, Thai, …) are not judged at all (fail open). See
 * docs/design/D1-calibrated-abstention.md §3.10.
 *
 * License: original work for groundfloor-lore.
 */

import { KEYWORD_STOPWORDS } from '../engines/searchRanking.js';
import { containsWholeToken, extractIdentifierTokens } from './abstention.js';
import { CONVERSATIONAL_STOPWORDS, NUMBER_WORDS, PHRASE_FOLDS, SYNONYM_GROUPS } from './termCoverageLexicon.js';

/** Weighted fraction of query terms that must appear in the top-k hits. */
export const DEFAULT_TERM_COVERAGE_MIN = 0.1;
/** How many top FINAL ranked hits the coverage check reads. */
export const DEFAULT_TERM_COVERAGE_TOP_K = 5;
/** The check only applies while z < floor + margin; a query this far above
 *  the null distribution is trusted on similarity alone. */
export const DEFAULT_TERM_COVERAGE_Z_MARGIN = 2.5;
/** An identifier-shaped term counts this much more than a plain word. */
const IDENTIFIER_WEIGHT = 2;

/** Question scaffolding / generic verbs on top of the shared keyword
 *  stopwords (searchRanking.ts). Domain-neutral English, but NOT blind: the
 *  conversational and meta-vocabulary rows were added after inspecting which
 *  terms real recall-eval questions missed (design doc §3.10 reports this and
 *  the held-out distractor set that checks it did not overfit). */
const EXTRA_STOPWORDS: ReadonlySet<string> = new Set([
    'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
    'there', 'here', 'get', 'gets', 'got', 'make', 'makes', 'made', 'way', 'ways',
    'much', 'many', 'some', 'than', 'then', 'also', 'just', 'like', 'need', 'needs',
    'own', 'give', 'given', 'take', 'takes', 'kind', 'sort', 'thing', 'things',
    'actually', 'exactly', 'really', 'still', 'ever', 'always', 'usually', 'currently',
    'right', 'now', 'today', 'again', 'each', 'every', 'other', 'same', 'such', 'more',
    'most', 'very', 'too', 'only', 'whether', 'being', 'having', 'doing', 'say', 'said',
    'tell', 'know', 'want', 'wants', 'goes', 'going', 'happen', 'happens', 'happened',
    'up', 'out', 'off', 'over', 'under', 'use', 'uses', 'used', 'using', 'work', 'works',
    'handle', 'handles', 'handled', 'handling', 'do', 'done', 'does', 'did', 'new', 'old',
    'went', 'wrong', 'something', 'else', 'instead', 'behind', 'getting', 'eventually', 'mostly', 'one',
    // Meta-vocabulary: words naming the KIND of answer wanted ("the rule
    // about X", "the design of X", "why did we choose X"), not its topic. A
    // stored decision rarely repeats "decision"/"rule"/"design" in its body.
    'rule', 'rules', 'design', 'bug', 'bugs', 'decision', 'decisions', 'decide', 'decided',
    'convention', 'conventions', 'strategy', 'approach', 'reason', 'reasons', 'reasoning',
    'requirement', 'requirements', 'choice', 'choose', 'chose', 'chosen', 'pick', 'picked', 'process',
    ...CONVERSATIONAL_STOPWORDS,
]);

export interface QueryTerm {
    text: string;
    kind: 'identifier' | 'word';
    weight: number;
}

/** Light suffix stripping so "expires"/"expired"/"expire" and
 *  "leases"/"lease" share a stem. A final silent `e` is dropped from words
 *  longer than 4 so the `-es`/`-ed` forms and the bare form agree. */
export function lightStem(word: string): string {
    return dropFinalE(stripSuffix(word.toLowerCase()));
}

function stripSuffix(w: string): string {
    if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
    for (const suf of ['ing', 'ed', 'es', 'ly']) {
        if (w.endsWith(suf) && w.length - suf.length >= 4) return w.slice(0, -suf.length);
    }
    // Plain plural: "jobs"→"job", but never "class"→"clas" / "bus"→"bu".
    if (w.endsWith('s') && !w.endsWith('ss') && w.length >= 4) return w.slice(0, -1);
    return w;
}

function dropFinalE(w: string): string {
    return w.length > 4 && w.endsWith('e') ? w.slice(0, -1) : w;
}

const WORD_SPLIT_RE = /[^\p{L}\p{N}]+/u;

/** Scripts written without spaces between words. A query containing any of
 *  these cannot be split into terms by WORD_SPLIT_RE, so the signal fails
 *  open (coverage null) rather than judging one giant "word". */
const UNSEGMENTED_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

/**
 * Strongly code-shaped identifier (review finding 3). The D1 detector
 * (abstention.ts) deliberately casts a wide net for the RESCUE; the
 * "identifier absent ⇒ coverage 0" rule needs a narrow one, or a product
 * name the corpus spells differently ("OAuth2", "gRPC", "iPhone",
 * "Node.js", "Worker-Lease-Timeout") abstains the whole query. Strong =
 * `#123`; contains `_`; a slashed path; a ≥3-segment hyphenated token with a
 * digit ("fx-code-000123", not "ISO-8601"); a dotted path that starts lowercase
 * or has ≥3 segments ("package.json", "ctx.a.b", not "Node.js"); camelCase
 * with ≥2 lowercase letters before the first capital ("chargeInvoice", not
 * "iPhone"/"gRPC"); PascalCase with ≥3 humps ("RetrieveCalibrationMeta",
 * not "JavaScript"); or ≥6 chars with a letter after a digit ("e68ff81d",
 * not "OAuth2"/"sha256").
 */
export function isStrongIdentifier(token: string): boolean {
    if (/^#\d+$/.test(token)) return true;
    if (token.includes('_')) return true;
    if (token.includes('/')) return true;
    if (token.includes('-') && /\d/.test(token) && token.split('-').length >= 3) return true; // fx-code-000123
    if (token.includes('.')) {
        const segs = token.split('.');
        return segs.length >= 3 || /^[a-z]/.test(token) || /[a-z][A-Z]/.test(token);
    }
    if (/^[a-z]{2,}[a-z0-9]*[A-Z][a-z]/.test(token)) return true;
    if (/^(?:[A-Z][a-z0-9]+){3,}$/.test(token)) return true;
    if (token.length >= 6 && /\d[A-Za-z]/.test(token) && /[A-Za-z]/.test(token)) return true;
    return false;
}

function foldPhrases(query: string): string {
    let out = query;
    for (const [words, fold] of PHRASE_FOLDS) {
        out = out.replace(new RegExp(`\\b${words.join('[\\s-]+')}\\b`, 'gi'), fold);
    }
    return out;
}

/** Content terms of `query`: strongly code-shaped identifiers kept whole
 *  (matched case-sensitively on token boundaries, weight 2), then the
 *  remaining plain words lowercased, minus stopwords, 1–2 letter words
 *  (digits of ≥2 kept: "45", "14"), deduped by stem. Weakly identifier-shaped
 *  tokens ("OAuth2", "Node.js") fall through to the word path. */
export function extractQueryTerms(query: string): QueryTerm[] {
    const identifiers = [...new Set(extractIdentifierTokens(query))].filter(isStrongIdentifier);
    let rest = query;
    for (const id of identifiers) rest = rest.split(id).join(' ');
    rest = foldPhrases(rest);
    const terms: QueryTerm[] = identifiers.map((text) => ({ text, kind: 'identifier', weight: IDENTIFIER_WEIGHT }));
    const seen = new Set<string>();
    for (const tok of rest.split(WORD_SPLIT_RE)) {
        if (!tok) continue;
        const raw = tok.toLowerCase();
        const isNumber = /^\p{N}+$/u.test(raw);
        // An ALL-CAPS 2-letter token is an acronym ("CI", "DB"), not a stopword.
        const isAcronym = /^[A-Z]{2,6}$/.test(tok);
        if (isNumber ? raw.length < 2 : (raw.length < 3 && !isAcronym)) continue;
        if (!isAcronym && (KEYWORD_STOPWORDS.has(raw) || EXTRA_STOPWORDS.has(raw))) continue;
        const s = lightStem(raw);
        if (seen.has(s)) continue;
        seen.add(s);
        terms.push({ text: raw, kind: 'word', weight: 1 });
    }
    return terms;
}

/** What the judged texts offer to match against. */
interface TextIndex {
    stems: Set<string>;
    /** Initials of every 2–5 consecutive-word window ("dead letter queue" → "dlq"). */
    initials: Set<string>;
    /** Lowercased ALL-CAPS tokens ("CLI" → "cli"). */
    acronyms: Set<string>;
}

function indexTexts(texts: readonly string[]): TextIndex {
    const stems = new Set<string>();
    const initials = new Set<string>();
    const acronyms = new Set<string>();
    for (const text of texts) {
        const words: string[] = [];
        for (const tok of text.split(WORD_SPLIT_RE)) {
            if (!tok) continue;
            stems.add(lightStem(tok));
            if (/^[A-Z]{2,6}s?$/.test(tok)) acronyms.add(tok.replace(/s$/, '').toLowerCase());
            // camelCase parts ("throttleLedger") and digit/letter parts ("30s", "k8s" stays whole too).
            for (const p of tok.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=\p{N})(?=\p{L})|(?<=\p{L})(?=\p{N})/u)) {
                if (p !== tok) stems.add(lightStem(p));
                words.push(p.toLowerCase());
            }
        }
        for (let i = 0; i < words.length; i++) {
            let acc = '';
            for (let n = 0; n < 5 && i + n < words.length; n++) {
                acc += words[i + n][0];
                if (n >= 1) initials.add(acc);
            }
        }
    }
    return { stems, initials, acronyms };
}

const SYNONYMS: ReadonlyMap<string, readonly string[]> = (() => {
    const m = new Map<string, string[]>();
    for (const group of SYNONYM_GROUPS) {
        const stems = group.map(lightStem);
        for (const s of stems) m.set(s, [...new Set([...(m.get(s) ?? []), ...stems])]);
    }
    return m;
})();

function stemCovered(s: string, idx: TextIndex): boolean {
    if (idx.stems.has(s)) return true;
    if (s.length < 4) return false;
    for (const h of idx.stems) {
        // "expir" vs "expiration", "retry" vs "retries": a ≥5-char stem that
        // prefixes a hit stem (or vice versa) is the same word.
        if (s.length >= 5 && h.length >= 5 && (h.startsWith(s) || s.startsWith(h))) return true;
        // Compounds: "load" inside "overload", "tenant" inside "multitenant".
        if (h.length >= s.length + 3 && (h.startsWith(s) || h.endsWith(s))) return true;
    }
    return false;
}

function wordCovered(word: string, idx: TextIndex): boolean {
    const s = lightStem(word);
    if (stemCovered(s, idx)) return true;
    const digits = NUMBER_WORDS[word];
    if (digits && idx.stems.has(digits)) return true;
    // Acronym in the query ("DLQ") spelled out in the texts, or vice versa.
    if (/^[a-z]{2,6}$/.test(word) && (idx.initials.has(word) || idx.acronyms.has(word))) return true;
    for (const syn of SYNONYMS.get(s) ?? []) if (syn !== s && stemCovered(syn, idx)) return true;
    return false;
}

export interface TermCoverageResult {
    /** Weighted fraction of terms found in the texts, 0..1; null when the
     *  query has no content terms (or is in an unsegmented script) — nothing
     *  to judge, never gates. Forced to 0 when the query names strongly
     *  code-shaped identifiers and NONE of them occurs in `allTexts` (the
     *  mirror image of the exact-identifier rescue: "you asked about X, and
     *  X is not stored"). */
    coverage: number | null;
    terms: number;
    missing: string[];
    identifiersAbsent: boolean;
}

/** Initials of consecutive query words that spell an ALL-CAPS token in the
 *  texts ("command line interface" ↔ "CLI"): those words count as covered. */
function phraseAcronymCovered(words: readonly string[], idx: TextIndex): Set<string> {
    const out = new Set<string>();
    for (let i = 0; i < words.length; i++) {
        for (let n = 2; n <= 5 && i + n <= words.length; n++) {
            const span = words.slice(i, i + n);
            if (idx.acronyms.has(span.map((w) => w[0]).join(''))) for (const w of span) out.add(w);
        }
    }
    return out;
}

/** `texts` = the top-k ranked hits coverage is judged against; `allTexts` =
 *  the whole ranked seed set, used only for the identifiers-absent check
 *  (defaults to `texts`). */
export function computeTermCoverage(query: string, texts: readonly string[], allTexts: readonly string[] = texts): TermCoverageResult {
    if (UNSEGMENTED_SCRIPT_RE.test(query)) return { coverage: null, terms: 0, missing: [], identifiersAbsent: false };
    const terms = extractQueryTerms(query);
    if (terms.length === 0) return { coverage: null, terms: 0, missing: [], identifiersAbsent: false };
    const ids = terms.filter((t) => t.kind === 'identifier');
    const identifiersAbsent = ids.length > 0 && !ids.some((t) => allTexts.some((x) => containsWholeToken(x, t.text)));
    const idx = indexTexts(texts);
    const viaPhrase = phraseAcronymCovered(terms.filter((t) => t.kind === 'word').map((t) => t.text), idx);
    let total = 0;
    let covered = 0;
    const missing: string[] = [];
    for (const t of terms) {
        total += t.weight;
        const hit = t.kind === 'identifier'
            ? texts.some((x) => containsWholeToken(x, t.text))
            : viaPhrase.has(t.text) || wordCovered(t.text, idx);
        if (hit) covered += t.weight;
        else missing.push(t.text);
    }
    return { coverage: identifiersAbsent ? 0 : covered / total, terms: terms.length, missing, identifiersAbsent };
}

/** label + content of a ranked seed — the text an identifier or term counts
 *  as "stored" in. */
export function seedText(n: { label?: string | null; content?: string | null }): string {
    return `${n.label ?? ''}\n${n.content ?? ''}`;
}

/** Env/option resolution — explicit option wins, then the env var, default off. */
export function resolveTermCoverage(opt: boolean | undefined): boolean {
    return opt ?? /^(1|true)$/i.test(process.env.LORE_RECALL_ABSTAIN_TERM_COVERAGE ?? '');
}

/** Threshold resolution: LORE_RECALL_TERM_COVERAGE_MIN overrides the
 *  default; clamped to [0, 1] (coverage is a fraction). */
export function resolveTermCoverageMin(): number {
    const raw = process.env.LORE_RECALL_TERM_COVERAGE_MIN;
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_TERM_COVERAGE_MIN;
}
