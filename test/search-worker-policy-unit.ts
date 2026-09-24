#!/usr/bin/env tsx
/**
 * search-worker-policy-unit.ts — LORE-ASK-SEARCH-WORKER-POLICY.
 *
 * A host embedding Lore wants PER-STORE control over search-worker isolation
 * instead of the process-global `LORE_SEARCH_WORKER` on/off switch: a tiny
 * knowledge store should stay in-process (a forked child costs ~90MB of
 * duplicated runtime for one table handle), while a large store gets the
 * crash-isolation of a worker process.
 *
 * Contract under test (see docs/CONFIGURATION.md `LORE_SEARCH_WORKER` +
 * per-store override, and the header comments in
 * engines/verbatimSearchWorkerProxy.ts / outbox/workspaceVerbatimResolver.ts /
 * mcp/services.ts):
 *
 *   1. A policy function is called once per store path, at first open, with
 *      the resolved base path.
 *   2. Its answer is authoritative for that store: `true` forks, `false`
 *      stays in-process — regardless of what LORE_SEARCH_WORKER says.
 *   3. The recursion guard still wins: inside a worker
 *      (LORE_IS_SEARCH_WORKER=1) the answer is always false, policy or not.
 *   4. No policy ⇒ today's env-only behaviour, unchanged (regression check).
 *   5. Both directions produce correct search results (write + search a doc
 *      through each).
 *
 * Sections:
 *   A — WorkspaceVerbatimResolver: policy true/false override the env gate.
 *   B — WorkspaceVerbatimResolver: write + search works through both a
 *       policy-forked worker store and a policy-kept in-process store.
 *   C — WorkspaceVerbatimResolver: no policy ⇒ same behaviour as calling
 *       `searchWorkerIsolationEnabled()` directly (today's call pattern).
 *   D — services.ts createVectorStore (the boot store): policy true/false
 *       toggle which concrete class gets constructed, overriding the env gate.
 *   E — a policy that THROWS never makes a store unopenable: the shared
 *       resolveSearchWorkerIsolation() helper warns once per base path and
 *       falls back to the env gate (today's behaviour, not a new default) —
 *       checked on the helper directly and through the resolver's getOrOpen().
 *   F — the same through createLore(): a throwing policy at boot does not fail
 *       createLore(); the env gate decides the boot store (env on AND off).
 *
 * A real parentEmbedder (deterministic, 8-dimensional — modeled on
 * test/verbatim-worker-parent-embeds-metadata-unit.ts) is passed everywhere a
 * store is constructed so a forked child skips ONNX model load entirely
 * (PARENT_EMBEDS): this keeps the whole suite fast and deterministic while
 * still exercising the REAL child_process.fork() path (not a stub).
 *
 * Run: npx tsx test/search-worker-policy-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { WorkspaceVerbatimResolver } from '../packages/lore/src/outbox/workspaceVerbatimResolver.js';
import { VerbatimStore } from '../packages/lore/src/engines/verbatimStore.js';
import type { VerbatimStoreApi } from '../packages/lore/src/engines/verbatimStoreApi.js';
import { VerbatimSearchWorkerProxy } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { searchWorkerIsolationEnabled, resolveSearchWorkerIsolation } from '../packages/lore/src/engines/verbatimSearchWorkerProxy.js';
import { log } from '../packages/lore/src/logger.js';
import { createLore } from '../packages/lore/src/index.js';
import type { SearchWorkerPolicy } from '../packages/lore/src/index.js';
import { WORKER_ENV } from '../packages/lore/src/engines/verbatimWorkerProtocol.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';
import { createVectorStore } from '../packages/lore/src/mcp/services.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

// Give any forked child a generous ready budget on slower CI machines. Not
// model-load bound here (parentEmbedder short-circuits that), but IPC/spawn
// jitter under load still benefits from headroom.
process.env.LORE_SEARCH_WORKER_READY_MS ??= '30000';

const DIM = 8;

/** Deterministic stand-in for the real provider — same text -> same vector,
 *  no model to load. Copied from the pattern in
 *  verbatim-worker-parent-embeds-metadata-unit.ts. */
class FakeEmbedProvider implements EmbeddingProvider {
    readonly modelId = 'fake-policy-test-embedder';
    readonly dimension = DIM;
    async initialize(): Promise<void> {}
    private vec(text: string): number[] {
        const out = new Array<number>(DIM).fill(0);
        for (let i = 0; i < text.length; i++) out[i % DIM] += text.charCodeAt(i) / 255;
        const norm = Math.hypot(...out) || 1;
        return out.map((x) => x / norm);
    }
    async embed(text: string): Promise<number[]> { return this.vec(text); }
    async embedQuery(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocument(text: string): Promise<number[]> { return this.vec(text); }
    async embedDocumentBatch(texts: string[]): Promise<number[][]> { return texts.map((t) => this.vec(t)); }
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

// Isolated Lore home for this test only — createWorkspace() registers real,
// non-boot workspace entries with real on-disk `.lore/` dirs under it.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'search-worker-policy-'));
process.env.LORE_HOME = HOME;
// 3.21 step 2 part 2 — this whole file is exercising VerbatimStore vs
// VerbatimSearchWorkerProxy branching, a LanceDB-only concern
// (resolveSearchWorkerIsolation short-circuits to false for a
// 'sqlite'-vector workspace regardless of policy/env — see that
// function's own doc comment). createWorkspace() now defaults NEW
// workspaces to vectorEngine:'sqlite', so every fixture workspace this
// file creates needs to opt back into 'lance' to keep testing what it says
// it tests.
process.env.LORE_DEFAULT_VECTOR_ENGINE = 'lance';

async function writeAndSearch(store: VerbatimStoreApi, tag: string): Promise<void> {
    await store.store({
        id: `lore:${tag}-doc1`,
        text: `a distinctive marker-${tag} document about search worker policy`,
        metadata: {},
    } as never);
    const hits = await store.search(`marker-${tag} search worker policy`, 5);
    assert.ok(hits.length > 0, `expected at least one hit for tag ${tag} (got ${hits.length})`);
    assert.ok(hits.some((h) => h.id === `lore:${tag}-doc1`), `expected the seeded doc to be a hit for tag ${tag}`);
}

async function main() {
    const resolversToClose: WorkspaceVerbatimResolver[] = [];
    const bootStoresToClose: Array<{ close?: () => Promise<void> | void }> = [];

    try {
        console.log('\n=== Section A: WorkspaceVerbatimResolver — policy overrides the env gate ===\n');

        await test('policy=true wins over LORE_SEARCH_WORKER off: store forks', async () => {
            delete process.env.LORE_SEARCH_WORKER;
            const ws = createWorkspace('policy-forces-worker-on');
            const resolver = new WorkspaceVerbatimResolver(new FakeEmbedProvider(), () => true, {});
            resolversToClose.push(resolver);
            const store = await resolver.getOrOpen(ws.name);
            assert.ok(store instanceof VerbatimSearchWorkerProxy, 'policy=true must produce a VerbatimSearchWorkerProxy even with the env gate off');
        });

        await test('policy=false wins over LORE_SEARCH_WORKER=1: store stays in-process', async () => {
            process.env.LORE_SEARCH_WORKER = '1';
            try {
                const ws = createWorkspace('policy-forces-worker-off');
                const resolver = new WorkspaceVerbatimResolver(new FakeEmbedProvider(), () => false, {});
                resolversToClose.push(resolver);
                const store = await resolver.getOrOpen(ws.name);
                assert.ok(!(store instanceof VerbatimSearchWorkerProxy), 'policy=false must keep the store in-process even with the env gate on');
                assert.equal(store.constructor, VerbatimStore, `expected the plain base class exactly (got "${store.constructor.name}")`);
                // "this.db" is non-null right after initialize() for a real
                // VerbatimStore (a VerbatimSearchWorkerProxy never opens
                // LanceDB in-process, so its "db" stays null — see the class
                // header comment). "table" is null until the first store()
                // call creates it (verbatimStore.ts initialize()), so that
                // half of the distinction is covered by writeAndSearch below
                // instead of asserted here.
                assert.notEqual((store as unknown as { db: unknown }).db, null, 'a real in-process store must have opened its db handle');
            } finally {
                delete process.env.LORE_SEARCH_WORKER;
            }
        });

        await test('policy is consulted with the resolved store path', async () => {
            const ws = createWorkspace('policy-receives-resolved-path');
            const seenPaths: string[] = [];
            const resolver = new WorkspaceVerbatimResolver(new FakeEmbedProvider(), (basePath) => {
                seenPaths.push(basePath);
                return false;
            }, {});
            resolversToClose.push(resolver);
            await resolver.getOrOpen(ws.name);
            assert.equal(seenPaths.length, 1, 'policy must be called exactly once per store path (at first open)');
            assert.ok(seenPaths[0].length > 0 && path.isAbsolute(seenPaths[0]), `expected an absolute resolved path, got ${seenPaths[0]}`);

            // A second getOrOpen for the SAME workspace must reuse the cached
            // store, not re-consult the policy (policy is a first-open decision).
            await resolver.getOrOpen(ws.name);
            assert.equal(seenPaths.length, 1, 'policy must not be re-consulted for an already-open store');
        });

        console.log('\n=== Section B: write + search works through both directions ===\n');

        await test('policy=true store (worker-forked): write then search returns the doc', async () => {
            const ws = createWorkspace('policy-worker-write-search');
            const resolver = new WorkspaceVerbatimResolver(new FakeEmbedProvider(), () => true, {});
            resolversToClose.push(resolver);
            const store = await resolver.getOrOpen(ws.name);
            assert.ok(store instanceof VerbatimSearchWorkerProxy, 'sanity: this store must be the worker proxy');
            await writeAndSearch(store, 'workerpath');
        });

        await test('policy=false store (in-process): write then search returns the doc', async () => {
            const ws = createWorkspace('policy-inprocess-write-search');
            const resolver = new WorkspaceVerbatimResolver(new FakeEmbedProvider(), () => false, {});
            resolversToClose.push(resolver);
            const store = await resolver.getOrOpen(ws.name);
            assert.ok(!(store instanceof VerbatimSearchWorkerProxy), 'sanity: this store must NOT be the worker proxy');
            await writeAndSearch(store, 'inprocpath');
        });

        console.log('\n=== Section C: no policy — regression check against 3.19.1 behaviour ===\n');

        await test('no policy + LORE_SEARCH_WORKER=1: behaves exactly like passing searchWorkerIsolationEnabled() directly (worker)', async () => {
            process.env.LORE_SEARCH_WORKER = '1';
            try {
                const wsControl = createWorkspace('no-policy-control-worker-on');
                const wsUnderTest = createWorkspace('no-policy-under-test-worker-on');
                const control = new WorkspaceVerbatimResolver(new FakeEmbedProvider(), searchWorkerIsolationEnabled(), {});
                const underTest = new WorkspaceVerbatimResolver(new FakeEmbedProvider(), undefined, {});
                resolversToClose.push(control, underTest);

                const controlStore = await control.getOrOpen(wsControl.name);
                // "undefined" here documents the resolver's own contract: no
                // policy means "nothing decided by the resolver" — server.ts
                // is the one that applies `opts.searchWorkerPolicy ??
                // searchWorkerIsolationEnabled()` before construction. A bare
                // `undefined` constructor arg alone is falsy, so it resolves
                // to in-process — this pins that fallback-of-last-resort down
                // explicitly rather than leaving it implicit.
                const underTestStore = await underTest.getOrOpen(wsUnderTest.name);

                assert.ok(controlStore instanceof VerbatimSearchWorkerProxy, 'control (today\'s call pattern) must fork with the env gate on');
                assert.ok(!(underTestStore instanceof VerbatimSearchWorkerProxy), 'a bare `undefined` ctor arg is falsy and stays in-process even with the env gate on — callers MUST pass the resolved value, matching server.ts');
            } finally {
                delete process.env.LORE_SEARCH_WORKER;
            }
        });

        await test('no policy + LORE_SEARCH_WORKER unset: matches searchWorkerIsolationEnabled() (in-process)', async () => {
            delete process.env.LORE_SEARCH_WORKER;
            const wsControl = createWorkspace('no-policy-control-worker-off');
            const control = new WorkspaceVerbatimResolver(new FakeEmbedProvider(), searchWorkerIsolationEnabled(), {});
            resolversToClose.push(control);
            const store = await control.getOrOpen(wsControl.name);
            assert.ok(!(store instanceof VerbatimSearchWorkerProxy), 'env gate off (today\'s call pattern) must stay in-process');
        });

        await test('recursion guard still wins: inside a worker, the policy is never even asked', async () => {
            process.env[WORKER_ENV.IS_WORKER] = '1';
            try {
                const ws = createWorkspace('policy-inside-worker-guard');
                let policyCalls = 0;
                const resolver = new WorkspaceVerbatimResolver(new FakeEmbedProvider(), () => { policyCalls++; return true; }, {});
                resolversToClose.push(resolver);
                const store = await resolver.getOrOpen(ws.name);
                assert.ok(!(store instanceof VerbatimSearchWorkerProxy), 'inside a worker the recursion guard must force in-process regardless of the policy');
                assert.equal(policyCalls, 0, 'the recursion guard must short-circuit BEFORE the policy function is invoked');
            } finally {
                delete process.env[WORKER_ENV.IS_WORKER];
            }
        });

        console.log('\n=== Section D: services.ts createVectorStore (the boot store) ===\n');

        await test('boot store: policy=true forks even with LORE_SEARCH_WORKER off', async () => {
            delete process.env.LORE_SEARCH_WORKER;
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-store-policy-on-'));
            const store = await createVectorStore({
                deploymentMode: 'local',
                graphBasePath: dir,
                embeddingProvider: new FakeEmbedProvider(),
                searchWorkerPolicy: () => true,
            });
            bootStoresToClose.push(store as unknown as { close?: () => Promise<void> });
            assert.ok(store instanceof VerbatimSearchWorkerProxy, 'boot store must fork when the policy says true, env notwithstanding');
        });

        await test('boot store: policy=false stays in-process even with LORE_SEARCH_WORKER=1', async () => {
            process.env.LORE_SEARCH_WORKER = '1';
            try {
                const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-store-policy-off-'));
                const store = await createVectorStore({
                    deploymentMode: 'local',
                    graphBasePath: dir,
                    embeddingProvider: new FakeEmbedProvider(),
                    searchWorkerPolicy: () => false,
                });
                bootStoresToClose.push(store as unknown as { close?: () => Promise<void> });
                assert.ok(!(store instanceof VerbatimSearchWorkerProxy), 'boot store must stay in-process when the policy says false, env notwithstanding');
                assert.equal(store.constructor, VerbatimStore, `expected the plain base class exactly (got "${store.constructor.name}")`);
            } finally {
                delete process.env.LORE_SEARCH_WORKER;
            }
        });

        await test('boot store: no policy falls back to the env gate (regression)', async () => {
            delete process.env.LORE_SEARCH_WORKER;
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-store-no-policy-'));
            const store = await createVectorStore({
                deploymentMode: 'local',
                graphBasePath: dir,
                embeddingProvider: new FakeEmbedProvider(),
            });
            bootStoresToClose.push(store as unknown as { close?: () => Promise<void> });
            assert.ok(!(store instanceof VerbatimSearchWorkerProxy), 'no policy + env off must stay in-process, matching 3.19.1');
        });

        console.log('\n=== Section E: a throwing policy falls back to the env gate ===\n');

        // Capture log.warn — `log` is a plain exported object, so swapping the
        // method is enough; restored in each test's finally.
        const captureWarnings = (): { warnings: string[]; restore: () => void } => {
            const warnings: string[] = [];
            const original = log.warn;
            log.warn = (message: unknown) => { warnings.push(String(message)); };
            return { warnings, restore: () => { log.warn = original; } };
        };
        const throwingPolicy: SearchWorkerPolicy = () => { throw new Error('host policy exploded'); };

        await test('helper: throwing policy → env gate decides (env on → true, env off → false)', async () => {
            const cap = captureWarnings();
            try {
                process.env.LORE_SEARCH_WORKER = '1';
                assert.equal(resolveSearchWorkerIsolation('/tmp/policy-throws-env-on', throwingPolicy), true, 'env on must win when the policy throws');
                delete process.env.LORE_SEARCH_WORKER;
                assert.equal(resolveSearchWorkerIsolation('/tmp/policy-throws-env-off', throwingPolicy), false, 'env off must win when the policy throws');
                assert.equal(cap.warnings.length, 2, `one warning per distinct base path (got ${cap.warnings.length})`);
                assert.ok(cap.warnings.every((w) => w.includes('host policy exploded') && w.includes('env gate')), 'warning names the failure and the fallback');
            } finally {
                cap.restore();
                delete process.env.LORE_SEARCH_WORKER;
            }
        });

        await test('helper: repeated throws for the SAME base path warn only once', async () => {
            const cap = captureWarnings();
            try {
                for (let i = 0; i < 3; i++) resolveSearchWorkerIsolation('/tmp/policy-throws-repeatedly', throwingPolicy);
                assert.equal(cap.warnings.length, 1, `expected exactly one warning, got ${cap.warnings.length}`);
            } finally {
                cap.restore();
            }
        });

        await test('helper: recursion guard beats a throwing policy (policy never called)', async () => {
            process.env[WORKER_ENV.IS_WORKER] = '1';
            process.env.LORE_SEARCH_WORKER = '1';
            let calls = 0;
            try {
                assert.equal(resolveSearchWorkerIsolation('/tmp/policy-in-worker', () => { calls++; throw new Error('x'); }), false);
                assert.equal(calls, 0, 'policy must not be invoked inside a worker');
            } finally {
                delete process.env[WORKER_ENV.IS_WORKER];
                delete process.env.LORE_SEARCH_WORKER;
            }
        });

        for (const envOn of [true, false]) {
            await test(`resolver: throwing policy → getOrOpen succeeds, env gate decides (LORE_SEARCH_WORKER ${envOn ? 'on' : 'off'}), warning logged once`, async () => {
                const cap = captureWarnings();
                if (envOn) process.env.LORE_SEARCH_WORKER = '1'; else delete process.env.LORE_SEARCH_WORKER;
                try {
                    const ws = createWorkspace(`policy-throws-resolver-${envOn ? 'on' : 'off'}`);
                    const resolver = new WorkspaceVerbatimResolver(new FakeEmbedProvider(), throwingPolicy, {});
                    resolversToClose.push(resolver);
                    const store = await resolver.getOrOpen(ws.name);
                    assert.equal(store instanceof VerbatimSearchWorkerProxy, envOn, `env gate (${envOn ? 'on' : 'off'}) must decide when the policy throws`);
                    await writeAndSearch(store, `throws${envOn ? 'on' : 'off'}`);
                    const again = await resolver.getOrOpen(ws.name);
                    assert.equal(again, store, 'second open reuses the cached store');
                    const policyWarnings = cap.warnings.filter((w) => w.includes('[searchWorkerPolicy]'));
                    assert.equal(policyWarnings.length, 1, `expected exactly one policy warning, got ${policyWarnings.length}`);
                } finally {
                    cap.restore();
                    delete process.env.LORE_SEARCH_WORKER;
                }
            });
        }

        console.log('\n=== Section F: createLore() with a throwing policy at boot ===\n');

        // Embedded createLore() pins its home via dataDir; LORE_HOME (set above
        // for createWorkspace) must not leak into it.
        const savedLoreHome = process.env.LORE_HOME;
        delete process.env.LORE_HOME;
        delete process.env.LORE_GRAPH_PATH;
        try {
            for (const envOn of [true, false]) {
                await test(`createLore: throwing policy does not fail boot; env gate decides the boot store (LORE_SEARCH_WORKER ${envOn ? 'on' : 'off'})`, async () => {
                    const cap = captureWarnings();
                    if (envOn) process.env.LORE_SEARCH_WORKER = '1'; else delete process.env.LORE_SEARCH_WORKER;
                    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `policy-throws-boot-${envOn ? 'on' : 'off'}-`));
                    fs.mkdirSync(path.join(dataDir, '.lore'), { recursive: true });
                    fs.writeFileSync(path.join(dataDir, 'workspaces.json'), JSON.stringify({
                        active: 'default',
                        workspaces: [{ name: 'default', path: dataDir, createdAt: '2026-09-18T00:00:00.000Z' }],
                    }, null, 2));
                    let lore: Awaited<ReturnType<typeof createLore>> | undefined;
                    try {
                        lore = await createLore({ deploymentMode: 'embedded', dataDir, searchWorkerPolicy: throwingPolicy });
                        const boot = lore.store.loreVerbatim;
                        assert.equal(boot instanceof VerbatimSearchWorkerProxy, envOn, `boot store must follow the env gate (${envOn ? 'on' : 'off'}) when the policy throws`);
                        const policyWarnings = cap.warnings.filter((w) => w.includes('[searchWorkerPolicy]'));
                        assert.equal(policyWarnings.length, 1, `expected exactly one policy warning at boot, got ${policyWarnings.length}`);
                    } finally {
                        cap.restore();
                        delete process.env.LORE_SEARCH_WORKER;
                        if (lore) { try { await lore.dispose('search-worker-policy-test'); } catch { /* best-effort */ } }
                        fs.rmSync(dataDir, { recursive: true, force: true });
                    }
                });
            }
        } finally {
            if (savedLoreHome !== undefined) process.env.LORE_HOME = savedLoreHome;
        }
    } finally {
        for (const resolver of resolversToClose) {
            try { await resolver.closeAll(); } catch { /* best-effort */ }
        }
        for (const store of bootStoresToClose) {
            try { if (typeof store.close === 'function') await store.close(); } catch { /* best-effort */ }
        }
        fs.rmSync(HOME, { recursive: true, force: true });
    }

    console.log('');
    if (failed > 0) {
        console.log(`\x1b[31m${failed} test(s) failed, ${passed} passed\x1b[0m`);
        process.exit(1);
    }
    console.log(`\x1b[32mAll ${passed} tests passed\x1b[0m`);
    process.exit(0);
}

main().catch((e) => {
    console.error('TEST HARNESS FAILED:', e);
    process.exit(2);
});
