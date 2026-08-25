#!/usr/bin/env node
/**
 * surreal-backend-matrix.mjs — reproducible evidence for the SurrealDB
 * storage-backend decision (surrealkv:// vs rocksdb://).
 *
 * docs/SURREALDB_BUILD_PLAN.md: "The storage backend (`surrealkv://`) is a
 * choice, not a given… Phase 1 either justifies `surrealkv` with something
 * more than 'it worked once', or runs the same crash test against both and
 * picks with evidence." The original benchmark scripts were not preserved, so
 * the numbers behind that decision could only be asserted. This script exists
 * so they can be RE-RUN.
 *
 * Measures, per backend:
 *   1. Cold open time (fresh directory).
 *   2. Warm open time (existing directory, in a fresh process).
 *   3. Single-row write throughput.
 *   4. Batched write throughput (one transaction).
 *   5. Native multi-hop traversal (3-hop and 5-hop, one query each).
 *   6. Close → reopen IN-PROCESS: does the directory lock clear, and how long
 *      does it take?
 *   7. Close → open FROM ANOTHER PROCESS: is the lock released on close, or
 *      held until the owning process exits?
 *   8. SIGKILL mid-write, then reopen: are acknowledged rows durable?
 *
 * (6) and (7) are the ones that decided it. They are not throughput numbers;
 * they are "can the daemon reopen a workspace at all".
 *
 * Usage:
 *   node scripts/diagnostics/surreal-backend-matrix.mjs            # both backends
 *   node scripts/diagnostics/surreal-backend-matrix.mjs surrealkv  # one backend
 *   node scripts/diagnostics/surreal-backend-matrix.mjs --rows 5000
 *
 * Read-only with respect to the repo and to LORE_HOME: every store is created
 * under a fresh mkdtemp directory and removed afterwards.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RecordId, Surreal } from 'surrealdb';
import { createNodeEngines } from '@surrealdb/node';

const SELF = fileURLToPath(import.meta.url);
const ALL_BACKENDS = ['surrealkv', 'rocksdb'];

/* ─── arg parsing ────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const rowsFlag = argv.indexOf('--rows');
const ROWS = rowsFlag === -1 ? 2000 : Number.parseInt(argv[rowsFlag + 1] ?? '2000', 10);
const CHAIN = 64; // nodes in the traversal chain
const requested = argv.filter((a) => ALL_BACKENDS.includes(a));
const BACKENDS = requested.length > 0 ? requested : ALL_BACKENDS;

/* ─── helpers ────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const ms = (start) => Number((performance.now() - start).toFixed(1));

function tmpdir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `surreal-matrix-${tag}-`));
}

async function connect(backend, dir, timeoutMs = 4000) {
    const db = new Surreal({ engines: createNodeEngines() });
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
    });
    try {
        await Promise.race([
            (async () => {
                await db.connect(`${backend}://${dir}/db`);
                await db.use({ namespace: 'lore', database: 'graph' });
                await db.query('DEFINE TABLE IF NOT EXISTS node SCHEMALESS');
                await db.query('DEFINE TABLE IF NOT EXISTS edge TYPE RELATION IN node OUT node SCHEMALESS');
            })(),
            timeout,
        ]);
        return db;
    } finally {
        clearTimeout(timer);
    }
}

const rid = (i) => new RecordId('node', `row-${i}`);

function row(i) {
    return {
        type: 'decision',
        label: `Label ${i}`,
        content: `Content body for row ${i}`.repeat(4),
        tags: [`tag-${i % 32}`],
        project: 'bench',
        ecosystem: '*',
        metadata: '{}',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

/* ─── child mode: used by the cross-process lock probe ───────────── */

if (argv[0] === '--child-open') {
    const [, backend, dir] = argv;
    try {
        const db = await connect(backend, dir, 4000);
        process.stdout.write('OPENED\n');
        await db.close();
    } catch (err) {
        process.stdout.write(`FAILED:${err.message}\n`);
    }
    process.exit(0);
}

/* ─── child mode: used by the SIGKILL durability probe ───────────── */

if (argv[0] === '--child-write') {
    const [, backend, dir] = argv;
    const db = await connect(backend, dir, 8000);
    for (let i = 0; ; i++) {
        await db.query('CREATE $r CONTENT $c', { r: rid(i), c: row(i) });
        process.stdout.write(`committed ${i}\n`);
    }
}

/* ─── measurements ───────────────────────────────────────────────── */

async function measureOpenAndWrites(backend, dir) {
    const coldStart = performance.now();
    const db = await connect(backend, dir);
    const coldOpenMs = ms(coldStart);

    const singleStart = performance.now();
    for (let i = 0; i < ROWS; i++) {
        await db.query('CREATE $r CONTENT $c', { r: rid(i), c: row(i) });
    }
    const singleMs = ms(singleStart);

    // Batched: one statement carrying the whole array, so the engine commits
    // once instead of ROWS times. This is the number the build plan cites as
    // 180× — worth re-measuring rather than trusting.
    const batch = [];
    for (let i = 0; i < ROWS; i++) batch.push({ id: new RecordId('node', `batch-${i}`), ...row(i) });
    const batchStart = performance.now();
    await db.query('INSERT INTO node $rows', { rows: batch });
    const batchMs = ms(batchStart);

    // A chain long enough that a 5-hop query is a real traversal.
    for (let i = 0; i < CHAIN; i++) {
        await db.query('CREATE $r CONTENT $c', { r: new RecordId('node', `chain-${i}`), c: row(i) });
    }
    for (let i = 0; i < CHAIN - 1; i++) {
        await db.query('RELATE $a->edge->$b CONTENT $c', {
            a: new RecordId('node', `chain-${i}`),
            b: new RecordId('node', `chain-${i + 1}`),
            c: { relation: 'next' },
        });
    }

    const hop3Start = performance.now();
    const hop3 = await db.query('SELECT * FROM $r->edge->node->edge->node->edge->node', {
        r: new RecordId('node', 'chain-0'),
    });
    const hop3Ms = ms(hop3Start);

    const hop5Start = performance.now();
    const hop5 = await db.query(
        'SELECT * FROM $r->edge->node->edge->node->edge->node->edge->node->edge->node',
        { r: new RecordId('node', 'chain-0') },
    );
    const hop5Ms = ms(hop5Start);

    await db.close();

    return {
        coldOpenMs,
        singleWritesPerSec: Math.round((ROWS / singleMs) * 1000),
        batchWritesPerSec: Math.round((ROWS / batchMs) * 1000),
        hop3: { ms: hop3Ms, rows: (hop3[0] ?? []).length },
        hop5: { ms: hop5Ms, rows: (hop5[0] ?? []).length },
    };
}

/**
 * After close(), how long until the SAME process can reopen the directory?
 * Returns the elapsed ms, or null if still locked after `budgetMs`.
 */
async function measureInProcessReopen(backend, dir, budgetMs = 8000) {
    const start = performance.now();
    for (let attempt = 1; ; attempt++) {
        try {
            const db = await connect(backend, dir, 500);
            const elapsed = ms(start);
            await db.close();
            return { elapsedMs: elapsed, attempts: attempt };
        } catch {
            if (performance.now() - start > budgetMs) return { elapsedMs: null, attempts: attempt };
            await sleep(250);
        }
    }
}

/** After close(), can a DIFFERENT process open the directory? */
async function probeCrossProcessOpen(backend, dir) {
    const child = spawn(process.execPath, [SELF, '--child-open', backend, dir], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c.toString(); });
    await new Promise((resolve) => child.once('exit', resolve));
    return out.trim().startsWith('OPENED');
}

/** SIGKILL a writing child, then verify every acknowledged row survived. */
async function probeCrashDurability(backend) {
    const dir = tmpdir(`kill-${backend}`);
    try {
        const child = spawn(process.execPath, [SELF, '--child-write', backend, dir], {
            stdio: ['ignore', 'pipe', 'pipe'], detached: true,
        });
        let lastCommitted = -1;
        child.stdout.on('data', (chunk) => {
            for (const line of chunk.toString().split('\n')) {
                const m = /^committed (\d+)$/.exec(line.trim());
                if (m) lastCommitted = Number(m[1]);
            }
        });
        const deadline = Date.now() + 30_000;
        while (lastCommitted < 20 && Date.now() < deadline) await sleep(20);
        const exited = new Promise((resolve) => child.once('exit', resolve));
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
        await Promise.race([exited, sleep(8000)]);

        if (lastCommitted < 0) return { acknowledged: 0, survived: 0, verdict: 'writer never started' };

        // A different process (this one) reopens — which for rocksdb only works
        // because the writer is dead, not because it released anything.
        const db = await connect(backend, dir, 8000);
        let survived = 0;
        for (let i = 0; i <= lastCommitted; i++) {
            const found = await db.query('SELECT * FROM $r', { r: rid(i) });
            if ((found[0] ?? []).length === 1) survived++;
        }
        const counted = await db.query('SELECT count() AS c FROM node GROUP ALL');
        const total = counted[0]?.[0]?.c ?? 0;
        await db.close();
        return {
            acknowledged: lastCommitted + 1,
            survived,
            total,
            verdict: survived === lastCommitted + 1 ? 'no loss' : `LOST ${lastCommitted + 1 - survived}`,
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* ─── run ────────────────────────────────────────────────────────── */

console.log(`SurrealDB storage-backend matrix — ${ROWS} rows, ${CHAIN}-node chain`);
console.log(`node ${process.versions.node} · ${process.platform}/${process.arch}\n`);

const results = {};
for (const backend of BACKENDS) {
    console.log(`── ${backend} ─────────────────────────────────────────`);
    const dir = tmpdir(backend);
    try {
        const perf = await measureOpenAndWrites(backend, dir);
        console.log(`  cold open              ${perf.coldOpenMs} ms`);
        console.log(`  write throughput       ${perf.singleWritesPerSec}/s single-row`);
        console.log(`  write throughput       ${perf.batchWritesPerSec}/s batched (one statement)`);
        console.log(`  native 3-hop           ${perf.hop3.ms} ms → ${perf.hop3.rows} row(s)`);
        console.log(`  native 5-hop           ${perf.hop5.ms} ms → ${perf.hop5.rows} row(s)`);

        const reopen = await measureInProcessReopen(backend, dir);
        console.log(reopen.elapsedMs === null
            ? `  in-process reopen      STILL LOCKED after ${reopen.attempts} attempts — the lock is NOT released on close()`
            : `  in-process reopen      ${reopen.elapsedMs} ms (attempt ${reopen.attempts})`);

        const crossProcess = await probeCrossProcessOpen(backend, dir);
        console.log(`  cross-process open     ${crossProcess ? 'OK' : 'BLOCKED — lock held for the owning process\'s lifetime'}`);

        const crash = await probeCrashDurability(backend);
        console.log(`  SIGKILL durability     ${crash.survived}/${crash.acknowledged} acknowledged rows survived — ${crash.verdict}`);

        results[backend] = { ...perf, reopen, crossProcess, crash };
    } catch (err) {
        console.log(`  FAILED: ${err.message}`);
        results[backend] = { error: err.message };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log('');
}

/* ─── verdict ────────────────────────────────────────────────────── */

if (BACKENDS.length > 1) {
    console.log('── verdict ────────────────────────────────────────────');
    for (const backend of BACKENDS) {
        const r = results[backend];
        if (!r || r.error) { console.log(`  ${backend}: could not be measured`); continue; }
        const reopenable = r.reopen.elapsedMs !== null && r.crossProcess;
        console.log(
            `  ${backend.padEnd(10)} reopen=${reopenable ? 'YES' : 'NO'} `
            + `durable=${r.crash.verdict === 'no loss' ? 'YES' : 'NO'} `
            + `single=${r.singleWritesPerSec}/s batched=${r.batchWritesPerSec}/s`,
        );
    }
    console.log(
        '\n  A backend that cannot be REOPENED is disqualified regardless of throughput:\n'
        + '  LocalGraphRegistry closes and reopens workspaces inside one daemon process\n'
        + '  (workspace switching, migration, backup/restore), and a held lock also locks\n'
        + '  out every other tool on the machine.',
    );
}

process.exit(0);
