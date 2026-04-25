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
 *      LoreNode AND every plugin-contributed node through the new
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

import type { LocalGraph } from './localGraph.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { EmbeddingProvider } from '../providers/types.js';
import { VerbatimStore } from './verbatimStore.js';
import { reconnectGraph } from './reconnect.js';
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
    graph: LocalGraph,
    pluginRegistry: PluginRegistry,
    opts: MigrateEmbeddingModelOptions,
): Promise<MigrateEmbeddingModelResult> {
    const { targetModelId, targetDimension, targetProvider, dryRun = false, force = false } = opts;

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
        };
    }

    // Count nodes for the plan (cheap, runs in dry-run too).
    const allNodes = await graph.listNodes();
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
        };
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
    const result = await reconnectGraph(graph, verbatim, pluginRegistry, {
        dryRun: false,
        force: true,
        pruneInferred: false,
    });

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
    };
}
