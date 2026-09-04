#!/usr/bin/env tsx
/**
 * compact-maintain-otherdaemon-unit.ts — `lore compact` and `lore maintain`'s
 * LanceDB-only path (compaction, version cleanup, ephemeral expiry with node
 * retention off) must not treat "a process on LORE_PORT did not confirm it
 * serves this home" as "safe to proceed".
 *
 * ── THE BUG (round E3, 2026-09-03, finding: high) ───────────────────────────
 *
 * Both commands gated their destructive LanceDB operations on a single
 * `isDaemonServingHome(loreHome()).servesHome` check. `servesHome: false`
 * covers THREE very different situations:
 *   1. no daemon reachable at all
 *   2. a daemon reachable on the port that rejected our credential (401/403,
 *      or a 200 body with no `loreHome`) — e.g. a stale/rotated/corrupted
 *      `auth.token`
 *   3. a daemon reachable on the port serving a genuinely different home
 *
 * Only case 1 is actually safe to proceed on. Cases 2 and 3 mean "a process
 * IS there and we could not confirm it isn't ours" — proceeding races
 * whatever it's doing. Reproduced with REAL LanceDB corruption in
 * qa/B5-round3/attack1b-compact-no-fallback.mts: a stale CLI token made the
 * daemon's health probe come back 401 (`servesHome: false`), and
 * `compactCommand` ran `table.optimize()` straight into a table a live
 * "daemon" connection was concurrently deleting from, producing
 * `lance error: Not found: …_deletions/….arrow`.
 *
 * Unlike the 18 commands routed through `openGraphForCli()`
 * (cli/commands/shared.ts), which fall through to a REAL on-disk lock
 * attempt via `openWorkspaceGraph(...).initialize()` as a fallback safety
 * net when the port probe is wrong, neither `compact.ts` nor the
 * `needGraph=false` (LanceDB-only) branch of `maintain.ts` ever opens the
 * graph store — so nothing caught a holder the port probe missed.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────
 *
 * Layer 1 (case 2/3 above): treat `otherDaemonReachable: true` as "not
 * proven safe" and refuse (same as a confirmed same-home daemon) unless
 * `--force` — `otherDaemonRefuseMessage()` in
 * migrateWorkspaceToWorkspaceShared.ts.
 *
 * Layer 2 (defense in depth for case 1, and for a case-2/3 daemon whose
 * health endpoint the port probe missed entirely — wrong port, timed-out
 * probe, no `auth.token` on disk to send): `probeSurrealLock()` opens (and
 * immediately closes) the workspace's own SurrealDB graph store directly —
 * no HTTP involved — right before LanceDB compaction/version-cleanup runs.
 * A daemon holds a workspace's graph store open whenever it holds ANY of
 * that workspace's substrates (including LanceDB) open, so this catches a
 * real holder the port probe cannot see by construction.
 *
 * T1 — compact: stale/rejected token (401) → refuses, no optimize runs.
 * T2 — compact: no daemon reachable at all, but the workspace's graph store
 *      IS held by a real second SurrealGraph handle → probeSurrealLock
 *      catches it, refuses, no optimize runs.
 * T3 — compact: no daemon, no holder → proceeds normally (control: the fix
 *      does not over-block the common case), and actually shrinks a
 *      tombstoned LanceDB table.
 * T4 — compact --force: bypasses both layers even against a rejected token.
 * T5 — maintain (LanceDB-only: --no-node-retention --no-ephemeral): stale/
 *      rejected token (401) → refuses before touching LanceDB.
 * T6 — maintain (LanceDB-only): no daemon reachable, workspace's graph store
 *      held by a real holder → probeSurrealLock catches it per-workspace,
 *      skips that workspace, never runs LanceDB compaction against it.
 * T7 — maintain (LanceDB-only): no daemon, no holder → proceeds normally.
 * T8 — message text: the otherDaemonReachable refusal names the port and
 *      says "rejected this CLI token", not "reports a different home" (that
 *      phrase would be false here — the daemon never told us whose home it
 *      serves, only that our credential didn't work).
 *
 * ── ROUND E4 FINDING (high, narrow) — absent graph store directory ─────────
 *
 * Both layers above assume "a daemon holds the graph store open whenever it
 * holds ANY of a workspace's substrates (including LanceDB)" — true for the
 * real Lore daemon (every LanceDB write route resolves the graph handle
 * first), but NOT true for anything that writes to `.lore/lancedb/` directly,
 * bypassing that routing. `probeSurrealLock`'s own doc comment says an ABSENT
 * store directory reports `free: true` BY DESIGN (probing would CREATE the
 * store — wrong for a restore destination) — so a workspace with LanceDB
 * data but no `.lore/surreal/` dir at all sailed through both layers with no
 * daemon detectable (no `auth.token`) and `probeSurrealLock` reporting
 * `free`. Reproduced with real data loss in
 * qa/B5-round4/attack2-graph-store-absent.mts (a raw concurrent LanceDB
 * writer's table collapsed to 0 rows after compact ran unchecked against
 * it). Fix: when the graph store directory is absent, neither command can
 * prove nothing else is writing to `lancedb/` — refuse unless `--force`.
 * There is no LanceDB-native lock to fall back on. Scoped to `lore
 * maintain`'s LanceDB-only (`needGraph === false`) path only — when node
 * retention is on, `openWorkspaceGraph(...).initialize()` opens/creates the
 * graph store directly right after this check and is the real safety net
 * for that path; refusing there too would block the ordinary case of a
 * brand-new workspace's first node-retention run.
 *
 * T9  — compact: no graph store directory at all → refuses, no optimize()
 *       runs (proven via unchanged file mtimes under `.lore/lancedb/`, not
 *       just an unchanged total size).
 * T10 — compact --force: bypasses the absent-graph-store refusal too, and
 *       prints a one-line notice at the moment the bypass happens (round E4,
 *       finding: low — `--force` used to skip every check silently).
 * T11 — compact refuses against a REAL spawned daemon (not a fake HTTP
 *       server) presented with a stale-but-plausible Bearer: confirms the
 *       real `/api/health` really does answer 200 with an anonymous/lite
 *       body (not 401) for a rejected token on this public path, and that
 *       `isDaemonServingHome` still correctly reports `credentialRejected`
 *       against that real response shape — the one gap T1-T8's fake-401
 *       servers do not cover.
 *
 * IMPLEMENTATION NOTE — each test runs in its OWN freshly spawned `tsx`
 * process, exactly like test/cli-daemon-preflight-unit.ts and
 * test/phase6-p4-migrate-and-compact-unit.ts. This is required, not just
 * convenient: `DEFAULT_PORT` in migrateWorkspaceToWorkspaceShared.ts is
 * `Number(process.env['LORE_PORT'] ?? 3847)` evaluated ONCE at module load,
 * and every test after the first to `import()` anything that transitively
 * pulls that module in (compact.js, maintain.js) would otherwise share —
 * and be silently pinned to — whichever LORE_PORT happened to be set at
 * that first import, in a single shared process.
 *
 * Run: npx tsx test/compact-maintain-otherdaemon-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(selfPath), '..');
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const SERVER_ENTRY = path.join(repoRoot, 'packages/lore/src/mcp/server.ts');

/** T11 only — a free ephemeral port for the real spawned daemon. */
function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            if (addr && typeof addr === 'object') { const p = addr.port; srv.close(() => resolve(p)); }
            else srv.close(() => reject(new Error('no free port')));
        });
    });
}

function dirSize(p: string): number {
    if (!fs.existsSync(p)) return 0;
    let total = 0;
    const stack: string[] = [p];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const child = path.join(cur, entry.name);
            try {
                if (entry.isDirectory()) stack.push(child);
                else if (entry.isFile()) total += fs.statSync(child).size;
            } catch { /* vanished mid-walk */ }
        }
    }
    return total;
}

/** relative-path -> mtimeMs, for every file under `p`. Used to prove a
 *  refused compaction never touched the LanceDB files on disk (a byte-count
 *  comparison alone would miss a rewrite that nets out to the same size). */
function snapshotMtimes(p: string): Record<string, number> {
    const out: Record<string, number> = {};
    if (!fs.existsSync(p)) return out;
    const stack: string[] = [p];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const child = path.join(cur, entry.name);
            try {
                if (entry.isDirectory()) stack.push(child);
                else if (entry.isFile()) out[path.relative(p, child)] = fs.statSync(child).mtimeMs;
            } catch { /* vanished mid-walk */ }
        }
    }
    return out;
}

/** Real LanceDB table with tombstoned rows under `<wsPath>/.lore/lancedb`,
 *  matching production layout and qa/B5-round3/attack1b's repro shape. */
async function seedLanceTable(wsPath: string): Promise<{ lancedbDir: string }> {
    const lancedbDir = path.join(wsPath, '.lore', 'lancedb');
    fs.mkdirSync(lancedbDir, { recursive: true });
    const require = createRequire(path.join(repoRoot, 'package.json'));
    const lancedb = await import(require.resolve('@lancedb/lancedb'));
    const db = await lancedb.connect(lancedbDir);
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, vec: [i * 0.1, i * 0.2], text: `row-${i}` }));
    const table = await db.createTable('nodes', rows);
    await table.delete('id % 2 = 0'); // tombstone half — leaves reclaimable space for optimize()
    return { lancedbDir };
}

/** Create (and immediately close) a workspace's SurrealDB graph store, so a
 *  "control" fixture has a genuinely present-but-unlocked store — distinct
 *  from the round-E4 absent-store case, which is refused by design now. */
async function createAndCloseGraphStore(wsPath: string, workspaceId: string): Promise<void> {
    const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
    const g = new SurrealGraph(wsPath, { workspaceId });
    await g.initialize();
    await g.close();
}

function startRejectingDaemonSync(): { server: http.Server; port: number } {
    const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if ((req.url ?? '').startsWith('/api/health')) {
            res.writeHead(401);
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
        }
        res.writeHead(404);
        res.end('{}');
    });
    return { server, port: 0 }; // caller awaits listen separately (needs async)
}

/* ─────────────────────────── Child-process bodies ─────────────────────── */

async function childT1(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const entry = createWorkspace('t1-rejected', {}, home);
    const { lancedbDir } = await seedLanceTable(entry.path);
    const sizeBefore = dirSize(lancedbDir);

    fs.writeFileSync(path.join(home, 'auth.token'), 'stale-token', 'utf-8');
    const { server } = startRejectingDaemonSync();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port); // set BEFORE first import of compact.js below

    const { compactCommand } = await import('../packages/lore/src/cli/commands/compact.js');
    let exitCode: number | null = null;
    const origExit = process.exit.bind(process);
    process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error('__exit__'); };
    let threwOther: string | null = null;
    try {
        await compactCommand(['t1-rejected']);
    } catch (e) {
        if ((e as Error).message !== '__exit__') threwOther = (e as Error).message;
    }
    process.exit = origExit;
    server.close();

    const sizeAfter = dirSize(lancedbDir);
    console.log('===RESULT_START===');
    console.log(`EXIT_CODE=${exitCode === null ? '' : exitCode}`);
    console.log(`THREW_OTHER=${threwOther ?? ''}`);
    console.log(`SIZE_BEFORE=${sizeBefore}`);
    console.log(`SIZE_AFTER=${sizeAfter}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT2(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
    const entry = createWorkspace('t2-locked', {}, home);
    const { lancedbDir } = await seedLanceTable(entry.path);
    const sizeBefore = dirSize(lancedbDir);

    const seeder = new SurrealGraph(entry.path, { workspaceId: 't2-locked' });
    await seeder.initialize();
    await seeder.close();
    const holder = new SurrealGraph(entry.path, { workspaceId: 't2-locked' });
    await holder.initialize();

    const { compactCommand } = await import('../packages/lore/src/cli/commands/compact.js');
    let exitCode: number | null = null;
    const origExit = process.exit.bind(process);
    process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error('__exit__'); };
    let threwOther: string | null = null;
    try {
        await compactCommand(['t2-locked']);
    } catch (e) {
        if ((e as Error).message !== '__exit__') threwOther = (e as Error).message;
    }
    process.exit = origExit;
    await holder.close();

    const sizeAfter = dirSize(lancedbDir);
    console.log('===RESULT_START===');
    console.log(`EXIT_CODE=${exitCode === null ? '' : exitCode}`);
    console.log(`THREW_OTHER=${threwOther ?? ''}`);
    console.log(`SIZE_BEFORE=${sizeBefore}`);
    console.log(`SIZE_AFTER=${sizeAfter}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT3(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const entry = createWorkspace('t3-free', {}, home);
    // Round E4: a present-but-unlocked graph store, so this control fixture
    // is genuinely "safe" under the round-E4 fix below, not the absent-store
    // shape that fix now (correctly) refuses — see T9/T10 for that case.
    await createAndCloseGraphStore(entry.path, 't3-free');
    const { lancedbDir } = await seedLanceTable(entry.path);
    const sizeBefore = dirSize(lancedbDir);

    const { compactCommand } = await import('../packages/lore/src/cli/commands/compact.js');
    await compactCommand(['t3-free']);

    const sizeAfter = dirSize(lancedbDir);
    console.log('===RESULT_START===');
    console.log(`SIZE_BEFORE=${sizeBefore}`);
    console.log(`SIZE_AFTER=${sizeAfter}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT4(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const entry = createWorkspace('t4-forced', {}, home);
    const { lancedbDir } = await seedLanceTable(entry.path);
    const sizeBefore = dirSize(lancedbDir);

    fs.writeFileSync(path.join(home, 'auth.token'), 'stale-token', 'utf-8');
    const { server } = startRejectingDaemonSync();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port);

    const { compactCommand } = await import('../packages/lore/src/cli/commands/compact.js');
    await compactCommand(['t4-forced', '--force']);
    server.close();

    const sizeAfter = dirSize(lancedbDir);
    console.log('===RESULT_START===');
    console.log(`SIZE_BEFORE=${sizeBefore}`);
    console.log(`SIZE_AFTER=${sizeAfter}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT5(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const entry = createWorkspace('t5-rejected', {}, home);
    const { lancedbDir } = await seedLanceTable(entry.path);
    const sizeBefore = dirSize(lancedbDir);

    fs.writeFileSync(path.join(home, 'auth.token'), 'stale-token', 'utf-8');
    const { server } = startRejectingDaemonSync();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port);

    const { maintainCommand } = await import('../packages/lore/src/cli/commands/maintain.js');
    let exitCode: number | null = null;
    const origExit = process.exit.bind(process);
    process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error('__exit__'); };
    let threwOther: string | null = null;
    try {
        await maintainCommand(['t5-rejected', '--no-node-retention', '--no-ephemeral', '--cleanup-versions-older-than', '0s']);
    } catch (e) {
        if ((e as Error).message !== '__exit__') threwOther = (e as Error).message;
    }
    process.exit = origExit;
    server.close();

    const sizeAfter = dirSize(lancedbDir);
    console.log('===RESULT_START===');
    console.log(`EXIT_CODE=${exitCode === null ? '' : exitCode}`);
    console.log(`THREW_OTHER=${threwOther ?? ''}`);
    console.log(`SIZE_BEFORE=${sizeBefore}`);
    console.log(`SIZE_AFTER=${sizeAfter}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT6(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
    const entry = createWorkspace('t6-locked', {}, home);
    const { lancedbDir } = await seedLanceTable(entry.path);
    const sizeBefore = dirSize(lancedbDir);

    const seeder = new SurrealGraph(entry.path, { workspaceId: 't6-locked' });
    await seeder.initialize();
    await seeder.close();
    const holder = new SurrealGraph(entry.path, { workspaceId: 't6-locked' });
    await holder.initialize();

    const { maintainCommand } = await import('../packages/lore/src/cli/commands/maintain.js');
    // No throw expected — maintain skips (continue) a locked workspace
    // rather than aborting the whole run (relevant for --all).
    await maintainCommand(['t6-locked', '--no-node-retention', '--no-ephemeral', '--cleanup-versions-older-than', '0s']);
    await holder.close();

    const sizeAfter = dirSize(lancedbDir);
    console.log('===RESULT_START===');
    console.log(`SIZE_BEFORE=${sizeBefore}`);
    console.log(`SIZE_AFTER=${sizeAfter}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT7(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const entry = createWorkspace('t7-free', {}, home);
    // Round E4: see childT3's comment — a present-but-unlocked graph store
    // keeps this control fixture "safe" under the round-E4 absent-store fix.
    await createAndCloseGraphStore(entry.path, 't7-free');
    const { lancedbDir } = await seedLanceTable(entry.path);
    const sizeBefore = dirSize(lancedbDir);

    const { maintainCommand } = await import('../packages/lore/src/cli/commands/maintain.js');
    // Capture stderr — the assertion here is "the LanceDB path actually ran
    // (not refused)", not "optimize() reclaims bytes" (that reclaim
    // behavior is the pre-existing maintain engine's own concern, unrelated
    // to this fix — asserting on it here would test something out of
    // scope). --json avoids console.log's per-line progress noise.
    const errLines: string[] = [];
    const origErr = console.error;
    console.error = (msg?: unknown) => { errLines.push(String(msg ?? '')); };
    try {
        await maintainCommand(['t7-free', '--no-node-retention', '--no-ephemeral', '--cleanup-versions-older-than', '0s', '--json']);
    } finally {
        console.error = origErr;
    }

    const sizeAfter = dirSize(lancedbDir);
    console.log('===RESULT_START===');
    console.log(`SIZE_BEFORE=${sizeBefore}`);
    console.log(`SIZE_AFTER=${sizeAfter}`);
    console.log(`STDERR_JOINED=${errLines.join(' | ').replace(/\n/g, ' ')}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT8(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    fs.writeFileSync(path.join(home, 'auth.token'), 'stale-token', 'utf-8');
    const { server } = startRejectingDaemonSync();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    process.env['LORE_PORT'] = String(port);

    const { isDaemonServingHome, otherDaemonRefuseMessage } =
        await import('../packages/lore/src/cli/commands/migrateWorkspaceToWorkspaceShared.js');
    const probe = await isDaemonServingHome(home);
    const msg = otherDaemonRefuseMessage('lore compact');
    server.close();

    console.log('===RESULT_START===');
    console.log(`SERVES_HOME=${probe.servesHome}`);
    console.log(`OTHER_REACHABLE=${probe.otherDaemonReachable}`);
    console.log(`CREDENTIAL_REJECTED=${probe.credentialRejected === true}`);
    console.log(`PORT=${port}`);
    console.log(`MSG=${msg.replace(/\n/g, '\\n')}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT9(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const entry = createWorkspace('t9-absent', {}, home);
    // No SurrealGraph ever opened for this workspace — matches
    // attack2-graph-store-absent.mts's shape: LanceDB data with NO
    // `.lore/surreal/` directory at all, no daemon reachable either.
    const { lancedbDir } = await seedLanceTable(entry.path);
    const mtimesBefore = snapshotMtimes(lancedbDir);

    const { compactCommand } = await import('../packages/lore/src/cli/commands/compact.js');
    const errLines: string[] = [];
    const origErr = console.error;
    console.error = (msg?: unknown) => { errLines.push(String(msg ?? '')); };
    let exitCode: number | null = null;
    const origExit = process.exit.bind(process);
    process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error('__exit__'); };
    let threwOther: string | null = null;
    try {
        await compactCommand(['t9-absent']); // NO --force
    } catch (e) {
        if ((e as Error).message !== '__exit__') threwOther = (e as Error).message;
    }
    process.exit = origExit;
    console.error = origErr;

    const mtimesAfter = snapshotMtimes(lancedbDir);
    console.log('===RESULT_START===');
    console.log(`EXIT_CODE=${exitCode === null ? '' : exitCode}`);
    console.log(`THREW_OTHER=${threwOther ?? ''}`);
    console.log(`MTIMES_EQUAL=${JSON.stringify(mtimesBefore) === JSON.stringify(mtimesAfter)}`);
    console.log(`STDERR_JOINED=${errLines.join(' | ').replace(/\n/g, ' ')}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

async function childT10(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
    const entry = createWorkspace('t10-forced', {}, home);
    const { lancedbDir } = await seedLanceTable(entry.path);
    const sizeBefore = dirSize(lancedbDir);

    const { compactCommand } = await import('../packages/lore/src/cli/commands/compact.js');
    const errLines: string[] = [];
    const origErr = console.error;
    console.error = (msg?: unknown) => { errLines.push(String(msg ?? '')); };
    try {
        await compactCommand(['t10-forced', '--force']);
    } finally {
        console.error = origErr;
    }

    const sizeAfter = dirSize(lancedbDir);
    console.log('===RESULT_START===');
    console.log(`SIZE_BEFORE=${sizeBefore}`);
    console.log(`SIZE_AFTER=${sizeAfter}`);
    console.log(`STDERR_JOINED=${errLines.join(' | ').replace(/\n/g, ' ')}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

/**
 * T11 — real daemon, not a fake HTTP server (round E4 finding, low —
 * T1/T5/T8 all fake the rejected-token response with a hand-rolled 401
 * server; none exercise the real daemon's actual behavior). health.ts's own
 * FINDING 4 / middleware.ts's B1 comment say a stale/garbage Bearer on a
 * PUBLIC path (`/api/health`) falls through to ANONYMOUS (principal=null),
 * returning the LITE body (200, no `loreHome`) rather than a 401.
 */
async function childT11(): Promise<void> {
    const home = process.env['LORE_HOME']!;
    const port = await findFreePort();
    // Set BEFORE any import of migrateWorkspaceToWorkspaceShared.js/compact.js
    // below — DEFAULT_PORT there is `Number(process.env['LORE_PORT'] ?? 3847)`
    // evaluated once at module load (see this file's header note).
    process.env['LORE_PORT'] = String(port);

    const proc = spawn(process.execPath, ['--import', 'tsx', SERVER_ENTRY, '--http'], {
        cwd: repoRoot,
        env: { ...process.env, LORE_HOME: home, LORE_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    proc.stdout.on('data', (c) => { log += c.toString(); });
    proc.stderr.on('data', (c) => { log += c.toString(); });

    async function waitReady(timeoutMs = 20_000): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return true; } catch { /* not up yet */ }
            await new Promise((r) => setTimeout(r, 150));
        }
        return false;
    }

    let realStatus = -1;
    let realHasLoreHome = true;
    let servesHome = true;
    let otherReachable = false;
    let credentialRejected = false;
    let exitCode: number | null = null;
    try {
        const ready = await waitReady();
        if (!ready) throw new Error(`real daemon never became ready:\n${log}`);

        const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
        createWorkspace('t11-real', {}, home);

        // Stale-but-plausible 64-hex Bearer (as if the CLI's cached token
        // predates a daemon restart that rotated auth.token) against the
        // REAL /api/health.
        const staleToken = 'b'.repeat(64);
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
            headers: { Authorization: `Bearer ${staleToken}` },
        });
        const body = (await res.json().catch(() => null)) as { loreHome?: string } | null;
        realStatus = res.status;
        realHasLoreHome = !!body?.loreHome;

        // The CLI's cached auth.token now predates the (simulated) rotation.
        fs.writeFileSync(path.join(home, 'auth.token'), staleToken, 'utf-8');
        const { isDaemonServingHome } = await import('../packages/lore/src/cli/commands/migrateWorkspaceToWorkspaceShared.js');
        const probe = await isDaemonServingHome(home);
        servesHome = probe.servesHome;
        otherReachable = probe.otherDaemonReachable;
        credentialRejected = probe.credentialRejected === true;

        const { compactCommand } = await import('../packages/lore/src/cli/commands/compact.js');
        const origExit = process.exit.bind(process);
        process.exit = (code?: number) => { exitCode = code ?? 0; throw new Error('__exit__'); };
        try {
            await compactCommand(['t11-real']);
        } catch (e) {
            if ((e as Error).message !== '__exit__') throw e;
        } finally {
            process.exit = origExit;
        }
    } finally {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    }

    console.log('===RESULT_START===');
    console.log(`REAL_STATUS=${realStatus}`);
    console.log(`REAL_HAS_LOREHOME=${realHasLoreHome}`);
    console.log(`SERVES_HOME=${servesHome}`);
    console.log(`OTHER_REACHABLE=${otherReachable}`);
    console.log(`CREDENTIAL_REJECTED=${credentialRejected}`);
    console.log(`EXIT_CODE=${exitCode === null ? '' : exitCode}`);
    console.log('===RESULT_END===');
    process.exitCode = 0;
}

/* ───────────────────────────── Orchestrator ────────────────────────────── */

function extractSection(stdout: string, marker: string): string {
    const startTag = '===RESULT_START===';
    const endTag = '===RESULT_END===';
    const startIdx = stdout.indexOf(startTag);
    const endIdx = stdout.indexOf(endTag);
    assert.ok(startIdx !== -1 && endIdx !== -1, `child stdout missing ${startTag}/${endTag} markers:\n${stdout}`);
    const section = stdout.slice(startIdx + startTag.length, endIdx);
    const m = new RegExp(`${marker}=(.*)`).exec(section);
    assert.ok(m, `child stdout missing ${marker}= marker:\n${stdout}`);
    return m![1]!.trim();
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`);
        failed++;
    }
}

function runChild(name: string, timeoutMs = 30_000): { stdout: string; status: number | null } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `lore-compact-maintain-otherdaemon-${name}-`));
    const { LORE_PORT: _unused, ...restEnv } = process.env;
    const result = spawnSync(tsxBin, [selfPath, '--child', name], {
        env: { ...restEnv, LORE_HOME: home },
        encoding: 'utf-8',
        timeout: timeoutMs,
    });
    assert.equal(result.status, 0, `child ${name} failed (status=${result.status}):\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return { stdout: result.stdout, status: result.status };
}

async function main(): Promise<void> {
    console.log('lore compact / lore maintain: otherDaemonReachable is "not proven safe", not "safe to proceed"');

    await test('T1: lore compact refuses (no optimize) when a process on LORE_PORT rejects the CLI token (401)', async () => {
        const { stdout } = runChild('t1');
        const exitCode = extractSection(stdout, 'EXIT_CODE');
        const threwOther = extractSection(stdout, 'THREW_OTHER');
        const sizeBefore = Number(extractSection(stdout, 'SIZE_BEFORE'));
        const sizeAfter = Number(extractSection(stdout, 'SIZE_AFTER'));
        assert.equal(threwOther, '', `compactCommand must not throw anything other than the exit shim: ${threwOther}`);
        assert.equal(exitCode, '1', 'compactCommand must exit(1) when the token was rejected');
        assert.equal(sizeAfter, sizeBefore, 'no optimize() must have run — lancedb dir size must be unchanged');
    });

    await test('T2: lore compact refuses (no optimize) when no daemon answers LORE_PORT but the workspace graph store is genuinely held', async () => {
        const { stdout } = runChild('t2');
        const exitCode = extractSection(stdout, 'EXIT_CODE');
        const sizeBefore = Number(extractSection(stdout, 'SIZE_BEFORE'));
        const sizeAfter = Number(extractSection(stdout, 'SIZE_AFTER'));
        assert.equal(exitCode, '1', 'compactCommand must exit(1) while the graph store is held');
        assert.equal(sizeAfter, sizeBefore, 'no optimize() must have run — lancedb dir size must be unchanged');
    });

    await test('T3 (control): lore compact proceeds and shrinks the lancedb dir when no daemon and no holder are present', async () => {
        const { stdout } = runChild('t3');
        const sizeBefore = Number(extractSection(stdout, 'SIZE_BEFORE'));
        const sizeAfter = Number(extractSection(stdout, 'SIZE_AFTER'));
        assert.ok(sizeAfter < sizeBefore, `expected compact to shrink the dir: before=${sizeBefore}B after=${sizeAfter}B`);
    });

    await test('T4: lore compact --force bypasses both layers even against a rejected token', async () => {
        const { stdout } = runChild('t4');
        const sizeBefore = Number(extractSection(stdout, 'SIZE_BEFORE'));
        const sizeAfter = Number(extractSection(stdout, 'SIZE_AFTER'));
        assert.ok(sizeAfter < sizeBefore, '--force must still let compaction run despite the rejected token');
    });

    await test('T5: lore maintain (LanceDB-only) refuses when a process on LORE_PORT rejects the CLI token (401)', async () => {
        const { stdout } = runChild('t5');
        const exitCode = extractSection(stdout, 'EXIT_CODE');
        const threwOther = extractSection(stdout, 'THREW_OTHER');
        const sizeBefore = Number(extractSection(stdout, 'SIZE_BEFORE'));
        const sizeAfter = Number(extractSection(stdout, 'SIZE_AFTER'));
        assert.equal(threwOther, '', `maintainCommand must not throw anything other than the exit shim: ${threwOther}`);
        assert.equal(exitCode, '1', 'maintainCommand must exit(1) when the token was rejected');
        assert.equal(sizeAfter, sizeBefore, 'no lancedb compaction must have run');
    });

    await test('T6: lore maintain (LanceDB-only) skips a workspace whose graph store is genuinely held, with no daemon reachable', async () => {
        const { stdout } = runChild('t6');
        const sizeBefore = Number(extractSection(stdout, 'SIZE_BEFORE'));
        const sizeAfter = Number(extractSection(stdout, 'SIZE_AFTER'));
        assert.equal(sizeAfter, sizeBefore, 'no lancedb compaction must have run against a locked workspace');
    });

    await test('T7 (control): lore maintain (LanceDB-only) proceeds (not refused) when no daemon and no holder are present', async () => {
        // Asserts the fix does not over-block the common case — NOT that
        // optimize() reclaims bytes, which is the pre-existing maintain
        // engine's own concern (see childT7's comment) and unrelated to
        // this fix's otherDaemonReachable / probeSurrealLock gates.
        const { stdout } = runChild('t7');
        const stderrJoined = extractSection(stdout, 'STDERR_JOINED');
        assert.doesNotMatch(stderrJoined, /locked by another process/i, `expected no lock refusal, got: ${stderrJoined}`);
        assert.doesNotMatch(stderrJoined, /rejected this CLI token/i, `expected no daemon refusal, got: ${stderrJoined}`);
        assert.doesNotMatch(stderrJoined, /no graph store to probe/i, `expected no absent-store refusal (fixture has a real, unlocked store), got: ${stderrJoined}`);
    });

    await test('T8: the otherDaemonReachable refusal reports credentialRejected and the message says "rejected", not "reports a different home"', async () => {
        const { stdout } = runChild('t8');
        const servesHome = extractSection(stdout, 'SERVES_HOME');
        const otherReachable = extractSection(stdout, 'OTHER_REACHABLE');
        const credentialRejected = extractSection(stdout, 'CREDENTIAL_REJECTED');
        const port = extractSection(stdout, 'PORT');
        const msg = extractSection(stdout, 'MSG');
        assert.equal(servesHome, 'false');
        assert.equal(otherReachable, 'true');
        assert.equal(credentialRejected, 'true', 'a 401 must be flagged as a rejected credential, not a confirmed different home');
        assert.match(msg, new RegExp(`port ${port}`));
        assert.match(msg, /rejected this CLI token/i);
        assert.doesNotMatch(msg, /different home/i, `must not claim a different home when the daemon only rejected our credential: ${msg}`);
    });

    await test('T9: lore compact refuses (no optimize, lancedb file mtimes unchanged) when the workspace has lancedb data but no graph store directory at all', async () => {
        const { stdout } = runChild('t9');
        const exitCode = extractSection(stdout, 'EXIT_CODE');
        const threwOther = extractSection(stdout, 'THREW_OTHER');
        const mtimesEqual = extractSection(stdout, 'MTIMES_EQUAL');
        const stderrJoined = extractSection(stdout, 'STDERR_JOINED');
        assert.equal(threwOther, '', `compactCommand must not throw anything other than the exit shim: ${threwOther}`);
        assert.equal(exitCode, '1', 'compactCommand must exit(1) when the graph store directory is absent');
        assert.equal(mtimesEqual, 'true', 'no optimize() must have run — every lancedb file mtime must be unchanged');
        assert.match(stderrJoined, /no graph store to probe/i, `expected the absent-graph-store refusal message, got: ${stderrJoined}`);
    });

    await test('T10: lore compact --force bypasses the absent-graph-store refusal, proceeds, and prints the bypass notice', async () => {
        const { stdout } = runChild('t10');
        const sizeBefore = Number(extractSection(stdout, 'SIZE_BEFORE'));
        const sizeAfter = Number(extractSection(stdout, 'SIZE_AFTER'));
        const stderrJoined = extractSection(stdout, 'STDERR_JOINED');
        assert.ok(sizeAfter < sizeBefore, '--force must still let compaction run despite the absent graph store');
        assert.match(stderrJoined, /proceeding with --force; daemon\/lock checks skipped/, `expected the --force bypass notice, got: ${stderrJoined}`);
    });

    await test('T11: against a REAL spawned daemon, a stale-but-plausible Bearer gets the anonymous/lite /api/health body (not 401), isDaemonServingHome reports credentialRejected, and lore compact refuses', async () => {
        const { stdout } = runChild('t11', 60_000); // real daemon boot is slower than the other, fully in-process cases
        const realStatus = extractSection(stdout, 'REAL_STATUS');
        const realHasLoreHome = extractSection(stdout, 'REAL_HAS_LOREHOME');
        const servesHome = extractSection(stdout, 'SERVES_HOME');
        const otherReachable = extractSection(stdout, 'OTHER_REACHABLE');
        const credentialRejected = extractSection(stdout, 'CREDENTIAL_REJECTED');
        const exitCode = extractSection(stdout, 'EXIT_CODE');
        assert.equal(realStatus, '200', 'a stale-but-plausible Bearer on the public /api/health path must fall through to anonymous (200), not 401 — see health.ts FINDING 4 / middleware.ts B1');
        assert.equal(realHasLoreHome, 'false', 'the anonymous/lite body must carry no loreHome field');
        assert.equal(servesHome, 'false');
        assert.equal(otherReachable, 'true');
        assert.equal(credentialRejected, 'true', 'isDaemonServingHome must flag this as a rejected credential against the REAL daemon response shape');
        assert.equal(exitCode, '1', 'lore compact must refuse against the real daemon + stale token');
    });

    if (failed > 0) {
        console.error(`\n${failed} test(s) failed, ${passed} passed`);
        process.exit(1);
    }
    console.log(`\nall ${passed} tests passed`);
}

/* ────────────────────────────── Dispatch ───────────────────────────────── */

const childIdx = process.argv.indexOf('--child');
if (childIdx !== -1) {
    const which = process.argv[childIdx + 1];
    const CHILDREN: Record<string, () => Promise<void>> = {
        t1: childT1, t2: childT2, t3: childT3, t4: childT4,
        t5: childT5, t6: childT6, t7: childT7, t8: childT8,
        t9: childT9, t10: childT10, t11: childT11,
    };
    const fn = which ? CHILDREN[which] : undefined;
    if (!fn) { console.error(`unknown --child ${which}`); process.exit(2); }
    await fn();
} else {
    await main();
}
