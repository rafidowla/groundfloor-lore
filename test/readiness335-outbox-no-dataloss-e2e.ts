#!/usr/bin/env tsx
/**
 * test/readiness335-outbox-no-dataloss-e2e.ts - 3.35.0 readiness: the outbox replicator survives transient
 * substrate failures without losing an acknowledged write (local / SQLite mode, real daemon).
 *
 * A preload (helpers/outbox-fault-preload.ts) makes the embed-replay path's graph read throw a SQLITE_BUSY-style
 * error the first 3 times it runs (a budget below LORE_OUTBOX_MAX_ATTEMPTS=5). The HTTP write path is untouched, so
 * every write is acknowledged. Asserts: the faults really fired (so the suite is not vacuous), the outbox drains to
 * depth 0 with 0 dead rows, every node is readable, the replayed vectors work (semantic recall that no keyword can
 * satisfy ranks the right node first), and the same holds after a restart on the same home without the preload.
 * The ArcadeDB variant of this guarantee (CME + container outage) is outbox-no-dataloss-arcade-e2e.ts, run by the
 * opt-in test:e2e:arcade-real group.
 *
 * Run: npx tsx test/readiness335-outbox-no-dataloss-e2e.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup } from './helpers/live-daemon.js';
import { apiFor, bootDaemon, makeChecker, stopDaemon, waitFor, waitOutboxDrained } from './helpers/readiness335.js';

const { check, finish } = makeChecker('3.35.0 readiness: outbox no-data-loss under transient replicator failures (SQLite)');
const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'outbox-fault-preload.ts');
const BULK = 40, SINGLE = 10;

async function main(): Promise<void> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r335-outbox-'));
    const log = path.join(tmp, 'faults.log');
    let h = await bootDaemon({ nodeArgs: ['--import', PRELOAD], env: { LORE_OUTBOX_FAULT_LOG: log, LORE_OUTBOX_FAULT_TOTAL: '3', LORE_OUTBOX_RETRY_BASE_MS: '100' } });
    const home = h.home;
    try {
        let api = apiFor(h);
        for (let i = 0; i < SINGLE; i++) {
            const r = await api.post('/api/node', {
                id: `ob-single-${i}`, type: 'decision', label: `Single ${i}`, workspace: 'default',
                content: i === 0 ? 'Retry failed uploads with exponential backoff and random jitter so clients do not stampede the server.' : `Plain fixture ${i} about cache invalidation after deploys.`,
            });
            check(`single write ${i} acknowledged`, r.status === 200 || r.status === 201, `${r.status} ${r.text}`);
        }
        const bulk = await api.post('/api/nodes/bulk', {
            workspace: 'default',
            nodes: Array.from({ length: BULK }, (_, i) => ({ id: `ob-bulk-${i}`, type: 'note', label: `Bulk ${i}`, content: `bulk fixture ${i}: quarterly capacity planning notes` })),
        });
        check('bulk write all acknowledged', bulk.status === 200 && bulk.body?.succeeded === BULK, bulk.text.slice(0, 300));

        const health = await waitOutboxDrained(api, 90_000);
        const injected = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
        check('the injected replicator failures really fired (3)', injected === 3, `injected=${injected}`);
        check('outbox drained: depth 0, 0 dead rows', health.outbox?.depth === 0 && (health.outbox?.dead ?? 0) === 0, JSON.stringify(health.outbox));

        const verify = async (phase: string): Promise<void> => {
            let missing = 0;
            const ids = [...Array.from({ length: SINGLE }, (_, i) => `ob-single-${i}`), ...Array.from({ length: BULK }, (_, i) => `ob-bulk-${i}`)];
            for (const id of ids) {
                const r = await api.get(`/api/node-full?id=${id}&workspace=default`);
                if (r.status !== 200 || r.body?.found !== true) missing++;
            }
            check(`${phase}: all ${ids.length} acknowledged nodes readable`, missing === 0, `${missing} missing`);
            const ok = await waitFor(async () => {
                const rr = await api.get(`/api/recall?topic=${encodeURIComponent('resending broken file transfers progressively slower')}&workspace=default`);
                return rr.status === 200 && rr.body?.hits?.[0]?.id === 'ob-single-0';
            }, 30_000, `${phase}: semantic recall`).catch(() => false);
            check(`${phase}: replayed vectors work (semantic recall ranks ob-single-0 first)`, ok === true);
        };
        await verify('after faults');

        await stopDaemon(h, 'SIGTERM');
        h = await bootDaemon({ home });
        api = apiFor(h);
        const h2 = await waitOutboxDrained(api, 60_000);
        check('after restart (no preload): depth 0, 0 dead rows', h2.outbox?.depth === 0 && (h2.outbox?.dead ?? 0) === 0, JSON.stringify(h2.outbox));
        await verify('after restart');
    } catch (err) {
        check('suite ran without throwing', false, (err as Error).stack ?? String(err));
        console.error(`--- daemon log tail ---\n${h.log.text.slice(-2500)}`);
    } finally {
        cleanup(h);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
    finish();
}
await main();
