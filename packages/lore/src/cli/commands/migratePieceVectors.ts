/**
 * migratePieceVectors.ts — `lore migrate piece-vectors`, D7c (3.23, piece-
 * level vectors), design section 2.8.
 *
 * Thin CLI wrapper over `engines/pieces/pieceIndexBuild.ts`'s
 * `buildPieceIndex` — same shape as `migrateEmbedding.ts` (daemon-lock
 * refusal via `openGraphForCli`/`CliDaemonLockError`, plan banner, result
 * summary), with one deliberate difference: there is no `--apply` flag here.
 * Unlike embedding-model migration (destructive re-embed of the ONE
 * canonical table — dry-run-by-default is the safer default),
 * `buildPieceIndex` is already idempotent by construction (a second run
 * against an already-valid+complete sidecar is a no-op), so the bare command
 * performs the real build; `--dry-run` opts INTO a count-only preview
 * instead.
 *
 * Engine-agnostic: constructs whichever store `openWorkspaceVerbatim`
 * resolves for this workspace (Lance or SQLite) — this command, unlike
 * migrateEmbedding.ts's Lance-only `new VerbatimStore(...)`, must support
 * both, since `test/d7-piece-migration-unit.ts` runs it under both engines.
 */

import path from 'path';
import { loreHome } from '../../config/loreHome.js';
import type { WorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import type { VerbatimStoreApi } from '../../engines/verbatimStoreApi.js';
import type { PieceBuildableStore } from '../../engines/pieces/pieceIndexBuild.js';

export async function migratePieceVectorsCommand(args: string[]): Promise<void> {
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    const drop = args.includes('--drop');

    if (drop && (dryRun || force)) {
        console.error('--drop cannot be combined with --dry-run or --force');
        process.exit(1);
    }

    const basePath = loreHome();
    const loreDir = path.join(basePath, '.lore');

    const { openGraphForCli, CliDaemonLockError } = await import('./shared.js');
    const { openWorkspaceVerbatim, resolveVerbatimEngineForPath } = await import('../../engines/openWorkspaceVerbatim.js');
    const { createEmbeddingProvider } = await import('../../mcp/services.js');
    const { buildPieceIndex } = await import('../../engines/pieces/pieceIndexBuild.js');
    const { getFingerprintPath } = await import('../../engines/embeddingFingerprint.js');

    // Same daemon-lock preflight every other CLI migration uses — refuse
    // fast with actionable recovery steps rather than racing the daemon's
    // single-writer lock (see migrateEmbedding.ts for the identical block).
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
        console.error('  lore migrate piece-vectors');
        console.error('');
        console.error('  launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.groundfloor.lore.plist  # macOS');
        console.error('  systemctl --user start lore                                                       # linux');
        process.exit(1);
    }

    const provider = await createEmbeddingProvider();
    const engine = resolveVerbatimEngineForPath(basePath, {}).engine;
    const store: VerbatimStoreApi = openWorkspaceVerbatim(basePath, provider, {
        // D7c — this CLI builds/maintains the index regardless of the
        // workspace's current retrieval intent (design 2.8: migration is
        // independent of intent, matching this module's own docblock).
        // `pieceVectors: true` only affects the constructor's own
        // `initialize({intentOn})` fast-path for a fresh/empty canonical
        // store — buildPieceIndex below does the real work either way.
        pieceVectors: true,
    });

    console.log('');
    console.log('Piece-vector migration');
    console.log(`  Engine:   ${engine === 'sqlite' ? 'SQLite' : 'LanceDB'}`);
    console.log(`  Provider: ${provider.constructor.name} (${provider.modelId})`);
    console.log(`  Mode:     ${drop ? 'DROP (remove index + sidecar, disable)' : dryRun ? 'DRY-RUN (count only, writes nothing)' : 'BUILD (idempotent — no-op if already current)'}`);
    if (force && !drop) console.log('  Force:    YES (rebuild even if already valid+complete)');
    console.log(`  Fingerprint: ${getFingerprintPath(basePath)}`);
    console.log('');

    try {
        await store.initialize();

        // D7c — buildPieceIndex only needs exportRows() + the store's own
        // piece-index instance (pieceIndexForMigration()); neither is part
        // of VerbatimStoreApi's public contract (same "feature-detect, don't
        // widen the shared interface for one caller" convention D7b's
        // PieceSearchCapableStore already established in
        // recall/pieceSeedSearch.ts) — both concrete engines implement it
        // structurally, so this cast is safe for whichever engine
        // openWorkspaceVerbatim resolved above.
        const buildableStore = store as unknown as PieceBuildableStore;

        const result = await buildPieceIndex(basePath, buildableStore, provider, {
            dryRun,
            force,
            drop,
        });

        console.log('─── Result ──────────────────────────────────');
        console.log(`  Action:          ${result.action}`);
        console.log(`  Nodes scanned:   ${result.nodesScanned}`);
        console.log(`  Nodes rebuilt:   ${result.nodesRebuilt}`);
        console.log(`  Pieces indexed:  ${result.piecesIndexed}${dryRun ? ' (estimated)' : ''}`);
        if (result.reason) console.log(`  Reason:          ${result.reason}`);
        console.log('');

        if (result.action === 'noop') {
            console.log('No-op: the piece index is already built and current. Re-run with --force to rebuild anyway.');
        } else if (result.action === 'dry-run') {
            console.log('Dry-run complete. Re-run without --dry-run to actually build.');
        } else if (result.action === 'dropped') {
            console.log('Piece index dropped. Retrieval falls back to canonical-row search; re-run without --drop to rebuild.');
        } else if (result.action === 'aborted') {
            console.log('Build aborted before completion. The sidecar is left incomplete (stale) — re-run to resume/rebuild.');
        } else {
            console.log('Piece index built. Retrieval picks it up automatically once the workspace\'s piece-vectors intent is on.');
        }
    } finally {
        await store.close();
        await graph.close();
    }
}
