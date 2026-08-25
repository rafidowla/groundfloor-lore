/**
 * ftsTokenizerProfile.ts — fix/fts-index-and-tokenizer, item 3.
 *
 * Picks the LanceDB FTS tokenizer for a workspace from a sample of its own
 * corpus, and persists a small JSON sidecar next to the LanceDB store (the
 * same pattern embeddingFingerprint.ts already uses for the embedding
 * model) recording which settings built the CURRENT on-disk index — so
 * VerbatimStore can detect drift (detected language changed, or the store
 * predates this feature entirely) and rebuild once, rather than silently
 * serving a mismatched index forever.
 *
 * Pure/side-effect-free surface: `detectTokenizerProfile` takes a sampled
 * text array (the caller — VerbatimStore — owns reading rows off LanceDB)
 * and returns a settings object; the sidecar read/write functions are the
 * only I/O in this module.
 *
 * ── The crash vector this file exists to prevent ──────────────────────
 * @lancedb/lancedb 0.27.2's `Index.fts({ language })` does not validate its
 * `language` string in JS — an unrecognized value panics the native Rust
 * layer (`unwrap()` on an `Err`) and SIGABRTs the ENTIRE process. This is
 * not a catchable JS exception; try/catch around createIndex does not help.
 * Verified empirically: `language: 'en'` (a bare ISO 639-1 code) aborts the
 * process; `language: 'English'` (the exact Rust enum variant name) does
 * not. `ISO_639_1_TO_LANCEDB_LANGUAGE` below is a closed allowlist for
 * exactly this reason — NEVER pass a `language` value that didn't come
 * through it.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { detectLanguage } from './language.js';

/**
 * The tokenizer knobs we actually vary. A subset of LanceDB's `FtsOptions`
 * (node_modules/@lancedb/lancedb/dist/indices.d.ts) — deliberately not the
 * full type, so this module's persisted JSON shape doesn't change out from
 * under us if LanceDB adds fields we don't use.
 */
export interface FtsTokenizerSettings {
    baseTokenizer: 'simple' | 'ngram';
    /** MUST be a value from ISO_639_1_TO_LANCEDB_LANGUAGE, or absent. */
    language?: string;
    stem?: boolean;
    removeStopWords?: boolean;
    lowercase?: boolean;
    ngramMinLength?: number;
    ngramMaxLength?: number;
}

/**
 * ISO 639-1 → the exact `language` variant name @lancedb/lancedb 0.27.2's
 * Rust layer accepts (lance-index's tokenizer::Language enum). This is the
 * COMPLETE accepted set for this pinned version — confirmed by triggering
 * the panic with an unmapped value and reading the Rust error's "expected
 * one of" list. A detected language outside this map must NEVER be passed
 * as `language`; omit the field instead (LanceDB's own default stemming is
 * safe with it absent — verified empirically, see ftsTokenizerProfile
 * spike notes in the fix/fts-index-and-tokenizer PR description).
 */
const ISO_639_1_TO_LANCEDB_LANGUAGE: Readonly<Record<string, string>> = {
    ar: 'Arabic', da: 'Danish', nl: 'Dutch', en: 'English', fi: 'Finnish',
    fr: 'French', de: 'German', el: 'Greek', hu: 'Hungarian', it: 'Italian',
    no: 'Norwegian', pt: 'Portuguese', ro: 'Romanian', ru: 'Russian',
    es: 'Spanish', sv: 'Swedish', ta: 'Tamil', tr: 'Turkish',
};

/**
 * ============================================================================
 * TOKENIZER SELECTION RULE — the ONE place this policy lives.
 * ----------------------------------------------------------------------------
 * There is one FTS index per workspace, therefore one tokenizer per
 * workspace. LanceDB 0.27.2 ships no per-language segmenter (no jieba) —
 * `ngram` is the only baseTokenizer that makes CJK text searchable at all,
 * and choosing it forgoes English stemming/stop-word removal. A mixed
 * English+CJK workspace cannot be tokenizer-optimal for both scripts at
 * once.
 *
 * DECISION (operator-adjustable): prefer CJK searchability. A workspace
 * stays on the Latin default until a MEANINGFUL fraction of the sampled
 * corpus is CJK (Chinese/Japanese/Thai — scripts that don't tokenize on
 * whitespace, so `simple` collapses a whole sentence into one useless
 * token), then the WHOLE workspace switches to `ngram`. Rationale: Chinese/
 * Japanese/Thai content going from "the index finds nothing" to "it works"
 * outweighs slightly weaker English relevance ranking in a mixed corpus.
 *
 * To flip this policy (e.g. keep English ranking sharp even in mixed
 * corpora, accepting that CJK content stays unsearchable), change
 * CJK_FRACTION_THRESHOLD / CJK_MIN_SAMPLES below — this is the only place
 * the rule is expressed.
 * ============================================================================
 */
const CJK_FRACTION_THRESHOLD = 0.15;
/** Floor alongside the fraction so one short CJK sample in a tiny corpus
 *  can't flip the whole workspace to ngram on noise. */
const CJK_MIN_SAMPLES = 2;

/** Languages that don't tokenize on whitespace/punctuation the way `simple`
 *  expects — see the selection-rule comment above. */
const CJK_LANGUAGES: Readonly<Record<string, true>> = { zh: true, ja: true, th: true };

/**
 * Codepoint ranges whose scripts have no whitespace word boundaries, so
 * `simple` tokenization collapses a whole sentence into one token: Han
 * (CJK Unified Ideographs + Extension A + compatibility), Hiragana,
 * Katakana, Hangul, and Thai.
 */
const CJK_SCRIPT_RE =
    /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯฀-๿]/u;
/** Non-whitespace, non-punctuation characters — the denominator for the
 *  per-sample script ratio below. */
const WORDLIKE_RE = /[^\s\p{P}\p{S}\p{Z}]/gu;
/** A sample counts as CJK when at least this share of its word-like
 *  characters are in a no-word-boundary script. Well clear of a stray
 *  ideograph in an otherwise English sentence, well under a genuinely
 *  CJK sentence carrying Latin product names or digits. */
const CJK_CHAR_RATIO = 0.3;

/**
 * Does this text need a script-aware tokenizer?
 *
 * WHY NOT `detectLanguage`: statistical language ID needs length, and short
 * strings defeat it. Verified: `供应商保险证明审批流程第0步骤说明文件`
 * (19 unambiguously-Han characters) returns `language: null`. In a corpus of
 * ten short Chinese documents only one classified as `zh`, landing under
 * CJK_MIN_SAMPLES, so the workspace silently chose `simple` and Chinese stayed
 * unsearchable — the exact bug the ngram path exists to prevent.
 *
 * The tokenizer question is not "which language is this" but "can whitespace
 * split it", and that is a property of the CHARACTERS. Counting codepoints is
 * deterministic and length-independent, so it holds on a 19-character document
 * where language ID gives up. `detectLanguage` is still the right tool for
 * picking the Latin stemming language below — that is what it is good at.
 */
export function hasCjkScript(text: string): boolean {
    if (!CJK_SCRIPT_RE.test(text)) return false;
    const wordLike = text.match(WORDLIKE_RE);
    if (!wordLike || wordLike.length === 0) return false;
    let cjkChars = 0;
    for (const ch of wordLike) if (CJK_SCRIPT_RE.test(ch)) cjkChars++;
    return cjkChars / wordLike.length >= CJK_CHAR_RATIO;
}

const NGRAM_SETTINGS: FtsTokenizerSettings = {
    baseTokenizer: 'ngram',
    ngramMinLength: 1,
    ngramMaxLength: 2,
};

/**
 * Sample-driven tokenizer choice. Pure function, deterministic on the given
 * sample, no I/O. Empty/unclassifiable input is the Latin default — a
 * fresh or tiny workspace should not jump to `ngram` on zero evidence.
 */
export function detectTokenizerProfile(sampleTexts: readonly string[]): FtsTokenizerSettings {
    // CJK decision: script-based, so it survives samples too short for
    // statistical language ID (see hasCjkScript). Every non-empty sample
    // counts here — unlike the language vote below, nothing is skipped for
    // being unclassifiable, which is precisely the case that used to lose
    // CJK workspaces.
    let scriptSamples = 0;
    let cjkSamples = 0;
    for (const text of sampleTexts) {
        if (!text) continue;
        scriptSamples++;
        if (hasCjkScript(text)) cjkSamples++;
    }
    if (
        scriptSamples > 0 &&
        cjkSamples >= CJK_MIN_SAMPLES &&
        cjkSamples / scriptSamples >= CJK_FRACTION_THRESHOLD
    ) {
        return { ...NGRAM_SETTINGS };
    }

    // Latin path: `detectLanguage` IS the right tool for picking a stemming
    // language, so the vote stays language-based. CJK_LANGUAGES still filters
    // it — a corpus below the script threshold above must not stem in Chinese.
    const languageVotes = new Map<string, number>();
    for (const text of sampleTexts) {
        const { language } = detectLanguage(text);
        if (!language) continue;
        languageVotes.set(language, (languageVotes.get(language) ?? 0) + 1);
    }

    // Latin default. Stem/remove-stop-words in the most-sampled non-CJK
    // language when it's on the crash-safe allowlist; otherwise omit
    // `language` entirely rather than guess (see the allowlist doc above).
    let bestLang: string | null = null;
    let bestVotes = 0;
    for (const [lang, votes] of languageVotes) {
        if (CJK_LANGUAGES[lang]) continue;
        if (votes > bestVotes) { bestLang = lang; bestVotes = votes; }
    }
    const lanceLanguage = bestLang ? ISO_639_1_TO_LANCEDB_LANGUAGE[bestLang] : undefined;
    return {
        baseTokenizer: 'simple',
        stem: true,
        removeStopWords: true,
        lowercase: true,
        ...(lanceLanguage ? { language: lanceLanguage } : {}),
    };
}

/** Field-by-field equality — used to decide whether an on-disk index needs
 *  a migration rebuild. `undefined` and the field's implied default compare
 *  equal so a sidecar written by an earlier, less-explicit version of this
 *  module doesn't force a spurious rebuild. */
export function tokenizerSettingsEqual(a: FtsTokenizerSettings, b: FtsTokenizerSettings): boolean {
    return (
        a.baseTokenizer === b.baseTokenizer &&
        (a.language ?? null) === (b.language ?? null) &&
        (a.stem ?? false) === (b.stem ?? false) &&
        (a.removeStopWords ?? false) === (b.removeStopWords ?? false) &&
        (a.lowercase ?? false) === (b.lowercase ?? false) &&
        (a.ngramMinLength ?? null) === (b.ngramMinLength ?? null) &&
        (a.ngramMaxLength ?? null) === (b.ngramMaxLength ?? null)
    );
}

/* ── Sidecar persistence — mirrors embeddingFingerprint.ts's pattern ───── */

/** Filename under <basePath>/.lore/lancedb/. */
const TOKENIZER_FINGERPRINT_FILENAME = 'fts_tokenizer.json';

/** Schema version — bump when the JSON shape changes incompatibly. */
const TOKENIZER_FINGERPRINT_VERSION = 1;

export interface FtsTokenizerFingerprint {
    settings: FtsTokenizerSettings;
    writtenAt: string;
    version: number;
}

function tokenizerFingerprintPath(basePath: string): string {
    return path.join(basePath, '.lore', 'lancedb', TOKENIZER_FINGERPRINT_FILENAME);
}

/** Re-exported so callers can show the path in messages without rebuilding it. */
export function getTokenizerFingerprintPath(basePath: string): string {
    return tokenizerFingerprintPath(basePath);
}

/**
 * Read the on-disk tokenizer fingerprint. Returns `null` when there isn't
 * one — that covers BOTH a brand-new store and a pre-migration store built
 * before this feature existed; the caller treats both as "unknown, rebuild
 * once" (see VerbatimStore.reconcileFtsTokenizer). Throws on a corrupt
 * file — a half-written JSON is a data-integrity issue, not a normal
 * "missing" case, mirroring embeddingFingerprint.ts's readFingerprint.
 */
export function readTokenizerFingerprint(basePath: string): FtsTokenizerSettings | null {
    const fp = tokenizerFingerprintPath(basePath);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, 'utf-8');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(
            `[ftsTokenizerProfile] Corrupt tokenizer fingerprint at ${fp}: ${(err as Error).message}. ` +
            `Delete the file to force a rebuild.`
        );
    }
    if (!parsed || typeof parsed !== 'object' || !('settings' in parsed)) {
        throw new Error(`[ftsTokenizerProfile] Malformed tokenizer fingerprint at ${fp}: missing 'settings'.`);
    }
    const settingsField = parsed.settings;
    if (typeof settingsField !== 'object' || settingsField === null) {
        throw new Error(`[ftsTokenizerProfile] Malformed tokenizer fingerprint at ${fp}: missing 'settings'.`);
    }
    if (!('baseTokenizer' in settingsField)) {
        throw new Error(`[ftsTokenizerProfile] Malformed tokenizer fingerprint at ${fp}: invalid baseTokenizer.`);
    }
    const baseTokenizer = settingsField.baseTokenizer;
    if (baseTokenizer !== 'simple' && baseTokenizer !== 'ngram') {
        throw new Error(`[ftsTokenizerProfile] Malformed tokenizer fingerprint at ${fp}: invalid baseTokenizer.`);
    }
    const language = 'language' in settingsField && typeof settingsField.language === 'string' ? settingsField.language : undefined;
    const stem = 'stem' in settingsField && typeof settingsField.stem === 'boolean' ? settingsField.stem : undefined;
    const removeStopWords = 'removeStopWords' in settingsField && typeof settingsField.removeStopWords === 'boolean' ? settingsField.removeStopWords : undefined;
    const lowercase = 'lowercase' in settingsField && typeof settingsField.lowercase === 'boolean' ? settingsField.lowercase : undefined;
    const ngramMinLength = 'ngramMinLength' in settingsField && typeof settingsField.ngramMinLength === 'number' ? settingsField.ngramMinLength : undefined;
    const ngramMaxLength = 'ngramMaxLength' in settingsField && typeof settingsField.ngramMaxLength === 'number' ? settingsField.ngramMaxLength : undefined;
    return { baseTokenizer, language, stem, removeStopWords, lowercase, ngramMinLength, ngramMaxLength };
}

/** Atomically write the tokenizer fingerprint. Creates the parent directory
 *  if missing. Mirrors embeddingFingerprint.ts's tmp-file + rename. */
export function writeTokenizerFingerprint(basePath: string, settings: FtsTokenizerSettings): FtsTokenizerFingerprint {
    const fp = tokenizerFingerprintPath(basePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const payload: FtsTokenizerFingerprint = {
        settings,
        writtenAt: new Date().toISOString(),
        version: TOKENIZER_FINGERPRINT_VERSION,
    };
    const tmp = `${fp}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, fp);
    return payload;
}

/** Test-only: clear the fingerprint file. Not exported via index.ts;
 *  imported directly by unit tests that need a clean fixture. */
export function _deleteTokenizerFingerprintForTests(basePath: string): void {
    const fp = tokenizerFingerprintPath(basePath);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
}
