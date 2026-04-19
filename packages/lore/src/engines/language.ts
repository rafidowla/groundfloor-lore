/**
 * language.ts — Language detection capability (Phase A / V2.2).
 *
 * Wraps `franc` in a small, opinionated interface. Core exposes this
 * function through three surfaces:
 *   - `PluginGraphContext.detectLanguage()` — for plugin code
 *   - MCP tool `detect_language` — for AI agents
 *   - HTTP `POST /api/language/detect` — for general tooling
 *
 * Design rule (see docs/LANGUAGE_DETECTION.md):
 *   Core NEVER invokes this function implicitly. It is a capability
 *   exposed to callers; every consumer decides whether to call it.
 *   If nobody tags content, `language` stays `null` and is treated as
 *   English / default downstream.
 *
 *   Running franc automatically on short-text or code-shaped content
 *   (function names, identifiers, file paths) is unreliable and would
 *   silently poison the graph. Keep it explicit.
 *
 * Determinism: pure function. Same input → same output. No I/O.
 * Error behavior: returns `{ language: null, confidence: 0 }` on
 *   any failure — never throws. Detection is always best-effort.
 */

import { francAll } from 'franc';

export interface LanguageDetectionResult {
    /** ISO 639-1 two-letter code (e.g. 'en', 'es', 'ja') or null if
     *  confidence fell below the threshold. */
    language: string | null;
    /** Confidence score in [0, 1]. franc returns a noisy number;
     *  treat < threshold as effectively "unknown". */
    confidence: number;
}

export interface LanguageDetectionOptions {
    /** Minimum confidence MARGIN to return a language. Default 0.03.
     *
     *  franc's top score is almost always 1.0 for any plausible text,
     *  so "absolute confidence" is not a useful signal. Instead we use
     *  (top_score - runner_up_score) — the margin between the best
     *  match and the second-best. Below this margin we treat the
     *  answer as ambiguous and return `null`.
     *
     *  0.03 accepts clear Latin-script prose (English, Spanish, French,
     *  German all have margins ≥ 0.04 on paragraph-length text) and
     *  rejects code-shaped content where runners-up cluster at 0.99+. */
    threshold?: number;
    /** Minimum text length to attempt detection. Short strings are
     *  inherently unreliable. Default 20. Below this we return
     *  `null` without calling franc. */
    minLength?: number;
}

const DEFAULT_THRESHOLD = 0.03;
const DEFAULT_MIN_LENGTH = 20;

/** ISO 639-3 → ISO 639-1 map for the languages we actually expect
 *  users to tag. franc returns 639-3; we normalize to 639-1 because
 *  everyone else (HTML lang, UI badges, user expectation) uses 639-1.
 *  Languages not in this map pass through as the 639-3 code — still
 *  a valid value, just less conventional. */
const ISO_639_3_TO_1: Record<string, string> = {
    eng: 'en', spa: 'es', fra: 'fr', deu: 'de', ita: 'it',
    por: 'pt', nld: 'nl', rus: 'ru', ukr: 'uk', pol: 'pl',
    tur: 'tr', ara: 'ar', heb: 'he', hin: 'hi', ben: 'bn',
    jpn: 'ja', kor: 'ko', zho: 'zh', cmn: 'zh', yue: 'zh',
    vie: 'vi', tha: 'th', ind: 'id', msa: 'ms', tgl: 'tl',
    swe: 'sv', nor: 'no', nob: 'no', dan: 'da', fin: 'fi',
    isl: 'is', ell: 'el', ces: 'cs', slk: 'sk', hun: 'hu',
    ron: 'ro', bul: 'bg', srp: 'sr', hrv: 'hr', slv: 'sl',
    lit: 'lt', lav: 'lv', est: 'et', kat: 'ka', hye: 'hy',
    aze: 'az', fas: 'fa', urd: 'ur', tam: 'ta', tel: 'te',
    mar: 'mr', guj: 'gu', kan: 'kn', mal: 'ml', sin: 'si',
    nep: 'ne', mya: 'my', khm: 'km', lao: 'lo', amh: 'am',
    swa: 'sw', zul: 'zu', xho: 'xh', afr: 'af',
};

/**
 * detectLanguage — Return the most likely ISO 639-1 language code
 * for `text`, or `null` if confidence is below threshold.
 *
 * Call explicitly; never invoked automatically by core. See the file
 * header for the rationale.
 */
export function detectLanguage(
    text: string,
    options: LanguageDetectionOptions = {},
): LanguageDetectionResult {
    const threshold = options.threshold ?? DEFAULT_THRESHOLD;
    const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;

    if (typeof text !== 'string') {
        return { language: null, confidence: 0 };
    }

    const trimmed = text.trim();
    if (trimmed.length < minLength) {
        return { language: null, confidence: 0 };
    }

    try {
        // francAll returns ranked [iso3, score] tuples with scores in
        // [0, 1]. The top result is our candidate; the delta between
        // top-1 and top-2 is our effective confidence (close-call
        // detections on short / mixed text produce adjacent scores,
        // which we want to treat as low-confidence).
        const ranked = francAll(trimmed, { minLength }) as Array<[string, number]>;
        if (ranked.length === 0 || ranked[0][0] === 'und') {
            return { language: null, confidence: 0 };
        }

        const top = ranked[0];
        const runnerUp = ranked[1] ?? ['und', 0];
        // franc scores are [0, 1] with the top often == 1.0 on clean
        // text. Using (top - runnerUp) as confidence captures decisive
        // matches and penalizes ambiguous ones. On a single-language
        // candidate list, confidence == top_score.
        const confidence = Math.max(0, Math.min(1, top[1] - runnerUp[1]));

        if (confidence < threshold) {
            return { language: null, confidence };
        }

        const iso1 = ISO_639_3_TO_1[top[0]] ?? top[0];
        return { language: iso1, confidence };
    } catch {
        return { language: null, confidence: 0 };
    }
}
