#!/usr/bin/env tsx
/**
 * test/readiness335-upgrade-from-334-e2e.ts - 3.35.0 readiness: a home written by the v3.34.0 daemon opens cleanly
 * with this build.
 *
 *   1. UPGRADE_FROM_DIR (a v3.34.0 checkout; default: <scratch>/v334 next to the repo's scratchpad, or set
 *      LORE_V334_DIR) runs its own daemon source on a fresh home: 12 single writes + a 150-node bulk, then the
 *      daemon is SIGKILLed right after the bulk is acknowledged, so the embed outbox rows are (normally) still unreplicated.
 *   2. The on-disk schemas (graph / verbatim / outbox sqlite files) are snapshotted read-only.
 *   3. THIS build boots on the same home: its migrations run (schema is a superset of the old one; outbox gains the
 *      3.35 columns), every v3.34.0 node is readable with its original content and revision, the leftover outbox rows
 *      replicate (depth 0, 0 dead rows), semantic recall works over vectors that include the replayed ones, an
 *      ifRevision write against an OLD node honours its migrated revision, and /ready is 200.
 *
 * Skips (exit 0, says so) when no v3.34.0 checkout is available. node_modules is shared with this repo (no dependency
 * changed between the tags), so the old checkout needs no install or build: the daemon runs from source via tsx.
 * Run: LORE_V334_DIR=<v3.34.0 worktree> npx tsx test/readiness335-upgrade-from-334-e2e.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { cleanup } from './helpers/live-daemon.js';
import { apiFor, bootDaemon, listFiles, makeChecker, stopDaemon, waitFor, waitOutboxDrained } from './helpers/readiness335.js';

const { check, finish } = makeChecker('3.35.0 readiness: upgrade from a v3.34.0 home');
const OLD = process.env['LORE_V334_DIR'] ?? '';
if (!OLD || !fs.existsSync(path.join(OLD, 'packages/lore/src/mcp/server.ts'))) {
    console.log('  skip (set LORE_V334_DIR to a v3.34.0 checkout: git worktree add --detach <dir> v3.34.0)');
    process.exit(0);
}
const SINGLE = 12, BULK = 150;
const NODE_IDS = [...Array.from({ length: SINGLE }, (_, i) => `up-single-${i}`), ...Array.from({ length: BULK }, (_, i) => `up-bulk-${i}`)];

type Schema = Record<string, string[]>; // "<file>:<table>" -> columns
function snapshot(home: string): { schema: Schema; userVersions: Record<string, number>; outboxByStatus: Record<string, number> } {
    const schema: Schema = {}, userVersions: Record<string, number> = {}, outboxByStatus: Record<string, number> = {};
    for (const rel of listFiles(home).filter((f) => f.endsWith('.sqlite'))) {
        const file = path.join(home, rel);
        let db: InstanceType<typeof Database> | undefined;
        try {
            db = new Database(file, { readonly: true, fileMustExist: true });
            userVersions[path.basename(rel)] = Number(db.pragma('user_version', { simple: true }));
            for (const t of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>) {
                schema[`${path.basename(rel)}:${t.name}`] = (db.prepare(`PRAGMA table_info("${t.name}")`).all() as Array<{ name: string }>).map((c) => c.name).sort();
            }
            if (path.basename(rel) === 'outbox.sqlite') {
                for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM outbox_entries GROUP BY status').all() as Array<{ status: string; n: number }>) outboxByStatus[r.status] = r.n;
            }
        } catch { /* a locked / non-sqlite file is simply not part of the snapshot */ } finally { db?.close(); }
    }
    return { schema, userVersions, outboxByStatus };
}

async function main(): Promise<void> {
    let h = await bootDaemon({ repoRoot: OLD });
    const home = h.home;
    try {
        let api = apiFor(h);
        // sanity: this really is the old daemon
        const hz = await api.get('/health', false);
        check('old daemon is v3.34.0', JSON.stringify(hz.body ?? hz.text).includes('3.34.0') || fs.readFileSync(path.join(OLD, 'package.json'), 'utf8').includes('"version": "3.34.0"'), hz.text.slice(0, 160));

        for (let i = 0; i < SINGLE; i++) {
            const r = await api.post('/api/node', {
                id: `up-single-${i}`, type: 'decision', label: `Single ${i}`, workspace: 'default',
                content: i === 0 ? 'Retry failed uploads with exponential backoff and random jitter so clients do not stampede the server.' : `Plain fixture ${i} about cache invalidation after deploys.`,
            });
            check(`v3.34.0 single write ${i} acknowledged`, r.status === 200 || r.status === 201, `${r.status} ${r.text.slice(0, 160)}`);
        }
        const bulk = await api.post('/api/nodes/bulk', {
            workspace: 'default',
            nodes: Array.from({ length: BULK }, (_, i) => ({ id: `up-bulk-${i}`, type: 'note', label: `Bulk ${i}`, content: `bulk fixture ${i}: quarterly capacity planning notes, batch ${i % 7}` })),
        });
        check(`v3.34.0 bulk of ${BULK} acknowledged`, bulk.status === 200 && bulk.body?.succeeded === BULK, bulk.text.slice(0, 200));
        await stopDaemon(h, 'SIGKILL'); // crash before the embed outbox drains
        const before = snapshot(home);
        const pendingBefore = Object.entries(before.outboxByStatus).filter(([s]) => s !== 'completed').reduce((a, [, n]) => a + n, 0);
        console.log(`  info  v3.34.0 outbox rows by status at SIGKILL: ${JSON.stringify(before.outboxByStatus)}`);
        check('v3.34.0 left unreplicated outbox rows behind (the upgrade has work to replay)', pendingBefore > 0, JSON.stringify(before.outboxByStatus));
        check('old home has graph + verbatim + outbox sqlite files', ['graph.sqlite', 'verbatim.sqlite', 'outbox.sqlite'].every((f) => Object.keys(before.userVersions).includes(f)), Object.keys(before.userVersions).join(','));

        // --- open the same home with THIS build ---
        h = await bootDaemon({ home });
        api = apiFor(h);
        const after = snapshot(home);
        const dropped: string[] = [], added: string[] = [];
        for (const [t, cols] of Object.entries(before.schema)) {
            const now = after.schema[t];
            if (!now) { dropped.push(`${t} (table gone)`); continue; }
            for (const c of cols) if (!now.includes(c)) dropped.push(`${t}.${c}`);
            for (const c of now) if (!cols.includes(c)) added.push(`${t}.${c}`);
        }
        console.log(`  info  columns added by the 3.35 migrations: ${added.join(', ') || '(none)'}`);
        check('migrations never drop a table or column the old build had', dropped.length === 0, dropped.join(', '));
        check('migrations ran: this build added schema (e.g. outbox 3.35 columns)', added.length > 0 || JSON.stringify(before.userVersions) !== JSON.stringify(after.userVersions), JSON.stringify({ before: before.userVersions, after: after.userVersions }));

        const health = await waitOutboxDrained(api, 120_000);
        check('leftover v3.34.0 outbox rows replicated: depth 0, 0 dead rows', health.outbox?.depth === 0 && (health.outbox?.dead ?? 0) === 0, JSON.stringify(health.outbox));
        const rd = await api.get('/ready', false);
        check('/ready -> 200 on the upgraded home', rd.status === 200 && rd.body?.status === 'ready', rd.text);

        const stats = await api.get('/api/stats?workspace=default');
        check(`stats nodeCount = ${NODE_IDS.length}`, stats.body?.nodeCount === NODE_IDS.length, stats.text.slice(0, 200));
        let missing = 0, badBody = 0;
        for (const id of NODE_IDS) {
            const r = await api.get(`/api/node-full?id=${id}&workspace=default`);
            if (r.status !== 200 || r.body?.found !== true) { missing++; continue; }
            if (id.startsWith('up-bulk-') && !String(r.body?.content).includes('quarterly capacity planning')) badBody++;
            if (id === 'up-single-0' && !String(r.body?.content).includes('exponential backoff')) badBody++;
        }
        check(`all ${NODE_IDS.length} v3.34.0 nodes readable with original content`, missing === 0 && badBody === 0, `missing=${missing} badBody=${badBody}`);
        const kw = await api.get(`/api/search?q=${encodeURIComponent('stampede')}&workspace=default`);
        check('keyword search finds v3.34.0 data', kw.text.includes('up-single-0'));
        const rec = await waitFor(async () => {
            const rr = await api.get(`/api/recall?topic=${encodeURIComponent('resending broken file transfers progressively slower')}&workspace=default`);
            return rr.status === 200 && rr.body?.hits?.[0]?.id === 'up-single-0';
        }, 60_000, 'semantic recall over upgraded vectors').catch(() => false);
        check('semantic recall (keyword-proof query) ranks the v3.34.0 node first', rec === true);

        // revisions written by 3.34.0 are honoured by the 3.35 conditional-write path
        const stale = await api.post('/api/node', { id: 'up-single-3', type: 'decision', label: 'Single 3', workspace: 'default', content: 'edited with stale rev', ifRevision: 99 });
        const rev = Number(stale.body?.currentRevision);
        check('ifRevision with a wrong revision -> 409 revision_mismatch exposing the v3.34.0 node revision', stale.status === 409 && stale.body?.code === 'revision_mismatch' && Number.isInteger(rev) && rev >= 1, `${stale.status} ${stale.text.slice(0, 200)}`);
        const good = await api.post('/api/node', { id: 'up-single-3', type: 'decision', label: 'Single 3', workspace: 'default', content: 'edited after upgrade', ifRevision: rev });
        check('ifRevision with the migrated revision -> 2xx', good.status === 200 || good.status === 201, `${good.status} ${good.text.slice(0, 200)}`);
        const probe = await api.post('/api/node', { id: 'up-single-3', type: 'decision', label: 'Single 3', workspace: 'default', content: 'probe', ifRevision: 99 });
        check('the revision advanced by exactly one', probe.status === 409 && probe.body?.currentRevision === rev + 1, probe.text.slice(0, 200));
        const gone = await api.get('/api/node-full?id=up-single-3&workspace=default');
        check('the edit landed', String(gone.body?.content).includes('edited after upgrade'));
        const fresh = await api.post('/api/node', { id: 'up-new-1', type: 'note', label: 'new', workspace: 'default', content: 'written by the new build' });
        check('a new write on the upgraded home lands', fresh.status === 200 || fresh.status === 201, fresh.text.slice(0, 160));
        const h2 = await waitOutboxDrained(api, 60_000);
        check('outbox still clean after post-upgrade writes', h2.outbox?.depth === 0 && (h2.outbox?.dead ?? 0) === 0, JSON.stringify(h2.outbox));
    } catch (err) {
        check('suite ran without throwing', false, (err as Error).stack ?? String(err));
        console.error(`--- daemon log tail ---\n${h.log.text.slice(-2500)}`);
    } finally {
        cleanup(h);
    }
    finish();
}
await main();
