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

import { initCommand, serveCommand, syncCommand, statusCommand, doctorCommand, setupCommand, lintCommand, authCommand, retentionCommand, compactCommand, maintainCommand, backupCommand, restoreCommand, diagnoseCommand, reconnectCommand, reconsumeCommand, storageCommand, reportCommand, exportCommand, snapshotCommand, migrateCommand, verbatimCommand, modelsCommand, seedWorkspacesCommand, workspacesCommand, operatorCommand, resolveDeferredCommand, recallCommand, getFullCommand, supersedeCommand, markStaleCommand, embedCommand, outboxCommand } from './commands.js';
import { embedderCommand } from './embedderCommands.js';
/* ─── Parse Arguments ─────────────────────────────────────────── */

/**
 * Strip a top-level `--mode=local|cloud` flag (or `--mode local`)
 * from argv before command dispatch and write it to
 * `LORE_DEPLOYMENT_MODE`. CLI > env > config > default precedence.
 *
 * Done at this layer (before any subcommand handler runs) so the
 * existing `resolveDeploymentMode` env path picks it up unchanged.
 * Throws on invalid values so a typo doesn't silently fall through
 * to default 'local'.
 */
import { parseModeFlag } from './modeFlag.js';

function consumeModeFlag(rawArgs: string[]): string[] {
    const r = parseModeFlag(rawArgs);
    if (r.error) {
        console.error(`[lore] ${r.error}`);
        process.exit(1);
    }
    if (r.mode) process.env['LORE_DEPLOYMENT_MODE'] = r.mode;
    return r.args;
}

const args = consumeModeFlag(process.argv.slice(2));
const command = args[0];

const CORE_HELP = `
@groundfloor/lore — a knowledge database for agentic AI

Usage: lore <command> [options]

Core commands:
  setup     One-time setup (graph, daemon, IDE config)
  init      Initialize .lore/ graph in the current repo
  serve     Start the MCP server (default: stdio, --http for daemon)
  sync      Push pending changes and pull from remote
  status    Show graph statistics and sync status
  doctor    Diagnose configuration and connectivity
  lint      Check graph health and relationships
  reconnect      Compute semantic_neighbor edges between LoreNodes (dry-run unless --apply)
  reconsume      Re-embed every node with fresh content + apply the full reconnect pass
  storage        Show per-workspace disk usage breakdown + SSD free
  report         Write/print GRAPH_REPORT.md — human-readable graph digest
  export html    Write a standalone HTML graph snapshot (offline-viewable)
  snapshot       One-shot folder scan → HTML snapshot (no workspace ingest)
  migrate        One-off migrations (v1-sqlite → graph, embedding-model swap)
  verbatim       LanceDB verbatim store tools (today: reap orphan embeddings)
  maintain       Config-driven capacity maintenance (compaction, version cleanup, retention, ephemeral expiry)
  models         Manage cached LLM models (today: prune unused ONNX weights)
  seed-workspaces  Create the developer + personal seed workspaces (idempotent)
  workspaces       List, show, switch, or report the active workspace
  operator         Bind / inspect the local-mode operator identity (portal_user)
  resolve-deferred Stamp resolved_at on a deferred-* Lore node (Q1.7)
  mark-stale       Mark nodes stale by tag (Gap #3 — run after large commits)
  embed            Embedding pipeline tools (today: reembed an existing workspace)
  outbox           Outbox operator tools (drain-failed self-heal sweep)


Options:
  --help          Show this help message
  --mode <m>      Force deployment mode: 'local' or 'cloud'
                  (CLI > LORE_DEPLOYMENT_MODE env > config > default 'local')

Examples:
  lore setup                             # Full onboarding (solo)
  lore status                            # Show current graph stats
  lore doctor                            # Check health
  lore --mode=cloud serve --http         # Start service in cloud mode
`;

function renderHelp(): string {
    return CORE_HELP;
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
        case 'auth':
            await authCommand(commandArgs);
            break;
        case 'retention':
            await retentionCommand(commandArgs);
            break;
        case 'compact':
            await compactCommand(commandArgs);
            break;
        case 'maintain':
            await maintainCommand(commandArgs);
            break;
        case 'diagnose':
            await diagnoseCommand(commandArgs);
            break;
        case 'backup':
            await backupCommand(commandArgs);
            break;
        case 'restore':
            await restoreCommand(commandArgs);
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
        case 'embedder':
            await embedderCommand(commandArgs);
            break;
        case 'models':
            await modelsCommand(commandArgs);
            break;
        case 'seed-workspaces':
            await seedWorkspacesCommand(commandArgs);
            break;
        case 'workspaces':
            await workspacesCommand(commandArgs);
            break;
        case 'operator':
            await operatorCommand(commandArgs);
            break;
        case 'resolve-deferred':
            await resolveDeferredCommand(commandArgs);
            break;
        case 'recall':
            await recallCommand(commandArgs);
            break;
        case 'get-full':
            await getFullCommand(commandArgs);
            break;
        case 'supersede':
            await supersedeCommand(commandArgs);
            break;
        case 'mark-stale':
            await markStaleCommand(commandArgs);
            break;
        case 'embed':
            await embedCommand(commandArgs);
            break;
        case 'outbox':
            await outboxCommand(commandArgs);
            break;
        default: {
            console.error(`Unknown command: '${command}'`);
            console.error(`Run 'lore --help' for available commands.`);
            process.exit(1);
        }
    }

    // Deliberate explicit exit (non-'serve' commands only). Originally a
    // workaround for the removed legacy graph engine's native addon
    // segfaulting during GC-on-exit cleanup; that engine was removed
    // 2026-08-21, but the CLI now loads other native addons (@surrealdb/node,
    // better-sqlite3, @lancedb/lancedb) and this exit guarantees no lingering
    // native handle can hang the process after data is committed.
    if (command !== 'serve') {
        process.exit(0);
    }
}

main().catch((error) => {
    console.error(`[lore] Fatal error: ${(error as Error).message}`);
    process.exit(1);
});
