#!/usr/bin/env node
/**
 * scripts/diagnostics/e2e-10-workspace.mjs — Sprint step 5, real end-to-end:
 * boots a REAL http daemon (own temp LORE_HOME + own port, TS source via
 * `--import tsx`, never touching the machine's :3847/:8847 daemons), opens
 * 10 workspaces with ~50 embedded entries each, forces the new verbatim
 * idle-sweep (LORE_VERBATIM_IDLE_TTL_MS/LORE_VERBATIM_SWEEP_MS) and the
 * existing graph-registry idle-sweep (LORE_REGISTRY_IDLE_TTL_MS/
 * LORE_REGISTRY_SWEEP_MS) to run within minutes, and records RSS/vmmap/fd
 * metrics at 5 checkpoints:
 *
 *   1. baseline            — daemon up, no workspace opened beyond boot.
 *   2. after-10-open       — all 10 workspaces written + searched.
 *   3. after-sweep         — traffic stopped, waited past TTL + 2 sweeps.
 *   4. after-reopen        — one evicted workspace searched again.
 *   5. after-shutdown      — SIGTERM sent; exit code + leftover-handle check.
 *
 * Run with `--search-worker 1` to repeat under LORE_SEARCH_WORKER=1
 * (out-of-process search); default is in-process search.
 *
 * MEASUREMENT ONLY. Nothing here edits packages/lore/src/**.
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), '..', '..');

// Self re-exec with `--import tsx` (same pattern as the other scripts under
// scripts/diagnostics/) so the orchestrator's own dynamic `import()` of TS
// source (packages/lore/src/auth/tokens.ts, to mint the harness's
// cross-workspace admin token) resolves without a dist/ build.
if (!process.env.__E2E_10WS_REEXEC) {
    const res = spawnSync(
        process.execPath,
        ['--import', 'tsx', SELF, ...process.argv.slice(2)],
        { stdio: 'inherit', cwd: REPO_ROOT, env: { ...process.env, __E2E_10WS_REEXEC: '1' } },
    );
    process.exit(res.status ?? 1);
}

const argv = process.argv.slice(2);
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
};
const SEARCH_WORKER = argOf('--search-worker', '0'); // '0' | '1'
const PORT = Number.parseInt(argOf('--port', '18847'), 10);
const TTL_MS = Number.parseInt(argOf('--ttl-ms', '60000'), 10);
const SWEEP_MS = Number.parseInt(argOf('--sweep-ms', '15000'), 10);
const WORKSPACES_N = Number.parseInt(argOf('--workspaces', '10'), 10);
const ENTRIES_PER_WS = Number.parseInt(argOf('--entries', '50'), 10);
const JSON_OUT = argOf('--json', null);
const LOG_DIR = argOf('--log-dir', path.join(os.tmpdir(), 'lore-e2e-logs'));

const MB = 1024 * 1024;
const toMb = (b) => b / MB;

function log(msg) { console.log(`[e2e-10ws] ${new Date().toISOString()} ${msg}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function vmmapFootprintMb(pid) {
    if (process.platform !== 'darwin') return null;
    try {
        const out = execFileSync('vmmap', ['--summary', String(pid)], {
            encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        const m = /Physical footprint:\s+([\d.]+)([KMG])/.exec(out);
        if (!m) return null;
        const value = Number.parseFloat(m[1]);
        const mult = m[2] === 'G' ? 1024 : m[2] === 'K' ? 1 / 1024 : 1;
        return value * mult;
    } catch { return null; }
}

function rssKb(pid) {
    try {
        const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        return out ? Number.parseInt(out, 10) : null;
    } catch { return null; }
}

function lsofLines(pid) {
    try {
        return execFileSync('lsof', ['-p', String(pid)], {
            encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
        }).split('\n');
    } catch { return []; }
}

function lsofPlusD(dir) {
    try {
        return execFileSync('lsof', ['+D', dir], {
            encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch (e) {
        // lsof exits non-zero (and prints nothing) when NOTHING has the dir open —
        // that is the success case, not a failure to distinguish from.
        return '';
    }
}

function childPids(parentPid) {
    try {
        return execFileSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' })
            .split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { return []; } // pgrep exits 1 with no output when there are no matches
}

function pidAlive(pid) {
    try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

/** Sample process-level metrics: RSS, vmmap, fd counts, per-substrate fd counts. */
function sampleProcess(pid, loreHome) {
    const rk = rssKb(pid);
    const vm = vmmapFootprintMb(pid);
    // Under LORE_SEARCH_WORKER=1, each opened workspace's
    // VerbatimSearchWorkerProxy forks its own out-of-process search worker
    // (engines/verbatimSearchWorkerProxy.ts `fork(entry, ...)`) as a direct
    // child of the daemon pid. Counting them here (default run: expect 0,
    // always) lets a checkpoint show open-store count and worker-process
    // count moving together, and confirms workers get reaped on eviction.
    const searchWorkerChildren = childPids(pid).length;
    const lines = lsofLines(pid);
    const totalFds = lines.length > 1 ? lines.length - 1 : 0; // minus header
    let graphFds = 0, lanceFds = 0;
    const graphDirs = new Set();
    const lanceDirs = new Set();
    for (const line of lines) {
        const l = line.toLowerCase();
        // Current on-disk name is `.lore/surreal/` (CLAUDE.md); `.lore/graph/`
        // is checked too since openWorkspaceGraph.ts treats it as the
        // pre-rename legacy layout — matching both is a harmless superset.
        if (l.includes(`${loreHome}/workspaces`.toLowerCase()) && /\.lore\/(surreal|graph)/.test(l)) {
            graphFds++;
            const m = /workspaces\/([^/]+)\/\.lore\/(?:surreal|graph)/i.exec(line);
            if (m) graphDirs.add(m[1]);
        }
        if (l.includes(`${loreHome}/workspaces`.toLowerCase()) && l.includes('/.lore/lancedb')) {
            lanceFds++;
            const m = /workspaces\/([^/]+)\/\.lore\/lancedb/i.exec(line);
            if (m) lanceDirs.add(m[1]);
        }
    }
    return {
        rssMb: rk == null ? null : rk / 1024,
        vmmapFootprintMb: vm,
        totalFds,
        graphFds, lanceFds,
        graphOpenWorkspacesByFd: [...graphDirs].sort(),
        lanceOpenWorkspacesByFd: [...lanceDirs].sort(),
        searchWorkerChildren,
    };
}

async function httpJson(base, token, urlPath, opts = {}) {
    const headers = { ...(opts.headers ?? {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    let body;
    if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${base}${urlPath}`, { method: opts.method ?? 'GET', headers, body });
    const text = await res.text();
    let parsed = text;
    if (text.length > 0) { try { parsed = JSON.parse(text); } catch { /* leave as text */ } }
    return { status: res.status, body: parsed };
}

async function sampleHealth(base, token) {
    try {
        const r = await httpJson(base, token, '/api/health');
        if (r.status !== 200) return { error: `status ${r.status}`, raw: r.body };
        const b = r.body;
        return {
            scanned: b.workspaces?.scanned ?? null,
            measuredCount: b.workspaces?.measuredCount ?? null,
            knownCount: b.workspaces?.knownCount ?? null,
            // docs/PERFORMANCE-MEMORY.md §11 — WorkspaceVerbatimResolver's own
            // open-store count (health.ts `workspaces.verbatimResolverOpenCount`,
            // added 28263f51). Recorded alongside measuredCount at every
            // checkpoint so verbatim-store idle eviction can be observed
            // directly instead of inferred from RSS/lsof (unreliable for
            // LanceDB — see §11.3).
            verbatimResolverOpenCount: b.workspaces?.verbatimResolverOpenCount ?? null,
            globalTotals: b.workspaces?.globalTotals ?? null,
            outboxDepth: b.outbox?.depth ?? null,
            outboxPerWorkspace: b.outbox?.perWorkspace ?? null,
        };
    } catch (e) {
        return { error: String(e?.message ?? e) };
    }
}

async function checkpoint(label, ctx) {
    const proc = sampleProcess(ctx.pid, ctx.loreHome);
    const health = await sampleHealth(ctx.base, ctx.token);
    // bootElapsedMs — wall-clock since the daemon became ready, so a
    // checkpoint's position relative to the T+60s retention-sweep bootstrap
    // (mcp/retentionScheduler.ts LORE_RETENTION_FIRST_FIRE_MS, default 60000)
    // is directly visible in the result JSON, not just inferable from `at`.
    const bootElapsedMs = ctx.bootAt ? Date.now() - ctx.bootAt : null;
    const cp = { label, at: new Date().toISOString(), bootElapsedMs, pid: ctx.pid, proc, health };
    ctx.checkpoints.push(cp);
    log(`checkpoint ${label}: bootElapsedMs=${bootElapsedMs} rss=${proc.rssMb?.toFixed(1)}MB vmmap=${proc.vmmapFootprintMb == null ? 'n/a' : proc.vmmapFootprintMb.toFixed(1) + 'MB'} totalFds=${proc.totalFds} graphFds=${proc.graphFds}(${proc.graphOpenWorkspacesByFd.length} ws) lanceFds=${proc.lanceFds}(${proc.lanceOpenWorkspacesByFd.length} ws) searchWorkerChildren=${proc.searchWorkerChildren} registry.scanned=${health.scanned} registry.measuredCount=${health.measuredCount} verbatimResolverOpenCount=${health.verbatimResolverOpenCount} outboxDepth=${health.outboxDepth}`);
    return cp;
}

function makeNodes(wsIdx, wsName, n) {
    const nodes = [];
    for (let i = 0; i < n; i++) {
        const id = `e2e-${wsName}-${i}`;
        nodes.push({
            id, type: 'note', label: id,
            content: `e2e-10-workspace harness entry ${i} for workspace ${wsName} (index ${wsIdx}). needle-phrase-${wsIdx} appears exactly once per workspace as the searchable anchor. lorem ipsum dolor sit amet.`,
            tags: 'e2e-10-workspace-harness',
            project: wsName,
        });
    }
    return nodes;
}

async function waitForOutboxDrain(base, token, wsName, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const h = await sampleHealth(base, token);
        const depth = h.outboxPerWorkspace?.[wsName]?.depth;
        if (depth === 0 || depth === undefined) return true;
        await sleep(500);
    }
    return false;
}

async function searchFindsNeedle(base, token, wsName, wsIdx, tries = 6) {
    const needle = `needle-phrase-${wsIdx}`;
    for (let i = 0; i < tries; i++) {
        const r = await httpJson(base, token, `/api/recall?topic=${encodeURIComponent(needle)}&workspace=${encodeURIComponent(wsName)}&max=5`);
        if (r.status === 200) {
            const text = JSON.stringify(r.body);
            if (text.includes(needle) || text.includes(`e2e-${wsName}-`)) return { found: true, attempt: i, body: r.body };
        }
        await sleep(1000);
    }
    return { found: false };
}

async function runOnce() {
    const loreHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-e2e-home-'));
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const label = `search-worker-${SEARCH_WORKER}`;
    const stdoutLog = path.join(LOG_DIR, `e2e-${label}-stdout.log`);
    const stderrLog = path.join(LOG_DIR, `e2e-${label}-stderr.log`);
    const outFd = fs.openSync(stdoutLog, 'a');
    const errFd = fs.openSync(stderrLog, 'a');

    log(`LORE_HOME=${loreHome} port=${PORT} ttl=${TTL_MS} sweep=${SWEEP_MS} searchWorker=${SEARCH_WORKER}`);
    log(`daemon logs -> ${stdoutLog} / ${stderrLog}`);

    // Mint a cross-workspace admin token BEFORE the daemon boots, by writing
    // registry.json directly (issueToken is a pure fs operation keyed off
    // process.env.LORE_HOME). Writing it before boot means the daemon's
    // first (lazy) registry read picks it up fresh — no in-process cache to
    // invalidate. Without this, the daemon's own bootstrap `auth.token` is
    // scoped to workspace "default" only and every write to the 10 harness
    // workspaces below would 403 with workspace_forbidden (the V3 per-
    // workspace isolation guarantee — see test/L6-consistency-proof.ts).
    const prevLoreHome = process.env.LORE_HOME;
    process.env.LORE_HOME = loreHome;
    const { issueToken, ALL_SCOPES } = await import(path.join(REPO_ROOT, 'packages/lore/src/auth/tokens.ts'));
    const { token: adminToken } = issueToken({
        workspace: 'default',
        label: 'e2e-10-workspace-harness-admin',
        scopes: [...ALL_SCOPES],
        admin: true,
    });
    if (prevLoreHome === undefined) delete process.env.LORE_HOME; else process.env.LORE_HOME = prevLoreHome;
    log('minted cross-workspace admin token for harness use');

    const env = {
        ...process.env,
        LORE_HOME: loreHome,
        LORE_PORT: String(PORT),
        LORE_VERBATIM_IDLE_TTL_MS: String(TTL_MS),
        LORE_VERBATIM_SWEEP_MS: String(SWEEP_MS),
        LORE_REGISTRY_IDLE_TTL_MS: String(TTL_MS),
        LORE_REGISTRY_SWEEP_MS: String(SWEEP_MS),
        LORE_TELEMETRY_OPT_OUT: '1',
    };
    if (SEARCH_WORKER === '1') env.LORE_SEARCH_WORKER = '1';
    else delete env.LORE_SEARCH_WORKER;

    const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO_ROOT, 'packages/lore/src/mcp/server.ts'), '--http'], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', outFd, errFd],
    });
    const pid = child.pid;
    log(`spawned daemon pid=${pid}`);

    // Safety net: if ANYTHING below throws (a route contract surprise, a
    // timeout, a bad assumption), this must not leak a daemon process still
    // bound to PORT — that stale process silently "answers" the NEXT run's
    // readiness probe with a different LORE_HOME/token registry, which is
    // exactly the bug this comment is here to prevent a repeat of (an
    // earlier draft of this script leaked pid 38444 across 4 runs this way).
    try {
        return await runWorkload({ child, pid, loreHome, adminToken, label, stdoutLog, stderrLog, outFd, errFd });
    } catch (err) {
        log(`workload threw: ${err?.stack ?? err}; force-killing daemon pid=${pid}`);
        if (pidAlive(pid)) { try { child.kill('SIGKILL'); } catch { /* best-effort */ } }
        try { fs.closeSync(outFd); } catch { /* already closed */ }
        try { fs.closeSync(errFd); } catch { /* already closed */ }
        throw err;
    }
}

async function runWorkload({ child, pid, loreHome, adminToken, label, stdoutLog, stderrLog, outFd, errFd }) {
    const base = `http://127.0.0.1:${PORT}`;
    let exitInfo = null;
    child.on('exit', (code, signal) => { exitInfo = { code, signal, at: new Date().toISOString() }; });

    // Wait for readiness.
    const readyDeadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < readyDeadline) {
        if (exitInfo) throw new Error(`daemon exited early: ${JSON.stringify(exitInfo)}`);
        try {
            const r = await fetch(`${base}/health`);
            if (r.status === 200) { ready = true; break; }
        } catch { /* not up yet */ }
        await sleep(500);
    }
    if (!ready) throw new Error('daemon did not become ready within 60s');
    log('daemon ready');

    const token = adminToken;
    const ctx = { pid, base, token, loreHome, checkpoints: [], bootAt: Date.now() };

    // ---- Checkpoint 1: baseline ----
    await checkpoint('1-baseline', ctx);

    // ---- Create + populate + search 10 workspaces ----
    const wsNames = [];
    for (let i = 0; i < WORKSPACES_N; i++) {
        const wsName = `e2e-ws-${i}`;
        wsNames.push(wsName);
        const create = await httpJson(base, token, '/api/workspaces', { method: 'POST', body: { name: wsName, label: `e2e harness ${i}` } });
        if (![200, 201, 400, 409].includes(create.status)) {
            throw new Error(`workspace create ${wsName} failed: ${create.status} ${JSON.stringify(create.body)}`);
        }
        const nodes = makeNodes(i, wsName, ENTRIES_PER_WS);
        const write = await httpJson(base, token, '/api/nodes/bulk', { method: 'POST', body: { workspace: wsName, nodes } });
        if (write.status !== 200) throw new Error(`bulk write ${wsName} failed: ${write.status} ${JSON.stringify(write.body)}`);
        const drained = await waitForOutboxDrain(base, token, wsName, 30000);
        const found = await searchFindsNeedle(base, token, wsName, i);
        log(`workspace ${wsName}: wrote ${ENTRIES_PER_WS} entries, outboxDrained=${drained}, searchFound=${found.found}`);
        if (!found.found) log(`  WARNING: needle-phrase-${i} not found via /api/recall for ${wsName} after retries`);
    }

    // ---- Checkpoint 2: after all 10 open ----
    await checkpoint('2-after-10-open', ctx);

    // ---- Stop traffic; wait past TTL + 2 sweeps ----
    const waitMs = TTL_MS + 2 * SWEEP_MS + 5000;
    log(`stopping traffic; waiting ${waitMs}ms (TTL ${TTL_MS} + 2*sweep ${SWEEP_MS} + 5s margin) for idle eviction...`);
    await sleep(waitMs);

    // ---- Checkpoint 3: after sweep ----
    await checkpoint('3-after-sweep', ctx);

    // ---- Reopen one workspace by searching it; confirm data found ----
    const reopenIdx = 0;
    const reopenWs = wsNames[reopenIdx];
    const reopenResult = await searchFindsNeedle(base, token, reopenWs, reopenIdx, 10);
    log(`reopen ${reopenWs}: found=${reopenResult.found}`);
    ctx.reopenResult = { workspace: reopenWs, ...reopenResult };

    // ---- Checkpoint 4: after reopen ----
    await checkpoint('4-after-reopen', ctx);

    // ---- Graceful shutdown ----
    const preShutdownLsof = lsofLines(pid);
    const preShutdownChildren = childPids(pid);
    log(`pre-shutdown: ${preShutdownLsof.length - 1} open fds, children=[${preShutdownChildren.join(',')}]`);

    log('sending SIGTERM...');
    const shutdownStart = Date.now();
    child.kill('SIGTERM');
    const exitDeadline = Date.now() + 20000;
    while (!exitInfo && Date.now() < exitDeadline) await sleep(200);
    const shutdownMs = Date.now() - shutdownStart;

    let childrenStillAlive = [];
    if (preShutdownChildren.length > 0) {
        await sleep(500); // brief grace period for children to follow parent down
        childrenStillAlive = preShutdownChildren.filter(pidAlive);
    }
    await sleep(300); // let the OS release fds/locks
    const lockFilesHeld = lsofPlusD(loreHome);

    const shutdown = {
        exitInfo, shutdownMs,
        preShutdownTotalFds: preShutdownLsof.length > 1 ? preShutdownLsof.length - 1 : 0,
        preShutdownChildren,
        childrenStillAliveAfterExit: childrenStillAlive,
        lockFilesHeldAfterExit: lockFilesHeld,
        loreHome,
    };
    log(`shutdown: exitInfo=${JSON.stringify(exitInfo)} shutdownMs=${shutdownMs} childrenStillAlive=[${childrenStillAlive.join(',')}] lockFilesHeld=${lockFilesHeld ? 'YES (see raw)' : 'none'}`);

    fs.closeSync(outFd); fs.closeSync(errFd);

    return { label, ttlMs: TTL_MS, sweepMs: SWEEP_MS, workspacesN: WORKSPACES_N, entriesPerWs: ENTRIES_PER_WS, loreHome, port: PORT, checkpoints: ctx.checkpoints, reopenResult: ctx.reopenResult, shutdown, stdoutLog, stderrLog };
}

async function main() {
    const result = await runOnce();
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify(result, null, 2));
    if (JSON_OUT) {
        fs.writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
        console.log(`\n[e2e-10ws] wrote ${JSON_OUT}`);
    }
    // Clean up the harness's own temp LORE_HOME (the daemon that owned it
    // has already exited via the graceful-shutdown step above).
    try { fs.rmSync(result.loreHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

main().catch((err) => {
    console.error('[e2e-10ws] fatal:', err);
    process.exit(1);
});
