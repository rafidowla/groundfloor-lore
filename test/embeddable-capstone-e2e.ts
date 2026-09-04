#!/usr/bin/env tsx
/**
 * embeddable-capstone-e2e.ts — TW-8a · the round-3 capstone.
 *
 * THE regression net for the entire embeddable-component round. It runs the
 * whole embedded-mode thesis end to end, IN ONE PROCESS, with NO port bound and
 * NO host-process pollution, and every assertion is FALSIFIABLE against a
 * pre-round-3 (swarm/integration-3 base) behaviour. If any of this round's
 * criticals regressed, this file goes red.
 *
 * It proves, in order:
 *
 *   (1) NO GLOBAL HANDLERS (TW-2b). Snapshot the host's
 *       process.listeners('uncaughtException'/'unhandledRejection') BEFORE
 *       createLore(); assert the set is byte-for-byte unchanged AFTER. On base,
 *       embedded createLore() leaves +1 of each behind. Also: no SIGINT/SIGTERM
 *       handlers, no process.exit, no net.Server / bound port.
 *
 *   (2) EMBEDDED REPLICATION ACTUALLY RUNS + SEMANTIC RECALL WORKS (TW-2a).
 *       Write a node WITH an embedding (default embed path, NOT skipEmbed) via
 *       the in-process nodeUpsert() API. That records a durable verbatim.upsert
 *       outbox row whose ONLY consumer is the outbox replicator. We drain the
 *       outbox to depth 0 (depends solely on the embedded replicator running —
 *       never started on base) and then recall the node through its EMBEDDING:
 *       a semantic query that shares NO substring with the node's label/content/
 *       tags. The query is chosen so the keyword path (the legacy graph engine lower(...) CONTAINS)
 *       returns NOTHING — we assert that too — so the verbatim hit can ONLY have
 *       come from a replicated vector. If replication were skipped, the vector
 *       never lands and this section FAILS (the exact bug TW-2a fixed).
 *
 *   (3) dataDir ISOLATION (TW-2a). A SECOND createLore({dataDir:B}) in the SAME
 *       process is fully isolated from instance A: a node written to A is not
 *       visible from B, B's secret is not visible from A, and the two graphs
 *       live in distinct on-disk dirs. On base, opts.dataDir never reaches the
 *       graph registry so both collide on the global LORE_HOME.
 *
 *   (4) CLEAN LIFECYCLE + NATURAL EXIT (TW-7b). dispose() drains both instances
 *       without throwing and is idempotent. The natural-exit proof — that an
 *       embedder can create → use → dispose → let Node exit on its own with NO
 *       process.exit and NO native legacy-graph-engine teardown SIGSEGV — is verified by
 *       spawning a child (`--child`) that does the full flow and exits NATURALLY;
 *       the parent asserts the child's exit code is exactly 0 (signal === null).
 *       The parent ITSELF also disposes everything and returns to a NATURAL exit
 *       (sets process.exitCode, never calls process.exit) — so even this runner
 *       demonstrates the contract it is testing.
 *
 * SUBSTANTIVE-ASSERTION DISCIPLINE: there is no expect(true).toBe(true) here.
 * Each assertion is wired to a specific round-3 fix and fails if that fix is
 * reverted:
 *   - §1 fails if global/process handlers are reinstalled (TW-2b).
 *   - §2 fails if embedded replication is skipped (TW-2a) — the recall depends
 *     on a REPLICATED embedding via a keyword-proof query.
 *   - §3 fails if dataDir is ignored (TW-2a).
 *   - §4 fails (non-zero child exit / SIGSEGV) if dispose teardown regresses
 *     (TW-7b).
 *
 * Harness: the tsx no-framework style used across test/ — manual pass/fail
 * counters. NO process.exit on the success path (the natural-exit contract is
 * part of what is under test).
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..');
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

// The default daemon HTTP port. The embedded library must never bind it.
const DAEMON_PORT = 3847;

// ── Workspace seeding ───────────────────────────────────────────────────────
// createLore({dataDir}) resolves the active boot graph + per-workspace graphs
// under <dataDir>. We seed a single "default" workspace at <home> so the
// embedded boot graph opens under THIS home and nowhere else.
function seedDefaultWorkspace(home: string): void {
    fs.mkdirSync(path.join(home, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(home, 'workspaces.json'),
        JSON.stringify(
            { active: 'default', workspaces: [{ name: 'default', path: home, createdAt: '2026-06-15T00:00:00.000Z' }] },
            null,
            2,
        ),
    );
}

function freshHome(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `lore-capstone-${tag}-`));
}

// ════════════════════════════════════════════════════════════════════════════
// CHILD MODE — the natural-exit proof for §4 (TW-7b).
// create → write (with real embedding) → dispose (×2, idempotent) → NATURAL
// EXIT. NO process.exit anywhere on the success path; NO signal handlers. If
// the native the legacy graph engine/LanceDB finalizers double-free during V8 GC-on-exit, this
// child crashes (code 139 / SIGSEGV) and the parent observes it.
// ════════════════════════════════════════════════════════════════════════════
async function runChildNaturalExit(): Promise<void> {
    const home = freshHome('child');
    seedDefaultWorkspace(home);
    delete process.env['LORE_HOME'];
    delete process.env['LORE_GRAPH_PATH'];

    const { createLore } = await import('../packages/lore/src/index.js');
    const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });
    const res = await lore.nodeUpsert({
        id: 'capstone-child-node',
        workspace: 'default',
        ecosystem: '*',
        nodeData: {
            id: 'capstone-child-node', type: 'note', label: 'child node',
            content: 'a node written in the spawned natural-exit child',
            tags: 'capstone', project: 'default', ecosystem: '*', metadata: '{}',
        },
        // Real embedding: exercises the verbatim + replicator + LanceDB native
        // handles, so teardown covers the full native surface (not graph-only).
    });
    if (!res.ok) {
        console.error('[child] nodeUpsert failed:', JSON.stringify(res));
        process.exitCode = 3; // surfaced as a non-zero parent assertion
        return;
    }
    await lore.dispose('capstone-child-teardown');
    // Idempotent second dispose must be a safe no-op, not a double-free.
    await lore.dispose('capstone-child-teardown-again');
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
    console.error('[child] disposed; returning to NATURAL process exit (no process.exit)');
    // INTENTIONAL: no process.exit — Node drains the loop and runs GC-on-exit.
    // A native double-free here SIGSEGVs and the parent's exit-code check fails.
}

// ════════════════════════════════════════════════════════════════════════════
// PARENT MODE — sections 1-4, all in-process.
// ════════════════════════════════════════════════════════════════════════════
async function runParent(): Promise<void> {
    // Do NOT set a global LORE_HOME: §3 proves dataDir ALONE isolates instances.
    delete process.env['LORE_HOME'];
    delete process.env['LORE_GRAPH_PATH'];

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

    /** Snapshot the EXACT listener function references the host has installed
     *  for the two process-global error events. We compare by reference (not
     *  just count) so a swapped handler can't sneak past a count check. */
    function snapshotGlobalHandlers(): {
        uncaught: ReadonlyArray<unknown>;
        unhandled: ReadonlyArray<unknown>;
        sigint: number;
        sigterm: number;
    } {
        return {
            uncaught: process.listeners('uncaughtException').slice(),
            unhandled: process.listeners('unhandledRejection').slice(),
            sigint: process.listenerCount('SIGINT'),
            sigterm: process.listenerCount('SIGTERM'),
        };
    }
    function sameRefs(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
        if (a.length !== b.length) return false;
        const sb = new Set(b);
        return a.every((x) => sb.has(x));
    }

    /** Connect to a TCP port; resolve true if something accepts, false if
     *  refused. Proves the embedded library bound no daemon transport. */
    function portIsListening(port: number, host = '127.0.0.1'): Promise<boolean> {
        return new Promise((resolve) => {
            const sock = net.connect({ port, host });
            const done = (v: boolean) => { sock.destroy(); resolve(v); };
            sock.once('connect', () => done(true));
            sock.once('error', () => done(false));
            sock.setTimeout(500, () => done(false));
        });
    }

    /** Count active net.Server handles owned by this process (portable proxy
     *  for "is a listener open"). _getActiveHandles is undocumented but stable;
     *  we filter to net.Server so timers/sockets don't perturb the count. */
    function netServerHandleCount(): number {
        const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
        if (typeof getHandles !== 'function') return -1;
        return getHandles.call(process).filter((h) => h instanceof net.Server).length;
    }

    console.log('TW-8a CAPSTONE — embedded end-to-end (one process, no port, no host pollution)');
    console.log('='.repeat(76));

    // ════════════════════════════════════════════════════════════════════════
    // (1) NO GLOBAL HANDLERS / NO PROCESS OWNERSHIP (TW-2b) — snapshot around
    //     createLore() and assert the host lifecycle is untouched.
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── (1) embedded is portless + installs NO global handlers ──────');

    const before = snapshotGlobalHandlers();
    const netServersBefore = netServerHandleCount();
    // If an UNRELATED daemon already owns :3847 before we create the embedded
    // instance, the global-port probe below cannot attribute that listener to
    // us. Capture the pre-state so the probe can skip in that case — the
    // process-local net.Server-handle check (createLore opened NO net.Server)
    // is the authoritative "embedded is portless" guarantee regardless of any
    // external daemon. (Keeps `npm test` green when the operator's daemon runs.)
    const portOwnedByExternalDaemon = await portIsListening(DAEMON_PORT);

    // Spy on process.exit so we can prove createLore() never calls it.
    const realExit = process.exit;
    let exitCalled = false;
    (process as unknown as { exit: (code?: number) => never }).exit =
        ((_code?: number) => { exitCalled = true; return undefined as never; });

    const homeA = freshHome('A');
    seedDefaultWorkspace(homeA);
    let loreA: Awaited<ReturnType<typeof createLore>>;
    try {
        loreA = await createLore({ deploymentMode: 'embedded', dataDir: homeA });
    } finally {
        process.exit = realExit;
    }

    const afterCreate = snapshotGlobalHandlers();

    await check('(1) createLore resolved to a usable in-process embedded instance', () => {
        assert.ok(loreA, 'createLore returned a LoreInstance');
        assert.equal(loreA.runMode, 'embedded', 'runMode is embedded');
        assert.equal(loreA.deploymentMode, 'local', 'embedded collapses substrate to local');
        assert.equal(typeof loreA.nodeUpsert, 'function', 'in-process nodeUpsert API is present');
        assert.equal(typeof loreA.dispose, 'function', 'host-owned dispose is present');
        assert.equal(loreA.dataHome, homeA, 'dataHome threads through to homeA');
    });

    await check('(1) createLore added NO uncaughtException handler (TW-2b)', () => {
        assert.ok(
            sameRefs(before.uncaught, afterCreate.uncaught),
            `host uncaughtException listener set must be UNCHANGED ` +
            `(before=${before.uncaught.length} after=${afterCreate.uncaught.length})`,
        );
    });

    await check('(1) createLore added NO unhandledRejection handler (TW-2b)', () => {
        assert.ok(
            sameRefs(before.unhandled, afterCreate.unhandled),
            `host unhandledRejection listener set must be UNCHANGED ` +
            `(before=${before.unhandled.length} after=${afterCreate.unhandled.length})`,
        );
    });

    await check('(1) createLore added NO SIGINT/SIGTERM handler', () => {
        assert.equal(afterCreate.sigint, before.sigint, 'no SIGINT handler added');
        assert.equal(afterCreate.sigterm, before.sigterm, 'no SIGTERM handler added');
    });

    await check('(1) createLore did NOT call process.exit (host owns lifecycle)', () => {
        assert.equal(exitCalled, false, 'createLore must not call process.exit');
    });

    await check('(1) createLore opened NO net.Server (active server-handle count unchanged)', () => {
        const after = netServerHandleCount();
        if (netServersBefore < 0 || after < 0) {
            console.log('       (note: _getActiveHandles unavailable — relying on port-refused check)');
            return;
        }
        assert.equal(after, netServersBefore, 'createLore must not open any net.Server listener');
    });

    await check(`(1) daemon HTTP port ${DAEMON_PORT} is NOT listening`, async () => {
        if (portOwnedByExternalDaemon) {
            console.log(`       (note: :${DAEMON_PORT} was already owned by an external daemon before createLore — skipping the global-port probe; the net.Server-handle check above already proves embedded opened no listener)`);
            return;
        }
        const listening = await portIsListening(DAEMON_PORT);
        assert.equal(listening, false, `no daemon transport — port ${DAEMON_PORT} must refuse connections`);
    });

    // ════════════════════════════════════════════════════════════════════════
    // (2) EMBEDDED REPLICATION RUNS + SEMANTIC RECALL (TW-2a).
    //     Write WITH an embedding → drain the outbox (only the started embedded
    //     replicator can) → recall via a KEYWORD-PROOF semantic query.
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── (2) embedded replication runs → semantic recall via embedding ──');

    // The node's searchable text. Deliberately NO token overlap with the recall
    // query below, so the only way to retrieve it is a replicated vector.
    const NODE_ID = 'capstone-semantic-recall-target';
    const NODE_LABEL = 'astronomy observation';
    const NODE_CONTENT = 'A luminous celestial body emits radiant heat across the dark void of outer space.';
    const NODE_TAGS = 'cosmos';
    // Semantically near "the sun / a star shining in space" but shares NO
    // substring with label/content/tags → the legacy graph engine CONTAINS cannot match it; only
    // an embedding can. (Verified explicitly by the keyword-miss assertion.)
    const SEMANTIC_QUERY = 'our nearest bright stellar furnace glowing in the galaxy';

    const outboxStore = loreA._daemon.outboxWiring.store;

    await check('(2) nodeUpsert(embed) enqueues a verbatim outbox row', async () => {
        const res = await loreA.nodeUpsert({
            id: NODE_ID,
            workspace: 'default',
            ecosystem: '*',
            nodeData: {
                id: NODE_ID, type: 'note', label: NODE_LABEL,
                content: NODE_CONTENT, tags: NODE_TAGS,
                project: 'default', ecosystem: '*', metadata: '{}',
            },
            // NOTE: no skipEmbed → the verbatim.upsert outbox row IS recorded.
        });
        assert.ok(res.ok, `nodeUpsert ok (got ${JSON.stringify(res)})`);
        const stats = await outboxStore.aggregateStats!();
        assert.ok(stats.depth >= 1, `at least one outbox row pending right after write (depth=${stats.depth})`);
    });

    await check('(2) the STARTED embedded replicator drains the outbox to depth 0', async () => {
        // We do NOT manually tick. The only consumer that marks the verbatim row
        // replicated is the replicator LOOP — started in-process by createLore on
        // the TW-2a branch, NEVER started on base. Poll depth → 0. On base the
        // loop is dormant so this times out with rows pending → FAIL.
        let depth = Number.MAX_SAFE_INTEGER;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && depth > 0) {
            depth = (await outboxStore.aggregateStats!()).depth;
            if (depth > 0) await new Promise((r) => setTimeout(r, 150));
        }
        assert.equal(depth, 0, 'the started replicator must drain every pending outbox row (base never starts it)');
    });

    await check('(2) keyword search MISSES the semantic query (proves no keyword fallback)', async () => {
        // the legacy graph engine lower(label|content|tags) CONTAINS <query>. The query shares no
        // substring with the node, so the keyword path returns nothing. This is
        // what makes the verbatim hit below attributable ONLY to the embedding.
        const kw = await loreA.store.storageClient.search(SEMANTIC_QUERY, 10, '*', '*');
        assert.ok(
            !kw.some((n) => n.id === NODE_ID),
            `keyword search must NOT find the node for a no-overlap query (got ${kw.map((n) => n.id).join(',')}) — ` +
            'otherwise the recall below could pass without any embedding',
        );
    });

    await check('(2) verbatimSearch FINDS the node VIA ITS REPLICATED EMBEDDING', async () => {
        const hits = await loreA.store.storageClient.verbatimSearch(SEMANTIC_QUERY, 10);
        assert.ok(
            hits.some((h) => h.id === `lore:${NODE_ID}` || h.id === NODE_ID),
            `semantic recall must surface the embedded-written node via its vector ` +
            `(query has no keyword overlap; hits=${hits.map((h) => h.id).join(',') || '<none>'}). ` +
            'On base the replicator never ran → no vector → this FAILS.',
        );
    });

    // ════════════════════════════════════════════════════════════════════════
    // (3) dataDir ISOLATION — a SECOND instance in the SAME process is isolated.
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── (3) two dataDirs in one process are fully isolated (TW-2a) ──');

    const homeB = freshHome('B');
    seedDefaultWorkspace(homeB);
    const loreB = await createLore({ deploymentMode: 'embedded', dataDir: homeB });

    await check('(3) each instance reports its own dataHome', () => {
        assert.equal(loreA.dataHome, homeA, 'A.dataHome === homeA');
        assert.equal(loreB.dataHome, homeB, 'B.dataHome === homeB');
        assert.notEqual(homeA, homeB, 'the two homes are distinct dirs');
    });

    await check('(3) a node written to A is NOT visible from B, and B-secret NOT visible from A', async () => {
        const regA = loreA._daemon.getGraphRegistry();
        const regB = loreB._daemon.getGraphRegistry();
        assert.ok(regA && regB, 'both embedded instances expose a graph registry');
        // getGraphHandle (not getOrOpen, which is hardcoded the legacy graph engine) — the
        // engine-aware accessor, matching how every other read/write path
        // resolves a workspace's actual graphEngine (surreal by default).
        const gA = await regA!.getGraphHandle('default');
        const gB = await regB!.getGraphHandle('default');

        // NODE_ID was written to A in §2. It must be invisible from B.
        assert.ok(await gA.getNode(NODE_ID), 'A must see its own node');
        assert.equal(await gB.getNode(NODE_ID), null, 'B must NOT see A node (isolation broken on base)');

        // A B-only secret must be invisible from A.
        const B_SECRET = 'capstone-B-only-secret';
        const res = await loreB.nodeUpsert({
            id: B_SECRET,
            workspace: 'default',
            ecosystem: '*',
            nodeData: {
                id: B_SECRET, type: 'note', label: 'B secret', content: 'lives only in B',
                tags: 'private', project: 'default', ecosystem: '*', metadata: '{}',
            },
            skipEmbed: true,
        });
        assert.ok(res.ok, 'B write ok');
        assert.equal(await gA.getNode(B_SECRET), null, 'A must NOT see B node (isolation broken on base)');
    });

    await check('(3) the two graphs live in SEPARATE on-disk dirs', () => {
        // .lore/surreal, not .lore/graph (the legacy graph engine) — new workspaces default to
        // SurrealDB, and no legacy graph engine file should exist at all for one (confirmed
        // 2026-08-13, see the outboxGetGraphForWorkspace fix in server.ts).
        const graphA = path.join(homeA, '.lore', 'surreal');
        const graphB = path.join(homeB, '.lore', 'surreal');
        assert.notEqual(graphA, graphB, 'paths differ');
        assert.ok(fs.existsSync(graphA), `A graph dir exists on disk: ${graphA}`);
        assert.ok(fs.existsSync(graphB), `B graph dir exists on disk: ${graphB}`);
        const legacyLeakA = path.join(homeA, '.lore', 'graph');
        const legacyLeakB = path.join(homeB, '.lore', 'graph');
        assert.ok(!fs.existsSync(legacyLeakA), `A must have NO the legacy graph engine file at all on a Surreal-backed workspace: ${legacyLeakA}`);
        assert.ok(!fs.existsSync(legacyLeakB), `B must have NO the legacy graph engine file at all on a Surreal-backed workspace: ${legacyLeakB}`);
    });

    // ════════════════════════════════════════════════════════════════════════
    // (3b) AUDIT-LOG SIDE CHANNEL — dataDir isolation must hold for EVERY
    // subsystem, not just the graph/vector data. Regression for a confirmed
    // leak: AuditLog's constructor fell through to the legacy env-based
    // loreHomePath() shim instead of receiving the instance's resolved
    // dataHome, so a write through a fully-isolated createLore({dataDir})
    // instance still appended its audit row somewhere OTHER than that
    // instance's own dataDir (in production, real HOME/.groundfloor; see the
    // bug report for the live repro against a real ~/.groundfloor).
    //
    // Cannot reproduce the "leaks into the real operator home" shape of the
    // bug from inside test/ directly: resolveLoreHome() (config/loreHome.ts)
    // has a deliberate isTestProcess() guard that redirects the no-dataDir
    // fallback to an isolated per-PID temp dir specifically so the test
    // suite can never scribble the operator's real ~/.groundfloor — good
    // safety, but it also means faking HOME here would only prove the guard
    // works, not that THIS instance's audit log honours ITS OWN dataDir.
    // Test the actual mechanism directly instead: does audit.jsonl land
    // inside dataHome (this instance's own directory), or somewhere shared
    // across every instance in the process (the per-PID fallback, on base —
    // which would put A's and B's audit rows in the SAME file, not each
    // instance's own dataDir, defeating the "fully isolated" promise just as
    // surely as leaking to the real home would).
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── (3b) the audit log honours each instance\'s OWN dataDir ──');

    await check('(3b) A and B each get their OWN audit.jsonl under their OWN dataDir, not a shared fallback', () => {
        const auditA = path.join(homeA, 'audit.jsonl');
        const auditB = path.join(homeB, 'audit.jsonl');
        assert.ok(fs.existsSync(auditA), `A's audit log must live under A's own dataDir: ${auditA}`);
        assert.ok(fs.existsSync(auditB), `B's audit log must live under B's own dataDir: ${auditB}`);
        assert.notEqual(auditA, auditB, 'A and B must not share one audit-log path');
        // Falsifiable the way §3's graph-isolation checks are: on base (no
        // dataHome threaded into AuditLog), BOTH instances fall back to the
        // one per-PID test-home path and this assertion fails — audit.jsonl
        // exists somewhere, just not under homeA/homeB.
    });

    // ════════════════════════════════════════════════════════════════════════
    // (4a) CLEAN LIFECYCLE — dispose() drains both without throwing; idempotent.
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n── (4) clean lifecycle + natural exit (TW-7b) ──────────────────');

    await check('(4) dispose() drains both instances without throwing', async () => {
        await loreA.dispose('capstone-A-teardown');
        await loreB.dispose('capstone-B-teardown');
    });

    await check('(4) dispose() is idempotent — a second call is a no-op, not a crash', async () => {
        await loreA.dispose('capstone-A-teardown-again');
        await loreB.dispose('capstone-B-teardown-again');
    });

    await check('(4) after dispose(): host global-handler set is UNCHANGED from baseline', () => {
        const afterDispose = snapshotGlobalHandlers();
        assert.ok(sameRefs(before.uncaught, afterDispose.uncaught), 'uncaughtException set restored to baseline');
        assert.ok(sameRefs(before.unhandled, afterDispose.unhandled), 'unhandledRejection set restored to baseline');
        assert.equal(afterDispose.sigint, before.sigint, 'SIGINT count restored');
        assert.equal(afterDispose.sigterm, before.sigterm, 'SIGTERM count restored');
    });

    // ── (4b) NATURAL-EXIT proof via a spawned child (TW-7b). ────────────────
    await check('(4) spawned child: create → embed-write → dispose → NATURAL exit is clean (no SIGSEGV)', () => {
        const res = spawnSync(TSX_BIN, [SELF, '--child'], {
            cwd: REPO_ROOT,
            env: { ...process.env },
            stdio: ['ignore', 'inherit', 'inherit'],
            timeout: 120_000, // model load + legacy-engine init + replication take a few seconds
        });
        assert.equal(
            res.signal,
            null,
            `child terminated by signal ${res.signal} — a native legacy-engine/LanceDB teardown crash (SIGSEGV) on natural exit`,
        );
        assert.equal(res.status, 0, `child exited ${res.status}, expected 0 (clean natural teardown, no process.exit)`);
    });

    // Clean up temp homes.
    for (const d of [homeA, homeB]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }

    // ── summary ──
    console.log('');
    console.log(`capstone: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.error('CAPSTONE FAILED — a round-3 embeddable guarantee regressed.');
    } else {
        console.log('CAPSTONE PASSED — embedded: portless, no global handlers, replication+recall, dataDir-isolated, clean+natural teardown ✓');
    }

    // NATURAL EXIT (TW-7b): the parent disposed every the legacy graph engine/LanceDB handle it
    // opened, so it returns to a natural process exit too. We set process.exitCode
    // instead of calling process.exit — even this runner proves the contract it
    // tests (no process.exit mask; a teardown SIGSEGV here would be a real crash).
    process.exitCode = failed > 0 ? 1 : 0;
}

// ── Dispatch: child path or full parent run. ────────────────────────────────
if (process.argv.includes('--child')) {
    await runChildNaturalExit();
    // NO process.exit on success — that is the entire point of this child.
} else {
    await runParent();
}
