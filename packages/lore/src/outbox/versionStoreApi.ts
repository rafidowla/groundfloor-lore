/**
 * versionStoreApi.ts — the version-history surface the tools, routes and services consume
 * (cloud parity C item 8). The local `VersionStore` (better-sqlite3, synchronous) satisfies it
 * as-is; the cloud `DataplaneVersionStore` (HTTP, asynchronous) implements it with Promises, so
 * every method returns `T | Promise<T>` and every consumer `await`s. Pruning / compaction /
 * vacuum are NOT part of this surface: they stay on the local `VersionStore` (cloud retention is
 * a Dataplane concern, see docs/CLOUD_GAP_AUDIT.md).
 */
import type { Changeset, ChangesetWrite, VersionRecord } from './versionStore.js';
import type { VersionHistoryPolicy } from './versionPolicy.js';
import type { EffectiveVersionHistoryPolicy } from './versionPruningPolicy.js';

type M<T> = T | Promise<T>;

/** Who is writing, and the history policy in force, for a node write that records its own version atomically. */
export interface VersionIntent {
    principal: string;
    policy?: VersionHistoryPolicy;
    /** Filled by the store with the id of every version row the graph write recorded under this intent (cloud). */
    recorded?: string[];
}

export interface VersionStoreApi {
    setHistoryPolicy(policy: VersionHistoryPolicy | undefined): void;
    getHistoryPolicy(): VersionHistoryPolicy | undefined;
    setEffectiveHistoryPolicy(policy: EffectiveVersionHistoryPolicy): void;
    getEffectiveHistoryPolicy(): EffectiveVersionHistoryPolicy;

    recordVersion(r: Omit<VersionRecord, 'compacted'>): M<void>;
    getVersions(nodeId: string, workspace: string, limit?: number): M<VersionRecord[]>;
    getDiff(workspace: string, since: string): M<VersionRecord[]>;
    getVersionsByChangeset(changesetId: string): M<VersionRecord[]>;

    createChangeset(workspace: string): M<string>;
    getChangeset(id: string): M<Changeset | null>;
    updateChangeset(id: string, status: 'committed' | 'rolled_back'): M<void>;
    incrementWriteCount(changesetId: string): M<void>;
    addChangesetWrite(changesetId: string, operation: string, payload: unknown): M<number>;
    getChangesetWrites(changesetId: string): M<ChangesetWrite[]>;

    /**
     * Cloud only. Remove the version rows (ids from `VersionIntent.recorded`) of a node write that was
     * rolled back after its graph write, so rollback/restore cannot resurrect a node that never stood
     * (review C #2). Local records its version AFTER the whole write, so it has nothing to undo.
     */
    discardVersions?(versionIds: string[]): Promise<void>;

    /**
     * Present only on a store whose graph writes the version row in the SAME atomic transaction as
     * the node (cloud). Run the node write inside `fn` and the graph records the version itself;
     * the caller must then NOT call `recordVersion('upsert')` for that write.
     */
    runWithVersionIntent?<T>(intent: VersionIntent, fn: () => Promise<T>): Promise<T>;
}

/** Run a node write so a cloud store records its version in the same transaction; a plain store just runs `fn`. */
export function withVersionIntent<T>(vs: VersionStoreApi | undefined, intent: VersionIntent, fn: () => Promise<T>): Promise<T> {
    return vs?.runWithVersionIntent ? vs.runWithVersionIntent(intent, fn) : fn();
}
