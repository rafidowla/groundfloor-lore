import fs from 'fs';
import path from 'path';
import { openWorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import { SyncEngine } from '../../engines/syncEngine.js';
import { resolveGraphBasePath } from './shared.js';

export async function syncCommand(_args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    if (!fs.existsSync(loreDir)) {
        console.error('❌ No .lore/ directory found. Run "lore init" first.');
        process.exit(1);
    }

    const graph = openWorkspaceGraph(basePath);
    await graph.initialize();

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
