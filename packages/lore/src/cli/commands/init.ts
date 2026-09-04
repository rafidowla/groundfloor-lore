import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveGraphEngineForPath } from '../../engines/openWorkspaceGraph.js';
import { loreHomePath } from '../../config/loreHome.js';
import {
    readWorkspaceRegistry,
    writeWorkspaceRegistry,
    upsertWorkspaceMapping,
    workspaceRegistryPath,
} from '../../config/workspaceRegistry.js';
import { resolveGraphBasePath, openGraphForCli } from './shared.js';

export async function initCommand(args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    console.log(`→ Initializing Lore in ${basePath}`);

    // Finding 11 (round E) — re-running `lore init` against a workspace a
    // daemon already serves used to sit in the ~15s openSurreal retry storm
    // and end in a raw driver error; refuse fast with a clear message
    // instead. Nothing here needs concurrent access with a live daemon —
    // init only ever writes during first-time bootstrap.
    const graph = await openGraphForCli(basePath);
    const engine = resolveGraphEngineForPath(basePath).engine;
    const graphDirName = engine === 'surreal' ? 'surreal' : 'graph';
    console.log(`✓ ${engine === 'surreal' ? 'SurrealDB' : 'legacy graph engine'} graph initialized at ${loreDir}/${graphDirName}/`);

    // `loreDir` is never created by `graph.initialize()` itself when the
    // engine is Surreal AND `basePath` (or an ancestor) contains a URL-
    // reserved character, e.g. a space: `surrealDataPath()` correctly
    // percent-encodes that into the connect string it hands the embedded
    // engine (see its doc comment in surreal/surrealConnection.ts — the same
    // scattering backup.ts/restore.ts already account for), so the graph's
    // own files land in a %20-spelled SIBLING directory tree, not under the
    // literal `.lore/` this function computed above. Nothing else had
    // created the literal `.lore/` in that case, so the plain
    // `fs.writeFileSync` below threw ENOENT. `sync.wal` is a sidecar file
    // unrelated to the graph engine (same as config.json / aux.sqlite), so
    // it belongs at the literal, predictable path regardless of engine or
    // path scattering — just make sure that directory exists first.
    fs.mkdirSync(loreDir, { recursive: true });

    const walPath = path.join(loreDir, 'sync.wal');
    if (!fs.existsSync(walPath)) {
        fs.writeFileSync(walPath, '', 'utf-8');
        console.log(`✓ WAL file created at ${walPath}`);
    }

    const gitignorePath = path.join(basePath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
        if (!gitignoreContent.includes('.lore/')) {
            fs.appendFileSync(gitignorePath, '\n# Lore graph data (local-only)\n.lore/\n', 'utf-8');
            console.log(`✓ Added .lore/ to .gitignore`);
        }
    }

    const workspaceName = path.basename(basePath);
    const registry = readWorkspaceRegistry();
    if (!(workspaceName in registry.projects)) {
        upsertWorkspaceMapping(registry, workspaceName, {
            ecosystem: '*',
            paths: [workspaceName, path.basename(basePath)],
        });
        writeWorkspaceRegistry(registry);
        console.log(`✓ Registered workspace '${workspaceName}' in ${workspaceRegistryPath()}`);
    }

    const mcpIndex = args.indexOf('--mcp');
    if (mcpIndex !== -1) {
        const mcpTool = args[mcpIndex + 1] ?? 'antigravity';
        await configureMcp(mcpTool, basePath);
    }

    const stats = await graph.getStats();
    await graph.close();

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`  Lore initialized!`);
    console.log(`  Graph: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
    console.log(`  Path:  ${loreDir}/${graphDirName}/`);
    console.log('');
    console.log('  Next steps:');
    console.log('    lore serve    # Start MCP server');
    console.log('    lore status   # Check graph stats');
    console.log('═══════════════════════════════════════════════════════════');
}

async function configureMcp(tool: string, basePath: string): Promise<void> {
    const serverJsPath = path.resolve(basePath, 'dist', 'mcp', 'server.js');
    const LORE_MCP_URL = 'http://127.0.0.1:3847/mcp';

    let configPath: string;
    let toolEntry: Record<string, unknown>;

    switch (tool) {
        case 'antigravity':
            configPath = path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
            toolEntry = { type: 'stdio', command: 'node', args: [serverJsPath] };
            break;
        case 'cursor':
            configPath = path.join(os.homedir(), '.cursor', 'mcp.json');
            toolEntry = { type: 'stdio', command: 'node', args: [serverJsPath] };
            break;
        case 'claude-code':
        case 'claude':
            // Claude Code reads mcpServers from ~/.claude/settings.json.
            // Schema: { type: "http", url: "<daemon-url>" } (http transport, not stdio).
            configPath = path.join(os.homedir(), '.claude', 'settings.json');
            toolEntry = { type: 'http', url: LORE_MCP_URL };
            break;
        default:
            console.log(`⚠ Unknown MCP tool '${tool}'. Supported: antigravity, cursor, claude-code`);
            return;
    }

    const mcpEntry = { 'groundfloor-lore': toolEntry };

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
