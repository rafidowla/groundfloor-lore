/**
 * cli/targetGuard.ts — pre-write safety checks for destructive per-workspace
 * migrations (`migrate-graph`, `migrate-vectors`).
 *
 * Incident this prevents: `lore migrate-graph default --to sqlite --data-dir
 * <copy>` ignored the unsupported `--data-dir`, fell back to LORE_HOME and
 * migrated that home's real `default` workspace. The command parsers now
 * reject unknown flags (cli/args.ts); this module is the second layer — even
 * with a valid `--data-dir`, the target must be provably what the operator
 * named:
 *   1. the target home's `workspaces.json` must already exist (the engines'
 *      `loadWorkspaces()` would otherwise BOOTSTRAP a registry — a write);
 *   2. it must contain the named workspace;
 *   3. when `--data-dir` was given, that workspace's `path` must resolve to
 *      inside the data dir. A copied tree whose registry still points back at
 *      the original roots is refused, naming both paths.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadWorkspaces } from '../config/workspaces.js';

export class TargetRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TargetRefusedError';
    }
}

/** realpath when the path exists, else the nearest existing ancestor's realpath + the tail. */
function realish(p: string): string {
    const abs = path.resolve(p);
    const tail: string[] = [];
    let cur = abs;
    for (;;) {
        try {
            const real = fs.realpathSync(cur);
            return tail.length ? path.join(real, ...tail.reverse()) : real;
        } catch {
            const parent = path.dirname(cur);
            if (parent === cur) return abs;
            tail.push(path.basename(cur));
            cur = parent;
        }
    }
}

export function isInside(child: string, parent: string): boolean {
    const rel = path.relative(realish(parent), realish(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface TargetCheck {
    registryPath: string;
    workspacePath: string;
}

/**
 * Throws TargetRefusedError unless `home`'s registry exists, names
 * `workspaceName`, and (when `dataDirGiven`) places it inside `home`.
 * Never writes.
 */
export function assertWorkspaceTarget(
    opts: { home: string; workspaceName: string; dataDirGiven: boolean },
): TargetCheck {
    const { home, workspaceName, dataDirGiven } = opts;
    const registryPath = path.join(home, 'workspaces.json');
    if (!fs.existsSync(registryPath)) {
        throw new TargetRefusedError(
            `no workspaces.json at ${registryPath} — refusing to create one. `
            + 'Check the target (--data-dir / LORE_HOME); nothing was changed.',
        );
    }
    const reg = loadWorkspaces(home);
    const entry = reg.workspaces.find((w) => w.name === workspaceName);
    if (!entry) {
        const known = reg.workspaces.map((w) => w.name).join(', ');
        throw new TargetRefusedError(
            `workspace '${workspaceName}' is not in ${registryPath} (known: ${known}); nothing was changed.`,
        );
    }
    if (dataDirGiven && !isInside(entry.path, home)) {
        throw new TargetRefusedError(
            `workspace '${workspaceName}' in ${registryPath} points at ${entry.path}, which is OUTSIDE `
            + `the --data-dir ${home}. This looks like a copied registry that still references the original `
            + 'roots; running would modify the original. Fix the registry path or point --data-dir at the right root. '
            + 'Nothing was changed.',
        );
    }
    return { registryPath, workspacePath: entry.path };
}

/** `--data-dir` resolved like migrate-vectors: must be an existing directory. */
export function requireExistingDir(dir: string, label: string): void {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new TargetRefusedError(`${label} ${dir} does not exist or is not a directory`);
    }
}
