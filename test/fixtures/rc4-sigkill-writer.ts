#!/usr/bin/env tsx
/**
 * test/fixtures/rc4-sigkill-writer.ts — child-process fixture for
 * the rc4 workspace-lifecycle audit's SIGKILL-mid-write scenario.
 *
 * Opens a SurrealGraph at the workspace dir passed as argv[2], then
 * writes nodes in a tight loop forever. Parent test sends SIGKILL
 * after a short delay; this fixture must crash mid-loop so the
 * parent can then assert the workspace dir is recoverable (no
 * orphan tmp files, no half-written manifest, etc.). The parent
 * does not reopen the graph in the same process — see
 * test/surreal-crash-recovery-unit.ts for the in-process
 * close/reopen + SIGKILL-then-reopen coverage.
 *
 * stdout: emits the count of completed upserts so the parent can
 * size its kill-window. Flushes line-buffered.
 */

import { SurrealGraph } from '../../packages/lore/src/engines/surrealGraph.js';

const wsDir = process.argv[2];
if (!wsDir) {
    console.error('usage: rc4-sigkill-writer.ts <workspaceDir>');
    process.exit(1);
}

const graph = new SurrealGraph(wsDir);

(async () => {
    await graph.initialize();
    let i = 0;
    // Run until SIGKILL. Each upsertNode is one SurrealDB write — the
    // parent kills somewhere in this loop.
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const id = `sigkill-${i}`;
        await graph.upsertNode({
            id,
            type: 'note',
            label: `sigkill #${i}`,
            content: `under-write content ${i}`,
            tags: 'sigkill,under-write',
            project: '*', ecosystem: '*', metadata: '{}',
            security_scopes: [],
        });
        i++;
        if (i % 10 === 0) {
            process.stdout.write(`${i}\n`);
        }
    }
})().catch((err) => {
    console.error(`writer crashed: ${(err as Error).message}`);
    process.exit(2);
});
