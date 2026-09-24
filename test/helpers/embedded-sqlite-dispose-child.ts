#!/usr/bin/env tsx
/**
 * embedded-sqlite-dispose-child.ts — child process for
 * test/embedded-sqlite-dispose-settles-unit.ts.
 *
 * Boots a REAL embedded Lore instance on a FRESH home (no workspaces.json
 * seeded ahead of time), so the fresh-home seeding path picks the new
 * default graph engine ('sqlite', per graphEngineSelector.ts
 * resolveNewWorkspaceGraphEngine — unless LORE_DEFAULT_GRAPH_ENGINE=surreal
 * is set, which this child never does). Writes one node with asyncEmbed:true
 * so the write is genuinely routed through the outbox and the replicator has
 * ticked at least once against the SqliteGraph boot graph, then disposes and
 * reports how long dispose() took.
 *
 * This is the exact shape that hung (pr/3.21.0-01..04): outboxReplicator's
 * between-tick nap is a deliberately UNREF'D setTimeout (outbox/replicator.ts
 * `sleep`), which only fires on its own schedule if something ELSE keeps the
 * event loop alive until then. SurrealGraph's own native handle used to do
 * that by accident; SqliteGraph (better-sqlite3) opens no such handle, so
 * once it is the boot graph and dispose()'s drain has closed everything else,
 * nothing pumps the loop and the nap's timer never fires — stop()'s
 * `await loopPromise` (shutdownDrain.ts step 4) hangs forever.
 *
 * Never calls process.exit — the parent asserts this drains its own event
 * loop and exits on its own within a bound.
 *
 * Not a test itself — invoked only as a child. Argv: <dir>.
 */

const dir = process.argv[2];
if (!dir) {
    console.error('usage: embedded-sqlite-dispose-child.ts <dir>');
    throw new Error('bad arguments');
}

// Same isolation contract as the sibling embedded-teardown-child.ts: dataDir
// alone scopes the instance, and this child must NOT inherit a surreal
// escape hatch from the parent's environment.
delete process.env['LORE_HOME'];
delete process.env['LORE_DEFAULT_GRAPH_ENGINE'];

const { createLore } = await import('../../packages/lore/src/index.js');
const { loadWorkspaces } = await import('../../packages/lore/src/config/workspaces.js');

const lore = await createLore({ deploymentMode: 'embedded', dataDir: dir });

// Confirm this boot really landed on the engine under test — a silent
// fallback to 'surreal' would make the rest of this child pass for the
// wrong reason.
const file = loadWorkspaces(dir);
const entry = file.workspaces.find((w) => w.name === file.active);
console.log(`GRAPH_ENGINE: ${entry?.graphEngine ?? '(absent)'}`);
if (entry?.graphEngine !== 'sqlite') {
    throw new Error(`expected fresh-home default 'sqlite', got ${JSON.stringify(entry?.graphEngine)}`);
}

await lore.nodeUpsert({
    id: 'sqlite-dispose-probe',
    workspace: 'default',
    ecosystem: '*',
    nodeData: {
        id: 'sqlite-dispose-probe', type: 'note', label: 'sqlite dispose probe',
        content: 'a write routed through the outbox, so the replicator has started and ticked at least once',
        tags: 'teardown', project: 'default', ecosystem: '*', metadata: '{}',
    },
    asyncEmbed: true,
} as never);

const startedAt = Date.now();
await lore.dispose('sqlite-dispose-child');
const disposeMs = Date.now() - startedAt;
console.log(`DISPOSE_MS: ${disposeMs}`);
console.log('teardown complete: sqlite disposed');
// No process.exit — the parent asserts this drains its own event loop.
