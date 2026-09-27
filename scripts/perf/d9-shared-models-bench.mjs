// scripts/perf/d9-shared-models-bench.mjs — D9 §6 "measure" (Lore 3.24,
// slice C3b): does the shared local model server actually help?
//
// Spins up 4 REAL hosts running the COMPILED package (the way Atlas, MIRA
// and PM Helper run it — plain `node`, no tsx, no ts-node) against the same
// LORE_HOME, each with its own dataDir. Every host bulk-ingests the same
// ~300-note deterministic corpus and runs 60 recalls (rerank ON, per-call
// `rerank: true`, the same mechanism test/d8-rerank-e2e.ts uses) from a
// fixed query list, then holds idle so RSS can be sampled.
//
// Scenario A: LORE_MODEL_SERVER=1 (shared) — all 4 hosts should share one
//   `lore-models` server process.
// Scenario B: LORE_MODEL_SERVER=0 (in-process) — each host loads its own
//   copy of both models.
//
// Each scenario runs 3 times, alternating A,B,A,B,A,B, and this script
// reports medians for: summed idle RSS (host+server), recall latency
// p50/p90, rerank busy/timeout rate, first-call latency, and the A-vs-B
// delta in MB/%.
//
// This is a MEASUREMENT script, not a test — it is deliberately NOT wired
// into `npm test` (build-rules-324.md's "every new test joins the test
// chain" rule does not apply to a one-off bench). It does not tune or gate
// anything: see the "no tuning" note in the results doc.
//
// Run (from the repo root, Node 22):
//   node scripts/perf/d9-shared-models-bench.mjs
//
// Inputs (env, both optional):
//   LORE_TEST_RERANK_MODEL_DIR — a local `<cache>/Xenova/ms-marco-MiniLM-L-6-v2`
//     directory to copy the re-rank model from (same variable the tests use,
//     see test/helpers/rerank-model-fixture.ts). Unset → the compiled CLI's
//     `lore models fetch-rerank` fetches it once into a seed home (network).
//   BENCH_OUT_DIR — where raw per-run JSON and temp homes go
//     (default: a fresh dir under os.tmpdir()).
//
// Writes:
//   docs/perf/D9-shared-models-RESULTS.md — the report
//   <BENCH_OUT_DIR>/run-<A|B><n>.json      — raw per-run JSON
//
// Style follows scripts/perf/embed-baseline.mjs (plain probe script, no
// framework) and scripts/measure-memory-configs.mjs (ps-based RSS sampling,
// deterministic fixtures, heavily commented rationale).

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOG_DIR = process.env.BENCH_OUT_DIR
    ? path.resolve(process.env.BENCH_OUT_DIR)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'lore-d9-bench-'));
const RERANK_MODEL_ID = 'Xenova/ms-marco-MiniLM-L-6-v2';
// Seed LORE_HOME holding only the re-rank model; each run clones it.
const SEED_HOME = path.join(LOG_DIR, 'seed-home');
const DIST_DIR = path.join(REPO_ROOT, '.bench-dist');
const RESULTS_DOC = path.join(REPO_ROOT, 'docs', 'perf', 'D9-shared-models-RESULTS.md');

const NPX = path.join(path.dirname(process.execPath), 'npx');

const CORPUS_SIZE = 300;
const RECALLS_PER_HOST = 60;
const HOSTS_PER_SCENARIO = 4;
const SCENARIO_ORDER = ['A', 'B', 'A', 'B', 'A', 'B'];

// ─── deterministic fixture data (identical across every host/run/scenario) ─

const TOPICS = [
    'authentication', 'caching', 'rate limiting', 'database migration', 'webhook delivery',
    'vector search', 'graph traversal', 'backup restore', 'encryption at rest', 'log redaction',
    'model deployment', 'job scheduling', 'index maintenance', 'data compression', 'replication lag',
    'session lifecycle', 'access control', 'error handling', 'connection pooling', 'metrics export',
];
const QUERIES = TOPICS.map((t) => `How does the system handle ${t}?`);

function corpusNote(i) {
    const topic = TOPICS[i % TOPICS.length];
    return `Note ${i}: this record documents ${topic} behavior, configuration defaults, and ` +
        `failure modes observed in the system for case ${i}. Related subsystems interact with ` +
        `${topic} during normal operation and during recovery, and operators should check this ` +
        `note before changing ${topic} settings.`;
}

// ─── machine info ──────────────────────────────────────────────────────

function machineInfo() {
    let chip = 'unknown';
    try { chip = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(); } catch { /* non-mac */ }
    return {
        chip,
        cpus: os.cpus().length,
        totalMemGB: Math.round(os.totalmem() / (1024 ** 3)),
        platform: `${os.platform()} ${os.release()}`,
        node: process.version,
    };
}

// ─── build: compile the package into the worktree, plain tsc + tsc-alias ──
// Mirrors test/model-server-dist-spawn-unit.ts exactly — real hosts run the
// compiled dist with plain node, not tsx, so this must too.

function buildDist() {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    const build = spawnSync(NPX, ['tsc', '--outDir', DIST_DIR], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 600_000 });
    if (build.status !== 0) throw new Error(`tsc build failed:\n${build.stdout}\n${build.stderr}`);
    const alias = spawnSync(NPX, ['tsc-alias', '--outDir', DIST_DIR], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 });
    if (alias.status !== 0) throw new Error(`tsc-alias failed:\n${alias.stdout}\n${alias.stderr}`);
}

// ─── temp LORE_HOME per run ────────────────────────────────────────────
// A seed home carrying the re-rank model is prepared once (copied from
// LORE_TEST_RERANK_MODEL_DIR, or fetched by the compiled CLI), then cloned
// per run with cp -Rc (copy-on-write on APFS). The e5-small embedding model
// is NOT in the seed — it is resolved from the legacy
// @huggingface/transformers cache in node_modules on first use, same as the
// tests. The `.complete` marker is required by rerankModelCached().

function prepareSeedHome() {
    fs.rmSync(SEED_HOME, { recursive: true, force: true });
    fs.mkdirSync(SEED_HOME, { recursive: true });
    const dest = path.join(SEED_HOME, 'models', ...RERANK_MODEL_ID.split('/'));
    const src = process.env.LORE_TEST_RERANK_MODEL_DIR;
    if (src) {
        if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`LORE_TEST_RERANK_MODEL_DIR=${src} is not a directory`);
        fs.mkdirSync(dest, { recursive: true });
        execFileSync('cp', ['-Rc', `${src}/.`, `${dest}/`]);
        fs.writeFileSync(path.join(dest, '.complete'), '');
        return;
    }
    const cliPath = path.join(DIST_DIR, 'lore', 'src', 'cli', 'index.js');
    const run = spawnSync(process.execPath, [cliPath, 'models', 'fetch-rerank'], {
        env: { ...process.env, LORE_HOME: SEED_HOME }, encoding: 'utf8', timeout: 600_000,
    });
    if (run.status !== 0) throw new Error(`lore models fetch-rerank failed:\n${run.stdout}\n${run.stderr}`);
    if (!fs.existsSync(path.join(dest, '.complete'))) throw new Error(`fetch-rerank did not leave ${dest}/.complete`);
}

function makeTempHome(tag) {
    const home = fs.mkdtempSync(path.join(LOG_DIR, `tmp-home-${tag}-`));
    execFileSync('cp', ['-Rc', `${SEED_HOME}/.`, `${home}/`]);
    return home;
}

// ─── host driver — plain ESM, run by plain node against the compiled dist ─

function driverSource() {
    return `
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
const DIST = process.env.__DIST_DIR;
const { createLore } = await import(DIST + '/lore/src/mcp/server.js');
const { serverKey, pidPath } = await import(DIST + '/lore/src/modelServer/paths.js');

const TOPICS = ${JSON.stringify(TOPICS)};
const QUERIES = ${JSON.stringify(QUERIES)};
const CORPUS_SIZE = ${CORPUS_SIZE};
const RECALLS = ${RECALLS_PER_HOST};

function corpusNote(i) {
    const topic = TOPICS[i % TOPICS.length];
    return \`Note \${i}: this record documents \${topic} behavior, configuration defaults, and \` +
        \`failure modes observed in the system for case \${i}. Related subsystems interact with \` +
        \`\${topic} during normal operation and during recovery, and operators should check this \` +
        \`note before changing \${topic} settings.\`;
}
function noteRecord(i) {
    const content = corpusNote(i);
    return { id: 'bench-' + i, workspace: 'default', ecosystem: '*', nodeData: { id: 'bench-' + i, type: 'note', label: 'bench-' + i, content, project: 'default', ecosystem: '*' } };
}

// First-call latency is measured from createLore() start, not from the
// first ingest: in-process mode may load the embedding model during
// createLore(), shared mode on the first embed call. Timing only the ingest
// would hide the in-process load and overstate shared mode's cost.
const t0 = performance.now();
const lore = await createLore({ dataDir: process.env.__DATA_DIR, deploymentMode: 'embedded', ownsProcess: false });
const createLoreMs = performance.now() - t0;

let firstCallLatencyMs = null;
let firstIngestMs = null;
try {
    const first = noteRecord(0);
    const fs0 = performance.now();
    await lore.bulkIngest([first], { embed: 'sync' });
    firstIngestMs = performance.now() - fs0;
    firstCallLatencyMs = performance.now() - t0;

    const rest = Array.from({ length: CORPUS_SIZE - 1 }, (_, i) => noteRecord(i + 1));
    await lore.bulkIngest(rest, { embed: 'sync' });

    const recallTimesMs = [];
    let rerankBusy = 0, rerankTimeout = 0, rerankApplied = 0, rerankOther = 0;
    for (let i = 0; i < RECALLS; i++) {
        const q = QUERIES[i % QUERIES.length];
        const rs = performance.now();
        const res = await lore.recall(q, { workspace: 'default', rerank: true, mode: 'summary' });
        recallTimesMs.push(performance.now() - rs);
        const reason = res && res._meta && res._meta.rerank ? res._meta.rerank.reason : undefined;
        const applied = res && res._meta && res._meta.rerank ? res._meta.rerank.applied : undefined;
        if (reason === 'busy') rerankBusy++;
        else if (reason === 'timeout') rerankTimeout++;
        else if (applied) rerankApplied++;
        else rerankOther++;
    }

    const status = lore.modelStatus();
    const pidFile = pidPath(process.env.LORE_HOME, serverKey(process.env.LORE_HOME));
    const serverPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null;

    process.stdout.write('HOST_RESULT ' + JSON.stringify({
        hostId: process.env.__HOST_ID, pid: process.pid,
        mode: status.mode, reason: status.reason ?? null, serverPid,
        firstCallLatencyMs, createLoreMs, firstIngestMs, recallTimesMs,
        rerankBusy, rerankTimeout, rerankApplied, rerankOther,
    }) + '\\n');
} catch (err) {
    process.stdout.write('HOST_ERROR ' + JSON.stringify({ hostId: process.env.__HOST_ID, message: String(err && err.stack || err) }) + '\\n');
}

// Hold idle until the orchestrator sends SIGTERM, so it can sample RSS
// while this process is quiescent (matches the reference dist-spawn test's
// own SIGTERM-then-poll cleanup pattern). A bare 'SIGTERM' listener with
// nothing else pending does NOT reliably keep Node 22's event loop alive
// once the module graph finishes (observed: process self-exits with an
// "unsettled top-level await" warning before any signal arrives — this bit
// scenario B, whose hosts have no open socket to a model server to keep
// them alive incidentally the way scenario A's hosts do). A self-clearing
// interval is a real pending handle, so it keeps the process up until we
// explicitly let go of it.
await new Promise((resolve) => {
    const keepAlive = setInterval(() => {}, 1000);
    process.once('SIGTERM', () => { clearInterval(keepAlive); resolve(); });
});
try { await lore.dispose(); } catch { /* best effort on the way out */ }
process.exit(0);
`;
}

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function rssKB(pid) {
    try {
        const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
        const n = parseInt(out.trim(), 10);
        return Number.isFinite(n) ? n : null;
    } catch {
        return null; // process already gone — best effort, matches measure-memory.mjs convention
    }
}

async function terminateAndWait(pid, label) {
    if (!pid || !alive(pid)) return;
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (alive(pid)) {
        console.log(`[bench] ${label} pid ${pid} did not exit on SIGTERM within 5s, sending SIGKILL`);
        try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
}

function serverStatusViaCli(loreHome) {
    const cliPath = path.join(DIST_DIR, 'lore', 'src', 'cli', 'index.js');
    const run = spawnSync(process.execPath, [cliPath, 'models', 'server', 'status', '--json'], {
        env: { ...process.env, LORE_HOME: loreHome },
        encoding: 'utf8',
        timeout: 10_000,
    });
    try { return JSON.parse((run.stdout ?? '').trim()); } catch { return null; }
}

function stopServerViaCli(loreHome) {
    const cliPath = path.join(DIST_DIR, 'lore', 'src', 'cli', 'index.js');
    const run = spawnSync(process.execPath, [cliPath, 'models', 'server', 'stop'], {
        env: { ...process.env, LORE_HOME: loreHome },
        encoding: 'utf8',
        timeout: 15_000,
    });
    return run.status === 0;
}

// ─── one scenario run: 4 hosts, simultaneous, against one fresh LORE_HOME ─

async function runOne(scenario, runIndex) {
    const tag = `${scenario}${runIndex}`;
    const home = makeTempHome(tag);
    const dataDirs = Array.from({ length: HOSTS_PER_SCENARIO }, (_, i) => fs.mkdtempSync(path.join(LOG_DIR, `tmp-data-${tag}-h${i}-`)));
    const driverPath = path.join(LOG_DIR, `driver-${tag}.mjs`);
    fs.writeFileSync(driverPath, driverSource());

    const baseEnv = { ...process.env, LORE_HOME: home, __DIST_DIR: DIST_DIR, LORE_MODEL_SERVER: scenario === 'A' ? '1' : '0', LORE_MODEL_SERVER_READY_MS: '30000', LORE_MODEL_SERVER_CALL_MS: '60000' };
    delete baseEnv.NODE_OPTIONS;
    delete baseEnv.LORE_LOCAL_EMBEDDING_DEVICE;

    const children = [];
    const resultPromises = dataDirs.map((dataDir, i) => new Promise((resolve) => {
        const env = { ...baseEnv, __DATA_DIR: dataDir, __HOST_ID: String(i) };
        const child = spawn(process.execPath, [driverPath], { cwd: REPO_ROOT, env });
        children.push(child);
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { err += d.toString(); });
        child.on('exit', (code, signal) => {
            const line = out.split('\n').find((l) => l.startsWith('HOST_RESULT ') || l.startsWith('HOST_ERROR '));
            resolve({ hostId: i, pid: child.pid, exitCode: code, signal, stderr: err, stdout: out, resultLine: line ?? null });
        });
    }));

    // Wait for every host to PRINT its result (not exit — they hold idle
    // afterward on purpose so RSS can be sampled while quiescent).
    await Promise.all(children.map((child, i) => new Promise((resolve, reject) => {
        let buf = '';
        const onData = (d) => {
            buf += d.toString();
            if (buf.includes('HOST_RESULT ') || buf.includes('HOST_ERROR ')) {
                child.stdout.off('data', onData);
                resolve();
            }
        };
        child.stdout.on('data', onData);
        child.on('exit', () => resolve()); // in case it exited/crashed before printing
        setTimeout(() => reject(new Error(`host ${i} produced no result within 120s`)), 120_000);
    })));

    // Give the event loop a moment to settle before sampling RSS.
    await new Promise((r) => setTimeout(r, 500));

    const hostPids = children.map((c) => c.pid);
    const hostRssKB = hostPids.map((pid) => rssKB(pid));

    let serverPid = null;
    let serverRssKB = null;
    let serverStatusRssBytes = null;
    if (scenario === 'A') {
        const status = serverStatusViaCli(home);
        if (status && status.running) {
            serverPid = status.pid;
            serverStatusRssBytes = status.rssBytes ?? null;
            serverRssKB = rssKB(serverPid);
        }
    }

    // Terminate hosts now that RSS is sampled, then collect their final
    // stdout (the exit handlers registered above already captured it).
    await Promise.all(hostPids.map((pid) => terminateAndWait(pid, 'host')));
    const finals = await Promise.all(resultPromises);

    // Between-scenario cleanup: make sure this run's server is gone before
    // returning, so it never overlaps with the next run's (different-key)
    // server. Prefer the graceful CLI shutdown; fall back to SIGTERM on the
    // pid this run itself discovered via the pidfile/CLI status above —
    // never a pid found by any other means.
    if (scenario === 'A' && serverPid) {
        const ok = stopServerViaCli(home);
        if (!ok || alive(serverPid)) await terminateAndWait(serverPid, 'model-server');
    }

    fs.rmSync(driverPath, { force: true });
    fs.rmSync(home, { recursive: true, force: true });
    for (const d of dataDirs) fs.rmSync(d, { recursive: true, force: true });

    const parsed = finals.map((f) => {
        if (!f.resultLine) return { hostId: f.hostId, error: `no result line; exitCode=${f.exitCode} signal=${f.signal} stderr=${f.stderr.slice(-2000)}` };
        const isError = f.resultLine.startsWith('HOST_ERROR ');
        const payload = JSON.parse(f.resultLine.slice(f.resultLine.indexOf(' ') + 1));
        return isError ? { hostId: f.hostId, error: payload.message } : payload;
    });

    const errors = parsed.filter((p) => p.error);
    if (errors.length > 0) {
        console.error(`[bench] run ${tag}: ${errors.length}/${HOSTS_PER_SCENARIO} host(s) errored:`);
        for (const e of errors) console.error(`  host ${e.hostId}: ${e.error}`);
    }

    const modesOk = scenario === 'A' && parsed.every((p) => p.mode === 'shared');
    const serverPids = new Set(parsed.map((p) => p.serverPid).filter((x) => x != null));
    const oneServer = scenario === 'A' ? serverPids.size === 1 : true;

    const result = {
        scenario, runIndex, tag,
        hostPids, hostRssKB, serverPid, serverRssKB, serverStatusRssBytes,
        hosts: parsed,
        assertions: scenario === 'A' ? { allHostsSharedMode: modesOk, exactlyOneServerPid: oneServer } : undefined,
    };
    fs.writeFileSync(path.join(LOG_DIR, `run-${tag}.json`), JSON.stringify(result, null, 2));
    return result;
}

// ─── stats helpers ─────────────────────────────────────────────────────

function median(nums) {
    const s = [...nums].filter((n) => n != null && Number.isFinite(n)).sort((a, b) => a - b);
    if (s.length === 0) return null;
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(nums, p) {
    const s = [...nums].filter((n) => n != null && Number.isFinite(n)).sort((a, b) => a - b);
    if (s.length === 0) return null;
    const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
    return s[Math.max(0, idx)];
}

function summarizeRun(r) {
    const allRecallMs = r.hosts.flatMap((h) => h.recallTimesMs ?? []);
    const firstCallLatencies = r.hosts.map((h) => h.firstCallLatencyMs).filter((n) => n != null);
    const busy = r.hosts.reduce((a, h) => a + (h.rerankBusy ?? 0), 0);
    const timeout = r.hosts.reduce((a, h) => a + (h.rerankTimeout ?? 0), 0);
    const totalRecalls = r.hosts.reduce((a, h) => a + (h.recallTimesMs?.length ?? 0), 0);
    const hostRssSumKB = r.hostRssKB.reduce((a, v) => a + (v ?? 0), 0);
    const totalRssKB = hostRssSumKB + (r.serverRssKB ?? 0);
    return {
        tag: r.tag, scenario: r.scenario,
        p50RecallMs: percentile(allRecallMs, 50),
        p90RecallMs: percentile(allRecallMs, 90),
        firstCallMedianMs: median(firstCallLatencies),
        firstCallWorstMs: firstCallLatencies.length ? Math.max(...firstCallLatencies) : null,
        createLoreMedianMs: median(r.hosts.map((h) => h.createLoreMs)),
        rerankBusy: busy, rerankTimeout: timeout, totalRecalls,
        rerankFailOpenRate: totalRecalls ? (busy + timeout) / totalRecalls : null,
        hostRssSumKB, serverRssKB: r.serverRssKB ?? null, totalRssKB,
        serverStatusRssBytes: r.serverStatusRssBytes ?? null,
        assertions: r.assertions ?? null,
    };
}

// ─── main ──────────────────────────────────────────────────────────────

async function main() {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.mkdirSync(path.dirname(RESULTS_DOC), { recursive: true });


    const info = machineInfo();
    console.log('[bench] machine:', JSON.stringify(info));
    console.log('[bench] building dist into', DIST_DIR);
    buildDist();
    console.log('[bench] preparing seed LORE_HOME with the re-rank model in', SEED_HOME);
    prepareSeedHome();

    const runs = [];
    try {
        for (let i = 0; i < SCENARIO_ORDER.length; i++) {
            const scenario = SCENARIO_ORDER[i];
            const runIndex = Math.floor(i / 2) + 1; // 1..3 within each scenario
            console.log(`[bench] run ${i + 1}/${SCENARIO_ORDER.length}: scenario ${scenario}, run ${runIndex}`);
            const t0 = performance.now();
            const r = await runOne(scenario, runIndex);
            console.log(`[bench]   done in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
            runs.push(r);
        }
    } finally {
        fs.rmSync(DIST_DIR, { recursive: true, force: true });
    }

    const summaries = runs.map(summarizeRun);
    const aRuns = summaries.filter((s) => s.scenario === 'A');
    const bRuns = summaries.filter((s) => s.scenario === 'B');

    const medA = {
        totalRssKB: median(aRuns.map((s) => s.totalRssKB)),
        p50RecallMs: median(aRuns.map((s) => s.p50RecallMs)),
        p90RecallMs: median(aRuns.map((s) => s.p90RecallMs)),
        firstCallMedianMs: median(aRuns.map((s) => s.firstCallMedianMs)),
        firstCallWorstMs: median(aRuns.map((s) => s.firstCallWorstMs)),
        createLoreMedianMs: median(aRuns.map((s) => s.createLoreMedianMs)),
        rerankFailOpenRate: median(aRuns.map((s) => s.rerankFailOpenRate)),
    };
    const medB = {
        totalRssKB: median(bRuns.map((s) => s.totalRssKB)),
        p50RecallMs: median(bRuns.map((s) => s.p50RecallMs)),
        p90RecallMs: median(bRuns.map((s) => s.p90RecallMs)),
        firstCallMedianMs: median(bRuns.map((s) => s.firstCallMedianMs)),
        firstCallWorstMs: median(bRuns.map((s) => s.firstCallWorstMs)),
        createLoreMedianMs: median(bRuns.map((s) => s.createLoreMedianMs)),
        rerankFailOpenRate: median(bRuns.map((s) => s.rerankFailOpenRate)),
    };
    const deltaMB = (medA.totalRssKB - medB.totalRssKB) / 1024;
    const deltaPct = medB.totalRssKB ? ((medA.totalRssKB - medB.totalRssKB) / medB.totalRssKB) * 100 : null;
    const recallP50DeltaPct = medB.p50RecallMs ? ((medA.p50RecallMs - medB.p50RecallMs) / medB.p50RecallMs) * 100 : null;
    const recallP90DeltaPct = medB.p90RecallMs ? ((medA.p90RecallMs - medB.p90RecallMs) / medB.p90RecallMs) * 100 : null;

    const allAssertionsOk = runs
        .filter((r) => r.scenario === 'A')
        .every((r) => r.assertions?.allHostsSharedMode === true && r.assertions?.exactlyOneServerPid === true);

    writeResultsDoc({ info, runs, summaries, aRuns, bRuns, medA, medB, deltaMB, deltaPct, recallP50DeltaPct, recallP90DeltaPct, allAssertionsOk });

    console.log('[bench] wrote', RESULTS_DOC);
    console.log('[bench] A vs B total RSS: A=%d MB, B=%d MB, delta=%d MB (%s%%)',
        Math.round(medA.totalRssKB / 1024), Math.round(medB.totalRssKB / 1024), Math.round(deltaMB), deltaPct?.toFixed(1));
}

function fmt(n, digits = 1) { return n == null ? 'n/a' : Number(n).toFixed(digits); }
function mb(kb) { return kb == null ? 'n/a' : (kb / 1024).toFixed(1); }

function writeResultsDoc(ctx) {
    const { info, summaries, medA, medB, deltaMB, deltaPct, recallP50DeltaPct, recallP90DeltaPct, allAssertionsOk } = ctx;
    const aRows = summaries.filter((s) => s.scenario === 'A');
    const bRows = summaries.filter((s) => s.scenario === 'B');

    const rowsTable = (rows) => rows.map((s) =>
        `| ${s.tag} | ${mb(s.totalRssKB)} | ${fmt(s.p50RecallMs)} | ${fmt(s.p90RecallMs)} | ${fmt(s.firstCallMedianMs, 0)} | ${fmt(s.firstCallWorstMs, 0)} | ${s.rerankBusy} | ${s.rerankTimeout} | ${s.totalRecalls} |`
    ).join('\n');

    const noisyNotes = [];
    for (const s of [...aRows, ...bRows]) {
        if (s.assertions && (!s.assertions.allHostsSharedMode || !s.assertions.exactlyOneServerPid)) {
            noisyNotes.push(`- **${s.tag}: assertion failed** — allHostsSharedMode=${s.assertions.allHostsSharedMode}, exactlyOneServerPid=${s.assertions.exactlyOneServerPid}. See run-${s.tag}.json.`);
        }
        if (s.hostRssSumKB === 0) noisyNotes.push(`- ${s.tag}: host RSS sum is 0 — \`ps\` likely failed to read at least one pid (process may have exited before sampling); see run-${s.tag}.json.`);
    }

    const doc = `# D9 shared-model-server measurements (Lore 3.24, slice C3b)

Measured (reported, not gated) per [D9-shared-model-server.md](../design/D9-shared-model-server.md) §6.
This is a measurement, not a release gate — no pass/fail threshold, no
production code changed based on the result (see "No tuning" below).

## Machine

- Chip: ${info.chip}
- CPUs: ${info.cpus}
- RAM: ${info.totalMemGB} GB
- OS: ${info.platform}
- Node: ${info.node}

## Command

\`\`\`
node scripts/perf/d9-shared-models-bench.mjs
\`\`\`

## Method

4 hosts (plain \`node\`, compiled dist via \`tsc\` + \`tsc-alias\` into a
throwaway \`.bench-dist/\` inside the worktree, deleted afterward — the same
pattern as \`test/model-server-dist-spawn-unit.ts\`), each with its own
\`dataDir\` but the same \`LORE_HOME\` (env-keyed model-server sharing is
independent of \`dataDir\`, D9 §5.1). Each host bulk-ingests the same
deterministic ~300-note corpus, then runs 60 recalls (\`rerank: true\`
per-call, same mechanism as \`test/d8-rerank-e2e.ts\`) from a fixed
20-query list cycled 3x, then holds idle for RSS sampling
(\`ps -o rss= -p <pid>\`).

Scenario **A** = \`LORE_MODEL_SERVER=1\` (shared); scenario **B** =
\`LORE_MODEL_SERVER=0\` (in-process). Each scenario ran 3 times, alternating
A,B,A,B,A,B. Every run gets a fresh temp \`LORE_HOME\` (copy-on-write clone
of a seed home holding the re-rank model, so a fresh copy also means a fresh model-server key
— no cross-run contamination). Scenario A's model server is stopped
(\`lore models server stop\`, falling back to SIGTERM on its own pidfile pid
if that fails) immediately after each run.

The re-rank model comes from \`LORE_TEST_RERANK_MODEL_DIR\` (copied) or a
one-off \`lore models fetch-rerank\` into the seed home; the embedding model
from the legacy \`transformers\` cache in \`node_modules\`.

**Scenario A assertion** (every host reports \`mode:'shared'\`, exactly one
server pid across all 4 hosts): ${allAssertionsOk ? 'PASSED on all 3 runs.' : 'FAILED on at least one run — see notes below.'}

## Results — per run

Scenario A (shared):

| run | total RSS (MB) | recall p50 (ms) | recall p90 (ms) | first-call median (ms) | first-call worst (ms) | rerank busy | rerank timeout | recalls |
|---|---|---|---|---|---|---|---|---|
${rowsTable(aRows)}
| **median** | **${mb(medA.totalRssKB)}** | **${fmt(medA.p50RecallMs)}** | **${fmt(medA.p90RecallMs)}** | **${fmt(medA.firstCallMedianMs, 0)}** | **${fmt(medA.firstCallWorstMs, 0)}** | | | |

Scenario B (in-process):

| run | total RSS (MB) | recall p50 (ms) | recall p90 (ms) | first-call median (ms) | first-call worst (ms) | rerank busy | rerank timeout | recalls |
|---|---|---|---|---|---|---|---|---|
${rowsTable(bRows)}
| **median** | **${mb(medB.totalRssKB)}** | **${fmt(medB.p50RecallMs)}** | **${fmt(medB.p90RecallMs)}** | **${fmt(medB.firstCallMedianMs, 0)}** | **${fmt(medB.firstCallWorstMs, 0)}** | | | |

## A vs B delta (medians)

| metric | A | B | delta |
|---|---|---|---|
| Total idle RSS (4 hosts${aRows[0]?.serverStatusRssBytes != null ? ' + server' : ' + server'}) | ${mb(medA.totalRssKB)} MB | ${mb(medB.totalRssKB)} MB | ${deltaMB >= 0 ? '+' : ''}${deltaMB.toFixed(1)} MB (${deltaPct == null ? 'n/a' : (deltaPct >= 0 ? '+' : '') + deltaPct.toFixed(1) + '%'}) |
| Recall p50 | ${fmt(medA.p50RecallMs)} ms | ${fmt(medB.p50RecallMs)} ms | ${recallP50DeltaPct == null ? 'n/a' : (recallP50DeltaPct >= 0 ? '+' : '') + recallP50DeltaPct.toFixed(1) + '%'} |
| Recall p90 | ${fmt(medA.p90RecallMs)} ms | ${fmt(medB.p90RecallMs)} ms | ${recallP90DeltaPct == null ? 'n/a' : (recallP90DeltaPct >= 0 ? '+' : '') + recallP90DeltaPct.toFixed(1) + '%'} |
| First-call latency (median host) | ${fmt(medA.firstCallMedianMs, 0)} ms | ${fmt(medB.firstCallMedianMs, 0)} ms | — |
| First-call latency (worst host) | ${fmt(medA.firstCallWorstMs, 0)} ms | ${fmt(medB.firstCallWorstMs, 0)} ms | — |
| of which \`createLore()\` (median host) | ${fmt(medA.createLoreMedianMs, 0)} ms | ${fmt(medB.createLoreMedianMs, 0)} ms | — |
| Rerank fail-open rate (busy+timeout / total) | ${medA.rerankFailOpenRate == null ? 'n/a' : (medA.rerankFailOpenRate * 100).toFixed(2) + '%'} | ${medB.rerankFailOpenRate == null ? 'n/a' : (medB.rerankFailOpenRate * 100).toFixed(2) + '%'} | — |

## Reading

- Total idle RSS is the sum of all 4 host processes' \`ps\` RSS plus (scenario
  A only) the shared \`lore-models\` server's own \`ps\` RSS. The server's
  self-reported \`status.rssBytes\` is recorded separately per run in the raw
  JSON as a cross-check against the \`ps\` figure.
- Recall p50/p90 pool all 240 recall timings (4 hosts × 60 recalls) within a
  run before taking the percentile; the table's "median" row is the median
  of the 3 per-run percentiles, not a re-pooled percentile across runs.
- First-call latency is measured from each host's \`createLore()\` start to
  its first single-note ingest-embed completing, so it includes model load
  wherever it happens: during \`createLore()\` or the first embed in-process
  (scenario B), or spawning the shared server and loading the model there
  (scenario A). The raw JSON also splits it into \`createLoreMs\` and
  \`firstIngestMs\`. Re-rank model load is not in it; it lands on each
  host's first recall.
${noisyNotes.length ? '\n### Noise / anomalies\n\n' + noisyNotes.join('\n') + '\n' : '\n No noise or anomalies observed across the 6 runs.\n'}

## No tuning

Per the brief for this slice: if shared mode came out slower on recall
p50/p90 by more than ~10%, or rerank busy was >0 in A but 0 in B, this
script and this doc report the numbers as measured. No production code
(model server, rerank stage, or otherwise) was changed to improve them —
that decision belongs to the feature owner, not this measurement.

## Raw data

Per-run JSON (host RSS, per-host recall timings, modelStatus, assertions):
\`<BENCH_OUT_DIR>/run-<A|B><1|2|3>.json\` (outside the repo, not committed).
`;
    fs.writeFileSync(RESULTS_DOC, doc);
}

main().catch((err) => {
    console.error('[bench] FAILED:', err.stack ?? err);
    try { fs.rmSync(DIST_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(1);
});
