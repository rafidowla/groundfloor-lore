#!/usr/bin/env node
/**
 * index.ts — Lore CLI Entry Point.
 *
 * Purpose:
 *   Command-line interface for @groundfloor/lore. Routes commands to
 *   their respective handlers. Uses Node.js built-in parseArgs (Node ≥18.3).
 *
 * Usage:
 *   lore <command> [options]
 *
 * Commands:
 *   init    — Initialize .lore/ in current repo
 *   serve   — Start MCP server on stdio
 *   sync    — Push/pull knowledge changes
 *   status  — Show graph stats and sync status
 *   doctor  — Diagnose configuration issues
 *
 * Side Effects: Delegates to command handlers which may modify filesystem.
 * Error Behavior: Prints error to stderr and exits with code 1.
 */

import { initCommand, serveCommand, syncCommand, statusCommand, doctorCommand, indexCommand, setupCommand, joinCommand, lintCommand, auditCommand, ingestFilesCommand, reconnectCommand, reconsumeCommand, storageCommand, reportCommand, exportCommand, snapshotCommand, migrateCommand, verbatimCommand, modelsCommand, scaffoldPluginCommand } from './commands.js';

/* ─── Parse Arguments ─────────────────────────────────────────── */

const args = process.argv.slice(2);
const command = args[0];

const HELP_TEXT = `
@groundfloor/lore — Unified Developer Intelligence Engine

Usage: lore <command> [options]

Commands:
  setup     One-time setup (graph, daemon, IDE config)
  join      Connect to a team's shared database
  init      Initialize .lore/ graph in the current repo
  serve     Start the MCP server (default: stdio, --http for daemon)
  index     Import code symbols from GitNexus into unified graph
  sync      Push pending changes and pull from remote
  status    Show graph statistics and sync status
  doctor    Diagnose configuration and connectivity
  lint      Check graph health and relationships
  audit     Verify local codebase against Master Data Models
  ingest-files   Synthesize CodeFile nodes + FileContains edges from existing CodeSymbols
  reconnect      Compute semantic_neighbor edges between LoreNodes (dry-run unless --apply)
  reconsume      Re-embed every node with fresh content + apply the full reconnect pass
  storage        Show per-workspace disk usage breakdown + SSD free
  report         Write/print GRAPH_REPORT.md — human-readable graph digest
  export html    Write a standalone HTML graph snapshot (offline-viewable)
  snapshot       One-shot folder scan → HTML snapshot (no workspace ingest)
  migrate        One-off migrations (today: v1-sqlite → Kùzu)
  verbatim       LanceDB verbatim store tools (today: reap orphan embeddings)
  models         Manage cached LLM models (today: prune unused ONNX weights)
  scaffold-plugin  Scaffold a new plugin skeleton under packages/lore-plugin-<name>/

Options:
  --help    Show this help message

Examples:
  lore setup                             # Full onboarding (solo)
  lore join gf://host:8001/ns?token=...  # Join a team
  lore index                             # Import all GitNexus repos
  lore index groundfloor-v2.5            # Import a specific repo
  lore status                            # Show current graph stats
  lore doctor                            # Check health
`;

/* ─── Command Routing ─────────────────────────────────────────── */

/**
 * main — Parse command and dispatch to handler.
 *
 * Side Effects: Delegates to command handlers.
 * Error Behavior: Prints error and exits with code 1.
 */
async function main(): Promise<void> {
    if (!command || command === '--help' || command === '-h') {
        console.log(HELP_TEXT);
        process.exit(0);
    }

    const commandArgs = args.slice(1);

    switch (command) {
        case 'setup':
            await setupCommand(commandArgs);
            break;
        case 'join':
            await joinCommand(commandArgs);
            break;
        case 'init':
            await initCommand(commandArgs);
            break;
        case 'serve':
            await serveCommand(commandArgs);
            break;
        case 'sync':
            await syncCommand(commandArgs);
            break;
        case 'status':
            await statusCommand(commandArgs);
            break;
        case 'doctor':
            await doctorCommand(commandArgs);
            break;
        case 'index':
            await indexCommand(commandArgs);
            break;
        case 'lint':
            await lintCommand(commandArgs);
            break;
        case 'audit':
            await auditCommand(commandArgs);
            break;
        case 'ingest-files':
            await ingestFilesCommand(commandArgs);
            break;
        case 'reconnect':
            await reconnectCommand(commandArgs);
            break;
        case 'reconsume':
            await reconsumeCommand(commandArgs);
            break;
        case 'storage':
            await storageCommand(commandArgs);
            break;
        case 'report':
            await reportCommand(commandArgs);
            break;
        case 'export':
            await exportCommand(commandArgs);
            break;
        case 'snapshot':
            await snapshotCommand(commandArgs);
            break;
        case 'migrate':
            await migrateCommand(commandArgs);
            break;
        case 'verbatim':
            await verbatimCommand(commandArgs);
            break;
        case 'models':
            await modelsCommand(commandArgs);
            break;
        case 'scaffold-plugin':
            await scaffoldPluginCommand(commandArgs);
            break;
        default:
            console.error(`Unknown command: '${command}'`);
            console.error(`Run 'lore --help' for available commands.`);
            process.exit(1);
    }

    // Explicit exit prevents segfault from @kineviz/kuzu-lite native addon
    // cleanup during Node.js garbage collection. The native addon occasionally
    // accesses freed memory during shutdown. Data is fully committed by this point.
    if (command !== 'serve') {
        process.exit(0);
    }
}

main().catch((error) => {
    console.error(`[lore] Fatal error: ${(error as Error).message}`);
    process.exit(1);
});
