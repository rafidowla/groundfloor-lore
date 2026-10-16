#!/usr/bin/env tsx
/**
 * test/readiness335-sqlite-default-e2e.ts - 3.35.0 readiness: the DEFAULT engine (SQLite) end to end
 * on a fresh home, through a real daemon.
 *
 *   1. fresh home, no engine env set: graph + verbatim vectors live in SQLite files (graph.sqlite,
 *      verbatim.sqlite); no legacy-engine data directories are created
 *   2. store (single), bulk, keyword search, semantic recall (keyword-proof query), node-full, stats
 *   3. graceful restart on the same home: every node still readable, recall still works, the outbox is empty
 *      and has no dead rows, and a write after the restart lands
 *
 * Real daemon, real embedding model, isolated HOME and free port. Never :3847, never ~/.groundfloor.
 * Run: npx tsx test/readiness335-sqlite-default-e2e.ts
 */
import path from 'node:path';
import { cleanup } from './helpers/live-daemon.js';
import { apiFor, bootDaemon, listFiles, makeChecker, stopDaemon, waitFor, waitOutboxDrained } from './helpers/readiness335.js';

const { check, finish } = makeChecker('3.35.0 readiness: default SQLite engine, fresh home, restart');
const SINGLE = 6;
const BULK = 20;

async function main(): Promise<void> {
    let h = await bootDaemon();
    const home = h.home;
    try {
        let api = apiFor(h);
        const dataDir = path.join(home, '.groundfloor', '.lore');
        const files = listFiles(path.join(home, '.groundfloor'));
        check('graph.sqlite exists on a fresh home', files.some((f) => f.endsWith('graph.sqlite')), files.join(','));
        check('verbatim.sqlite (vectors) exists', files.some((f) => f.endsWith('verbatim.sqlite')));
        check('outbox.sqlite exists', files.some((f) => f.endsWith('outbox.sqlite')));
        const legacy = files.filter((f) => /\.lance(\/|$)|surreal|\.kz$/i.test(f));
        check('no legacy-engine (Lance / Surreal / .kz) data created', legacy.length === 0, legacy.join(','));

        // 2. writes
        for (let i = 0; i < SINGLE; i++) {
            const r = await api.post('/api/node', {
                id: `sq-single-${i}`, type: 'decision', label: `Single ${i}`, workspace: 'default',
                content: i === 0
                    ? 'Retry failed uploads with exponential backoff and random jitter so clients do not stampede the server.'
                    : `Plain fixture ${i} about cache invalidation after deploys.`,
                tags: 'sqlite,e2e',
            });
            check(`single write ${i} -> 201/200`, r.status === 200 || r.status === 201, `${r.status} ${r.text}`);
        }
        const bulk = await api.post('/api/nodes/bulk', {
            workspace: 'default',
            nodes: Array.from({ length: BULK }, (_, i) => ({ id: `sq-bulk-${i}`, type: 'note', label: `Bulk ${i}`, content: `bulk fixture ${i}: quarterly capacity planning notes`, tags: 'bulk' })),
        });
        check('bulk write all succeeded', bulk.status === 200 && bulk.body?.succeeded === BULK, bulk.text.slice(0, 300));
        await waitOutboxDrained(api);

        const verify = async (phase: string): Promise<void> => {
            const stats = await api.get('/api/stats?workspace=default');
            check(`${phase}: stats nodeCount = ${SINGLE + BULK}`, stats.body?.nodeCount === SINGLE + BULK, stats.text.slice(0, 200));
            let missing = 0;
            for (const id of [...Array.from({ length: SINGLE }, (_, i) => `sq-single-${i}`), ...Array.from({ length: BULK }, (_, i) => `sq-bulk-${i}`)]) {
                const r = await api.get(`/api/node-full?id=${id}&workspace=default`);
                if (r.status !== 200 || r.body?.found !== true) missing++;
            }
            check(`${phase}: all ${SINGLE + BULK} nodes readable via node-full`, missing === 0, `${missing} missing`);
            const full = await api.get('/api/node-full?id=sq-single-0&workspace=default');
            check(`${phase}: body intact`, String(full.body?.content).includes('exponential backoff'));
            const kw = await api.get(`/api/search?q=${encodeURIComponent('stampede')}&workspace=default`);
            check(`${phase}: keyword search finds the node`, kw.text.includes('sq-single-0'));
            const hit = await waitFor(async () => {
                const rr = await api.get(`/api/recall?topic=${encodeURIComponent('resending broken file transfers progressively slower')}&workspace=default`);
                return rr.status === 200 && rr.body?.hits?.[0]?.id === 'sq-single-0';
            }, 30_000, `${phase}: semantic recall ranks sq-single-0 first`).catch(() => false);
            check(`${phase}: semantic recall (keyword-proof query) ranks the node first`, hit === true);
        };
        await verify('before restart');

        // 3. graceful restart on the same home
        await stopDaemon(h, 'SIGTERM');
        h = await bootDaemon({ home });
        api = apiFor(h);
        await verify('after restart');
        const health = await waitOutboxDrained(api);
        check('after restart: outbox empty and 0 dead rows', health.outbox?.depth === 0 && (health.outbox?.dead ?? 0) === 0, JSON.stringify(health.outbox));
        const post = await api.post('/api/node', { id: 'sq-after-restart', type: 'note', label: 'after', content: 'written after the restart', workspace: 'default' });
        check('write after restart lands', post.status === 200 || post.status === 201, post.text);
        const back = await api.get('/api/node-full?id=sq-after-restart&workspace=default');
        check('write after restart is readable', back.body?.found === true);
        check('data dir still SQLite-only after restart', !listFiles(path.join(home, '.groundfloor')).some((f) => /\.lance(\/|$)|surreal|\.kz$/i.test(f)));
    } catch (err) {
        check('suite ran without throwing', false, (err as Error).stack ?? String(err));
        console.error(`--- daemon log tail ---\n${h.log.text.slice(-2500)}`);
    } finally {
        cleanup(h);
    }
    finish();
}

await main();
