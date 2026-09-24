/**
 * questionAliases.ts — 3.21 step 3(e): shared validation + id-shape helpers
 * for a node's optional `questions[]` / `summary` / `entities[]` / `topics[]`.
 *
 * Lore stays a database: nothing here calls a model. Callers (an app, an
 * agent) supply the questions/summary/entities/topics themselves — this
 * module only validates shape/caps and computes the deterministic alias row
 * id. The actual alias verbatim-row fan-out lives in nodeServiceVerbatim.ts
 * (write path) and the alias→parent mapping used by recall lives in
 * recall/retrieve.ts (read path); both import the shared constants/parser
 * from here so the two sides can never disagree about the id shape.
 *
 * Alias row id shape: `lore:<nodeId>#q<index>` (index 0-based, < MAX_QUESTIONS)
 * — the same `#<tag><suffix>` convention VerbatimStore already uses for
 * history rows (`lore:<id>#rev<timestamp>`), so `isHistoryId`/`assertSafeLanceId`
 * treat it as an ordinary (non-history) canonical row, and no engine/schema
 * change was needed to support it.
 */

export const MAX_QUESTIONS = 5;
export const MAX_QUESTION_CHARS = 300;
export const MAX_SUMMARY_CHARS = 500;
export const MAX_LIST_ITEMS = 20;
export const MAX_LIST_ITEM_CHARS = 100;

export interface QuestionsMetaInput {
    questions?: unknown;
    summary?: unknown;
    entities?: unknown;
    topics?: unknown;
}

export interface QuestionsMetaValue {
    questions: string[];
    summary?: string;
    entities?: string[];
    topics?: string[];
}

/**
 * Validate the optional questions/summary/entities/topics fields. Every
 * field is optional — a caller sending none of them gets exactly today's
 * behaviour (no validation runs, no metadata patch, no alias rows).
 *
 * Returns the FIRST violation as a plain, caller-facing message (mirrors
 * the style of nodeService.ts's other early-validation checks — field cap,
 * protected field, etc.) so every surface (MCP schema, REST body, core
 * direct-call) can render the same wording.
 */
export function validateQuestionsMeta(input: QuestionsMetaInput): { ok: true; value: QuestionsMetaValue } | { ok: false; error: string } {
    const value: QuestionsMetaValue = { questions: [] };

    if (input.questions !== undefined) {
        if (!Array.isArray(input.questions) || !input.questions.every((q) => typeof q === 'string')) {
            return { ok: false, error: 'questions must be an array of strings' };
        }
        if (input.questions.length > MAX_QUESTIONS) {
            return { ok: false, error: `questions exceeds the limit of ${MAX_QUESTIONS} (got ${input.questions.length})` };
        }
        for (const q of input.questions) {
            if (q.length === 0) return { ok: false, error: 'a question must not be empty' };
            if (q.length > MAX_QUESTION_CHARS) {
                return { ok: false, error: `a question exceeds the ${MAX_QUESTION_CHARS}-char limit (got ${q.length})` };
            }
        }
        value.questions = input.questions as string[];
    }

    if (input.summary !== undefined) {
        if (typeof input.summary !== 'string') return { ok: false, error: 'summary must be a string' };
        if (input.summary.length > MAX_SUMMARY_CHARS) {
            return { ok: false, error: `summary exceeds the ${MAX_SUMMARY_CHARS}-char limit (got ${input.summary.length})` };
        }
        value.summary = input.summary;
    }

    for (const [key, raw] of [['entities', input.entities], ['topics', input.topics]] as const) {
        if (raw === undefined) continue;
        if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) {
            return { ok: false, error: `${key} must be an array of strings` };
        }
        if (raw.length > MAX_LIST_ITEMS) {
            return { ok: false, error: `${key} exceeds the limit of ${MAX_LIST_ITEMS} (got ${raw.length})` };
        }
        for (const item of raw) {
            if (item.length > MAX_LIST_ITEM_CHARS) {
                return { ok: false, error: `a ${key} entry exceeds the ${MAX_LIST_ITEM_CHARS}-char limit (got ${item.length})` };
            }
        }
        if (key === 'entities') value.entities = raw as string[];
        else value.topics = raw as string[];
    }

    return { ok: true, value };
}

/**
 * Merge `summary`/`entities`/`topics` into a node's existing `metadata` JSON
 * string, verbatim (no processing). Only keys actually present on `patch`
 * are written; an omitted key leaves whatever `baseMetadataJson` already
 * carried for it untouched (same "verbatim, caller-controlled" contract the
 * pre-existing `metadata` field has always had — see store_node's own
 * `metadata` param). Malformed existing JSON is treated as `{}` rather than
 * throwing — the same tolerant-parse convention verbatim/schema code uses
 * elsewhere in this codebase.
 */
export function mergeQuestionsMetaIntoMetadataJson(
    baseMetadataJson: string | undefined,
    patch: Pick<QuestionsMetaValue, 'summary' | 'entities' | 'topics'>,
): string {
    let base: Record<string, unknown>;
    try {
        const parsed = baseMetadataJson ? JSON.parse(baseMetadataJson) : {};
        base = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch {
        base = {};
    }
    if (patch.summary !== undefined) base['summary'] = patch.summary;
    if (patch.entities !== undefined) base['entities'] = patch.entities;
    if (patch.topics !== undefined) base['topics'] = patch.topics;
    return JSON.stringify(base);
}

/** Deterministic alias verbatim-row id for the `i`-th question of `nodeId`
 *  (bare node id, no `lore:` prefix — the caller applies it exactly once,
 *  same convention as the main row's `lore:<id>`). */
export function aliasRowId(nodeId: string, index: number): string {
    return `lore:${nodeId}#q${index}`;
}

/**
 * Parse a raw verbatim-row id (as returned by search()/bm25Search() — may or
 * may not carry the `lore:` prefix, this function doesn't care) as an alias
 * row. Returns null for an ordinary (non-alias) id. `index` is bounds-checked
 * against MAX_QUESTIONS so a coincidental `#q<huge-number>` suffix in an
 * unrelated caller-chosen id is never misread as an alias.
 */
export function parseAliasRowId(rawId: string): { parentId: string; index: number } | null {
    const m = /^(.+)#q(\d+)$/.exec(rawId);
    if (!m) return null;
    const index = Number(m[2]);
    if (!Number.isInteger(index) || index < 0 || index >= MAX_QUESTIONS) return null;
    return { parentId: m[1]!, index };
}

/**
 * mapAliasHitsToParent — the read-side twin of `aliasRowId`. Given a raw
 * ranked hit list (verbatim search()/bm25Search() output, best-to-worst
 * order), maps every alias-row hit to its PARENT id and drops duplicates —
 * keeping the FIRST (best-ranked) occurrence per parent — so:
 *
 *   - an alias row is NEVER returned as a result in its own right (only the
 *     parent id ever reaches graph hydration downstream);
 *   - "a parent hit via several aliases/legs keeps its best rank per list
 *     before fusion" — a parent matched by TWO aliases (or an alias AND its
 *     own direct row) in the SAME list collapses to one entry at whichever
 *     rank was best, so rrfFuse (recall/rrf.ts) sees one contribution per
 *     list per parent, not an inflated count from duplicate aliases.
 */
export function mapAliasHitsToParent<T extends { id: string }>(hits: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const hit of hits) {
        const parsed = parseAliasRowId(hit.id);
        const mappedId = parsed ? parsed.parentId : hit.id;
        if (seen.has(mappedId)) continue;
        seen.add(mappedId);
        out.push(mappedId === hit.id ? hit : { ...hit, id: mappedId });
    }
    return out;
}
