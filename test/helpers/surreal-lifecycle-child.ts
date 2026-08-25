#!/usr/bin/env tsx
/**
 * surreal-lifecycle-child.ts — child process for the SurrealDB exit test.
 *
 * Exercises a full engine lifecycle (open → write → read → edge → traverse →
 * close) and then simply RETURNS. It deliberately never calls `process.exit`:
 * the whole point of test/surreal-process-exit-unit.ts is whether the process
 * can drain its event loop on its own, and an explicit exit would mask exactly
 * the leaked-handle bug the test exists to catch.
 *
 * Not a test itself — invoked only as a child. Argv: <dir>.
 */

import { SurrealGraph } from '../../packages/lore/src/engines/surrealGraph.js';

const dir = process.argv[2];
if (!dir) {
    console.error('usage: surreal-lifecycle-child.ts <dir>');
    throw new Error('missing directory argument');
}

const graph = new SurrealGraph(dir, { workspaceId: 'exit-ws' });
await graph.initialize();

for (const id of ['a', 'b']) {
    await graph.upsertNode({
        id,
        type: 'decision',
        label: `Label ${id}`,
        content: `Content ${id}`,
        tags: ['exit'],
        project: 'proj',
        ecosystem: '*',
        metadata: '{}',
    });
}
await graph.addEdge({ sourceId: 'a', targetId: 'b', relation: 'refers_to' });
await graph.getNode('a');
await graph.search('Content', 10);
await graph.traverse('a', 2);
await graph.getStats();
await graph.close();

process.stdout.write('lifecycle complete\n');
