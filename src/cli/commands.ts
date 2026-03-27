/**
 * commands.ts — CLI Command Handlers.
 *
 * Purpose:
 *   Implements the five CLI commands: init, serve, sync, status, doctor.
 *   Each command creates its own LocalGraph and SyncEngine instances
 *   as needed — the CLI is a thin orchestration layer.
 *
 * Side Effects: Filesystem writes (init), stdio (serve), network (sync).
 * Error Behavior: Each command catches errors and exits with code 1.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
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
    const antigravityConfigPath = path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
    if (fs.existsSync(antigravityConfigPath)) {
        try {
            const mcpConfig = JSON.parse(fs.readFileSync(antigravityConfigPath, 'utf-8'));
            if (mcpConfig.mcpServers?.['groundfloor-lore']) {
                const serverArgs = mcpConfig.mcpServers['groundfloor-lore'].args ?? [];
                const serverPath = serverArgs[0] ?? 'unknown';
                const serverExists = fs.existsSync(serverPath);
                if (serverExists) {
                    console.log(`  ✓ Antigravity MCP config: groundfloor-lore → ${path.basename(serverPath)}`);
                } else {
                    console.log(`  ✗ Antigravity MCP config: server.js not found at ${serverPath}`);
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
