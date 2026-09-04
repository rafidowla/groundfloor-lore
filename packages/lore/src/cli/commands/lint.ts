import fs from 'fs';
import path from 'path';
import { resolveGraphBasePath, openGraphForCli } from './shared.js';

export async function lintCommand(_args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    if (!fs.existsSync(loreDir)) {
        console.error('❌ No .lore/ directory found. Run "lore init" first.');
        process.exit(1);
    }

    // Finding 11 (round E) — refuse fast with a clear message when a
    // running daemon holds this store's lock, instead of the old ~15s
    // openSurreal retry storm ending in a raw driver error.
    const graph = await openGraphForCli(basePath);

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
