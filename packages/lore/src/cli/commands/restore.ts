/**
 * cli/commands/restore.ts — `lore restore` CLI.
 *
 * Usage:
 *   lore restore <tarball> [--workspace <name>]
 *
 * Counterpart to `lore backup`. Extracts the tarball into the target
 * workspace's .lore/ directory. If the workspace already has a
 * .lore/, it's sidelined to .lore.pre-restore-<iso> (rollback path).
 *
 * Does NOT start the daemon. Operator restarts after restore; the
 * consistency sweeper picks up any drift on the next pass.
 *
 * Exits 0 on success; prints the sidelined-prior path so the
 * operator knows where the old state went.
 */

import * as fs from 'node:fs';
import { resolveWorkspaceGraphEngine } from '../../engines/graphEngineSelector.js';
import * as path from 'node:path';

import { restoreWorkspace } from '../../engines/restore.js';
import { loadWorkspaces, getActiveWorkspaceName } from '../../config/workspaces.js';

interface Flags {
    workspace?: string;
    tarball?: string;
}

function parseFlags(args: string[]): Flags {
    const out: Flags = {};
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--workspace' && i + 1 < args.length) out.workspace = args[++i];
        else if (a === '--help' || a === '-h') {
            console.log(
                `Usage: lore restore <tarball> [--workspace <name>]\n` +
                `  Restore a workspace from a backup tarball. Sidelines\n` +
                `  any existing .lore/ to .lore.pre-restore-<iso> as a\n` +
                `  rollback path. Operator restarts the daemon after.\n`,
            );
            process.exit(0);
        } else if (!a.startsWith('--') && !out.tarball) {
            out.tarball = a;
        }
    }
    return out;
}

export async function restoreCommand(args: string[]): Promise<void> {
    const flags = parseFlags(args);
    if (!flags.tarball) {
        console.error('Usage: lore restore <tarball> [--workspace <name>]');
        process.exit(1);
    }
    const wsName = flags.workspace ?? getActiveWorkspaceName();
    const wsFile = loadWorkspaces();
    const entry = wsFile.workspaces.find(w => w.name === wsName);
    if (!entry) {
        console.error(`No workspace named '${wsName}'. Known: ${wsFile.workspaces.map(w => w.name).join(', ')}`);
        process.exit(1);
    }
    if (!fs.existsSync(entry.path)) {
        console.error(`Workspace dir does not exist: ${entry.path}`);
        process.exit(1);
    }

    console.log(`→ Restoring '${path.basename(flags.tarball)}' into workspace '${wsName}' (${entry.path})`);

    const result = await restoreWorkspace({
        tarballPath: path.resolve(flags.tarball),
        workspaceDir: entry.path,
        // From the registry, so a cross-engine restore is refused rather than
        // leaving workspaces.json and .lore/ disagreeing.
        expectedEngine: resolveWorkspaceGraphEngine(wsName),
    });

    const mb = (result.bytesRestored / 1024 / 1024).toFixed(1);
    const sec = (result.durationMs / 1000).toFixed(1);
    console.log(`✓ Restored ${mb} MB · ${result.files.length} file(s) · ${sec}s`);
    if (result.sidelinedPriorTo) {
        console.log(`  Prior .lore/ moved to: ${result.sidelinedPriorTo}`);
        console.log(`  Remove it once you're confident the restore is good.`);
    }
    if (result.sidelinedPriorScatteredSurrealTo) {
        console.log(`  Prior SurrealDB store (outside .lore/) moved to: ${result.sidelinedPriorScatteredSurrealTo}`);
        console.log(`  Remove it once you're confident the restore is good.`);
    }
    console.log(`\nNext: restart the daemon to pick up the restored state.`);
}
