#!/usr/bin/env tsx
/**
 * surreal-crash-writer.ts — child process for the SurrealDB crash test.
 *
 * Opens a SurrealGraph on the given directory and writes rows forever,
 * printing `committed <n>` on stdout AFTER each write resolves. The parent
 * (test/surreal-crash-recovery-unit.ts) reads that line to learn the
 * high-water mark of genuinely-committed rows, then SIGKILLs this process
 * group mid-write. Every row at or below the last reported index must survive
 * the crash.
 *
 * Printing AFTER the await is the whole point: a row reported here is one the
 * engine acknowledged, so "it's missing after the crash" is unambiguously data
 * loss rather than a race in the harness.
 *
 * Not a test itself — invoked only as a child. Argv: <dir> <backend>.
 */

import { SurrealGraph } from '../../packages/lore/src/engines/surrealGraph.js';
import type { SurrealBackend } from '../../packages/lore/src/engines/surreal/surrealConnection.js';

const dir = process.argv[2];
const backend = (process.argv[3] ?? 'surrealkv') as SurrealBackend;
if (!dir) {
    console.error('usage: surreal-crash-writer.ts <dir> [surrealkv|rocksdb]');
    process.exit(2);
}

const graph = new SurrealGraph(dir, { backend });
await graph.initialize();

for (let i = 0; ; i++) {
    await graph.upsertNode({
        id: `row-${i}`,
        type: 'decision',
        label: `row ${i}`,
        content: `Content ${i}`,
        tags: ['durable'],
        project: 'proj',
        ecosystem: '*',
        metadata: '{}',
    });
    // Flush synchronously so the parent sees the high-water mark even if the
    // kill lands in the very next tick.
    process.stdout.write(`committed ${i}\n`);
}
