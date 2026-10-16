/**
 * test/helpers/outbox-fault-preload.ts - node `--import` preload for the outbox no-data-loss e2e (readiness335-outbox).
 *
 * Makes the outbox REPLICATOR meet transient substrate failures: the first LORE_OUTBOX_FAULT_TOTAL (default 3) times
 * the embed-replay path (outbox/wiring storeEmbedBatch) reads a node from the graph, the read throws (a budget below
 * LORE_OUTBOX_MAX_ATTEMPTS, so no single row can exhaust its retries). The write
 * path (HTTP handlers) is untouched, so every write is acknowledged normally and only replication is disturbed.
 * Each injected failure is appended to LORE_OUTBOX_FAULT_LOG. Test-only: nothing in packages/ reads this.
 */
import fs from 'node:fs';
import { SqliteGraph } from '../../packages/lore/src/engines/sqliteGraph.js';

const budget = Math.max(1, Number(process.env['LORE_OUTBOX_FAULT_TOTAL'] ?? 3));
const log = process.env['LORE_OUTBOX_FAULT_LOG'];
if (log) {
    const proto = SqliteGraph.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'getNode');
    const orig = desc?.value as ((...a: unknown[]) => Promise<unknown>) | undefined;
    if (typeof orig === 'function') {
        let injected = 0;
        Object.defineProperty(proto, 'getNode', { ...desc, value: async function (this: unknown, ...args: unknown[]) {
            const id = String(args[0]);
            if ((new Error().stack ?? '').includes('outbox/wiring')) {
                if (injected < budget) {
                    injected++;
                    fs.appendFileSync(log, `${id}\n`);
                    throw new Error('SQLITE_BUSY: database is locked (injected by readiness335 outbox fault)');
                }
            }
            return orig.apply(this, args);
        } });
    }
}
