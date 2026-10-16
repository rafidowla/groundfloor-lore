/**
 * test/helpers/ready-fault-preload.ts - node `--import` preload for the /ready e2e (readiness335-ready-local).
 *
 * While the file named by LORE_READY_FAULT_FLAG exists, every async SqliteGraph method (reads AND writes,
 * so the /ready probe and real node writes alike) fails with a SQLite I/O error, the way a broken store
 * would; delete the file and the store "recovers". Lifecycle methods are left alone. Test-only: nothing in
 * packages/ reads this.
 */
import fs from 'node:fs';
import { SqliteGraph } from '../../packages/lore/src/engines/sqliteGraph.js';

const LIFECYCLE = new Set(['constructor', 'close', 'dispose', 'initialize', 'init', 'shutdown', 'flush']);
const flag = process.env['LORE_READY_FAULT_FLAG'];
if (flag) {
    const proto = SqliteGraph.prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
        const desc = Object.getOwnPropertyDescriptor(proto, name); // accessors (e.g. dataPath) are skipped: reading them here would throw
        const fn = desc?.value as unknown;
        if (LIFECYCLE.has(name) || typeof fn !== 'function' || fn.constructor.name !== 'AsyncFunction') continue;
        Object.defineProperty(proto, name, { ...desc, value: async function (this: unknown, ...args: unknown[]) {
            if (fs.existsSync(flag)) throw new Error('SQLITE_IOERR: disk I/O error (injected by readiness335)');
            return (fn as (...a: unknown[]) => unknown).apply(this, args);
        } });
    }
}
