import path from 'path';
import { loreHome } from '../../config/loreHome.js';

export async function reconsumeCommand(args: string[]): Promise<void> {
    await reconnectCommand([...args, '--apply']);
}

export async function reconnectCommand(args: string[]): Promise<void> {
    const { openWorkspaceGraph } = await import('../../engines/openWorkspaceGraph.js');
    const { VerbatimStore } = await import('../../engines/verbatimStore.js');
    const { reconnectGraph } = await import('../../engines/reconnect.js');

    const apply = args.includes('--apply');
    const force = args.includes('--force');
    const full = args.includes('--full');
    const kIndex = args.indexOf('--k');
    const tIndex = args.indexOf('--threshold');
    const sinceIndex = args.indexOf('--since');
    const k = kIndex >= 0 ? parseInt(args[kIndex + 1], 10) : 5;
    const threshold = tIndex >= 0 ? parseFloat(args[tIndex + 1]) : 0.65;
    const sinceArg: string | undefined = sinceIndex >= 0 ? args[sinceIndex + 1] : undefined;

    const basePath = loreHome();
    const loreDir = path.join(basePath, '.lore');
    const cursorPath = path.join(loreDir, 'reconnect.cursor');

    let since: string | undefined = sinceArg;
    if (!since && !full) {
        try {
            since = (await import('node:fs')).default.readFileSync(cursorPath, 'utf-8').trim() || undefined;
        } catch { /* no cursor yet — first run; full sweep */ }
    }

    const graph = openWorkspaceGraph(basePath);
    const verbatim = new VerbatimStore(basePath);
    await graph.initialize();

    console.log('');
    const sweepLabel = since ? `incremental since ${since}` : 'full sweep';
    console.log(`  Reconnect pass — k=${k}, threshold=${threshold}, mode=${apply ? 'APPLY' : 'dry-run'}${force ? ', force=true' : ''}, ${sweepLabel}`);
    const startedIso = new Date().toISOString();
    const result = await reconnectGraph(graph, verbatim, { k, minSim: threshold, dryRun: !apply, force, since });

    console.log(`  ✓ Scanned ${result.candidatesScanned} node(s); embeddings added: ${result.embeddingsAdded}, skipped (hash match): ${result.embeddingsSkipped}`);
    const buckets = Object.entries(result.distribution).sort((a, b) => Number(b[0]) - Number(a[0]));
    if (buckets.length) {
        console.log('  Similarity distribution (all neighbors, before threshold):');
        for (const [bucket, count] of buckets.slice(0, 10)) {
            const bar = '█'.repeat(Math.min(40, Math.round(count / 2)));
            console.log(`    ≥ ${bucket.padStart(4)}  ${bar}  (${count})`);
        }
    }
    console.log(`  ✓ Proposed edges at threshold ${threshold}: ${result.proposedEdges.length}`);

    if (apply) {
        const pruned = Object.entries(result.prunedByOwner)
            .map(([owner, n]) => `${owner}:${n}`)
            .join('  ');
        console.log(`  ✓ Pruned — ${pruned || '(nothing)'}`);
        console.log(`  ✓ Inserted — core:${result.coreEdgesInserted}`);
        if (!full) {
            try {
                (await import('node:fs')).default.writeFileSync(cursorPath, startedIso, 'utf-8');
            } catch (err) {
                console.error(`  (warn) could not persist reconnect cursor at ${cursorPath}: ${(err as Error).message}`);
            }
        }
    } else {
        console.log('');
        console.log('  (dry run — nothing was written. Re-run with --apply to commit.)');
    }
    await graph.close();
}
