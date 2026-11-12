/**
 * workspaceErase/versionsEraser.ts — removes the deleted workspace's node-version history.
 *
 * Version history (`<workspace dir>/.lore/versions.sqlite`: `node_versions`, `changesets`, `changeset_writes`) is one
 * file per HOST data root, shared by every workspace that host serves, and keyed by workspace NAME. Like the outbox, it is
 * not inside the deleted workspace's own (held) folder, so the local-dir eraser never reaches it, and it keeps full node
 * content — a deleted workspace would otherwise stay readable there.
 *
 * Same rules as the outbox eraser, except for a re-created name: when a LIVE workspace now carries the deleted
 * workspace's name, only history no newer than the deletion (`target.deletedAt`) is removed, so the new workspace keeps
 * its own history but none of the old content stays readable under it. Without a usable `deletedAt` nothing can be
 * separated safely, so the step is `unverifiable` (never `complete`). Registry unreadable => `partial`; only opens `versions.sqlite` files that
 * already exist (never creates one); deletes by exact workspace name in one transaction; a second pass that finds
 * nothing is the verification.
 */

import fs from 'node:fs';
import path from 'node:path';
import { VersionStore } from '../../outbox/versionStore.js';
import { liveClaims, readLiveEntriesStrict } from './liveRegistry.js';
import type { EraseOptions, EraseStepResult, EraseTarget, WorkspaceEraser } from './types.js';

const STORE = 'versions';

export interface VersionsEraserDeps { home: string }

/** Existing `versions.sqlite` files this host could be using: `<home>/.lore` and each live workspace's `.lore`. */
export function candidateVersionDirs(home: string, liveEntryPaths: readonly string[]): string[] {
    const dirs = new Map<string, string>();
    for (const base of [home, ...liveEntryPaths]) {
        const loreDir = path.join(base, '.lore');
        if (!fs.existsSync(path.join(loreDir, 'versions.sqlite'))) continue;
        let key = loreDir;
        try { key = fs.realpathSync(loreDir); } catch { /* keep the literal path */ }
        if (!dirs.has(key)) dirs.set(key, loreDir);
    }
    return [...dirs.values()];
}

const res = (status: EraseStepResult['status'], detail?: string, removed: Record<string, number> = {}, remaining: Record<string, number> = {}): EraseStepResult =>
    ({ store: STORE, status, removed, remaining, ...(detail ? { detail } : {}) });

export function createVersionsEraser(deps: VersionsEraserDeps): WorkspaceEraser {
    return {
        store: STORE,
        async erase(target: EraseTarget, _opts?: EraseOptions): Promise<EraseStepResult> {
            let live;
            try { live = readLiveEntriesStrict(deps.home); }
            catch (e) { return res('partial', `could not read the workspace registry, so no version history was touched (${(e as Error).message})`); }
            let upTo: string | undefined;
            const nameReused = liveClaims(live, { id: target.id, name: target.name, paths: [] }).byName;
            if (nameReused) {
                const ms = target.deletedAt ? Date.parse(target.deletedAt) : Number.NaN;
                if (Number.isNaN(ms)) {
                    return res('unverifiable', 'a live workspace now uses this name and the deletion time is unknown, so the old version history could not be told apart from the new one and was left alone');
                }
                upTo = new Date(ms).toISOString();
            }
            const dirs = candidateVersionDirs(deps.home, live.map((w) => w.path));
            if (dirs.length === 0) return res('not-applicable', 'no version history exists in this deployment', {}, { rows: 0 });
            let removed = 0; let remaining = 0; const problems: string[] = [];
            for (const dir of dirs) {
                let store: VersionStore | null = null;
                try {
                    store = VersionStore.open(dir);
                    const a = store.purgeWorkspace(target.name, upTo);
                    removed += a.versions + a.changesetWrites + a.changesets;
                    const b = store.purgeWorkspace(target.name, upTo); // a second pass that deletes nothing proves none remain
                    remaining += b.versions + b.changesetWrites + b.changesets;
                } catch (e) {
                    problems.push(`${path.basename(path.dirname(dir)) || 'versions'}: ${(e as Error).message}`.slice(0, 200));
                } finally {
                    store?.close();
                }
            }
            if (problems.length > 0) return res('partial', `version history could not be cleaned and will be retried (${problems.join('; ')})`, { rows: removed }, { rows: remaining });
            return remaining > 0
                ? res('partial', 'version rows were still arriving during the erase; it will be retried', { rows: removed + remaining }, { rows: 0 })
                : res('complete', undefined, { rows: removed }, { rows: 0 });
        },
    };
}
