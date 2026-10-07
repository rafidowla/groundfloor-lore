/**
 * verbatimCheckScopes.ts — read-only report of verbatim rows whose
 * `security_scopes` were damaged by the pre-3.28.0 Lance writer
 * (`lore verbatim check-scopes <workspace>`, post-3.28.0).
 *
 * The damage: before 3.28.0, VerbatimStore's private `toPlainStringList`
 * indexed an Arrow `List<Utf8>` vector with `v[i]` (undefined) and
 * String()-ed it, so every history snapshot (`<id>#rev…`), storeBatch
 * preflight snapshot and `tombstone()` write (the #rev row AND the
 * overwritten canonical tombstone) carried `['undefined', 'undefined', …]`
 * — one `'undefined'` per original scope. Live canonical non-tombstone rows
 * were not affected. `lore migrate-vectors --to sqlite` copied the damaged
 * rows into SQLite as JSON text `["undefined",…]`. No principal holds a scope
 * called 'undefined', so the effect is fail-closed (the rows are invisible),
 * and this command only REPORTS. Nothing is repaired or rewritten: the
 * original scopes are unrecoverable from the damaged row itself. (They can
 * sometimes be proven from the node version log: see verbatimRepairScopes.ts,
 * `lore verbatim repair-scopes`.)
 *
 * Read-only by construction:
 *   - Lance: opens the table directly with @lancedb/lancedb (never through
 *     VerbatimStore: no fingerprint stamp, no index build/repair, no embed)
 *     and only runs a `select(id, text, security_scopes)` scan.
 *   - SQLite: opens `verbatim.sqlite` read-only and creates no file, not even
 *     the empty `-wal` / `-shm` sidecars a read-only better-sqlite3 open of a
 *     WAL database leaves behind (see sqliteScopeRows). Never
 *     openSqliteVerbatimDb, which sets WAL pragmas, creates the schema and
 *     loads extensions.
 *
 * Classes (per row, from the RAW stored scopes):
 *   all_undefined    non-empty and every entry === 'undefined'
 *   mixed_undefined  contains 'undefined' plus other values (expected ~0)
 *   unreadable       SQLite only: the JSON text does not parse to an array
 *   ok               everything else, including empty / null
 * Kinds: canonical_live, canonical_tombstone (text starts `[TOMBSTONED`, or
 * is_tombstone = 1 in SQLite), history (`#rev` id in Lance; is_canonical = 0
 * in SQLite). `#q<n>` alias rows are canonical rows and count as canonical.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import Database from 'better-sqlite3';
import { loadWorkspacesIfPresent } from '../config/workspaces.js';
import { loreHome } from '../config/loreHome.js';
import { classifyLanceId } from './migrateVectorsRows.js';
import { lanceRowId } from './verbatimPromotionStage.js';

export const VERBATIM_TABLE = 'lore_verbatim';
export const TOMBSTONE_PREFIX = '[TOMBSTONED';
export const SAMPLE_CAP = 20;

export type ScopeClass = 'ok' | 'all_undefined' | 'mixed_undefined' | 'unreadable';
export type ScopeRowKind = 'canonical_live' | 'canonical_tombstone' | 'history';

export const SCOPE_CLASSES: readonly ScopeClass[] = ['ok', 'all_undefined', 'mixed_undefined', 'unreadable'];
export const SCOPE_ROW_KINDS: readonly ScopeRowKind[] = ['canonical_live', 'canonical_tombstone', 'history'];

export type ClassCounts = Record<ScopeClass, number>;

export interface CheckScopesReport {
    status: 'checked' | 'nothing-to-check';
    workspaceName: string;
    home: string;
    registryPath: string;
    workspaceDir: string;
    engine: 'lance' | 'sqlite';
    totalRows: number;
    totals: ClassCounts;
    byKind: Record<ScopeRowKind, ClassCounts & { total: number }>;
    /** Up to SAMPLE_CAP row ids per non-ok class. Ids only, never text. */
    samples: Record<Exclude<ScopeClass, 'ok'>, string[]>;
    message?: string;
    durationMs: number;
}

export interface CheckScopesOptions {
    workspaceName: string;
    /** Lore home holding workspaces.json. Default: the process's LORE_HOME. */
    home?: string;
}

export class VerbatimCheckScopesError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'VerbatimCheckScopesError';
    }
}

/** Arrow vectors / typed arrays -> plain JS values; everything else passes through. */
export function plainValue(v: unknown): unknown {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || v instanceof Date) return v;
    if (Array.isArray(v) || ArrayBuffer.isView(v) || (typeof v === 'object' && Symbol.iterator in (v as object))) {
        return Array.from(v as Iterable<unknown>, plainValue);
    }
    return v;
}

/** Classify an already-plain scopes array. */
export function classifyScopes(scopes: readonly unknown[]): Exclude<ScopeClass, 'unreadable'> {
    if (scopes.length === 0) return 'ok';
    let undef = 0;
    for (const s of scopes) if (s === 'undefined') undef++;
    if (undef === 0) return 'ok';
    return undef === scopes.length ? 'all_undefined' : 'mixed_undefined';
}

const zeroCounts = (): ClassCounts => ({ ok: 0, all_undefined: 0, mixed_undefined: 0, unreadable: 0 });

class Tally {
    totalRows = 0;
    readonly totals = zeroCounts();
    readonly kinds: Record<ScopeRowKind, ClassCounts & { total: number }> = {
        canonical_live: { total: 0, ...zeroCounts() },
        canonical_tombstone: { total: 0, ...zeroCounts() },
        history: { total: 0, ...zeroCounts() },
    };
    readonly samples: Record<Exclude<ScopeClass, 'ok'>, string[]> = { all_undefined: [], mixed_undefined: [], unreadable: [] };
    add(kind: ScopeRowKind, cls: ScopeClass, id: string): void {
        this.totalRows++;
        this.totals[cls]++;
        this.kinds[kind].total++;
        this.kinds[kind][cls]++;
        if (cls !== 'ok' && this.samples[cls].length < SAMPLE_CAP) this.samples[cls].push(id);
    }
}

export function lanceTableExists(workspaceDir: string): boolean {
    return fs.existsSync(path.join(workspaceDir, '.lore', 'lancedb', `${VERBATIM_TABLE}.lance`));
}

async function scanLance(workspaceDir: string, tally: Tally): Promise<void> {
    const conn = await lancedb.connect(path.join(workspaceDir, '.lore', 'lancedb'));
    let table: lancedb.Table | null = null;
    try {
        table = await conn.openTable(VERBATIM_TABLE);
        const have = new Set((await table.schema()).fields.map((f) => f.name));
        const cols = ['id', 'text', 'security_scopes'].filter((c) => have.has(c));
        for await (const batch of table.query().select(cols)) {
            for (const r of batch.toArray() as Array<Record<string, unknown>>) {
                const id = String(r.id);
                const raw = plainValue(r.security_scopes);
                const cls = Array.isArray(raw) ? classifyScopes(raw) : 'ok';
                const kind: ScopeRowKind = classifyLanceId(id) === 'history'
                    ? 'history'
                    : String(r.text ?? '').startsWith(TOMBSTONE_PREFIX) ? 'canonical_tombstone' : 'canonical_live';
                tally.add(kind, cls, id);
            }
        }
    } finally {
        try { table?.close(); } catch { /* best effort */ }
        try { conn.close(); } catch { /* best effort */ }
    }
}

interface SqliteScopeRow {
    id: string;
    security_scopes: string | null;
    is_canonical: number;
    is_tombstone: number;
    superseded_at: string | null;
    created_at: string | null;
}
const SCOPE_SQL = 'SELECT id, security_scopes, is_canonical, is_tombstone, superseded_at, created_at FROM verbatim';

/** A read-only SQLite handle that creates no file (see openReadOnlySqlite). */
export interface ReadOnlySqlite {
    all(sql: string, ...params: unknown[]): unknown[];
    iterate(sql: string, ...params: unknown[]): Iterable<unknown>;
    close(): void;
}

/**
 * Open a SQLite file read-only WITHOUT creating any file.
 *
 * A read-only better-sqlite3 open of a WAL database creates empty `-wal` and
 * `-shm` sidecars when they are absent, which is a write to the operator's data
 * dir. So:
 *   - no `-wal` / `-shm` beside the file (cleanly closed, nothing to replay):
 *     open through node:sqlite with `immutable=1`, which takes no locks and
 *     creates nothing;
 *   - a sidecar exists (a host has it open, or crashed with unreplayed pages):
 *     open with better-sqlite3 `readonly`, because the WAL holds committed rows
 *     the main file lacks, and the sidecars already exist so none are created.
 */
export async function openReadOnlySqlite(sqlitePath: string): Promise<ReadOnlySqlite> {
    const hasSidecar = fs.existsSync(`${sqlitePath}-wal`) || fs.existsSync(`${sqlitePath}-shm`);
    if (!hasSidecar) {
        const sqlite = await importNodeSqlite();
        if (sqlite) {
            const db = new sqlite.DatabaseSync(`file:${encodeURI(sqlitePath).replace(/\?/g, '%3F').replace(/#/g, '%23')}?immutable=1`, { readOnly: true });
            return {
                all: (sql, ...params) => db.prepare(sql).all(...params),
                iterate: (sql, ...params) => db.prepare(sql).iterate(...params),
                close: () => db.close(),
            };
        }
    }
    const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    return {
        all: (sql, ...params) => db.prepare(sql).all(...params),
        iterate: (sql, ...params) => db.prepare(sql).iterate(...params),
        close: () => { db.close(); },
    };
}

/** True when the SQLite file has a table called `table` (internal constants only, never user input). */
export function sqliteHasTable(db: ReadOnlySqlite, table: string): boolean {
    return db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`).length > 0;
}

/** Rows of one table of a SQLite file, read through openReadOnlySqlite. Yields nothing when the table is missing. */
export async function* readOnlySqliteRows<T>(sqlitePath: string, table: string, sql: string): AsyncGenerator<T> {
    const db = await openReadOnlySqlite(sqlitePath);
    try {
        if (!sqliteHasTable(db, table)) return;
        for (const r of db.iterate(sql)) yield r as T;
    } finally { db.close(); }
}

function sqliteScopeRows(sqlitePath: string): AsyncGenerator<SqliteScopeRow> {
    return readOnlySqliteRows<SqliteScopeRow>(sqlitePath, 'verbatim', SCOPE_SQL);
}

type NodeSqlite = { DatabaseSync: new (p: string, o: { readOnly: boolean }) => {
    prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; iterate(...p: unknown[]): Iterable<unknown> };
    close(): void;
} };

/** node:sqlite prints an ExperimentalWarning on first load; swallow that one line (the CLI's stderr stays clean). */
async function importNodeSqlite(): Promise<NodeSqlite | null> {
    const orig = process.emitWarning;
    process.emitWarning = ((w: unknown, ...rest: unknown[]) => {
        const msg = typeof w === 'string' ? w : (w as Error | undefined)?.message ?? '';
        if (/SQLite is an experimental feature/i.test(msg)) return;
        return (orig as (...a: unknown[]) => void).call(process, w, ...rest);
    }) as typeof process.emitWarning;
    try {
        // Variable specifier: the installed @types/node predates node:sqlite's typings.
        const spec = 'node:sqlite';
        return (await import(spec)) as unknown as NodeSqlite;
    } catch {
        return null;
    } finally {
        process.emitWarning = orig;
    }
}

async function scanSqlite(sqlitePath: string, tally: Tally): Promise<void> {
    for await (const r of sqliteScopeRows(sqlitePath)) {
        let cls: ScopeClass;
        const raw = r.security_scopes;
        if (raw === null || raw === undefined || raw === '') cls = 'ok';
        else {
            try {
                const parsed: unknown = JSON.parse(raw);
                cls = Array.isArray(parsed) ? classifyScopes(parsed) : 'unreadable';
            } catch { cls = 'unreadable'; }
        }
        const kind: ScopeRowKind = !r.is_canonical ? 'history' : r.is_tombstone ? 'canonical_tombstone' : 'canonical_live';
        // History rows share their canonical id in SQLite; report them in Lance's `<id>#rev<ts>` form.
        let sampleId = r.id;
        if (!r.is_canonical) {
            try { sampleId = lanceRowId({ id: r.id, is_canonical: 0, superseded_at: r.superseded_at, created_at: r.created_at } as never); } catch { /* keep the bare id */ }
        }
        tally.add(kind, cls, sampleId);
    }
}

/**
 * Report damaged `security_scopes` in a workspace's verbatim store (Lance or
 * SQLite per the registry's `vectorEngine`). Writes nothing. Throws
 * VerbatimCheckScopesError for refusals (no registry, unknown workspace).
 */
export async function checkVerbatimScopes(opts: CheckScopesOptions): Promise<CheckScopesReport> {
    const startedAt = Date.now();
    const home = opts.home ?? loreHome();
    const ws = opts.workspaceName;
    // Read-only registry lookup: never bootstraps a workspaces.json.
    const registry = loadWorkspacesIfPresent(home);
    const registryPath = path.join(home, 'workspaces.json');
    if (!registry) {
        throw new VerbatimCheckScopesError(`no workspace registry (workspaces.json) found under ${home} — nothing to check. `
            + 'Check --data-dir / LORE_HOME points at the Lore home that holds the workspace.');
    }
    const entry = registry.workspaces.find((w) => w.name === ws);
    if (!entry) {
        throw new VerbatimCheckScopesError(`workspace_not_found: "${ws}" (known: ${registry.workspaces.map((w) => w.name).join(', ')})`);
    }
    const workspaceDir = entry.path;
    const engine: 'lance' | 'sqlite' = entry.vectorEngine === 'sqlite' ? 'sqlite' : 'lance';
    const tally = new Tally();
    const finish = (status: CheckScopesReport['status'], message?: string): CheckScopesReport => ({
        status, workspaceName: ws, home, registryPath, workspaceDir, engine,
        totalRows: tally.totalRows, totals: tally.totals, byKind: tally.kinds, samples: tally.samples,
        ...(message ? { message } : {}), durationMs: Date.now() - startedAt,
    });

    if (engine === 'sqlite') {
        const sqlitePath = path.join(workspaceDir, '.lore', 'verbatim.sqlite');
        if (!fs.existsSync(sqlitePath)) return finish('nothing-to-check', `nothing to check: '${ws}' has no SQLite verbatim store (${sqlitePath})`);
        await scanSqlite(sqlitePath, tally);
    } else {
        if (!lanceTableExists(workspaceDir)) return finish('nothing-to-check', `nothing to check: '${ws}' has no LanceDB ${VERBATIM_TABLE} table`);
        await scanLance(workspaceDir, tally);
    }
    return finish('checked');
}
