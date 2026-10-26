/**
 * workspaceErase/outboxEraser.ts — removes the deleted workspace's replication-queue rows (lane f6b).
 *
 * The outbox (`<workspace dir>/.lore/outbox.sqlite`) is one file per HOST data root, not per workspace: it lives
 * in the boot/active workspace's `.lore` directory and every workspace served by that host writes rows into it,
 * tagged with the workspace NAME (column `workspace`). So the deleted workspace's rows are NOT inside its own
 * (held) folder and the local-dir eraser never reaches them.
 *
 * Because the key is a name, not the permanent id, this eraser acts only when NO live registry entry carries the
 * name (a re-created workspace with the same name would otherwise lose its own pending replication). The registry
 * unreadable => `partial` (cannot prove the name is free). It only opens `outbox.sqlite` files that already exist
 * (home `.lore` and each live workspace's `.lore`); it never creates one and never closes a host's own handle.
 * Rows are deleted by exact `workspace = name` inside one transaction per file (`deleteByWorkspace`); a second
 * pass deleting zero rows is the verification that none remain.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SqliteOutboxStore } from '../../outbox/sqliteStore.js';
import { liveClaims, readLiveEntriesStrict } from './liveRegistry.js';
import type { EraseOptions, EraseStepResult, EraseTarget, WorkspaceEraser } from './types.js';

const STORE = 'outbox';

export interface OutboxEraserDeps { home: string }

/** Existing `outbox.sqlite` files this host could be using: `<home>/.lore` and each live workspace's `.lore`. */
export function candidateOutboxDirs(home: string, liveEntryPaths: readonly string[]): string[] {
    const dirs = new Map<string, string>();
    for (const base of [home, ...liveEntryPaths]) {
        const loreDir = path.join(base, '.lore');
        if (!fs.existsSync(path.join(loreDir, 'outbox.sqlite'))) continue;
        let key = loreDir;
        try { key = fs.realpathSync(loreDir); } catch { /* keep the literal path */ }
        if (!dirs.has(key)) dirs.set(key, loreDir);
    }
    return [...dirs.values()];
}

const res = (status: EraseStepResult['status'], detail?: string, removed: Record<string, number> = {}, remaining: Record<string, number> = {}): EraseStepResult =>
    ({ store: STORE, status, removed, remaining, ...(detail ? { detail } : {}) });

export function createOutboxEraser(deps: OutboxEraserDeps): WorkspaceEraser {
    return {
        store: STORE,
        async erase(target: EraseTarget, _opts?: EraseOptions): Promise<EraseStepResult> {
            let live;
            try { live = readLiveEntriesStrict(deps.home); }
            catch (e) { return res('partial', `could not read the workspace registry, so no queue rows were touched (${(e as Error).message})`); }
            if (liveClaims(live, { id: target.id, name: target.name, paths: [] }).byName) {
                return res('not-applicable', 'a live workspace now uses this name, so its replication-queue rows were left alone');
            }
            const dirs = candidateOutboxDirs(deps.home, live.map((w) => w.path));
            if (dirs.length === 0) return res('not-applicable', 'no replication queue exists in this deployment', {}, { rows: 0 });
            let removed = 0; let remaining = 0; const problems: string[] = [];
            for (const dir of dirs) {
                let store: SqliteOutboxStore | null = null;
                try {
                    store = new SqliteOutboxStore(dir);
                    removed += await store.deleteByWorkspace(target.name);
                    remaining += await store.deleteByWorkspace(target.name); // a second pass that deletes nothing proves none remain
                } catch (e) {
                    problems.push(`${path.basename(path.dirname(dir)) || 'queue'}: ${(e as Error).message}`.slice(0, 200));
                } finally {
                    store?.close();
                }
            }
            if (problems.length > 0) return res('partial', `a replication queue could not be cleaned and will be retried (${problems.join('; ')})`, { rows: removed }, { rows: remaining });
            // `remaining` counts rows the verification pass still found (and removed): non-zero means a writer raced us.
            return remaining > 0
                ? res('partial', 'queue rows were still arriving during the erase; it will be retried', { rows: removed + remaining }, { rows: 0 })
                : res('complete', undefined, { rows: removed }, { rows: 0 });
        },
    };
}
