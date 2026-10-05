/**
 * verbatimFtsReconcile.ts — fix/fts-index-and-tokenizer.
 *
 * Tokenizer detection + migration-reconciliation extracted out of
 * VerbatimStore (file-size budget — AGENTS.md: a new concern goes into a
 * new module under the same directory rather than growing an
 * already-past-cap engine file). Mirrors verbatimBatch.ts's small-context-
 * object pattern: these functions take exactly the couplings they need (the
 * live table handle, the on-disk base path, and a gated `ensureFtsIndex`
 * callback) instead of a VerbatimStore instance, so they're independently
 * testable and the coupling surface stays explicit.
 */

import type * as lancedb from '@lancedb/lancedb';

import { log } from '../logger.js';
import {
    detectTokenizerProfile,
    readTokenizerFingerprint,
    tokenizerSettingsEqual,
} from './ftsTokenizerProfile.js';
import type { FtsTokenizerSettings } from './ftsTokenizerProfile.js';
import { HISTORY_ID_LIKE_PATTERN } from './verbatimHistory.js';

/**
 * Mutable surface these helpers need from VerbatimStore. `ensureFtsIndex`
 * is the caller's own gated (searchGate.exclusive), sidecar-writing build
 * entry point — reconcileFtsTokenizer calls back into it rather than
 * duplicating the build/write logic here.
 */
export interface FtsReconcileCtx {
    readonly table: lancedb.Table | null;
    readonly basePath: string;
    ensureFtsIndex(opts: { minRows?: number; tokenizer?: FtsTokenizerSettings }): Promise<boolean>;
}

/** Total rows sampled for language/script detection, spread over
 *  SAMPLE_WINDOWS offset windows across the table (so the sample is not just
 *  the first rows physically written). 120, not 200: franc costs ~1 ms per
 *  ~900-char row, and the sample runs inside initialize() under the search
 *  gate on every open (measured: +75 ms vs the old 60-row sample at 5,000
 *  rows with 120; ~+150 ms with 200). */
const SAMPLE_ROWS = 120;
const SAMPLE_WINDOWS = 4;
/** Only the head of each text is used for detection: franc cost grows with
 *  length and a language verdict does not need more. 500, not 1000/2000:
 *  typical rows are ~900 chars, so a 1000 cap barely trims them (measured on
 *  120 rows of ~900 chars: old 60-row sample 57 ms; @2000 120 ms; @1000
 *  116 ms; @500 76 ms). */
const SAMPLE_TEXT_MAX_CHARS = 500;

const LIVE_ROWS_FILTER = `id NOT LIKE '${HISTORY_ID_LIKE_PATTERN}' AND text NOT LIKE '[TOMBSTONED%'`;

/** Bounded sample of live (non-history, non-tombstoned) row text, for
 *  language/script detection only — never returns more than maxRows, and never
 *  throws. Returns null when the read FAILED (distinct from an empty table), so
 *  the caller can keep the stored settings instead of treating an I/O hiccup as
 *  "no evidence" and flipping the index. Tables with more live rows than
 *  maxRows are read in SAMPLE_WINDOWS equal windows spread evenly over the
 *  table via the query `.offset()`. */
async function sampleTextForTokenizerDetection(ctx: FtsReconcileCtx, maxRows = SAMPLE_ROWS): Promise<string[] | null> {
    if (!ctx.table) return [];
    try {
        const total = await ctx.table.countRows(LIVE_ROWS_FILTER);
        const windowSize = Math.ceil(maxRows / SAMPLE_WINDOWS);
        const offsets: number[] = [];
        if (total <= maxRows) {
            offsets.push(0);
        } else {
            for (let w = 0; w < SAMPLE_WINDOWS; w++) {
                offsets.push(Math.floor((w * (total - windowSize)) / (SAMPLE_WINDOWS - 1)));
            }
        }
        const texts: string[] = [];
        for (const offset of offsets) {
            const rows = await ctx.table
                .query()
                .where(LIVE_ROWS_FILTER)
                .select(['text'])
                .offset(offset)
                .limit(total <= maxRows ? maxRows : windowSize)
                .toArray();
            for (const r of rows) {
                const row = r as { text?: unknown };
                if (typeof row.text === 'string' && row.text.length > 0) {
                    texts.push(row.text.length > SAMPLE_TEXT_MAX_CHARS ? row.text.slice(0, SAMPLE_TEXT_MAX_CHARS) : row.text);
                }
            }
        }
        return texts;
    } catch (err) {
        log.error(`[VerbatimStore] tokenizer sample read failed (non-fatal): ${(err as Error).message}`);
        return null;
    }
}

/** Stored settings for the current on-disk index, or null when none/unreadable.
 *  Feeds the hysteresis in detectTokenizerProfile. */
function readStoredSettings(ctx: FtsReconcileCtx): FtsTokenizerSettings | null {
    try {
        return readTokenizerFingerprint(ctx.basePath);
    } catch (err) {
        log.error(`[VerbatimStore] FTS tokenizer fingerprint unreadable (treating as unknown, non-fatal): ${(err as Error).message}`);
        return null;
    }
}

/**
 * Sample-driven tokenizer choice for THIS workspace (see
 * ftsTokenizerProfile.ts for the CJK-vs-Latin decision rule and the
 * clearly-dominant-language rule with hysteresis). `previous` is the stored
 * sidecar settings; omitted, it is read from the sidecar here so every caller
 * (including ensureFtsIndex) applies the same hysteresis. Best-effort: any
 * failure — including "table doesn't exist yet" — falls back to the Latin
 * default rather than throwing. A language-detection hiccup must never block
 * indexing.
 */
export async function detectDesiredTokenizer(
    ctx: FtsReconcileCtx,
    previous?: FtsTokenizerSettings | null,
): Promise<FtsTokenizerSettings> {
    const prev = previous === undefined ? readStoredSettings(ctx) : previous;
    try {
        const sample = await sampleTextForTokenizerDetection(ctx);
        if (sample === null && prev) return prev;
        return detectTokenizerProfile(sample ?? [], prev ?? undefined);
    } catch (err) {
        log.error(`[VerbatimStore] tokenizer language sampling failed (using Latin default, non-fatal): ${(err as Error).message}`);
        return detectTokenizerProfile([]);
    }
}

/** Best-effort targeted drop of whatever index (if any) sits on the `text`
 *  column — used only by reconcileFtsTokenizer below. Tolerant of "nothing
 *  there"; each drop attempt is individually guarded so one failure can't
 *  strand the rest (mirrors indexIntegrity.dropAllIndices' per-name
 *  guarding, but scoped to `text` only — the vector index is never touched
 *  by a tokenizer-only migration). */
async function dropTextIndexIfPresent(ctx: FtsReconcileCtx): Promise<void> {
    if (!ctx.table) return;
    try {
        const indices = await ctx.table.listIndices?.();
        if (!Array.isArray(indices)) return;
        for (const idx of indices) {
            const idxObj = idx as { columns?: string[]; name?: string };
            if (idxObj.columns?.includes('text') && idxObj.name) {
                const indexName = idxObj.name;
                await ctx.table.dropIndex(indexName).catch((err) => {
                    log.error(`[VerbatimStore] dropIndex('${indexName}') during tokenizer migration skipped (non-fatal): ${(err as Error).message}`);
                });
            }
        }
    } catch (err) {
        log.error(`[VerbatimStore] listIndices during tokenizer migration failed (non-fatal): ${(err as Error).message}`);
    }
}

/**
 * Startup tokenizer migration check (fix/fts-index-and-tokenizer, item 3
 * "Migration of existing workspaces"). Called once per store open, only
 * when the crash-recovery heal did NOT already run (see
 * VerbatimStore.initialize()). Mirrors embeddingFingerprint.ts's sidecar
 * pattern: a JSON file next to the LanceDB store records the tokenizer
 * settings that built the CURRENT on-disk index. A missing sidecar covers
 * two cases that both mean "unknown, rebuild once": a genuinely fresh
 * store, and a pre-migration store built before this feature existed —
 * which may even be sitting on the legacy `{config:{type:'fts'}}` bug that
 * built a BTree index instead of FTS (see VerbatimStore's
 * _bm25SearchUncached fix note); the drop below clears that too, and
 * ensureFtsIndex's own existing-index check (indexType === 'FTS') would
 * refuse to treat it as "done" even without this function's help.
 */
export async function reconcileFtsTokenizer(ctx: FtsReconcileCtx): Promise<void> {
    if (!ctx.table) return;
    let stored: FtsTokenizerSettings | null;
    try {
        stored = readTokenizerFingerprint(ctx.basePath);
    } catch (err) {
        log.error(`[VerbatimStore] FTS tokenizer fingerprint unreadable (treating as unknown, rebuilding once, non-fatal): ${(err as Error).message}`);
        stored = null;
    }
    const desired = await detectDesiredTokenizer(ctx, stored);
    if (stored !== null && tokenizerSettingsEqual(stored, desired)) return; // already correct — nothing to do.

    // Settings are unknown or stale. Drop any existing index on `text`
    // (best-effort — tolerant of "nothing to drop": createIndex's default
    // replace:true would clear it anyway) so the rebuild starts clean.
    // The rebuild itself is the crash-safe step — ensureFtsIndex wraps it
    // in the SAME markBuildStart/markBuildDone marker indexIntegrity.ts
    // already uses, not a second mechanism. A crash between this drop and
    // the rebuild leaves the index verifiably absent and the sidecar
    // unwritten; the next open re-detects "unknown" and retries — never a
    // silently-partial state.
    await dropTextIndexIfPresent(ctx);
    await ctx.ensureFtsIndex({ tokenizer: desired });
}
