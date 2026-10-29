/**
 * ingestion/ingestionBlobErase.ts — erase the uploaded source files (blobs) of a deleted workspace (lane f6a).
 *
 * Runs BEFORE the ingestion rows are erased, because the rows are the only record of which blobs belong to
 * the workspace (a blob is just bytes under a content-hash name; there is no per-workspace listing in a blob
 * store). Contract: engines/workspaceErase/types.ts.
 *
 * How a blob is matched and why that is safe:
 *   - The target's blobs are the `storageRef`s of its own ingestion sources (not-purged ones; a purged source's
 *     blob is already gone). Nothing is found by scanning the blob store or by name.
 *   - A ref is deleted unless the optional `isRefHeldElsewhere` hook says another workspace still uses it. There is no
 *     cross-workspace lookup in the ingestion store: refs are content-addressed per workspace and one upload per source
 *     (`FsBlobStore`: `<sha256(scope)[:16]>/<sha256(bytes)>` where scope is the store's `blobScope` = the permanent
 *     workspace id for Postgres; Groundfloor Files: `gf1:<fileId>:<sha>`), so two workspaces never share a ref.
 *   - The one exception is LEGACY: a ref minted before `blobScope` hashes the workspace NAME, and a later workspace that
 *     reused the same NAME and uploaded the same bytes (and any SQLite store, which has no permanent id) gets the same
 *     FsBlobStore ref. Only a caller that knows of such a workspace can say so, through `isRefHeldElsewhere`
 *     (hostErasers.ts does for name reuse).
 *
 * A ref the blob store cannot parse as one of its own (`IBlobStore.isValidRef` false: garbage, `../x`, an absolute path)
 * names no blob that store holds, so there is nothing to delete for it: it is noted, never touched on disk, and it is NOT a
 * failure (a single bad `storage_ref` used to make has()/delete() throw -> `partial` -> the erase never reached the row steps).
 * A throw on a WELL-FORMED ref (permission denied, network error) is still a failure. A store without `isValidRef` cannot
 * tell the two apart, so there any throw stays a failure.
 *
 * Key: `workspaceKey` (default: the permanent id). The caller chooses what the store's `workspace` column holds
 * for this workspace. `wholeStore: true` lists every source in the store - only for a store dedicated to the
 * target (its own SQLite file), where the file's location, not a column, proves ownership.
 */

import type { EraseOptions, EraseStepResult, EraseTarget, WorkspaceEraser } from '../engines/workspaceErase/types.js';
import { FsBlobStore, type IBlobStore } from './blobStore.js';
import type { IIngestionStore } from './store.js';

const PAGE = 500;

export type IngestionBlobStoreLabel = 'blobs-fs' | 'blobs-groundfloor';

export interface IngestionBlobEraserOptions {
    ingestionStore: IIngestionStore;
    blobStore: IBlobStore;
    /** Store label; default: `blobs-fs` for an {@link FsBlobStore}, else `blobs-groundfloor`. */
    store?: IngestionBlobStoreLabel;
    /** What the ingestion store's `workspace` column holds for the target. Default: `target.id`. */
    workspaceKey?: (target: EraseTarget) => string;
    /** List every source in the store (dedicated per-workspace store only). Overrides `workspaceKey`. */
    wholeStore?: boolean;
    /** Extra "is this ref still used by someone else" check (e.g. a workspace that reused the name). True = keep the blob. */
    isRefHeldElsewhere?: (ref: string) => Promise<boolean>;
}

export function createIngestionBlobEraser(o: IngestionBlobEraserOptions): WorkspaceEraser {
    const label: IngestionBlobStoreLabel = o.store ?? (o.blobStore instanceof FsBlobStore ? 'blobs-fs' : 'blobs-groundfloor');

    async function* refs(key: string | null, signal?: AbortSignal): AsyncGenerator<string> {
        let after: string | undefined;
        for (;;) {
            if (signal?.aborted) return;
            const page = await o.ingestionStore.listSourceBlobRefs(key, PAGE, after);
            if (page.length === 0) return;
            for (const r of page) yield r.storageRef;
            after = page[page.length - 1]!.sourceId;
            if (page.length < PAGE) return;
        }
    }

    async function erase(target: EraseTarget, opts: EraseOptions = {}): Promise<EraseStepResult> {
        if (!target.id) throw new Error('ingestion blob erase: target.id (permanent workspace id) is required');
        const key = o.wholeStore ? null : (o.workspaceKey ? o.workspaceKey(target) : target.id);
        if (key === '') throw new Error('ingestion blob erase: empty workspace key');
        const removed: Record<string, number> = {};
        const remaining: Record<string, number> = {};
        const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };
        const kept = new Set<string>();
        let seen = 0;
        let failed = 0;
        let malformed = 0;
        let aborted = false;

        const canDelete = typeof o.blobStore.delete === 'function';
        const canCheck = typeof o.blobStore.has === 'function';

        // Pure syntax check, no I/O. A store that cannot classify (or whose check throws) never reports "malformed".
        const isMalformed = (ref: string): boolean => {
            try { return o.blobStore.isValidRef !== undefined && !o.blobStore.isValidRef(ref); } catch { return false; }
        };

        const heldElsewhere = async (ref: string): Promise<boolean> => {
            return o.isRefHeldElsewhere ? o.isRefHeldElsewhere(ref) : false;
        };

        for await (const ref of refs(key, opts.signal)) {
            seen++;
            if (opts.signal?.aborted) { aborted = true; break; }
            if (isMalformed(ref)) { malformed++; continue; }
            if (!canDelete) continue;
            try {
                if (await heldElsewhere(ref)) { kept.add(ref); continue; }
                // Check first so a re-run (or a store whose delete answers "ok" for a missing blob) never double-counts.
                if (canCheck && !(await o.blobStore.has!(ref))) continue;
                if (await o.blobStore.delete!(ref)) bump(removed, 'blobs');
            } catch {
                failed++;
            }
        }
        if (opts.signal?.aborted) aborted = true;

        // Verify with a fresh pass: a target blob that is not shared and still exists is "remaining".
        let verifiable = canCheck;
        if (canCheck) {
            for await (const ref of refs(key)) {
                if (kept.has(ref) || isMalformed(ref)) continue;
                try {
                    if (await o.blobStore.has!(ref)) bump(remaining, 'blobs');
                } catch {
                    verifiable = false;
                }
            }
        }
        remaining['blobs'] = remaining['blobs'] ?? 0;

        const notes: string[] = [];
        if (kept.size > 0) notes.push(`${kept.size} blob(s) are still referenced by another workspace and were kept`);
        if (malformed > 0) notes.push(`${malformed} source(s) had an unreadable storage reference; no blob could exist for them`);
        if (failed > 0) notes.push(`${failed} blob(s) could not be deleted (will be retried)`);
        if (aborted) notes.push('erase was aborted before it finished');
        if (!canDelete) notes.push('this blob store cannot delete blobs');
        if (!canCheck) notes.push('this blob store cannot confirm a blob is gone');

        let status: EraseStepResult['status'];
        if (seen === 0) status = 'not-applicable';
        else if (remaining['blobs']! > 0 || failed > 0 || aborted) status = 'partial';
        else if (!canDelete || !verifiable) status = 'unverifiable';
        else status = 'complete';
        const res: EraseStepResult = { store: label, status, removed, remaining };
        if (notes.length > 0) res.detail = notes.join('; ');
        return res;
    }

    return { store: label, erase };
}
