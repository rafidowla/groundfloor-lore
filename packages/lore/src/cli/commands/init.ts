import fs from 'fs';
import path from 'path';
import os from 'os';
import { openWorkspaceGraph, resolveGraphEngineForPath } from '../../engines/openWorkspaceGraph.js';
import { loreHomePath } from '../../config/loreHome.js';
import {
    readWorkspaceRegistry,
    writeWorkspaceRegistry,
    upsertWorkspaceMapping,
    workspaceRegistryPath,
} from '../../config/workspaceRegistry.js';
import { resolveGraphBasePath } from './shared.js';

export async function initCommand(args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    console.log(`→ Initializing Lore in ${basePath}`);

    const graph = openWorkspaceGraph(basePath);
    await graph.initialize();
    const engine = resolveGraphEngineForPath(basePath).engine;
    const graphDirName = engine === 'surreal' ? 'surreal' : 'graph';
    console.log(`✓ ${engine === 'surreal' ? 'SurrealDB' : 'Kùzu'} graph initialized at ${loreDir}/${graphDirName}/`);

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
