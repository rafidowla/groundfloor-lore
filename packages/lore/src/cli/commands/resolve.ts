import { openWorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import { resolveGraphBasePath } from './shared.js';

export async function resolveDeferredCommand(args: string[]): Promise<void> {
    const nodeId = args[0];
    if (!nodeId || nodeId === '--help' || nodeId === '-h') {
        console.error('usage: lore resolve-deferred <nodeId> [--commit <sha>]');
        console.error('');
        console.error('Stamps metadata.resolved_at (and optionally metadata.resolved_by_commit) on');
        console.error('a deferred-* Lore node. Once stamped, the node no longer surfaces in recall().');
        console.error('');
        console.error('Example:');
        console.error('  lore resolve-deferred deferred-reconnect-hook --commit b321692');
        process.exit(1);
    }

    if (!nodeId.startsWith('deferred-')) {
        console.error(`Error: node id '${nodeId}' does not start with 'deferred-'.`);
        console.error('Only deferred-* nodes can be resolved with this command.');
        process.exit(1);
    }

    const commitIdx = args.indexOf('--commit');
    const commit = commitIdx >= 0 ? args[commitIdx + 1] : undefined;
    if (commitIdx >= 0 && !commit) {
        console.error('Error: --commit requires a value.');
        process.exit(1);
    }

    const basePath = resolveGraphBasePath();
    const graph = openWorkspaceGraph(basePath);
    await graph.initialize();

    try {
        const { stampResolved } = await import('../../engines/deferred.js');
        const result = await stampResolved(graph, nodeId, commit);
        if (!result) {
            console.error(`Error: deferred node '${nodeId}' not found.`);
            process.exit(1);
        }
        const { metadata } = result;
        console.log(`Resolved deferred node '${nodeId}'.`);
        console.log(`  resolved_at:        ${metadata['resolved_at']}`);
        if (metadata['resolved_by_commit']) {
            console.log(`  resolved_by_commit: ${metadata['resolved_by_commit']}`);
        }
        console.log('');
        console.log('Node remains in graph; subsequent recall() calls will not surface it.');
    } finally {
        await graph.close();
    }
}
