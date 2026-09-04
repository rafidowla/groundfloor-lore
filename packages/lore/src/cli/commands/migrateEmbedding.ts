import path from 'path';
import { loreHome } from '../../config/loreHome.js';
import type { WorkspaceGraph } from '../../engines/openWorkspaceGraph.js';

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

    const basePath = loreHome();
    const loreDir = path.join(basePath, '.lore');

    const { openGraphForCli, CliDaemonLockError } = await import('./shared.js');
    const { LocalEmbeddingProvider } = await import('../../providers/localEmbeddingProvider.js');
    const { OpenAICompatEmbeddingProvider } = await import('../../providers/openAICompatEmbeddingProvider.js');
    const { migrateEmbeddingModel } = await import('../../engines/migrateEmbeddingModel.js');
    const { readFingerprintOrLegacy, getFingerprintPath } = await import('../../engines/embeddingFingerprint.js');

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

    // Finding 11 (round E) — openGraphForCli's LORE_PORT-aware daemon
    // preflight (+ shortened openSurreal budget on the residual lock-held
    // case) replaces what used to be a bare `graph.initialize()` that sat
    // through the full ~15s retry storm before landing in this catch. The
    // launchctl recovery message below is unchanged either way.
    let graph: WorkspaceGraph;
    try {
        graph = await openGraphForCli(basePath);
    } catch (err) {
        const msg = err instanceof CliDaemonLockError
            ? err.message
            : ((err as Error)?.message ?? '');
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
        const result = await migrateEmbeddingModel(basePath, graph, {
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
            console.log('NOTE: --apply DROPS lore_verbatim and re-embeds every LoreNode.');
            console.log('      On a 10k-node graph with the local MiniLM provider this takes ~5 minutes.');
        } else {
            console.log('Migration applied. Daemon should be restarted so it picks up the new fingerprint.');
        }
    } finally {
        await graph.close();
    }
}
