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

import { initCommand, serveCommand, syncCommand, statusCommand, doctorCommand, setupCommand, joinCommand, lintCommand, auditCommand, reconnectCommand, reconsumeCommand, storageCommand, reportCommand, exportCommand, snapshotCommand, migrateCommand, verbatimCommand, modelsCommand, scaffoldPluginCommand, resolveDeferredCommand } from './commands.js';
import { ConfigManager } from '../config/configManager.js';
import { PluginRegistry } from '../plugins/registry.js';
import path from 'path';
import os from 'os';

/* ─── Parse Arguments ─────────────────────────────────────────── */

const args = process.argv.slice(2);
const command = args[0];

/**
 * Lazily boot a PluginRegistry to list/dispatch plugin-contributed
 * commands. Used for `--help` discovery and for any subcommand name
 * that isn't a core command.
 */
function loadPluginCliCommands(): Record<string, { plugin: string; help: string; handler: (args: string[]) => Promise<void> }> {
    try {
        const basePath = path.join(os.homedir(), '.groundfloor');
        const loreDir = path.join(basePath, '.lore');
        const registry = new PluginRegistry(new ConfigManager(loreDir));
        registry.boot();
        return registry.collectCliCommands();
    } catch {
        // No .lore/ yet (pre-init) or plugin boot failed — return empty
        // so `lore setup` / `lore init` still work.
        return {};
    }
}

const CORE_HELP = `
@groundfloor/lore — Unified Intelligence Engine

Usage: lore <command> [options]

Core commands:
  setup     One-time setup (graph, daemon, IDE config)
  join      Connect to a team's shared database
  init      Initialize .lore/ graph in the current repo
  serve     Start the MCP server (default: stdio, --http for daemon)
  sync      Push pending changes and pull from remote
  status    Show graph statistics and sync status
  doctor    Diagnose configuration and connectivity
  lint      Check graph health and relationships
  audit     Verify local codebase against Master Data Models
  reconnect      Compute semantic_neighbor edges between LoreNodes (dry-run unless --apply)
  reconsume      Re-embed every node with fresh content + apply the full reconnect pass
  storage        Show per-workspace disk usage breakdown + SSD free
  report         Write/print GRAPH_REPORT.md — human-readable graph digest
  export html    Write a standalone HTML graph snapshot (offline-viewable)
  snapshot       One-shot folder scan → HTML snapshot (no workspace ingest)
  migrate        One-off migrations (v1-sqlite → Kùzu, embedding-model swap)
  verbatim       LanceDB verbatim store tools (today: reap orphan embeddings)
  models         Manage cached LLM models (today: prune unused ONNX weights)
  scaffold-plugin  Scaffold a new plugin skeleton under packages/lore-plugin-<name>/
  resolve-deferred Stamp resolved_at on a deferred-* Lore node (Q1.7)

Options:
  --help    Show this help message

Examples:
  lore setup                             # Full onboarding (solo)
  lore join gf://host:8001/ns?token=...  # Join a team
  lore status                            # Show current graph stats
  lore doctor                            # Check health
`;

function renderHelp(): string {
    const pluginCommands = loadPluginCliCommands();
    const entries = Object.entries(pluginCommands);
    if (entries.length === 0) return CORE_HELP;
    const pluginLines = ['', 'Plugin commands:'];
    for (const [name, cmd] of entries) {
        pluginLines.push(`  ${name.padEnd(14)} ${cmd.help}  (${cmd.plugin})`);
    }
    return CORE_HELP + pluginLines.join('\n') + '\n';
}

/* ─── Command Routing ─────────────────────────────────────────── */

/**
 * main — Parse command and dispatch to handler.
 *
 * Side Effects: Delegates to command handlers.
 * Error Behavior: Prints error and exits with code 1.
 */
async function main(): Promise<void> {
    if (!command || command === '--help' || command === '-h') {
        console.log(renderHelp());
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
        case 'lint':
            await lintCommand(commandArgs);
            break;
        case 'audit':
            await auditCommand(commandArgs);
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
        case 'resolve-deferred':
            await resolveDeferredCommand(commandArgs);
            break;
        default: {
            // Dispatch to plugin-contributed commands if any match.
            const pluginCommands = loadPluginCliCommands();
            const pluginCmd = pluginCommands[command];
            if (pluginCmd) {
                await pluginCmd.handler(commandArgs);
                break;
            }
            console.error(`Unknown command: '${command}'`);
            console.error(`Run 'lore --help' for available commands.`);
            process.exit(1);
        }
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
