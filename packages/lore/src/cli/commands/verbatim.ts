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

export async function verbatimCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub === 'dedupe') {
        await verbatimDedupeCommand(args.slice(1));
        return;
    }
    if (sub !== 'reap') {
        console.error('usage: lore verbatim reap [--apply] [--prefix <prefix>]');
        console.error('       Default prefix: lore: (reap orphaned LoreNode embeddings)');
        console.error('       lore verbatim dedupe <workspace> [--data-dir <path>] [--apply] [--json]');
        console.error('       Check / clean duplicate canonical ids in a workspace\'s LanceDB verbatim table');
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
