import fs from 'fs';
import path from 'path';
import { openWorkspaceGraph, resolveGraphEngineForPath } from '../../engines/openWorkspaceGraph.js';
import { SyncEngine } from '../../engines/syncEngine.js';
import { ConfigManager } from '../../config/configManager.js';
import { loreHomePath } from '../../config/loreHome.js';
import { readWorkspaceRegistry } from '../../config/workspaceRegistry.js';
import { resolveGraphBasePath } from './shared.js';

export async function statusCommand(_args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    if (!fs.existsSync(loreDir)) {
        console.error('❌ No .lore/ directory found. Run "lore init" first.');
        process.exit(1);
    }

    const graph = openWorkspaceGraph(basePath);
    await graph.initialize();

    const stats = await graph.getStats();
    const syncEngine = new SyncEngine(graph, loreDir, null);
    const syncStatus = syncEngine.getStatus();

    let projectName = '*';
    let ecosystem = '*';
    try {
        const reg = readWorkspaceRegistry();
        for (const [name, mapping] of Object.entries(reg.projects)) {
            for (const pathFragment of mapping.paths) {
                if (basePath.includes(pathFragment)) {
                    projectName = name;
                    ecosystem = mapping.ecosystem;
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
    // Reported, not assumed. This printed "Kùzu" unconditionally, so a
    // Surreal-backed workspace was described as running an engine it does not
    // run, with a path that does not exist.
    const engine = resolveGraphEngineForPath(basePath).engine;
    console.log(`  Engine:     ${engine === 'surreal' ? 'SurrealDB' : 'Kùzu'} (local graph)`);
    console.log(`  Graph:      ${path.join(loreDir, engine === 'surreal' ? 'surreal' : 'graph')}`);
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
    console.log('  Sync');
    console.log(`    WAL pending:   ${syncStatus.walPending} entries`);
    console.log(`    Last sync:     ${syncStatus.lastSync === '1970-01-01T00:00:00.000Z' ? 'never' : syncStatus.lastSync}`);
    console.log(`    Remote:        ${syncStatus.hasAdapter ? 'connected' : 'offline (no adapter configured)'}`);
    console.log(`    Auto-sync:     ${syncStatus.isAutoSyncing ? 'running' : 'off'}`);
    console.log('');

    await graph.close();
}
