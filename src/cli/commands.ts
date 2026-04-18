/**
 * commands.ts — CLI Command Handlers.
 *
 * Purpose:
 *   Implements CLI commands: init, serve, sync, status, doctor, setup, join.
 *   Each command creates its own LocalGraph and SyncEngine instances
 *   as needed — the CLI is a thin orchestration layer.
 *
 * Side Effects: Filesystem writes (init, setup, join), stdio (serve), network (sync, join).
 * Error Behavior: Each command catches errors and exits with code 1.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import http from 'http';
import { LocalGraph } from '../engines/localGraph.js';
import { SyncEngine } from '../engines/syncEngine.js';
import { listGitNexusRepos, getGitNexusRepo, importFromGitNexus, isGitNexusAvailable } from '../engines/codeIndexer.js';

/* ─── Shared Helpers ──────────────────────────────────────────── */

/**
 * findRepoRoot — Walk up from CWD to find the git repo root.
 *
 * @returns Git repo root path, or CWD if not in a git repo.
 */
function findRepoRoot(): string {
    let currentDirectory = process.cwd();
    while (currentDirectory !== path.dirname(currentDirectory)) {
        if (fs.existsSync(path.join(currentDirectory, '.git'))) {
            return currentDirectory;
        }
        currentDirectory = path.dirname(currentDirectory);
    }
    return process.cwd();
}

/**
 * resolveGraphBasePath — Determines the base path for the .lore/ directory.
 *
 * Always uses ~/.groundfloor for consistency across CLI, MCP, and IDEs.
 */
function resolveGraphBasePath(): string {
    return path.join(os.homedir(), '.groundfloor');
}

/* ─── Command: init ───────────────────────────────────────────── */

/**
 * initCommand — Initialize .lore/ graph in the current repo.
 *
 * Purpose: Creates the .lore/ directory, initializes the Kùzu graph schema,
 *   registers the project in ~/.groundfloor/projects.json, and optionally
 *   configures MCP for Antigravity or Cursor.
 *
 * @param args - CLI arguments. Supports --mcp <tool> to auto-configure MCP.
 *
 * Side Effects:
 *   - Creates .lore/ directory with Kùzu graph.
 *   - Optionally writes MCP config.
 *   - Registers project in projects.json.
 *
 * Error Behavior: Prints error and exits with code 1.
 */
export async function initCommand(args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    console.log(`→ Initializing Lore in ${basePath}`);

    // Create graph
    const graph = new LocalGraph(basePath);
    await graph.initialize();
    console.log(`✓ Kùzu graph initialized at ${loreDir}/graph/`);

    // Create WAL directory marker
    const walPath = path.join(loreDir, 'sync.wal');
    if (!fs.existsSync(walPath)) {
        fs.writeFileSync(walPath, '', 'utf-8');
        console.log(`✓ WAL file created at ${walPath}`);
    }

    // Add .lore/ to .gitignore if not already present
    const gitignorePath = path.join(basePath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
        if (!gitignoreContent.includes('.lore/')) {
            fs.appendFileSync(gitignorePath, '\n# Lore graph data (local-only)\n.lore/\n', 'utf-8');
            console.log(`✓ Added .lore/ to .gitignore`);
        }
    }

    // Register project
    const projectName = path.basename(basePath);
    const registryPath = path.join(os.homedir(), '.groundfloor', 'projects.json');
    let registry: { projects: Record<string, { ecosystem: string; paths: string[] }> };

    try {
        registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    } catch {
        registry = { projects: {} };
    }

    if (!(projectName in registry.projects)) {
        registry.projects[projectName] = {
            ecosystem: '*',
            paths: [projectName, path.basename(basePath)],
        };
        fs.mkdirSync(path.dirname(registryPath), { recursive: true });
        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 4) + '\n', 'utf-8');
        console.log(`✓ Registered project '${projectName}' in ~/.groundfloor/projects.json`);
    }

    // Optional MCP auto-config
    const mcpIndex = args.indexOf('--mcp');
    if (mcpIndex !== -1) {
        const mcpTool = args[mcpIndex + 1] ?? 'antigravity';
        await configureMcp(mcpTool, basePath);
    }

    // Get stats
    const stats = await graph.getStats();
    await graph.close();

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Lore initialized!`);
    console.log(`  Graph: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
    console.log(`  Path:  ${loreDir}/graph/`);
    console.log('');
    console.log('  Next steps:');
    console.log('    lore serve    # Start MCP server');
    console.log('    lore status   # Check graph stats');
    console.log('═══════════════════════════════════════════════════════════');
}

/**
 * configureMcp — Write MCP server config for the specified tool.
 *
 * @param tool - "antigravity" or "cursor".
 * @param basePath - Base path where the lore package is installed.
 */
async function configureMcp(tool: string, basePath: string): Promise<void> {
    const serverJsPath = path.resolve(basePath, 'dist', 'mcp', 'server.js');

    const mcpEntry = {
        'groundfloor-lore': {
            type: 'stdio',
            command: 'node',
            args: [serverJsPath],
        },
    };

    let configPath: string;
    switch (tool) {
        case 'antigravity':
            configPath = path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
            break;
        case 'cursor':
            configPath = path.join(os.homedir(), '.cursor', 'mcp.json');
            break;
        default:
            console.log(`⚠ Unknown MCP tool '${tool}'. Supported: antigravity, cursor`);
            return;
    }

    let existingConfig: { mcpServers: Record<string, unknown> };
    try {
        existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
        existingConfig = { mcpServers: {} };
    }

    existingConfig.mcpServers = { ...existingConfig.mcpServers, ...mcpEntry };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 4) + '\n', 'utf-8');
    console.log(`✓ MCP config written for ${tool} at ${configPath}`);
}

/* ─── Command: serve ──────────────────────────────────────────── */

/**
 * serveCommand — Start the MCP server.
 *
 * Purpose: Starts the MCP server in either stdio (default) or HTTP daemon mode.
 *   Pass --http to start as a shared HTTP daemon on port 3847.
 *
 * @param args - CLI arguments. Supports '--http' for daemon mode.
 *
 * Side Effects: Starts MCP server, opens Kùzu database.
 * Error Behavior: Server module handles its own errors.
 */
export async function serveCommand(args: string[]): Promise<void> {
    const useHttp = args.includes('--http');

    if (useHttp) {
        // Pass --http to the server module via process.argv
        process.argv.push('--http');
    }

    // Import the server module — it starts itself on import
    await import('../mcp/server.js');
}

/* ─── Command: index ─────────────────────────────────────── */

/**
 * indexCommand — Import code symbols from GitNexus into the unified Lore graph.
 *
 * Purpose:
 *   Reads GitNexus .gitnexus/ Kùzu databases and imports all code symbols
 *   and relationships into Lore's unified graph. Enables cross-pillar queries
 *   between knowledge nodes and code symbols.
 *
 * @param args - Optional repo name. If omitted, imports all indexed repos.
 *
 * Side Effects:
 *   - Opens GitNexus DB read-only for each repo.
 *   - Clears existing code symbols before re-import (idempotent).
 *   - Writes CodeSymbol + CodeRelation to Lore Kùzu graph.
 *
 * Error Behavior: Prints per-repo results. Non-fatal errors are collected.
 */
export async function indexCommand(args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    if (!fs.existsSync(loreDir)) {
        console.error('❌ No .lore/ directory found. Run "lore init" first.');
        process.exit(1);
    }

    const graph = new LocalGraph(basePath);
    await graph.initialize();

    const specificRepo = args[0];

    if (specificRepo) {
        // Index a specific repo
        const repoEntry = getGitNexusRepo(specificRepo);
        if (!repoEntry) {
            console.error(`❌ Repository '${specificRepo}' not found in GitNexus registry.`);
            console.error('  Available repos:');
            const allRepos = listGitNexusRepos();
            for (const repo of allRepos) {
                console.error(`    - ${repo.name} (${repo.stats.nodes} symbols)`);
            }
            await graph.close();
            process.exit(1);
        }

        console.log(`→ Indexing '${specificRepo}' from GitNexus...`);
        const result = await importFromGitNexus(repoEntry, graph);
        printIndexResult(result);
    } else {
        // Index all repos
        const repos = listGitNexusRepos();
        if (repos.length === 0) {
            console.error('❌ No GitNexus-indexed repos found.');
            console.error('  Run "gitnexus analyze <path>" to index a repo first.');
            await graph.close();
            process.exit(1);
        }

        console.log(`→ Indexing ${repos.length} repo(s) from GitNexus...`);
        console.log('');

        for (const repo of repos) {
            console.log(`  ─── ${repo.name} (${repo.stats.nodes} GitNexus symbols) ───`);
            const result = await importFromGitNexus(repo, graph);
            printIndexResult(result);
            console.log('');
        }
    }

    // Show updated stats
    const stats = await graph.getStats();
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Unified Graph Stats:');
    console.log(`    Knowledge: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
    console.log(`    Code:      ${stats.codeSymbolCount} symbols, ${stats.codeRelationCount} relations`);
    console.log('═══════════════════════════════════════════════════════════');

    await graph.close();
}

/**
 * printIndexResult — Display the result of a code index operation.
 */
function printIndexResult(result: import('../engines/codeIndexer.js').IndexResult): void {
    console.log(`  ✓ ${result.symbolsImported} symbols imported`);
    console.log(`  ✓ ${result.relationsImported} relations imported`);
    if (result.symbolsCleared > 0) {
        console.log(`  ✓ ${result.symbolsCleared} old symbols cleared`);
    }
    console.log(`  ✓ Duration: ${result.durationMs}ms`);
    if (result.errors.length > 0) {
        console.log(`  ⚠ ${result.errors.length} non-fatal errors`);
        for (const error of result.errors.slice(0, 5)) {
            console.log(`    - ${error}`);
        }
        if (result.errors.length > 5) {
            console.log(`    ... and ${result.errors.length - 5} more`);
        }
    }
}

/* ─── Command: sync ───────────────────────────────────────────── */

/**
 * syncCommand — Trigger a manual sync cycle (push + pull).
 *
 * @param _args - CLI arguments (unused).
 *
 * Side Effects: Network push/pull, WAL truncation.
 */
export async function syncCommand(_args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    if (!fs.existsSync(loreDir)) {
        console.error('❌ No .lore/ directory found. Run "lore init" first.');
        process.exit(1);
    }

    const graph = new LocalGraph(basePath);
    await graph.initialize();

    // Create sync engine without adapter (offline mode for now)
    const syncEngine = new SyncEngine(graph, loreDir, null);

    console.log(`→ Syncing from ${loreDir}`);

    const walStatus = syncEngine.getStatus();
    console.log(`  WAL pending: ${walStatus.walPending} entries`);
    console.log(`  Last sync:   ${walStatus.lastSync === '1970-01-01T00:00:00.000Z' ? 'never' : walStatus.lastSync}`);

    const result = await syncEngine.sync();

    console.log('');
    console.log('  Push: ' + (result.push.errors.length > 0
        ? result.push.errors[0]
        : `${result.push.nodesPushed} nodes, ${result.push.edgesPushed} edges`));
    console.log('  Pull: ' + `${result.pull.nodesPulled} nodes, ${result.pull.edgesPulled} edges` +
        (result.pull.conflicts > 0 ? ` (${result.pull.conflicts} conflicts resolved)` : ''));

    await graph.close();
}

/* ─── Command: status ─────────────────────────────────────────── */

/**
 * statusCommand — Show graph statistics and sync status.
 *
 * @param _args - CLI arguments (unused).
 *
 * Side Effects: Reads from graph and WAL.
 */
export async function statusCommand(_args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    if (!fs.existsSync(loreDir)) {
        console.error('❌ No .lore/ directory found. Run "lore init" first.');
        process.exit(1);
    }

    const graph = new LocalGraph(basePath);
    await graph.initialize();

    const stats = await graph.getStats();
    const syncEngine = new SyncEngine(graph, loreDir, null);
    const syncStatus = syncEngine.getStatus();

    // Load project registry
    const registryPath = path.join(os.homedir(), '.groundfloor', 'projects.json');
    let projectName = '*';
    let ecosystem = '*';
    try {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
        for (const [name, mapping] of Object.entries(registry.projects)) {
            const projectMapping = mapping as { ecosystem: string; paths: string[] };
            for (const pathFragment of projectMapping.paths) {
                if (basePath.includes(pathFragment)) {
                    projectName = name;
                    ecosystem = projectMapping.ecosystem;
                    break;
                }
            }
        }
    } catch {
        // No registry — fine
    }

    console.log('');
    console.log('  @groundfloor/lore — Status');
    console.log('  ─────────────────────────────────────');
    console.log(`  Engine:     Kùzu (local graph)`);
    console.log(`  Graph:      ${path.join(loreDir, 'graph')}`);
    console.log(`  Project:    ${projectName}`);
    console.log(`  Ecosystem:  ${ecosystem}`);
    console.log('');
    console.log('  Knowledge Graph');
    console.log(`    Nodes:    ${stats.nodeCount}`);
    console.log(`    Edges:    ${stats.edgeCount}`);
    if (Object.keys(stats.typeBreakdown).length > 0) {
        console.log('    Types:');
        for (const [typeName, count] of Object.entries(stats.typeBreakdown)) {
            console.log(`      ${typeName}: ${count}`);
        }
    }
    console.log('');
    console.log('  Code Graph');
    console.log(`    Symbols:   ${stats.codeSymbolCount}`);
    console.log(`    Relations: ${stats.codeRelationCount}`);
    if (stats.codeSymbolCount === 0) {
        console.log('    (run "lore index" to import from GitNexus)');
    }
    console.log('');
    console.log('  Sync');
    console.log(`    WAL pending:   ${syncStatus.walPending} entries`);
    console.log(`    Last sync:     ${syncStatus.lastSync === '1970-01-01T00:00:00.000Z' ? 'never' : syncStatus.lastSync}`);
    console.log(`    Remote:        ${syncStatus.hasAdapter ? 'connected' : 'offline (no adapter configured)'}`);
    console.log(`    Auto-sync:     ${syncStatus.isAutoSyncing ? 'running' : 'off'}`);
    console.log('');

    await graph.close();
}

/* ─── Command: doctor ─────────────────────────────────────────── */

/**
 * doctorCommand — Diagnose configuration and connectivity.
 *
 * Purpose: Checks all components of the Lore system and reports
 *   their health status.
 *
 * @param _args - CLI arguments (unused).
 *
 * Side Effects: Reads filesystem, optionally tests network.
 */
export async function doctorCommand(_args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');
    let issues = 0;

    console.log('');
    console.log('  @groundfloor/lore — Doctor');
    console.log('  ─────────────────────────────────────');

    // Check 1: .lore/ directory exists
    if (fs.existsSync(loreDir)) {
        console.log('  ✓ .lore/ directory exists');
    } else {
        console.log('  ✗ .lore/ directory not found — run "lore init"');
        issues++;
    }

    // Check 2: Kùzu graph exists
    const graphDir = path.join(loreDir, 'graph');
    if (fs.existsSync(graphDir)) {
        console.log('  ✓ Kùzu graph directory exists');
    } else {
        console.log('  ✗ Kùzu graph not found — run "lore init"');
        issues++;
    }

    // Check 3: Graph is readable and has data
    if (fs.existsSync(loreDir)) {
        try {
            const graph = new LocalGraph(basePath);
            await graph.initialize();
            const stats = await graph.getStats();
            console.log(`  ✓ Graph readable: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
            await graph.close();
        } catch (graphError) {
            console.log(`  ✗ Graph error: ${(graphError as Error).message}`);
            issues++;
        }
    }

    // Check 4: Project registry
    const registryPath = path.join(os.homedir(), '.groundfloor', 'projects.json');
    if (fs.existsSync(registryPath)) {
        try {
            const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
            const projectCount = Object.keys(registry.projects ?? {}).length;
            console.log(`  ✓ Project registry: ${projectCount} projects registered`);
        } catch {
            console.log('  ✗ Project registry exists but is malformed');
            issues++;
        }
    } else {
        console.log('  ⚠ Project registry not found (~/.groundfloor/projects.json)');
    }

    // Check 5: MCP config (Antigravity)
    // Antigravity uses { serverUrl: "..." } format (no type field).
    const antigravityConfigPath = path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
    if (fs.existsSync(antigravityConfigPath)) {
        try {
            const mcpConfig = JSON.parse(fs.readFileSync(antigravityConfigPath, 'utf-8'));
            if (mcpConfig.mcpServers?.['groundfloor-lore']) {
                const loreEntry = mcpConfig.mcpServers['groundfloor-lore'];
                const configuredUrl = loreEntry.serverUrl ?? loreEntry.url ?? null;
                if (configuredUrl) {
                    console.log(`  ✓ Antigravity MCP config: groundfloor-lore → ${configuredUrl}`);
                    if (loreEntry.url && !loreEntry.serverUrl) {
                        console.log('  ⚠ Antigravity uses "serverUrl" (not "url") — run "lore setup" to fix');
                        issues++;
                    }
                } else {
                    console.log('  ✗ Antigravity MCP config: no serverUrl or command configured');
                    issues++;
                }
            } else {
                console.log('  ⚠ Antigravity MCP config exists but no groundfloor-lore entry');
            }
        } catch {
            console.log('  ✗ Antigravity MCP config is malformed');
            issues++;
        }
    } else {
        console.log('  ⚠ Antigravity MCP config not found');
    }

    // Check 6: WAL file
    const walPath = path.join(loreDir, 'sync.wal');
    if (fs.existsSync(walPath)) {
        const syncEngine = new SyncEngine(null as unknown as LocalGraph, loreDir, null);
        const walPending = syncEngine.getStatus().walPending;
        console.log(`  ✓ WAL file exists: ${walPending} pending entries`);
    } else {
        console.log('  ⚠ WAL file not found (will be created on first write)');
    }

    // Check 7: Node.js version
    const nodeVersion = process.versions.node;
    const majorVersion = parseInt(nodeVersion.split('.')[0], 10);
    if (majorVersion >= 20) {
        console.log(`  ✓ Node.js version: v${nodeVersion}`);
    } else {
        console.log(`  ✗ Node.js version: v${nodeVersion} (requires ≥20)`);
        issues++;
    }

    // Check 8: GitNexus CLI
    if (isGitNexusAvailable()) {
        const repos = listGitNexusRepos();
        console.log(`  ✓ GitNexus CLI available: ${repos.length} repo(s) indexed`);
    } else {
        console.log('  ✗ GitNexus CLI not found — install with: npm install -g gitnexus');
        issues++;
    }

    // Summary
    console.log('');
    if (issues === 0) {
        console.log('  All checks passed! ✓');
    } else {
        console.log(`  ${issues} issue${issues > 1 ? 's' : ''} found.`);
    }
    console.log('');
}

/* ─── Command: setup ─────────────────────────────────────────── */

/**
 * setupCommand — One-command onboarding for Groundfloor Lore.
 *
 * Purpose:
 *   Automates the full setup process: graph initialization, daemon installation,
 *   and IDE configuration. Transforms a 10-step manual process into one command.
 *
 * @param args - CLI arguments. Supports '--team' for team lead setup (future).
 *
 * Side Effects:
 *   - Creates ~/.groundfloor/.lore/graph/ (Kùzu database)
 *   - Installs LaunchAgent at ~/Library/LaunchAgents/com.groundfloor.lore.plist
 *   - Starts the Lore HTTP daemon on port 3847
 *   - Writes MCP config to detected IDEs (Cursor, Antigravity)
 *
 * Error Behavior: Prints per-step results. Non-fatal errors are collected.
 * Idempotent: Safe to run multiple times — skips already-completed steps.
 */
export async function setupCommand(args: string[]): Promise<void> {
    console.log('');
    console.log('  @groundfloor/lore — Setup');
    console.log('  ═══════════════════════════════════════');
    console.log('');

    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');
    const logsDir = path.join(basePath, 'logs');
    let steps = 0;
    let issues = 0;

    // ─── Step 1: Initialize graph ───────────────────────────────
    if (fs.existsSync(path.join(loreDir, 'graph'))) {
        console.log('  ✓ Graph already exists at ~/.groundfloor/.lore/graph/');
    } else {
        try {
            fs.mkdirSync(loreDir, { recursive: true });
            const graph = new LocalGraph(basePath);
            await graph.initialize();
            await graph.close();
            console.log('  ✓ Kùzu graph initialized at ~/.groundfloor/.lore/graph/');
        } catch (graphError) {
            console.error(`  ✗ Failed to initialize graph: ${(graphError as Error).message}`);
            issues++;
        }
    }
    steps++;

    // ─── Step 2: Create logs directory ──────────────────────────
    fs.mkdirSync(logsDir, { recursive: true });
    steps++;

    // ─── Step 3: Install LaunchAgent (macOS only) ───────────────
    if (process.platform === 'darwin') {
        const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.groundfloor.lore.plist');
        const nodePath = process.execPath;
        const serverPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'mcp', 'server.js');

        const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.groundfloor.lore</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${serverPath}</string>
        <string>--http</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>${logsDir}/lore-mcp.log</string>
    <key>StandardOutPath</key>
    <string>${logsDir}/lore-mcp.out</string>
    <key>WorkingDirectory</key>
    <string>${basePath}</string>
</dict>
</plist>
`;

        if (fs.existsSync(plistPath)) {
            console.log('  ✓ LaunchAgent already installed');
        } else {
            try {
                fs.writeFileSync(plistPath, plistContent, 'utf-8');
                console.log('  ✓ LaunchAgent installed at ~/Library/LaunchAgents/');
            } catch (plistError) {
                console.error(`  ✗ Failed to install LaunchAgent: ${(plistError as Error).message}`);
                issues++;
            }
        }
        steps++;

        // ─── Step 4: Start daemon ───────────────────────────────────
        try {
            const isRunning = isDaemonRunning();
            if (isRunning) {
                console.log('  ✓ Daemon already running on port 3847');
            } else {
                execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });
                // Wait for daemon to start
                await new Promise(resolve => setTimeout(resolve, 3000));
                if (isDaemonRunning()) {
                    console.log('  ✓ Daemon started on port 3847');
                } else {
                    console.log('  ⚠ Daemon loaded but may need a moment — check: curl http://127.0.0.1:3847/health');
                }
            }
        } catch (daemonError) {
            console.error(`  ✗ Failed to start daemon: ${(daemonError as Error).message}`);
            issues++;
        }
        steps++;
    } else {
        console.log('  ⚠ LaunchAgent is macOS-only. Start the daemon manually:');
        console.log('    node dist/mcp/server.js --http');
        steps += 2;
    }

    // ─── Step 5: Detect and configure IDEs ──────────────────────
    // NOTE: Cursor and Antigravity use different MCP config schemas.
    //   Cursor:      { type: "http", url: "..." }
    //   Antigravity:  { serverUrl: "..." }  (no type field)
    const LORE_MCP_URL = 'http://127.0.0.1:3847/mcp';

    // Cursor
    const cursorDir = path.join(os.homedir(), '.cursor');
    if (fs.existsSync(cursorDir)) {
        try {
            const cursorConfig = path.join(cursorDir, 'mcp.json');
            const cursorMcpEntry = { type: 'http', url: LORE_MCP_URL };
            writeMcpConfig(cursorConfig, 'groundfloor-lore', cursorMcpEntry);
            console.log('  ✓ Cursor configured — ~/.cursor/mcp.json');
        } catch (cursorError) {
            console.error(`  ✗ Cursor config failed: ${(cursorError as Error).message}`);
            issues++;
        }
    } else {
        console.log('  · Cursor not detected — skipping');
    }

    // Antigravity
    const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity');
    if (fs.existsSync(antigravityDir)) {
        try {
            const agConfig = path.join(antigravityDir, 'mcp_config.json');
            const antigravityMcpEntry = { serverUrl: LORE_MCP_URL };
            writeMcpConfig(agConfig, 'groundfloor-lore', antigravityMcpEntry);
            console.log('  ✓ Antigravity configured — ~/.gemini/antigravity/mcp_config.json');
        } catch (agError) {
            console.error(`  ✗ Antigravity config failed: ${(agError as Error).message}`);
            issues++;
        }
    } else {
        console.log('  · Antigravity not detected — skipping');
    }
    steps++;

    // ─── Step 6: Install Lore Protocol rules per IDE ────────────
    const protocolSource = path.resolve(
        path.dirname(new URL(import.meta.url).pathname), '..', '..', 'docs', 'LORE_PROTOCOL.md'
    );
    let protocolContent = '';
    try {
        protocolContent = fs.readFileSync(protocolSource, 'utf-8');
    } catch {
        // Fallback: try from package root
        try {
            const altPath = path.resolve(
                path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'docs', 'LORE_PROTOCOL.md'
            );
            protocolContent = fs.readFileSync(altPath, 'utf-8');
        } catch {
            console.log('  ⚠ LORE_PROTOCOL.md not found — skipping rules installation');
        }
    }

    if (protocolContent) {
        let rulesInstalled = 0;

        // Cursor — .mdc format with yaml frontmatter
        const cursorRulesDir = path.join(os.homedir(), '.cursor', 'rules');
        if (fs.existsSync(path.join(os.homedir(), '.cursor'))) {
            try {
                fs.mkdirSync(cursorRulesDir, { recursive: true });
                const cursorRule = `---
description: Lore Intelligence Protocol — auto-consult knowledge graph and auto-store learnings
globs:
alwaysApply: true
---

${protocolContent}`;
                const cursorRulePath = path.join(cursorRulesDir, 'lore-protocol.mdc');
                fs.writeFileSync(cursorRulePath, cursorRule, 'utf-8');
                console.log('  ✓ Cursor rules installed — ~/.cursor/rules/lore-protocol.mdc');
                rulesInstalled++;
            } catch (cursorRuleError) {
                console.error(`  ✗ Cursor rules failed: ${(cursorRuleError as Error).message}`);
                issues++;
            }
        }

        // Antigravity — append section to GEMINI.md
        const geminiMdPath = path.join(os.homedir(), '.gemini', 'GEMINI.md');
        if (fs.existsSync(path.join(os.homedir(), '.gemini'))) {
            try {
                const sectionHeader = '14. LORE INTELLIGENCE PROTOCOL (MANDATORY)';
                let existingGemini = '';
                try { existingGemini = fs.readFileSync(geminiMdPath, 'utf-8'); } catch { /* new file */ }

                if (existingGemini.includes(sectionHeader)) {
                    console.log('  ✓ Antigravity rules already in GEMINI.md');
                } else {
                    const geminiSection = `
────────────────────────────────────────
${sectionHeader}
────────────────────────────────────────
Applies when the \`groundfloor-lore\` MCP server is available.

${protocolContent}
────────────────────────────────────────
`;
                    // Insert before END OF GLOBAL RULE, or append
                    if (existingGemini.includes('END OF GLOBAL RULE')) {
                        const updated = existingGemini.replace('END OF GLOBAL RULE', geminiSection + '\nEND OF GLOBAL RULE');
                        fs.writeFileSync(geminiMdPath, updated, 'utf-8');
                    } else {
                        fs.appendFileSync(geminiMdPath, geminiSection, 'utf-8');
                    }
                    console.log('  ✓ Antigravity rules appended to ~/.gemini/GEMINI.md');
                }
                rulesInstalled++;
            } catch (agRuleError) {
                console.error(`  ✗ Antigravity rules failed: ${(agRuleError as Error).message}`);
                issues++;
            }
        }

        // Claude Code — append to CLAUDE.md
        const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
        if (fs.existsSync(path.join(os.homedir(), '.claude'))) {
            try {
                const claudeHeader = 'LORE INTELLIGENCE PROTOCOL';
                let existingClaude = '';
                try { existingClaude = fs.readFileSync(claudeMdPath, 'utf-8'); } catch { /* new file */ }

                if (existingClaude.includes(claudeHeader)) {
                    console.log('  ✓ Claude Code rules already in CLAUDE.md');
                } else {
                    fs.appendFileSync(claudeMdPath, `\n\n# ${claudeHeader}\n\n${protocolContent}`, 'utf-8');
                    console.log('  ✓ Claude Code rules appended to ~/.claude/CLAUDE.md');
                }
                rulesInstalled++;
            } catch (claudeError) {
                console.error(`  ✗ Claude Code rules failed: ${(claudeError as Error).message}`);
                issues++;
            }
        }

        if (rulesInstalled === 0) {
            console.log('  · No supported IDEs detected for rules — add manually:');
            console.log(`    See: ${protocolSource}`);
        }
    }
    steps++;

    // ─── Step 7: Global git hooks (auto-reindex on commit) ──────
    const globalHooksDir = path.join(basePath, 'hooks');
    const hookSource = path.resolve(
        path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'hooks', 'post-commit'
    );

    try {
        fs.mkdirSync(globalHooksDir, { recursive: true });

        // Copy hook to global hooks dir
        if (fs.existsSync(hookSource)) {
            fs.copyFileSync(hookSource, path.join(globalHooksDir, 'post-commit'));
            fs.chmodSync(path.join(globalHooksDir, 'post-commit'), 0o755);

            // Set global git hooks path
            const currentHooksPath = (() => {
                try { return execSync('git config --global core.hooksPath', { encoding: 'utf-8' }).trim(); } catch { return ''; }
            })();

            if (currentHooksPath === globalHooksDir || currentHooksPath === `~/.groundfloor/hooks` || currentHooksPath.endsWith('.groundfloor/hooks')) {
                console.log('  ✓ Global git hooks already configured');
            } else {
                execSync(`git config --global core.hooksPath "${globalHooksDir}"`, { stdio: 'ignore' });
                console.log('  ✓ Global git hooks installed — auto-reindex on commit');
            }
        } else {
            console.log('  ⚠ Hook script not found — skipping git hooks');
        }
    } catch (hookError) {
        console.error(`  ✗ Git hooks failed: ${(hookError as Error).message}`);
        issues++;
    }
    steps++;

    // ─── Summary ────────────────────────────────────────────────
    console.log('');
    console.log('  ═══════════════════════════════════════');
    if (issues === 0) {
        console.log('  ✅ Setup complete!');
        console.log('');
        console.log('  Next steps:');
        console.log('    cd ~/your-project && gitnexus analyze .   # Index a project');
        console.log('    lore index                                # Import into Lore');
        console.log('    lore join gf://host:port/ns?token=...     # Join a team (optional)');
    } else {
        console.log(`  ⚠ Setup completed with ${issues} issue(s). Run 'lore doctor' for details.`);
    }
    console.log('');
}

/* ─── Command: join ──────────────────────────────────────────── */

/**
 * joinCommand — Connect to a team's SurrealDB for shared knowledge sync.
 *
 * Purpose:
 *   Parses a join URL, extracts connection parameters, saves credentials,
 *   and tests the connection. One command to enable team sync.
 *
 * @param args - CLI arguments. First arg must be a gf:// URL.
 *
 * Join URL Format:
 *   gf://hostname:port/namespace?token=BASE64_PASSWORD
 *   Example: gf://192.168.1.50:8001/groundfloor?token=cm9vdDEyMw==
 *
 * Side Effects:
 *   - Creates ~/.groundfloor/infra/surrealdb/.env with connection credentials.
 *
 * Error Behavior: Validates URL format and tests connection before saving.
 * Idempotent: Overwrites existing .env if run again.
 */
export async function joinCommand(args: string[]): Promise<void> {
    const joinUrl = args[0];

    if (!joinUrl) {
        console.error('❌ Usage: lore join gf://hostname:port/namespace?token=BASE64_PASSWORD');
        console.error('');
        console.error('  Example:');
        console.error('    lore join gf://192.168.1.50:8001/groundfloor?token=cm9vdDEyMw==');
        process.exit(1);
    }

    // ─── Parse join URL ─────────────────────────────────────────
    const parsed = parseJoinUrl(joinUrl);
    if (!parsed) {
        console.error('❌ Invalid join URL format.');
        console.error('  Expected: gf://hostname:port/namespace?token=BASE64_PASSWORD');
        process.exit(1);
    }

    const { host, port, namespace, password } = parsed;

    console.log('');
    console.log('  @groundfloor/lore — Team Join');
    console.log('  ═══════════════════════════════════════');
    console.log(`  Host:      ${host}:${port}`);
    console.log(`  Namespace: ${namespace}`);
    console.log('');

    // ─── Test connection ────────────────────────────────────────
    const surrealUrl = `ws://${host}:${port}/rpc`;
    const healthUrl = `http://${host}:${port}/health`;

    process.stdout.write('  Testing connection... ');
    const healthy = await testHttpHealth(healthUrl);
    if (!healthy) {
        console.log('❌');
        console.error(`  Could not reach SurrealDB at ${host}:${port}`);
        console.error('  Check that the team database is running and accessible.');
        process.exit(1);
    }
    console.log('✓');

    // ─── Save credentials ───────────────────────────────────────
    const basePath = resolveGraphBasePath();
    const envDir = path.join(basePath, 'infra', 'surrealdb');
    const envPath = path.join(envDir, '.env');

    fs.mkdirSync(envDir, { recursive: true });
    const envContent = `SURREAL_ROOT_PASS=${password}\nSURREAL_URL=${surrealUrl}\nSURREAL_NAMESPACE=${namespace}\n`;
    fs.writeFileSync(envPath, envContent, 'utf-8');
    console.log('  ✓ Credentials saved to ~/.groundfloor/infra/surrealdb/.env');

    // ─── Restart daemon to pick up new credentials ──────────────
    if (process.platform === 'darwin') {
        const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.groundfloor.lore.plist');
        if (fs.existsSync(plistPath)) {
            try {
                execSync(`launchctl unload "${plistPath}"`, { stdio: 'ignore' });
                execSync(`launchctl load "${plistPath}"`, { stdio: 'ignore' });
                await new Promise(resolve => setTimeout(resolve, 3000));
                console.log('  ✓ Daemon restarted with team sync enabled');
            } catch {
                console.log('  ⚠ Could not restart daemon — restart manually: launchctl unload/load');
            }
        }
    }

    console.log('');
    console.log('  ═══════════════════════════════════════');
    console.log('  ✅ Joined team!');
    console.log('  Knowledge will sync automatically on next daemon restart.');
    console.log('  Run "lore status" to verify sync status.');
    console.log('');
}

/* ─── Shared Utilities ───────────────────────────────────────── */

/**
 * isDaemonRunning — Check if the Lore HTTP daemon is responding on port 3847.
 *
 * @returns true if daemon responds to /health, false otherwise.
 *
 * Error Behavior: Returns false on any network error.
 * Determinism: Non-deterministic (depends on network state).
 */
function isDaemonRunning(): boolean {
    try {
        execSync('curl -s --max-time 2 http://127.0.0.1:3847/health', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * writeMcpConfig — Merge a Lore MCP server entry into an IDE's config file.
 *
 * Purpose:
 *   Reads existing config (if any), adds/updates the groundfloor-lore entry,
 *   and writes back. Does not overwrite other MCP server entries.
 *
 * @param configPath - Absolute path to the IDE's MCP config JSON file.
 * @param serverName - MCP server name key (e.g., "groundfloor-lore").
 * @param entry - The MCP server config object to set.
 *
 * Side Effects: Writes to filesystem.
 * Idempotent: Safe to call multiple times.
 */
function writeMcpConfig(
    configPath: string,
    serverName: string,
    entry: Record<string, string>,
): void {
    let config: Record<string, unknown> = { mcpServers: {} };

    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch {
            // Corrupted config — start fresh
        }
    }

    if (!config['mcpServers'] || typeof config['mcpServers'] !== 'object') {
        config['mcpServers'] = {};
    }

    (config['mcpServers'] as Record<string, unknown>)[serverName] = entry;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n', 'utf-8');
}

/**
 * parseJoinUrl — Parse a gf:// join URL into connection parameters.
 *
 * @param url - Join URL in the format gf://host:port/namespace?token=BASE64_PASS
 * @returns Parsed parameters or null if invalid.
 *
 * Determinism: Deterministic.
 */
function parseJoinUrl(url: string): { host: string; port: string; namespace: string; password: string } | null {
    try {
        // Replace gf:// with http:// for URL parsing
        const parsed = new URL(url.replace(/^gf:\/\//, 'http://'));
        const host = parsed.hostname;
        const port = parsed.port || '8001';
        const namespace = parsed.pathname.replace(/^\//, '') || 'groundfloor';
        const tokenBase64 = parsed.searchParams.get('token');

        if (!host || !tokenBase64) return null;

        const password = Buffer.from(tokenBase64, 'base64').toString('utf-8');
        if (!password) return null;

        return { host, port, namespace, password };
    } catch {
        return null;
    }
}

/**
 * testHttpHealth — Test if a URL returns a successful HTTP response.
 *
 * @param url - HTTP URL to test.
 * @returns Promise resolving to true if reachable, false otherwise.
 *
 * Error Behavior: Returns false on timeout, connection refused, etc.
 * Determinism: Non-deterministic.
 */
function testHttpHealth(url: string): Promise<boolean> {
    return new Promise((resolve) => {
        const request = http.get(url, { timeout: 5000 }, (response) => {
            resolve(response.statusCode === 200);
        });
        request.on('error', () => resolve(false));
        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });
    });
}

/* ─── Command: lint ───────────────────────────────────────────── */

/**
 * lintCommand — Perform health checks manually on the graph.
 *
 * @param _args - CLI arguments.
 *
 * Side Effects: Reads from Kùzu database. Prints to stdout/stderr.
 */
export async function lintCommand(_args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    if (!fs.existsSync(loreDir)) {
        console.error('❌ No .lore/ directory found. Run "lore init" first.');
        process.exit(1);
    }

    const graph = new LocalGraph(basePath);
    await graph.initialize();

    console.log(`→ Linting graph at ${loreDir}...`);
    const warnings = await graph.lintGraph();
    
    await graph.close();

    if (warnings.length > 0) {
        console.error('');
        console.error('  ⚠️ LINT WARNINGS FOUND:');
        for (const warning of warnings) {
            console.error(`    - ${warning}`);
        }
        console.error('');
        process.exit(1);
    } else {
        console.log('  ✓ No lint warnings found. Graph is healthy!');
        process.exit(0);
    }
}

/* ─── Command: audit ──────────────────────────────────────────── */

/**
 * auditCommand — Detects MDM Schema Drift.
 *
 * Purpose:
 *   Validates the current codebase against Lore Master Data Models.
 *   Fails if strict JSON metadata fields are missing from TS code.
 */
export async function auditCommand(_args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const graph = new LocalGraph(basePath);
    await graph.initialize();
    
    console.log(`→ Auditing codebase against Master Data Models...`);
    const allNodes = await graph.listNodes();
    const schemas = allNodes.filter(n => n.type === 'schema');

    if (schemas.length === 0) {
        console.log('  No specific MDM schemas found to audit. Pass.');
        await graph.close();
        process.exit(0);
    }

    const repoRoot = findRepoRoot();
    const tsFiles = findTsFiles(repoRoot);
    let driftDetected = false;

    for (const schema of schemas) {
        if (!schema.metadata) continue;
        let meta;
        try { meta = JSON.parse(schema.metadata); } catch { continue; }
        if (!meta.fields || !Array.isArray(meta.fields)) continue;

        let schemaSymbolFound = false;
        let missingFields = [];
        const targetLabel = schema.label;
        
        for (const file of tsFiles) {
            const content = fs.readFileSync(file, 'utf-8');
            const declarationRegex = new RegExp(`(?:interface|class|type)\\s+${targetLabel}\\b`, 'g');
            if (declarationRegex.test(content)) {
                schemaSymbolFound = true;
                for (const field of meta.fields) {
                    const fieldRegex = new RegExp(`\\b${field.name}\\b`, 'g');
                    if (!fieldRegex.test(content)) {
                        missingFields.push(field.name);
                    }
                }
                break;
            }
        }
        
        if (schemaSymbolFound && missingFields.length > 0) {
            console.error(`  ❌ DRIFT DETECTED: [${targetLabel}] is missing official MDM fields: ${missingFields.join(', ')}`);
            driftDetected = true;
        } else if (schemaSymbolFound) {
            console.log(`  ✓ SCHEMA ALIGNED: [${targetLabel}] perfectly matches ecosystem MDM.`);
        }
    }

    await graph.close();

    if (driftDetected) {
        console.error('');
        console.error('  ⚠️ SCHEMA DRIFT VIOLATION. Please correct your data models to align with the Lore Master Data Model.');
        process.exit(1);
    } else {
        console.log('  ✓ Codebase models are strictly aligned with MDM. Good to push!');
        process.exit(0);
    }
}

function findTsFiles(dir: string, fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            if (file === 'node_modules' || file === '.git' || file === 'dist') continue;
            findTsFiles(filePath, fileList);
        } else {
            if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
                fileList.push(filePath);
            }
        }
    }
    return fileList;
}

/**
 * ingestFilesCommand — Materialize CodeFile nodes from existing CodeSymbols.
 *
 * V2.1: the developer lore has CodeSymbols but zero CodeFile nodes, so
 * queries like "which files does this decision touch?" are impossible
 * until we model files. This walks every CodeSymbol, groups by filePath,
 * and creates one CodeFile per distinct path plus a FileContains edge
 * from the file to each of its symbols.
 *
 * Idempotent — safe to re-run after pulling more symbols via `lore index`.
 */
export async function ingestFilesCommand(_args: string[]): Promise<void> {
    const graph = new LocalGraph(path.join(os.homedir(), '.groundfloor'));
    await graph.initialize();
    console.log('');
    console.log('  Ingesting files from existing CodeSymbols…');
    const stats = await graph.ingestFilesFromSymbols();
    console.log(`  ✓ ${stats.filesCreated} CodeFile node(s) synthesized`);
    console.log(`  ✓ ${stats.edgesCreated} FileContains edge(s) created`);
    await graph.close();
    console.log('');
    console.log('  Next: `lore reconnect` to link LoreNode knowledge to these files via semantic similarity.');
}

/**
 * reconnectCommand — Run the V2.1 semantic reconnection pass.
 *
 *   lore reconnect                          # dry-run (default)
 *   lore reconnect --apply                  # prune + insert
 *   lore reconnect --k 8 --threshold 0.55   # experiment with params
 */
export async function reconnectCommand(args: string[]): Promise<void> {
    const { LocalGraph } = await import('../engines/localGraph.js');
    const { VerbatimStore } = await import('../engines/verbatimStore.js');
    const { reconnectGraph } = await import('../engines/reconnect.js');

    const apply = args.includes('--apply');
    const kIndex = args.indexOf('--k');
    const tIndex = args.indexOf('--threshold');
    const k = kIndex >= 0 ? parseInt(args[kIndex + 1], 10) : 5;
    const threshold = tIndex >= 0 ? parseFloat(args[tIndex + 1]) : 0.65;

    const basePath = path.join(os.homedir(), '.groundfloor');
    const graph = new LocalGraph(basePath);
    const verbatim = new VerbatimStore(basePath);
    await graph.initialize();

    console.log('');
    console.log(`  Reconnect pass — k=${k}, threshold=${threshold}, mode=${apply ? 'APPLY' : 'dry-run'}`);
    const result = await reconnectGraph(graph, verbatim, { k, minSim: threshold, dryRun: !apply });

    console.log(`  ✓ Scanned ${result.candidatesScanned} node(s); embeddings added: ${result.embeddingsAdded}`);
    const buckets = Object.entries(result.distribution).sort((a, b) => Number(b[0]) - Number(a[0]));
    if (buckets.length) {
        console.log('  Similarity distribution (all neighbors, before threshold):');
        for (const [bucket, count] of buckets.slice(0, 10)) {
            const bar = '█'.repeat(Math.min(40, Math.round(count / 2)));
            console.log(`    ≥ ${bucket.padStart(4)}  ${bar}  (${count})`);
        }
    }
    console.log(`  ✓ Proposed edges at threshold ${threshold}: ${result.proposedEdges.length}`);

    if (apply) {
        console.log(`  ✓ Pruned ${result.inferredPruned} prior inferred edge(s)`);
        console.log(`  ✓ Inserted ${result.edgesInserted} new semantic_neighbor edge(s)`);
    } else {
        console.log('');
        console.log('  (dry run — nothing was written. Re-run with --apply to commit.)');
    }
    await graph.close();
}
