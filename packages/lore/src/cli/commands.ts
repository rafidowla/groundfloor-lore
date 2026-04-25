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
import { ConfigManager } from '../config/configManager.js';

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

    const { PluginRegistry } = await import('../plugins/registry.js');
    const graph = new LocalGraph(basePath);
    const registry = new PluginRegistry(new ConfigManager(loreDir));
    registry.boot();
    await graph.initialize();
    await registry.registerSchemas(graph.createPluginGraphContext());

    const stats = await graph.getStats();
    stats.pluginStats = await registry.collectPluginStats(graph.createPluginGraphContext());
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
    // Plugin-contributed stats render generically — core never names
    // plugin-specific metrics. Each active plugin gets a section.
    const pluginStatsMap = stats.pluginStats ?? {};
    for (const [pluginName, metrics] of Object.entries(pluginStatsMap)) {
        if (Object.keys(metrics).length === 0) continue;
        console.log(`  ${pluginName} plugin`);
        for (const [metric, count] of Object.entries(metrics)) {
            console.log(`    ${metric}: ${count}`);
        }
        console.log('');
    }
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

    // Check 8: Active plugins + each plugin's self-reported doctor checks.
    // Core owns NO plugin-specific logic here — every contribution flows
    // through ILorePlugin.contributeDoctorChecks.
    try {
        const { ConfigManager } = await import('../config/configManager.js');
        const { PluginRegistry } = await import('../plugins/registry.js');
        const { VerbatimStore } = await import('../engines/verbatimStore.js');
        const { SyncEngine } = await import('../engines/syncEngine.js');
        const configManager = new ConfigManager(loreDir);
        const registry = new PluginRegistry(configManager);
        registry.boot();
        const graph = new LocalGraph(basePath);
        await graph.initialize();
        await registry.registerSchemas(graph.createPluginGraphContext());
        const active = registry.active().map((p) => p.name);
        console.log(`  ✓ Active plugins: ${active.join(', ') || '(none)'}`);

        const verbatimStore = new VerbatimStore(loreDir);
        const syncEngine = new SyncEngine(graph, loreDir, null);
        const pluginCtx = {
            graph,
            verbatimStore,
            syncEngine,
            syncAdapter: null,
            schemaLoader: null,
            scope: { project: '*', ecosystem: '*' },
            loreDir,
        };
        const checks = await registry.collectDoctorChecks(pluginCtx);
        for (const c of checks) {
            const glyph = c.ok ? '✓' : '✗';
            console.log(`  ${glyph} ${c.message}`);
            if (!c.ok) issues++;
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
        console.log('    lore --help                               # See plugin commands');
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

/* ─── V2.2 / F4: lore models prune ───────────────────────────── */

/**
 * modelsCommand — `lore models prune [--apply] [--keep <pattern>]...`
 *
 * Walks ~/.groundfloor/models/ and reports (or deletes) ONNX model
 * directories that aren't the currently-active embedded model. The
 * typical use case: a user upgraded Qwen 0.5B → Gemma 3 1B and now
 * has ~1 GB of stale Qwen weights sitting around. Also useful if
 * the user tried multiple embedded models over time.
 *
 * Dry-run by default. `--keep <glob>` can pin additional models the
 * user wants to preserve (e.g. an Ollama-on-disk variant they swap
 * between). Active model is ALWAYS kept regardless of flags.
 *
 * Scope note: this only manages Transformers.js cache at
 * ~/.groundfloor/models/. Ollama's model cache is in ~/.ollama/;
 * not touched here. BYOK providers have nothing to prune.
 *
 * Directory layout inside ~/.groundfloor/models/:
 *   <org>/<model-name>/   (e.g. Xenova/Qwen1.5-0.5B-Chat/,
 *                              onnx-community/gemma-3-1b-it-ONNX/)
 */
export async function modelsCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub !== 'prune') {
        console.error('usage: lore models prune [--apply] [--keep <pattern>]...');
        console.error('       Removes cached ONNX model weights that are not the currently active');
        console.error('       embedded model. Dry-run by default — use --apply to actually delete.');
        console.error('');
        console.error('       --keep <pattern>  Pin additional models to preserve. Can be repeated.');
        console.error('                         Example: --keep "Xenova/*" --keep "onnx-community/Llama*"');
        process.exit(1);
    }

    const apply = args.includes('--apply');
    const keepGlobs: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--keep' && i + 1 < args.length) {
            keepGlobs.push(args[i + 1]);
            i++;
        }
    }

    // Resolve the currently-active embedded model from config. Keep
    // conservative: if config is missing or malformed, treat the
    // pre-V2.2 + V2.2 defaults as always-keep. Better to leave a
    // model on disk than to delete the one the user is about to use.
    const basePath = path.join(os.homedir(), '.groundfloor');
    const configManager = new ConfigManager(path.join(basePath, '.lore'));
    let activeModel = 'onnx-community/gemma-3-1b-it-ONNX';
    try {
        const cfg = configManager.read();
        if (cfg.llmProvider === 'embedded') {
            // V2.2 default — not stored in config directly; the
            // dispatcher's DEFAULT_MODELS constant owns it. Use the
            // known default plus a safety fallback.
            activeModel = 'onnx-community/gemma-3-1b-it-ONNX';
        }
    } catch {
        /* use fallback */
    }
    // Always-keep list. This goes beyond "the active LLM" because
    // several Transformers.js models under ~/.groundfloor/models/ are
    // infrastructure, not user-selectable chat models:
    //   - Xenova/all-MiniLM-L6-v2 is the sentence-transformer
    //     embedder used by VerbatimStore + LanceDB. Removing it
    //     breaks reconnect and semantic recall.
    //   - onnx-community/gemma-3-1b-it-ONNX is the active LLM (V2.2).
    //
    // Any future model introduced as infrastructure (not a user
    // chat pick) must be added here. A ~1 GB false positive is
    // cheap — a broken reconnect from pruning an embedder is not.
    const alwaysKeep = new Set([
        activeModel,
        'Xenova/all-MiniLM-L6-v2',             // VerbatimStore embedder
        'onnx-community/gemma-3-1b-it-ONNX',   // V2.2 default LLM (fallback)
    ]);

    const modelsRoot = path.join(basePath, 'models');
    if (!fs.existsSync(modelsRoot)) {
        console.log(`No model cache found at ${modelsRoot}. Nothing to prune.`);
        return;
    }

    console.log('');
    console.log(`Model cache prune`);
    console.log(`  Cache:    ${modelsRoot}`);
    console.log(`  Active:   ${activeModel}`);
    if (keepGlobs.length > 0) console.log(`  Keep:     ${keepGlobs.join(', ')}`);
    console.log(`  Mode:     ${apply ? 'APPLY' : 'DRY-RUN (use --apply to delete)'}`);
    console.log('');

    // Walk <modelsRoot>/<org>/<model>/ two levels deep. Some layouts
    // may nest deeper (huggingface may add version subdirs), but we
    // treat <org>/<model> as the atomic unit to keep/drop.
    const candidates: Array<{ relPath: string; fullPath: string; sizeBytes: number }> = [];
    for (const org of fs.readdirSync(modelsRoot)) {
        const orgPath = path.join(modelsRoot, org);
        if (!fs.statSync(orgPath).isDirectory()) continue;
        for (const model of fs.readdirSync(orgPath)) {
            const modelPath = path.join(orgPath, model);
            if (!fs.statSync(modelPath).isDirectory()) continue;
            const relPath = `${org}/${model}`;
            candidates.push({
                relPath,
                fullPath: modelPath,
                sizeBytes: dirSizeBytes(modelPath),
            });
        }
    }

    if (candidates.length === 0) {
        console.log('No cached models found.');
        return;
    }

    const matchesKeepGlob = (relPath: string): boolean => {
        for (const pat of keepGlobs) {
            // Simple glob: * matches non-slash segment, everything else literal.
            const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
            if (re.test(relPath)) return true;
        }
        return false;
    };

    const keep: typeof candidates = [];
    const drop: typeof candidates = [];
    for (const c of candidates) {
        if (alwaysKeep.has(c.relPath) || matchesKeepGlob(c.relPath)) {
            keep.push(c);
        } else {
            drop.push(c);
        }
    }

    const formatBytes = (n: number): string => {
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
        return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    };

    console.log(`Found ${candidates.length} cached model${candidates.length === 1 ? '' : 's'}:`);
    for (const c of keep) {
        console.log(`  KEEP    ${c.relPath.padEnd(50)} ${formatBytes(c.sizeBytes)}`);
    }
    for (const c of drop) {
        console.log(`  PRUNE   ${c.relPath.padEnd(50)} ${formatBytes(c.sizeBytes)}`);
    }
    const dropTotalBytes = drop.reduce((a, b) => a + b.sizeBytes, 0);
    console.log('');
    console.log(`  ${keep.length} keep, ${drop.length} to prune, ${formatBytes(dropTotalBytes)} to reclaim`);
    console.log('');

    if (drop.length === 0) {
        console.log('No models to prune.');
        return;
    }

    if (!apply) {
        console.log('Dry-run complete. Re-run with --apply to actually delete.');
        return;
    }

    let pruned = 0;
    let reclaimedBytes = 0;
    for (const c of drop) {
        try {
            fs.rmSync(c.fullPath, { recursive: true, force: true });
            pruned++;
            reclaimedBytes += c.sizeBytes;
            console.log(`  ✓ Removed ${c.relPath}`);
        } catch (err) {
            console.error(`  ✗ Failed to remove ${c.relPath}: ${(err as Error).message}`);
        }
    }

    // Clean up now-empty <org>/ parent dirs.
    for (const org of fs.readdirSync(modelsRoot)) {
        const orgPath = path.join(modelsRoot, org);
        try {
            if (fs.statSync(orgPath).isDirectory() && fs.readdirSync(orgPath).length === 0) {
                fs.rmdirSync(orgPath);
            }
        } catch { /* ignore */ }
    }

    console.log('');
    console.log(`Done. ${pruned} model${pruned === 1 ? '' : 's'} pruned, ${formatBytes(reclaimedBytes)} reclaimed.`);
}

/** dirSizeBytes — recursive sum of file sizes under `dir`. Best-effort:
 *  permission errors on individual files silently skip rather than
 *  abort, so one unreadable file doesn't kill the whole scan. */
function dirSizeBytes(dir: string): number {
    let total = 0;
    const walk = (p: string): void => {
        try {
            const st = fs.statSync(p);
            if (st.isFile()) {
                total += st.size;
                return;
            }
            if (st.isDirectory()) {
                for (const name of fs.readdirSync(p)) {
                    walk(path.join(p, name));
                }
            }
        } catch { /* ignore */ }
    };
    walk(dir);
    return total;
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
    if (target === 'embedding-model') {
        await migrateEmbeddingModelCommand(args.slice(1));
        return;
    }
    if (target !== 'v1-sqlite') {
        console.error('usage: lore migrate <target> [options]');
        console.error('');
        console.error('Targets:');
        console.error('  v1-sqlite [<path>] [--apply] [--archive]');
        console.error('      Migrate a V1 knowledge.db SQLite file into the Kùzu graph.');
        console.error('      Default path: ~/.groundfloor/knowledge.db');
        console.error('  embedding-model --to <modelId> [--dim <n>] [--apply] [--force]');
        console.error('      Re-embed the corpus into a different model\'s vector space.');
        console.error('      Default is dry-run. Use --apply to drop+rebuild lore_verbatim.');
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

/* ─── Command: scaffold-plugin (Q1.4) ─────────────────────────── */

/**
 * scaffoldPluginCommand — Generate a new plugin skeleton under
 * `packages/lore-plugin-<name>/` with a working IR stub.
 *
 * Q1.4 / decision D-D: "Each plugin invents a narrow IR it serializes
 * into." The scaffold's whole job is to front-load the IR question —
 * the first file the user fills in is the IR descriptor. Anything
 * generated here boots cleanly against the current core without
 * hand-editing tsconfig paths.
 *
 * Steps:
 *   1. Validate kebab-case name (lowercase, digits, hyphens).
 *   2. Refuse if `packages/lore-plugin-<name>/` already exists.
 *   3. Write src/{index.ts, schema.ts, tools.ts} + README.md.
 *   4. Patch root tsconfig.json: add `@lore-plugin-<name>/*` path
 *      alias and `packages/lore-plugin-<name>/src/**\/*` include.
 *   5. Print next steps: add to `BUILTIN_PLUGINS` in registry.ts,
 *      activate in `.lore/config.json`, rebuild.
 *
 * Acceptance (per post_v2_plan.md Q1.4):
 *   "New plugin template can be scaffolded with `npx lore
 *    scaffold-plugin <name>` and has a working IR on first boot."
 *
 * Intentionally does NOT auto-register in BUILTIN_PLUGINS — that
 * edit is a one-liner and leaving it manual keeps the scaffolder
 * side-effect-free outside the new plugin's directory (plus one
 * tsconfig patch).
 */
export async function scaffoldPluginCommand(args: string[]): Promise<void> {
    const name = args[0];
    if (!name) {
        console.error('Usage: lore scaffold-plugin <name>');
        console.error('  name must be kebab-case (lowercase, digits, hyphens).');
        console.error('  Example: lore scaffold-plugin finance');
        process.exit(1);
    }
    if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(name)) {
        console.error(`Invalid plugin name: '${name}'.`);
        console.error('  Must be kebab-case: start with a letter, end with letter/digit,');
        console.error('  contain only lowercase letters, digits, and hyphens.');
        process.exit(1);
    }

    // Find the monorepo root — this CLI runs from any subdir but the
    // scaffolder writes to packages/ at the repo root.
    const repoRoot = findRepoRoot();
    const packagesDir = path.join(repoRoot, 'packages');
    if (!fs.existsSync(packagesDir)) {
        console.error(`No packages/ directory at ${repoRoot}. Run this from a groundfloor-lore checkout.`);
        process.exit(1);
    }

    const pluginDir = path.join(packagesDir, `lore-plugin-${name}`);
    if (fs.existsSync(pluginDir)) {
        console.error(`Plugin directory already exists: ${pluginDir}`);
        console.error('  Pick a different name or delete the existing directory first.');
        process.exit(1);
    }

    const pascal = name.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
    const capConst = `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}Plugin`;

    // Derived table/kind names — intentionally minimal IR stub.
    // One node table (NoteOne), one edge table (NoteRefersTo). The
    // user replaces these with their real domain on first edit.
    const nodeTable = `${pascal}Note`;
    const edgeTable = `${pascal}RefersTo`;
    const nodeKind = `${name}_note`;

    fs.mkdirSync(path.join(pluginDir, 'src'), { recursive: true });

    // Defeat tsc-alias rewriting: if the literal `@lore-core/plugins/...`
    // string appears in this file's source, tsc-alias replaces it with a
    // relative path at build time — which corrupts the scaffolded
    // plugin's imports (they'd be relative to the CLI dist, not to the
    // new plugin dir). Assembling the path at runtime from split parts
    // keeps the full aliased path out of the compiled output.
    const CORE_TYPES = '@' + 'lore-core/plugins/types.js';

    /* ─── src/schema.ts ───────────────────────────────────────── */
    const schemaTs = `/**
 * schema.ts — ${pascal} plugin Kùzu schema.
 *
 * Q1.4 IR stub. Replace \`${nodeTable}\` and \`${edgeTable}\` with
 * your real domain node + edge tables. The node and edge names here
 * must match the \`ir\` descriptor in index.ts — the registry uses
 * the declared IR to check for cross-plugin table-name collisions
 * at boot.
 */

import type { PluginGraphContext } from '${CORE_TYPES}';

export async function register${pascal}Schema(ctx: PluginGraphContext): Promise<void> {
    await ctx.executeQuery(\`
        CREATE NODE TABLE IF NOT EXISTS ${nodeTable} (
            id STRING,
            displayName STRING,
            content STRING,
            createdAt STRING,
            updatedAt STRING,
            PRIMARY KEY (id)
        )
    \`);

    await ctx.executeQuery(\`
        CREATE REL TABLE IF NOT EXISTS ${edgeTable} (
            FROM ${nodeTable} TO ${nodeTable},
            note STRING,
            confidence STRING DEFAULT 'extracted'
        )
    \`);
}
`;

    /* ─── src/tools.ts ─────────────────────────────────────────── */
    const toolsTs = `/**
 * tools.ts — ${pascal} plugin MCP tool registrations.
 *
 * Q1.4 stub. Plugins can ship tool-free (see the legal plugin
 * exemplar) — the LLM will use core's generic store_node /
 * store_edge against this plugin's IR. Add domain-specific tools
 * here when you want deterministic flows (recall_x, upcoming_y).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PluginContext } from '${CORE_TYPES}';

export const ${pascal.toUpperCase()}_TOOL_NAMES: readonly string[] = [];

export function register${pascal}Tools(_server: McpServer, _ctx: PluginContext): void {
    // Intentionally empty — tool-free is a first-class pattern.
    // Uncomment and extend when you need domain-specific tools:
    //
    // server.tool(
    //     '${name}_upcoming',
    //     'Summary of what you are looking at',
    //     { days: z.number().optional() },
    //     async ({ days }) => { ... }
    // );
}
`;

    /* ─── src/index.ts ─────────────────────────────────────────── */
    const indexTs = `/**
 * index.ts — ${pascal} plugin manifest.
 *
 * Generated by \`lore scaffold-plugin ${name}\`. Replace the IR stub
 * below with your real domain vocabulary, then:
 *
 *   1. Add this plugin to the BUILTIN_PLUGINS map in
 *      packages/lore/src/plugins/registry.ts:
 *
 *        import { ${capConst} } from '@lore-plugin-${name}/index.js';
 *        const BUILTIN_PLUGINS = { ..., ${name}: ${capConst} };
 *
 *   2. Activate in .lore/config.json:
 *
 *        { "plugins": ["${name}"] }
 *
 *   3. Rebuild: \`npm run build && launchctl kickstart -k
 *      gui/\\\$UID/com.groundfloor.lore\`
 *
 *   4. Verify: \`curl http://127.0.0.1:3847/api/plugins/ir\` shows
 *      your plugin's declared IR.
 */

import type {
    ILorePlugin,
    PluginContext,
    PluginGraphContext,
    RetentionRule,
} from '${CORE_TYPES}';
import { register${pascal}Schema } from './schema.js';
import { register${pascal}Tools } from './tools.js';

export const ${capConst}: ILorePlugin = {
    name: '${name}',
    version: '0.1.0',
    description: '${pascal} plugin — scaffolded stub. Replace this description.',

    // Legacy flat fields — kept in sync with \`ir\` below. Future
    // versions of core will read \`ir\` exclusively; for now both
    // fields are written so older tooling still works.
    ownedTables: ['${nodeTable}', '${edgeTable}'],
    nodeTypes: ['${nodeKind}'],
    edgeRelations: ['refers_to'],

    // Q1.4 — Declarative IR. The authoritative shape descriptor.
    ir: {
        version: '0.1.0',
        ownedNodeTables: ['${nodeTable}'],
        ownedEdgeTables: ['${edgeTable}'],
        nodeKinds: ['${nodeKind}'],
        edgeKinds: ['refers_to'],
    },

    uiHints: {
        modeLabel: '${pascal}',
        systemPrompt: '${pascal} vocabulary active.',
        defaultFilterTypes: ['${nodeKind}'],
        cameraFocusTag: '${name}',
    },

    registerTools(server, ctx: PluginContext) {
        register${pascal}Tools(server, ctx);
    },

    async registerSchema(ctx: PluginGraphContext) {
        await register${pascal}Schema(ctx);
    },

    contributeSystemPrompt(_ctx: PluginContext): string | null {
        return '${pascal} knowledge is active in this workspace.';
    },

    contributeRetentionPolicy(): RetentionRule[] {
        return [
            { nodeType: '${nodeKind}', condition: 'age', ageThresholdDays: 10_000, action: 'keep-forever' },
        ];
    },
};
`;

    /* ─── README.md ────────────────────────────────────────────── */
    const readme = `# @lore-plugin-${name}

Scaffolded plugin — replace this README with your plugin's story.

## IR

- Node tables: \`${nodeTable}\`
- Edge tables: \`${edgeTable}\`
- Node kinds: \`${nodeKind}\`
- Edge kinds: \`refers_to\`

See \`src/index.ts\` for the full manifest and \`src/schema.ts\` for
the Kùzu schema definitions.

## Activation

1. Register in \`packages/lore/src/plugins/registry.ts\` BUILTIN_PLUGINS.
2. Add \`${name}\` to \`.lore/config.json\` plugins array.
3. Rebuild.
`;

    fs.writeFileSync(path.join(pluginDir, 'src', 'schema.ts'), schemaTs);
    fs.writeFileSync(path.join(pluginDir, 'src', 'tools.ts'), toolsTs);
    fs.writeFileSync(path.join(pluginDir, 'src', 'index.ts'), indexTs);
    fs.writeFileSync(path.join(pluginDir, 'README.md'), readme);

    /* ─── Patch root tsconfig.json ──────────────────────────────── */
    // Add the new path alias + include glob. Read-modify-write the
    // JSON as a string with targeted replacements so we preserve the
    // exact formatting (comments, trailing commas, indentation) the
    // hand-written tsconfig uses.
    const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
    let tsconfig = fs.readFileSync(tsconfigPath, 'utf-8');
    const aliasKey = `"@lore-plugin-${name}/*"`;
    const includeGlob = `"packages/lore-plugin-${name}/src/**/*"`;

    if (!tsconfig.includes(aliasKey)) {
        // Insert the new alias right before the closing brace of the
        // `paths` object. Anchor on the known last-entry pattern.
        tsconfig = tsconfig.replace(
            /("@lore-plugin-legal\/\*":\s*\[[^\]]*\])(\s*\n\s*\})/,
            `$1,\n            ${aliasKey}: ["packages/lore-plugin-${name}/src/*"]$2`,
        );
    }
    if (!tsconfig.includes(includeGlob)) {
        tsconfig = tsconfig.replace(
            /("packages\/lore-plugin-legal\/src\/\*\*\/\*")(\s*\n\s*\])/,
            `$1,\n        ${includeGlob}$2`,
        );
    }
    fs.writeFileSync(tsconfigPath, tsconfig);

    console.log(`Created packages/lore-plugin-${name}/`);
    console.log(`  src/index.ts    — manifest + IR descriptor`);
    console.log(`  src/schema.ts   — Kùzu tables (${nodeTable}, ${edgeTable})`);
    console.log(`  src/tools.ts    — MCP tool registrar (empty stub)`);
    console.log(`  README.md`);
    console.log(`Patched tsconfig.json:`);
    console.log(`  + @lore-plugin-${name}/* path alias`);
    console.log(`  + packages/lore-plugin-${name}/src/**/* include`);
    console.log(``);
    console.log(`Next steps:`);
    console.log(`  1. Edit src/index.ts — replace the IR stub with your real domain.`);
    console.log(`  2. Add to packages/lore/src/plugins/registry.ts:`);
    console.log(`       import { ${capConst} } from '@lore-plugin-${name}/index.js';`);
    console.log(`       const BUILTIN_PLUGINS = { ..., ${name}: ${capConst} };`);
    console.log(`  3. Activate: add "${name}" to .lore/config.json plugins[].`);
    console.log(`  4. Rebuild: npm run build`);
    console.log(`  5. Verify: curl http://127.0.0.1:3847/api/plugins/ir (auth-gated).`);
}

/* ─── Command: resolve-deferred (Q1.7) ────────────────────────── */

/**
 * resolveDeferredCommand — `lore resolve-deferred <nodeId> [--commit <sha>]`
 *
 * Stamps `metadata.resolved_at = <ISO>` (and optionally
 * `metadata.resolved_by_commit = <sha>`) on a `deferred-*` Lore node.
 * After running this, the node stops appearing in `recall()`'s
 * deferred sidecar. The Lore node itself stays in the graph for
 * historical context.
 *
 * This is the post-commit entry point — the equivalent MCP tool
 * (`resolve_deferred`) exists for in-session resolution from a
 * Claude Code agent.
 *
 * Exit codes:
 *   0 — resolution stamped (or already resolved — idempotent)
 *   1 — usage error, node not found, or node id doesn't start with `deferred-`
 */
export async function resolveDeferredCommand(args: string[]): Promise<void> {
    const nodeId = args[0];
    if (!nodeId || nodeId === '--help' || nodeId === '-h') {
        console.error('usage: lore resolve-deferred <nodeId> [--commit <sha>]');
        console.error('');
        console.error('Stamps metadata.resolved_at (and optionally metadata.resolved_by_commit) on');
        console.error('a deferred-* Lore node. Once stamped, the node no longer surfaces in recall().');
        console.error('');
        console.error('Example:');
        console.error('  lore resolve-deferred deferred-plugin-recalibrate-hook --commit b321692');
        process.exit(1);
    }

    if (!nodeId.startsWith('deferred-')) {
        console.error(`Error: node id '${nodeId}' does not start with 'deferred-'.`);
        console.error('Only deferred-* nodes can be resolved with this command.');
        process.exit(1);
    }

    const commitIdx = args.indexOf('--commit');
    const commit = commitIdx >= 0 ? args[commitIdx + 1] : undefined;
    if (commitIdx >= 0 && !commit) {
        console.error('Error: --commit requires a value.');
        process.exit(1);
    }

    const basePath = resolveGraphBasePath();
    const graph = new LocalGraph(basePath);
    await graph.initialize();

    try {
        const { stampResolved } = await import('../engines/deferred.js');
        const result = await stampResolved(graph, nodeId, commit);
        if (!result) {
            console.error(`Error: deferred node '${nodeId}' not found.`);
            process.exit(1);
        }
        const { metadata } = result;
        console.log(`Resolved deferred node '${nodeId}'.`);
        console.log(`  resolved_at:        ${metadata['resolved_at']}`);
        if (metadata['resolved_by_commit']) {
            console.log(`  resolved_by_commit: ${metadata['resolved_by_commit']}`);
        }
        console.log('');
        console.log('Node remains in graph; subsequent recall() calls will not surface it.');
    } finally {
        await graph.close();
    }
}

/* ─── Q2.2 follow-up to slice 7: embedding-model migration ────── */

/**
 * migrateEmbeddingModelCommand — `lore migrate embedding-model
 *   --to <modelId> [--dim <n>] [--apply] [--force]`
 *
 * Re-embeds the entire corpus into a different model's vector space.
 * See `engines/migrateEmbeddingModel.ts` for the rationale and the
 * step ordering. This file is the thin CLI wrapper.
 *
 * Defaults:
 *   - dimension: 384 (matches MiniLM and multilingual-e5-small)
 *   - mode: dry-run (use --apply to drop the table and re-embed)
 *   - provider: LocalEmbeddingProvider with the target modelId. To
 *     migrate to a remote (BGE-M3 1024-d) model, set the standard
 *     LORE_EMBEDDING_PROVIDER=openai_compat env vars before running
 *     and the command will pick up that provider via the same
 *     resolver the daemon uses.
 *
 * Also runs as a no-op when the on-disk fingerprint already matches
 * the target — running it twice in a row is safe.
 */
export async function migrateEmbeddingModelCommand(args: string[]): Promise<void> {
    const toIdx = args.indexOf('--to');
    const dimIdx = args.indexOf('--dim');
    const apply = args.includes('--apply');
    const force = args.includes('--force');

    const targetModelId = toIdx >= 0 ? args[toIdx + 1] : '';
    if (!targetModelId) {
        console.error('usage: lore migrate embedding-model --to <modelId> [--dim <n>] [--apply] [--force]');
        console.error('');
        console.error('Examples:');
        console.error('  lore migrate embedding-model --to Xenova/multilingual-e5-small');
        console.error('     # dry-run: print plan only');
        console.error('  lore migrate embedding-model --to Xenova/multilingual-e5-small --apply');
        console.error('     # drop+rebuild lore_verbatim with the new model');
        console.error('  lore migrate embedding-model --to BAAI/bge-m3 --dim 1024 --apply');
        console.error('     # cross-dim migration (set LORE_EMBEDDING_PROVIDER=openai_compat and');
        console.error('     # the LORE_EMBEDDING_BASE_URL/MODEL/DIMENSION env vars beforehand)');
        process.exit(1);
    }
    const targetDimension = dimIdx >= 0 ? Number.parseInt(args[dimIdx + 1], 10) : 384;
    if (!Number.isInteger(targetDimension) || targetDimension <= 0) {
        console.error(`--dim must be a positive integer (got ${args[dimIdx + 1]})`);
        process.exit(1);
    }

    const basePath = path.join(os.homedir(), '.groundfloor');
    const loreDir = path.join(basePath, '.lore');

    const { LocalGraph } = await import('../engines/localGraph.js');
    const { ConfigManager } = await import('../config/configManager.js');
    const { PluginRegistry } = await import('../plugins/registry.js');
    const { LocalEmbeddingProvider } = await import('../providers/localEmbeddingProvider.js');
    const { OpenAICompatEmbeddingProvider } = await import('../providers/openAICompatEmbeddingProvider.js');
    const { migrateEmbeddingModel } = await import('../engines/migrateEmbeddingModel.js');
    const { readFingerprintOrLegacy, getFingerprintPath } = await import('../engines/embeddingFingerprint.js');

    // Resolve the target provider. Honor the same env-var contract the
    // daemon uses (server.ts:createEmbeddingProvider) so a "remote
    // BGE-M3" migration just sets the env and runs the CLI.
    const remoteKind = (process.env['LORE_EMBEDDING_PROVIDER'] ?? '').trim().toLowerCase();
    let provider;
    if (remoteKind === 'openai_compat' || remoteKind === 'compat' || remoteKind === 'remote') {
        const baseUrl = process.env['LORE_EMBEDDING_BASE_URL'] ?? '';
        const modelId = process.env['LORE_EMBEDDING_MODEL'] ?? targetModelId;
        const apiKey = process.env['LORE_EMBEDDING_API_KEY'] ?? undefined;
        if (!baseUrl) {
            console.error('LORE_EMBEDDING_PROVIDER=openai_compat requires LORE_EMBEDDING_BASE_URL');
            process.exit(1);
        }
        provider = new OpenAICompatEmbeddingProvider({
            baseUrl, modelId, dimension: targetDimension, apiKey,
        });
    } else {
        provider = new LocalEmbeddingProvider({ modelId: targetModelId, dimension: targetDimension });
    }

    const graph = new LocalGraph(basePath);
    const registry = new PluginRegistry(new ConfigManager(loreDir));
    registry.boot();
    try {
        await graph.initialize();
    } catch (err) {
        // Kùzu is single-writer; if the daemon is up it holds the lock
        // and direct opens fail. Same pattern as `lore reconsume`.
        // Detect the typical message and translate to actionable guidance.
        const msg = (err as Error)?.message ?? '';
        console.error('');
        console.error(`Could not open the local graph: ${msg}`);
        console.error('');
        console.error('This usually means the Lore daemon is running and holds the single-writer lock.');
        console.error('Stop the daemon, run the migration, then start it back up:');
        console.error('');
        console.error('  launchctl bootout gui/$UID/com.groundfloor.lore   # macOS');
        console.error('  systemctl --user stop lore                         # linux');
        console.error('');
        console.error('  lore migrate embedding-model --to <id> --apply');
        console.error('');
        console.error('  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.groundfloor.lore.plist  # macOS');
        console.error('  systemctl --user start lore                                                       # linux');
        process.exit(1);
    }
    await registry.registerSchemas(graph.createPluginGraphContext());

    const current = readFingerprintOrLegacy(basePath);
    console.log('');
    console.log('Embedding-model migration');
    console.log(`  From:   model="${current.modelId}", dim=${current.dimension}`);
    console.log(`  To:     model="${targetModelId}", dim=${targetDimension}`);
    console.log(`  Provider: ${provider.constructor.name} (${provider.modelId})`);
    console.log(`  Mode:   ${apply ? 'APPLY' : 'DRY-RUN (use --apply to actually re-embed)'}`);
    if (force) console.log('  Force:  YES (will rebuild even if fingerprint matches)');
    console.log(`  Fingerprint: ${getFingerprintPath(basePath)}`);
    console.log('');

    try {
        const result = await migrateEmbeddingModel(basePath, graph, registry, {
            targetModelId,
            targetDimension,
            targetProvider: provider,
            dryRun: !apply,
            force,
        });

        if (result.skipped) {
            console.log('No-op: on-disk fingerprint already matches the target.');
            console.log('       Re-run with --force to rebuild from scratch anyway.');
            return;
        }

        console.log('─── Result ──────────────────────────────────');
        console.log(`  Nodes scanned:        ${result.nodesScanned}`);
        console.log(`  Embeddings written:   ${result.embeddingsWritten}${apply ? '' : ' (would be)'}`);
        console.log(`  Table dropped:        ${result.tableDropped ? 'yes' : 'no (was missing)'}`);
        console.log(`  Fingerprint written:  ${result.fingerprintWritten ? 'yes' : 'no'}`);
        if (result.completedAt) console.log(`  Completed at:         ${result.completedAt}`);
        console.log('');

        if (!apply) {
            console.log('Dry-run complete. Re-run with --apply to commit.');
            console.log('NOTE: --apply DROPS lore_verbatim and re-embeds every LoreNode + plugin contribution.');
            console.log('      On a 10k-node graph with the local MiniLM provider this takes ~5 minutes.');
        } else {
            console.log('Migration applied. Daemon should be restarted so it picks up the new fingerprint.');
        }
    } finally {
        await graph.close();
    }
}
