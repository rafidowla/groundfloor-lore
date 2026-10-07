/**
 * verbatimRepairScopes.ts — restore the original `security_scopes` of verbatim
 * rows damaged by the pre-3.28.0 Lance writer, ONLY where the original is
 * provable (`lore verbatim repair-scopes <workspace>`, post-3.28.0).
 *
 * The damage (see verbatimCheckScopes.ts): `#rev` history rows and tombstone
 * rows were stored with `security_scopes = ['undefined', ...]`, one entry per
 * original scope. The rows are invisible to every principal (fail-closed).
 *
 * Where the truth lives. A node write records a version in
 * `<loreDir>/versions.sqlite` (`node_versions.new_state` = JSON of the full node,
 * with top-level `security_scopes` and `updatedAt`), and the node's verbatim
 * row is written with `metadata.updatedAt = node.updatedAt`. A `#rev` snapshot
 * copies the replaced row's `updatedAt` verbatim (snapshotForRev, the
 * storeBatch preflight snapshot, tombstone()). So the history row of node N
 * with `updatedAt = U` is exactly the row some version of N wrote with
 * `new_state.updatedAt = U`, and that version's `new_state.security_scopes`
 * are the scopes the row should have.
 *
 * A canonical TOMBSTONE row is provable by a second route: tombstone() writes
 * the `#rev<ts>` snapshot and the tombstone in one call, both from the same
 * `r.security_scopes`, with `ts` = the tombstone's `updatedAt` and the original
 * text re-appended after the `[TOMBSTONED <ts> reason: ...]\n\n` header. So
 * the tombstone takes the scopes of its same-instant `#rev<ts>` sibling, once
 * the sibling's text proves it is the same row.
 *
 * What is restored (a row gets a `restorable` verdict ONLY when ALL hold):
 *   - the row is entirely 'undefined' (class all_undefined); mixed_undefined,
 *     unreadable and ok rows are never touched;
 *   - history / tombstone kind with a node id (`lore:<node>`), never a live
 *     canonical row (the writer did not damage those);
 *   - exactly one row has that id (Lance) — a duplicated id could not be updated
 *     without touching the other copy;
 *   - the version log has at least one record of that node in that workspace
 *     whose `updatedAt` equals the row's, whose `type` / `label` agree with the
 *     row, and every such record carries the SAME scopes (else ambiguous);
 *   - those scopes are a non-empty list of real strings (no 'undefined', no
 *     empty entry) and their COUNT equals the number of damaged entries.
 * Everything else keeps its damaged scopes (fail-closed). A canonical row's
 * CURRENT scopes are never copied onto an old row.
 *
 * Output: counts, verdict names and row ids only. No scope value, no row text,
 * is ever printed or returned.
 *
 * Writes only the `security_scopes` column (Lance `table.update`, SQLite
 * `UPDATE ... SET security_scopes`). A final re-scan checks that the row count,
 * every untouched row's scopes, and every row's id, text, updatedAt,
 * contentHash, type and label (SQLite: also rowid, flags and timestamps) are
 * unchanged, via an order-independent digest. Vector, tags, project, ecosystem
 * and metadata columns are not part of that digest; the write never names them.
 *
 * Modes: dry run (default) reads only and creates no file (versions.sqlite and
 * verbatim.sqlite are opened read-only without sidecars). `--apply` is offline
 * like `dedupe --apply`: daemon preflight, backup first, a re-read of each
 * chunk immediately before it is written, then the verification re-scan.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';
import { loadWorkspacesIfPresent } from '../config/workspaces.js';
import { loreHome } from '../config/loreHome.js';
import { isDaemonServingHome, daemonRefuseMessage } from '../cli/commands/migrateWorkspaceToWorkspaceShared.js';
import { backupWorkspace, type BackupResult } from './backup.js';
import { assertSafeLanceId, escapeSqlLiteral } from './verbatimHistory.js';
import { classifyLanceId } from './migrateVectorsRows.js';
import {
    SAMPLE_CAP, TOMBSTONE_PREFIX, VERBATIM_TABLE, lanceTableExists, openReadOnlySqlite, plainValue, readOnlySqliteRows, sqliteHasTable,
    classifyScopes, type ScopeRowKind,
} from './verbatimCheckScopes.js';

const DEFAULT_CHUNK = 200;
const SQLITE_CHUNK = 500;
const REV_RE = /#rev(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
const ALIAS_RE = /#q\d+$/;
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MASK = (1n << 64n) - 1n;

export type RepairVerdict =
    | 'restorable'
    | 'no_version_log'
    | 'no_match'
    | 'ambiguous_match'
    | 'count_mismatch'
    | 'empty_or_invalid_scopes'
    | 'no_updated_at'
    | 'tombstone_unproven'
    | 'live_row_unproven'
    | 'not_node_row'
    | 'duplicate_id';

export const REPAIR_VERDICTS: readonly RepairVerdict[] = [
    'restorable', 'no_version_log', 'no_match', 'ambiguous_match', 'count_mismatch', 'empty_or_invalid_scopes',
    'no_updated_at', 'tombstone_unproven', 'live_row_unproven', 'not_node_row', 'duplicate_id',
];

export type RepairStatus = 'nothing-to-check' | 'planned' | 'applied';

export interface RepairScopesReport {
    status: RepairStatus;
    workspaceName: string;
    home: string;
    registryPath: string;
    workspaceDir: string;
    engine: 'lance' | 'sqlite';
    apply: boolean;
    totalRows: number;
    /** Rows by class (counts only). mixed_undefined and unreadable are never touched. */
    totals: { ok: number; all_undefined: number; mixed_undefined: number; unreadable: number };
    /** Verdict per all_undefined row. Sums to totals.all_undefined. */
    verdicts: Record<RepairVerdict, number>;
    /** The same, split by row kind. */
    byKind: Record<ScopeRowKind, Record<RepairVerdict, number>>;
    /** Up to SAMPLE_CAP row ids per verdict. Ids only, never text or scopes. */
    samples: Record<RepairVerdict, string[]>;
    versionLog: { files: string[]; nodesLookedUp: number };
    /** apply only. */
    backup?: BackupResult;
    /** apply only: rows whose scopes were written, and the re-scan's findings. */
    restored?: number;
    verified?: { totalRows: number; remainingAllUndefined: number; untouchedRowsUnchanged: true };
    message?: string;
    durationMs: number;
}

export interface RepairScopesOptions {
    workspaceName: string;
    /** Lore home holding workspaces.json. Default: the process's LORE_HOME. */
    home?: string;
    /** Write the repair. Default false = dry run (writes nothing). */
    apply?: boolean;
    /** Required with `apply`: directory the pre-write backup tarball is written into. */
    backupOutDir?: string;
    /** Bypass the daemon preflight (tests only). */
    skipDaemonCheck?: boolean;
    /** Port the daemon preflight probes (tests; default LORE_PORT / 3847). */
    daemonProbePort?: number;
    /** Rows written per commit on Lance (default 200). */
    chunkSize?: number;
    /** TEST-ONLY: runs after a chunk was planned and before its pre-write re-read (simulates a concurrent writer). */
    beforeRecheck?: (chunkIndex: number) => void | Promise<void>;
}

export class VerbatimRepairScopesError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VerbatimRepairScopesError';
    }
}

/* ─── scan ─────────────────────────────────────────────────────────── */

type Cls = 'ok' | 'all_undefined' | 'mixed_undefined' | 'unreadable';

interface ScanRow {
    /** Lance: the row id. SQLite: the rowid (decimal string). The write target. */
    key: string;
    /** Report id: Lance row id; SQLite history rows in Lance's `<id>#rev<ts>` form. */
    id: string;
    /** Id without the `#rev<ts>` suffix. */
    bareId: string;
    kind: ScopeRowKind;
    cls: Cls;
    /** Number of entries when the scopes parse as a list. */
    count: number;
    /** Plain scopes list when it parsed (else null). */
    scopes: string[] | null;
    updatedAt: string;
    type: string;
    label: string;
    /** History rows: the `#rev` timestamp. */
    ts: string | null;
    /** Digest of every non-scope field. */
    fields: string;
    /** Digest of the whole row as scanned (fields + stored scopes form). */
    digest: bigint;
    /** The stored scopes in their on-disk text form (for the digest and the SQLite compare-and-set). */
    scopesText: string | null;
    /** History rows: length + sha256 of the text (sibling proof for tombstones). */
    textLen: number;
    textHash: string | null;
    /** all_undefined tombstones only. */
    text: string | null;
}

interface Scan {
    rows: ScanRow[]; // every non-ok row + every history row (the proof set)
    totalRows: number;
    totals: Record<Cls, number>;
    /** Sum (mod 2^64) of every row's digest. */
    digestSum: bigint;
    /** Lance only: ids that occur more than once. */
    duplicateIds: Set<string>;
    /** Rows named by `watch`, whatever their class. */
    watched: Map<string, ScanRow>;
}

const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const big = (hex: string): bigint => BigInt('0x' + hex.slice(0, 16));
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const rowDigest = (fields: string, scopesText: string | null): bigint => big(sha([fields, scopesText]));

function parseClass(scopes: unknown): { cls: Cls; list: string[] | null } {
    if (!Array.isArray(scopes)) return { cls: 'ok', list: null };
    return { cls: classifyScopes(scopes), list: scopes.map((x) => String(x)) };
}

function newScan(): Scan {
    return {
        rows: [], totalRows: 0, totals: { ok: 0, all_undefined: 0, mixed_undefined: 0, unreadable: 0 },
        digestSum: 0n, duplicateIds: new Set(), watched: new Map(),
    };
}

function finishRow(scan: Scan, row: ScanRow, watch: Set<string> | undefined): void {
    scan.totalRows++;
    scan.totals[row.cls]++;
    scan.digestSum = (scan.digestSum + row.digest) & MASK;
    if (row.cls !== 'ok' || row.kind === 'history') scan.rows.push(row);
    if (watch?.has(row.key)) scan.watched.set(row.key, row);
}

async function scanLance(workspaceDir: string, watch?: Set<string>): Promise<Scan> {
    const scan = newScan();
    const conn = await lancedb.connect(path.join(workspaceDir, '.lore', 'lancedb'));
    let table: lancedb.Table | null = null;
    try {
        table = await conn.openTable(VERBATIM_TABLE);
        const have = new Set((await table.schema()).fields.map((f) => f.name));
        const cols = ['id', 'text', 'updatedAt', 'contentHash', 'type', 'label', 'security_scopes'].filter((c) => have.has(c));
        const seen = new Set<string>();
        for await (const batch of table.query().select(cols)) {
            for (const r of batch.toArray() as Array<Record<string, unknown>>) {
                const id = String(r.id);
                if (seen.has(id)) scan.duplicateIds.add(id); else seen.add(id);
                const raw = plainValue(r.security_scopes);
                const { cls, list } = parseClass(raw);
                const text = s(r.text);
                const history = classifyLanceId(id) === 'history';
                const kind: ScopeRowKind = history ? 'history' : text.startsWith(TOMBSTONE_PREFIX) ? 'canonical_tombstone' : 'canonical_live';
                const fields = sha([id, text, s(r.updatedAt), s(r.contentHash), s(r.type), s(r.label)]);
                const scopesText = list ? JSON.stringify(list) : null;
                const m = history ? REV_RE.exec(id) : null;
                finishRow(scan, {
                    key: id, id, bareId: m ? id.slice(0, m.index) : id, kind, cls, count: list?.length ?? 0, scopes: list,
                    updatedAt: s(r.updatedAt), type: s(r.type), label: s(r.label), ts: m ? m[1]! : null,
                    fields, digest: rowDigest(fields, scopesText), scopesText,
                    textLen: history ? text.length : 0, textHash: history ? sha(text) : null,
                    text: kind === 'canonical_tombstone' && cls === 'all_undefined' ? text : null,
                }, watch);
            }
        }
    } finally {
        try { table?.close(); } catch { /* best effort */ }
        try { conn.close(); } catch { /* best effort */ }
    }
    return scan;
}

interface SqliteRow {
    rowid: number; id: string; text: string; updatedAt: string | null; content_hash: string | null; type: string | null; label: string | null;
    security_scopes: string | null; is_canonical: number; is_tombstone: number; superseded_at: string | null; created_at: string | null; updated_at: string | null;
}
const SQLITE_SQL = 'SELECT rowid, id, text, updatedAt, content_hash, type, label, security_scopes, is_canonical, is_tombstone, superseded_at, created_at, updated_at FROM verbatim';

function revTs(r: SqliteRow): string | null {
    const t = r.superseded_at ?? r.created_at;
    if (!t) return null;
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

async function scanSqlite(sqlitePath: string, watch?: Set<string>): Promise<Scan> {
    const scan = newScan();
    for await (const r of readOnlySqliteRows<SqliteRow>(sqlitePath, 'verbatim', SQLITE_SQL)) {
        let cls: Cls;
        let list: string[] | null = null;
        const rawText = r.security_scopes;
        if (rawText === null || rawText === undefined || rawText === '') cls = 'ok';
        else {
            try {
                const parsed: unknown = JSON.parse(rawText);
                if (Array.isArray(parsed)) { ({ cls, list } = parseClass(parsed)); } else cls = 'unreadable';
            } catch { cls = 'unreadable'; }
        }
        const history = !r.is_canonical;
        const kind: ScopeRowKind = history ? 'history' : r.is_tombstone ? 'canonical_tombstone' : 'canonical_live';
        const ts = history ? revTs(r) : null;
        const id = history && ts ? `${r.id}#rev${ts}` : r.id;
        const text = s(r.text);
        const fields = sha([r.rowid, r.id, text, s(r.updatedAt), s(r.content_hash), s(r.type), s(r.label), r.is_canonical, r.is_tombstone,
            s(r.superseded_at), s(r.created_at), s(r.updated_at)]);
        finishRow(scan, {
            key: String(r.rowid), id, bareId: r.id, kind, cls, count: list?.length ?? 0, scopes: list,
            updatedAt: s(r.updatedAt), type: s(r.type), label: s(r.label), ts, fields,
            digest: rowDigest(fields, rawText ?? null), scopesText: rawText ?? null,
            textLen: history ? text.length : 0, textHash: history ? sha(text) : null,
            text: kind === 'canonical_tombstone' && cls === 'all_undefined' ? text : null,
        }, watch);
    }
    return scan;
}

/* ─── version log ──────────────────────────────────────────────────── */

interface VersionHit { updatedAt: string; scopes: unknown; type: string; label: string }

/**
 * versions.sqlite files that can hold this workspace's node versions. The store
 * is bound at host boot to the boot workspace's `<path>/.lore/versions.sqlite`
 * (or `<dataDir>/.lore/versions.sqlite` in the legacy single-root layout), so
 * another workspace's versions may sit in the boot workspace's file. Every
 * registered workspace's file and `<home>/.lore/` are therefore candidates; the
 * `workspace` column selects the rows. Never opened for writing, never created.
 */
export function versionLogCandidates(home: string, workspaceDirs: readonly string[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const dir of [home, ...workspaceDirs]) {
        const f = path.join(dir, '.lore', 'versions.sqlite');
        if (!fs.existsSync(f)) continue;
        let real = f;
        try { real = fs.realpathSync(f); } catch { /* keep f */ }
        if (seen.has(real)) continue;
        seen.add(real);
        out.push(f);
    }
    return out;
}

class VersionLog {
    private readonly dbs: Array<{ file: string; db: Awaited<ReturnType<typeof openReadOnlySqlite>> }> = [];
    private readonly cache = new Map<string, VersionHit[]>();
    constructor(readonly files: string[], private readonly workspaceName: string) {}

    async open(): Promise<void> {
        for (const file of this.files) {
            const db = await openReadOnlySqlite(file);
            if (!sqliteHasTable(db, 'node_versions')) { db.close(); continue; }
            this.dbs.push({ file, db });
        }
    }

    close(): void { for (const d of this.dbs) { try { d.db.close(); } catch { /* best effort */ } } }

    get lookedUp(): number { return this.cache.size; }

    /** Every recorded version state of `nodeId` in this workspace (compacted rows have no state and are skipped). */
    hits(nodeId: string): VersionHit[] {
        const cached = this.cache.get(nodeId);
        if (cached) return cached;
        const out: VersionHit[] = [];
        for (const { db } of this.dbs) {
            const rows = db.all('SELECT new_state FROM node_versions WHERE node_id = ? AND workspace = ? AND new_state IS NOT NULL', nodeId, this.workspaceName) as Array<{ new_state: string }>;
            for (const r of rows) {
                let st: unknown;
                try { st = JSON.parse(r.new_state); } catch { continue; }
                if (!st || typeof st !== 'object' || Array.isArray(st)) continue;
                const o = st as Record<string, unknown>;
                if (typeof o.updatedAt !== 'string') continue;
                out.push({ updatedAt: o.updatedAt, scopes: o.security_scopes, type: s(o.type), label: s(o.label) });
            }
        }
        this.cache.set(nodeId, out);
        return out;
    }
}

/* ─── verdicts ─────────────────────────────────────────────────────── */

interface PlanEntry { row: ScanRow; scopes: string[]; scopesJson: string }
interface Verdict { verdict: RepairVerdict; scopes?: string[] }

/** `lore:<node>` / `lore:<node>#q<n>` -> the node ids it could belong to (alias form first stripped, full id also tried). */
function nodeIdCandidates(bareId: string): string[] | null {
    if (!bareId.startsWith('lore:')) return null;
    const rest = bareId.slice('lore:'.length);
    if (rest === '') return null;
    const stripped = rest.replace(ALIAS_RE, '');
    return stripped !== rest && stripped !== '' ? [rest, stripped] : [rest];
}

function validScopes(v: unknown): string[] | null {
    if (!Array.isArray(v) || v.length === 0) return null;
    for (const x of v) if (typeof x !== 'string' || x === '' || x === 'undefined') return null;
    return v as string[];
}

function historyVerdict(row: ScanRow, log: VersionLog, dup: Set<string>): Verdict {
    const cands = nodeIdCandidates(row.bareId);
    if (!cands) return { verdict: 'not_node_row' };
    if (!row.ts) return { verdict: 'no_updated_at' }; // SQLite history row without a usable timestamp
    if (dup.has(row.id)) return { verdict: 'duplicate_id' };
    if (row.updatedAt === '') return { verdict: 'no_updated_at' };
    const alias = ALIAS_RE.test(row.bareId);
    const all: VersionHit[] = [];
    for (const n of cands) all.push(...log.hits(n));
    if (all.length === 0) return { verdict: 'no_version_log' };
    const matches = all.filter((h) => h.updatedAt === row.updatedAt && h.type === row.type && (alias || h.label === row.label));
    if (matches.length === 0) return { verdict: 'no_match' };
    const distinct = new Set(matches.map((m) => JSON.stringify(m.scopes)));
    if (distinct.size > 1) return { verdict: 'ambiguous_match' };
    const scopes = validScopes(matches[0]!.scopes);
    if (!scopes) return { verdict: 'empty_or_invalid_scopes' };
    if (scopes.length !== row.count) return { verdict: 'count_mismatch' };
    return { verdict: 'restorable', scopes };
}

function tombstoneVerdict(row: ScanRow, histVerdicts: Map<string, Verdict>, siblings: Map<string, ScanRow[]>, dup: Set<string>): Verdict {
    if (!nodeIdCandidates(row.bareId)) return { verdict: 'not_node_row' };
    if (dup.has(row.id)) return { verdict: 'duplicate_id' };
    if (row.updatedAt === '') return { verdict: 'no_updated_at' };
    if (!ISO_MS_RE.test(row.updatedAt) || row.text === null) return { verdict: 'tombstone_unproven' };
    const sibs = siblings.get(`${row.bareId}\u0000${row.updatedAt}`) ?? [];
    if (sibs.length === 0) return { verdict: 'tombstone_unproven' };
    if (sibs.length > 1) return { verdict: 'ambiguous_match' };
    const sib = sibs[0]!;
    if (dup.has(sib.id)) return { verdict: 'duplicate_id' };
    // The tombstone text is `[TOMBSTONED <ts> reason: ...]\n\n<sibling text>`.
    const t = row.text;
    const tailStart = t.length - sib.textLen;
    if (!t.startsWith(`${TOMBSTONE_PREFIX} ${row.updatedAt} reason: `) || tailStart < 2 || t.slice(tailStart - 2, tailStart) !== '\n\n'
        || sha(t.slice(tailStart)) !== sib.textHash) return { verdict: 'tombstone_unproven' };
    if (sib.cls === 'all_undefined') {
        const v = histVerdicts.get(sib.key);
        if (!v || v.verdict !== 'restorable') return { verdict: v?.verdict ?? 'tombstone_unproven' };
        if (v.scopes!.length !== row.count) return { verdict: 'count_mismatch' };
        return { verdict: 'restorable', scopes: v.scopes };
    }
    // The sibling already holds real scopes (restored by an earlier run of this command): same proof chain.
    const scopes = sib.cls === 'ok' ? validScopes(sib.scopes) : null;
    if (!scopes) return { verdict: 'tombstone_unproven' };
    if (scopes.length !== row.count) return { verdict: 'count_mismatch' };
    return { verdict: 'restorable', scopes };
}

const zeroVerdicts = (): Record<RepairVerdict, number> => Object.fromEntries(REPAIR_VERDICTS.map((v) => [v, 0])) as Record<RepairVerdict, number>;

interface Planned {
    verdicts: Record<RepairVerdict, number>;
    byKind: Record<ScopeRowKind, Record<RepairVerdict, number>>;
    samples: Record<RepairVerdict, string[]>;
    plan: PlanEntry[];
}

function buildPlan(scan: Scan, log: VersionLog): Planned {
    const verdicts = zeroVerdicts();
    const byKind: Record<ScopeRowKind, Record<RepairVerdict, number>> = { canonical_live: zeroVerdicts(), canonical_tombstone: zeroVerdicts(), history: zeroVerdicts() };
    const samples = Object.fromEntries(REPAIR_VERDICTS.map((v) => [v, [] as string[]])) as Record<RepairVerdict, string[]>;
    const plan: PlanEntry[] = [];
    const histVerdicts = new Map<string, Verdict>();
    const siblings = new Map<string, ScanRow[]>();
    for (const r of scan.rows) {
        if (r.kind !== 'history' || !r.ts) continue;
        const k = `${r.bareId}\u0000${r.ts}`;
        const l = siblings.get(k) ?? [];
        l.push(r);
        siblings.set(k, l);
    }
    const record = (row: ScanRow, v: Verdict): void => {
        verdicts[v.verdict]++;
        byKind[row.kind][v.verdict]++;
        if (samples[v.verdict].length < SAMPLE_CAP && !samples[v.verdict].includes(row.id)) samples[v.verdict].push(row.id); // a duplicated Lance id is listed once
        if (v.verdict === 'restorable') plan.push({ row, scopes: v.scopes!, scopesJson: JSON.stringify(v.scopes) });
    };
    const damaged = scan.rows.filter((r) => r.cls === 'all_undefined');
    for (const r of damaged) if (r.kind === 'history') histVerdicts.set(r.key, historyVerdict(r, log, scan.duplicateIds));
    for (const r of damaged) {
        if (r.kind === 'history') record(r, histVerdicts.get(r.key)!);
        else if (r.kind === 'canonical_tombstone') record(r, tombstoneVerdict(r, histVerdicts, siblings, scan.duplicateIds));
        else record(r, { verdict: 'live_row_unproven' });
    }
    return { verdicts, byKind, samples, plan };
}

/* ─── apply ────────────────────────────────────────────────────────── */

const sqlQuote = (id: string): string => `'${escapeSqlLiteral(id)}'`;

/** Rows of `ids` as a FRESH Lance handle sees them: id -> [{updatedAt, scopes}] (all copies). */
async function readLanceChunk(lancedbPath: string, ids: string[]): Promise<Map<string, Array<{ updatedAt: string; scopes: string[] | null }>>> {
    const conn = await lancedb.connect(lancedbPath);
    let table: lancedb.Table | null = null;
    try {
        table = await conn.openTable(VERBATIM_TABLE);
        const out = new Map<string, Array<{ updatedAt: string; scopes: string[] | null }>>();
        const rows = await table.query().where(`id IN (${ids.map(sqlQuote).join(', ')})`).select(['id', 'updatedAt', 'security_scopes']).toArray() as Array<Record<string, unknown>>;
        for (const r of rows) {
            const raw = plainValue(r.security_scopes);
            const l = out.get(String(r.id)) ?? [];
            l.push({ updatedAt: s(r.updatedAt), scopes: Array.isArray(raw) ? raw.map((x) => String(x)) : null });
            out.set(String(r.id), l);
        }
        return out;
    } finally {
        try { table?.close(); } catch { /* best effort */ }
        try { conn.close(); } catch { /* best effort */ }
    }
}

async function applyLance(workspaceDir: string, plan: PlanEntry[], chunkSize: number, opts: RepairScopesOptions, written: { n: number }): Promise<void> {
    const lancedbPath = path.join(workspaceDir, '.lore', 'lancedb');
    // Group by target scopes so one update covers many ids.
    const groups = new Map<string, PlanEntry[]>();
    for (const e of plan) {
        const g = groups.get(e.scopesJson) ?? [];
        g.push(e);
        groups.set(e.scopesJson, g);
    }
    const chunks: PlanEntry[][] = [];
    for (const g of groups.values()) for (let i = 0; i < g.length; i += chunkSize) chunks.push(g.slice(i, i + chunkSize));
    const conn = await lancedb.connect(lancedbPath);
    let table: lancedb.Table | null = null;
    try {
        table = await conn.openTable(VERBATIM_TABLE);
        for (let c = 0; c < chunks.length; c++) {
            const chunk = chunks[c]!;
            for (const e of chunk) assertSafeLanceId(e.row.id, 'repairScopes');
            const ids = chunk.map((e) => e.row.id);
            await opts.beforeRecheck?.(c);
            const now = await readLanceChunk(lancedbPath, ids);
            for (const e of chunk) {
                const copies = now.get(e.row.id) ?? [];
                const cur = copies[0];
                if (copies.length !== 1 || !cur || cur.updatedAt !== e.row.updatedAt || !cur.scopes || cur.scopes.length !== e.row.count
                    || classifyScopes(cur.scopes) !== 'all_undefined') {
                    throw new VerbatimRepairScopesError(`ABORTED: row '${e.row.id}' changed since it was read (another process wrote to this Lance table during the apply — an app that embeds Lore on this data dir, such as Atlas, MIRA or PM Helper, must be closed first). `
                        + `Nothing was written for this chunk; ${written.n} row(s) in earlier chunk(s) were already restored and stay restored. Re-run 'lore verbatim repair-scopes' to see the current state`);
                }
            }
            await table.update({ where: `id IN (${ids.map(sqlQuote).join(', ')})`, values: { security_scopes: chunk[0]!.scopes } });
            written.n += chunk.length;
        }
    } finally {
        try { table?.close(); } catch { /* best effort */ }
        try { conn.close(); } catch { /* best effort */ }
    }
}

async function applySqlite(sqlitePath: string, plan: PlanEntry[], written: { n: number }, opts: RepairScopesOptions): Promise<void> {
    const db = new Database(sqlitePath, { fileMustExist: true });
    try {
        db.pragma('busy_timeout = 5000');
        // Compare-and-set on the exact bytes read: the row must still hold the damaged text and the same updatedAt.
        const stmt = db.prepare('UPDATE verbatim SET security_scopes = ? WHERE rowid = ? AND security_scopes IS ? AND updatedAt IS ?');
        for (let i = 0; i < plan.length; i += SQLITE_CHUNK) {
            const chunk = plan.slice(i, i + SQLITE_CHUNK);
            await opts.beforeRecheck?.(i / SQLITE_CHUNK);
            const tx = db.transaction(() => {
                for (const e of chunk) {
                    const res = stmt.run(e.scopesJson, Number(e.row.key), e.row.scopesText, e.row.updatedAt === '' ? null : e.row.updatedAt);
                    if (res.changes !== 1) {
                        throw new VerbatimRepairScopesError(`ABORTED: row '${e.row.id}' changed since it was read (another process wrote to this SQLite store during the apply — an app that embeds Lore on this data dir must be closed first). `
                            + `This chunk was rolled back; ${written.n} row(s) in earlier chunk(s) were already restored and stay restored. Re-run 'lore verbatim repair-scopes' to see the current state`);
                    }
                }
            });
            tx();
            written.n += chunk.length;
        }
    } finally { db.close(); }
}

/* ─── entry point ──────────────────────────────────────────────────── */

/**
 * Plan (and with `apply`, perform) the proven restoration of damaged
 * `security_scopes`. Throws VerbatimRepairScopesError for refusals and failed
 * verification; the message names the backup path once one exists.
 */
export async function repairVerbatimScopes(opts: RepairScopesOptions): Promise<RepairScopesReport> {
    const startedAt = Date.now();
    const home = opts.home ?? loreHome();
    const ws = opts.workspaceName;
    const apply = opts.apply === true;
    const registry = loadWorkspacesIfPresent(home);
    const registryPath = path.join(home, 'workspaces.json');
    if (!registry) {
        throw new VerbatimRepairScopesError(`no workspace registry (workspaces.json) found under ${home} — nothing to repair. `
            + 'Check --data-dir / LORE_HOME points at the Lore home that holds the workspace.');
    }
    const entry = registry.workspaces.find((w) => w.name === ws);
    if (!entry) throw new VerbatimRepairScopesError(`workspace_not_found: "${ws}" (known: ${registry.workspaces.map((w) => w.name).join(', ')})`);
    const workspaceDir = entry.path;
    const engine: 'lance' | 'sqlite' = entry.vectorEngine === 'sqlite' ? 'sqlite' : 'lance';
    const sqlitePath = path.join(workspaceDir, '.lore', 'verbatim.sqlite');

    const base = (status: RepairStatus, scan: Scan | null, planned: Planned | null, log: VersionLog | null, message?: string): RepairScopesReport => ({
        status, workspaceName: ws, home, registryPath, workspaceDir, engine, apply,
        totalRows: scan?.totalRows ?? 0,
        totals: scan?.totals ?? { ok: 0, all_undefined: 0, mixed_undefined: 0, unreadable: 0 },
        verdicts: planned?.verdicts ?? zeroVerdicts(),
        byKind: planned?.byKind ?? { canonical_live: zeroVerdicts(), canonical_tombstone: zeroVerdicts(), history: zeroVerdicts() },
        samples: planned?.samples ?? (Object.fromEntries(REPAIR_VERDICTS.map((v) => [v, []])) as unknown as Record<RepairVerdict, string[]>),
        versionLog: { files: log?.files ?? [], nodesLookedUp: log?.lookedUp ?? 0 },
        ...(message ? { message } : {}), durationMs: Date.now() - startedAt,
    });

    const exists = engine === 'sqlite' ? fs.existsSync(sqlitePath) : lanceTableExists(workspaceDir);
    if (!exists) {
        return base('nothing-to-check', null, null, null, engine === 'sqlite'
            ? `nothing to check: '${ws}' has no SQLite verbatim store (${sqlitePath})`
            : `nothing to check: '${ws}' has no LanceDB ${VERBATIM_TABLE} table`);
    }
    if (apply && !opts.skipDaemonCheck) {
        const probe = await isDaemonServingHome(home, 800, opts.daemonProbePort);
        if (probe.servesHome) throw new VerbatimRepairScopesError(daemonRefuseMessage('lore verbatim repair-scopes --apply'));
    }
    if (apply && !opts.backupOutDir) {
        throw new VerbatimRepairScopesError('verbatim repair-scopes: --apply needs a backup directory (backupOutDir); refusing to write without a backup.');
    }

    const scanner = (watch?: Set<string>): Promise<Scan> => (engine === 'sqlite' ? scanSqlite(sqlitePath, watch) : scanLance(workspaceDir, watch));
    const log = new VersionLog(versionLogCandidates(home, registry.workspaces.map((w) => w.path)), ws);
    try {
        await log.open();
        const before = await scanner();
        const planned = buildPlan(before, log);
        if (!apply || planned.plan.length === 0) return base('planned', before, planned, log);

        // ── Backup FIRST ────────────────────────────────────────────────
        fs.mkdirSync(opts.backupOutDir!, { recursive: true }); // created only when there is real work to back up
        const backup = await backupWorkspace({ workspaceDir, workspaceName: ws, outDir: opts.backupOutDir! });
        // backupWorkspace downgrades a failed per-store copy to a warning. The
        // store this command writes MUST be in the backup, or we refuse.
        const storeEntry = engine === 'sqlite' ? 'verbatim.sqlite' : 'lancedb/';
        const storeWarning = backup.warnings.find((w) => w.startsWith(`${storeEntry.replace(/\/$/, '')}:`));
        if (!backup.files.includes(storeEntry) || storeWarning) {
            throw new VerbatimRepairScopesError(`verbatim repair-scopes: the backup at ${backup.tarballPath} does not contain ${storeEntry}${storeWarning ? ` (${storeWarning})` : ''}; refusing to write. Nothing was changed.`);
        }
        const written = { n: 0 };
        try {
            if (engine === 'sqlite') await applySqlite(sqlitePath, planned.plan, written, opts);
            else await applyLance(workspaceDir, planned.plan, Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK), opts, written);

            // ── Re-scan and assert ──────────────────────────────────────
            const watch = new Set(planned.plan.map((e) => e.row.key));
            const after = await scanner(watch);
            const problems: string[] = [];
            if (after.totalRows !== before.totalRows) problems.push(`row count changed ${before.totalRows} -> ${after.totalRows}`);
            let expected = before.digestSum;
            for (const e of planned.plan) {
                expected = (expected - e.row.digest + MASK + 1n) & MASK;
                expected = (expected + rowDigest(e.row.fields, e.scopesJson)) & MASK;
                const w = after.watched.get(e.row.key);
                if (!w) problems.push(`restored row '${e.row.id}' is missing after the write`);
                else if (w.cls !== 'ok' || JSON.stringify(w.scopes) !== e.scopesJson || w.fields !== e.row.fields) problems.push(`row '${e.row.id}' does not hold exactly the planned scopes`);
            }
            if (after.digestSum !== expected) problems.push('some row other than the restored scopes changed (text, vector-adjacent fields, updatedAt, ids or scopes of an untouched row)');
            const exp = { ...before.totals, all_undefined: before.totals.all_undefined - planned.plan.length, ok: before.totals.ok + planned.plan.length };
            for (const k of ['ok', 'all_undefined', 'mixed_undefined', 'unreadable'] as const) {
                if (after.totals[k] !== exp[k]) problems.push(`class ${k}: ${after.totals[k]} rows, expected ${exp[k]}`);
            }
            if (problems.length > 0) {
                throw new VerbatimRepairScopesError(`post-write verification FAILED: ${problems.join('; ')}. Restore from the backup at ${backup.tarballPath} if unexpected.`);
            }
            const rep = base('applied', before, planned, log);
            rep.backup = backup;
            rep.restored = planned.plan.length;
            rep.verified = { totalRows: after.totalRows, remainingAllUndefined: after.totals.all_undefined, untouchedRowsUnchanged: true };
            return rep;
        } catch (e) {
            if (e instanceof VerbatimRepairScopesError && /backup at /.test(e.message)) throw e;
            const err = e instanceof Error ? e : new Error(String(e));
            throw new VerbatimRepairScopesError(`${err.message} — backup at ${backup.tarballPath}`);
        }
    } finally {
        log.close();
    }
}
