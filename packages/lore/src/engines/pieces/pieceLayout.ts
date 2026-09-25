/**
 * pieceLayout.ts — D7 (3.23, piece-level vectors), design section 2.4.
 *
 * A node is normally indexed as ONE mean-pooled vector for its whole
 * verbatim text, which blurs recall on long documents (a query matching
 * one paragraph competes against the averaged signal of the whole node).
 * "Pieces" are a parallel, derived, opt-in index: a title row (the node's
 * label) plus overlapping ~128-token windows of the body, each embedded
 * and searched independently, then rolled back up to the owning node id
 * by the (out-of-scope, later-slice) retrieval layer.
 *
 * PIECE_LAYOUT_V1 is NOT configurable by env or option — window/overlap
 * size are baked into the layout id. Changing them is a new layout
 * (`pieces-v2`, ...), not a tunable, because an index built under one
 * layout is meaningless under another: mixing windows of different sizes
 * in one search would silently bias toward whichever window size happens
 * to score higher for reasons that have nothing to do with relevance.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { EmbeddingProvider } from '../../providers/types.js';
import { embeddingProviderFingerprint } from '../../providers/localEmbeddingProvider.js';
import { getFingerprintPath } from '../embeddingFingerprint.js';

export const PIECE_LAYOUT_V1 = {
    layout: 'pieces-v1' as const,
    windowTokens: 128,
    overlapTokens: 32,
    titleRow: true,
} as const;

/** Fixed-width character-window fallback, used only when the embedding
 *  provider exposes no `splitIntoWindows` (or it rejects — no usable
 *  tokenizer on that provider). Not a tunable, not env-driven: like
 *  PIECE_LAYOUT_V1's token window, it is baked into the layout so the
 *  sidecar's `tokenizer: 'chars'` marker is a complete description of
 *  how a piece was produced. */
export const CHAR_WINDOW_SIZE = 480;
export const CHAR_WINDOW_OVERLAP = 120;

export interface PieceRow {
    /** 0 for the title row (skipped when the label is empty); 1..n for
     *  body windows, in order. */
    pieceIndex: number;
    /** The exact text that was embedded — `label` alone for the title
     *  row, `label + '\n' + window` for a body window (design 2.4: the
     *  label is prepended to every piece so a window embedded in
     *  isolation still carries its owning node's title as context). */
    text: string;
    isTitle: boolean;
}

/**
 * `buildVerbatimText` (verbatimSchema.ts) joins `[label, content, tags]`
 * with blank lines to produce the canonical row's stored text. Piece
 * building needs the body ALONE (not re-embedding the label twice, once
 * as the title row and again as part of the body's first window) — this
 * strips exactly the `label + '\n\n'` prefix `buildVerbatimText` would
 * have added, when present, and returns the text unchanged otherwise
 * (e.g. a caller that passes body text directly, as the unit tests do).
 */
export function stripLeadingLabel(text: string, label: string | undefined): string {
    if (!label) return text;
    const prefix = `${label}\n\n`;
    return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/**
 * Split `body` into overlapping windows, preferring the embedding
 * provider's own tokenizer (`splitIntoWindows`) for an exact token count.
 * Falls back to a fixed character window (480/120) when the provider
 * doesn't implement `splitIntoWindows`, or when it throws (no usable
 * tokenizer on that provider/pipeline). Returns `{ windows, tokenizer }`
 * so the caller can stamp the sidecar's `tokenizer` field accurately.
 */
async function splitBody(
    provider: EmbeddingProvider,
    body: string,
): Promise<{ windows: string[]; tokenizer: 'model' | 'chars' }> {
    const trimmed = body.trim();
    if (trimmed.length === 0) return { windows: [], tokenizer: 'model' };
    if (typeof provider.splitIntoWindows === 'function') {
        try {
            const windows = await provider.splitIntoWindows(
                trimmed,
                PIECE_LAYOUT_V1.windowTokens,
                PIECE_LAYOUT_V1.overlapTokens,
            );
            if (windows.length > 0) return { windows, tokenizer: 'model' };
        } catch {
            // No usable tokenizer on this provider — fall through to the
            // char-window fallback below. Not re-thrown: a provider that
            // can embed but can't tokenize for windowing purposes should
            // still get a (coarser) piece index, not lose the feature
            // entirely.
        }
    }
    return { windows: charWindows(trimmed), tokenizer: 'chars' };
}

function charWindows(text: string): string[] {
    if (text.length <= CHAR_WINDOW_SIZE) return [text];
    const windows: string[] = [];
    const stride = Math.max(1, CHAR_WINDOW_SIZE - CHAR_WINDOW_OVERLAP);
    for (let start = 0; start < text.length; start += stride) {
        const window = text.slice(start, start + CHAR_WINDOW_SIZE);
        if (window.trim().length > 0) windows.push(window);
        if (start + CHAR_WINDOW_SIZE >= text.length) break;
    }
    return windows.length > 0 ? windows : [text];
}

/**
 * Build the full piece list for a node: a title row (piece 0, the label
 * alone — skipped when `label` is empty/undefined) followed by one piece
 * per body window (`label + '\n' + window`, so every piece carries its
 * owning node's title even when read in isolation). `body` must already
 * have any `buildVerbatimText`-added label prefix stripped (see
 * `stripLeadingLabel`) — this function does not re-derive that.
 *
 * Returns `{ pieces, tokenizer }` — `pieces` is `[]` for a node with no
 * label and no non-empty body (nothing to piece).
 */
export async function buildPieces(
    provider: EmbeddingProvider,
    label: string | undefined,
    body: string,
): Promise<{ pieces: PieceRow[]; tokenizer: 'model' | 'chars' }> {
    const pieces: PieceRow[] = [];
    const trimmedLabel = label?.trim();
    let index = 0;
    if (PIECE_LAYOUT_V1.titleRow && trimmedLabel) {
        pieces.push({ pieceIndex: index++, text: trimmedLabel, isTitle: true });
    }
    const { windows, tokenizer } = await splitBody(provider, body);
    for (const window of windows) {
        const text = trimmedLabel ? `${trimmedLabel}\n${window}` : window;
        pieces.push({ pieceIndex: index++, text, isTitle: false });
    }
    return { pieces, tokenizer };
}

// ---- sidecar -----------------------------------------------------------

export interface PieceSidecar {
    layout: typeof PIECE_LAYOUT_V1.layout;
    windowTokens: number;
    overlapTokens: number;
    titleRow: boolean;
    /** Which splitter actually produced the pieces currently in the
     *  index — 'model' (provider tokenizer) or 'chars' (fixed-width
     *  fallback). Informational; validity does NOT depend on this
     *  matching the live provider's capability, only on `embedding`
     *  matching the live provider's fingerprint (a provider can lose/
     *  gain a usable tokenizer across restarts without invalidating an
     *  otherwise-current index). */
    tokenizer: 'model' | 'chars';
    /** `embeddingProviderFingerprint(provider)` at the time the index
     *  was (re)built — must match the live provider's fingerprint or the
     *  index is stale (a different model/dtype produces vectors that are
     *  not comparable). */
    embedding: string;
    /** True only once every canonical row at build time has been piece-
     *  indexed — a partially-built index (crash mid-migration, out of
     *  scope for D7a since nothing yet builds a non-empty index other
     *  than incrementally via store hooks) must never be used for
     *  search: no partial use and no silent mixing. */
    complete: boolean;
}

function pieceSidecarPath(basePath: string): string {
    return path.join(path.dirname(getFingerprintPath(basePath)), 'piece_layout.json');
}

export function readPieceSidecar(basePath: string): PieceSidecar | null {
    const fp = pieceSidecarPath(basePath);
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, 'utf-8');
    try {
        return JSON.parse(raw) as PieceSidecar;
    } catch (err) {
        throw new Error(`[pieceLayout] corrupt piece sidecar at ${fp}: ${(err as Error).message}`);
    }
}

/** Atomic tmp-file-then-rename write, matching the fingerprint sidecar's
 *  own convention (embeddingFingerprint.ts's writeFingerprint) — a crash
 *  mid-write must never leave a half-written JSON file behind. */
export function writePieceSidecar(basePath: string, sidecar: PieceSidecar): void {
    const fp = pieceSidecarPath(basePath);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = `${fp}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(sidecar, null, 2), 'utf-8');
    fs.renameSync(tmp, fp);
}

/**
 * A sidecar is usable ONLY when every layout field matches PIECE_LAYOUT_V1
 * exactly AND `embedding` matches the live provider's fingerprint AND
 * `complete` is true. Any mismatch means "stale" — never partial use,
 * never silent mixing of vectors from different layouts/models.
 */
export function isPieceSidecarValid(
    sidecar: PieceSidecar | null,
    provider: Pick<EmbeddingProvider, 'modelId' | 'dtype'>,
): { valid: true } | { valid: false; reason: string } {
    if (!sidecar) return { valid: false, reason: 'no sidecar' };
    if (!sidecar.complete) return { valid: false, reason: 'incomplete build' };
    if (
        sidecar.layout !== PIECE_LAYOUT_V1.layout ||
        sidecar.windowTokens !== PIECE_LAYOUT_V1.windowTokens ||
        sidecar.overlapTokens !== PIECE_LAYOUT_V1.overlapTokens ||
        sidecar.titleRow !== PIECE_LAYOUT_V1.titleRow
    ) {
        return { valid: false, reason: 'layout mismatch' };
    }
    const liveFingerprint = embeddingProviderFingerprint(provider);
    if (sidecar.embedding !== liveFingerprint) {
        return { valid: false, reason: `embedding fingerprint mismatch (sidecar=${sidecar.embedding}, live=${liveFingerprint})` };
    }
    return { valid: true };
}

export function freshPieceSidecar(provider: Pick<EmbeddingProvider, 'modelId' | 'dtype'>, tokenizer: 'model' | 'chars'): PieceSidecar {
    return {
        layout: PIECE_LAYOUT_V1.layout,
        windowTokens: PIECE_LAYOUT_V1.windowTokens,
        overlapTokens: PIECE_LAYOUT_V1.overlapTokens,
        titleRow: PIECE_LAYOUT_V1.titleRow,
        tokenizer,
        embedding: embeddingProviderFingerprint(provider),
        complete: true,
    };
}
