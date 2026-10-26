/**
 * workspaceErase/pathsEraser.ts — drops the deleted workspace's project-folder mapping (lane f6b).
 *
 * `<home>/workspace-paths.json` (and the legacy `projects.json`) map a workspace NAME to the project folders
 * that auto-select it. Delete never touched them, so a deleted workspace's name and folder list stayed behind.
 * The key is a name, so the entry is dropped only when no live registry entry carries that name (a re-created
 * workspace of the same name keeps its own mapping). Rewrites are atomic (write-rename) and touch only that one
 * key; an unreadable file is never overwritten (`partial`, retried).
 */

import fs from 'node:fs';
import path from 'node:path';
import { liveClaims, readLiveEntriesStrict } from './liveRegistry.js';
import type { EraseOptions, EraseStepResult, EraseTarget, WorkspaceEraser } from './types.js';

const STORE = 'workspace-paths';
const FILES = ['workspace-paths.json', 'projects.json'] as const;

const res = (status: EraseStepResult['status'], detail?: string, removed: Record<string, number> = {}, remaining: Record<string, number> = {}): EraseStepResult =>
    ({ store: STORE, status, removed, remaining, ...(detail ? { detail } : {}) });

export function createPathsEraser(deps: { home: string }): WorkspaceEraser {
    return {
        store: STORE,
        async erase(target: EraseTarget, _opts?: EraseOptions): Promise<EraseStepResult> {
            let live;
            try { live = readLiveEntriesStrict(deps.home); }
            catch (e) { return res('partial', `could not read the workspace registry, so no mapping was touched (${(e as Error).message})`); }
            if (liveClaims(live, { id: target.id, name: target.name, paths: [] }).byName) {
                return res('not-applicable', 'a live workspace now uses this name, so its project-folder mapping was left alone');
            }
            let removed = 0; let seen = false; const problems: string[] = [];
            for (const f of FILES) {
                const file = path.join(deps.home, f);
                let raw: string;
                try { raw = fs.readFileSync(file, 'utf8'); }
                catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; problems.push(`${f}: unreadable`); continue; }
                seen = true;
                let parsed: { projects?: Record<string, unknown> } & Record<string, unknown>;
                try { parsed = JSON.parse(raw) as typeof parsed; } catch { problems.push(`${f}: not valid JSON, left untouched`); continue; }
                const projects = parsed.projects;
                if (!projects || typeof projects !== 'object' || !Object.prototype.hasOwnProperty.call(projects, target.name)) continue;
                delete projects[target.name];
                const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
                try {
                    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 4) + '\n', 'utf8');
                    fs.renameSync(tmp, file);
                    removed++;
                } catch (e) {
                    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
                    problems.push(`${f}: could not be rewritten (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
                }
            }
            if (problems.length) return res('partial', `${problems.join('; ')}; it will be retried`, { entries: removed }, { entries: problems.length });
            if (!seen) return res('not-applicable', 'no project-folder mapping file exists', {}, { entries: 0 });
            return removed > 0 ? res('complete', undefined, { entries: removed }, { entries: 0 }) : res('not-applicable', 'no project-folder mapping existed for this workspace', {}, { entries: 0 });
        },
    };
}
