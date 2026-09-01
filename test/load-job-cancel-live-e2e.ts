#!/usr/bin/env tsx
/**
 * Live-daemon cancel: POST /api/load then POST /api/load/jobs/<id>/cancel
 * against a real --http process (isolated HOME, free port).
 */

import assert from 'node:assert/strict';
import { spawnDaemon, waitForReady, fetchAuthToken, cleanup, type DaemonHandle } from './helpers/live-daemon.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

console.log('Live-daemon load-job cancel E2E');

await test('POST /api/load then cancel — job never completes', async () => {
    let h: DaemonHandle | null = null;
    try {
        h = await spawnDaemon();
        const ready = await waitForReady(h.port, 60_000);
        assert.ok(ready, `daemon never became ready\n${h.log.text}`);
        h.token = await fetchAuthToken(h.port, h.home);
        const base = `http://127.0.0.1:${h.port}`;
        const origin = base;
        const auth = { Authorization: `Bearer ${h.token}`, Origin: origin };
        const seed = await fetch(`${base}/api/node`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: 'live-cancel-seed', type: 'note', label: 'seed',
                content: 'ensure default workspace exists', workspace: 'default',
            }),
        });
        assert.ok(seed.status === 200 || seed.status === 201, `seed node failed ${seed.status}`);
        const lines = Array.from({ length: 20_000 }, (_, i) => JSON.stringify({ id: `live-${i}`, text: `row ${i} live cancel` }));
        const body = lines.join('\n') + '\n';
        const load = await fetch(`${base}/api/load?workspace=default&format=jsonl&embed=skip&target=verbatim`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/x-ndjson' },
            body,
        });
        const loadText = await load.text();
        assert.equal(load.status, 200, `POST /api/load failed ${load.status} ${loadText}`);
        const created = JSON.parse(loadText) as { job_id?: string; status?: string };
        assert.ok(created.job_id, loadText);
        const jobId = created.job_id!;

        let pre = '';
        for (let i = 0; i < 30; i++) {
            const get = await fetch(`${base}/api/load/jobs/${jobId}`, { headers: auth });
            const job = await get.json() as { status?: string };
            pre = job.status ?? '';
            if (pre === 'running' || pre === 'complete' || pre === 'failed' || pre === 'cancelled') break;
            await new Promise((r) => setTimeout(r, 50));
        }
        const cancel = await fetch(`${base}/api/load/jobs/${jobId}/cancel`, {
            method: 'POST',
            headers: auth,
        });
        const cancelText = await cancel.text();
        assert.equal(cancel.status, 200, `cancel ${cancel.status} after job was ${pre}: ${cancelText}`);
        const cancelledBody = JSON.parse(cancelText) as { status?: string };
        assert.equal(cancelledBody.status, 'cancelled');

        let status = '';
        for (let i = 0; i < 40; i++) {
            const get = await fetch(`${base}/api/load/jobs/${jobId}`, { headers: auth });
            const getText = await get.text();
            assert.equal(get.status, 200, getText);
            const job = JSON.parse(getText) as { status?: string };
            status = job.status ?? '';
            if (status === 'cancelled' || status === 'complete' || status === 'failed') break;
            await new Promise((r) => setTimeout(r, 150));
        }
        assert.equal(status, 'cancelled', `job ended as ${status}, not cancelled`);
    } finally {
        cleanup(h);
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
