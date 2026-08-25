import fs from 'fs';
import path from 'path';
import { openWorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import { resolveGraphBasePath } from './shared.js';

export async function lintCommand(_args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    if (!fs.existsSync(loreDir)) {
        console.error('❌ No .lore/ directory found. Run "lore init" first.');
        process.exit(1);
    }

    const graph = openWorkspaceGraph(basePath);
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
