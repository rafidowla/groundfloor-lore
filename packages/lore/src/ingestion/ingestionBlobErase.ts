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
 *   - A ref is deleted only when no source of ANOTHER workspace in the same ingestion database still points at it
 *     (`countBlobRefsHeldByOtherWorkspaces`) and the optional `isRefHeldElsewhere` hook says no. Refs are
 *     content-addressed per workspace (`FsBlobStore`: `<sha256(workspace name)[:16]>/<sha256>`; Groundfloor Files:
 *     `gf1:<fileId>:<sha>`, one upload per source), so two workspaces normally never share one - this is the
 *     belt-and-braces check.
 *   - Known gap, reported not guessed at: a SQLite ingestion store is one file per workspace, so it cannot see a
 *     LATER workspace that reused the same NAME and uploaded the same bytes (same FsBlobStore ref). A caller that
 *     knows of such a workspace passes `isRefHeldElsewhere`.
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
        let aborted = false;

        const canDelete = typeof o.blobStore.delete === 'function';
        const canCheck = typeof o.blobStore.has === 'function';

        const heldElsewhere = async (ref: string): Promise<boolean> => {
            if (key !== null && (await o.ingestionStore.countBlobRefsHeldByOtherWorkspaces(key, ref)) > 0) return true;
            return o.isRefHeldElsewhere ? o.isRefHeldElsewhere(ref) : false;
        };

        for await (const ref of refs(key, opts.signal)) {
            seen++;
            if (opts.signal?.aborted) { aborted = true; break; }
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
                if (kept.has(ref)) continue;
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
