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

import { initCommand, serveCommand, syncCommand, statusCommand, doctorCommand, indexCommand } from './commands.js';

/* ─── Parse Arguments ─────────────────────────────────────────── */

const args = process.argv.slice(2);
const command = args[0];

const HELP_TEXT = `
@groundfloor/lore — Unified Developer Intelligence Engine

Usage: lore <command> [options]

Commands:
  init      Initialize .lore/ graph in the current repo
  serve     Start the MCP server (default: stdio, --http for daemon)
  index     Import code symbols from GitNexus into unified graph
  sync      Push pending changes and pull from remote
  status    Show graph statistics and sync status
  doctor    Diagnose configuration and connectivity

Options:
  --help    Show this help message

Examples:
  lore init                    # Initialize in current repo
  lore init --mcp antigravity  # Initialize and configure MCP for Antigravity
  lore index                   # Import all GitNexus repos into code graph
  lore index groundfloor-v2.5  # Import a specific repo
  lore status                  # Show current graph stats
  lore sync                    # Trigger manual sync
  lore doctor                  # Check health of all components
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
