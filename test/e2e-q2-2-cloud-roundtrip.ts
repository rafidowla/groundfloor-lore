#!/usr/bin/env tsx
/**
 * e2e-q2-2-cloud-roundtrip.ts — Q2.2 cloud-mode roundtrip (slices 2 + 3 + 4).
 *
 * Q2.2 wires both a graph adapter (slice 2) and a vector-store adapter
 * (slice 3) behind the Q2.1 mode flag. This e2e exercises the full
 * singleton-daemon path against an in-memory mock Dataplane:
 *
 *   Case A — two-tenant isolation (slice 2 graph):
 *     Store node "node-alpha" as tenant "tenant-alpha".
 *     Store node "node-beta" as tenant "tenant-beta".
 *     Stats for each tenant reflect only that tenant's nodes.
 *     Cross-tenant read of node-alpha as tenant-beta → 404.
 *     Verifies AsyncLocalStorage correctly propagates tenant through
 *     the HTTP handler into DataplaneGraph.tenantProvider().
 *
 *   Case B — upsert idempotency (slice 2 graph):
 *     Re-store "node-alpha" with updated label. Snapshot shows count
 *     unchanged (no duplicate row).
 *
 *   Case C — vector-store tenant isolation (slice 3):
 *     Each ingest also fires a verbatim write (embed → insert into
 *     lore_verbatim via DataplaneVectorStore). Snapshot must show:
 *       - tenant-alpha has a lore_verbatim collection with the alpha row
 *       - tenant-beta has a lore_verbatim collection with the beta row
 *       - neither bucket leaks into the other
 *     /api/stats for each tenant must carry verbatimDocuments=1. This
 *     verifies cloud-mode VectorStore factory + tenant-routed embed +
 *     upsert-via-updateByQuery+insert.
 *
 *   Case D — vector-store upsert idempotency (slice 3):
 *     Re-store "node-alpha". lore_verbatim row count stays at 1 (the
 *     updateByQuery → insert-on-0 path is idempotent across writes).
 *
 *   Case E — plugin cloud-schema provisioning (slice 4):
 *     Default config has the `developer` plugin active. Cloud mode wires
 *     its `registerCloudSchema` hook into DataplaneGraph on boot; each
 *     tenant's first touch fans out the 7 developer collections
 *     (developer_code_symbol, developer_code_file, etc.) alongside the
 *     core lore_node + lore_edge. Mock snapshot must show all
 *     DEVELOPER_CLOUD_COLLECTIONS in both tenant-alpha and tenant-beta.
 *     (Cypher→AQL op routing deferred to a follow-up slice; this case
 *     covers schema parity only.)
 *
 * The mock Dataplane is the test/helpers/mock-dataplane.ts shim.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { startMockDataplane, type MockDataplane } from './helpers/mock-dataplane.js';
import { DEVELOPER_CLOUD_COLLECTIONS } from '../packages/lore-plugin-developer/src/cloudSchema.js';

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
                srv.close(() => reject(new Error('no free port')));
            }
        });
    });
}

interface DaemonHandle {
    proc: ChildProcessWithoutNullStreams;
    home: string;
    port: number;
    token: string;
    log: { text: string };
}

async function waitForReady(port: number, timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            if (res.ok) return true;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 150));
    }
    return false;
}

async function spawnCloudDaemon(dataplaneUrl: string): Promise<DaemonHandle> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-q2-2-'));
    const port = await findFreePort();
    const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: os.tmpdir(),
        LORE_PORT: String(port),
        LORE_DEPLOYMENT_MODE: 'cloud',
        DATAPLANE_API_KEY: 'q2-2-test-key',
        DATAPLANE_URL: dataplaneUrl,
        DATAPLANE_ORG_ID: 'org-q2-2',
    };
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

async function main(): Promise<void> {
    console.log('Q2.2 slices 2+3 — cloud roundtrip (DataplaneGraph + DataplaneVectorStore, AsyncLocalStorage tenant routing)');
    console.log('='.repeat(72));

    const mock: MockDataplane = await startMockDataplane();
    console.log(`  mock Dataplane at ${mock.url}`);

    let h: DaemonHandle | null = null;
    try {
        h = await spawnCloudDaemon(mock.url);
        const ready = await waitForReady(h.port);
        if (!ready) throw new Error(`daemon never ready\nSTDERR:\n${h.log.text}`);
        h.token = await fetchAuthToken(h.port);

        const origin = `http://127.0.0.1:${h.port}`;
        const baseHdr = { Authorization: `Bearer ${h.token}`, Origin: origin, 'Content-Type': 'application/json' };
        const hdrAlpha = { ...baseHdr, 'X-Lore-Workspace': 'tenant-alpha' };
        const hdrBeta = { ...baseHdr, 'X-Lore-Workspace': 'tenant-beta' };

        // — Case A: two-tenant isolation —
        console.log('— Case A: two-tenant isolation —');

        // Ingest node-alpha as tenant-alpha.
        const rAlpha = await fetch(`http://127.0.0.1:${h.port}/api/node`, {
            method: 'POST',
            headers: hdrAlpha,
            body: JSON.stringify({
                id: 'node-alpha',
                type: 'note',
                label: 'Alpha tenant node',
                content: 'alpha content',
                tags: 'q2-2,alpha',
                project: 'groundfloor-lore',
            }),
        });
        assert.equal(rAlpha.status, 200, `tenant-alpha ingest failed: ${rAlpha.status} ${await rAlpha.text()}`);

        // Ingest node-beta as tenant-beta.
        const rBeta = await fetch(`http://127.0.0.1:${h.port}/api/node`, {
            method: 'POST',
            headers: hdrBeta,
            body: JSON.stringify({
                id: 'node-beta',
                type: 'note',
                label: 'Beta tenant node',
                content: 'beta content',
                tags: 'q2-2,beta',
                project: 'groundfloor-lore',
            }),
        });
        assert.equal(rBeta.status, 200, `tenant-beta ingest failed: ${rBeta.status} ${await rBeta.text()}`);

        // stats for tenant-alpha → nodeCount >=1 and beta node is NOT visible.
        const statsAlpha = await fetch(`http://127.0.0.1:${h.port}/api/stats`, { headers: hdrAlpha });
        assert.equal(statsAlpha.status, 200);
        const sAlpha = await statsAlpha.json() as { nodeCount?: number };
        assert.ok((sAlpha.nodeCount ?? 0) >= 1, `alpha expected >=1 node, got ${sAlpha.nodeCount}`);

        const statsBeta = await fetch(`http://127.0.0.1:${h.port}/api/stats`, { headers: hdrBeta });
        const sBeta = await statsBeta.json() as { nodeCount?: number };
        assert.ok((sBeta.nodeCount ?? 0) >= 1, `beta expected >=1 node, got ${sBeta.nodeCount}`);

        // Mock snapshot must show two tenants in the store.
        const snap = mock.snapshot();
        const alphaBucket = snap.tenants.find((t) => t.tenantId === 'tenant-alpha');
        const betaBucket = snap.tenants.find((t) => t.tenantId === 'tenant-beta');
        assert.ok(alphaBucket, 'mock must have tenant-alpha bucket');
        assert.ok(betaBucket, 'mock must have tenant-beta bucket');
        const alphaNodes = alphaBucket?.collections.find((c) => c.name === 'lore_node')?.count ?? 0;
        const betaNodes = betaBucket?.collections.find((c) => c.name === 'lore_node')?.count ?? 0;
        assert.equal(alphaNodes, 1, `tenant-alpha expected 1 node in mock, got ${alphaNodes}`);
        assert.equal(betaNodes, 1, `tenant-beta expected 1 node in mock, got ${betaNodes}`);

        // Cross-tenant read: ask for node-alpha while posing as tenant-beta.
        // Routed through getNode via GET /api/node?id=node-alpha. Tenant-beta's
        // collection doesn't have node-alpha, so the handler returns 404.
        const crossRead = await fetch(
            `http://127.0.0.1:${h.port}/api/node?id=node-alpha`,
            { headers: hdrBeta },
        );
        assert.equal(crossRead.status, 404, `cross-tenant read must 404 for tenant-beta; got ${crossRead.status}`);
        console.log('  ok  two-tenant isolation: tenant buckets distinct, cross-tenant read denied');

        // — Case B: upsert idempotency (graph) —
        console.log('— Case B: upsert idempotency (graph) —');
        const rAlpha2 = await fetch(`http://127.0.0.1:${h.port}/api/node`, {
            method: 'POST',
            headers: hdrAlpha,
            body: JSON.stringify({
                id: 'node-alpha',
                type: 'note',
                label: 'Alpha tenant node — UPDATED',
                content: 'alpha content v2',
                tags: 'q2-2,alpha,updated',
                project: 'groundfloor-lore',
            }),
        });
        assert.equal(rAlpha2.status, 200, `tenant-alpha re-ingest failed: ${rAlpha2.status}`);
        const snap2 = mock.snapshot();
        const alphaNodes2 = snap2.tenants
            .find((t) => t.tenantId === 'tenant-alpha')
            ?.collections.find((c) => c.name === 'lore_node')?.count ?? 0;
        assert.equal(alphaNodes2, 1, `upsert should not duplicate; got ${alphaNodes2} nodes`);
        console.log('  ok  upsert idempotency: second store_node does not duplicate');

        // — Case C: vector-store tenant isolation (slice 3) —
        console.log('— Case C: vector-store tenant isolation (slice 3) —');
        // DataplaneVectorStore.store runs async from the ingest handler
        // (fire-and-forget). Poll briefly for the write to land in the mock.
        // First run downloads the Xenova/all-MiniLM-L6-v2 embedder
        // (~90 MB) before the store() call can resolve. Allow up to 120s.
        const vectorReady = await (async () => {
            const deadline = Date.now() + 120_000;
            while (Date.now() < deadline) {
                const s = mock.snapshot();
                const a = s.tenants.find((t) => t.tenantId === 'tenant-alpha')
                    ?.collections.find((c) => c.name === 'lore_verbatim')?.count ?? 0;
                const b = s.tenants.find((t) => t.tenantId === 'tenant-beta')
                    ?.collections.find((c) => c.name === 'lore_verbatim')?.count ?? 0;
                if (a >= 1 && b >= 1) return true;
                await new Promise((r) => setTimeout(r, 500));
            }
            return false;
        })();
        if (!vectorReady) {
            // Spill the daemon log so CI can see why the write didn't happen.
            console.error('daemon log (tail):\n' + (h?.log.text.slice(-4000) ?? '(no log)'));
        }
        assert.ok(vectorReady, 'vector-store writes did not land within 120s');
        const snap3 = mock.snapshot();
        const alphaVerbatim = snap3.tenants.find((t) => t.tenantId === 'tenant-alpha')
            ?.collections.find((c) => c.name === 'lore_verbatim')?.count ?? 0;
        const betaVerbatim = snap3.tenants.find((t) => t.tenantId === 'tenant-beta')
            ?.collections.find((c) => c.name === 'lore_verbatim')?.count ?? 0;
        assert.equal(alphaVerbatim, 1, `tenant-alpha expected 1 verbatim row, got ${alphaVerbatim}`);
        assert.equal(betaVerbatim, 1, `tenant-beta expected 1 verbatim row, got ${betaVerbatim}`);

        // /api/stats must report the tenant-scoped verbatim count.
        const statsAlpha2 = await fetch(`http://127.0.0.1:${h.port}/api/stats`, { headers: hdrAlpha });
        const sAlpha2 = await statsAlpha2.json() as { verbatimDocuments?: number };
        assert.equal(sAlpha2.verbatimDocuments, 1, `tenant-alpha verbatim count via /api/stats expected 1, got ${sAlpha2.verbatimDocuments}`);
        const statsBeta2 = await fetch(`http://127.0.0.1:${h.port}/api/stats`, { headers: hdrBeta });
        const sBeta2 = await statsBeta2.json() as { verbatimDocuments?: number };
        assert.equal(sBeta2.verbatimDocuments, 1, `tenant-beta verbatim count via /api/stats expected 1, got ${sBeta2.verbatimDocuments}`);
        console.log('  ok  vector tenant isolation: each tenant has exactly 1 verbatim row, stats agree');

        // — Case D: vector-store upsert idempotency (slice 3) —
        console.log('— Case D: vector-store upsert idempotency (slice 3) —');
        // Case B already did a re-ingest of node-alpha above — that also
        // should have fired an idempotent verbatim write via
        // DataplaneVectorStore.store (updateByQuery → insert on 0).
        // Give the async write a moment to settle, then confirm no dup.
        await new Promise((r) => setTimeout(r, 500));
        const snap4 = mock.snapshot();
        const alphaVerbatim2 = snap4.tenants.find((t) => t.tenantId === 'tenant-alpha')
            ?.collections.find((c) => c.name === 'lore_verbatim')?.count ?? 0;
        assert.equal(alphaVerbatim2, 1, `vector upsert should not duplicate; got ${alphaVerbatim2} rows`);
        console.log('  ok  vector upsert idempotency: re-ingest does not duplicate verbatim rows');

        // — Case E: plugin cloud-schema provisioning (slice 4) —
        console.log('— Case E: plugin cloud-schema provisioning (slice 4) —');
        // The developer plugin is active by default (configManager default
        // `plugins: ['developer']`). Cloud mode wires its registerCloudSchema
        // hook into DataplaneGraph.setPluginSchemaHooks, and pushSchemaFor
        // runs those hooks on each tenant's first touch. Cases A+C already
        // touched tenant-alpha and tenant-beta. Every developer collection
        // must therefore exist in both buckets (empty is fine — we're
        // verifying schema parity, not data).
        const snapPlugin = mock.snapshot();
        for (const tenant of ['tenant-alpha', 'tenant-beta']) {
            const bucket = snapPlugin.tenants.find((t) => t.tenantId === tenant);
            assert.ok(bucket, `plugin-schema: tenant ${tenant} must have a bucket`);
            const names = new Set(bucket!.collections.map((c) => c.name));
            for (const expected of DEVELOPER_CLOUD_COLLECTIONS) {
                assert.ok(
                    names.has(expected),
                    `plugin-schema: tenant ${tenant} missing collection "${expected}" (present: ${[...names].sort().join(', ')})`,
                );
            }
        }
        console.log(
            `  ok  plugin cloud schema: developer plugin's ${DEVELOPER_CLOUD_COLLECTIONS.length} ` +
            `collections provisioned in both tenant buckets`,
        );

        console.log('');
        console.log('all Q2.2 slice-2 + slice-3 + slice-4 cases passed ✓');
    } finally {
        cleanup(h);
        await mock.close();
    }
}

main().catch((err) => {
    console.error('FAIL:', err);
    process.exit(1);
});
