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
import { execSync } from 'child_process';
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
            console.error('  Run `lore analyze <path>` to build the code index for a repo first.');
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

/**
 * analyzeCommand — `lore analyze <path> [extra args...]`
 *
 * Thin wrapper around the underlying code indexer. Lets users build
 * the code index using only Lore commands, without ever having to
 * learn or type the indexer's name. Streams the indexer's output
 * directly so progress and errors stay visible. Auto-installs the
 * indexer on first run if it's missing.
 *
 * Forwards extra args after <path> to the indexer (e.g.
 * `--embeddings`, `--no-cache`). Exits with the indexer's exit code.
 *
 * Daemon-aware? No — the indexer writes to its own files; Lore reads
 * from there via `lore index` afterwards.
 *
 * Plugin boundary: this command lives in the developer plugin
 * because the indexer (gitnexus) is plugin-owned vocabulary. Core's
 * cli/index.ts dispatches to it via registerCliCommands.
 */
function findIndexerBin(): string | null {
    const candidates = [
        '/opt/homebrew/bin/gitnexus',
        '/usr/local/bin/gitnexus',
        path.join(os.homedir(), '.nvm/versions/node', process.version, 'bin/gitnexus'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

export async function analyzeCommand(args: string[]): Promise<void> {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        console.log('Usage: lore analyze <path> [--embeddings] [--no-cache] [...]');
        console.log('');
        console.log('  Builds the code index for a repository so Lore\'s code_*');
        console.log('  MCP tools (code_query, code_full_context, code_impact, etc.)');
        console.log('  can see the symbols. After analyze finishes, run `lore index`');
        console.log('  to import the symbols into the unified knowledge graph.');
        console.log('');
        console.log('  Extra flags are forwarded to the underlying indexer.');
        console.log('  The indexer is auto-installed on first run if missing.');
        process.exit(args.length === 0 ? 1 : 0);
    }

    let indexerBin = findIndexerBin();
    if (!indexerBin) {
        console.log('  · Code indexer not found. Installing (this may take a minute)...');
        try {
            execSync('npm install -g gitnexus', { stdio: 'inherit' });
        } catch (installError) {
            console.error('');
            console.error(`  ✗ Code indexer install failed: ${(installError as Error).message}`);
            console.error('    You can retry manually: npm install -g gitnexus');
            process.exit(1);
        }
        indexerBin = findIndexerBin();
        if (!indexerBin) {
            console.error('');
            console.error('  ✗ Code indexer install reported success but binary still not on PATH.');
            console.error('    Check your npm global bin directory.');
            process.exit(1);
        }
        console.log('  ✓ Code indexer installed.');
        console.log('');
    }

    try {
        const escaped = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ');
        execSync(`${indexerBin} analyze ${escaped}`, { stdio: 'inherit' });
    } catch (analyzeError) {
        const exitCode = (analyzeError as { status?: number }).status ?? 1;
        process.exit(exitCode);
    }
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
