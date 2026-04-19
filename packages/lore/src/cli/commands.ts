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
// `lore index` + `lore doctor` reach the GitNexus-backed code indexer
// through the developer plugin's opaque api. See src/plugins/developer/
// codeIndexer.ts for the implementation.
import type { DeveloperApi, IndexResult } from '@lore-plugin-developer/api.js';

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

    const { ConfigManager } = await import('../config/configManager.js');
    const { PluginRegistry } = await import('../plugins/registry.js');
    const graph = new LocalGraph(basePath);
    const registry = new PluginRegistry(new ConfigManager(loreDir));
    registry.boot();
    await graph.initialize();
    await registry.registerSchemas(graph.createPluginGraphContext());

    const devPlugin = registry.active().find((p) => p.name === 'developer');
    const devApi = devPlugin?.api as DeveloperApi | undefined;
    if (!devApi) {
        console.error('❌ `lore index` requires the "developer" plugin. Add "developer" to .lore/config.json plugins[].');
        await graph.close();
        process.exit(1);
    }

    const specificRepo = args[0];

    if (specificRepo) {
        const repoEntry = devApi.getGitNexusRepo(specificRepo);
        if (!repoEntry) {
            console.error(`❌ Repository '${specificRepo}' not found in GitNexus registry.`);
            console.error('  Available repos:');
            for (const repo of devApi.listGitNexusRepos()) {
                console.error(`    - ${repo.name} (${repo.stats.nodes} symbols)`);
            }
            await graph.close();
            process.exit(1);
        }

        console.log(`→ Indexing '${specificRepo}' from GitNexus...`);
        const result = await devApi.importFromGitNexus(repoEntry);
        printIndexResult(result);
    } else {
        const repos = devApi.listGitNexusRepos();
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
            const result = await devApi.importFromGitNexus(repo);
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
function printIndexResult(result: IndexResult): void {
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

    // Check 3: Graph is readable. If the daemon is up it holds Kùzu's
    // single-writer lock, so we can't open it directly — defer to the
    // daemon's HTTP surface for node/edge counts via /api/storage (which
    // also gives us disk-usage free). If the daemon is down, open the
    // DB directly as before.
    if (fs.existsSync(loreDir)) {
        const tokenPath = path.join(os.homedir(), '.groundfloor', 'auth.token');
        const daemonUp = (await probeHttp('/api/health', null)) === 200;
        if (daemonUp && fs.existsSync(tokenPath)) {
            try {
                const token = fs.readFileSync(tokenPath, 'utf-8').trim();
                const topology = await probeJson('/api/topology', token);
                if (topology && Array.isArray(topology.nodes) && Array.isArray(topology.edges)) {
                    console.log(`  ✓ Graph (via daemon): ${topology.nodes.length} nodes, ${topology.edges.length} edges`);
                } else {
                    console.log('  ⚠ Daemon up but /api/topology returned unexpected shape');
                }
            } catch (err) {
                console.log(`  ⚠ Graph check via daemon failed: ${(err as Error).message}`);
            }
        } else {
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

    // Check 8: Active plugins + per-plugin health (developer plugin owns
    // the GitNexus-availability check it used to drive in core).
    try {
        const { ConfigManager } = await import('../config/configManager.js');
        const { PluginRegistry } = await import('../plugins/registry.js');
        const registry = new PluginRegistry(new ConfigManager(loreDir));
        registry.boot();
        const graph = new LocalGraph(basePath);
        await graph.initialize();
        await registry.registerSchemas(graph.createPluginGraphContext());
        const active = registry.active().map((p) => p.name);
        console.log(`  ✓ Active plugins: ${active.join(', ') || '(none)'}`);

        const devPlugin = registry.active().find((p) => p.name === 'developer');
        const devApi = devPlugin?.api as DeveloperApi | undefined;
        if (devApi) {
            if (devApi.isGitNexusAvailable()) {
                const repos = devApi.listGitNexusRepos();
                console.log(`  ✓ GitNexus CLI available: ${repos.length} repo(s) indexed`);
            } else {
                console.log('  ✗ GitNexus CLI not found — install with: npm install -g gitnexus');
                issues++;
            }
        }
        await graph.close();
    } catch (pluginErr) {
        console.log(`  ⚠ Plugin health check failed: ${(pluginErr as Error).message}`);
    }

    // ─── S10: Security posture ─────────────────────────────────
    console.log('');
    console.log('  Security posture');
    console.log('  ─────────────────────────────────────');
    const dataHome = path.join(os.homedir(), '.groundfloor');

    // S1 — filesystem permissions
    try {
        const dhStat = fs.statSync(dataHome);
        const dhMode = dhStat.mode & 0o777;
        if (dhMode === 0o700) {
            console.log('  ✓ Data home permissions (~/.groundfloor) = 0700');
        } else {
            console.log(`  ✗ Data home permissions = 0${dhMode.toString(8)} (expected 0700). Daemon restart will self-heal.`);
            issues++;
        }
    } catch {
        console.log('  ⚠ Data home ~/.groundfloor not found');
    }
    try {
        const tokenPath = path.join(dataHome, 'auth.token');
        if (fs.existsSync(tokenPath)) {
            const tokMode = fs.statSync(tokenPath).mode & 0o777;
            if (tokMode === 0o600) {
                console.log('  ✓ Auth token file (0600)');
            } else {
                console.log(`  ✗ Auth token mode = 0${tokMode.toString(8)} (expected 0600)`);
                issues++;
            }
        } else {
            console.log('  ⚠ Auth token not yet generated (daemon not booted)');
        }
    } catch { /* ignore */ }

    // S3 — daemon reachable + correctly gating unauthenticated requests
    try {
        const tokenPath = path.join(dataHome, 'auth.token');
        if (fs.existsSync(tokenPath)) {
            const token = fs.readFileSync(tokenPath, 'utf-8').trim();
            const healthStatus = await probeHttp('/api/health', null);
            if (healthStatus === 200) {
                console.log('  ✓ Daemon /api/health reachable (no auth)');
            } else {
                console.log(`  ⚠ /api/health status=${healthStatus ?? 'unreachable'} — daemon may not be running`);
            }
            const configUnauth = await probeHttp('/api/config', null);
            if (configUnauth === 401) {
                console.log('  ✓ /api/config rejects unauthenticated requests (401)');
            } else if (configUnauth == null) {
                console.log('  ⚠ Daemon unreachable — skipping auth-enforcement check');
            } else {
                console.log(`  ✗ /api/config without auth returned ${configUnauth} (expected 401) — SECURITY GAP`);
                issues++;
            }
            const configAuth = await probeHttp('/api/config', token);
            if (configAuth === 200) {
                console.log('  ✓ /api/config accepts valid bearer (200)');
            } else if (configAuth != null) {
                console.log(`  ✗ /api/config with valid bearer returned ${configAuth} (expected 200)`);
                issues++;
            }
        }
    } catch (authErr) {
        console.log(`  ⚠ Auth posture check failed: ${(authErr as Error).message}`);
    }

    // S6 — encryption keyring per workspace (key presence = opt-in ready)
    try {
        const { hasWorkspaceKey } = await import('../security/keyring.js');
        const wsRegistryPath = path.join(dataHome, 'workspaces.json');
        if (fs.existsSync(wsRegistryPath)) {
            const reg = JSON.parse(fs.readFileSync(wsRegistryPath, 'utf-8')) as { workspaces: Array<{ name: string }> };
            let ready = 0;
            for (const ws of reg.workspaces) {
                const has = await hasWorkspaceKey(ws.name);
                if (has) ready++;
            }
            console.log(`  ⓘ Encryption keyring: ${ready}/${reg.workspaces.length} workspace(s) have keys provisioned (S6 primitives; opt-in wiring pending)`);
        }
    } catch (keyErr) {
        console.log(`  ⚠ Keyring check failed: ${(keyErr as Error).message}`);
    }

    // S8 — npm audit summary
    try {
        const { execSync } = await import('child_process');
        const auditRaw = execSync('npm audit --json', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const audit = JSON.parse(auditRaw) as { metadata?: { vulnerabilities?: Record<string, number> } };
        const v = audit.metadata?.vulnerabilities ?? {};
        const criticalCount = v.critical ?? 0;
        const highCount = v.high ?? 0;
        const moderateCount = v.moderate ?? 0;
        if (criticalCount === 0 && highCount === 0 && moderateCount === 0) {
            console.log('  ✓ npm audit clean (0 vulnerabilities)');
        } else {
            console.log(`  ⚠ npm audit: ${criticalCount} critical, ${highCount} high, ${moderateCount} moderate`);
            if (criticalCount > 0 || highCount > 0) issues++;
        }
    } catch {
        console.log('  ⚠ npm audit not runnable');
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

/**
 * probeHttp — small helper for doctor to probe the daemon via HTTP.
 * Returns status code or null on unreachable.
 */
async function probeHttp(pathname: string, token: string | null): Promise<number | null> {
    return await new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1',
            port: 3847,
            method: 'GET',
            path: pathname,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            timeout: 2000,
        }, (res) => {
            res.resume();
            resolve(res.statusCode ?? null);
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

/**
 * probeJson — like probeHttp but parses the response body. Returns
 * null on any error (unreachable, non-200, non-JSON).
 */
async function probeJson(pathname: string, token: string | null): Promise<any | null> {
    return await new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1',
            port: 3847,
            method: 'GET',
            path: pathname,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            timeout: 3000,
        }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return resolve(null); }
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
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
    console.log('  Note: Lore is local-first. One daemon per person.');
    console.log('  For teams / families, each person runs their own daemon');
    console.log('  and shares via Dataplane. See docs/DEPLOYMENT_MODEL.md.');
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
    // V2.1 / Option C: this command is developer-plugin-specific but lives
    // in core CLI for discoverability. We reach the plugin by booting the
    // registry + its schemas, then calling through the opaque api field.
    const { ConfigManager } = await import('../config/configManager.js');
    const { PluginRegistry } = await import('../plugins/registry.js');
    const basePath = path.join(os.homedir(), '.groundfloor');
    const loreDir = path.join(basePath, '.lore');
    const graph = new LocalGraph(basePath);
    const registry = new PluginRegistry(new ConfigManager(loreDir));
    registry.boot();
    await graph.initialize();
    await registry.registerSchemas(graph.createPluginGraphContext());

    const devPlugin = registry.active().find((p) => p.name === 'developer');
    const devApi = devPlugin?.api as
        | { ingestFilesFromSymbols: () => Promise<{ filesCreated: number; edgesCreated: number }> }
        | undefined;
    if (!devApi) {
        console.error('  ✗ ingest-files requires the "developer" plugin. Add "developer" to .lore/config.json plugins[].');
        await graph.close();
        return;
    }
    console.log('');
    console.log('  Ingesting files from existing CodeSymbols…');
    const stats = await devApi.ingestFilesFromSymbols();
    console.log(`  ✓ ${stats.filesCreated} CodeFile node(s) synthesized`);
    console.log(`  ✓ ${stats.edgesCreated} FileContains edge(s) created`);
    await graph.close();
    console.log('');
    console.log('  Next: `lore reconnect` to link LoreNode knowledge to these files via semantic similarity.');
}

/**
 * reconsumeCommand — One-call "refresh everything" pipeline.
 *
 * Equivalent to `lore reconnect --apply`, but named to make the intent
 * obvious ("reconsume the content, update the graph"). Always applies;
 * uses enriched file + symbol embeddings so cross-pillar links actually
 * land at the default threshold.
 *
 *   lore reconsume                          # default k=5, threshold=0.65
 *   lore reconsume --k 8 --threshold 0.55   # experiment
 */
export async function reconsumeCommand(args: string[]): Promise<void> {
    await reconnectCommand([...args, '--apply']);
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
    const { ConfigManager } = await import('../config/configManager.js');
    const { PluginRegistry } = await import('../plugins/registry.js');

    const apply = args.includes('--apply');
    const force = args.includes('--force');
    const kIndex = args.indexOf('--k');
    const tIndex = args.indexOf('--threshold');
    const k = kIndex >= 0 ? parseInt(args[kIndex + 1], 10) : 5;
    const threshold = tIndex >= 0 ? parseFloat(args[tIndex + 1]) : 0.65;

    const basePath = path.join(os.homedir(), '.groundfloor');
    const loreDir = path.join(basePath, '.lore');
    const graph = new LocalGraph(basePath);
    const verbatim = new VerbatimStore(basePath);
    const registry = new PluginRegistry(new ConfigManager(loreDir));
    registry.boot();
    await graph.initialize();
    await registry.registerSchemas(graph.createPluginGraphContext());

    console.log('');
    console.log(`  Reconnect pass — k=${k}, threshold=${threshold}, mode=${apply ? 'APPLY' : 'dry-run'}${force ? ', force=true' : ''}`);
    const result = await reconnectGraph(graph, verbatim, registry, { k, minSim: threshold, dryRun: !apply, force });

    console.log(`  ✓ Scanned ${result.candidatesScanned} node(s); embeddings added: ${result.embeddingsAdded}, skipped (hash match): ${result.embeddingsSkipped}`);
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
        const pruned = Object.entries(result.prunedByOwner)
            .map(([owner, n]) => `${owner}:${n}`)
            .join('  ');
        console.log(`  ✓ Pruned — ${pruned || '(nothing)'}`);
        console.log(`  ✓ Inserted — core:${result.coreEdgesInserted}  plugin-routed:${result.pluginEdgesRouted}  (unrouted:${result.unroutedEdges})`);
    } else {
        console.log('');
        console.log('  (dry run — nothing was written. Re-run with --apply to commit.)');
    }
    await graph.close();
}

/* ─── C3.5: storage command ───────────────────────────────────── */

import { inspectAllWorkspaces, inspectDataHome, formatBytes } from '../engines/storageInspector.js';

/**
 * storageCommand — print per-workspace byte breakdown + disk-free.
 *
 * Output resembles `du`-plus: categories (graph / embeddings / logs /
 * models / config / other) sum per workspace, with a SSD headroom line
 * at the bottom. Human-readable by default; `--json` for machine use.
 */
export async function storageCommand(args: string[]): Promise<void> {
    const json = args.includes('--json');
    const dataHome = path.join(os.homedir(), '.groundfloor');

    const homeBreakdown = inspectDataHome(dataHome);
    const workspaces = inspectAllWorkspaces(dataHome);

    if (json) {
        console.log(JSON.stringify({
            dataHome: { path: dataHome, breakdown: homeBreakdown },
            workspaces: workspaces.map((w) => ({ name: w.name, path: w.path, breakdown: w.breakdown })),
        }, null, 2));
        return;
    }

    const line = (label: string, bytes: number, pad = 18): string =>
        `  ${label.padEnd(pad)} ${formatBytes(bytes).padStart(10)}`;

    console.log('');
    console.log('Storage — groundfloor-lore');
    console.log('');

    for (const ws of workspaces) {
        console.log(`Workspace: ${ws.name}  (${ws.path})`);
        const b = ws.breakdown;
        console.log(line('Graph (Kùzu)', b.graphBytes));
        console.log(line('Embeddings (Lance)', b.embeddingsBytes));
        console.log(line('Models', b.modelsBytes));
        console.log(line('Logs', b.logsBytes));
        console.log(line('Config', b.configBytes));
        console.log(line('Other', b.otherBytes));
        console.log(line('  TOTAL', b.totalBytes));
        console.log('');
    }

    // If the default workspace is the data home (V2.0 compat), the line
    // above already counted everything. Otherwise show the data-home
    // residual (logs, models shared across workspaces).
    const homeCovered = workspaces.some((w) => w.path === dataHome);
    if (!homeCovered) {
        console.log(`Data home residual  (${dataHome})`);
        console.log(line('Logs', homeBreakdown.logsBytes));
        console.log(line('Models', homeBreakdown.modelsBytes));
        console.log(line('Config', homeBreakdown.configBytes));
        console.log('');
    }

    if (homeBreakdown.diskTotalBytes > 0) {
        const pctUsed = ((1 - homeBreakdown.diskFreeBytes / homeBreakdown.diskTotalBytes) * 100).toFixed(0);
        console.log(`SSD: ${formatBytes(homeBreakdown.diskFreeBytes)} free of ${formatBytes(homeBreakdown.diskTotalBytes)} (${pctUsed}% used)`);
    }
}

/* ─── C4: graph report command ─────────────────────────────────── */

import { writeGraphReport } from '../engines/graphReport.js';

/**
 * reportCommand — write/print a human-readable GRAPH_REPORT.md.
 *
 * Routing:
 *   1. If the daemon is running, fetch the report from /api/report
 *      (the daemon holds Kùzu's single-writer lock, so the CLI
 *      can't open the DB in parallel).
 *   2. Otherwise, open the DB directly and generate inline.
 *
 * Flags:
 *   --output <path>   write to file (default: stdout)
 *   --project <name>  scope to a project
 *   --topN <n>        override top-N hubs (default 20)
 */
export async function reportCommand(args: string[]): Promise<void> {
    const outIdx = args.indexOf('--output');
    const outputPath = outIdx >= 0 ? args[outIdx + 1] : null;
    const projIdx = args.indexOf('--project');
    const project = projIdx >= 0 ? args[projIdx + 1] : undefined;
    const topNIdx = args.indexOf('--topN');
    const topN = topNIdx >= 0 ? parseInt(args[topNIdx + 1], 10) : undefined;

    let md: string | null = null;

    // Try HTTP first — cheapest path when the daemon is up.
    try {
        md = await fetchReportViaDaemon(project, topN);
    } catch {
        // Daemon not running or unreachable — fall through to direct DB.
    }

    if (md == null) {
        const basePath = path.join(os.homedir(), '.groundfloor');
        const graph = new LocalGraph(basePath);
        await graph.initialize();
        md = await writeGraphReport(graph, { project, topN });
        await graph.close();
    }

    if (outputPath) {
        const resolved = path.resolve(outputPath);
        fs.writeFileSync(resolved, md, { mode: 0o600 });
        console.log(`Wrote ${md.length} bytes to ${resolved}`);
    } else {
        process.stdout.write(md);
    }
}

/* ─── Phase 7a / F2b: verbatim reaper ──────────────────────── */

/**
 * verbatimCommand — `lore verbatim reap [--apply] [--prefix <p>]`
 *
 * Finds LanceDB verbatim records whose corresponding Kùzu node no
 * longer exists (orphans from pre-F2a deletes + test leaks). Lists
 * them in dry-run mode; deletes them with --apply.
 *
 * Default prefix: 'lore:'  — the core-plugin verbatim namespace.
 * Other prefixes (e.g. 'file:', 'symbol:') are plugin-owned; reaping
 * those requires the plugin's side to report whether the referenced
 * thing still exists. Out of scope for the MVP; users can pass
 * --prefix explicitly if they know what they're doing.
 */
export async function verbatimCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub !== 'reap') {
        console.error('usage: lore verbatim reap [--apply] [--prefix <prefix>]');
        console.error('       Default prefix: lore: (reap orphaned LoreNode embeddings)');
        process.exit(1);
    }
    const apply = args.includes('--apply');
    const prefixIdx = args.indexOf('--prefix');
    const prefix = prefixIdx >= 0 ? args[prefixIdx + 1] : 'lore:';

    const basePath = path.join(os.homedir(), '.groundfloor');
    const graph = new LocalGraph(basePath);
    const { VerbatimStore } = await import('../engines/verbatimStore.js');
    const verbatim = new VerbatimStore(basePath);

    await graph.initialize();
    await verbatim.initialize();

    console.log('');
    console.log(`Verbatim reaper`);
    console.log(`  Prefix:   ${prefix}`);
    console.log(`  Mode:     ${apply ? 'APPLY' : 'DRY-RUN (use --apply to delete)'}`);
    console.log('');

    const allIds = await verbatim.listIds(prefix);
    console.log(`Inspecting ${allIds.length} verbatim records with prefix "${prefix}"...`);

    const orphans: string[] = [];
    let alive = 0;
    for (const verbatimId of allIds) {
        // Strip the prefix to get the graph node id
        const nodeId = verbatimId.startsWith(prefix) ? verbatimId.slice(prefix.length) : verbatimId;
        const node = await graph.getNode(nodeId);
        if (node == null) {
            orphans.push(verbatimId);
        } else {
            alive++;
        }
    }

    console.log('');
    console.log(`  Alive:   ${alive} verbatim records have a matching Kùzu node`);
    console.log(`  Orphan:  ${orphans.length} verbatim records with NO matching node`);
    console.log('');

    if (orphans.length > 0) {
        console.log('Orphan samples (first 20):');
        for (const o of orphans.slice(0, 20)) console.log(`  - ${o}`);
        if (orphans.length > 20) console.log(`  ... and ${orphans.length - 20} more`);
        console.log('');
    }

    if (apply && orphans.length > 0) {
        console.log(`Reaping ${orphans.length} orphan embedding(s)...`);
        let reaped = 0;
        for (const id of orphans) {
            await verbatim.delete(id);
            reaped++;
        }
        console.log(`Done. ${reaped} orphan embeddings removed.`);
    } else if (!apply && orphans.length > 0) {
        console.log('Dry-run complete. Re-run with --apply to actually delete.');
    } else {
        console.log('No action needed.');
    }

    await graph.close();
}

/* ─── Phase 7a: V1 SQLite migration command ──────────────────── */

import { migrateV1Sqlite } from '../engines/v1Migration.js';

/**
 * migrateCommand — one-off tools for moving data between eras.
 *
 *   lore migrate v1-sqlite [<path>]           # dry-run (default)
 *   lore migrate v1-sqlite [<path>] --apply   # actually import
 *   lore migrate v1-sqlite --apply --archive  # import + move file to archive
 */
export async function migrateCommand(args: string[]): Promise<void> {
    const target = args[0];
    if (target !== 'v1-sqlite') {
        console.error('usage: lore migrate v1-sqlite [<path>] [--apply] [--archive]');
        console.error('       Default path: ~/.groundfloor/knowledge.db');
        console.error('       Default is dry-run. Use --apply to write to the Kùzu graph.');
        process.exit(1);
    }

    // Parse optional positional path (anything that doesn't start with --)
    const rest = args.slice(1);
    const pathArg = rest.find((a) => !a.startsWith('--'));
    const apply = rest.includes('--apply');
    const archive = rest.includes('--archive');

    const sqlitePath = pathArg ?? path.join(os.homedir(), '.groundfloor', 'knowledge.db');

    if (!fs.existsSync(sqlitePath)) {
        console.error(`No SQLite database at ${sqlitePath}`);
        process.exit(1);
    }

    const basePath = path.join(os.homedir(), '.groundfloor');
    const loreDir = path.join(basePath, '.lore');
    const graph = new LocalGraph(basePath);

    // We need the verbatim store + plugin registry to fire the ingest
    // hook for each imported node (so LanceDB + semantic-reconnect run).
    const { VerbatimStore } = await import('../engines/verbatimStore.js');
    const verbatim = new VerbatimStore(basePath);
    const { ConfigManager } = await import('../config/configManager.js');
    const { PluginRegistry } = await import('../plugins/registry.js');
    const registry = new PluginRegistry(new ConfigManager(loreDir));
    registry.boot();

    await graph.initialize();
    await registry.registerSchemas(graph.createPluginGraphContext());

    console.log('');
    console.log(`Migration: V1 SQLite → V2 Kùzu`);
    console.log(`  Source:   ${sqlitePath}`);
    console.log(`  Mode:     ${apply ? 'APPLY' : 'DRY-RUN (use --apply to write)'}`);
    if (archive && !apply) {
        console.log(`  Archive:  (--archive is ignored without --apply)`);
    } else if (archive) {
        console.log(`  Archive:  YES — source file will be moved to ~/.groundfloor/archive/`);
    }
    console.log('');

    const report = await migrateV1Sqlite(graph, {
        sqlitePath,
        apply,
        archive,
        verbatimStore: apply ? verbatim : undefined,
        pluginRegistry: apply ? registry : undefined,
    });

    console.log('─── Summary ─────────────────────────────────');
    console.log(`  V1 nodes read:              ${report.v1NodesRead}`);
    console.log(`  V1 edges read:              ${report.v1EdgesRead}`);
    console.log('');
    console.log(`  Nodes imported:             ${report.nodesImported}${apply ? '' : ' (would be)'}`);
    console.log(`  Nodes skipped (id match):   ${report.nodesSkippedIdConflict.length}`);
    console.log(`  Nodes flagged (content dup): ${report.nodesFlaggedContentDup.length}`);
    console.log('');
    console.log(`  Edges imported:             ${report.edgesImported}${apply ? '' : ' (would be)'}`);
    console.log(`  Edges skipped (duplicate):  ${report.edgesSkippedAlreadyExists}`);
    console.log(`  Edges skipped (dangling):   ${report.edgesSkippedMissingEndpoint.length}`);
    console.log('');
    console.log(`  Duration:                   ${report.durationMs}ms`);
    if (report.archivedTo) {
        console.log(`  Archived to:                ${report.archivedTo}`);
    }

    // Show ID-skip details if any
    if (report.nodesSkippedIdConflict.length > 0) {
        console.log('');
        console.log('ID conflicts (V1 id matched an existing Kùzu node — V1 skipped):');
        for (const id of report.nodesSkippedIdConflict.slice(0, 10)) console.log(`  - ${id}`);
        if (report.nodesSkippedIdConflict.length > 10) {
            console.log(`  ... and ${report.nodesSkippedIdConflict.length - 10} more`);
        }
    }

    // Show content-dup flags
    if (report.nodesFlaggedContentDup.length > 0) {
        console.log('');
        console.log('Content-duplicates (V1 id imported alongside an existing node with identical content):');
        console.log('  Review and `lore delete_node <v1-id>` to collapse if desired.');
        for (const pair of report.nodesFlaggedContentDup.slice(0, 10)) {
            console.log(`  - V1: ${pair.v1Id}  ~=  existing: ${pair.existingId}`);
        }
        if (report.nodesFlaggedContentDup.length > 10) {
            console.log(`  ... and ${report.nodesFlaggedContentDup.length - 10} more`);
        }
    }

    if (!apply) {
        console.log('');
        console.log('Dry-run complete. Run again with --apply to actually import.');
    } else {
        console.log('');
        console.log('Migration applied. Run `lore status` to confirm.');
        if (!archive) {
            console.log(`The source SQLite is still at ${sqlitePath} — delete manually or re-run with --archive.`);
        }
    }

    await graph.close();
}

/* ─── C10: snapshot command ──────────────────────────────────── */

/**
 * snapshotCommand — `lore snapshot <folder> --output graph.html`
 *
 * The graphify-style one-shot: point it at a folder, get a standalone
 * HTML snapshot of what's in there. Uses an ephemeral workspace so the
 * user's live graph isn't touched.
 *
 * Implementation choice for scope: for C10 minimum viable, we don't
 * stand up a full ephemeral workspace (that requires reconnect + plugin
 * re-registration against a new path). Instead, we iterate the folder
 * via the FilesystemConnector + route through the ExtractorRegistry,
 * collecting extracted content into in-memory nodes and then rendering
 * directly via exportGraphAsHtml's templates.
 *
 * This produces a PREVIEW-quality snapshot — what's in the folder,
 * with text content extracted and shown. Semantic edges (reconnect)
 * require the full workspace pipeline; those are absent from the
 * one-shot snapshot. For semantic-edge snapshots, use the normal
 * ingest → reconnect → export flow against your active workspace.
 */
export async function snapshotCommand(args: string[]): Promise<void> {
    const folder = args[0];
    if (!folder || folder.startsWith('--')) {
        console.error('usage: lore snapshot <folder> --output <graph.html> [--title "..."]');
        process.exit(1);
    }
    const outIdx = args.indexOf('--output');
    if (outIdx < 0 || !args[outIdx + 1]) {
        console.error('--output <path> is required');
        process.exit(1);
    }
    const outputPath = path.resolve(args[outIdx + 1]);
    const titleIdx = args.indexOf('--title');
    const title = titleIdx >= 0 ? args[titleIdx + 1] : `Lore snapshot of ${path.basename(folder)}`;

    const absFolder = path.resolve(folder);
    if (!fs.existsSync(absFolder)) {
        console.error(`folder not found: ${absFolder}`);
        process.exit(1);
    }

    const { buildDefaultRegistry } = await import('../engines/extractors/index.js');
    const { FilesystemConnector } = await import('../engines/connectors/index.js');
    const extractors = buildDefaultRegistry();
    const connector = new FilesystemConnector({
        extractorRegistry: extractors,
        roots: [absFolder],
        // Allow the target folder even if it's outside the standard
        // allowlist — `lore snapshot` is explicitly opt-in to this path.
        workspaceRoot: absFolder,
    });

    console.log(`Scanning ${absFolder}...`);
    const nodes: Array<{ id: string; label: string; type: string; group: string }> = [];
    const edges: Array<{ from: string; to: string; label?: string }> = [];
    const parentChildren = new Map<string, string[]>();

    let count = 0;
    for await (const item of connector.sync({ fullSync: true })) {
        count++;
        const rel = path.relative(absFolder, item.metadata.absolutePath as string);
        const parent = path.dirname(rel);
        const kind = inferSnapshotKind(item.mimeType);
        const id = `file:${rel}`;
        nodes.push({
            id,
            label: path.basename(rel),
            type: kind,
            group: kind,
        });
        if (parent && parent !== '.') {
            if (!parentChildren.has(parent)) {
                parentChildren.set(parent, []);
                nodes.push({ id: `dir:${parent}`, label: parent, type: 'directory', group: 'directory' });
            }
            parentChildren.get(parent)!.push(id);
            edges.push({ from: `dir:${parent}`, to: id, label: 'contains' });
        }
    }

    // Build minimal topology payload for the HTML export template.
    // We reuse exportGraphAsHtml's output structure by constructing a
    // mini LocalGraph-shaped object with just getTopology().
    const topology = { nodes, edges };
    const html = renderSnapshotHtml(topology, {
        title,
        description: `Snapshot of ${absFolder} (${count} files, ${nodes.length} nodes). This is a one-shot file-tree view. Semantic edges require running a full ingest+reconnect against your active workspace.`,
    });

    fs.writeFileSync(outputPath, html, { mode: 0o600 });
    console.log(`Wrote ${html.length} bytes to ${outputPath}`);
    console.log(`Open: open "${outputPath}"`);
}

function inferSnapshotKind(mime: string): string {
    if (mime.startsWith('text/')) return 'text';
    if (mime === 'application/pdf') return 'pdf';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'message/rfc822') return 'email';
    if (mime.includes('wordprocessingml')) return 'docx';
    return 'file';
}

// Tiny inline HTML renderer for snapshots — doesn't need the full
// graph topology pipeline, so standalone from exportGraphAsHtml.
function renderSnapshotHtml(
    topology: { nodes: Array<{ id: string; label: string; type: string; group: string }>, edges: Array<{ from: string; to: string; label?: string }> },
    opts: { title: string; description: string },
): string {
    const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c] ?? c));
    return [
        '<!DOCTYPE html><html><head><meta charset="utf-8">',
        `<title>${escape(opts.title)}</title>`,
        '<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>',
        '<style>body{font-family:-apple-system,system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}header{padding:1rem 1.5rem;background:#1e293b;border-bottom:1px solid #334155}header h1{margin:0 0 .25rem;font-size:1.1rem}header p{margin:0;font-size:.85rem;color:#94a3b8}#g{width:100vw;height:calc(100vh - 80px)}</style>',
        `</head><body><header><h1>${escape(opts.title)}</h1><p>${escape(opts.description)}</p></header><div id="g"></div>`,
        `<script>const DATA=${JSON.stringify(topology)};const options={nodes:{shape:"dot",size:14,font:{color:"#e2e8f0",size:12}},edges:{arrows:{to:{enabled:true,scaleFactor:.4}},color:{color:"#475569"}},physics:{stabilization:{iterations:150}},groups:{directory:{color:{background:"#475569",border:"#334155"}},text:{color:{background:"#38A169",border:"#2F855A"}},pdf:{color:{background:"#E53E3E",border:"#C53030"}},docx:{color:{background:"#3182CE",border:"#2B6CB0"}},email:{color:{background:"#805AD5",border:"#553C9A"}},audio:{color:{background:"#DD6B20",border:"#C05621"}},image:{color:{background:"#D69E2E",border:"#B7791F"}},file:{color:{background:"#718096",border:"#4A5568"}}}};new vis.Network(document.getElementById("g"),DATA,options);</script></body></html>`,
    ].join('');
}

/* ─── C8: export command ──────────────────────────────────────── */

import { exportGraphAsHtml } from '../engines/htmlExport.js';

/**
 * exportCommand — write a self-contained HTML graph snapshot.
 *
 *   lore export html --output graph.html [--project <name>] [--max-nodes N] [--title "..."]
 *
 * Routes through the daemon via /api/export/html when it's up
 * (avoids Kùzu single-writer contention), falls back to direct DB.
 */
export async function exportCommand(args: string[]): Promise<void> {
    if (args[0] !== 'html') {
        console.error('usage: lore export html --output <path> [--project <name>] [--max-nodes N] [--title "..."]');
        process.exit(1);
    }
    const outIdx = args.indexOf('--output');
    if (outIdx < 0 || !args[outIdx + 1]) {
        console.error('--output <path> is required');
        process.exit(1);
    }
    const outputPath = path.resolve(args[outIdx + 1]);
    const projectIdx = args.indexOf('--project');
    const project = projectIdx >= 0 ? args[projectIdx + 1] : undefined;
    const maxIdx = args.indexOf('--max-nodes');
    const maxNodes = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : undefined;
    const titleIdx = args.indexOf('--title');
    const title = titleIdx >= 0 ? args[titleIdx + 1] : undefined;

    let html: string | null = null;
    try {
        html = await fetchHtmlExportViaDaemon({ project, maxNodes, title });
    } catch {
        // Daemon down — open DB directly.
    }
    if (html == null) {
        const basePath = path.join(os.homedir(), '.groundfloor');
        const graph = new LocalGraph(basePath);
        await graph.initialize();
        html = await exportGraphAsHtml(graph, { project, maxNodes, title });
        await graph.close();
    }
    fs.writeFileSync(outputPath, html, { mode: 0o600 });
    console.log(`Wrote ${html.length} bytes to ${outputPath}`);
    console.log(`Open in a browser: open "${outputPath}"`);
}

async function fetchHtmlExportViaDaemon(opts: { project?: string; maxNodes?: number; title?: string }): Promise<string> {
    const tokenPath = path.join(os.homedir(), '.groundfloor', 'auth.token');
    if (!fs.existsSync(tokenPath)) throw new Error('no daemon');
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    const qs = new URLSearchParams();
    if (opts.project) qs.set('project', opts.project);
    if (opts.maxNodes != null) qs.set('maxNodes', String(opts.maxNodes));
    if (opts.title) qs.set('title', opts.title);
    const pathQs = qs.toString() ? `/api/export/html?${qs.toString()}` : '/api/export/html';
    return await new Promise<string>((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: 3847, method: 'GET', path: pathQs,
            headers: { Authorization: `Bearer ${token}` }, timeout: 15_000,
        }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                if (res.statusCode === 200) resolve(body);
                else reject(new Error(`HTTP ${res.statusCode}`));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

async function fetchReportViaDaemon(project?: string, topN?: number): Promise<string> {
    const tokenPath = path.join(os.homedir(), '.groundfloor', 'auth.token');
    if (!fs.existsSync(tokenPath)) {
        throw new Error('no auth token — daemon not initialized');
    }
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();

    const qs = new URLSearchParams();
    if (project) qs.set('project', project);
    if (topN != null) qs.set('topN', String(topN));
    const path_ = qs.toString() ? `/api/report?${qs.toString()}` : '/api/report';

    return await new Promise<string>((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: 3847,
            method: 'GET',
            path: path_,
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10_000,
        }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                if (res.statusCode === 200) resolve(body);
                else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}

