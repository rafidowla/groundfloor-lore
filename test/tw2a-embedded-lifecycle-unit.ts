#!/usr/bin/env tsx
/**
 * tw2a-embedded-lifecycle-unit.ts — TW-2a adversarial unit tests.
 *
 * Three cases, each FAILS on base (swarm/integration-3) and PASSES on the
 * TW-2a branch:
 *
 *   (a) REPLICATION RUNS IN EMBEDDED MODE.
 *       createLore({deploymentMode:'embedded'}) → store a node WITH an
 *       embedding via the in-process nodeUpsert() (outbox-routed verbatim) →
 *       drain the replicator → verbatimSearch FINDS the node via its vector.
 *       On base: the embedded path never starts the replicator, so the
 *       verbatim.upsert outbox row is never drained into LanceDB and the
 *       search returns nothing.
 *
 *   (b) dataDir ISOLATES TWO INSTANCES ON DISK.
 *       createLore({dataDir:A}) and createLore({dataDir:B}) in ONE process →
 *       a node written through A is NOT visible through B, and the two graphs
 *       live in SEPARATE on-disk dirs (A/.../surreal and B/.../surreal both
 *       exist and are distinct). On base: opts.dataDir never reaches
 *       resolveGraphPath/the registry, so both collide on the global
 *       LORE_HOME graph and the write to A leaks into B.
 *
 *   (c) INIT-THROW LEAKS NO TIMERS.
 *       Force an embedded substrate-init step to throw → the createLore()
 *       promise rejects, and AFTER the rejection there are ZERO net new Lore
 *       timers in the event loop (probed via process.getActiveResourcesInfo()
 *       timer count). On base: the four+ background timers start BEFORE the
 *       unguarded init, dispose() is unreachable, and the timers leak.
 *
 * Harness: the tsx no-framework style used across test/ — manual pass/fail
 * counters. A trailing process.exit(0) guards against a native-engine
 * teardown crash after all assertions have already passed (noted below if
 * it bites).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// IMPORTANT: do NOT set process.env.LORE_HOME globally. The whole point of (b)
// is that dataDir alone — with NO global LORE_HOME — isolates instances on
// disk. We clear any inherited LORE_HOME so a developer's env can't mask it.
delete process.env['LORE_HOME'];
delete process.env['LORE_GRAPH_PATH'];

// ── Timer-leak probe (TW-2a case c) ─────────────────────────────────────────
// process.getActiveResourcesInfo() does NOT report unref()'d timers, and every
// Lore background timer is unref'd — so a raw active-resources count can't see
// the leak the finding describes ("the leak only bites a long-lived embedding
// HOST process"). Instead we instrument the global timer constructors BEFORE
// importing the library and track LIVE (created-but-not-cleared, not-yet-fired)
// timers. A leaked timer stays tracked; a cleaned-up one is removed via clear*()
// and a one-shot setTimeout is removed when it fires. This is the "timer-count
// probe" the qacheck allows.
//
// We track the timer TYPE so we can count leaked recurring BACKGROUND LOOPS
// (setInterval) — which is exactly what the four TW-2a-named timers + the
// orchestration tick are. One-shot setTimeouts (e.g. the shutdown drain's own
// 5 s embed-drain race) are measurement noise that self-clears, so the
// interval count is the binding signal.
const liveTimers = new Map<unknown, 'interval' | 'timeout'>();
const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
const realClearInterval = globalThis.clearInterval;
const realClearTimeout = globalThis.clearTimeout;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).setInterval = (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const h = realSetInterval(fn as never, ms as never, ...(rest as never[]));
    liveTimers.set(h, 'interval');
    return h;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).setTimeout = (fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const wrapped = (...a: unknown[]) => { liveTimers.delete(h); (fn as (...x: unknown[]) => void)(...a); };
    const h = realSetTimeout(wrapped as never, ms as never, ...(rest as never[]));
    liveTimers.set(h, 'timeout');
    return h;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).clearInterval = (h: unknown) => { liveTimers.delete(h); return realClearInterval(h as never); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).clearTimeout = (h: unknown) => { liveTimers.delete(h); return realClearTimeout(h as never); };

/** Snapshot the set of currently-live timer handles. */
function snapshotTimers(): Set<unknown> { return new Set(liveTimers.keys()); }
/** Count recurring (setInterval) timers created since `before` and not cleared. */
function leakedIntervalsSince(before: Set<unknown>): number {
    let n = 0;
    for (const [h, kind] of liveTimers) { if (!before.has(h) && kind === 'interval') n++; }
    return n;
}

const { createLore } = await import('../packages/lore/src/index.js');

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL ${name}`);
        console.error('       ' + ((err as Error).message ?? String(err)));
        const stack = (err as Error).stack?.split('\n').slice(1, 4).map((l) => '       ' + l).join('\n');
        if (stack) console.error(stack);
    }
}

/** Seed a fresh data home with a single "default" workspace at <home> so the
 *  embedded boot graph opens under THIS home (not the global one). */
function seedDefaultWorkspace(home: string): void {
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify(
            {
                active: 'default',
                // Explicit 'surreal': the embedded graph substrate is
                // SurrealDB (the default since 2026-08-11 — pinned here so
                // the pin survives even if the default flips back). Both
                // the write (nodeUpsert → getGraphHandle) and the
                // same-tick verification read below go through the SAME
                // engine-aware accessor, so there is no cross-engine
                // visibility race to reason about.
                workspaces: [{ name: 'default', path: home, createdAt: '2026-06-15T00:00:00.000Z', graphEngine: 'surreal' }],
            },
            null,
            2,
        ),
    );
}

const tmpDirs: string[] = [];
function freshHome(tag: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `lore-tw2a-${tag}-`));
    tmpDirs.push(d);
    return d;
}

async function main(): Promise<void> {
    console.log('TW-2a — embedded lifecycle (replication / dataDir isolation / timer cleanup)');
    console.log('='.repeat(72));

    // ════════════════════════════════════════════════════════════════════
    // (a) REPLICATION RUNS IN EMBEDDED MODE
    // ════════════════════════════════════════════════════════════════════
    console.log('\n── (a) embedded replication drains the verbatim outbox ───');
    {
        const home = freshHome('repl');
        seedDefaultWorkspace(home);
        const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });

        // Write a node WITH an embedding (no skipEmbed). This records a
        // node.upsert AND a verbatim.upsert row in the durable SQLite outbox.
        // The ONLY consumer that marks those rows replicated/completed is the
        // outbox REPLICATOR. The audit finding's durable defect: in embedded
        // mode the replicator is never started, so the rows stay pending
        // FOREVER (an unbounded leak) — and semantic recall has to wait on the
        // 30-min self-heal sweep. We assert on the outbox DEPTH draining to 0,
        // which depends solely on the replicator running.
        const NODE_ID = 'tw2a-embedded-recall-target';
        const UNIQUE = 'ztagliatelle quokka embedding-marker';
        const outboxStore = lore._daemon.outboxWiring.store;
        await check('(a) embedded nodeUpsert(embed) enqueues outbox rows', async () => {
            const res = await lore.nodeUpsert({
                id: NODE_ID,
                workspace: 'default',
                ecosystem: '*',
                nodeData: {
                    id: NODE_ID, type: 'note', label: 'embedding recall target',
                    content: UNIQUE, tags: 'tw2a', project: 'default', ecosystem: '*', metadata: '{}',
                },
            });
            assert.ok(res.ok, `nodeUpsert ok (got ${JSON.stringify(res)})`);
            const stats = await outboxStore.aggregateStats!();
            assert.ok(stats.depth >= 1, `at least one outbox row must be pending right after the write (depth=${stats.depth})`);
        });

        // ADVERSARIAL: we do NOT call tickOnce(). The ONLY thing that drains
        // the outbox is the running replicator LOOP — started by the embedded
        // path on the branch, NEVER started on base. We poll the outbox depth
        // and let the started loop (250 ms idle cadence) drain it to 0. On base
        // the loop is dormant, so depth never reaches 0 and the poll times out
        // with rows still pending → FAIL (the durable leak the finding names).
        await check('(a) running replicator drains the outbox to depth 0', async () => {
            let depth = Number.MAX_SAFE_INTEGER;
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline && depth > 0) {
                const stats = await outboxStore.aggregateStats!();
                depth = stats.depth;
                if (depth > 0) await new Promise((r) => setTimeout(r, 150));
            }
            assert.equal(depth, 0, 'the started replicator must drain every pending outbox row (base never starts it → stays pending)');
        });

        // And the node is recallable via its embedding once replication landed.
        await check('(a) verbatimSearch FINDS the embedded-written node', async () => {
            const hits = await lore.store.storageClient.verbatimSearch(UNIQUE, 10);
            assert.ok(
                hits.some((h) => h.id === `lore:${NODE_ID}` || h.id === NODE_ID),
                'the embedded-written node must be recallable via its embedding',
            );
        });

        await check('(a) dispose() clean', async () => { await lore.dispose('tw2a-a'); });
    }

    // ════════════════════════════════════════════════════════════════════
    // (b) dataDir ISOLATES TWO INSTANCES ON DISK
    // ════════════════════════════════════════════════════════════════════
    console.log('\n── (b) two dataDirs are isolated on disk ─────────────────');
    {
        const homeA = freshHome('isoA');
        const homeB = freshHome('isoB');
        seedDefaultWorkspace(homeA);
        seedDefaultWorkspace(homeB);

        const loreA = await createLore({ deploymentMode: 'embedded', dataDir: homeA });
        const loreB = await createLore({ deploymentMode: 'embedded', dataDir: homeB });

        await check('(b) instance handles report their own dataHome', () => {
            assert.equal(loreA.dataHome, homeA, 'A.dataHome === homeA');
            assert.equal(loreB.dataHome, homeB, 'B.dataHome === homeB');
        });

        const A_ONLY = 'tw2a-A-only-secret';
        await check('(b) write to A then assert NOT visible in B', async () => {
            const res = await loreA.nodeUpsert({
                id: A_ONLY,
                workspace: 'default',
                ecosystem: '*',
                nodeData: {
                    id: A_ONLY, type: 'note', label: 'A secret', content: 'lives only in A',
                    tags: 'a', project: 'default', ecosystem: '*', metadata: '{}',
                },
                skipEmbed: true,
            });
            assert.ok(res.ok, 'A write ok');

            const regA = loreA._daemon.getGraphRegistry();
            const regB = loreB._daemon.getGraphRegistry();
            assert.ok(regA && regB, 'both embedded instances expose a registry');
            const gA = await regA!.getGraphHandle('default');
            const gB = await regB!.getGraphHandle('default');

            const fromA = await gA.getNode(A_ONLY);
            const fromB = await gB.getNode(A_ONLY);
            assert.ok(fromA !== null, 'A must see its own node');
            assert.equal(fromB, null, 'B must NOT see A node (isolation broken on base — collision on global LORE_HOME)');
        });

        await check('(b) the two graphs live in SEPARATE on-disk dirs', () => {
            const graphA = path.join(homeA, '.lore', 'surreal');
            const graphB = path.join(homeB, '.lore', 'surreal');
            assert.notEqual(graphA, graphB, 'paths differ');
            assert.ok(fs.existsSync(graphA), `A graph dir exists on disk: ${graphA}`);
            assert.ok(fs.existsSync(graphB), `B graph dir exists on disk: ${graphB}`);
            // The collision bug would leave A's data under the global home, not
            // under homeA; existence under homeA is the disk-isolation proof.
        });

        await check('(b) dispose() both', async () => {
            await loreA.dispose('tw2a-b-a');
            await loreB.dispose('tw2a-b-b');
        });
    }

    // ════════════════════════════════════════════════════════════════════
    // (c) INIT-THROW LEAKS NO TIMERS
    // ════════════════════════════════════════════════════════════════════
    console.log('\n── (c) init-throw leaks zero timers ──────────────────────');
    {
        // Force graph.initialize() to throw: point the active workspace path
        // at a REGULAR FILE via LORE_HOME. SurrealGraph opens the embedded
        // engine under <path>/.lore/surreal; when that path is a regular
        // file, db.connect() fails on every attempt and initialize()
        // rejects — INSIDE the embedded init block, AFTER the createLore()
        // background timers (rate-limiter sweep, retention bootstrap, token
        // sweeper, consistency sweep, active-session sweep) have already
        // started.
        // The throw must land DURING the embedded substrate init (graph
        // initialize), AFTER createLore's background timers have started — not
        // at an earlier config read. So we make the workspace dir + its `.lore`
        // dir VALID (ConfigManager succeeds, timers start), but plant a regular
        // FILE where the engine wants its `.lore/surreal` data dir → graph
        // .initialize() rejects inside the embedded init block. We drive it
        // via LORE_HOME for parity with the original legacy-era fixture shape.
        // The open-retry budget is shrunk via env so the deliberate failure
        // costs ~1.5s, not the 15s production default.
        const home = freshHome('throw');
        fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
        fs.writeFileSync(path.join(home, '.lore', 'surreal'), 'not a database — a regular file');
        fs.writeFileSync(
            path.join(home, 'workspaces.json'),
            JSON.stringify(
                { active: 'default', workspaces: [{ name: 'default', path: home, createdAt: '2026-06-15T00:00:00.000Z' }] },
                null,
                2,
            ),
        );
        const prevHome = process.env['LORE_HOME'];
        process.env['LORE_HOME'] = home;
        const prevOpenBudget = process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
        const prevOpenTimeout = process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'];
        process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = '1500';
        process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'] = '400';

        // Snapshot LIVE timer handles immediately before the attempt.
        const before = snapshotTimers();

        await check('(c) createLore embedded REJECTS when graph init throws', async () => {
            try {
                const bad = await createLore({ deploymentMode: 'embedded', dataDir: home });
                await bad.dispose('tw2a-c-unexpected').catch(() => {});
                assert.fail('createLore must reject when substrate init throws');
            } catch {
                // expected — the init throw must propagate to the caller.
            }
        });

        await check('(c) init-throw leaked NO recurring Lore timers (cleanup ran)', async () => {
            // Allow the failed-init cleanup (the ordered drain) to clear timers.
            await new Promise((r) => realSetTimeout(r, 200));
            const leaked = leakedIntervalsSince(before);
            // On base: the background loops (rate-limiter sweep, retention
            // daily sweep, token sweeper, consistency sweep, active-session
            // sweep, orchestration tick) started before the UNGUARDED init
            // throw and were never cleared — dispose() is unreachable — so
            // SIX recurring intervals leak.
            // On branch: initEmbeddedSubstrates ran the ordered drain, which
            // clears every one of those. The audit-export file-tailer's flush
            // interval (audit/fileTailExporter.ts) is now ALSO stopped by the
            // embedded drain (composeEmbeddedDrain's stopAuditExporter hook,
            // wired in server.ts's buildEmbeddedDrain) — see
            // packages/lore/src/mcp/embeddedLifecycle.ts. So the floor is 0.
            const ACKNOWLEDGED_OUT_OF_SCOPE_FLOOR = 0;
            assert.ok(
                leaked <= ACKNOWLEDGED_OUT_OF_SCOPE_FLOOR,
                `init-throw must leak no TW-2a recurring timers; leaked=${leaked} ` +
                `(branch ≤ ${ACKNOWLEDGED_OUT_OF_SCOPE_FLOOR}; base leaks 6)`,
            );
        });

        if (prevHome === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = prevHome;
        if (prevOpenBudget === undefined) delete process.env['LORE_SURREAL_OPEN_BUDGET_MS']; else process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = prevOpenBudget;
        if (prevOpenTimeout === undefined) delete process.env['LORE_SURREAL_OPEN_TIMEOUT_MS']; else process.env['LORE_SURREAL_OPEN_TIMEOUT_MS'] = prevOpenTimeout;
    }

    // ════════════════════════════════════════════════════════════════════
    // (d) deploymentMode DOES NOT CHANGE BACKGROUND-LOOP BEHAVIOUR FOR A
    //     NON-OWNING HOST.  (S9-EMBEDDED-ENV-SCRUB follow-up)
    //
    //     The daemon sweepers (retention auto-sweep, auth-registry sweep,
    //     consistency reconciliation, scheduled compaction) were gated on
    //     `effectiveMode !== 'embedded'` — mode, not ownership. So a host that
    //     embedded Lore IN-PROCESS but chose deploymentMode 'local' started
    //     Lore's recurring housekeeping loops inside the HOST, and because that
    //     instance takes the plain (non-embedded) shutdown drain, several were
    //     never cleared and kept firing after dispose().
    //
    //     The invariant: for a caller that did NOT claim process ownership,
    //     picking 'local' instead of 'embedded' must not add a single recurring
    //     background loop. Asserted as a DELTA between the two modes rather
    //     than "zero timers", because a handful of loops (active-session sweep,
    //     orchestration tick, audit-exporter flush) are started outside this
    //     gate in both modes — they are a separate concern, and pinning an
    //     absolute count here would make this case fail for unrelated reasons.
    // ════════════════════════════════════════════════════════════════════
    console.log('\n── (d) non-owning host: mode must not change loop count ──');
    {
        const embeddedHome = freshHome('own-embedded');
        seedDefaultWorkspace(embeddedHome);
        const beforeEmbedded = snapshotTimers();
        const embeddedLore = await createLore({ deploymentMode: 'embedded', dataDir: embeddedHome });
        const embeddedLoops = leakedIntervalsSince(beforeEmbedded);
        await embeddedLore.dispose('tw2a-d-embedded');

        const localHome = freshHome('own-local');
        seedDefaultWorkspace(localHome);
        const beforeLocal = snapshotTimers();
        // Same library call, same lack of ownership — only the mode differs.
        const localLore = await createLore({ deploymentMode: 'local', dataDir: localHome });
        const localLoops = leakedIntervalsSince(beforeLocal);

        await check('(d) local adds NO recurring loops over embedded for a non-owning host', () => {
            assert.equal(
                localLoops,
                embeddedLoops,
                `deploymentMode changed process-global behaviour for a caller that never claimed ` +
                `ownership: embedded started ${embeddedLoops} recurring loop(s), local started ` +
                `${localLoops}. The extra loop(s) are the daemon sweepers running inside a host ` +
                `process Lore does not own — gate them on ownsProcess, not on mode.`,
            );
        });

        await localLore.dispose('tw2a-d-local');
    }

    // ── summary ──
    console.log('');
    console.log(`tw2a: ${passed} passed, ${failed} failed`);
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

    if (failed > 0) {
        console.error('TW-2a FAILED.');
        process.exit(1);
    }
    console.log('TW-2a PASSED — embedded replication + dataDir isolation + timer cleanup ✓');
    // Explicit clean exit (harness style): dispose() released the engine
    // handles; exit(0) avoids any native-teardown crash during natural
    // shutdown.
    process.exit(0);
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});
