/**
 * tablesLeftBehind.ts - the SQLite `tables.sqlite` a workspace leaves on disk when its graph engine is switched
 * to `postgres` (the Postgres table storage never reads it and starts empty).
 *
 *   - `inspectLegacyTablesFile`  cheap check: does the file exist, and does any table in it hold a row?
 *   - `warnTablesLeftBehind`     logs ONE warning per workspace per process (called where the factory chooses
 *                                Postgres), naming the file and `lore tables copy`.
 *   - `openLegacyTablesSnapshot` copies the file (+ WAL) into a temp dir and opens the COPY through
 *                                SqliteTableStorage, so the original is never opened, locked or modified.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { SqliteTableStorage } from './sqliteTableStorage.js';
import { openSqliteTableStorageAt } from './tableStorageFactory.js';

export const LEGACY_TABLES_FILE = 'tables.sqlite';
export const LEGACY_SCHEMAS_FILE = 'sqlite-collection-schemas.json';

export const legacyTablesPath = (workspaceDir: string): string => path.join(workspaceDir, '.lore', LEGACY_TABLES_FILE);

export interface LegacyTablesInspection {
    path: string;
    exists: boolean;
    /** At least one user table holds a row. When `inspected` is false this is the conservative guess (file has bytes). */
    nonEmpty: boolean;
    /** False when the file could not be opened for the check (locked, corrupt). */
    inspected: boolean;
}

/** Existence + "any row at all" check, read-only; never reads row values. */
export function inspectLegacyTablesFile(workspaceDir: string): LegacyTablesInspection {
    const file = legacyTablesPath(workspaceDir);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { return { path: file, exists: false, nonEmpty: false, inspected: true }; }
    if (size === 0) return { path: file, exists: true, nonEmpty: false, inspected: true };
    let db: Database.Database | undefined;
    try {
        db = new Database(file, { readonly: true, fileMustExist: true });
        const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        for (const { name } of names) {
            if (db.prepare(`SELECT 1 FROM "${name.replace(/"/g, '""')}" LIMIT 1`).get() !== undefined) {
                return { path: file, exists: true, nonEmpty: true, inspected: true };
            }
        }
        return { path: file, exists: true, nonEmpty: false, inspected: true };
    } catch {
        return { path: file, exists: true, nonEmpty: true, inspected: false };
    } finally {
        try { db?.close(); } catch { /* ignore */ }
    }
}

const warned = new Set<string>();

/** Test hook: forget which workspaces were already warned about. */
export function resetTablesLeftBehindWarningsForTest(): void { warned.clear(); }

/**
 * Warn (once per workspace per process) that `workspace` stores tables in Postgres while a non-empty
 * `tables.sqlite` still sits in `workspaceDir`. Never throws.
 */
export function warnTablesLeftBehind(workspace: string, workspaceDir: string, warn: (m: string) => void = (m) => console.warn(m)): void {
    if (warned.has(workspace)) return;
    warned.add(workspace);
    try {
        const r = inspectLegacyTablesFile(workspaceDir);
        if (!r.exists || !r.nonEmpty) return;
        warn(
            `[lore] workspace '${workspace}' keeps its tables in Postgres, but ${r.path} ` +
            `${r.inspected ? 'still holds table rows' : 'exists and could not be inspected (it may hold table rows)'} that Lore no longer reads. ` +
            `Copy them with: lore tables copy --workspace ${workspace}  (dry run first; add --yes to copy). The file is never changed or deleted.`,
        );
    } catch { /* a diagnostic must never break opening the table storage */ }
}

export interface LegacyTablesSnapshot {
    storage: SqliteTableStorage;
    /** Table names present in the SQLite file but absent from the schema sidecar (cannot be copied: no declared shape). */
    undeclared: string[];
    close(): void;
}

/** Open a private copy of the workspace's tables.sqlite. Returns null when the file does not exist. */
export function openLegacyTablesSnapshot(workspaceDir: string): LegacyTablesSnapshot | null {
    const src = legacyTablesPath(workspaceDir);
    if (!fs.existsSync(src)) return null;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-tables-copy-'));
    const cleanup = (): void => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } };
    try {
        const dst = path.join(tmp, LEGACY_TABLES_FILE);
        fs.copyFileSync(src, dst);
        if (fs.existsSync(`${src}-wal`)) fs.copyFileSync(`${src}-wal`, `${dst}-wal`);
        const sidecarSrc = path.join(path.dirname(src), LEGACY_SCHEMAS_FILE);
        const sidecarDst = path.join(tmp, LEGACY_SCHEMAS_FILE);
        if (fs.existsSync(sidecarSrc)) fs.copyFileSync(sidecarSrc, sidecarDst);
        const storage = openSqliteTableStorageAt(dst, sidecarDst);
        const declared = new Set<string>(fs.existsSync(sidecarDst) ? Object.keys(JSON.parse(fs.readFileSync(sidecarDst, 'utf-8')) as object) : []);
        const names = storage.getDatabase().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
        const undeclared = names.map((n) => n.name).filter((n) => !declared.has(n));
        return { storage, undeclared, close: () => { try { storage.close(); } finally { cleanup(); } } };
    } catch (err) {
        cleanup();
        throw err;
    }
}
