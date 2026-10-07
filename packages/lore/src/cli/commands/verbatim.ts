import fs from 'fs';
import http from 'http';
import { isRevisionHistoryId } from '../../engines/verbatimHistory.js';
import * as path from 'node:path';
import { loreHome, loreHomePath, resolveLoreHome } from '../../config/loreHome.js';
import { openGraphForCli } from './shared.js';
import { DEFAULT_PORT } from './migrateWorkspaceToWorkspaceShared.js';
import { parseOrExit, dataDirFlag } from '../args.js';
import { assertWorkspaceTarget } from '../targetGuard.js';

interface ReapResponse {
    prefix: string;
    apply: boolean;
    inspected: number;
    alive: number;
    orphans: number;
    tombstoned: number;
    sample: string[];
}

async function tryHttpReap(prefix: string, apply: boolean): Promise<ReapResponse | null> {
    let token: string | null = null;
    try {
        token = fs.readFileSync(loreHomePath('auth.token'), 'utf-8').trim();
    } catch {
        return null;
    }
    if (!token) return null;
    return new Promise((resolve) => {
        const payload = JSON.stringify({ apply, prefix });
        const req = http.request(
            `http://127.0.0.1:${DEFAULT_PORT}/api/verbatim/reap`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload).toString(),
                    'Authorization': `Bearer ${token}`,
                },
                timeout: 30_000,
            },
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    resolve(null);
                    return;
                }
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(body) as ReapResponse); } catch { resolve(null); }
                });
            },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(payload);
        req.end();
    });
}

function dedupeUsage(): void {
    console.error('usage: lore verbatim dedupe <workspace> [--data-dir <path>] [--apply] [--json]');
    console.error('');
    console.error('  Check (default) or clean duplicate canonical ids in a workspace\'s LanceDB');
    console.error('  lore_verbatim table. Report-only unless --apply; writes nothing without it.');
    console.error('  --apply            Offline only. Backs up first, then for each group of copies with');
    console.error('                     IDENTICAL content keeps the newest and removes the rest. Groups');
    console.error('                     whose copies differ are reported, never touched (exit 1).');
    console.error('                     Copies are identical only when content hash, full text,');
    console.error('                     security_scopes, type, label, tags, project and ecosystem all match');
    console.error('                     (a live row and its tombstoned twin differ).');
    console.error('                     CLOSE every app that embeds Lore on this data dir (Atlas, MIRA,');
    console.error('                     PM Helper) first: the command cannot detect them. It re-checks each');
    console.error('                     chunk just before deleting and aborts if another writer changed it.');
    console.error('  --data-dir <path>  Target an embedded host\'s createLore({ dataDir }) root instead of');
    console.error('                     LORE_HOME. Must hold a workspaces.json naming <workspace>.');
    console.error('  --json             Print the report as JSON.');
    console.error('  #rev history rows are never touched. Unknown flags are rejected.');
}

const GROUP_LIST_MAX = 50;

async function verbatimDedupeCommand(args: string[]): Promise<void> {
    const parsed = parseOrExit('verbatim dedupe', args, {
        bool: ['--apply', '--json'],
        value: ['--data-dir'],
        positionals: { min: 1, max: 1 },
    }, { usage: dedupeUsage });
    const workspaceName = parsed.positionals[0]!;
    const apply = parsed.has('--apply');
    const json = parsed.has('--json');
    const dataDir = dataDirFlag(parsed);
    // Human text goes to stdout; in --json mode stdout carries ONLY the JSON document.
    const say = json ? (m: string) => console.error(m) : (m: string) => console.log(m);

    if (dataDir !== undefined && (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory())) {
        console.error(`verbatim dedupe failed: --data-dir ${dataDir} does not exist or is not a directory`);
        process.exit(1);
    }
    const home = dataDir !== undefined ? resolveLoreHome({ dataDir }) : loreHome();
    say(`  Home:      ${home}${dataDir !== undefined ? ' (from --data-dir)' : ''}`);
    say(`  Registry:  ${path.join(home, 'workspaces.json')}`);
    if (apply) {
        // Same pre-write assertion as migrate-vectors: registry exists, names the workspace,
        // and (with --data-dir) places it inside that root.
        try {
            assertWorkspaceTarget({ home, workspaceName, dataDirGiven: dataDir !== undefined });
        } catch (error) {
            console.error(`verbatim dedupe refused: ${(error as Error).message}`);
            process.exit(1);
        }
    }
    if (apply) {
        // Embedded hosts run Lore in-process, so the daemon preflight cannot see them. Always on stderr (stdout is JSON-only in --json mode).
        console.error('WARNING: close every app that embeds Lore on this data dir (Atlas, MIRA, PM Helper) before running --apply; this command cannot detect them. '
            + 'A concurrent write is caught only by a re-check just before each delete, which then aborts the run.');
    }
    const backupOutDir = path.join(home, 'verbatim-dedupe-backups');

    const { dedupeVerbatimIdentical } = await import('../../engines/verbatimDedupe.js');
    let r;
    try {
        r = await dedupeVerbatimIdentical({ workspaceName, home, apply, backupOutDir });
    } catch (error) {
        console.error(`verbatim dedupe failed: ${(error as Error).message}`);
        process.exit(1);
    }

    const differing = r.scan?.differingGroups ?? 0;
    if (json) {
        console.log(JSON.stringify(r, null, 2));
        if (differing > 0) process.exitCode = 1;
        return;
    }
    console.log('');
    if (r.message) {
        console.log(r.message);
        return;
    }
    const scan = r.scan!;
    console.log(`Verbatim duplicate check: '${workspaceName}'${apply ? ' (APPLY)' : ' (report only — nothing is written)'}`);
    console.log(`  Rows:              ${scan.totalRows} (${scan.historyRows} #rev history, never touched)`);
    console.log(`  Distinct ids:      ${scan.distinctIds}`);
    console.log(`  Identical groups:  ${scan.identicalGroups} (${scan.extraRows} extra row(s) removable)`);
    console.log(`  Differing groups:  ${scan.differingGroups} (${scan.differingExtraRows} extra row(s), never touched)`);
    if (scan.groups.length > 0) {
        console.log('');
        for (const g of scan.groups.slice(0, GROUP_LIST_MAX)) {
            console.log(`  ${g.identical ? 'identical' : 'DIFFERING'}  ${g.copies} copies  ${g.identical ? `keep updatedAt ${g.keptUpdatedAt || '(none)'}` : 'not touched'}  ${g.id}`);
        }
        if (scan.groups.length > GROUP_LIST_MAX) console.log(`  … and ${scan.groups.length - GROUP_LIST_MAX} more group(s) (use --json for all)`);
    }
    console.log('');
    if (r.status === 'applied') {
        console.log(`  Backup:            ${r.backup!.tarballPath}`);
        console.log(`  Fixed:             ${r.groupsFixed} group(s), ${r.rowsRemoved} row(s) removed`);
        console.log(`  Verified:          0 identical groups remain; ${r.rescan!.distinctIds} distinct ids (unchanged); ${r.rescan!.historyRows} history rows (unchanged)`);
    } else if (scan.identicalGroups > 0) {
        console.log('Re-run with --apply to remove the extra identical copies (a backup is taken first; stop the daemon / embedding host first).');
    } else if (scan.groups.length === 0) {
        console.log('No duplicate ids.');
    }
    if (differing > 0) {
        console.error(`${differing} group(s) have copies that DIFFER — not touched. Resolve those by hand (keep one version of each), then re-run.`);
        process.exitCode = 1;
    }
}

function checkScopesUsage(): void {
    console.error('usage: lore verbatim check-scopes <workspace> [--data-dir <path>] [--json]');
    console.error('');
    console.error('  Read-only report of verbatim rows whose security_scopes were damaged by the');
    console.error('  pre-3.28.0 writer (history, #rev and tombstone rows stored as [\'undefined\', ...]).');
    console.error('  Works on LanceDB and SQLite workspaces. Writes nothing and repairs nothing; the');
    console.error('  damage is fail-closed (the affected rows match no principal).');
    console.error('  --data-dir <path>  Target an embedded host\'s createLore({ dataDir }) root instead of');
    console.error('                     LORE_HOME. Must hold a workspaces.json naming <workspace>.');
    console.error('  --json             Print the report as JSON.');
    console.error('  Exit code is 0 when the check completes; unknown flags are rejected.');
}

async function verbatimCheckScopesCommand(args: string[]): Promise<void> {
    const parsed = parseOrExit('verbatim check-scopes', args, {
        bool: ['--json'],
        value: ['--data-dir'],
        positionals: { min: 1, max: 1 },
    }, { usage: checkScopesUsage });
    const workspaceName = parsed.positionals[0]!;
    const json = parsed.has('--json');
    const dataDir = dataDirFlag(parsed);

    if (dataDir !== undefined && (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory())) {
        console.error(`verbatim check-scopes failed: --data-dir ${dataDir} does not exist or is not a directory`);
        process.exit(1);
    }
    const home = dataDir !== undefined ? resolveLoreHome({ dataDir }) : loreHome();
    try {
        assertWorkspaceTarget({ home, workspaceName, dataDirGiven: dataDir !== undefined });
    } catch (error) {
        console.error(`verbatim check-scopes refused: ${(error as Error).message}`);
        process.exit(1);
    }

    // Read-only: no daemon preflight (same as `dedupe` in report mode).
    const { checkVerbatimScopes, SCOPE_ROW_KINDS } = await import('../../engines/verbatimCheckScopes.js');
    let r;
    try {
        r = await checkVerbatimScopes({ workspaceName, home });
    } catch (error) {
        console.error(`verbatim check-scopes failed: ${(error as Error).message}`);
        process.exit(1);
    }
    if (json) {
        console.log(JSON.stringify(r, null, 2));
        return;
    }
    console.log(`  Home:      ${home}${dataDir !== undefined ? ' (from --data-dir)' : ''}`);
    console.log(`  Registry:  ${r.registryPath}`);
    console.log('');
    if (r.message) {
        console.log(r.message);
        return;
    }
    console.log(`Verbatim scope check: '${workspaceName}' (${r.engine}, report only — nothing is written)`);
    console.log(`  Rows:              ${r.totalRows}`);
    console.log(`  OK:                ${r.totals.ok}`);
    console.log(`  All 'undefined':   ${r.totals.all_undefined}`);
    console.log(`  Mixed 'undefined': ${r.totals.mixed_undefined}`);
    if (r.totals.unreadable > 0) console.log(`  Unreadable:        ${r.totals.unreadable}`);
    console.log('');
    for (const k of SCOPE_ROW_KINDS) {
        const c = r.byKind[k];
        console.log(`  ${k.replace('_', ' ').padEnd(20)} ${c.total} row(s): ${c.ok} ok, ${c.all_undefined} all-undefined, ${c.mixed_undefined} mixed${c.unreadable > 0 ? `, ${c.unreadable} unreadable` : ''}`);
    }
    for (const cls of ['all_undefined', 'mixed_undefined', 'unreadable'] as const) {
        const ids = r.samples[cls];
        if (ids.length === 0) continue;
        console.log('');
        console.log(`Sample ids, ${cls} (first ${ids.length} of ${r.totals[cls]}):`);
        for (const id of ids) console.log(`  - ${id}`);
    }
    console.log('');
    const damaged = r.totals.all_undefined + r.totals.mixed_undefined;
    console.log(damaged > 0
        ? `${damaged} row(s) carry damaged scopes. They match no principal (fail-closed). This command repairs nothing.`
        : 'No damaged scopes found.');
}

function repairScopesUsage(): void {
    console.error('usage: lore verbatim repair-scopes <workspace> [--data-dir <path>] [--apply] [--json]');
    console.error('');
    console.error('  Restore the ORIGINAL security_scopes of rows damaged by the pre-3.28.0 writer');
    console.error('  (history, #rev and tombstone rows stored as [\'undefined\', ...]), but ONLY where the');
    console.error('  original is provable from the node version log (versions.sqlite): same node, the');
    console.error('  row\'s updatedAt equals one version\'s updatedAt, identical scopes in every matching');
    console.error('  version, and the same number of scopes as damaged entries. A tombstone takes the');
    console.error('  scopes of its same-instant #rev sibling. Everything else is left untouched');
    console.error('  (fail-closed); a canonical row\'s current scopes are never copied onto an old row.');
    console.error('  Mixed and unreadable rows are never touched. Works on LanceDB and SQLite workspaces.');
    console.error('  Default is a dry run: per damaged row a verdict (restorable or why not), counts and');
    console.error('  sample row ids. No scope value and no row text is ever printed. Writes nothing.');
    console.error('  --apply            Offline only. Backs up first, then writes ONLY the security_scopes');
    console.error('                     column of the restorable rows (text, vectors, updatedAt and the row');
    console.error('                     count never change) and re-scans to prove it. CLOSE every app that');
    console.error('                     embeds Lore on this data dir (Atlas, MIRA, PM Helper) first: the');
    console.error('                     command cannot detect them; each chunk is re-read just before it is');
    console.error('                     written and the run aborts if another writer changed a row.');
    console.error('  --data-dir <path>  Target an embedded host\'s createLore({ dataDir }) root instead of');
    console.error('                     LORE_HOME. Must hold a workspaces.json naming <workspace>.');
    console.error('  --json             Print the report as JSON.');
    console.error('  Unknown flags are rejected.');
}

async function verbatimRepairScopesCommand(args: string[]): Promise<void> {
    const parsed = parseOrExit('verbatim repair-scopes', args, {
        bool: ['--apply', '--json'],
        value: ['--data-dir'],
        positionals: { min: 1, max: 1 },
    }, { usage: repairScopesUsage });
    const workspaceName = parsed.positionals[0]!;
    const apply = parsed.has('--apply');
    const json = parsed.has('--json');
    const dataDir = dataDirFlag(parsed);
    // Human text goes to stdout; in --json mode stdout carries ONLY the JSON document.
    const say = json ? (m: string) => console.error(m) : (m: string) => console.log(m);

    if (dataDir !== undefined && (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory())) {
        console.error(`verbatim repair-scopes failed: --data-dir ${dataDir} does not exist or is not a directory`);
        process.exit(1);
    }
    const home = dataDir !== undefined ? resolveLoreHome({ dataDir }) : loreHome();
    try {
        assertWorkspaceTarget({ home, workspaceName, dataDirGiven: dataDir !== undefined });
    } catch (error) {
        console.error(`verbatim repair-scopes refused: ${(error as Error).message}`);
        process.exit(1);
    }
    say(`  Home:      ${home}${dataDir !== undefined ? ' (from --data-dir)' : ''}`);
    say(`  Registry:  ${path.join(home, 'workspaces.json')}`);
    if (apply) {
        // Embedded hosts run Lore in-process, so the daemon preflight cannot see them. Always on stderr (stdout is JSON-only in --json mode).
        console.error('WARNING: close every app that embeds Lore on this data dir (Atlas, MIRA, PM Helper) before running --apply; this command cannot detect them. '
            + 'A concurrent write is caught only by a re-check just before each write, which then aborts the run.');
    }
    const backupOutDir = path.join(home, 'verbatim-repair-scopes-backups');

    const { repairVerbatimScopes, REPAIR_VERDICTS } = await import('../../engines/verbatimRepairScopes.js');
    let r;
    try {
        r = await repairVerbatimScopes({ workspaceName, home, apply, backupOutDir });
    } catch (error) {
        console.error(`verbatim repair-scopes failed: ${(error as Error).message}`);
        process.exit(1);
    }
    if (json) {
        console.log(JSON.stringify(r, null, 2));
        return;
    }
    console.log('');
    if (r.message) {
        console.log(r.message);
        return;
    }
    console.log(`Verbatim scope repair: '${workspaceName}' (${r.engine}, ${apply ? 'APPLY' : 'dry run — nothing is written'})`);
    console.log(`  Rows:              ${r.totalRows}`);
    console.log(`  All 'undefined':   ${r.totals.all_undefined}`);
    console.log(`  Mixed 'undefined': ${r.totals.mixed_undefined} (never touched)`);
    if (r.totals.unreadable > 0) console.log(`  Unreadable:        ${r.totals.unreadable} (never touched)`);
    console.log(`  Version logs read: ${r.versionLog.files.length}${r.versionLog.files.length === 0 ? ' (none found: nothing can be proven)' : ''}`);
    console.log('');
    console.log('Verdict per all-undefined row:');
    for (const v of REPAIR_VERDICTS) {
        if (r.verdicts[v] === 0) continue;
        console.log(`  ${v.padEnd(26)} ${r.verdicts[v]}`);
    }
    for (const v of REPAIR_VERDICTS) {
        const ids = r.samples[v];
        if (ids.length === 0) continue;
        console.log('');
        console.log(`Sample ids, ${v} (first ${ids.length} of ${r.verdicts[v]}):`);
        for (const id of ids) console.log(`  - ${id}`);
    }
    console.log('');
    if (r.status === 'applied') {
        console.log(`  Backup:            ${r.backup!.tarballPath}`);
        console.log(`  Restored:          ${r.restored} row(s)`);
        console.log(`  Verified:          ${r.verified!.totalRows} rows (count unchanged); every other row byte-identical; ${r.verified!.remainingAllUndefined} row(s) still all-undefined (left as they were)`);
    } else if (r.verdicts.restorable > 0) {
        console.log(`${r.verdicts.restorable} row(s) are provably restorable. Re-run with --apply to restore them (a backup is taken first; stop the daemon and close embedding hosts first).`);
    } else if (r.totals.all_undefined === 0) {
        console.log('No damaged scopes found.');
    } else {
        console.log('Nothing is provably restorable. The damaged rows stay as they are (fail-closed).');
    }
}

export async function verbatimCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub === 'dedupe') {
        await verbatimDedupeCommand(args.slice(1));
        return;
    }
    if (sub === 'check-scopes') {
        await verbatimCheckScopesCommand(args.slice(1));
        return;
    }
    if (sub === 'repair-scopes') {
        await verbatimRepairScopesCommand(args.slice(1));
        return;
    }
    if (sub !== 'reap') {
        console.error('usage: lore verbatim reap [--apply] [--prefix <prefix>]');
        console.error('       Default prefix: lore: (reap orphaned LoreNode embeddings)');
        console.error('       lore verbatim dedupe <workspace> [--data-dir <path>] [--apply] [--json]');
        console.error('       Check / clean duplicate canonical ids in a workspace\'s LanceDB verbatim table');
        console.error('       lore verbatim check-scopes <workspace> [--data-dir <path>] [--json]');
        console.error('       Read-only report of rows whose security_scopes were damaged as [\'undefined\', ...] (Lance or SQLite)');
        console.error('       lore verbatim repair-scopes <workspace> [--data-dir <path>] [--apply] [--json]');
        console.error('       Restore those scopes where the node version log proves the original (dry run by default; --apply is offline, backed up)');
        process.exit(1);
    }
    const parsed = parseOrExit('verbatim reap', args.slice(1), {
        bool: ['--apply'],
        value: ['--prefix'],
    }, { usage: () => console.error('usage: lore verbatim reap [--apply] [--prefix <prefix>]') });
    const apply = parsed.has('--apply');
    const prefix = parsed.get('--prefix') ?? 'lore:';

    console.log('');
    console.log(`Verbatim reaper`);
    console.log(`  Prefix:   ${prefix}`);
    console.log(`  Mode:     ${apply ? 'APPLY' : 'DRY-RUN (use --apply to tombstone)'}`);
    console.log('');

    const httpResult = await tryHttpReap(prefix, apply);
    if (httpResult) {
        console.log(`Inspected ${httpResult.inspected} verbatim records with prefix "${prefix}"...`);
        console.log('');
        console.log(`  Alive:   ${httpResult.alive} verbatim records have a matching graph node`);
        console.log(`  Orphan:  ${httpResult.orphans} verbatim records with NO matching node`);
        console.log('');
        if (httpResult.orphans > 0) {
            console.log('Orphan samples (first 20):');
            for (const o of httpResult.sample) console.log(`  - ${o}`);
            if (httpResult.orphans > httpResult.sample.length) {
                console.log(`  ... and ${httpResult.orphans - httpResult.sample.length} more`);
            }
            console.log('');
        }
        if (apply && httpResult.tombstoned > 0) {
            console.log(`Done. ${httpResult.tombstoned} orphan embeddings tombstoned (content preserved, marked superseded).`);
        } else if (!apply && httpResult.orphans > 0) {
            console.log('Dry-run complete. Re-run with --apply to tombstone these rows (content preserved).');
        } else {
            console.log('No action needed.');
        }
        console.log('');
        console.log(`(Routed through the running Lore daemon at 127.0.0.1:${DEFAULT_PORT}.)`);
        return;
    }

    const basePath = loreHome();
    // Finding 11 (round E) — the HTTP attempt above already tried the
    // daemon; this direct-open fallback is what used to sit in the ~15s
    // openSurreal retry storm. tryHttpReap() above now resolves
    // DEFAULT_PORT (LORE_PORT-aware) instead of a hardcoded 3847, so this
    // fallback fires only when the HTTP attempt genuinely misses the daemon
    // (missing/stale auth token, daemon down, timeout). Refuse fast with a
    // clear message instead of the raw driver error.
    const graph = await openGraphForCli(basePath);
    const { VerbatimStore } = await import('../../engines/verbatimStore.js');
    const verbatim = new VerbatimStore(basePath);

    await verbatim.initialize();

    const allIds = await verbatim.listIds(prefix);
    console.log(`Inspecting ${allIds.length} verbatim records with prefix "${prefix}"...`);

    const orphans: string[] = [];
    let alive = 0;
    for (const verbatimId of allIds) {
        // Anchored suffix match (audit 5.6) — an id merely CONTAINING
        // '#rev' (URL fragment etc.) is a canonical row, not a snapshot.
        if (isRevisionHistoryId(verbatimId)) continue;
        // Only `lore:`-prefixed rows are graph-node-derived, so only they
        // can be orphans of the graph. Bare ids (e.g. the content-hash ids
        // store_verbatim's docs recommend) and namespaced ids belong to
        // the direct-write caller — audit cluster 5 (2026-08-17): bare ids
        // used to fall through to getNode → null → false "orphan".
        if (!verbatimId.startsWith('lore:')) { alive++; continue; }
        const nodeId = verbatimId.slice('lore:'.length);
        const node = await graph.getNode(nodeId);
        if (node == null) orphans.push(verbatimId);
        else alive++;
    }

    console.log('');
    console.log(`  Alive:   ${alive} verbatim records have a matching graph node`);
    console.log(`  Orphan:  ${orphans.length} verbatim records with NO matching node`);
    console.log('');

    if (orphans.length > 0) {
        console.log('Orphan samples (first 20):');
        for (const o of orphans.slice(0, 20)) console.log(`  - ${o}`);
        if (orphans.length > 20) console.log(`  ... and ${orphans.length - 20} more`);
        console.log('');
    }

    if (apply && orphans.length > 0) {
        console.log(`Tombstoning ${orphans.length} orphan embedding(s)...`);
        let tombstoned = 0;
        let failed = 0;
        for (const id of orphans) {
            // 1.M10 — tombstone() now throws on real failures; isolate per
            // row so one failure neither aborts the reap nor reads as success.
            try {
                await verbatim.tombstone(id, 'graph node missing — discovered via verbatim reap');
                tombstoned++;
            } catch (err) {
                failed++;
                console.error(`  FAILED ${id}: ${(err as Error).message}`);
            }
        }
        console.log(`Done. ${tombstoned} orphan embeddings tombstoned (content preserved, marked superseded).`);
        if (failed > 0) {
            console.error(`${failed} tombstone(s) FAILED — rows left live in the index; re-run to retry.`);
            process.exitCode = 1;
        }
    } else if (!apply && orphans.length > 0) {
        console.log('Dry-run complete. Re-run with --apply to tombstone these rows (content preserved).');
    } else {
        console.log('No action needed.');
    }

    await graph.close();
}
