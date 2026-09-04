import fs from 'fs';
import http from 'http';
import { isRevisionHistoryId } from '../../engines/verbatimHistory.js';
import { loreHome, loreHomePath } from '../../config/loreHome.js';
import { openGraphForCli } from './shared.js';
import { DEFAULT_PORT } from './migrateWorkspaceToWorkspaceShared.js';

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

export async function verbatimCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub !== 'reap') {
        console.error('usage: lore verbatim reap [--apply] [--prefix <prefix>]');
        console.error('       Default prefix: lore: (reap orphaned LoreNode embeddings)');
        process.exit(1);
    }
    const apply = args.includes('--apply');
    const prefixIdx = args.indexOf('--prefix');
    const prefix = prefixIdx >= 0 ? args[prefixIdx + 1] : 'lore:';

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
