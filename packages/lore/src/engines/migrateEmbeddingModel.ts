/**
 * migrateEmbeddingModel.ts — Q2.2 follow-up to slice 7.
 *
 * Re-embeds the entire local corpus into a different model's vector
 * space. The slice-7 commit message called this out as the missing
 * piece that gates flipping the default local model from MiniLM to
 * `multilingual-e5-small`:
 *
 *   "A future slice will add migration tooling (drop+rebuild
 *    `lore_verbatim`, modelId fingerprint check) to make flipping
 *    the default safe."
 *
 * Why this is needed:
 *   - Two embedding models produce vectors in different spaces. Mixing
 *     them in one LanceDB table silently degrades retrieval quality
 *     (you'd compare a MiniLM query vector to e5 doc vectors). LanceDB
 *     can't detect this — vector dim is the same (384) for both.
 *   - When dimensions differ (e.g. switching to BGE-M3 1024-d via
 *     OpenAICompatEmbeddingProvider), LanceDB rejects writes outright.
 *     The user sees an opaque schema error instead of a clear "your
 *     model and table dim disagree, run the migration".
 *
 * What it does:
 *   1. Reads the fingerprint at <basePath>/.lore/lancedb/embedding_model.json.
 *      If absent, assumes the legacy MiniLM/384 default.
 *   2. Validates the target model + dimension.
 *   3. Drops the `lore_verbatim` LanceDB table (no-op when missing).
 *   4. Runs the reconnect engine with `force: true`, re-embedding every
 *      LoreNode through the new
 *      EmbeddingProvider.
 *   5. Writes the new fingerprint.
 *
 * Idempotent: if the on-disk fingerprint already matches the target,
 * the migration is a no-op (returns `{ skipped: true }`). Operators
 * can run `lore migrate embedding-model --to <id>` without risk.
 *
 * Dry-run shows what WOULD happen without dropping the table or doing
 * any embed work — so an operator can sanity-check counts before
 * committing to a (potentially long) re-embed pass on a large corpus.
 */

import * as lancedb from '@lancedb/lancedb';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { LoreGraphHandle } from '../storage/loreStorageClient.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { VerbatimStore } from './verbatimStore.js';
import type * as verbatimHistory from './verbatimHistory.js';
import { reconnectGraph, type ReconnectableGraph } from './reconnect.js';
import {
    checkCompatibility,
    readFingerprintOrLegacy,
    writeFingerprint,
} from './embeddingFingerprint.js';

export interface MigrateEmbeddingModelOptions {
    /** Model id to migrate to (e.g. "Xenova/multilingual-e5-small"). Required. */
    targetModelId: string;
    /** Target dimension. Required. Must match the EmbeddingProvider's `dimension`. */
    targetDimension: number;
    /** EmbeddingProvider that produces vectors in the target space. Required. */
    targetProvider: EmbeddingProvider;
    /** When true, only print the plan; don't drop the table or re-embed. */
    dryRun?: boolean;
    /**
     * When true, run the migration even if the fingerprint already
     * matches the target. Useful for "I think the table is corrupt,
     * rebuild from scratch". Default false (idempotent no-op).
     */
    force?: boolean;
    /**
     * Cooperative cancellation, forwarded to `reconnectGraph`'s own
     * `shouldAbort` (polled at every page boundary and search chunk).
     *
     * This is the FOURTH `reconnectGraph` caller and it re-embeds the entire
     * corpus, so it is the longest-running of the four. Without it the sweep
     * has no stopping point short of completion, which is the pattern the
     * `/api/graph/reconnect` + first-install paths were fixed to stop using.
     * Optional because the CLI caller runs in a one-shot process with nothing
     * to drain; a host that embeds this must pass its tracker's seal.
     */
    shouldAbort?: () => boolean;
}

export interface MigrateEmbeddingModelResult {
    /** True when the on-disk fingerprint already matched and `force` was false. */
    skipped: boolean;
    /** Plan that was executed (or would have been, in dry-run). */
    from: { modelId: string; dimension: number };
    to: { modelId: string; dimension: number };
    /** Total LoreNodes considered for re-embed (`graph.listNodes()` size). */
    nodesScanned: number;
    /** Embeddings actually written into the rebuilt table (0 in dry-run). */
    embeddingsWritten: number;
    /** Whether the LanceDB `lore_verbatim` table was dropped. */
    tableDropped: boolean;
    /** Whether the new fingerprint was persisted to disk. */
    fingerprintWritten: boolean;
    /** Time the migration finished, ISO. Empty in dry-run. */
    completedAt: string;
    /**
     * 2026-08-17 (functional-correctness 4.5) — count of non-`lore:`
     * verbatim documents (store_verbatim writes — the ONLY store for that
     * content, since it has no graph copy) read back before the table drop
     * and re-added, re-embedded with the target provider, after the
     * rebuild. Canonical rows only — `#rev` revision-history snapshots are
     * still lost (export-excluded by design, same as workspace export);
     * that residual loss is intentional-but-documented, not silent.
     */
    nonNodeRowsPreserved: number;
    /**
     * True when `shouldAbort` stopped the re-embed sweep early. The new
     * fingerprint is then NOT written, so the on-disk fingerprint still names
     * the PREVIOUS model and a re-run repeats the migration — the same
     * "a marker may only advance over ground actually covered" rule the
     * reconnect cursors follow. Absent on a normal run.
     */
    aborted?: boolean;
}

/**
 * Drop the `lore_verbatim` LanceDB table at `<basePath>/.lore/lancedb/`.
 *
 * Returns `true` if the table existed and was dropped, `false` if it
 * was missing (treated as success — first migration on a fresh install
 * is a valid case). Throws on any other error (corrupted directory,
 * permissions, etc.) — the caller should NOT proceed to re-embed if
 * the table couldn't be cleanly dropped, because partial writes would
 * mix old and new vectors.
 */
async function dropVerbatimTable(basePath: string): Promise<boolean> {
    const lancedbPath = path.join(basePath, '.lore', 'lancedb');
    if (!fs.existsSync(lancedbPath)) return false;
    const db = await lancedb.connect(lancedbPath);
    const tables = await db.tableNames();
    if (!tables.includes('lore_verbatim')) return false;
    await db.dropTable('lore_verbatim');
    return true;
}

/**
 * Run the migration. Caller is responsible for:
 *   - constructing `graph` (already initialized) and `pluginRegistry`
 *     (already booted + schemas registered)
 *   - constructing `targetProvider` so its `modelId` and `dimension`
 *     match the `target*` parameters; these aren't read off the
 *     provider so the call site can use a wrapper / mock in tests.
 */
export async function migrateEmbeddingModel(
    basePath: string,
    graph: ReconnectableGraph,
    opts: MigrateEmbeddingModelOptions,
): Promise<MigrateEmbeddingModelResult> {
    const { targetModelId, targetDimension, targetProvider, dryRun = false, force = false, shouldAbort } = opts;

    if (!targetModelId || typeof targetModelId !== 'string') {
        throw new Error('[migrateEmbeddingModel] targetModelId is required');
    }
    if (!Number.isInteger(targetDimension) || targetDimension <= 0) {
        throw new Error(`[migrateEmbeddingModel] targetDimension must be a positive integer (got ${targetDimension})`);
    }
    if (!targetProvider || typeof targetProvider.embed !== 'function') {
        throw new Error('[migrateEmbeddingModel] targetProvider must implement EmbeddingProvider');
    }

    const current = readFingerprintOrLegacy(basePath);
    const compat = checkCompatibility(basePath, { modelId: targetModelId, dimension: targetDimension });

    // Idempotent fast path: target == current AND not forced.
    if (compat.matches && !force) {
        return {
            skipped: true,
            from: { modelId: current.modelId, dimension: current.dimension },
            to: { modelId: targetModelId, dimension: targetDimension },
            nodesScanned: 0,
            embeddingsWritten: 0,
            tableDropped: false,
            fingerprintWritten: false,
            completedAt: '',
            nonNodeRowsPreserved: 0,
        };
    }

    // Count nodes for the plan (cheap, runs in dry-run too).
    const allNodes = await graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
    const nodesScanned = allNodes.length;

    if (dryRun) {
        return {
            skipped: false,
            from: { modelId: current.modelId, dimension: current.dimension },
            to: { modelId: targetModelId, dimension: targetDimension },
            nodesScanned,
            embeddingsWritten: 0,
            tableDropped: false,
            fingerprintWritten: false,
            completedAt: '',
            nonNodeRowsPreserved: 0,
        };
    }

    // 0. Preserve non-node verbatim documents (2026-08-17, functional-
    //    correctness 4.5). store_verbatim forbids `lore:`-prefixed ids by
    //    construction (assertSafeVerbatimId), so every id here NOT starting
    //    with `lore:` is content that ONLY EVER EXISTED in this table —
    //    there is no graph copy to rebuild it from, unlike LoreNodes.
    //    Dropping the table and rebuilding solely from `graph.listNodes()`
    //    (step 2 below) used to delete this content permanently. Read it
    //    back BEFORE the drop; re-add it (re-embedded with the target
    //    provider — the old vectors are in the wrong space) after the
    //    rebuild, independent of whether the graph re-embed pass aborted
    //    (these rows have nothing to do with graph nodes). Canonical rows
    //    only: `#rev` history snapshots are export-excluded by
    //    `exportRows()` (same as workspace export) — that residual loss is
    //    a known, documented gap, not a silent one.
    let preservedRows: Array<{ id: string; text: string; contentHash: string; metadata: verbatimHistory.VerbatimExportRow['metadata'] }> = [];
    try {
        const existingStore = new VerbatimStore(basePath, targetProvider);
        const exported = await existingStore.exportRows();
        preservedRows = exported.rows.filter((r) => !r.id.startsWith('lore:'));
    } catch {
        // No table yet (fresh install) — nothing to preserve.
        preservedRows = [];
    }

    // 1. Drop the existing table. If this fails, abort BEFORE writing
    //    a new fingerprint — operators must not see "fingerprint says
    //    e5-small" while the table still holds MiniLM vectors.
    const tableDropped = await dropVerbatimTable(basePath);

    // 2. Re-embed everything via reconnect with the new provider.
    //    `force: true` ensures contentHash skipping doesn't preserve
    //    any rows that might have survived (defensive — dropTable
    //    above should have removed them all).
    //    `dryRun: false` actually writes; we never want a dry-run
    //    inside a non-dry-run migration.
    //    `pruneInferred: false` because we just dropped the vector
    //    table; LoreEdge prune is unrelated to the embedding swap and
    //    would make the operator wait for an unrelated cleanup.
    const verbatim = new VerbatimStore(basePath, targetProvider);
    const result = await reconnectGraph(graph, verbatim, {
        dryRun: false,
        force: true,
        pruneInferred: false,
        ...(shouldAbort ? { shouldAbort } : {}),
    });

    // 2b. Restore the preserved non-node documents, re-embedded with the
    //     target provider. Runs regardless of `result.aborted` — these rows
    //     are independent of graph-node re-embedding, so an aborted graph
    //     sweep is no reason to leave store_verbatim content lost as well.
    //     Best-effort per row: one bad row must not lose the rest.
    let nonNodeRowsPreserved = 0;
    for (const row of preservedRows) {
        try {
            await verbatim.store({
                id: row.id,
                text: row.text,
                metadata: {
                    type: row.metadata.type ?? '',
                    label: row.metadata.label ?? '',
                    tags: row.metadata.tags ?? '',
                    project: row.metadata.project ?? '',
                    ecosystem: row.metadata.ecosystem ?? '',
                    updatedAt: row.metadata.updatedAt ?? new Date().toISOString(),
                    contentHash: row.contentHash,
                },
            });
            nonNodeRowsPreserved++;
        } catch { /* best-effort restore — one bad row must not lose the rest */ }
    }

    // 2c. An aborted re-embed leaves the table PARTIALLY populated, so the
    //     fingerprint must not be advanced: writing it would tell every later
    //     run "already on the target model" while most rows still hold vectors
    //     from the old one — an invisible, permanent half-migration. Returning
    //     without the fingerprint keeps the documented recovery ("operator can
    //     re-run the migration") available.
    if (result.aborted) {
        return {
            skipped: false,
            from: { modelId: current.modelId, dimension: current.dimension },
            to: { modelId: targetModelId, dimension: targetDimension },
            nodesScanned,
            embeddingsWritten: result.embeddingsAdded,
            tableDropped,
            fingerprintWritten: false,
            completedAt: '',
            nonNodeRowsPreserved,
            aborted: true,
        };
    }

    // 3. Persist the new fingerprint LAST. If the embed pass crashed,
    //    the on-disk fingerprint still reflects the previous (now
    //    invalid) state — operator can re-run the migration.
    writeFingerprint(basePath, { modelId: targetModelId, dimension: targetDimension });

    return {
        skipped: false,
        from: { modelId: current.modelId, dimension: current.dimension },
        to: { modelId: targetModelId, dimension: targetDimension },
        nodesScanned,
        embeddingsWritten: result.embeddingsAdded,
        tableDropped,
        fingerprintWritten: true,
        completedAt: new Date().toISOString(),
        nonNodeRowsPreserved,
    };
}
