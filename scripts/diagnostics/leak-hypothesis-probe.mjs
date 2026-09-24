#!/usr/bin/env node
/**
 * scripts/diagnostics/leak-hypothesis-probe.mjs — PROBE ONLY, for the
 * `@surrealdb/node@3.0.3` close()-does-not-release-native-memory
 * investigation (see scripts/measure-memory.mjs's `surreal-only` config,
 * which already established the base leak: +99 MB/cycle, R^2=1.000, +3
 * open files/cycle held after close()).
 *
 * This script isolates WHICH layer the leak lives in by running the same
 * open/write/close shape at three different levels:
 *   - the full Lore engine (packages/lore/src/engines/surrealGraph.ts)
 *   - the mid-level connection helper (.../surreal/surrealConnection.ts)
 *   - the bare native NAPI binding, bypassing the JS wrapper entirely
 *
 * Does NOT modify anything under packages/ or node_modules/. Every mode
 * writes only to a fresh `os.tmpdir()` mkdtemp directory, removed after
 * each cycle (except H2, which deliberately reuses one directory — that IS
 * the hypothesis under test).
 *
 * Usage:
 *   node --import tsx --expose-gc scripts/diagnostics/leak-hypothesis-probe.mjs <mode> [--cycles N] [--entries N] [--node-modules DIR]
 *
 * Modes: h0, h1a, h1b, h2, h3, h4, h5, h7
 * (h6 is a separate concern — see leak-hypothesis-h6.sh in the same dir.)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(HERE), '..', '..');

// Self re-exec with --expose-gc + --import tsx, same pattern as
// scripts/measure-memory.mjs, so `node scripts/diagnostics/leak-hypothesis-probe.mjs <mode>`
// works directly without the caller having to remember the flags.
if (typeof globalThis.gc !== 'function') {
    const res = spawnSync(
        process.execPath,
        ['--expose-gc', '--import', 'tsx', HERE, ...process.argv.slice(2)],
        { stdio: 'inherit', cwd: REPO_ROOT, env: process.env },
    );
    process.exit(res.status ?? 1);
}
const gc = globalThis.gc;

/* ─── args ───────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const MODE = argv[0];
const argOf = (flag, fallback) => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : argv[i + 1];
};
const CYCLES = Number.parseInt(argOf('--cycles', '10'), 10);
const ENTRIES = Number.parseInt(argOf('--entries', '100'), 10);
const NODE_MODULES_DIR = argOf('--node-modules', path.join(REPO_ROOT, 'node_modules'));

/* ─── helpers ────────────────────────────────────────────────────── */
const MB = 1024 * 1024;
function rssMb() {
    try { gc(); } catch { /* ignore */ }
    return process.memoryUsage().rss / MB;
}
function tmpdir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `leak-probe-${tag}-`));
}
function lsofLines(pid) {
    try {
        return execFileSync('lsof', ['-p', String(pid)], {
            encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
        }).split('\n').filter((l) => l.trim().length > 0);
    } catch {
        return null;
    }
}
function countMatch(lines, needle) {
    if (!lines) return null;
    const n = needle.toLowerCase();
    return lines.filter((l) => l.toLowerCase().includes(n)).length;
}
function linreg(ys) {
    const n = ys.length;
    if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };
    const xs = Array.from({ length: n }, (_, i) => i);
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - meanX) * (ys[i] - meanY); den += (xs[i] - meanX) ** 2; }
    const slope = den === 0 ? 0 : num / den;
    const intercept = meanY - slope * meanX;
    let ssTot = 0, ssRes = 0;
    for (let i = 0; i < n; i++) {
        const pred = intercept + slope * xs[i];
        ssRes += (ys[i] - pred) ** 2;
        ssTot += (ys[i] - meanY) ** 2;
    }
    const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
    return { slope, intercept, r2 };
}
function reportSlope(label, samples, startCycle = 3) {
    const win = samples.filter((s) => s.cycle >= startCycle);
    const ys = win.map((s) => s.rssMb);
    const { slope, r2 } = linreg(ys);
    console.log(`\n[${label}] RSS slope over cycles ${startCycle}..${samples[samples.length - 1].cycle}: `
        + `${slope.toFixed(3)} MB/cycle  R^2=${r2.toFixed(3)}  `
        + `(first=${ys[0]?.toFixed(1)} MB last=${ys[ys.length - 1]?.toFixed(1)} MB)`);
    return { slope, r2 };
}
const filler = 'lorem ipsum dolor sit amet consectetur adipiscing '.repeat(6);
function nativeBindingFile() {
    const map = {
        'darwin-arm64': 'surrealdb-node.darwin-arm64.node',
        'darwin-x64': 'surrealdb-node.darwin-x64.node',
        'linux-arm64': 'surrealdb-node.linux-arm64-gnu.node',
        'linux-x64': 'surrealdb-node.linux-x64-gnu.node',
    };
    const key = `${process.platform}-${process.arch}`;
    const file = map[key];
    if (!file) throw new Error(`No native binding mapping for ${key} — extend nativeBindingFile()`);
    return file;
}
async function loadNative(nodeModulesDir) {
    const req = createRequire(path.join(nodeModulesDir, '@surrealdb/node/package.json'));
    return req(`./dist/${nativeBindingFile()}`);
}
async function loadCbor(nodeModulesDir) {
    // ESM-only package; resolve its entry from the given node_modules root
    // so H6 (a separate temp install) can point at a DIFFERENT tree.
    const pkgJsonPath = path.join(nodeModulesDir, '@surrealdb/cbor/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const entry = path.join(nodeModulesDir, '@surrealdb/cbor', pkg.main);
    return import(pathToFileURLString(entry));
}
function pathToFileURLString(p) {
    return new URL(`file://${path.resolve(p)}`).toString();
}

/* ─── H0: full engine, fresh dir/cycle, name the held files ─────────── */
async function runH0() {
    const { SurrealGraph } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/surrealGraph.ts'));
    const samples = [];
    let lastDirForNaming = null;
    for (let c = 1; c <= CYCLES; c++) {
        const dir = tmpdir(`h0-${c}`);
        const graph = new SurrealGraph(dir, { workspaceId: 'h0-harness' });
        await graph.initialize();
        const nodes = Array.from({ length: ENTRIES }, (_, i) => ({
            id: `h0-cycle${c}-${i}`, type: 'note', label: `h0 entry c${c}#${i}`,
            content: `H0 harness node cycle ${c} #${i}. ${filler}`,
            tags: ['h0-harness'], project: 'h0-harness', ecosystem: 'h0-harness', metadata: '{}',
        }));
        await graph.bulkUpsertNodes(nodes);
        await graph.close();
        const lines = lsofLines(process.pid);
        const heldForThisDir = lines ? lines.filter((l) => l.includes(dir)) : null;
        if (c === Math.min(5, CYCLES)) lastDirForNaming = { dir, heldForThisDir };
        const s = { cycle: c, rssMb: rssMb(), surrealFilesHeld: heldForThisDir ? heldForThisDir.length : null };
        samples.push(s);
        console.log(`  [h0] cycle ${c}/${CYCLES} rss=${s.rssMb.toFixed(1)} MB  filesHeldForThisDir=${s.surrealFilesHeld}`);
        // NOTE: intentionally NOT deleting `dir` — H0 wants to see accumulation
        // of held fds across cycles (each cycle's own leaked files), matching
        // the ESTABLISHED finding ("+3 open files/cycle... AFTER close").
    }
    reportSlope('h0', samples);
    if (lastDirForNaming) {
        console.log(`\n[h0] Exact open-file lines held for cycle ${Math.min(5, CYCLES)}'s directory (${lastDirForNaming.dir}) AFTER close():`);
        if (lastDirForNaming.heldForThisDir && lastDirForNaming.heldForThisDir.length > 0) {
            for (const l of lastDirForNaming.heldForThisDir) console.log('    ' + l);
        } else {
            console.log('    (none — lsof unavailable or nothing held)');
        }
    }
}

/* ─── H1: bare native binding, (a) no notifications, (b) notifications+recv ─ */
async function h1Writes(e, cbor, cycle, entries) {
    await e.execute(cbor.encode({ id: 1, method: 'use', params: ['lore', 'graph'] }));
    for (let i = 0; i < entries; i++) {
        const content = {
            type: 'note', label: `h1 entry c${cycle}#${i}`,
            content: `H1 harness node cycle ${cycle} #${i}. ${filler}`,
            tags: ['h1-harness'], project: 'h1-harness',
        };
        const resp = await e.execute(cbor.encode({ id: 100 + i, method: 'query', params: ['CREATE node CONTENT $c', { c: content }] }));
        const decoded = cbor.decode(resp);
        if (Array.isArray(decoded) && decoded[0]?.status && decoded[0].status !== 'OK') {
            throw new Error(`h1Writes query failed: ${JSON.stringify(decoded)}`);
        }
    }
}
async function runH1(variant, nodeModulesDir = NODE_MODULES_DIR) {
    const native = await loadNative(nodeModulesDir);
    const cbor = await loadCbor(nodeModulesDir);
    const { SurrealNodeEngine } = native;
    const samples = [];
    let pendingSettledCount = 0;
    for (let c = 1; c <= CYCLES; c++) {
        const dir = tmpdir(`h1${variant}-${c}`);
        const e = await SurrealNodeEngine.connect(`surrealkv://${dir}/db`, undefined);
        await h1Writes(e, cbor, c, ENTRIES);
        let recvSettledWithin200ms = null;
        if (variant === 'b') {
            const receiver = await e.notifications();
            const recvPromise = receiver.recv().then(() => ({ settled: true })).catch(() => ({ settled: true }));
            e.free();
            recvSettledWithin200ms = await Promise.race([
                recvPromise.then((r) => r.settled),
                new Promise((resolve) => setTimeout(() => resolve(false), 200)),
            ]);
            if (recvSettledWithin200ms) pendingSettledCount++;
        } else {
            e.free();
        }
        fs.rmSync(dir, { recursive: true, force: true });
        const lines = lsofLines(process.pid);
        const s = {
            cycle: c, rssMb: rssMb(),
            surrealFdCount: countMatch(lines, 'surreal') ?? countMatch(lines, dir.split('/').pop()),
            recvSettledWithin200ms,
        };
        samples.push(s);
        console.log(`  [h1${variant}] cycle ${c}/${CYCLES} rss=${s.rssMb.toFixed(1)} MB  surrealFds=${s.surrealFdCount}`
            + (variant === 'b' ? `  recvSettledWithin200ms=${s.recvSettledWithin200ms}` : ''));
    }
    reportSlope(`h1${variant}`, samples);
    if (variant === 'b') {
        console.log(`[h1b] pending recv() calls that settled within 200ms of free(): ${pendingSettledCount}/${CYCLES}`);
    }
}

/* ─── H2: same directory, reopened 10x without wiping ────────────────── */
async function runH2() {
    const { SurrealGraph } = await import(path.join(REPO_ROOT, 'packages/lore/src/engines/surrealGraph.ts'));
    const dir = tmpdir('h2-samedir');
    const entriesPerCycle = Math.min(ENTRIES, 50); // keep growing corpus manageable; noted as a confound below
    const samples = [];
    for (let c = 1; c <= CYCLES; c++) {
        const graph = new SurrealGraph(dir, { workspaceId: 'h2-harness' });
        await graph.initialize();
        const nodes = Array.from({ length: entriesPerCycle }, (_, i) => ({
            id: `h2-cycle${c}-${i}`, type: 'note', label: `h2 entry c${c}#${i}`,
            content: `H2 harness node cycle ${c} #${i}. ${filler}`,
            tags: ['h2-harness'], project: 'h2-harness', ecosystem: 'h2-harness', metadata: '{}',
        }));
        await graph.bulkUpsertNodes(nodes);
        await graph.close();
        const lines = lsofLines(process.pid);
        const s = { cycle: c, rssMb: rssMb(), surrealFdCount: countMatch(lines, 'surreal') };
        samples.push(s);
        console.log(`  [h2] reopen ${c}/${CYCLES} (same dir, +${entriesPerCycle} rows, cumulative=${c * entriesPerCycle}) `
            + `rss=${s.rssMb.toFixed(1)} MB  surrealFds=${s.surrealFdCount}`);
    }
    console.log('\n[h2] NOTE: unlike H0/H1, corpus size grows every cycle (this IS the hypothesis under test — '
        + '"what idle eviction + reopen does" reopens and re-writes the same store), so a rising slope here is '
        + 'expected to be steeper than H0\'s fixed-corpus-per-cycle number for that reason ALONE, on top of any leak.');
    reportSlope('h2', samples);
    fs.rmSync(dir, { recursive: true, force: true });
}

/* ─── H3: mem:// through the normal Surreal()+createNodeEngines path ─── */
async function runH3() {
    const { Surreal } = await import('surrealdb');
    const { createNodeEngines } = await import('@surrealdb/node');
    const samples = [];
    for (let c = 1; c <= CYCLES; c++) {
        const db = new Surreal({ engines: createNodeEngines() });
        await db.connect('mem://');
        await db.use({ namespace: 'lore', database: 'graph' });
        await db.query('DEFINE TABLE IF NOT EXISTS node SCHEMALESS');
        for (let i = 0; i < ENTRIES; i++) {
            await db.query('CREATE node CONTENT $c', {
                c: {
                    type: 'note', label: `h3 entry c${c}#${i}`,
                    content: `H3 harness node cycle ${c} #${i}. ${filler}`,
                    tags: ['h3-harness'], project: 'h3-harness',
                },
            });
        }
        await db.close();
        const s = { cycle: c, rssMb: rssMb() };
        samples.push(s);
        console.log(`  [h3] cycle ${c}/${CYCLES} rss=${s.rssMb.toFixed(1)} MB`);
    }
    reportSlope('h3', samples);
}

/* ─── H4: rocksdb:// through the normal path, fresh dir each cycle ───── */
async function runH4() {
    const { Surreal } = await import('surrealdb');
    const { createNodeEngines } = await import('@surrealdb/node');
    const samples = [];
    for (let c = 1; c <= CYCLES; c++) {
        const dir = tmpdir(`h4-${c}`);
        const db = new Surreal({ engines: createNodeEngines() });
        await db.connect(`rocksdb://${dir}/db`);
        await db.use({ namespace: 'lore', database: 'graph' });
        await db.query('DEFINE TABLE IF NOT EXISTS node SCHEMALESS');
        for (let i = 0; i < ENTRIES; i++) {
            await db.query('CREATE node CONTENT $c', {
                c: {
                    type: 'note', label: `h4 entry c${c}#${i}`,
                    content: `H4 harness node cycle ${c} #${i}. ${filler}`,
                    tags: ['h4-harness'], project: 'h4-harness',
                },
            });
        }
        await db.close();
        const lines = lsofLines(process.pid);
        const s = { cycle: c, rssMb: rssMb(), surrealFdCount: countMatch(lines, 'rocksdb') ?? countMatch(lines, 'surreal') };
        samples.push(s);
        console.log(`  [h4] cycle ${c}/${CYCLES} rss=${s.rssMb.toFixed(1)} MB  fds=${s.surrealFdCount} (fresh dir — rocksdb never releases its lock in-process)`);
        // Deliberately NOT deleting `dir`: rocksdb's known non-release means a
        // second open of the SAME dir in this process would hang, per
        // surrealConnection.ts's own documented finding. Fresh dirs avoid that.
    }
    reportSlope('h4', samples);
}

/* ─── H5: does anything else release it? 5s wait+gc; double close() ─── */
async function runH5() {
    const { openSurreal, applySurrealSchema, resolveSurrealFeatures } = await import(
        path.join(REPO_ROOT, 'packages/lore/src/engines/surreal/surrealConnection.ts')
    );
    const dir = tmpdir('h5');
    const conn = await openSurreal(dir, { backend: 'surrealkv' });
    await applySurrealSchema(conn.db, resolveSurrealFeatures());
    for (let i = 0; i < ENTRIES; i++) {
        await conn.db.query('CREATE node CONTENT $c', {
            c: { type: 'note', label: `h5 entry #${i}`, content: `H5 harness node #${i}. ${filler}`, tags: ['h5-harness'], project: 'h5-harness' },
        });
    }
    const beforeClose = { rssMb: rssMb(), fdCount: countMatch(lsofLines(process.pid), 'surreal') };
    console.log(`[h5] before close(): rss=${beforeClose.rssMb.toFixed(1)} MB  surrealFds=${beforeClose.fdCount}`);

    await conn.db.close();
    const immediatelyAfterClose = { rssMb: rssMb(), fdCount: countMatch(lsofLines(process.pid), 'surreal') };
    console.log(`[h5] immediately after 1st close(): rss=${immediatelyAfterClose.rssMb.toFixed(1)} MB  surrealFds=${immediatelyAfterClose.fdCount}`);

    // Second close() on the same handle — does it throw, no-op, or change anything?
    let secondCloseError = null;
    try {
        await conn.db.close();
    } catch (err) {
        secondCloseError = err instanceof Error ? err.message : String(err);
    }
    const afterSecondClose = { rssMb: rssMb(), fdCount: countMatch(lsofLines(process.pid), 'surreal') };
    console.log(`[h5] after 2nd close() (error=${secondCloseError ?? 'none'}): rss=${afterSecondClose.rssMb.toFixed(1)} MB  surrealFds=${afterSecondClose.fdCount}`);

    await new Promise((resolve) => setTimeout(resolve, 5000));
    gc();
    const after5s = { rssMb: rssMb(), fdCount: countMatch(lsofLines(process.pid), 'surreal') };
    console.log(`[h5] after 5s wait + forced gc(): rss=${after5s.rssMb.toFixed(1)} MB  surrealFds=${after5s.fdCount}`);

    console.log(`\n[h5] deltas: close 1st vs before=${(immediatelyAfterClose.rssMb - beforeClose.rssMb).toFixed(1)} MB, `
        + `fds ${beforeClose.fdCount} -> ${immediatelyAfterClose.fdCount}; `
        + `after-5s-wait vs immediately-after-close=${(after5s.rssMb - immediatelyAfterClose.rssMb).toFixed(1)} MB, `
        + `fds ${immediatelyAfterClose.fdCount} -> ${after5s.fdCount}`);

    fs.rmSync(dir, { recursive: true, force: true });
}

/* ─── H7: does Lore use live queries anywhere? ───────────────────────── */
function runH7() {
    const patterns = ['LIVE', 'liveQuery', 'subscribe'];
    const targets = ['packages/lore/src/engines/surreal', 'packages/lore/src/engines/surrealGraph.ts'];
    for (const t of targets) {
        console.log(`\n$ grep -rn "LIVE\\|liveQuery\\|subscribe" ${t}`);
        try {
            const out = execFileSync('grep', ['-rn', 'LIVE\\|liveQuery\\|subscribe', path.join(REPO_ROOT, t)], { encoding: 'utf8' });
            console.log(out.trim().length ? out : '  (no matches)');
        } catch (err) {
            // grep exits 1 on no matches — not a real error
            if (err.status === 1) console.log('  (no matches)');
            else console.log(`  grep error: ${err.message}`);
        }
    }
}

/* ─── dispatch ───────────────────────────────────────────────────────── */
console.log(`leak-hypothesis-probe: mode=${MODE} cycles=${CYCLES} entries=${ENTRIES} node=${process.versions.node} ${process.platform}/${process.arch}\n`);
switch (MODE) {
    case 'h0': await runH0(); break;
    case 'h1a': await runH1('a'); break;
    case 'h1b': await runH1('b'); break;
    case 'h2': await runH2(); break;
    case 'h3': await runH3(); break;
    case 'h4': await runH4(); break;
    case 'h5': await runH5(); break;
    case 'h7': runH7(); break;
    default:
        console.error(`unknown mode "${MODE}" — expected one of h0 h1a h1b h2 h3 h4 h5 h7`);
        process.exit(2);
}
