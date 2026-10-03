/**
 * dataplaneVersionStore.ts — cloud version history + changesets over the `lore_version`
 * collection (cloud parity C item 8, D6 as amended by R3). The cloud counterpart of the local
 * versions.sqlite `VersionStore`, with the same public surface (`VersionStoreApi`).
 *
 * Scope: every read and write is scoped to (org, Lore workspace) with the D3 filter builder PLUS the
 * client-side `guardScope` re-check. The Lore workspace comes from the ALS binding only; the
 * `workspace` argument the local API takes is ignored (a mismatching one returns nothing and is
 * logged) so a caller can never name another workspace's history.
 *
 * Write paths:
 *   - NODE UPSERT (graph-driven, `upsertNode`): when a version intent is active (nodeService wraps
 *     its graph write in `runWithVersionIntent`) and the policy says to record, the node row and
 *     its version row go to `/v1/transaction` together; if the route is absent (R3) the node is
 *     written, then the version row separately, and a version-row failure is counted in health,
 *     never thrown. Without an intent the node is a plain scoped upsert (bulk ingest, sync,
 *     rollback replays … are not versioned — same as local, where only nodeService records).
 *   - `recordVersion` (rollback / restore / outcome): a separate, best-effort row write, failure
 *     counted. These versions describe a change that has ALREADY been made by another call, so
 *     there is nothing to make atomic with.
 *   - changesets: ordinary scoped rows (kind 'changeset' / 'changeset_write').
 * Prune / compaction are not implemented for cloud (`countPrunable` reports zeros).
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { log } from '../logger.js';
import type { LoreNode } from '../providers/types.js';
import { NODE_COLLECTION, VERSION_COLLECTION } from '../engines/dataplaneCollections.js';
import {
    buildDataplaneScopeFilter, scopeRowFields, type DataplaneScope, type ScopeFilterInput,
    scopeWorkspaceName,
} from '../engines/dataplaneScopeFilter.js';
import {
    keepInScope, pageRepeats, scopedCount, scopedGetRow, scopedUpsert, SCOPED_SCAN_CAP, type ScopedBulkClient, type ScopedUpsertClient,
} from '../engines/dataplaneScopedIo.js';
import { transactionRunnerFor } from '../engines/dataplaneTransaction.js';
import { canonicalOps } from '../engines/dataplaneVerbatimHistory.js';
import { shouldRecordVersion, type VersionHistoryPolicy } from './versionPolicy.js';
import { resolveEffectiveVersionHistoryPolicy, type EffectiveVersionHistoryPolicy } from './versionPruningPolicy.js';
import type { Changeset, ChangesetWrite, VersionRecord } from './versionStore.js';
import type { VersionIntent, VersionStoreApi } from './versionStoreApi.js';

export type VersionClient = ScopedUpsertClient & ScopedBulkClient;

/** What the owning graph lends the store, so a credential rebuild (adoptConnectionFrom) is followed. */
export interface VersionStoreHost {
    client(): VersionClient;
    scope(): DataplaneScope;
    ensureInitialized(scope: DataplaneScope): Promise<void>;
    connection?: string;
}

type Row = Record<string, unknown>;
const PAGE = 500;
const MAX_SEQ_RETRIES = 5;
const intentStore = new AsyncLocalStorage<VersionIntent>();

const json = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : JSON.stringify(v));
const parse = (v: unknown): unknown => (typeof v === 'string' && v !== '' ? JSON.parse(v) : null);
const compact = (o: Row): Row => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function rowToVersion(r: Row, workspace: string): VersionRecord {
    return {
        versionId: String(r['lore_id'] ?? ''),
        nodeId: String(r['node_id'] ?? ''),
        workspace,
        timestamp: String(r['timestamp'] ?? ''),
        principal: String(r['principal'] ?? 'mcp'),
        operation: String(r['operation'] ?? ''),
        previousState: parse(r['previous_state']),
        newState: parse(r['new_state']),
        changesetId: r['changeset_id'] != null ? String(r['changeset_id']) : null,
        compacted: r['compacted'] === true || Number(r['compacted'] ?? 0) === 1,
    };
}

function rowToChangeset(r: Row, workspace: string): Changeset {
    return {
        id: String(r['lore_id'] ?? ''),
        workspace,
        status: String(r['status'] ?? 'open') as Changeset['status'],
        createdAt: String(r['created_at'] ?? ''),
        committedAt: r['committed_at'] != null ? String(r['committed_at']) : null,
        writeCount: Number(r['write_count'] ?? 0),
    };
}

function versionFields(r: Omit<VersionRecord, 'compacted' | 'workspace' | 'versionId'>): Row {
    return compact({
        kind: 'node_version',
        node_id: r.nodeId,
        timestamp: r.timestamp,
        principal: r.principal,
        operation: r.operation,
        previous_state: json(r.previousState),
        new_state: json(r.newState),
        changeset_id: r.changesetId ?? undefined,
        compacted: false,
    });
}

export class DataplaneVersionStore implements VersionStoreApi {
    private historyPolicy: VersionHistoryPolicy | undefined;
    private effectivePolicy: EffectiveVersionHistoryPolicy | undefined;

    constructor(private readonly host: VersionStoreHost) {}

    setHistoryPolicy(policy: VersionHistoryPolicy | undefined): void { this.historyPolicy = policy; }
    getHistoryPolicy(): VersionHistoryPolicy | undefined { return this.historyPolicy; }
    setEffectiveHistoryPolicy(policy: EffectiveVersionHistoryPolicy): void { this.effectivePolicy = policy; }
    getEffectiveHistoryPolicy(): EffectiveVersionHistoryPolicy {
        return this.effectivePolicy ?? resolveEffectiveVersionHistoryPolicy(this.historyPolicy);
    }
    /** Cloud retention is not implemented here (Dataplane concern): nothing is ever prunable. */
    countPrunable(_olderThanDays: number): { eligibleForCompact: number; alreadyCompacted: number } {
        return { eligibleForCompact: 0, alreadyCompacted: 0 };
    }

    runWithVersionIntent<T>(intent: VersionIntent, fn: () => Promise<T>): Promise<T> {
        return intentStore.run(intent, fn);
    }

    private async ready(): Promise<DataplaneScope> {
        const scope = this.host.scope();
        await this.host.ensureInitialized(scope);
        return scope;
    }

    /* ─── graph-driven node write ───────────────────────────────── */

    /**
     * Write the node row, and — when a version intent is active and the policy says to record —
     * its version row, atomically when `/v1/transaction` exists (see the module header).
     */
    async upsertNode(a: { scope: DataplaneScope; loreId: string; doc: Row; node: LoreNode; previous: LoreNode | null; isNew: boolean }): Promise<void> {
        const client = this.host.client();
        const conn = this.host.connection;
        const intent = intentStore.getStore();
        const policy = intent?.policy ?? this.historyPolicy;
        const plain = (): Promise<unknown> => scopedUpsert(client, a.scope, NODE_COLLECTION, a.loreId, a.doc, conn);
        if (!intent || !shouldRecordVersion(typeof a.node.type === 'string' ? a.node.type : undefined, a.previous, a.node, policy)) {
            await plain();
            return;
        }
        const versionId = randomUUID();
        const fields = versionFields({
            nodeId: a.loreId, timestamp: new Date().toISOString(), principal: intent.principal, operation: 'upsert',
            previousState: a.previous, newState: a.node, changesetId: null,
        });
        const nodeOps = canonicalOps(a.scope, NODE_COLLECTION, a.loreId, a.doc);
        const versionCreate = canonicalOps(a.scope, VERSION_COLLECTION, versionId, fields).create;
        await transactionRunnerFor(client, conn).writeWithHistory({
            tenant: a.scope.dataplaneWorkspaceId,
            ops: [a.isNew ? nodeOps.create : nodeOps.update, versionCreate],
            ...(a.isNew ? { retryOps: [nodeOps.update, versionCreate] } : {}),
            key: `lore-${versionId}`,
            what: `version:${a.loreId}`,
            change: plain,
            history: async () => { await scopedUpsert(client, a.scope, VERSION_COLLECTION, versionId, fields, conn); },
        });
        intent.recorded?.push(versionId);
    }

    /**
     * Review C #2: remove the version rows of a node write the service then rolled back (its verbatim
     * step failed). Atomic with the node write is the whole point of item 8, so the version cannot be
     * deferred until after the verbatim step; it is compensated here instead. Scoped delete by row key
     * + kind, per id; a failure is thrown so the rollback reports "partial state may remain".
     */
    async discardVersions(versionIds: string[]): Promise<void> {
        if (versionIds.length === 0) return;
        const scope = await this.ready();
        for (const id of versionIds) {
            const filter = buildDataplaneScopeFilter(scope, { loreId: id, extra: [{ field: 'kind', op: 'eq', value: 'node_version' }] }, 'crud', 0).server as object;
            await this.host.client().deleteByQuery(scope.dataplaneWorkspaceId, VERSION_COLLECTION, filter, this.host.connection);
        }
    }

    /* ─── node_versions ─────────────────────────────────────────── */

    /** A version of a change another call already made (rollback / restore / outcome): separate, best-effort. */
    async recordVersion(r: Omit<VersionRecord, 'compacted'>): Promise<void> {
        const scope = await this.ready();
        const runner = transactionRunnerFor(this.host.client(), this.host.connection);
        try {
            await scopedUpsert(this.host.client(), scope, VERSION_COLLECTION, r.versionId, versionFields(r), this.host.connection);
        } catch (err) {
            runner.recordHistoryFailure(`version:${r.nodeId}`, err);
        }
    }

    /**
     * Scoped scan: server clauses `extra`, client re-check (scope + `keep`), stable paging. Default
     * order is lore_id asc; `opts.sort` changes it and `opts.stopAfter` ends the scan as soon as that
     * many rows pass `keep` (a newest-first read of a long history never walks all of it). Past
     * SCOPED_SCAN_CAP rows scanned it throws instead of returning a partial answer.
     */
    private async scan(
        scope: DataplaneScope, extra: NonNullable<ScopeFilterInput['extra']>, keep: (r: Row) => boolean, what: string,
        opts: { sort?: Array<{ field: string; direction: 'asc' | 'desc' }>; stopAfter?: number } = {},
    ): Promise<Row[]> {
        const built = buildDataplaneScopeFilter(scope, { extra }, 'crud', 0);
        const out: Row[] = [];
        let head: unknown;
        for (let offset = 0; ; offset += PAGE) {
            if (offset >= SCOPED_SCAN_CAP) throw new Error(`cloud version scan (${what}) exceeded ${SCOPED_SCAN_CAP} rows; narrow the query`);
            const res = await this.host.client().query<Row>(
                scope.dataplaneWorkspaceId, VERSION_COLLECTION,
                { filter: built.server, sort: opts.sort ?? [{ field: 'lore_id', direction: 'asc' }], limit: PAGE, offset },
                this.host.connection,
            );
            const records = res.records ?? [];
            if (offset === 0) head = records[0]?.['id'];
            else if (pageRepeats(head, records[0]?.['id'])) throw new Error(`cloud version scan (${what}): the connector ignored offset paging (e.g. SQLite); refusing a partial or duplicated answer`);
            out.push(...keepInScope(records, built.clientPredicate, what).filter(keep));
            if (opts.stopAfter !== undefined && out.length >= opts.stopAfter) return out.slice(0, opts.stopAfter);
            if (records.length < PAGE) return out;
        }
    }

    private sameWorkspace(scope: DataplaneScope, workspace: string, what: string): boolean {
        if (workspace === scopeWorkspaceName(scope)) return true;
        log.warn('cloud_version_workspace_mismatch', { what, requested: workspace, bound: scopeWorkspaceName(scope) });
        return false;
    }

    private async versionsWhere(
        scope: DataplaneScope, extra: NonNullable<ScopeFilterInput['extra']>, keep: (r: Row) => boolean, what: string,
        opts?: { sort?: Array<{ field: string; direction: 'asc' | 'desc' }>; stopAfter?: number },
    ): Promise<VersionRecord[]> {
        const rows = await this.scan(scope, [{ field: 'kind', op: 'eq', value: 'node_version' }, ...extra], (r) => r['kind'] === 'node_version' && keep(r), what, opts);
        return rows.map((r) => rowToVersion(r, scopeWorkspaceName(scope)));
    }

    private live = (r: Row): boolean => !(r['compacted'] === true || Number(r['compacted'] ?? 0) === 1);

    /**
     * Newest-first version log for a single node. Excludes compacted rows. Paged newest-first and cut
     * at `limit`, so a node with a long history costs one page, not a scan of the whole history.
     */
    async getVersions(nodeId: string, workspace: string, limit = 50): Promise<VersionRecord[]> {
        const scope = await this.ready();
        if (!this.sameWorkspace(scope, workspace, 'getVersions')) return [];
        const all = await this.versionsWhere(scope, [{ field: 'node_id', op: 'eq', value: nodeId }], (r) => r['node_id'] === nodeId && this.live(r), 'getVersions',
            { sort: [{ field: 'timestamp', direction: 'desc' }, { field: 'lore_id', direction: 'desc' }], stopAfter: limit });
        return all.sort((x, y) => y.timestamp.localeCompare(x.timestamp)).slice(0, limit);
    }

    /**
     * All non-compacted changes in the workspace at or after `since` (ISO 8601), newest first. Local
     * has no bound here; cloud throws past SCOPED_SCAN_CAP (50,000) rows rather than truncate: narrow
     * `since`. (A Dataplane cursor/streaming read would lift this; see DATAPLANE_INTEGRATION.md.)
     */
    async getDiff(workspace: string, since: string): Promise<VersionRecord[]> {
        const scope = await this.ready();
        if (!this.sameWorkspace(scope, workspace, 'getDiff')) return [];
        const all = await this.versionsWhere(scope, [{ field: 'timestamp', op: 'gte', value: since }], (r) => String(r['timestamp'] ?? '') >= since && this.live(r), 'getDiff');
        return all.sort((x, y) => y.timestamp.localeCompare(x.timestamp));
    }

    /** All versions created as part of a changeset (oldest first). */
    async getVersionsByChangeset(changesetId: string): Promise<VersionRecord[]> {
        const scope = await this.ready();
        const all = await this.versionsWhere(scope, [{ field: 'changeset_id', op: 'eq', value: changesetId }], (r) => r['changeset_id'] === changesetId, 'getVersionsByChangeset');
        return all.sort((x, y) => x.timestamp.localeCompare(y.timestamp));
    }

    /* ─── changesets ────────────────────────────────────────────── */

    async createChangeset(workspace: string): Promise<string> {
        const scope = await this.ready();
        if (!this.sameWorkspace(scope, workspace, 'createChangeset')) throw new Error('cloud createChangeset: workspace does not match the bound Lore workspace');
        const id = `cs-${randomUUID()}`;
        await scopedUpsert(this.host.client(), scope, VERSION_COLLECTION, id,
            { kind: 'changeset', status: 'open', created_at: new Date().toISOString(), write_count: 0 }, this.host.connection);
        return id;
    }

    private async changesetRow(scope: DataplaneScope, id: string): Promise<Row | null> {
        const row = await scopedGetRow(this.host.client(), scope, VERSION_COLLECTION, id, this.host.connection);
        return row && row['kind'] === 'changeset' ? row : null;
    }

    async getChangeset(id: string): Promise<Changeset | null> {
        const scope = await this.ready();
        const row = await this.changesetRow(scope, id);
        return row ? rowToChangeset(row, scopeWorkspaceName(scope)) : null;
    }

    private async patchChangeset(scope: DataplaneScope, id: string, fields: Row): Promise<void> {
        const { id: _k, ...ident } = scopeRowFields(scope, id);
        void _k;
        const filter = buildDataplaneScopeFilter(scope, { loreId: id, extra: [{ field: 'kind', op: 'eq', value: 'changeset' }] }, 'crud', 0).server as object;
        await this.host.client().updateByQuery(scope.dataplaneWorkspaceId, VERSION_COLLECTION, filter, { ...fields, ...ident }, this.host.connection);
    }

    async updateChangeset(id: string, status: 'committed' | 'rolled_back'): Promise<void> {
        const scope = await this.ready();
        await this.patchChangeset(scope, id, { status, committed_at: new Date().toISOString() });
    }

    /**
     * Brings `write_count` in line with the changeset's buffered write rows. NOT a read-modify-write:
     * that lost concurrent increments (review C #11). It recounts, exactly like addChangesetWrite, so
     * concurrent callers converge on the true number; it no longer adds one without a write row.
     */
    async incrementWriteCount(changesetId: string): Promise<void> {
        const scope = await this.ready();
        if (!(await this.changesetRow(scope, changesetId))) return;
        await this.patchChangeset(scope, changesetId, { write_count: await this.countWrites(scope, changesetId) });
    }

    private countWrites(scope: DataplaneScope, changesetId: string): Promise<number> {
        return scopedCount(this.host.client(), scope, VERSION_COLLECTION,
            { extra: [{ field: 'kind', op: 'eq', value: 'changeset_write' }, { field: 'changeset_id', op: 'eq', value: changesetId }] }, this.host.connection);
    }

    private writesOf(scope: DataplaneScope, changesetId: string): Promise<Row[]> {
        return this.scan(scope, [{ field: 'kind', op: 'eq', value: 'changeset_write' }, { field: 'changeset_id', op: 'eq', value: changesetId }],
            (r) => r['kind'] === 'changeset_write' && r['changeset_id'] === changesetId, 'changesetWrites');
    }

    /**
     * Append a buffered write and return its seq. seq = max(seq)+1 over the changeset's writes; the
     * row's `lore_id` is `<csId>#w<seq>`, so two concurrent appenders that pick the same seq collide
     * on the unique row key and the loser retries with a fresh seq (the local SW-06 guarantee).
     */
    async addChangesetWrite(changesetId: string, operation: string, payload: unknown): Promise<number> {
        const scope = await this.ready();
        const client = this.host.client();
        for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
            const seqs = (await this.writesOf(scope, changesetId)).map((r) => Number(r['seq'] ?? -1));
            const seq = (seqs.length > 0 ? Math.max(...seqs) : -1) + 1;
            const loreId = `${changesetId}#w${seq}`;
            const fields = compact({ kind: 'changeset_write', changeset_id: changesetId, seq, operation, payload: json(payload) ?? 'null' });
            try {
                await client.insert(scope.dataplaneWorkspaceId, VERSION_COLLECTION, { ...fields, ...scopeRowFields(scope, loreId) }, this.host.connection);
            } catch (err) {
                if (await scopedGetRow(client, scope, VERSION_COLLECTION, loreId, this.host.connection).catch(() => null)) continue; // lost the seq race
                throw err;
            }
            await this.patchChangeset(scope, changesetId, { write_count: await this.countWrites(scope, changesetId) });
            return seq;
        }
        throw new Error(`cloud addChangesetWrite: could not allocate a sequence number for ${changesetId}`);
    }

    async getChangesetWrites(changesetId: string): Promise<ChangesetWrite[]> {
        const scope = await this.ready();
        return (await this.writesOf(scope, changesetId))
            .map((r) => ({
                id: String(r['lore_id'] ?? ''),
                changesetId: String(r['changeset_id'] ?? ''),
                seq: Number(r['seq'] ?? 0),
                operation: String(r['operation'] ?? ''),
                payload: parse(r['payload']),
            }))
            .sort((x, y) => x.seq - y.seq);
    }
}
