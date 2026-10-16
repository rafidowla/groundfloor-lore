#!/usr/bin/env tsx
/**
 * test/readiness335-ready-local-e2e.ts - 3.35.0 (e) readiness: /ready in LOCAL mode on a real daemon.
 *
 *   1. healthy: /ready and /api/ready -> 200 {status:'ready', mode:'local'}, anonymous, Cache-Control: no-store
 *   2. store broken (SqliteGraph reads fail with an I/O error, injected by a preload that watches a flag file):
 *      /ready -> 503 {status:'not_ready'} + Retry-After: 2 + no-store; the anonymous body carries no reason or
 *      detail, an operator bearer gets reason 'unavailable'; /health stays 200 the whole time; a node write
 *      is also refused (so 503 means what it says)
 *   3. store recovers: /ready is 200 again without a restart, and a write lands
 *
 * Real daemon, isolated HOME, free port. LORE_READY_CACHE_MS=100 shortens the probe cache.
 * Run: npx tsx test/readiness335-ready-local-e2e.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup } from './helpers/live-daemon.js';
import { apiFor, bootDaemon, makeChecker, waitFor } from './helpers/readiness335.js';

const { check, finish } = makeChecker('3.35.0 readiness: /ready in local mode (200 -> broken store 503 -> recovered 200)');
const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'ready-fault-preload.ts');

async function main(): Promise<void> {
    const flagDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-fault-'));
    const flag = path.join(flagDir, 'broken');
    const h = await bootDaemon({
        nodeArgs: ['--import', PRELOAD],
        env: { LORE_READY_FAULT_FLAG: flag, LORE_READY_CACHE_MS: '100' },
    });
    try {
        const api = apiFor(h);

        // 1. healthy
        for (const p of ['/ready', '/api/ready']) {
            const r = await api.get(p, false);
            check(`healthy ${p} -> 200 ready, mode local`, r.status === 200 && r.body?.status === 'ready' && r.body?.mode === 'local', r.text);
            check(`healthy ${p}: Cache-Control no-store`, (r.headers.get('cache-control') ?? '').includes('no-store'));
        }
        const hz = await api.get('/health', false);
        check('healthy /health -> 200', hz.status === 200);
        const w0 = await api.post('/api/node', { id: 'rdy-before', type: 'note', label: 'before', content: 'healthy write', workspace: 'default' });
        check('healthy write lands', w0.status === 200 || w0.status === 201, w0.text);

        // 2. break the store
        fs.writeFileSync(flag, 'x');
        const notReady = await waitFor(async () => {
            const r = await api.get('/ready', false);
            return r.status === 503 ? r : null;
        }, 10_000, '/ready -> 503 once the store is broken');
        check('broken: /ready -> 503 not_ready', notReady.body?.status === 'not_ready', notReady.text);
        check('broken: Retry-After 2', notReady.headers.get('retry-after') === '2', String(notReady.headers.get('retry-after')));
        check('broken: Cache-Control no-store', (notReady.headers.get('cache-control') ?? '').includes('no-store'));
        check('broken: anonymous body exposes no reason/detail', notReady.body?.reason === undefined && notReady.body?.detail === undefined, notReady.text);
        const alias = await api.get('/api/ready', false);
        check('broken: /api/ready alias -> 503 too', alias.status === 503);
        const op = await api.get('/ready', true);
        check('broken: operator bearer sees reason "unavailable"', op.status === 503 && op.body?.reason === 'unavailable', op.text);
        const hzBroken = await api.get('/health', false);
        check('broken: /health STAYS 200 (liveness never depends on the store)', hzBroken.status === 200);
        const wBroken = await api.post('/api/node', { id: 'rdy-during', type: 'note', label: 'during', content: 'write while broken', workspace: 'default' });
        check('broken: a node write is refused (not 2xx)', wBroken.status >= 400, `${wBroken.status} ${wBroken.text.slice(0, 200)}`);

        // 3. recover
        fs.rmSync(flag);
        const back = await waitFor(async () => {
            const r = await api.get('/ready', false);
            return r.status === 200 ? r : null;
        }, 10_000, '/ready -> 200 after recovery');
        check('recovered: /ready -> 200 ready without a restart', back.body?.status === 'ready' && back.body?.mode === 'local', back.text);
        const w1 = await api.post('/api/node', { id: 'rdy-after', type: 'note', label: 'after', content: 'write after recovery', workspace: 'default' });
        check('recovered: a write lands', w1.status === 200 || w1.status === 201, w1.text);
        const rb = await api.get('/api/node-full?id=rdy-before&workspace=default');
        const rd = await api.get('/api/node-full?id=rdy-during&workspace=default');
        check('recovered: pre-fault data intact; the refused write left nothing', rb.body?.found === true && rd.body?.found === false);
    } catch (err) {
        check('suite ran without throwing', false, (err as Error).stack ?? String(err));
        console.error(`--- daemon log tail ---\n${h.log.text.slice(-2500)}`);
    } finally {
        cleanup(h);
        fs.rmSync(flagDir, { recursive: true, force: true });
    }
    finish();
}

await main();
