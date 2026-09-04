/**
 * cli/commands/diagnose.ts — `lore diagnose` CLI.
 *
 * Runs the tri-substrate consistency diagnostic (graph ↔ vector store
 * ↔ optional SQLite tables) and prints a one-line summary plus the
 * full JSON report on stdout. Exits 0 when consistent, 1 when issues
 * found — usable in a CI/cron gate.
 *
 * Usage:
 *   lore diagnose                           # active workspace, no sqlite checks
 *   lore diagnose --workspace developer     # explicit workspace
 *   lore diagnose --sqlite code_change_event:node_id  # one sqlite check
 *   lore diagnose --sqlite a:x --sqlite b:y           # multiple sqlite checks
 *   lore diagnose --json                    # only the JSON, no summary line
 */

import { createTableStorage } from '../../engines/tableStorageFactory.js';
import type { RelationalProvider } from '../../providers/relationalTypes.js';
import { VerbatimStore } from '../../engines/verbatimStore.js';
import {
    diagnoseConsistency,
    summarizeReport,
    type SqliteOrphanCheck,
} from '../../diagnostics/consistency.js';
import { resolveGraphBasePath, openGraphForCli } from './shared.js';
import { getActiveWorkspaceName } from '../../config/workspaces.js';

export async function diagnoseCommand(args: string[]): Promise<void> {
    const flags = parseFlags(args);
    const workspace = flags.workspace ?? getActiveWorkspaceName();

    const basePath = resolveGraphBasePath();
    // Finding 11 (round E) — refuse fast with a clear message when a
    // running daemon holds this store's lock, instead of the old ~15s
    // openSurreal retry storm ending in a raw driver error.
    const graph = await openGraphForCli(basePath, { workspaceId: workspace });
    const verbatim = new VerbatimStore(basePath);
    await verbatim.initialize();
    const tableStorage = createTableStorage(basePath);

    try {
        const report = await diagnoseConsistency(
            graph,
            verbatim,
            tableStorage,
            { workspace, sqliteChecks: flags.sqliteChecks.length > 0 ? flags.sqliteChecks : undefined },
        );

        if (!flags.json) {
            console.log(summarizeReport(report));
        }
        console.log(JSON.stringify(report, null, 2));

        process.exit(report.hasIssues ? 1 : 0);
    } finally {
        await graph.close();
        await verbatim.close();
        const maybeClose = (tableStorage as RelationalProvider).close;
        if (typeof maybeClose === 'function') maybeClose.call(tableStorage);
    }
}

interface Flags {
    workspace?: string;
    sqliteChecks: SqliteOrphanCheck[];
    json: boolean;
}

function parseFlags(args: string[]): Flags {
    const out: Flags = { sqliteChecks: [], json: false };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--workspace' && i + 1 < args.length) {
            out.workspace = args[++i];
        } else if (a === '--sqlite' && i + 1 < args.length) {
            const parts = args[++i].split(':');
            if (parts.length !== 2) {
                throw new Error(`--sqlite expects 'table:column', got '${args[i]}'`);
            }
            out.sqliteChecks.push({ table: parts[0], column: parts[1] });
        } else if (a === '--json') {
            out.json = true;
        } else if (a === '--help' || a === '-h') {
            console.log(
                `Usage: lore diagnose [--workspace <name>] [--sqlite <table:column>...] [--json]\n` +
                `  Runs the tri-substrate consistency diagnostic.\n` +
                `  Exits 0 when consistent, 1 when issues found.\n`,
            );
            process.exit(0);
        }
    }
    return out;
}
