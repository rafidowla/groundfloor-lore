/**
 * pieceIndexBuild.ts — D7c (3.23, piece-level vectors), design section 2.8.
 *
 * `buildPieceIndex(basePath, store, provider, opts)` is the engine-agnostic
 * primitive behind `lore migrate piece-vectors`. It always performs a full
 * drop-then-rebuild-fresh on any non-no-op, non-dry-run, non-drop run — a
 * deliberate scope reduction from the design's per-node `contentHash`-skip
 * resume path (2.8 step 4) and orphan-piece delete (step 5): a fresh table
 * built from every canonical row can never contain a stale/orphaned nodeId,
 * so step 5 is satisfied trivially, and correctness (idempotent, safely
 * resumable) does not depend on the per-node skip, only its efficiency does.
 * See D7c's handoff for the tradeoff this makes against a very large store.
 *
 * Engine-agnostic: `store` only needs `exportRows()` (already public on both
 * VerbatimStore and SqliteVerbatimStore) and `pieceIndexForMigration()` (a
 * D7c addition to both — returns the store's own already-wired
 * LancePieceIndex/SqlitePieceIndex instance, reused here rather than
 * re-derived, so this module never needs a Lance path or a raw SQLite
 * handle of its own).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { log } from '../../logger.js';
import type { EmbeddingProvider } from '../../providers/types.js';
import { embeddingProviderFingerprint } from '../../providers/localEmbeddingProvider.js';
import { getFingerprintPath } from '../embeddingFingerprint.js';
import {
    PIECE_LAYOUT_V1, readPieceSidecar, writePieceSidecar, isPieceSidecarValid,
    type PieceSidecar,
} from './pieceLayout.js';

/** The narrow surface buildPieceIndex needs from either store engine. */
export interface PieceBuildableStore {
    exportRows(opts?: { project?: string }): Promise<{
        rows: Array<{
            id: string;
            text: string;
            metadata: { type?: string; label?: string; project?: string; ecosystem?: string };
        }>;
    }>;
    pieceIndexForMigration(): PieceIndexLike | null;
}

/** The narrow surface of LancePieceIndex/SqlitePieceIndex buildPieceIndex
 *  needs — both classes already satisfy this shape structurally. */
export interface PieceIndexLike {
    upsertForRows(rows: Array<{
        id: string; label?: string; text: string; type?: string;
        project?: string; ecosystem?: string; security_scopes?: string[];
    }>): Promise<void>;
    drop(): Promise<void>;
    /** (Re)create the table fresh+empty and mark the index valid, without
     *  touching the sidecar — see LancePieceIndex.createEmptyForRebuild()'s
     *  docblock. Required before any upsertForRows() call in a rebuild: both
     *  engines no-op upsertForRows()/deleteForIds() while `!valid`, and
     *  drop() alone leaves the index invalid. */
    createEmptyForRebuild(): Promise<void>;
    count(): Promise<number>;
}

export interface BuildPieceIndexOptions {
    /** Rebuild even when the sidecar is already valid+complete. */
    force?: boolean;
    /** Count/estimate only — writes nothing (no sidecar, no table changes). */
    dryRun?: boolean;
    /** Remove the table + sidecar and stop — disable and reclaim disk. */
    drop?: boolean;
    /** Checked between batches; a truthy return aborts before completion
     *  (the sidecar is left `complete:false`, matching an interrupted run —
     *  the next invocation resumes/rebuilds safely, per this module's
     *  full-rebuild strategy above). */
    shouldAbort?: () => boolean;
    batchSize?: number;
}

export type BuildPieceIndexAction = 'noop' | 'dropped' | 'dry-run' | 'built' | 'aborted';

export interface BuildPieceIndexResult {
    action: BuildPieceIndexAction;
    nodesScanned: number;
    nodesRebuilt: number;
    piecesIndexed: number;
    reason?: string;
}

const DEFAULT_BATCH_SIZE = 256;
/** Matches pieceLayout.ts's own char-window fallback stride (480 - 120) —
 *  used only for the `--dry-run` piece-count estimate below, never for real
 *  windowing (which always goes through buildPieces via upsertForRows). */
const ESTIMATE_STRIDE = 480 - 120;

export async function buildPieceIndex(
    basePath: string,
    store: PieceBuildableStore,
    provider: Pick<EmbeddingProvider, 'modelId' | 'dtype'>,
    opts: BuildPieceIndexOptions = {},
): Promise<BuildPieceIndexResult> {
    const existingSidecar = readPieceSidecar(basePath);
    const existingCheck = isPieceSidecarValid(existingSidecar, provider);

    // --drop: remove the table + sidecar and disable, regardless of current
    // validity — disable-and-reclaim, not a rebuild.
    if (opts.drop) {
        const idx = store.pieceIndexForMigration();
        if (idx) {
            await idx.drop().catch((err: Error) =>
                log.warn(`[buildPieceIndex] drop failed (continuing — sidecar removal still proceeds): ${err.message}`));
        }
        removePieceSidecarFile(basePath);
        return { action: 'dropped', nodesScanned: 0, nodesRebuilt: 0, piecesIndexed: 0 };
    }

    // Step 1: already built, valid, and no --force -> no-op.
    if (existingCheck.valid && existingSidecar?.complete && !opts.force) {
        const idx = store.pieceIndexForMigration();
        const pieceCount = idx ? await idx.count().catch(() => 0) : 0;
        return {
            action: 'noop', nodesScanned: 0, nodesRebuilt: 0,
            piecesIndexed: pieceCount, reason: 'already built',
        };
    }

    // Step 3 (design 2.8) — a sidecar that IS present and complete, but whose
    // layout or embedding fingerprint no longer matches (existingCheck.valid
    // is false with reason 'layout mismatch' / 'embedding fingerprint
    // mismatch (...)') is a DIFFERENT case from "no sidecar yet" or "build
    // was interrupted" (reason 'incomplete build', handled below by the
    // ordinary rebuild path — that one resumes automatically, no flag
    // needed). A complete-but-mismatched index reflects a deliberate prior
    // build under a layout/model this run no longer matches; silently
    // discarding and rebuilding it without being asked could surprise an
    // operator mid-investigation, so this refuses and requires an explicit
    // --force (rebuild) or --drop (remove) — same "ask before discarding a
    // complete result" posture migrateEmbeddingModel.ts's dry-run-by-default
    // takes for its own destructive rebuild, applied here only to the one
    // case that is actually destroying a previously-COMPLETE index rather
    // than finishing an unfinished or nonexistent one.
    if (!existingCheck.valid && existingSidecar?.complete && !opts.force) {
        return {
            action: 'aborted', nodesScanned: 0, nodesRebuilt: 0, piecesIndexed: 0,
            reason: `refusing to rebuild over a mismatched piece index (${existingCheck.reason}) — pass --force to rebuild or --drop to remove it first`,
        };
    }

    const exported = await store.exportRows();
    const rows = exported.rows;

    if (opts.dryRun) {
        const sampleN = Math.min(20, rows.length);
        let sampledPieces = 0;
        for (let i = 0; i < sampleN; i++) {
            const r = rows[i];
            const windows = r.text.trim().length === 0 ? 0
                : Math.max(1, Math.ceil(r.text.length / ESTIMATE_STRIDE));
            sampledPieces += (r.metadata.label ? 1 : 0) + windows;
        }
        const estimatedPieces = sampleN > 0 ? Math.round((sampledPieces / sampleN) * rows.length) : 0;
        return {
            action: 'dry-run', nodesScanned: rows.length, nodesRebuilt: 0,
            piecesIndexed: estimatedPieces,
            reason: `${rows.length} node(s), ~${estimatedPieces} piece(s) estimated (nothing written)`,
        };
    }

    const idx = store.pieceIndexForMigration();
    if (!idx) {
        return {
            action: 'aborted', nodesScanned: rows.length, nodesRebuilt: 0, piecesIndexed: 0,
            reason: 'store has no piece-index instance available for this engine',
        };
    }

    // Non-no-op, non-dry-run, non-drop: always a full drop + rebuild — see
    // module docblock. Covers both "--force on an already-valid index" and
    // "stale/absent/mixed-layout sidecar", and step 3's "drop it first when
    // layout/fingerprint differs" is unconditional here rather than gated.
    //
    // createEmptyForRebuild() (not drop()) — drop() alone leaves the index
    // `valid=false`, and both engines no-op upsertForRows()/deleteForIds()
    // while invalid, which would make the rebuild loop below silently write
    // zero pieces. createEmptyForRebuild() drops+recreates the table AND
    // marks it valid again, without touching the sidecar (this function
    // owns that lifecycle, written next). Unlike the old best-effort
    // drop()-and-continue, a failure here is fatal to the run: proceeding
    // with an invalid index would build a sidecar claiming completeness
    // over zero real pieces.
    try {
        await idx.createEmptyForRebuild();
    } catch (err) {
        return {
            action: 'aborted', nodesScanned: rows.length, nodesRebuilt: 0, piecesIndexed: 0,
            reason: `failed to (re)create the piece table: ${(err as Error).message}`,
        };
    }

    // Write the sidecar with complete:false FIRST — a crash or abort from
    // here until the final write leaves it correctly marked stale, so a
    // concurrent query (which checks `complete`) or a re-run never treats a
    // partial build as usable.
    const inProgressSidecar: PieceSidecar = {
        layout: PIECE_LAYOUT_V1.layout,
        windowTokens: PIECE_LAYOUT_V1.windowTokens,
        overlapTokens: PIECE_LAYOUT_V1.overlapTokens,
        titleRow: PIECE_LAYOUT_V1.titleRow,
        tokenizer: 'model',
        embedding: embeddingProviderFingerprint(provider),
        complete: false,
    };
    writePieceSidecar(basePath, inProgressSidecar);

    const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : DEFAULT_BATCH_SIZE;
    let nodesRebuilt = 0;
    let aborted = false;
    for (let i = 0; i < rows.length; i += batchSize) {
        if (opts.shouldAbort?.()) { aborted = true; break; }
        const batch = rows.slice(i, i + batchSize).map((r) => ({
            id: r.id,
            label: r.metadata.label,
            text: r.text,
            type: r.metadata.type,
            project: r.metadata.project,
            ecosystem: r.metadata.ecosystem,
            // D7c — exportRows()'s VerbatimExportRow carries no
            // security_scopes (verbatimHistory.ts's export shape omits it) —
            // the same documented gap migrateEmbeddingModel.ts already
            // accepts for its own non-node-row re-embed path (see that
            // file's step 0 comment). A node with security_scopes set loses
            // piece-level scoping until its next incremental write refreshes
            // its pieces with the real value; canonical-row scope
            // enforcement is unaffected either way.
            security_scopes: [] as string[],
        }));
        await idx.upsertForRows(batch);
        nodesRebuilt += batch.length;
    }

    if (aborted) {
        return {
            action: 'aborted', nodesScanned: rows.length, nodesRebuilt, piecesIndexed: 0,
            reason: 'aborted before completion — sidecar left incomplete, re-run to resume/rebuild',
        };
    }

    writePieceSidecar(basePath, { ...inProgressSidecar, complete: true });
    const piecesIndexed = await idx.count().catch(() => 0);
    return { action: 'built', nodesScanned: rows.length, nodesRebuilt, piecesIndexed };
}

function removePieceSidecarFile(basePath: string): void {
    // pieceLayout.ts deliberately does not export a delete helper or its
    // own private path-join function — mirror its exact derivation (same
    // dir as the embedding fingerprint) via the one piece it DOES export,
    // getFingerprintPath, rather than hardcoding the '.lore/lancedb' segment.
    const fp = path.join(path.dirname(getFingerprintPath(basePath)), 'piece_layout.json');
    try { fs.rmSync(fp, { force: true }); } catch { /* best-effort */ }
}
