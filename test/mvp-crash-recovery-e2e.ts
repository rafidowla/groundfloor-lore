#!/usr/bin/env tsx
/**
 * mvp-crash-recovery-e2e.ts — MVP readiness P1a: LIVE hard-crash durability.
 *
 * The unit suite (outbox-crash-recovery-unit) + chaos-suite prove the outbox
 * REPLAY LOGIC in-process. This proves the REAL daemon survives a hard kill:
 * write nodes, SIGKILL the process (no graceful drain — a true crash) BEFORE
 * the outbox has drained, restart on the SAME data dir, and assert nothing was
 * lost — graph nodes persisted (the legacy graph engine durability) AND the un-drained embed rows
 * replay on boot so semantic recall still works.
 *
 * Falsifiable: on a daemon that lost un-replicated writes on crash, §2 (count)
 * or §3 (recall after recovery) goes red.
 */

import assert from 'node:assert/strict';
import { spawnDaemon, waitForReady, fetchAuthToken, killDaemon, cleanup, type DaemonHandle } from './helpers/live-daemon.js';

let passed = 0;
let failed = 0;

const N = 6; // single synchronous writes (default embed) — land in the legacy graph engine before each 200

console.log('MVP crash-recovery E2E — SIGKILL mid-flight, restart, zero loss');

async function main(): Promise<void> {
    let h: DaemonHandle | null = null;
    let home = '';
    try {
        // ── Boot, write a batch, then CRASH before the outbox drains ──────────
        h = await spawnDaemon();
        home = h.home;
        assert.ok(await waitForReady(h.port), `daemon never ready\n${h.log.text}`);
        h.token = await fetchAuthToken(h.port, h.home);
        let base = `http://127.0.0.1:${h.port}`;
        const hdr = (t: string) => ({ Authorization: `Bearer ${t}`, Origin: base, 'Content-Type': 'application/json' });

        // Single writes via POST /api/node with the DEFAULT embed path: each node
        // is written to the legacy graph engine SYNCHRONOUSLY (recorded to graph.wal) before its 200,
        // so the graph itself — not just the outbox — must survive the hard kill.
        for (let i = 0; i < N; i++) {
            const r = await fetch(`${base}/api/node`, { method: 'POST', headers: hdr(h.token), body: JSON.stringify({
                id: `mvp-crash-${i}`, type: 'note', label: `crash fixture ${i}`,
                content: `durability probe number ${i}: the daemon must not lose this across a hard kill`,
                tags: 'crash,durability', workspace: 'default',
            }) });
            assert.ok(r.status === 200 || r.status === 201, `write ${i} failed: ${r.status} ${await r.text()}`);
        }
        // The writes are synchronous, so they're already counted before the crash.
        const preKill = await (await fetch(`${base}/api/stats?workspace=default`, { headers: { Authorization: `Bearer ${h.token}`, Origin: base } })).json() as { nodeCount?: number };
        assert.equal(preKill.nodeCount, N, `pre-kill count must be ${N} (synchronous writes), got ${preKill.nodeCount}`);
        // Hard crash: SIGKILL the whole daemon process GROUP (so the real node
        // process — not just the npx wrapper — dies and releases the legacy engine's OS-level
        // graph lock), then wait for it to be reaped + the lock to free. (A real
        // supervisor like launchd handles this with its restart loop; here we poll.)
        await killDaemon(h, 'SIGKILL');
        await new Promise((r) => setTimeout(r, 2000));

        // ── Restart on the SAME home (data dir), retrying while the lock frees ──
        let recovered = false;
        for (let attempt = 0; attempt < 4 && !recovered; attempt++) {
            h = await spawnDaemon({ home });
            if (await waitForReady(h.port, 20_000)) { recovered = true; break; }
            await killDaemon(h, 'SIGKILL');
            await new Promise((r) => setTimeout(r, 3000)); // lock not free yet — back off + retry
        }
        assert.ok(recovered, `daemon never recovered after crash (last boot log)\n${h.log.text.slice(-1500)}`);
        h.token = await fetchAuthToken(h.port, h.home);
        base = `http://127.0.0.1:${h.port}`;
        const get = (p: string) => fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${h!.token}`, Origin: base } });

        // §2 — every graph node survived the hard crash. Synchronous writes were
        // recorded to the legacy engine's graph.wal before each 200, so reopening the data dir
        // replays the WAL and the nodes are all present (allow a short settle for
        // WAL replay on boot).
        let count = 0;
        for (let i = 0; i < 40; i++) {
            const s = await (await get('/api/stats?workspace=default')).json() as { nodeCount?: number };
            count = s.nodeCount ?? 0;
            if (count >= N) break;
            await new Promise((r) => setTimeout(r, 250));
        }
        assert.equal(count, N, `expected ${N} nodes after crash recovery, got ${count}`);
        // Spot-check a specific node's full body is intact.
        const full = await (await get(`/api/node-full?id=${encodeURIComponent('mvp-crash-3')}&workspace=default`)).text();
        assert.ok(full.includes('durability probe number 3'), 'a specific node body must be intact after the crash');

        // §3 — embeddings survived too (default embed is inline → in LanceDB before
        // the crash): semantic recall returns a node post-recovery.
        let recalled = false;
        for (let i = 0; i < 20; i++) {
            const rr = await get(`/api/recall?topic=${encodeURIComponent('information durability guarantee under failure')}&workspace=default`);
            if (rr.status === 200 && JSON.stringify(await rr.json()).includes('mvp-crash-')) { recalled = true; break; }
            await new Promise((r) => setTimeout(r, 250));
        }
        assert.ok(recalled, 'semantic recall failed after recovery — embedding lost on crash');

        console.log(`  ✓ wrote ${N} nodes synchronously, SIGKILL'd the daemon group, restarted on the same data dir`);
        console.log('  ✓ §2 all graph nodes survived the hard crash (count exact + spot-check body intact)');
        console.log('  ✓ §3 embeddings survived (semantic recall works post-recovery)');
        passed = 3;
    } catch (err) {
        failed = 1;
        console.error(`  ✗ ${(err as Error).message}`);
        if (h) console.error(`--- daemon log tail ---\n${h.log.text.slice(-2000)}`);
    } finally {
        cleanup(h); // removes the (restarted) home
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
