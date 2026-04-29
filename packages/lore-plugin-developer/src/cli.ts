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
import { loreHome } from '@lore-core/config/loreHome.js';
import type { DeveloperApi, IndexResult } from './api.js';

function resolveGraphBasePath(): string {
    return loreHome();
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

/* ─── lore repos — Phase 1a Add-Project CLI ────────────────────── */

const REPOS_HELP = `Usage: lore repos <subcommand> [args]

Subcommands:
  list                                  Show all indexed repositories with freshness
  add <path> [--install-hook] [--force] Analyze + import a single repo
  batch <parent> [opts]                 Discover git repos under <parent> and add them
                                          --depth shallow|deep   (default: shallow)
                                          --install-hook         Install post-commit hook in each
                                          --dry-run              Preview only — list, do not add
                                          --yes                  Skip the confirmation prompt
  remove <name>                         Drop the repo from Lore's graph and registry
  freshness <name> [--stale-after-h N]  Show whether the index is up-to-date (default 24h threshold)
  install-hook <path> [--force]         Install the post-commit auto-refresh hook only

Examples:
  lore repos list
  lore repos add /Users/me/code/my-app --install-hook
  lore repos batch /Users/me/code/v3 --install-hook
  lore repos batch /Users/me/code --depth deep --dry-run
  lore repos remove old-repo
`;

export async function reposCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (!sub || sub === '--help' || sub === '-h') {
        console.log(REPOS_HELP);
        process.exit(sub ? 0 : 1);
    }
    const subArgs = args.slice(1);

    switch (sub) {
        case 'list':
            return reposList();
        case 'add':
            return reposAdd(subArgs);
        case 'batch':
            return reposBatch(subArgs);
        case 'remove':
            return reposRemove(subArgs);
        case 'freshness':
            return reposFreshness(subArgs);
        case 'install-hook':
            return reposInstallHook(subArgs);
        default:
            console.error(`Unknown subcommand: ${sub}`);
            console.error('');
            console.log(REPOS_HELP);
            process.exit(1);
    }
}

async function reposList(): Promise<void> {
    const { devApi, close } = await bootForCli();
    if (!devApi) {
        console.error('  ✗ repos requires the "developer" plugin. Add "developer" to .lore/config.json plugins[].');
        await close();
        process.exit(1);
    }
    const repos = devApi.listGitNexusRepos();
    if (repos.length === 0) {
        console.log('No repos indexed yet. Use `lore repos add <path>` to add one.');
        await close();
        return;
    }
    console.log('');
    console.log(`Indexed repositories (${repos.length}):`);
    console.log('');
    for (const repo of repos) {
        const fresh = devApi.getRepoFreshness(repo.name, 24);
        const status = fresh
            ? (fresh.status === 'fresh' ? '✓ fresh'
                : fresh.status === 'stale' ? `⚠ stale (${fresh.reason})`
                : '✗ never indexed')
            : '?';
        console.log(`  ${repo.name.padEnd(30)} ${status}`);
        console.log(`    path:        ${repo.path}`);
        console.log(`    indexed at:  ${repo.indexedAt}`);
        if (repo.stats) {
            console.log(`    stats:       ${repo.stats.nodes} symbols, ${repo.stats.edges} relations, ${repo.stats.embeddings ?? 0} embeddings`);
        }
        console.log('');
    }
    await close();
}

async function reposAdd(args: string[]): Promise<void> {
    const repoPath = args.find((a) => !a.startsWith('--'));
    if (!repoPath) {
        console.error('Usage: lore repos add <path> [--install-hook] [--force]');
        process.exit(1);
    }
    const installHook = args.includes('--install-hook');
    const force = args.includes('--force');

    const { devApi, close } = await bootForCli();
    if (!devApi) {
        console.error('  ✗ repos add requires the "developer" plugin.');
        await close();
        process.exit(1);
    }
    console.log('');
    console.log(`  Adding ${repoPath}…`);
    if (force) console.log('  (--force: re-running analyze even if HEAD is current)');
    if (installHook) console.log('  (--install-hook: will install .git/hooks/post-commit if absent)');
    console.log('');
    try {
        const result = await devApi.addRepo(repoPath, { installHook, force });
        console.log(`  ✓ ${result.name}: ${result.imported ? 'imported' : 'skipped'}, ${result.symbolCount ?? 0} symbols`);
        if (result.analyzed) console.log('  ✓ Analyze run');
        if (result.hookInstalled) console.log('  ✓ Post-commit hook installed');
        if (result.warnings && result.warnings.length > 0) {
            for (const w of result.warnings) console.log(`  ⚠ ${w}`);
        }
    } catch (e) {
        console.error(`  ✗ ${(e as Error).message}`);
        await close();
        process.exit(1);
    }
    await close();
}

async function reposBatch(args: string[]): Promise<void> {
    const parent = args.find((a) => !a.startsWith('--'));
    if (!parent) {
        console.error('Usage: lore repos batch <parent> [--depth shallow|deep] [--install-hook] [--dry-run] [--yes]');
        process.exit(1);
    }
    const depthIdx = args.indexOf('--depth');
    const depth = (depthIdx >= 0 ? args[depthIdx + 1] : 'shallow') as 'shallow' | 'deep';
    if (depth !== 'shallow' && depth !== 'deep') {
        console.error(`Invalid --depth: ${depth}. Must be 'shallow' or 'deep'.`);
        process.exit(1);
    }
    const installHook = args.includes('--install-hook');
    const dryRun = args.includes('--dry-run');
    const yes = args.includes('--yes');

    const { devApi, close } = await bootForCli();
    if (!devApi) {
        console.error('  ✗ repos batch requires the "developer" plugin.');
        await close();
        process.exit(1);
    }

    console.log('');
    console.log(`  Discovering git repos under ${parent} (depth: ${depth})…`);
    const found = devApi.discoverRepos(parent, { depth });
    if (found.length === 0) {
        console.log('  No git repositories found.');
        await close();
        return;
    }
    console.log('');
    console.log(`  Found ${found.length} repos:`);
    for (const r of found) {
        const tag = r.alreadyIndexed ? '(already indexed)' : '(new)';
        console.log(`    ${r.name.padEnd(30)} ${tag}  ${r.path}`);
    }
    const toAdd = found.filter((r) => !r.alreadyIndexed);
    console.log('');
    console.log(`  ${toAdd.length} new repo(s) would be added.`);
    if (dryRun) {
        console.log('  --dry-run: stopping. Re-run without --dry-run to add.');
        await close();
        return;
    }
    if (toAdd.length === 0) {
        await close();
        return;
    }
    if (!yes) {
        console.log('');
        console.log('  Re-run with --yes to confirm and start indexing.');
        await close();
        return;
    }

    console.log('');
    console.log('  Adding repos sequentially (this may take a few minutes)…');
    let okCount = 0;
    let failCount = 0;
    for (const r of toAdd) {
        process.stdout.write(`  • ${r.name}… `);
        try {
            const res = await devApi.addRepo(r.path, { installHook });
            console.log(`✓ ${res.symbolCount ?? 0} symbols${res.hookInstalled ? ' (+ hook)' : ''}`);
            okCount++;
        } catch (e) {
            console.log(`✗ ${(e as Error).message}`);
            failCount++;
        }
    }
    console.log('');
    console.log(`  Done. ${okCount} added, ${failCount} failed.`);
    await close();
}

async function reposRemove(args: string[]): Promise<void> {
    const name = args[0];
    if (!name) {
        console.error('Usage: lore repos remove <name>');
        process.exit(1);
    }
    const { devApi, close } = await bootForCli();
    if (!devApi) {
        console.error('  ✗ repos remove requires the "developer" plugin.');
        await close();
        process.exit(1);
    }
    try {
        const result = await devApi.removeRepo(name);
        console.log(`  ✓ Removed ${result.name}: ${result.symbolsCleared} symbols cleared, registry updated: ${result.registryUpdated}`);
    } catch (e) {
        console.error(`  ✗ ${(e as Error).message}`);
        await close();
        process.exit(1);
    }
    await close();
}

async function reposFreshness(args: string[]): Promise<void> {
    const name = args.find((a) => !a.startsWith('--'));
    if (!name) {
        console.error('Usage: lore repos freshness <name> [--stale-after-h N]');
        process.exit(1);
    }
    const staleIdx = args.indexOf('--stale-after-h');
    const staleAfter = staleIdx >= 0 ? Number(args[staleIdx + 1]) : 24;

    const { devApi, close } = await bootForCli();
    if (!devApi) {
        console.error('  ✗ repos freshness requires the "developer" plugin.');
        await close();
        process.exit(1);
    }
    const fresh = devApi.getRepoFreshness(name, staleAfter);
    if (!fresh) {
        console.error(`  ✗ Repo not found: ${name}`);
        await close();
        process.exit(1);
    }
    console.log('');
    console.log(`  Repo:                 ${fresh.name}`);
    console.log(`  Status:               ${fresh.status}${fresh.reason ? ' — ' + fresh.reason : ''}`);
    console.log(`  Indexed at:           ${fresh.indexedAt}`);
    console.log(`  Hours since index:    ${Math.round(fresh.hoursSinceIndex)}h`);
    console.log(`  Last indexed commit:  ${fresh.lastIndexedCommit || '(none)'}`);
    console.log(`  Current HEAD commit:  ${fresh.currentHeadCommit ?? '(unknown)'}`);
    console.log(`  Behind HEAD:          ${fresh.behindHead}`);
    await close();
}

async function reposInstallHook(args: string[]): Promise<void> {
    const repoPath = args.find((a) => !a.startsWith('--'));
    if (!repoPath) {
        console.error('Usage: lore repos install-hook <path> [--force]');
        process.exit(1);
    }
    const force = args.includes('--force');
    const { devApi, close } = await bootForCli();
    if (!devApi) {
        console.error('  ✗ install-hook requires the "developer" plugin.');
        await close();
        process.exit(1);
    }
    try {
        const result = devApi.installPostCommitHook(repoPath, { force });
        if (result.installed) {
            console.log(`  ✓ Post-commit hook installed in ${repoPath}/.git/hooks/post-commit`);
        } else {
            console.log(`  · ${result.reason ?? 'not installed'} (use --force to overwrite)`);
        }
    } catch (e) {
        console.error(`  ✗ ${(e as Error).message}`);
        await close();
        process.exit(1);
    }
    await close();
}
