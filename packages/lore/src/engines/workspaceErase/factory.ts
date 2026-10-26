/**
 * workspaceErase/factory.ts — assembles the erasers in the fixed run order (lane f6b).
 *
 * Order (WAVE-F f6-COMMON): 1. ingestion blobs, 2. engine rows (postgres / dataplane), 3. name-keyed side stores (outbox rows, workspace-paths entry), 4. local dir,
 * 5. keyring, 6. audit log (last: a failure there must not block the local dir / key erasure; it needs the registry and deletion log, not the data dir).
 * Blob references are read from ingestion rows, so blobs must go before rows; the local dir holds SQLite rows and
 * the ingestion store, so it goes after the network stores; the keyring goes last so the key outlives the data.
 * `extra` is the slot where the plug-in lane adds the Postgres + blob erasers: each is placed by its `store` label.
 */

import { loreHome } from '../../config/loreHome.js';
import { createAuditEraser } from './auditEraser.js';
import { createDataplaneEraser, type DataplaneEraserDeps } from './dataplaneEraser.js';
import { createKeyringEraser, type KeyringOps } from './keyringEraser.js';
import { createLocalDirEraser } from './localDir.js';
import { createOutboxEraser } from './outboxEraser.js';
import { createPathsEraser } from './pathsEraser.js';
import type { WorkspaceEraser } from './types.js';

export interface EraserFactoryDeps {
    home: string;
    env?: Record<string, string | undefined>;
    dataplane?: Pick<DataplaneEraserDeps, 'clientFactory' | 'now' | 'collections'>;
    /** Fault-injection seam for the local-dir removal (tests). */
    rm?: (p: string) => void;
    /** Keychain operations; tests inject a fake. Default: the OS keychain, used only for the default Lore home. */
    keyringOps?: KeyringOps;
    /** Force the keyring step on/off; default = on only when `home` is the machine's default Lore home. */
    keyringEnabled?: boolean;
}

/** Position of a store in the run order; unknown labels run just before the local dir. */
export const ERASE_RUN_ORDER: readonly string[] = ['blobs-fs', 'blobs-groundfloor', 'postgres', 'dataplane', 'outbox', 'workspace-paths', 'local-dir', 'keyring', 'audit-log'];

const rank = (store: string): number => {
    const i = ERASE_RUN_ORDER.indexOf(store);
    if (i >= 0) return i;
    if (store.startsWith('blobs')) return 1;
    return ERASE_RUN_ORDER.indexOf('local-dir') - 0.5;
};

export function buildWorkspaceErasers(deps: EraserFactoryDeps, extra: readonly WorkspaceEraser[] = []): WorkspaceEraser[] {
    const keyringEnabled = deps.keyringEnabled ?? (deps.home === loreHome());
    const own: WorkspaceEraser[] = [
        createDataplaneEraser({ home: deps.home, ...(deps.env ? { env: deps.env } : {}), ...(deps.dataplane ?? {}) }),
        createOutboxEraser({ home: deps.home }),
        createPathsEraser({ home: deps.home }),
        createLocalDirEraser({ home: deps.home, ...(deps.rm ? { rm: deps.rm } : {}) }),
        createKeyringEraser({ home: deps.home, enabled: keyringEnabled, ...(deps.keyringOps ? { ops: deps.keyringOps } : {}) }),
        createAuditEraser({ home: deps.home }),
    ];
    const all = [...extra, ...own];
    // Stable sort by rank (Array.prototype.sort is stable): equal ranks keep insertion order.
    return all.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e.store) - rank(b.e.store) || a.i - b.i).map((x) => x.e);
}
