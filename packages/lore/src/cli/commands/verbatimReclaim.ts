/**
 * `lore verbatim reclaim` (3.35.0) — collapse the duplicate verbatim rows that
 * pre-3.35.0 skip-identical gaps left behind. The row rule and the SQL live in
 * engines/verbatimReclaim.ts; this file owns flags, target resolution, the
 * refusal policy and the report.
 *
 * Dry run by default (read-only connection, safe next to a live host).
 * `--apply` refuses when anything has the store open, then deletes in one
 * transaction per chunk. Space returns to the OS only with `--vacuum`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { loreHome, resolveLoreHome } from '../../config/loreHome.js';
import { loadWorkspacesIfPresent } from '../../config/workspaces.js';
import { parseOrExit, dataDirFlag } from '../args.js';
import { readPromotionState } from '../../engines/verbatimPromotionState.js';
import { isDaemonServingHome, daemonRefuseMessage } from './migrateWorkspaceToWorkspaceShared.js';
import {
    scanReclaim, applyReclaim, openReclaimDb, sqliteFootprintBytes, freelistBytes, canonicalRowCount,
    ReclaimConflictError, type ReclaimPlan,
} from '../../engines/verbatimReclaim.js';

export function reclaimUsage(): void {
    console.error('usage: lore verbatim reclaim [<workspace>] [--lore-dir <.lore dir> | --data-dir <path>] [--apply] [--vacuum] [--force] [--json]');
    console.error('');
    console.error('  Collapse duplicate verbatim rows (SQLite stores). Per node id, in time order, a run of');
    console.error('  CONSECUTIVE rows with identical content (hash, type, label, tags, project, ecosystem, scopes)');
    console.error('  keeps one row: the canonical row if the run ends at it, else the run\'s oldest row. A row whose');
    console.error('  content differs from its neighbours is never deleted (A,A,B,B,A -> A,B,A). Tombstones and');
    console.error('  rows with no content hash are never touched.');
    console.error('  Default is a dry run: counts per workspace and a bytes estimate. Writes nothing; safe while a');
    console.error('  host is running.');
    console.error('  --apply            Delete, one transaction per 500-row chunk. REFUSES while any process has the');
    console.error('                     store open (daemon, embedded host) or a promotion is in progress. Stop the');
    console.error('                     host and back up <ws>/.lore/verbatim.sqlite first.');
    console.error('  --vacuum           After --apply, VACUUM so the file shrinks on disk. Off by default: without');
    console.error('                     it the freed pages are reused by later writes but the file keeps its size.');
    console.error('  --lore-dir <dir>   ONE embedded workspace, addressed by its .lore/ directory.');
    console.error('  --data-dir <path>  Target an embedded host\'s createLore({ dataDir }) root instead of LORE_HOME.');
    console.error('  --force            Bypass only the "holder could not be determined" / promotion refusals.');
    console.error('                     A confirmed holder is always refused.');
    console.error('  --json             Print the report as JSON.');
    console.error('  LanceDB stores are reported as not_supported (use `lore verbatim dedupe` for duplicate ids).');
}

interface Target { workspace: string; dbPath: string; basePath: string; engine: 'sqlite' | 'lance'; hasFile: boolean }

interface TargetReport {
    workspace: string;
    dbPath: string;
    status: 'planned' | 'applied' | 'nothing-to-reclaim' | 'not_supported' | 'no-store';
    message?: string;
    plan?: Omit<ReclaimPlan, 'rows'>;
    deleted?: number;
    bytesBefore?: number;
    bytesAfter?: number;
    freelistBytesAfter?: number;
    vacuumed?: boolean;
    ftsIntegrity?: string;
}

/** pids (other than ours) with the store file, its -wal or -shm open. determined=false when the OS could not say. */
export function findSqliteHolders(dbPath: string): { pids: number[]; determined: boolean } {
    const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((f) => fs.existsSync(f));
    if (files.length === 0) return { pids: [], determined: true };
    const pids = new Set<number>();
    if (process.platform === 'linux') {
        try {
            const targets = new Set(files.map((f) => fs.realpathSync(f)));
            for (const p of fs.readdirSync('/proc')) {
                if (!/^\d+$/.test(p) || Number(p) === process.pid) continue;
                let fds: string[];
                try { fds = fs.readdirSync(`/proc/${p}/fd`); } catch { continue; }
                for (const fd of fds) {
                    try { if (targets.has(fs.readlinkSync(`/proc/${p}/fd/${fd}`))) { pids.add(Number(p)); break; } } catch { /* closed */ }
                }
            }
            return { pids: [...pids], determined: true };
        } catch {
            return { pids: [], determined: false };
        }
    }
    if (process.platform === 'win32') return { pids: [], determined: false };
    try {
        const out = execFileSync('lsof', ['-t', '--', ...files], { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
        for (const l of out.split('\n')) { const n = Number(l.trim()); if (Number.isSafeInteger(n) && n > 0 && n !== process.pid) pids.add(n); }
        return { pids: [...pids], determined: true };
    } catch (err) {
        const e = err as NodeJS.ErrnoException & { status?: number | null; stdout?: string };
        if (e.status === 1 && !e.stdout) return { pids: [], determined: true }; // lsof: nothing has it open
        return { pids: [], determined: false };
    }
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const u = ['KiB', 'MiB', 'GiB', 'TiB'];
    let v = n / 1024; let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${u[i]}`;
}

function resolveTargets(opts: { loreDir?: string; home: string; workspace?: string }): Target[] {
    if (opts.loreDir) {
        const dir = path.resolve(opts.loreDir);
        const dbPath = path.join(dir, 'verbatim.sqlite');
        const lance = fs.existsSync(path.join(dir, 'lancedb'));
        const hasFile = fs.existsSync(dbPath);
        return [{ workspace: '(embedded)', dbPath, basePath: path.dirname(dir), engine: !hasFile && lance ? 'lance' : 'sqlite', hasFile }];
    }
    const registry = loadWorkspacesIfPresent(opts.home);
    if (!registry) {
        throw new Error(`no workspace registry (workspaces.json) found under ${opts.home}. Check LORE_HOME / --data-dir, or use --lore-dir for an embedded workspace.`);
    }
    let entries = registry.workspaces;
    if (opts.workspace) {
        entries = entries.filter((w) => w.name === opts.workspace);
        if (entries.length === 0) {
            throw new Error(`workspace_not_found: "${opts.workspace}" (known: ${registry.workspaces.map((w) => w.name).join(', ')})`);
        }
    }
    return entries.map((w) => {
        const dbPath = path.join(w.path, '.lore', 'verbatim.sqlite');
        return { workspace: w.name, dbPath, basePath: w.path, engine: w.vectorEngine === 'sqlite' ? 'sqlite' as const : 'lance' as const, hasFile: fs.existsSync(dbPath) };
    });
}

function planLines(r: TargetReport): string[] {
    const p = r.plan!;
    const lines = [
        `  rows ${p.totalRows} (${p.distinctIds} node ids); ${p.rowsToDelete} duplicate row(s) in ${p.runsCollapsed} run(s) across ${p.idsAffected} id(s); ~${fmtBytes(p.bytesEstimate)} of text+vectors`,
    ];
    if (p.sampleIds.length > 0) lines.push(`  most duplicated: ${p.sampleIds.slice(0, 5).map((s) => `${s.id} (${s.rows})`).join(', ')}`);
    return lines;
}

export async function verbatimReclaimCommand(args: string[]): Promise<void> {
    const parsed = parseOrExit('verbatim reclaim', args, {
        bool: ['--apply', '--vacuum', '--force', '--json'],
        value: ['--lore-dir', '--data-dir'],
        positionals: { min: 0, max: 1 },
    }, { usage: reclaimUsage });
    const apply = parsed.has('--apply');
    const vacuum = parsed.has('--vacuum');
    const force = parsed.has('--force');
    const json = parsed.has('--json');
    const loreDirArg = parsed.get('--lore-dir');
    const dataDir = dataDirFlag(parsed);
    const workspace = parsed.positionals[0];
    const say = json ? (m: string) => console.error(m) : (m: string) => console.log(m);
    const fail = (m: string): never => { console.error(`verbatim reclaim refused: ${m}`); return process.exit(1); };

    if (vacuum && !apply) fail('--vacuum only applies together with --apply');
    if (loreDirArg && (dataDir !== undefined || workspace)) fail('--lore-dir addresses one embedded workspace; do not combine it with --data-dir or a workspace name');
    if (loreDirArg && (!fs.existsSync(loreDirArg) || !fs.statSync(loreDirArg).isDirectory())) fail(`--lore-dir ${loreDirArg} does not exist or is not a directory`);
    if (dataDir !== undefined && (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory())) fail(`--data-dir ${dataDir} does not exist or is not a directory`);

    const home = dataDir !== undefined ? resolveLoreHome({ dataDir }) : loreHome();
    let targets: Target[];
    try {
        targets = resolveTargets({ loreDir: loreDirArg, home, workspace });
    } catch (e) {
        return fail((e as Error).message);
    }

    // Preflight every target BEFORE writing any of them.
    if (apply) {
        if (!loreDirArg && (await isDaemonServingHome(home)).servesHome) {
            console.error(daemonRefuseMessage('lore verbatim reclaim --apply'));
            process.exit(1);
        }
        for (const t of targets) {
            if (t.engine !== 'sqlite' || !t.hasFile) continue;
            const h = findSqliteHolders(t.dbPath);
            if (h.pids.length > 0) {
                fail(`${t.dbPath} is open in pid ${h.pids.join(', ')}. Stop that host (daemon / embedded app) first, then re-run. This is never bypassed by --force.`);
            }
            if (!h.determined && !force) {
                fail(`could not determine whether anything has ${t.dbPath} open (no lsof, or no permission). Stop every host yourself and re-run with --force.`);
            }
            const promo = readPromotionStateSafe(t.basePath);
            if (promo && !force) fail(`a LanceDB -> SQLite promotion is in progress for ${t.basePath} (state: ${promo}). Let it finish or recover first; --force overrides.`);
        }
        console.error('WARNING: back up each .lore/verbatim.sqlite before --apply. This deletes rows and cannot be undone.');
    }

    say(`  Home:      ${loreDirArg ? '(embedded --lore-dir)' : home}`);
    say(`  Mode:      ${apply ? 'APPLY' : 'DRY RUN (nothing is written; add --apply to delete)'}${vacuum ? ' + VACUUM' : ''}`);
    const reports: TargetReport[] = [];
    let failed = false;
    for (const t of targets) {
        const base = { workspace: t.workspace, dbPath: t.dbPath };
        if (t.engine === 'lance') {
            reports.push({ ...base, status: 'not_supported', message: 'not_supported: this workspace uses the LanceDB verbatim engine; reclaim covers SQLite stores only (use `lore verbatim dedupe` for duplicate ids)' });
            continue;
        }
        if (!t.hasFile) { reports.push({ ...base, status: 'no-store', message: `no SQLite verbatim store at ${t.dbPath}` }); continue; }
        const r = reclaimOne(t, apply, vacuum);
        if (r.status === 'applied' && r.message) failed = true;
        reports.push(r);
    }
    if (json) {
        console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', vacuum, targets: reports }, null, 2));
    } else {
        for (const r of reports) printReport(r, apply);
        const total = reports.reduce((n, r) => n + (r.plan?.rowsToDelete ?? 0), 0);
        console.log('');
        console.log(apply ? `Done. ${reports.reduce((n, r) => n + (r.deleted ?? 0), 0)} duplicate row(s) removed.`
            : (total > 0 ? `${total} duplicate row(s) removable. Stop the host, back up verbatim.sqlite, then re-run with --apply (add --vacuum to shrink the file).` : 'Nothing to reclaim.'));
    }
    if (failed) process.exitCode = 1;
}

function readPromotionStateSafe(basePath: string): string | null {
    try { return readPromotionState(basePath)?.state ?? null; } catch { return 'unreadable promotion.json'; }
}

function reclaimOne(t: Target, apply: boolean, vacuum: boolean): TargetReport {
    const base = { workspace: t.workspace, dbPath: t.dbPath };
    const db = openReclaimDb(t.dbPath, apply);
    try {
        const plan = scanReclaim(db);
        const { rows: _rows, ...summary } = plan;
        if (plan.rowsToDelete === 0) return { ...base, status: 'nothing-to-reclaim', plan: summary };
        if (!apply) return { ...base, status: 'planned', plan: summary, bytesBefore: sqliteFootprintBytes(t.dbPath).total };
        const before = sqliteFootprintBytes(t.dbPath).total;
        const canonBefore = canonicalRowCount(db);
        let res;
        try {
            res = applyReclaim(db, plan);
        } catch (e) {
            if (e instanceof ReclaimConflictError) return { ...base, status: 'applied', plan: summary, message: e.message, bytesBefore: before };
            throw e;
        }
        const problems: string[] = [];
        if (res.after.canonicalRows !== canonBefore) problems.push(`canonical row count changed (${canonBefore} -> ${res.after.canonicalRows})`);
        if (res.after.distinctIds !== plan.distinctIds) problems.push(`distinct node ids changed (${plan.distinctIds} -> ${res.after.distinctIds})`);
        if (res.after.remainingDeletable !== 0) problems.push(`${res.after.remainingDeletable} duplicate row(s) remain`);
        if (res.ftsIntegrity !== 'ok') problems.push(`FTS integrity check failed: ${res.ftsIntegrity}`);
        db.pragma('wal_checkpoint(TRUNCATE)');
        if (vacuum) { db.exec('VACUUM'); db.pragma('wal_checkpoint(TRUNCATE)'); }
        return {
            ...base, status: 'applied', plan: summary, deleted: res.deleted, bytesBefore: before,
            bytesAfter: sqliteFootprintBytes(t.dbPath).total, freelistBytesAfter: freelistBytes(db),
            vacuumed: vacuum, ftsIntegrity: res.ftsIntegrity,
            ...(problems.length > 0 ? { message: `post-apply verification FAILED: ${problems.join('; ')}` } : {}),
        };
    } finally {
        try { db.close(); } catch { /* best effort */ }
    }
}

function printReport(r: TargetReport, apply: boolean): void {
    console.log('');
    console.log(`Workspace '${r.workspace}' (${r.dbPath})`);
    if (r.status === 'not_supported' || r.status === 'no-store') { console.log(`  ${r.message}`); return; }
    for (const l of planLines(r)) console.log(l);
    if (r.status === 'nothing-to-reclaim') { console.log('  nothing to reclaim'); return; }
    if (r.status === 'planned') { console.log(`  file on disk: ${fmtBytes(r.bytesBefore ?? 0)} (dry run: unchanged)`); return; }
    console.log(`  deleted ${r.deleted ?? 0} row(s)`);
    console.log(`  file on disk: ${fmtBytes(r.bytesBefore ?? 0)} -> ${fmtBytes(r.bytesAfter ?? 0)}${r.vacuumed ? ' (vacuumed)' : `; ${fmtBytes(r.freelistBytesAfter ?? 0)} is free inside the file and is reused by later writes (re-run with --vacuum to shrink it)`}`);
    console.log(`  verified: canonical rows and node ids unchanged, FTS index ${r.ftsIntegrity === 'ok' ? 'consistent' : 'INCONSISTENT'}`);
    if (r.message) console.log(`  ERROR: ${r.message}`);
}
