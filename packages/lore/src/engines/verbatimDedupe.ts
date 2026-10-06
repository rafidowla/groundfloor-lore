/**
 * verbatimDedupe.ts — check / clean duplicate canonical ids in a workspace's
 * LanceDB `lore_verbatim` table (`lore verbatim dedupe <workspace>`, 3.28).
 *
 * A Lance table has no unique constraint, so a canonical id can be stored
 * more than once (a retried bulk write, an interrupted promotion). SQLite
 * enforces unique ids, so `lore migrate-vectors` refuses such a workspace
 * (or, with `--dedupe-identical`, drops the extras only in the SQLite copy).
 * This module repairs the Lance table itself so the workspace migrates
 * without the flag and recall stops seeing the same record twice.
 *
 * Rules (shared with migrate-vectors via migrateVectorsDedupe.ts — NOT
 * reimplemented here):
 *   - Only non-history ids are considered. `<id>#rev<ISO>` history rows are
 *     never duplicates and are never touched (`classifyLanceId`). `#q<n>`
 *     alias rows are canonical rows of their own and ARE deduped like any
 *     other non-history id (migrate-vectors would refuse on them too).
 *   - Identity of a copy = `rowIdentityKey`: contentHash (or text digest),
 *     the full text, security_scopes (sorted), type, label, tags, project and
 *     ecosystem — NOT updatedAt/createdAt/vector. A group is IDENTICAL when
 *     every copy has the same key, DIFFERING otherwise (same hash with
 *     different scopes, or a live row beside its tombstoned twin, is
 *     DIFFERING: reported, never touched).
 *   - Kept copy = newest `updatedAt`; ties go to the first copy in scan order
 *     (`CanonicalTracker`).
 *
 * Modes:
 *   - report-only (default): opens the table read-only-in-practice (scan of
 *     id/updatedAt + the identity columns), lists the groups, writes NOTHING.
 *   - apply: offline only (daemon preflight), backup first, then per
 *     IDENTICAL group delete every row with that id and add back exactly the
 *     kept row with all its columns, vector included. Immediately before each
 *     chunk's delete the chunk's ids are re-read from a FRESH table handle and
 *     the apply aborts if any id's rows changed since pass 2 (a concurrent
 *     writer: this command cannot see apps that embed Lore in-process, so the
 *     operator must close Atlas / MIRA / PM Helper first; no cross-process
 *     lock exists). Differing groups are
 *     reported and never touched. A final re-scan asserts that no identical
 *     group is left, nothing but the extra rows disappeared, and every
 *     history row, distinct id and differing group is unchanged.
 *
 * Why delete + add and not `mergeInsert('id')`: mergeInsert reconciles
 * source against target; with a target that already holds N copies of an id
 * it updates ALL N in place and leaves N copies, so it can never collapse
 * them. Lance's JS API has no multi-operation transaction, so the removal
 * and the re-add are two commits. The window is narrowed (the kept rows are
 * fully read into memory BEFORE the delete; both calls run back to back per
 * chunk; the add is retried), and covered by the mandatory pre-write backup,
 * whose path is in the error should the add ever fail after the delete.
 *
 * Opens the Lance table directly — never through VerbatimStore (that would
 * run its write gate / index repair and embed). The table's keyword (FTS)
 * index is derived data; rows added here are picked up when VerbatimStore
 * next opens the workspace and heals the index.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { loadWorkspacesIfPresent } from '../config/workspaces.js';
import { loreHome } from '../config/loreHome.js';
import { isDaemonServingHome, daemonRefuseMessage } from '../cli/commands/migrateWorkspaceToWorkspaceShared.js';
import { backupWorkspace, type BackupResult } from './backup.js';
import { classifyLanceId, type RowKind } from './migrateVectorsRows.js';
import { CanonicalTracker, IDENTITY_COLUMNS, rowIdentityKey } from './migrateVectorsDedupe.js';

const VERBATIM_TABLE = 'lore_verbatim';
const DEFAULT_CHUNK = 200;
const ADD_ATTEMPTS = 3;

export interface DedupeGroupReport {
    id: string;
    kind: Exclude<RowKind, 'history'>;
    /** Rows in the Lance table carrying this id (>= 2). */
    copies: number;
    identical: boolean;
    /** updatedAt of the copy that is (identical group) / would be kept; null for a differing group, which is never touched. */
    keptUpdatedAt: string | null;
}

export interface DedupeScan {
    /** Every physical row in the table. */
    totalRows: number;
    /** `#rev` history rows (never touched). */
    historyRows: number;
    /** Distinct non-history ids (canonical + `#q` alias). */
    distinctIds: number;
    groups: DedupeGroupReport[];
    identicalGroups: number;
    differingGroups: number;
    /** Rows an apply would delete: copies - 1 summed over IDENTICAL groups. */
    extraRows: number;
    /** copies - 1 summed over DIFFERING groups (reported, never removed). */
    differingExtraRows: number;
}

export type DedupeStatus = 'not-applicable-sqlite' | 'nothing-to-check' | 'checked' | 'applied';

export interface DedupeReport {
    status: DedupeStatus;
    workspaceName: string;
    home: string;
    registryPath: string;
    workspaceDir: string;
    apply: boolean;
    /** Scan before any write (absent for the two "nothing to do" statuses). */
    scan?: DedupeScan;
    /** apply only. */
    backup?: BackupResult;
    /** apply only: identical groups collapsed to one row / rows removed. */
    groupsFixed?: number;
    rowsRemoved?: number;
    /** apply only: scan after the write (assertions already passed). */
    rescan?: DedupeScan;
    /** Human one-liner for the two "nothing to do" statuses. */
    message?: string;
    durationMs: number;
}

export interface DedupeVerbatimOptions {
    workspaceName: string;
    /** Lore home holding workspaces.json. Default: the process's LORE_HOME. */
    home?: string;
    /** Write the fix. Default false = report-only (writes nothing). */
    apply?: boolean;
    /** Required with `apply`: directory the pre-write backup tarball is written into (must exist). */
    backupOutDir?: string;
    /** Bypass the daemon preflight (tests only). */
    skipDaemonCheck?: boolean;
    /** Port the daemon preflight probes (tests; default LORE_PORT / 3847). */
    daemonProbePort?: number;
    /** Identical groups handled per delete+add (default 200). */
    chunkSize?: number;
    /** TEST-ONLY: throw between the delete and the add of the first chunk. */
    simulateFailure?: 'after-delete';
    /** TEST-ONLY: runs after pass 2 read a chunk and before the pre-delete re-check (simulates a concurrent writer). */
    beforeRecheck?: (chunkIndex: number) => void | Promise<void>;
}

export class VerbatimDedupeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VerbatimDedupeError';
    }
}

/**
 * Read-only, id-only duplicate probe for `lore doctor`. Opens the Lance table directly (no
 * VerbatimStore, so no index rebuild, no writes) and counts canonical ids (not `#rev` history)
 * that appear more than once. Returns null when the workspace has no Lance table.
 */
export async function countDuplicateCanonicalIds(workspaceDir: string): Promise<{ groups: number; extraRows: number } | null> {
    if (!lanceTableExists(workspaceDir)) return null;
    const conn = await lancedb.connect(path.join(workspaceDir, '.lore', 'lancedb'));
    let table: lancedb.Table | null = null;
    try {
        table = await conn.openTable(VERBATIM_TABLE);
        const seen = new Map<string, number>();
        for await (const r of lanceRows(table, ['id'])) {
            const id = String(r.id);
            if (classifyLanceId(id) === 'history') continue;
            seen.set(id, (seen.get(id) ?? 0) + 1);
        }
        let groups = 0;
        let extraRows = 0;
        for (const n of seen.values()) if (n > 1) { groups++; extraRows += n - 1; }
        return { groups, extraRows };
    } finally {
        try { table?.close(); } catch { /* ignore */ }
        try { conn.close(); } catch { /* ignore */ }
    }
}

/**
 * `lore doctor`'s read-only sweep: every REGISTERED workspace whose live vector store is LanceDB
 * (a Lance table and no verbatim.sqlite beside it) and that holds duplicate canonical ids. Writes
 * nothing; a workspace that fails to scan is skipped (doctor must never fail over this).
 */
export async function findWorkspacesWithDuplicateIds(home: string): Promise<Array<{ name: string; groups: number; extraRows: number }>> {
    const reg = loadWorkspacesIfPresent(home);
    if (!reg) return [];
    const out: Array<{ name: string; groups: number; extraRows: number }> = [];
    for (const w of reg.workspaces) {
        if (fs.existsSync(path.join(w.path, '.lore', 'verbatim.sqlite'))) continue;
        try {
            const d = await countDuplicateCanonicalIds(w.path);
            if (d && d.groups > 0) out.push({ name: w.name, ...d });
        } catch { /* skip */ }
    }
    return out;
}

async function* lanceRows(table: lancedb.Table, columns?: string[]): AsyncGenerator<Record<string, unknown>> {
    const q = columns ? table.query().select(columns) : table.query();
    for await (const batch of q) {
        for (const r of batch.toArray()) yield r as Record<string, unknown>;
    }
}

/** Arrow vectors / typed arrays -> plain JS values `table.add` accepts; everything else passes through. */
function plainValue(v: unknown): unknown {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || v instanceof Date) return v;
    if (Array.isArray(v) || ArrayBuffer.isView(v) || (typeof v === 'object' && Symbol.iterator in (v as object))) {
        return Array.from(v as Iterable<unknown>, plainValue);
    }
    return v;
}

const sqlQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function lanceTableExists(workspaceDir: string): boolean {
    return fs.existsSync(path.join(workspaceDir, '.lore', 'lancedb', `${VERBATIM_TABLE}.lance`));
}

/**
 * Scan an open table: classify every row, group non-history ids. Only the
 * columns identity needs are read (`IDENTITY_COLUMNS` + updatedAt; any absent
 * from an old table counts as '').
 */
async function scanTable(table: lancedb.Table): Promise<{ scan: DedupeScan; tracker: CanonicalTracker; kinds: Map<string, RowKind> }> {
    const wanted = [...IDENTITY_COLUMNS, 'updatedAt'];
    let columns: string[] | undefined;
    try {
        const have = new Set((await table.schema()).fields.map((f) => f.name));
        columns = wanted.filter((c) => have.has(c));
    } catch { columns = undefined; }
    const tracker = new CanonicalTracker();
    let totalRows = 0;
    let historyRows = 0;
    const kinds = new Map<string, RowKind>();
    for await (const r of lanceRows(table, columns)) {
        totalRows++;
        const id = String(r.id);
        const kind = classifyLanceId(id);
        if (kind === 'history') { historyRows++; continue; }
        const ua = r.updatedAt === null || r.updatedAt === undefined ? null : String(r.updatedAt);
        tracker.add(id, kind, rowIdentityKey(r), ua, false, false);
        kinds.set(id, kind);
    }
    const plan = tracker.plan();
    const groups: DedupeGroupReport[] = tracker.duplicates().map((d) => ({
        id: d.id,
        kind: kinds.get(d.id) as Exclude<RowKind, 'history'>,
        copies: d.copies,
        identical: d.identical,
        keptUpdatedAt: d.identical ? plan.get(d.id)!.keptUpdatedAt : null,
    })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const identical = groups.filter((g) => g.identical);
    const differing = groups.filter((g) => !g.identical);
    return {
        tracker, kinds,
        scan: {
            totalRows, historyRows, distinctIds: tracker.size(), groups,
            identicalGroups: identical.length, differingGroups: differing.length,
            extraRows: identical.reduce((n, g) => n + g.copies - 1, 0),
            differingExtraRows: differing.reduce((n, g) => n + g.copies - 1, 0),
        },
    };
}

/** Per-id fingerprint of a chunk's rows: every copy's [identity key, updatedAt], sorted. */
type ChunkSignature = Map<string, string[]>;
const copySig = (r: Record<string, unknown>): string =>
    `${rowIdentityKey(r)}|${r.updatedAt === null || r.updatedAt === undefined ? '' : String(r.updatedAt)}`;

/**
 * Re-read `ids` through a FRESH connection + table handle (so a write made by
 * another process since pass 2 is visible) and return their signature. Handles
 * are closed synchronously, so nothing but this read's own awaits sits between
 * the caller's compare and its delete.
 */
async function readChunkSignature(lancedbPath: string, ids: Set<string>): Promise<ChunkSignature> {
    const conn = await lancedb.connect(lancedbPath);
    let table: lancedb.Table | null = null;
    try {
        table = await conn.openTable(VERBATIM_TABLE);
        const have = new Set((await table.schema()).fields.map((f) => f.name));
        const columns = [...IDENTITY_COLUMNS, 'updatedAt'].filter((c) => have.has(c));
        const out: ChunkSignature = new Map();
        for await (const batch of table.query().where(`id IN (${[...ids].map(sqlQuote).join(', ')})`).select(columns)) {
            for (const r of batch.toArray() as Array<Record<string, unknown>>) {
                const id = String(r.id);
                if (!ids.has(id)) continue;
                const list = out.get(id) ?? [];
                list.push(copySig(r));
                out.set(id, list);
            }
        }
        for (const list of out.values()) list.sort();
        return out;
    } finally {
        try { table?.close(); } catch { /* best effort */ }
        try { conn.close(); } catch { /* best effort */ }
    }
}

/** Compact fingerprint of the groups the apply must NOT change (differing ones). */
const differingSignature = (s: DedupeScan): string =>
    JSON.stringify(s.groups.filter((g) => !g.identical).map((g) => [g.id, g.copies]));

/**
 * Check (default) or fix (`apply`) duplicate non-history ids in a workspace's
 * LanceDB verbatim table. Throws VerbatimDedupeError for refusals (no
 * registry, unknown workspace, daemon serving the home, failed assertions).
 * Never throws for "SQLite workspace" / "no Lance table" — those are
 * statuses.
 */
export async function dedupeVerbatimIdentical(opts: DedupeVerbatimOptions): Promise<DedupeReport> {
    const startedAt = Date.now();
    const home = opts.home ?? loreHome();
    const ws = opts.workspaceName;
    const apply = !!opts.apply;
    // Read-only registry lookup: never bootstraps a workspaces.json.
    const registry = loadWorkspacesIfPresent(home);
    const registryPath = path.join(home, 'workspaces.json');
    if (!registry) {
        throw new VerbatimDedupeError(`verbatim dedupe: no workspace registry (workspaces.json) found under ${home} — nothing to check. `
            + 'Check --data-dir / LORE_HOME points at the Lore home that holds the workspace.');
    }
    const entry = registry.workspaces.find((w) => w.name === ws);
    if (!entry) {
        throw new VerbatimDedupeError(`workspace_not_found: "${ws}" (known: ${registry.workspaces.map((w) => w.name).join(', ')})`);
    }
    const workspaceDir = entry.path;
    const base = { workspaceName: ws, home, registryPath, workspaceDir, apply };
    const done = (r: Omit<DedupeReport, 'workspaceName' | 'home' | 'registryPath' | 'workspaceDir' | 'apply' | 'durationMs'>): DedupeReport =>
        ({ ...base, ...r, durationMs: Date.now() - startedAt });

    if (entry.vectorEngine === 'sqlite') {
        return done({ status: 'not-applicable-sqlite', message: `not applicable: SQLite enforces unique ids ('${ws}' is registered with vectorEngine 'sqlite')` });
    }
    if (!lanceTableExists(workspaceDir)) {
        return done({ status: 'nothing-to-check', message: `nothing to check: '${ws}' has no LanceDB ${VERBATIM_TABLE} table` });
    }

    if (apply && !opts.skipDaemonCheck) {
        const probe = await isDaemonServingHome(home, 800, opts.daemonProbePort);
        if (probe.servesHome) throw new VerbatimDedupeError(daemonRefuseMessage('lore verbatim dedupe --apply'));
    }
    if (apply && !opts.backupOutDir) {
        throw new VerbatimDedupeError('verbatim dedupe: --apply needs a backup directory (backupOutDir); refusing to write without a backup.');
    }

    const lancedbPath = path.join(workspaceDir, '.lore', 'lancedb');
    const conn = await lancedb.connect(lancedbPath);
    let table: lancedb.Table | null = null;
    try {
        table = await conn.openTable(VERBATIM_TABLE);
        const first = await scanTable(table);
        if (!apply || first.scan.identicalGroups === 0) {
            return done({ status: 'checked', scan: first.scan });
        }

        // ── Backup FIRST ────────────────────────────────────────────────
        fs.mkdirSync(opts.backupOutDir!, { recursive: true }); // created only when there is real work to back up
        const backup = await backupWorkspace({ workspaceDir, workspaceName: ws, outDir: opts.backupOutDir! });

        const plan = first.tracker.plan();
        const identicalIds = first.scan.groups.filter((g) => g.identical).map((g) => g.id);
        const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK);
        let rowsRemoved = 0;
        try {
            for (let c = 0; c < identicalIds.length; c += chunkSize) {
                const ids = new Set(identicalIds.slice(c, c + chunkSize));
                // Pass 2: read the FULL kept row (every column + vector) of each id
                // in this chunk, by scan ordinal, and re-check it is the copy pass 1 chose.
                const kept = new Map<string, Record<string, unknown>>();
                const ordinal = new Map<string, number>();
                const seen: ChunkSignature = new Map(); // every copy of every id in this chunk, as pass 2 saw it
                for await (const raw of lanceRows(table)) {
                    const id = String(raw.id);
                    if (!ids.has(id) || classifyLanceId(id) === 'history') continue;
                    const ord = ordinal.get(id) ?? 0;
                    ordinal.set(id, ord + 1);
                    const sigList = seen.get(id) ?? [];
                    sigList.push(copySig(raw));
                    seen.set(id, sigList);
                    const p = plan.get(id)!;
                    if (ord !== p.keptOrdinal) continue;
                    const ua = raw.updatedAt === null || raw.updatedAt === undefined ? '' : String(raw.updatedAt);
                    if (rowIdentityKey(raw) !== p.key || ua !== p.keptUpdatedAt) {
                        throw new VerbatimDedupeError(`the kept copy of '${id}' changed between scans (the Lance table was modified during the run) — nothing written for this chunk`);
                    }
                    const row: Record<string, unknown> = {};
                    for (const k of Object.keys(raw)) row[k] = plainValue(raw[k]);
                    kept.set(id, row);
                }
                for (const id of ids) {
                    if (!kept.has(id)) throw new VerbatimDedupeError(`could not read the kept copy of '${id}' — nothing written for this chunk`);
                    if ((ordinal.get(id) ?? 0) !== plan.get(id)!.copies) {
                        throw new VerbatimDedupeError(`'${id}' now has ${ordinal.get(id) ?? 0} copies, expected ${plan.get(id)!.copies} (the Lance table was modified during the run) — nothing written for this chunk`);
                    }
                }
                const rows = [...kept.values()];
                // Concurrent-writer guard (no cross-process lock exists; embedded hosts are invisible to the
                // daemon preflight). Re-read this chunk's ids from a fresh handle; the delete follows with
                // no await in between except this read itself.
                await opts.beforeRecheck?.(c / chunkSize);
                for (const list of seen.values()) list.sort();
                const now = await readChunkSignature(lancedbPath, ids);
                for (const id of ids) {
                    if (JSON.stringify(now.get(id) ?? []) !== JSON.stringify(seen.get(id) ?? [])) {
                        throw new VerbatimDedupeError(`ABORTED: the rows of '${id}' changed since they were read (another process wrote to this Lance table during the apply — an app that embeds Lore on this data dir, such as Atlas, MIRA or PM Helper, must be closed first). `
                            + `Nothing was deleted for this chunk; ${rowsRemoved} extra row(s) in ${c / chunkSize} earlier chunk(s) were already removed and stay removed. Re-run 'lore verbatim dedupe' to see the current state`);
                    }
                }
                // Remove every copy of these ids (exact match: `#rev` history rows have different ids), then
                // re-add exactly the kept rows. Two commits — see the header for why not mergeInsert.
                await table.delete(`id IN (${[...ids].map(sqlQuote).join(', ')})`);
                try {
                    if (opts.simulateFailure === 'after-delete' && c === 0) throw new Error('simulated failure after delete (test)');
                    let lastErr: unknown;
                    for (let attempt = 1; attempt <= ADD_ATTEMPTS; attempt++) {
                        try { await table.add(rows as Array<{ [k: string]: unknown }>); lastErr = null; break; } catch (e) { lastErr = e; }
                    }
                    if (lastErr) throw lastErr;
                } catch (e) {
                    throw new VerbatimDedupeError(`re-adding ${rows.length} kept row(s) FAILED after their copies were deleted (${(e as Error).message}). `
                        + `Ids affected: ${[...ids].slice(0, 10).join(', ')}${ids.size > 10 ? ', …' : ''}. Restore from the backup at ${backup.tarballPath}.`);
                }
                rowsRemoved += [...ids].reduce((n, id) => n + plan.get(id)!.copies - 1, 0);
            }

            // ── Re-scan and assert ──────────────────────────────────────
            const after = (await scanTable(table)).scan;
            const before = first.scan;
            const problems: string[] = [];
            if (after.identicalGroups !== 0) problems.push(`${after.identicalGroups} identical duplicate group(s) remain`);
            if (after.distinctIds !== before.distinctIds) problems.push(`distinct id count changed ${before.distinctIds} -> ${after.distinctIds}`);
            if (after.historyRows !== before.historyRows) problems.push(`history rows changed ${before.historyRows} -> ${after.historyRows}`);
            if (after.totalRows !== before.totalRows - before.extraRows) problems.push(`total rows ${after.totalRows}, expected ${before.totalRows - before.extraRows}`);
            if (differingSignature(after) !== differingSignature(before)) problems.push('differing groups changed');
            if (problems.length > 0) {
                throw new VerbatimDedupeError(`post-write verification FAILED: ${problems.join('; ')}. Restore from the backup at ${backup.tarballPath} if unexpected.`);
            }
            return done({ status: 'applied', scan: before, backup, groupsFixed: before.identicalGroups, rowsRemoved, rescan: after });
        } catch (e) {
            if (e instanceof VerbatimDedupeError && /backup at /.test(e.message)) throw e;
            const err = e instanceof Error ? e : new Error(String(e));
            throw new VerbatimDedupeError(`${err.message} — backup at ${backup.tarballPath}`);
        }
    } finally {
        try { table?.close(); } catch { /* best effort */ }
        try { conn.close(); } catch { /* best effort */ }
    }
}
