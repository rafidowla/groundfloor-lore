/**
 * seedWorkspaces.ts — `lore seed-workspaces` command (step #4).
 *
 * One-shot setup that creates the `personal` seed workspace.
 * Idempotent — skips workspaces that already exist, doesn't overwrite
 * an existing config.json.
 *
 * Doesn't switch the active workspace — that's a deliberate user
 * action via `lore workspaces switch <name>`.
 */

import fs from 'fs';
import path from 'path';
import {
    createWorkspace,
    loadWorkspaces,
    type WorkspaceEntry,
} from '../../config/workspaces.js';
import { ConfigManager } from '../../config/configManager.js';

interface SeedTemplate {
    name: string;
    description: string;
}

const TEMPLATES: SeedTemplate[] = [
    {
        name: 'personal',
        description: 'People, places, events, memories — dogfood the person',
    },
];

export interface SeedResult {
    created: string[];
    skippedExisting: string[];
    skippedConfigPresent: string[];
}

/**
 * Pure-ish helper: do the seed work, return what changed. CLI handler
 * prints; tests assert. Pull in injected helpers so tests can run
 * against a tmp dir without touching the user's real LORE_HOME.
 */
export function seedWorkspaces(deps: {
    loadWorkspaces: () => { workspaces: WorkspaceEntry[] };
    createWorkspace: (name: string) => WorkspaceEntry;
    makeConfigManager: (loreDir: string) => { read: () => unknown; patch: (u: Record<string, unknown>) => unknown };
    configFileExists: (workspacePath: string) => boolean;
} = defaultDeps()): SeedResult {
    const existing = new Set(deps.loadWorkspaces().workspaces.map(w => w.name));
    const result: SeedResult = { created: [], skippedExisting: [], skippedConfigPresent: [] };

    for (const tpl of TEMPLATES) {
        let entry: WorkspaceEntry;
        if (existing.has(tpl.name)) {
            // Workspace exists; only write config if absent (don't clobber user edits).
            entry = deps.loadWorkspaces().workspaces.find(w => w.name === tpl.name)!;
            if (deps.configFileExists(entry.path)) {
                result.skippedConfigPresent.push(tpl.name);
                continue;
            }
            result.skippedExisting.push(tpl.name);
        } else {
            entry = deps.createWorkspace(tpl.name);
            result.created.push(tpl.name);
        }
        // SP-14 — initialize the workspace config (idempotent). The
        // pre-v3.11.0 `plugins: [...]` patch was removed: the plugin system
        // is gone, nothing in Core reads a `plugins` array, and writing it
        // produced misleading dead metadata in config.json.
        const loreDir = path.join(entry.path, '.lore');
        const cfg = deps.makeConfigManager(loreDir);
        cfg.read();                       // initializes if missing
    }
    return result;
}

function defaultDeps() {
    return {
        loadWorkspaces,
        createWorkspace,
        makeConfigManager: (loreDir: string) => new ConfigManager(loreDir),
        configFileExists: (workspacePath: string) =>
            fs.existsSync(path.join(workspacePath, '.lore', 'config.json')),
    };
}

export async function seedWorkspacesCommand(_args: string[]): Promise<void> {
    const r = seedWorkspaces();
    if (r.created.length > 0) {
        console.log(`Created seed workspaces: ${r.created.join(', ')}`);
    }
    if (r.skippedExisting.length > 0) {
        console.log(`Wrote config for existing workspaces: ${r.skippedExisting.join(', ')}`);
    }
    if (r.skippedConfigPresent.length > 0) {
        console.log(`Skipped (workspace + config already present): ${r.skippedConfigPresent.join(', ')}`);
    }
    if (r.created.length === 0 && r.skippedExisting.length === 0) {
        console.log('Nothing to do — seed workspace already configured.');
    } else {
        console.log(`\nNext: lore workspaces switch <name> to activate one.`);
    }
}
