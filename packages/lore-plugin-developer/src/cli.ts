/**
 * developer/cli.ts — Developer-plugin CLI subcommands.
 *
 * `lore index` and `lore ingest-files` are developer-specific (they
 * reach GitNexus + the CodeFile / CodeSymbol tables the plugin owns).
 * They used to live in core cli/commands.ts, behind
 * `if (pluginRegistry.isActive('developer'))` blocks — exactly the
 * red-flag pattern CLAUDE.md warns against. Option C: move them here
 * and register them through ILorePlugin.registerCliCommands.
 *
 * Both commands reboot their own LocalGraph + PluginRegistry so they
 * work as standalone CLI invocations (no daemon required).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { LocalGraph } from '@lore-core/engines/localGraph.js';
import { ConfigManager } from '@lore-core/config/configManager.js';
import { PluginRegistry } from '@lore-core/plugins/registry.js';
import type { DeveloperApi, IndexResult } from './api.js';

function resolveGraphBasePath(): string {
    return path.join(os.homedir(), '.groundfloor');
}

async function bootForCli(): Promise<{ graph: LocalGraph; devApi: DeveloperApi | undefined; close: () => Promise<void> }> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');
    if (!fs.existsSync(loreDir)) {
        console.error('❌ No .lore/ directory found. Run "lore init" first.');
        process.exit(1);
    }
    const graph = new LocalGraph(basePath);
    const registry = new PluginRegistry(new ConfigManager(loreDir));
    registry.boot();
    await graph.initialize();
    await registry.registerSchemas(graph.createPluginGraphContext());
    const devPlugin = registry.active().find((p) => p.name === 'developer');
    const devApi = devPlugin?.api as DeveloperApi | undefined;
    return { graph, devApi, close: () => graph.close() };
}

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

export async function indexCommand(args: string[]): Promise<void> {
    const { graph, devApi, close } = await bootForCli();
    if (!devApi) {
        console.error('❌ `lore index` requires the "developer" plugin. Add "developer" to .lore/config.json plugins[].');
        await close();
        process.exit(1);
    }

    const specificRepo = args[0];
    if (specificRepo) {
        const repoEntry = devApi.getGitNexusRepo(specificRepo);
        if (!repoEntry) {
            console.error(`❌ Repository '${specificRepo}' not found in the code-index registry.`);
            console.error('  Available repos:');
            for (const repo of devApi.listGitNexusRepos()) {
                console.error(`    - ${repo.name} (${repo.stats.nodes} symbols)`);
            }
            await close();
            process.exit(1);
        }
        console.log(`→ Indexing '${specificRepo}' from the code index...`);
        const result = await devApi.importFromGitNexus(repoEntry);
        printIndexResult(result);
    } else {
        const repos = devApi.listGitNexusRepos();
        if (repos.length === 0) {
            console.error('❌ No indexed repos found.');
            console.error('  Run "gitnexus analyze <path>" to build the code index for a repo first.');
            await close();
            process.exit(1);
        }
        console.log(`→ Indexing ${repos.length} repo(s) from the code index...`);
        console.log('');
        for (const repo of repos) {
            console.log(`  ─── ${repo.name} (${repo.stats.nodes} indexed symbols) ───`);
            const result = await devApi.importFromGitNexus(repo);
            printIndexResult(result);
            console.log('');
        }
    }

    const stats = await graph.getStats();
    const devStats = stats.pluginStats?.['developer'] ?? {};
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Unified Graph Stats:');
    console.log(`    Knowledge: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
    console.log(`    Code:      ${devStats['codeSymbolCount'] ?? 0} symbols, ${devStats['codeRelationCount'] ?? 0} relations`);
    console.log('═══════════════════════════════════════════════════════════');

    await close();
}

export async function ingestFilesCommand(_args: string[]): Promise<void> {
    const { devApi, close } = await bootForCli();
    if (!devApi) {
        console.error('  ✗ ingest-files requires the "developer" plugin. Add "developer" to .lore/config.json plugins[].');
        await close();
        return;
    }
    console.log('');
    console.log('  Ingesting files from existing CodeSymbols…');
    const stats = await devApi.ingestFilesFromSymbols();
    console.log(`  ✓ ${stats.filesCreated} CodeFile node(s) synthesized`);
    console.log(`  ✓ ${stats.edgesCreated} FileContains edge(s) created`);
    await close();
    console.log('');
    console.log('  Next: `lore reconnect` to link LoreNode knowledge to these files via semantic similarity.');
}
