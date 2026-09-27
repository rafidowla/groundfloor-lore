#!/usr/bin/env tsx
/**
 * model-server-dist-spawn-unit.ts — D9 (3.24) release gate: the shared model
 * server must actually start from the COMPILED package a host installs.
 *
 * Every other model-server test runs under tsx, where the client spawns
 * `main.ts` with tsx's loader flags inherited through `process.execArgv`.
 * Hosts (Atlas, MIRA, PM Helper) run the built `dist/` with plain node: no
 * tsx, no `.ts` files. A client that hard-codes `main.ts` passes every tsx
 * test and still fails in every real host — silently degrading to the
 * in-process fallback, i.e. shipping 3.24 with no sharing at all.
 *
 * This test compiles the package exactly as `npm run build` does (tsc +
 * tsc-alias) into a throwaway directory INSIDE the repo (so bare imports
 * resolve through the repo's node_modules), then drives it from a plain
 * `node` child with no loader flags and no NODE_OPTIONS:
 *   - `createLore()` + a real embed reaches `modelStatus().mode === 'shared'`;
 *   - a second host with a different `dataDir` reuses that same server;
 *   - the spawned server's command line runs `.../modelServer/main.js` and
 *     carries no tsx loader and none of the host's own node flags.
 *
 * Run: npx tsx test/model-server-dist-spawn-unit.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, `.dist-spawn-check-${process.pid}`);
const npx = path.join(path.dirname(process.execPath), 'npx');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void> | void) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
};

function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

// The driver is plain ESM run by plain node — it must not depend on tsx.
const DRIVER = `
import * as fs from 'node:fs';
const { createLore } = await import(${JSON.stringify(path.join(outDir, 'lore/src/mcp/server.js'))});
const lore = await createLore({ dataDir: process.env.__DATA_DIR, deploymentMode: 'embedded', ownsProcess: false });
try {
    const content = 'the quick brown fox jumps over the lazy dog near the riverbank';
    await lore.bulkIngest([{ id: 'd1', workspace: 'default', ecosystem: '*', nodeData: { id: 'd1', type: 'note', label: 'd1', content, project: 'default', ecosystem: '*' } }], { embed: 'sync' });
    const status = lore.modelStatus();
    const { serverKey, pidPath } = await import(${JSON.stringify(path.join(outDir, 'lore/src/modelServer/paths.js'))});
    const pidFile = pidPath(process.env.LORE_HOME, serverKey(process.env.LORE_HOME));
    const serverPid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : null;
    console.log('RESULT ' + JSON.stringify({ mode: status.mode, reason: status.reason ?? null, serverPid }));
} finally {
    await lore.dispose();
}
`;

console.log('model-server dist spawn — compiled package, plain node, no tsx\n');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-dist-home-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-dist-data-'));
const dataDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-dist-data2-'));
let serverPid: number | null = null;
try {
    const build = spawnSync(npx, ['tsc', '--outDir', outDir], { cwd: repoRoot, encoding: 'utf8', timeout: 600_000 });
    assert.equal(build.status, 0, `tsc build failed:\n${build.stdout}\n${build.stderr}`);
    const alias = spawnSync(npx, ['tsc-alias', '--outDir', outDir], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 });
    assert.equal(alias.status, 0, `tsc-alias failed:\n${alias.stdout}\n${alias.stderr}`);
    const driverPath = path.join(outDir, 'driver.mjs');
    fs.writeFileSync(driverPath, DRIVER);

    await test('built dist ships modelServer/main.js and no .ts entry', () => {
        assert.ok(fs.existsSync(path.join(outDir, 'lore/src/modelServer/main.js')));
        assert.ok(!fs.existsSync(path.join(outDir, 'lore/src/modelServer/main.ts')));
    });

    // A deliberately host-specific node flag: it must NOT leak into the
    // shared server (the first host's flags would otherwise decide it).
    const env: NodeJS.ProcessEnv = { ...process.env, LORE_HOME: home, __DATA_DIR: dataDir, LORE_MODEL_SERVER: '1', LORE_MODEL_SERVER_READY_MS: '30000', LORE_MODEL_SERVER_CALL_MS: '60000' };
    delete env.NODE_OPTIONS;
    delete env.LORE_LOCAL_EMBEDDING_DEVICE;
    const runHost = (data: string) => {
        const run = spawnSync(process.execPath, ['--max-old-space-size=3072', driverPath], { cwd: repoRoot, env: { ...env, __DATA_DIR: data }, encoding: 'utf8', timeout: 180_000 });
        const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
        const result = line ? JSON.parse(line.slice(7)) as { mode: string; reason: string | null; serverPid: number | null } : null;
        return { run, line, result };
    };
    const { run, line, result } = runHost(dataDir);
    serverPid = result?.serverPid ?? null;

    await test('plain-node host from dist reaches shared mode (no fallback)', () => {
        assert.equal(run.status, 0, `driver failed:\n${run.stdout}\n${run.stderr}`);
        assert.ok(result, `driver printed no RESULT line:\n${run.stdout}\n${run.stderr}`);
        assert.equal(result.mode, 'shared', `expected shared, got ${result.mode} (reason: ${result.reason})`);
        assert.ok(serverPid && alive(serverPid), `expected a live model-server process, driver said: ${line}`);
    });

    await test('a second host with a DIFFERENT dataDir reuses the same server (keyed on LORE_HOME, not dataDir)', () => {
        const second = runHost(dataDir2);
        assert.equal(second.run.status, 0, `second driver failed:\n${second.run.stdout}\n${second.run.stderr}`);
        assert.equal(second.result?.mode, 'shared', `second host: ${second.line}`);
        assert.equal(second.result?.serverPid, serverPid, 'both hosts must be served by one process');
        for (const d of [dataDir, dataDir2]) assert.ok(!fs.existsSync(path.join(d, 'run')), `no per-dataDir server state expected under ${d}`);
    });

    await test('spawned server runs main.js with no tsx loader and no inherited host flags', () => {
        assert.ok(serverPid);
        const ps = spawnSync('ps', ['-o', 'command=', '-p', String(serverPid)], { encoding: 'utf8' });
        const cmd = ps.stdout.trim();
        assert.ok(cmd.endsWith(path.join('modelServer', 'main.js')), `unexpected server command: ${cmd}`);
        assert.ok(!/tsx/.test(cmd), `server command must not carry a tsx loader: ${cmd}`);
        assert.ok(!cmd.includes('--max-old-space-size'), `server must not inherit the host's node flags: ${cmd}`);
    });
} finally {
    if (serverPid && alive(serverPid)) {
        try { process.kill(serverPid, 'SIGTERM'); } catch { /* gone */ }
        for (let i = 0; i < 50 && alive(serverPid); i++) await new Promise((r) => setTimeout(r, 100));
        if (alive(serverPid)) { try { process.kill(serverPid, 'SIGKILL'); } catch { /* gone */ } }
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(dataDir2, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0 || passed === 0) process.exit(1);
