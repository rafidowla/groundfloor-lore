/**
 * indexIntegrity.ts — crash-safe LanceDB index builds + corruption self-heal.
 *
 * Problem this closes (2026-07-01): building an FTS / IVF-PQ index writes into
 * the live LanceDB table. If the process is killed partway through the build
 * (crash, OOM, SIGKILL, power loss), the table's manifest can end up pointing
 * at a half-written index. Every later read then re-loads that broken index —
 * in the worst case a native abort (SIGSEGV, uncatchable), so the WHOLE process
 * crash-loops on every read until someone rebuilds by hand. The base table
 * data survives; only the index is damaged (confirmed empirically against
 * @lancedb/lancedb 0.27.2 — a corrupt index count-scans fine but index reads
 * fail).
 *
 * Two mechanisms, defence in depth:
 *
 *  1. BUILD MARKER (atomicity signal). {@link markBuildStart} drops a tiny
 *     sentinel file next to the LanceDB dir *before* `createIndex`, and
 *     {@link markBuildDone} removes it on success (or caught failure). A marker
 *     that survives into the next open == "the last build did not finish" ==
 *     the index is suspect. This is a pure filesystem signal: detecting it
 *     never reads (and so never crashes on) the corrupt index.
 *
 *  2. HEAL. {@link dropAllIndices} removes every index from the table via the
 *     metadata-only `dropIndex` path (verified safe on a corrupt index — it
 *     warns, it does not abort), leaving the table index-less so reads fall
 *     back to a brute-force scan. The caller then rebuilds the indices from the
 *     surviving rows. dropIndex + createIndex was verified to produce a working
 *     index across a fresh process, where fs-deleting the index dir does NOT
 *     (it leaves a dangling manifest reference → "Not found: index.idx").
 *
 * {@link isIndexCorruptionError} recognises the (catchable) errors LanceDB
 * 0.27.2 throws when it does manage to surface a corrupt index as a JS error
 * rather than a hard abort — used by the search paths to schedule a heal
 * instead of propagating a useless error.
 *
 * Worker-process isolation (so an *uncatchable* native abort only restarts a
 * worker instead of the whole service) is the heavier follow-on and lives
 * outside this module.
 */

import fs from 'fs';
import path from 'path';

import { log } from '../logger.js';

/** Index kinds we build on lore_verbatim. */
export type IndexKind = 'vector' | 'fts';

/**
 * Per-kind sentinel filename. One file per kind (rather than one shared file)
 * so the concurrent `ensureVectorIndex` (ungated) and `ensureFtsIndex` (gated)
 * builds never race on a single marker's contents.
 */
function markerPath(lancedbPath: string, kind: IndexKind): string {
    return path.join(lancedbPath, `.index-building-${kind}`);
}

/**
 * Record that an index build is starting. Best-effort: a failure to write the
 * marker must not block the build itself (worst case we lose crash-safety for
 * this one build, which is strictly better than refusing to index).
 */
export function markBuildStart(lancedbPath: string, kind: IndexKind): void {
    try {
        fs.mkdirSync(lancedbPath, { recursive: true });
        // Content is advisory only; presence is what matters. No timestamp via
        // Date.now() here keeps the module side-effect-pure for tests that stub
        // time — the mtime on disk is enough for humans debugging.
        fs.writeFileSync(markerPath(lancedbPath, kind), `${kind}\n`, 'utf8');
    } catch (err) {
        log.error(`[indexIntegrity] could not write ${kind} build marker (non-fatal): ${(err as Error).message}`);
    }
}

/** Clear a build marker after the build completes (or fails cleanly). */
export function markBuildDone(lancedbPath: string, kind: IndexKind): void {
    try {
        fs.rmSync(markerPath(lancedbPath, kind), { force: true });
    } catch (err) {
        log.error(`[indexIntegrity] could not clear ${kind} build marker (non-fatal): ${(err as Error).message}`);
    }
}

/**
 * True if any index build was left unfinished (its marker survived a restart) —
 * i.e. the on-disk index for this workspace is suspect and must be healed
 * before it is read. Pure filesystem check: never touches the index itself.
 */
export function hasInterruptedBuild(lancedbPath: string): boolean {
    const kinds: IndexKind[] = ['vector', 'fts'];
    return kinds.some((k) => {
        try {
            return fs.existsSync(markerPath(lancedbPath, k));
        } catch {
            return false;
        }
    });
}

/** Clear every build marker (after a successful heal). */
export function clearAllBuildMarkers(lancedbPath: string): void {
    (['vector', 'fts'] as IndexKind[]).forEach((k) => markBuildDone(lancedbPath, k));
}

/**
 * Minimal shape of the LanceDB Table bits the heal path needs. Kept structural
 * so this module doesn't drag in the full lancedb types (and so tests can pass
 * a fake).
 */
export interface HealableTable {
    listIndices?: () => Promise<Array<{ name?: string }>>;
    dropIndex?: (name: string) => Promise<void>;
}

/**
 * LanceDB's default index names: `<column>_idx`. We build indices on `vector`
 * and `text`, so these are the names to drop when enumeration fails.
 */
const CONVENTIONAL_INDEX_NAMES = ['vector_idx', 'text_idx'];

/**
 * Drop every index on the table via the metadata-only `dropIndex` path. Safe on
 * a corrupt index (dropIndex does not read the index payload — it removes the
 * manifest reference, emitting a "Failed to get statistics" warning at worst).
 *
 * Robustness: `listIndices()` can itself FAIL to enumerate a corrupt index
 * (observed: it returns nothing / throws when the index files are damaged), so
 * we UNION whatever it reports with the conventional `<column>_idx` names and
 * attempt every candidate. Each drop is individually guarded — a name that
 * isn't actually present (or won't drop) can't strand the rest. Returns the
 * number of indices actually dropped.
 */
export async function dropAllIndices(table: HealableTable): Promise<number> {
    if (typeof table.dropIndex !== 'function') return 0;

    const names = new Set<string>(CONVENTIONAL_INDEX_NAMES);
    if (typeof table.listIndices === 'function') {
        try {
            for (const idx of (await table.listIndices()) ?? []) {
                if (idx?.name) names.add(idx.name);
            }
        } catch (err) {
            // Enumeration failed (corrupt index) — fall back to the
            // conventional names already seeded above.
            log.error(`[indexIntegrity] listIndices failed during heal (using conventional names): ${(err as Error).message}`);
        }
    }

    let dropped = 0;
    for (const name of names) {
        try {
            await table.dropIndex(name);
            dropped += 1;
        } catch (err) {
            // Absent or un-droppable — non-fatal; a fresh createIndex rebuild
            // supersedes whatever remains.
            log.error(`[indexIntegrity] dropIndex('${name}') skipped during heal: ${(err as Error).message}`);
        }
    }
    return dropped;
}

/**
 * Substrings LanceDB 0.27.2 uses when it surfaces a corrupt / unreadable index
 * as a catchable JS error (vs a hard native abort). Matched case-insensitively
 * against the error message so the search paths can schedule a heal + degrade
 * instead of propagating a dead-end error.
 */
const INDEX_CORRUPTION_SIGNS = [
    'unsupported index version',
    'lanceerror(index)',
    'lance error: lanceerror(index)',
    '.idx', // "Not found: .../index.idx" — dangling / missing index artifact
    'corrupt',
];

/** True if the error looks like a corrupt / unreadable LanceDB index. */
export function isIndexCorruptionError(err: unknown): boolean {
    const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
    if (!msg) return false;
    return INDEX_CORRUPTION_SIGNS.some((sign) => msg.includes(sign));
}
