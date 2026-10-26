/**
 * workspaceErase/hostErasers.ts — the erasers lane f6a built (Postgres rows, uploaded source files), made ready to run
 * inside the lifecycle on a real host (lane f6c).
 *
 * `resolveErasers` (lifecycle.ts) adds the two erasers returned by {@link buildHostErasers} to every default run, so the
 * daemon's scheduled tick, an embedded `createLore()`, `DELETE ?erase=now`, `lore workspaces erase-now` and the maintain
 * expiry all reach them. Both decide per deleted workspace whether they apply (a host that runs no Postgres and has no
 * ingestion store reports `not-applicable`, like the outbox / keyring steps); neither opens anything until it runs.
 *
 * Postgres: the f6a eraser is opened over a PRIVATE pool (the shared pool belongs to the host). Rows are keyed by the
 * workspace's PERMANENT id, so a reused name cannot reach them and the eraser deletes them for real. See POSTGRES_ROWS_KEYED_BY.
 *
 * Uploaded source files ("blobs"): the filesystem / Files API blob ref is derived from the workspace NAME, so the step runs
 * (for those shared stores) only when NO live registry entry carries that name (same guard as the outbox / paths erasers) and
 * no live entry points at the deleted workspace's folder. Where the file refs are read from:
 *   - `<held folder>/ingestion.sqlite` (the whole file belongs to the deleted workspace), and/or
 *   - the Postgres ingestion tables, rows `workspace_id = <permanent id>`, only when the workspace's saved registry entry declared the
 *     postgres engine.
 * The blob store comes from the host's own `LORE_INGEST_BLOB_STORE` settings. If those are missing or invalid the step reports
 * `unverifiable` (never silently complete).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_GRAPH_ENGINE } from '../graphEngineSelector.js';
import { makeBlobStoreFactory } from '../../ingestion/blobStoreFactory.js';
import type { IBlobStore } from '../../ingestion/blobStore.js';
import { loadIngestHostConfig, type IngestHostConfig } from '../../ingestion/hostConfig.js';
import { createIngestionBlobEraser } from '../../ingestion/ingestionBlobErase.js';
import { SqliteIngestionStore } from '../../ingestion/sqliteStore.js';
import type { IIngestionStore } from '../../ingestion/store.js';
import { liveClaims, readLiveEntriesStrict } from './liveRegistry.js';
import { openIngestionStoreForErase, openWorkspaceEraser, type OpenedIngestionStore, type OpenedWorkspaceEraser } from './openWorkspaceEraser.js';
import type { EraseOptions, EraseStepResult, EraseTarget, WorkspaceEraser } from './types.js';

export interface HostEraserDeps {
    /** Lore home whose registry this host serves. */
    home: string;
    env?: Record<string, string | undefined>;
    /** Test seams. */
    openPostgres?: (engine: string, o?: { dedicatedPool?: boolean }) => Promise<OpenedWorkspaceEraser>;
    openPostgresIngestion?: (workspace: string) => Promise<OpenedIngestionStore>;
}

const envOf = (d: HostEraserDeps): Record<string, string | undefined> => d.env ?? process.env;
const hasPgUrl = (d: HostEraserDeps): boolean => (envOf(d)['LORE_PG_URL'] ?? '').trim() !== '';

const result = (store: string, status: EraseStepResult['status'], detail?: string, removed: Record<string, number> = {}, remaining: Record<string, number> = {}): EraseStepResult =>
    ({ store, status, removed, remaining, ...(detail ? { detail } : {}) });

/* ─── Postgres rows ─────────────────────────────────────────────── */

export function createHostPostgresEraser(deps: HostEraserDeps): WorkspaceEraser {
    return {
        store: 'postgres',
        async erase(target: EraseTarget, opts?: EraseOptions): Promise<EraseStepResult> {
            if (!hasPgUrl(deps)) {
                return target.engine === 'postgres'
                    ? result('postgres', 'unverifiable', 'This workspace used the Postgres engine, but this process has no Postgres connection configured (LORE_PG_URL), so its rows could not be checked. Nothing was deleted.')
                    : result('postgres', 'not-applicable', 'This host does not use Postgres.');
            }
            const opened = await (deps.openPostgres ?? openWorkspaceEraser)('postgres', { dedicatedPool: true });
            try { return await opened.erase(target, opts); }
            finally { await opened.close().catch(() => undefined); }
        },
    };
}

/* ─── uploaded source files ─────────────────────────────────────── */

/** Combine the per-source results of one blob step: the worst outcome wins, counts add up. */
export function mergeBlobResults(store: string, parts: readonly EraseStepResult[]): EraseStepResult {
    if (parts.length === 0) return result(store, 'not-applicable', 'No ingestion store exists for this workspace.');
    const has = (s: EraseStepResult['status']): boolean => parts.some((p) => p.status === s);
    const status: EraseStepResult['status'] = has('partial') ? 'partial' : has('unverifiable') ? 'unverifiable' : parts.every((p) => p.status === 'not-applicable') ? 'not-applicable' : 'complete';
    const add = (pick: (p: EraseStepResult) => Record<string, number>): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const p of parts) for (const [k, v] of Object.entries(pick(p))) out[k] = (out[k] ?? 0) + v;
        return out;
    };
    const detail = parts.map((p) => p.detail).filter((x): x is string => !!x).join('; ');
    return result(store, status, detail || undefined, add((p) => p.removed), add((p) => p.remaining));
}

const lstat = (p: string): fs.Stats | null => { try { return fs.lstatSync(p); } catch { return null; } };

/** Blob store for the folder, or a stand-in that cannot delete (with the reason) when the host's settings do not allow one. */
function blobStoreFor(cfg: IngestHostConfig['blobs'], dir: string | null): { store: IBlobStore; problem?: string } {
    const refuse = async (): Promise<never> => { throw new Error('blob storage is not configured'); };
    const stub: IBlobStore = { put: refuse, get: refuse };
    try {
        if (cfg.store === 'fs' && !dir) return { store: stub, problem: 'its uploaded-files folder no longer exists' };
        return { store: makeBlobStoreFactory(cfg)(dir ?? '') };
    } catch (e) {
        return { store: stub, problem: `this process's upload storage settings (LORE_INGEST_BLOB_STORE) are missing or invalid (${(e as Error).message.slice(0, 160)})` };
    }
}

export function createHostBlobEraser(deps: HostEraserDeps): WorkspaceEraser {
    let cfg: IngestHostConfig['blobs'];
    try { cfg = loadIngestHostConfig(envOf(deps) as NodeJS.ProcessEnv).blobs; }
    catch { cfg = loadIngestHostConfig({}).blobs; }
    const label = cfg.store === 'groundfloor' ? 'blobs-groundfloor' : 'blobs-fs';

    async function runOne(target: EraseTarget, dir: string | null, store: IIngestionStore, key: { wholeStore: true } | { workspaceKey: (t: EraseTarget) => string }, opts?: EraseOptions): Promise<EraseStepResult> {
        const { store: blobs, problem } = blobStoreFor(cfg, dir);
        const inner = createIngestionBlobEraser({ ingestionStore: store, blobStore: blobs, store: label, ...key });
        const r = await inner.erase(target, opts);
        if (problem && r.status !== 'not-applicable') return { ...r, status: 'unverifiable', detail: `Uploaded files could not be erased: ${problem}.` };
        return r;
    }

    return {
        store: label,
        async erase(target: EraseTarget, opts?: EraseOptions): Promise<EraseStepResult> {
            let live;
            try { live = readLiveEntriesStrict(deps.home); }
            catch (e) { return result(label, 'partial', `could not read the workspace registry, so no uploaded files were touched (${(e as Error).message})`); }
            // `holdingPath === null`: nothing was held (the folder never existed); `undefined`: legacy delete, data still at `path`.
            const dir = target.holdingPath === undefined ? (target.path || null) : target.holdingPath;
            const claims = liveClaims(live, { id: target.id, name: target.name, paths: dir ? [dir] : [] });
            if (claims.byPath) return result(label, 'not-applicable', 'a live workspace uses the same folder, so its uploaded files were left alone');
            // Name reuse. Blob refs are `<sha256(name) prefix>/<content sha256>`, so a live workspace with the same name
            // can share a ref. Files inside the id-derived holding folder (fs store) are still the old workspace's
            // alone and are erased; anything keyed by name in a SHARED place (the Files API) is left alone
            // and reported `unverifiable`, never `not-applicable`, so the receipt cannot read complete.
            const nameTaken = claims.byName !== null;
            const heldOwnFolder = typeof target.holdingPath === 'string';
            if (nameTaken && !heldOwnFolder) return result(label, 'unverifiable', 'a live workspace now uses this name, so uploaded files recorded under that name could not be told apart and were left alone');

            const parts: EraseStepResult[] = [];
            if (dir) {
                const dirStat = lstat(dir);
                // A link anywhere on the way to the upload folder could point a delete at someone else's files: touch nothing.
                if (dirStat && (dirStat.isSymbolicLink() || lstat(path.join(dir, 'ingestion-blobs'))?.isSymbolicLink())) {
                    return result(label, 'unverifiable', 'its folder or upload folder is a link, so uploaded files were not touched');
                }
                const file = path.join(dir, 'ingestion.sqlite');
                const fileStat = dirStat ? lstat(file) : null;
                if (fileStat && nameTaken && cfg.store !== 'fs') {
                    parts.push(result(label, 'unverifiable', 'a live workspace now uses this name and uploaded files live in shared storage keyed by that name, so none were deleted'));
                } else if (fileStat) {
                    if (!fileStat.isFile()) return result(label, 'unverifiable', 'its ingestion database is not a plain file, so uploaded files were not touched');
                    const store = new SqliteIngestionStore(file);
                    try { parts.push(await runOne(target, dir, store, { wholeStore: true }, opts)); }
                    finally { await store.close().catch(() => undefined); }
                }
            }
            if (target.engine === 'postgres' || (target.engine == null && hasPgUrl(deps) && parts.length === 0)) {
                // Postgres ingestion rows are keyed by the permanent id, so a live workspace that reuses the name cannot be
                // confused with this one here (the blob-ref name guard above still applies to shared blob storage).
                if (!hasPgUrl(deps)) {
                    parts.push(result(label, 'unverifiable', 'This workspace used the Postgres engine, but this process has no Postgres connection configured (LORE_PG_URL), so its uploaded files could not be looked up.'));
                } else if (target.engine == null) {
                    parts.push(result(label, 'unverifiable', 'This workspace was deleted before its storage engine was recorded, so its uploaded files could not be looked up in Postgres.'));
                } else {
                    const opened = await (deps.openPostgresIngestion ?? ((w: string) => openIngestionStoreForErase('postgres', w)))(target.id);
                    try { parts.push(await runOne(target, dir, opened.store, { workspaceKey: (t) => t.id }, opts)); }
                    finally { await opened.close().catch(() => undefined); }
                }
            }
            return parts.length === 0 ? result(label, 'not-applicable', 'This workspace has no ingestion store.') : mergeBlobResults(label, parts);
        },
    };
}

/** The two host-level erasers, in no particular order (the factory sorts by `store`). */
export function buildHostErasers(deps: HostEraserDeps): WorkspaceEraser[] {
    return [createHostBlobEraser(deps), createHostPostgresEraser(deps)];
}

/** What the saved registry entry says about the engine; unknown (legacy record without an entry) is null. */
export const engineOfEntry = (entry: { graphEngine?: string } | undefined): string | null => entry ? (entry.graphEngine ?? DEFAULT_GRAPH_ENGINE) : null;
