#!/usr/bin/env tsx
/**
 * test/verbatim-gate-arg-slot-unit.ts — fix/search-worker-call-cancellation
 * (3.20.2 follow-up, independent-review finding 3): regression guard for the
 * `GATE_ARG_SLOT` bug class documented in
 * packages/lore/src/engines/verbatimWorkerProtocol.ts.
 *
 * THE RISK THIS PINS: `resolveSeedStore()` (packages/lore/src/recall/
 * retrieveSeedStore.ts) calls the REAL `VerbatimStore.search`/`bm25Search`
 * POSITIONALLY — `gate` is not a named option, it is "whatever argument
 * happens to land in the trailing slot". Two independent paths must keep it
 * aligned with the real method's fixed arity:
 *   - the boot/active-workspace path, which goes THROUGH
 *     `LoreStorageClient.verbatimSearch`/`verbatimBm25Search` — the latter
 *     uses a structural `Bm25Fn` type-cast (see loreStorageClient.ts) that
 *     TypeScript cannot check against the real `VerbatimStore` class, so an
 *     intervening parameter added to one side and not the other would NOT be
 *     a compile error, only a silent runtime misalignment;
 *   - the non-active-workspace path, which calls a per-workspace
 *     `VerbatimStore` (from `workspaceVerbatimResolver.getOrOpen`) directly.
 *
 * Before this file, `grep -rn "GATE_ARG_SLOT" test/` returned nothing — no
 * test failed if a future edit shifted an optional parameter and pushed
 * `gate` into the wrong slot (e.g. landing on `actorScopes` or `opts`
 * instead, which the real methods would silently accept without complaint,
 * since both are typed as optional/`unknown`-ish).
 *
 * Design: drives `resolveSeedStore()` — the real production function, not a
 * reimplementation of its logic — against REAL `VerbatimStore` instances
 * (never a mock of `search`/`bm25Search`), for BOTH resolution branches
 * (`isBootGraph=true` via `LoreStorageClient.fromLocal`, and
 * `isBootGraph=false` via a `workspaceVerbatimResolver`), and spies on the
 * real instance method (capturing the raw `arguments` it receives) to assert
 * the `gate` object lands at exactly `GATE_ARG_SLOT.search` /
 * `GATE_ARG_SLOT.bm25Search` — imported from verbatimWorkerProtocol.ts, never
 * hardcoded here, so this test tracks the real constant if it ever changes.
 *
 * Run: npx tsx test/verbatim-gate-arg-slot-unit.ts
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import { LocalEmbeddingProvider } from '../packages/lore/src/providers/localEmbeddingProvider.js';
import { LoreStorageClient } from '../packages/lore/src/storage/loreStorageClient.js';
import { GATE_ARG_SLOT } from '../packages/lore/src/engines/verbatimWorkerProtocol.js';
import { resolveSeedStore, type RetrieveSeedStoreDeps } from '../packages/lore/src/recall/retrieveSeedStore.js';
import type { StorageBundle } from '../packages/lore/src/mcp/services.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; },
            (err: Error) => { console.error(`  \x1b[31m✗ ${name}\x1b[0m\n    ${err.stack ?? err.message}`); failed++; },
        );
}

/** Wraps a REAL instance method with a spy that records the exact positional
 *  `arguments` it was called with, then forwards to the original
 *  implementation (so the real search/bm25Search still runs — this is not a
 *  mock, it observes the real call). Returns the captured call list and a
 *  restore function. */
function spyOnMethod<M extends (...args: never[]) => unknown>(
    obj: Record<string, unknown>,
    method: string,
): { calls: unknown[][]; restore: () => void } {
    const original = (obj[method] as M).bind(obj);
    const calls: unknown[][] = [];
    obj[method] = (...args: unknown[]) => {
        calls.push(args);
        return (original as (...a: unknown[]) => unknown)(...args);
    };
    return {
        calls,
        restore: () => { obj[method] = original; },
    };
}

async function withRealStore<T>(fn: (store: VerbatimStore) => Promise<T>): Promise<T> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-gate-arg-slot-'));
    const store = new VerbatimStore(tmp, new LocalEmbeddingProvider());
    try {
        await store.initialize();
        await store.store({
            id: 'gate-arg-slot-doc-1',
            text: 'alpha bravo charlie gate arg slot fixture document',
            metadata: {
                type: 'note', label: 'fixture', tags: 'seed',
                project: '*', ecosystem: '*',
                updatedAt: new Date().toISOString(), security_scopes: [],
            },
        });
        return await fn(store);
    } finally {
        await store.close().catch(() => undefined);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

async function run() {
    console.log('\n=== fix/search-worker-call-cancellation (3.20.2 follow-up): GATE_ARG_SLOT regression guard ===\n');

    // Sanity on the constants themselves — if these ever drift from the real
    // VerbatimStore signatures (query, limit, filter, opts, actorScopes, gate)
    // / (query, limit, filter, actorScopes, gate), the assertions below (which
    // key off these SAME constants) would silently stop testing anything
    // meaningful, so pin their expected values explicitly too.
    assert.equal(GATE_ARG_SLOT.search, 5, 'GATE_ARG_SLOT.search must be VerbatimStore.search\'s 6th (0-indexed 5th) positional slot');
    assert.equal(GATE_ARG_SLOT.bm25Search, 4, 'GATE_ARG_SLOT.bm25Search must be VerbatimStore.bm25Search\'s 5th (0-indexed 4th) positional slot');

    await test('search(): boot/active-workspace branch — resolveSeedStore -> LoreStorageClient.verbatimSearch -> REAL VerbatimStore.search() receives `gate` at GATE_ARG_SLOT.search', async () => {
        await withRealStore(async (store) => {
            const storageClient = LoreStorageClient.fromLocal({
                graph: {} as unknown as Parameters<typeof LoreStorageClient.fromLocal>[0]['graph'],
                verbatim: store as unknown as Parameters<typeof LoreStorageClient.fromLocal>[0]['verbatim'],
            });
            const bundle = { storageClient } as unknown as StorageBundle;
            const deps: RetrieveSeedStoreDeps = { store: bundle };

            const spy = spyOnMethod<VerbatimStore['search']>(store as unknown as Record<string, unknown>, 'search');
            try {
                const controller = new AbortController();
                const seedStore = await resolveSeedStore(deps, 'default', /* isBootGraph */ true, '*', controller.signal);
                assert.ok(seedStore, 'resolveSeedStore must resolve a seed store for the boot/active branch');
                await seedStore!.search('alpha bravo charlie', 5);

                assert.equal(spy.calls.length, 1, 'the real VerbatimStore.search() must have been called exactly once');
                const args = spy.calls[0];
                const gateArg = args[GATE_ARG_SLOT.search!] as { signal?: AbortSignal } | undefined;
                assert.ok(gateArg, `gate must be present at GATE_ARG_SLOT.search (index ${GATE_ARG_SLOT.search}) — got args of length ${args.length}: ${JSON.stringify(args.map((a) => typeof a))}`);
                assert.equal(gateArg!.signal, controller.signal, 'the gate object at that slot must carry the SAME AbortSignal resolveSeedStore was given — not merely truthy, but the right one, ruling out an accidental match against a nearby slot');
            } finally {
                spy.restore();
            }
        });
    });

    await test('bm25Search(): boot/active-workspace branch — resolveSeedStore -> LoreStorageClient.verbatimBm25Search (Bm25Fn structural cast) -> REAL VerbatimStore.bm25Search() receives `gate` at GATE_ARG_SLOT.bm25Search', async () => {
        await withRealStore(async (store) => {
            const storageClient = LoreStorageClient.fromLocal({
                graph: {} as unknown as Parameters<typeof LoreStorageClient.fromLocal>[0]['graph'],
                verbatim: store as unknown as Parameters<typeof LoreStorageClient.fromLocal>[0]['verbatim'],
            });
            const bundle = { storageClient } as unknown as StorageBundle;
            const deps: RetrieveSeedStoreDeps = { store: bundle };

            // Spying on `store.bm25Search` here specifically exercises the
            // `Bm25Fn` structural-cast call site (`fn.call(store, ...)` in
            // loreStorageClient.ts) — the exact landmine GATE_ARG_SLOT's own
            // doc warns about, since that cast is invisible to TypeScript
            // against the real VerbatimStore class.
            const spy = spyOnMethod<VerbatimStore['bm25Search']>(store as unknown as Record<string, unknown>, 'bm25Search');
            try {
                const controller = new AbortController();
                const seedStore = await resolveSeedStore(deps, 'default', /* isBootGraph */ true, '*', controller.signal);
                assert.ok(seedStore, 'resolveSeedStore must resolve a seed store for the boot/active branch');
                await seedStore!.bm25Search('alpha bravo charlie', 5);

                assert.equal(spy.calls.length, 1, 'the real VerbatimStore.bm25Search() must have been called exactly once');
                const args = spy.calls[0];
                const gateArg = args[GATE_ARG_SLOT.bm25Search!] as { signal?: AbortSignal } | undefined;
                assert.ok(gateArg, `gate must be present at GATE_ARG_SLOT.bm25Search (index ${GATE_ARG_SLOT.bm25Search}) — got args of length ${args.length}: ${JSON.stringify(args.map((a) => typeof a))}`);
                assert.equal(gateArg!.signal, controller.signal, 'the gate object at that slot must carry the SAME AbortSignal resolveSeedStore was given');
            } finally {
                spy.restore();
            }
        });
    });

    await test('search(): non-active-workspace branch — resolveSeedStore -> workspaceVerbatimResolver -> REAL per-workspace VerbatimStore.search() receives `gate` at GATE_ARG_SLOT.search', async () => {
        await withRealStore(async (wsStore) => {
            // The boot store is a SEPARATE real instance the non-active
            // branch must never touch — confirms resolveSeedStore actually
            // took the resolver path, not a boot-store fallback that would
            // make this test vacuous.
            await withRealStore(async (bootStore) => {
                const bootStorageClient = LoreStorageClient.fromLocal({
                    graph: {} as unknown as Parameters<typeof LoreStorageClient.fromLocal>[0]['graph'],
                    verbatim: bootStore as unknown as Parameters<typeof LoreStorageClient.fromLocal>[0]['verbatim'],
                });
                const bundle = { storageClient: bootStorageClient } as unknown as StorageBundle;
                const deps: RetrieveSeedStoreDeps = {
                    store: bundle,
                    workspaceVerbatimResolver: { getOrOpen: async () => wsStore as unknown as Awaited<ReturnType<NonNullable<RetrieveSeedStoreDeps['workspaceVerbatimResolver']>['getOrOpen']>> },
                };

                const bootSpy = spyOnMethod<VerbatimStore['search']>(bootStore as unknown as Record<string, unknown>, 'search');
                const wsSpy = spyOnMethod<VerbatimStore['search']>(wsStore as unknown as Record<string, unknown>, 'search');
                try {
                    const controller = new AbortController();
                    const seedStore = await resolveSeedStore(deps, 'workspace-b', /* isBootGraph */ false, '*', controller.signal);
                    assert.ok(seedStore, 'resolveSeedStore must resolve a seed store for the non-active branch via the resolver');
                    await seedStore!.search('alpha bravo charlie', 5);

                    assert.equal(bootSpy.calls.length, 0, 'the BOOT store must never be touched on the non-active-workspace branch');
                    assert.equal(wsSpy.calls.length, 1, 'the per-workspace store\'s real search() must have been called exactly once');
                    const args = wsSpy.calls[0];
                    const gateArg = args[GATE_ARG_SLOT.search!] as { signal?: AbortSignal } | undefined;
                    assert.ok(gateArg, `gate must be present at GATE_ARG_SLOT.search (index ${GATE_ARG_SLOT.search}) — got args of length ${args.length}: ${JSON.stringify(args.map((a) => typeof a))}`);
                    assert.equal(gateArg!.signal, controller.signal, 'the gate object at that slot must carry the SAME AbortSignal resolveSeedStore was given');
                } finally {
                    bootSpy.restore();
                    wsSpy.restore();
                }
            });
        });
    });

    await test('bm25Search(): non-active-workspace branch — resolveSeedStore -> workspaceVerbatimResolver -> REAL per-workspace VerbatimStore.bm25Search() receives `gate` at GATE_ARG_SLOT.bm25Search', async () => {
        await withRealStore(async (wsStore) => {
            await withRealStore(async (bootStore) => {
                const bootStorageClient = LoreStorageClient.fromLocal({
                    graph: {} as unknown as Parameters<typeof LoreStorageClient.fromLocal>[0]['graph'],
                    verbatim: bootStore as unknown as Parameters<typeof LoreStorageClient.fromLocal>[0]['verbatim'],
                });
                const bundle = { storageClient: bootStorageClient } as unknown as StorageBundle;
                const deps: RetrieveSeedStoreDeps = {
                    store: bundle,
                    workspaceVerbatimResolver: { getOrOpen: async () => wsStore as unknown as Awaited<ReturnType<NonNullable<RetrieveSeedStoreDeps['workspaceVerbatimResolver']>['getOrOpen']>> },
                };

                const bootSpy = spyOnMethod<VerbatimStore['bm25Search']>(bootStore as unknown as Record<string, unknown>, 'bm25Search');
                const wsSpy = spyOnMethod<VerbatimStore['bm25Search']>(wsStore as unknown as Record<string, unknown>, 'bm25Search');
                try {
                    const controller = new AbortController();
                    const seedStore = await resolveSeedStore(deps, 'workspace-b', /* isBootGraph */ false, '*', controller.signal);
                    assert.ok(seedStore, 'resolveSeedStore must resolve a seed store for the non-active branch via the resolver');
                    await seedStore!.bm25Search('alpha bravo charlie', 5);

                    assert.equal(bootSpy.calls.length, 0, 'the BOOT store must never be touched on the non-active-workspace branch');
                    assert.equal(wsSpy.calls.length, 1, 'the per-workspace store\'s real bm25Search() must have been called exactly once');
                    const args = wsSpy.calls[0];
                    const gateArg = args[GATE_ARG_SLOT.bm25Search!] as { signal?: AbortSignal } | undefined;
                    assert.ok(gateArg, `gate must be present at GATE_ARG_SLOT.bm25Search (index ${GATE_ARG_SLOT.bm25Search}) — got args of length ${args.length}: ${JSON.stringify(args.map((a) => typeof a))}`);
                    assert.equal(gateArg!.signal, controller.signal, 'the gate object at that slot must carry the SAME AbortSignal resolveSeedStore was given');
                } finally {
                    bootSpy.restore();
                    wsSpy.restore();
                }
            });
        });
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
