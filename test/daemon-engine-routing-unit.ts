#!/usr/bin/env tsx
/**
 * daemon-engine-routing-unit.ts — the daemon reads and writes the engine each
 * workspace DECLARES.
 *
 * ── THE BUG THIS CLOSES ─────────────────────────────────────────────────────
 *
 * `graphEngine: 'surreal'` was reachable from the CLI (`openWorkspaceGraph`)
 * and from `lore migrate engine` (`LocalGraphRegistry.getGraphHandle`) and from
 * NOWHERE ELSE. The daemon's boot factory returned `new LocalGraph(...)`
 * unconditionally in local mode, and all ~44 per-workspace resolver call sites
 * went through `LocalGraphRegistry.getOrOpen`, which is the KÙZU substrate
 * accessor and hands back a `LocalGraph` for every workspace whatever it
 * declares.
 *
 * That did not fail. A Surreal-backed workspace still carries a real, EMPTY
 * Kùzu database, so the daemon read it and answered honestly about the wrong
 * store: bulk writes landed there and returned `ok:true`, `export_snapshot`
 * produced an empty JSONL, the retention sweep reported `eligible: 0`, and
 * `lore_status` printed `kùzu + lancedb (local)`.
 *
 * ── POST KUZU-REMOVAL SHAPE (Phase 3d, 2026-08-21) ──────────────────────────
 *
 * LocalGraph and getOrOpen are gone. The invariant this file was really about
 * — the daemon must NEVER silently read/write a store other than the one the
 * workspace declares — now has a sharper expression on the other flank: a
 * workspace that still EXPLICITLY declares `graphEngine: 'kuzu'` must FAIL
 * LOUDLY (`KuzuEngineRemovedError`) from every engine-resolving entry point,
 * not silently fall back to SurrealDB. A silent fallback would recreate this
 * exact bug class mirror-image: an empty Surreal store read "successfully"
 * while the workspace's real Kùzu data sits in `.lore/graph` (the
 * pm-scope-app incident's shape).
 *
 * Assertions:
 *
 *   1. the registry accessor (`getGraphHandle`) refuses an explicit 'kuzu'
 *      declaration with `KuzuEngineRemovedError`, naming the workspace;
 *   2. the CLI/boot factory (`openWorkspaceGraph`) refuses the same way;
 *   3. the shared route/tool resolver (`resolveTargetGraph`) sees the
 *      Surreal-declared workspace's own node;
 *   4. a Surreal boot graph still produces a registry, and priming hands
 *      back the very instance boot already opened;
 *   5. `prime()` refuses an unrecognised (non-SurrealGraph) implementation
 *      loudly rather than no-op'ing and letting the registry open a rival
 *      handle on the same directory.
 *
 * Run: npx tsx test/daemon-engine-routing-unit.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LocalGraphRegistry } from '../packages/lore/src/engines/localGraphRegistry.js';
import { openWorkspaceGraph } from '../packages/lore/src/engines/openWorkspaceGraph.js';
import { KuzuEngineRemovedError } from '../packages/lore/src/engines/graphEngineSelector.js';
import { buildGraphRegistryForLocalMode } from '../packages/lore/src/mcp/bootSteps.js';
import { resolveTargetGraph } from '../packages/lore/src/mcp/tools/workspaceResolve.js';
import type { StorageBundle } from '../packages/lore/src/mcp/storageBundle.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error('       ' + ((err as Error).message ?? String(err)));
    }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-daemonroute-'));
const SURREAL_WS = 'sws';
const KUZU_WS = 'kws';
const surrealPath = path.join(home, 'workspaces', SURREAL_WS);
const kuzuPath = path.join(home, 'workspaces', KUZU_WS);
fs.mkdirSync(path.join(surrealPath, '.lore'), { recursive: true });
fs.mkdirSync(path.join(kuzuPath, '.lore'), { recursive: true });
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    version: 1,
    active: SURREAL_WS,
    workspaces: [
        { name: SURREAL_WS, path: surrealPath, graphEngine: 'surreal' },
        { name: KUZU_WS, path: kuzuPath, graphEngine: 'kuzu' },
    ],
}, null, 2));

const NODE = {
    id: 'only-in-surreal',
    type: 'decision',
    label: 'written through the engine the workspace declares',
    content: 'if the daemon reads another store, this node is invisible',
    tags: ['routing'],
    project: 'p',
    ecosystem: 'e',
    metadata: '{}',
};

console.log('daemon-engine-routing — the daemon honours graphEngine (or fails loudly)');

const registry = new LocalGraphRegistry({ autoEvict: false, home });

await test('getGraphHandle REFUSES an explicit kuzu declaration — loud, not silent', async () => {
    // The precondition everything else rests on, post-removal: the one
    // remaining accessor must not hand out a substitute store for a
    // workspace whose declared engine no longer exists.
    await assert.rejects(
        () => registry.getGraphHandle(KUZU_WS),
        (err: unknown) => {
            assert.ok(err instanceof KuzuEngineRemovedError,
                `expected KuzuEngineRemovedError, got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`);
            assert.equal(err.workspace, KUZU_WS, 'the error names the workspace');
            assert.match(err.message, /kuzu/i);
            assert.match(err.message, new RegExp(KUZU_WS));
            assert.match(err.message, /workspaces\.json/);
            return true;
        },
    );
});

await test('openWorkspaceGraph REFUSES the same explicit kuzu declaration', async () => {
    // The CLI/boot half of the same refusal — no silent SurrealGraph.
    assert.throws(
        () => openWorkspaceGraph(kuzuPath, { workspaceId: KUZU_WS, home }),
        (err: unknown) => {
            assert.ok(err instanceof KuzuEngineRemovedError,
                `expected KuzuEngineRemovedError, got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`);
            assert.equal(err.workspace, KUZU_WS);
            return true;
        },
    );
});

await test('a write through the handle reads back through the declared engine', async () => {
    const handle = await registry.getGraphHandle(SURREAL_WS);
    await handle.upsertNode(NODE as Parameters<typeof handle.upsertNode>[0]);
    const readBack = await handle.getNode(NODE.id);
    assert.ok(readBack, 'the declared engine must read back what was written through it');
    assert.equal(readBack!.label, NODE.label);
});

await test('resolveTargetGraph — the shared route/tool resolver — sees the Surreal node', async () => {
    // `resolveTargetGraph` backs export_snapshot, corpus_health and the
    // retention routes; `readGate.resolveReadGraph` and `bulkWrite.resolveGraph`
    // are the same swap. Pre-fix this returned the Kùzu handle and every one
    // of them answered from the empty database.
    //
    // Only `store.loreGraph` is read from the bundle on the registry path, so a
    // stub stands in for the full boot bundle rather than booting a daemon.
    const stubStore = { loreGraph: null } as unknown as StorageBundle;
    const resolved = await resolveTargetGraph(stubStore, registry, SURREAL_WS, SURREAL_WS);
    assert.ok(resolved.ok, 'resolution succeeded');
    assert.equal(resolved.graph.constructor.name, 'SurrealGraph');
    const node = await resolved.graph.getNode(NODE.id);
    assert.ok(node, 'the resolver reached the store the workspace actually declares');
    assert.equal(node!.id, NODE.id);
});

/**
 * Everything below reopens the SAME surrealkv directory, so the handles above
 * must be closed and the driver's asynchronously-released directory lock given
 * time to clear (DEC-SURREAL-BACKEND) before the next open — otherwise the
 * next initialize() burns its whole retry budget on a lock that is already
 * logically free.
 */
async function releaseStoreLock(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 750);
    await promise;
}

await registry.disposeAll();
await releaseStoreLock();

await test('a Surreal boot graph still produces a registry', async () => {
    // `buildGraphRegistryForLocalMode` gated on `graph instanceof LocalGraph`
    // and returned undefined otherwise. Once createGraph honours the declared
    // engine that gate would have switched the ENTIRE per-workspace routing
    // layer off for a Surreal-backed daemon — every route silently falling back
    // to the boot handle, which is the workspace-isolation boundary itself.
    const bootGraph = openWorkspaceGraph(surrealPath, { workspaceId: SURREAL_WS, home });
    await bootGraph.initialize();
    try {
        assert.equal(bootGraph.constructor.name, 'SurrealGraph');
        const reg = buildGraphRegistryForLocalMode('local', bootGraph, SURREAL_WS, home, { autoEvict: false });
        assert.ok(reg, 'a registry is built for a Surreal-backed boot workspace');

        // And priming must hand BACK the very instance boot already opened —
        // not open a second one. surrealkv releases its directory lock
        // asynchronously (DEC-SURREAL-BACKEND), so a concurrent second open
        // does not merely waste a handle, it fails.
        const viaRegistry = await reg!.getGraphHandle(SURREAL_WS);
        assert.equal(viaRegistry, bootGraph,
            'the registry returned the primed boot handle rather than opening a rival one');
        await reg!.disposeAll();
    } finally {
        await bootGraph.close();
    }
});

await releaseStoreLock();

await test('prime() refuses an unrecognised graph implementation loudly', async () => {
    // The old no-op prime left the registry to open its OWN handle on the same
    // directory — a lock fight on surrealkv. With SurrealGraph the only engine,
    // anything else must be refused at the seam.
    const reg = new LocalGraphRegistry({ autoEvict: false, home });
    const boot = openWorkspaceGraph(surrealPath, { workspaceId: SURREAL_WS, home });
    await boot.initialize();
    try {
        reg.prime(SURREAL_WS, boot);
        assert.equal(await reg.getGraphHandle(SURREAL_WS), boot,
            'the primed boot handle is the registry\'s handle — no rival open on the same directory');
        assert.throws(
            () => reg.prime(SURREAL_WS, { constructor: { name: 'GhostGraph' } } as never),
            /GhostGraph.*SurrealGraph/s,
            'prime() must name the rejected implementation and the only accepted one',
        );
        await reg.disposeAll();
    } finally {
        await boot.close();
    }
});


fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
