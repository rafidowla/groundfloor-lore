#!/usr/bin/env tsx
/**
 * embedded-teardown-child.ts — child process for the embedded-teardown exit
 * test (test/embedded-abandoned-dispose-exit-unit.ts).
 *
 * Brings up an embedded Lore instance, writes a node (so the outbox replicator
 * has genuinely been started and has ticked), then either disposes it or
 * DELIBERATELY DOES NOT, per argv — and RETURNS.
 *
 * It never calls `process.exit`, for exactly the reason
 * test/helpers/surreal-lifecycle-child.ts doesn't: the property under test is
 * whether the process can drain its own event loop, and an explicit exit would
 * mask the leak the test exists to catch.
 *
 * Not a test itself — invoked only as a child. Argv: <dir> <dispose|abandon>.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const dir = process.argv[2];
const mode = process.argv[3];
if (!dir || (mode !== 'dispose' && mode !== 'abandon' && mode !== 'local')) {
    console.error('usage: embedded-teardown-child.ts <dir> <dispose|abandon|local>');
    throw new Error('bad arguments');
}

// Same isolation contract as tw2a-embedded-lifecycle-unit.ts: dataDir alone
// scopes the instance, so an inherited LORE_HOME must not be able to mask it.
delete process.env['LORE_HOME'];

fs.mkdirSync(path.join(dir, '.lore'), { recursive: true });
fs.writeFileSync(
    path.join(dir, 'workspaces.json'),
    JSON.stringify({
        active: 'default',
        workspaces: [{ name: 'default', path: dir, createdAt: '2026-06-15T00:00:00.000Z', graphEngine: 'surreal' }],
    }, null, 2),
);

const { createLore } = await import('../../packages/lore/src/index.js');

// 'local' gets buildDrain() — the SAME ordered drain the daemon runs — where
// 'embedded' gets the composed variant. Binding no port, so this exercises the
// daemon's teardown wiring (real SQLite sidecars, real verbatim resolver, real
// graph) without standing up a daemon.
const lore = await createLore({ deploymentMode: mode === 'local' ? 'local' : 'embedded', dataDir: dir });
await lore.nodeUpsert({
    id: 'teardown-probe',
    workspace: 'default',
    ecosystem: '*',
    nodeData: {
        id: 'teardown-probe', type: 'note', label: 'teardown probe',
        content: 'a write, so the replicator has started and ticked at least once',
        tags: 'teardown', project: 'default', ecosystem: '*', metadata: '{}',
    },
});

if (mode === 'local') {
    await lore.recall('teardown probe', { workspace: 'default' });
    await lore.dispose('teardown-child-local');
    await lore.dispose('teardown-child-local-again');   // must be idempotent
    console.log('teardown complete: local drain, disposed twice');
    // No process.exit — the parent asserts this drains its own event loop.
} else if (mode === 'dispose') {
    // A READ, so `ensureAccessTracker` creates this graph's access-time
    // tracker and arms its flush timer. Load-bearing, not incidental: the
    // tracker is what turned a closed store back ON in 3.18.0 — its timer
    // outlived the drain and `SurrealGraph.stampAccessTimes` re-opened the
    // store from the background, stranding a native engine that held the host
    // open forever. Without a read here, no tracker exists and this test
    // cannot see that class of bug at all.
    //
    // Deliberately NOT done on the abandon path below. That case asserts a
    // narrow, Lore-owned property (no referenced timer of OURS survives), and
    // a read pulls in dependency-owned timers — onnxruntime and friends — that
    // Lore neither creates nor can clear. Asserting over those would make the
    // case flaky and would not be pinning anything Lore controls.
    await lore.recall('teardown probe', { workspace: 'default' });

    await lore.dispose('teardown-child');
    // Outlive at least one tracker flush interval (the parent sets
    // LORE_ACCESS_FLUSH_MS well below this). A stale flush that fires here
    // and re-opens the store is the regression; the process then never exits.
    await new Promise<void>((resolve) => { setTimeout(resolve, 2_000); });
    console.log('teardown complete: disposed');
    // No process.exit — the parent asserts this drains its own event loop.
} else {
    // The abandoned path: an embedding host that cannot complete its teardown
    // (Atlas's EmbeddedLore.close() skips dispose() when its maintenance lock
    // is wedged, by design) leaves the instance exactly like this.
    //
    // This branch DOES call process.exit, and that is not a cheat — it is the
    // honest scope of what Lore can promise here. An un-closed SurrealGraph
    // holds the libuv loop open by itself (`@surrealdb/node`, measured: a
    // lifecycle child that skips `graph.close()` never exits), and dispose is
    // the only thing that closes it. So "an abandoned instance exits" is NOT
    // achievable and asserting it would pin a promise Lore cannot keep.
    //
    // What IS Lore's to keep, and what the parent asserts, is that abandoning
    // leaves no REFERENCED TIMER of ours on the loop — the replicator's nap
    // used to be one, and it turned every skipped teardown into a permanent
    // hang with an empty `_getActiveHandles()` list and nothing to blame.
    // Reported as a list so the parent can name whatever regresses.
    const resources = process.getActiveResourcesInfo();
    console.log(`teardown complete: abandoned (dispose deliberately not called)`);
    console.log(`RESOURCES: ${JSON.stringify(resources)}`);
    process.exit(0);
}
