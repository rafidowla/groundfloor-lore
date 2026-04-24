#!/usr/bin/env tsx
/**
 * e2e-q2-1-server-mode.ts — Q2.1 Server Mode smoke test.
 *
 * Q2.1 acceptance (docs/post_v2_plan.md):
 *   1. One Lore binary runs local single-user AND cloud multi-tenant by
 *      config only — no separate build.
 *   2. Smoke test: spin up server-mode instance, create workspace, ingest
 *      one document, recall it.
 *   3. Zero direct DB connections from Lore code (enforced by test-arch).
 *
 * This suite covers (1) and (2). Rule (3) is enforced by the arch test
 * (scripts/test-arch.mjs, no-direct-cloud-driver rule) and runs as part
 * of `npm test`, so we don't repeat it here.
 *
 * The suite spawns a fresh daemon per case with an isolated HOME (so
 * nothing touches the user's real ~/.groundfloor/), on a high unused
 * port, and tears it down between cases.
 *
 * Cases:
 *   1. Local mode (default): daemon boots, /api/health reports mode=local,
 *      /api/node works without X-Lore-Workspace header, recall via
 *      /api/stats sees the node.
 *   2. Cloud mode without Dataplane credential: daemon exits 78 (EX_CONFIG)
 *      within the boot window.
 *   3. Cloud mode with env-sourced Dataplane credential: daemon boots,
 *      /api/health reports mode=cloud, /api/node WITHOUT the X-Lore-Workspace
 *      header returns 400 workspace_header_required, WITH the header
 *      succeeds end-to-end (store + stats roundtrip).
 *
 * No framework; same tsx-run style as the rest of test/.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'packages/lore/src/mcp/server.ts');

async function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            if (addr && typeof addr === 'object') {
                const p = addr.port;
                srv.close(() => resolve(p));
            } else {
                srv.close(() => reject(new Error('could not resolve free port')));
            }
        });
    });
}

interface DaemonHandle {
    proc: ChildProcessWithoutNullStreams;
    home: string;
    port: number;
    token: string;
    /** Live buffer — mutated as stdout/stderr chunks arrive. */
    log: { text: string };
}

/** Poll /health until the daemon answers or timeout. */
async function waitForReady(port: number, timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) return true;
        } catch { /* daemon not up yet */ }
        await new Promise((r) => setTimeout(r, 150));
    }
    return false;
}

async function spawnDaemon(opts: {
    mode?: 'local' | 'cloud';
    dataplaneApiKey?: string;
}): Promise<DaemonHandle> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-q2-1-'));
    const port = await findFreePort();
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: os.tmpdir(),
        LORE_PORT: String(port),
    };
    if (opts.mode) env.LORE_DEPLOYMENT_MODE = opts.mode;
    if (opts.dataplaneApiKey) {
        env.DATAPLANE_API_KEY = opts.dataplaneApiKey;
        // Point the ping at a black hole so it fails fast; the daemon
        // tolerates the failure and boot proceeds (dataplane=error).
        env.DATAPLANE_URL = 'http://127.0.0.1:9';
    }

    const proc = spawn('npx', ['tsx', SERVER_ENTRY, '--http'], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = { text: '' };
    proc.stdout.on('data', (c) => { log.text += c.toString(); });
    proc.stderr.on('data', (c) => { log.text += c.toString(); });

    return { proc, home, port, token: '', log };
}

async function fetchAuthToken(port: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/bootstrap`, {
        headers: { Origin: `http://127.0.0.1:${port}` },
    });
    if (!res.ok) throw new Error(`bootstrap failed ${res.status}`);
    const body = await res.json() as { token: string };
    return body.token;
}

function cleanup(h: DaemonHandle | null): void {
    if (!h) return;
    try { h.proc.kill('SIGTERM'); } catch { /* noop */ }
    try { fs.rmSync(h.home, { recursive: true, force: true }); } catch { /* noop */ }
}

async function caseLocalMode(): Promise<void> {
    console.log('— Case 1: local mode (default) —');
    let h: DaemonHandle | null = null;
    try {
        h = await spawnDaemon({});
        const ready = await waitForReady(h.port);
        if (!ready) throw new Error(`daemon never became ready\nSTDERR:\n${h.log.text}`);
        h.token = await fetchAuthToken(h.port);
        const origin = `http://127.0.0.1:${h.port}`;
        const authHdr = { Authorization: `Bearer ${h.token}`, Origin: origin };

        // /api/health reports mode=local, no header required.
        const healthRes = await fetch(`http://127.0.0.1:${h.port}/api/health`, { headers: { Origin: origin } });
        assert.equal(healthRes.status, 200, 'health must be 200');
        const health = await healthRes.json() as { deploymentMode?: string };
        assert.equal(health.deploymentMode, 'local', `expected deploymentMode=local, got ${health.deploymentMode}`);

        // Ingest a node via /api/node (no X-Lore-Workspace required in local).
        const nodeId = 'q2-1-smoke-local';
        const ingest = await fetch(`http://127.0.0.1:${h.port}/api/node`, {
            method: 'POST',
            headers: { ...authHdr, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: nodeId,
                type: 'note',
                label: 'Q2.1 smoke — local mode',
                content: 'smoke test content',
                tags: 'q2-1,smoke',
                project: 'groundfloor-lore',
            }),
        });
        assert.equal(ingest.status, 200, `ingest failed: ${ingest.status}`);

        // Recall roundtrip via /api/stats — total should be ≥ 1.
        const stats = await fetch(`http://127.0.0.1:${h.port}/api/stats`, { headers: authHdr });
        assert.equal(stats.status, 200);
        const s = await stats.json() as { nodeCount?: number };
        assert.ok((s.nodeCount ?? 0) >= 1, `expected ≥1 node, got ${s.nodeCount}`);
        console.log('  ok  local mode: boot → health mode=local → /api/node → /api/stats roundtrip');
    } finally {
        cleanup(h);
    }
}

async function caseCloudWithoutCredential(): Promise<void> {
    console.log('— Case 2: cloud mode without Dataplane credential (expect exit 78) —');
    let h: DaemonHandle | null = null;
    try {
        h = await spawnDaemon({ mode: 'cloud' });
        // Daemon should exit with code 78 (EX_CONFIG) before becoming
        // ready. Wait for the full 'close' event (fires AFTER stdio
        // streams have drained) so h.log.text has the complete message.
        // Race against the readiness poll to catch the wrong outcome
        // where the daemon somehow booted.
        const outcome = await Promise.race<{ kind: 'ready' } | { kind: 'closed'; code: number | null }>([
            waitForReady(h.port, 8000).then(() => ({ kind: 'ready' as const })),
            new Promise((resolve) => {
                h!.proc.on('close', (code) => resolve({ kind: 'closed' as const, code }));
            }),
        ]);
        assert.equal(outcome.kind, 'closed', 'daemon must exit, not become ready, in cloud mode without credentials');
        if (outcome.kind === 'closed') {
            assert.equal(outcome.code, 78, `expected EX_CONFIG (78), got ${outcome.code}`);
        }
        assert.ok(
            /cloud mode requires a Dataplane credential/i.test(h.log.text),
            `expected helpful error in stderr; got:\n${h.log.text}`,
        );
        console.log('  ok  cloud-no-creds: exit=78 + helpful stderr message');
    } finally {
        cleanup(h);
    }
}

async function caseCloudWithCredential(): Promise<void> {
    console.log('— Case 3: cloud mode with env-sourced credential —');
    let h: DaemonHandle | null = null;
    try {
        h = await spawnDaemon({ mode: 'cloud', dataplaneApiKey: 'q2-1-smoke-test-key' });
        const ready = await waitForReady(h.port);
        if (!ready) throw new Error(`daemon never became ready\nSTDERR:\n${h.log.text}`);
        h.token = await fetchAuthToken(h.port);
        const origin = `http://127.0.0.1:${h.port}`;
        const authHdr = { Authorization: `Bearer ${h.token}`, Origin: origin };

        // health reports mode=cloud.
        const healthRes = await fetch(`http://127.0.0.1:${h.port}/api/health`, { headers: { Origin: origin } });
        const health = await healthRes.json() as { deploymentMode?: string };
        assert.equal(health.deploymentMode, 'cloud', `expected deploymentMode=cloud, got ${health.deploymentMode}`);

        // /api/node WITHOUT X-Lore-Workspace → 400 workspace_header_required.
        const missingHeader = await fetch(`http://127.0.0.1:${h.port}/api/node`, {
            method: 'POST',
            headers: { ...authHdr, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'q2-1-smoke-cloud-reject', type: 'note', label: 'rejected' }),
        });
        assert.equal(missingHeader.status, 400, `expected 400, got ${missingHeader.status}`);
        const rejBody = await missingHeader.json() as { code?: string };
        assert.equal(rejBody.code, 'workspace_header_required', `expected workspace_header_required, got ${rejBody.code}`);

        // /api/node WITH X-Lore-Workspace → 200 and stats roundtrip.
        const cloudNodeId = 'q2-1-smoke-cloud';
        const ingest = await fetch(`http://127.0.0.1:${h.port}/api/node`, {
            method: 'POST',
            headers: { ...authHdr, 'Content-Type': 'application/json', 'X-Lore-Workspace': 'tenant-alpha' },
            body: JSON.stringify({
                id: cloudNodeId,
                type: 'note',
                label: 'Q2.1 smoke — cloud mode',
                content: 'tenant-alpha content',
                tags: 'q2-1,smoke,cloud',
                project: 'groundfloor-lore',
            }),
        });
        assert.equal(ingest.status, 200, `ingest failed: ${ingest.status}`);

        const stats = await fetch(`http://127.0.0.1:${h.port}/api/stats`, {
            headers: { ...authHdr, 'X-Lore-Workspace': 'tenant-alpha' },
        });
        assert.equal(stats.status, 200);
        const s = await stats.json() as { nodeCount?: number };
        assert.ok((s.nodeCount ?? 0) >= 1, `expected ≥1 node, got ${s.nodeCount}`);
        console.log('  ok  cloud-with-creds: boot → mode=cloud → reject-no-header → accept-with-header → roundtrip');
    } finally {
        cleanup(h);
    }
}

async function main(): Promise<void> {
    console.log('Q2.1 — Server Mode smoke test');
    console.log('='.repeat(72));
    await caseLocalMode();
    await caseCloudWithoutCredential();
    await caseCloudWithCredential();
    console.log('');
    console.log('all Q2.1 cases passed ✓');
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});
