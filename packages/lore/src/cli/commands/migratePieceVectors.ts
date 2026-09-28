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
 *
 * `--data-dir <path>` (3.24.2): target an embedded host's own
 * `createLore({ dataDir })` root instead of `loreHome()`. Without it the
 * target is `loreHome()` verbatim, exactly as before. Path resolution and the
 * build itself are shared with the exported `rebuildPieceIndex()` API
 * (engines/pieces/rebuildPieceIndex.ts).
 */

import type { WorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import type { PieceRebuildTarget } from '../../engines/pieces/rebuildPieceIndex.js';

/** Value of `--data-dir <path>` / `--data-dir=<path>`; undefined when absent. */
function parseDataDir(args: string[]): string | undefined {
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a.startsWith('--data-dir=')) return a.slice('--data-dir='.length);
        if (a === '--data-dir') {
            const v = args[i + 1];
            if (v === undefined || v.startsWith('--')) {
                console.error('--data-dir requires a path');
                process.exit(1);
            }
            return v;
        }
    }
    return undefined;
}

export async function migratePieceVectorsCommand(args: string[]): Promise<void> {
    const dryRun = args.includes('--dry-run');
    const force = args.includes('--force');
    const drop = args.includes('--drop');

    if (drop && (dryRun || force)) {
        console.error('--drop cannot be combined with --dry-run or --force');
        process.exit(1);
    }

    const dataDir = parseDataDir(args);

    const { openGraphForCli, CliDaemonLockError } = await import('./shared.js');
    const { resolveVerbatimEngineForPath } = await import('../../engines/openWorkspaceVerbatim.js');
    const { createEmbeddingProvider } = await import('../../mcp/services.js');
    const { resolvePieceRebuildTarget, rebuildPieceIndexAt, acquirePieceRebuildLock, PieceIndexDataDirInUseError } =
        await import('../../engines/pieces/rebuildPieceIndex.js');
    const { getFingerprintPath } = await import('../../engines/embeddingFingerprint.js');

    let target: PieceRebuildTarget;
    try {
        target = resolvePieceRebuildTarget(dataDir);
    } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
    }
    const basePath = target.basePath;

    let graph: { close(): Promise<void> } | WorkspaceGraph;
    if (dataDir !== undefined) {
        // An embedded host's data root: no LORE_HOME daemon owns it, so the
        // lock preflight is a short-budget direct open. If the host is still
        // running, tell the operator to stop THAT host — the launchd recipe
        // below would stop an unrelated daemon.
        try {
            graph = await acquirePieceRebuildLock(target);
        } catch (err) {
            console.error('');
            console.error(`Could not open ${basePath}: ${(err as Error)?.message ?? ''}`);
            if (err instanceof PieceIndexDataDirInUseError) {
                console.error('');
                console.error('Stop (or dispose the Lore instance of) the host that owns this data directory, then re-run:');
                console.error('');
                console.error(`  lore migrate piece-vectors --data-dir ${dataDir}`);
            }
            process.exit(1);
        }
    } else try {
        // Same daemon-lock preflight every other CLI migration uses — refuse
        // fast with actionable recovery steps rather than racing the daemon's
        // single-writer lock (see migrateEmbedding.ts for the identical block).
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
    const engine = resolveVerbatimEngineForPath(basePath, { home: target.home }).engine;

    console.log('');
    console.log('Piece-vector migration');
    if (dataDir !== undefined) console.log(`  Data dir: ${basePath}`);
    console.log(`  Engine:   ${engine === 'sqlite' ? 'SQLite' : 'LanceDB'}`);
    console.log(`  Provider: ${provider.constructor.name} (${provider.modelId})`);
    console.log(`  Mode:     ${drop ? 'DROP (remove index + sidecar, disable)' : dryRun ? 'DRY-RUN (count only, writes nothing)' : 'BUILD (idempotent — no-op if already current)'}`);
    if (force && !drop) console.log('  Force:    YES (rebuild even if already valid+complete)');
    console.log(`  Fingerprint: ${getFingerprintPath(basePath)}`);
    console.log('');

    try {
        // rebuildPieceIndexAt opens whichever store openWorkspaceVerbatim
        // resolves (Lance or SQLite) with pieceVectors: true — this CLI
        // builds/maintains the index regardless of the workspace's current
        // retrieval intent (design 2.8) — and runs buildPieceIndex on it.
        const result = await rebuildPieceIndexAt(target, provider, { dryRun, force, drop });

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
        await graph.close();
    }
}
