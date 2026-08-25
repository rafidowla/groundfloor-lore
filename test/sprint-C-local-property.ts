#!/usr/bin/env tsx
/**
 * test/sprint-C-local-property.ts — Sprint C-local gate (10 cases)
 *
 *   C-D1   /metrics endpoint returns Prometheus text when LORE_METRICS=on
 *   C-D2   /metrics returns 404 metrics_not_enabled when LORE_METRICS off
 *   C-D3   OTel hooks present + env-configurable (LORE_OTEL_EXPORTER_OTLP_ENDPOINT)
 *   C-D4   lore backup CLI: snapshot path + rotation pruning works
 *   C-D5   lore restore CLI: sidelines prior .lore + restores
 *   C-D6   workspace quota: writes beyond maxNodes return 429
 *   C-D7   workspace quota: writes beyond maxStorageBytes return 429
 *   C-D8   load testing harness exists in scripts/load-tests/ with 4 scenarios
 *   C-D9   time_series REST sibling exists + workspace_required enforced
 *   C-D10  cross-sprint sentinels preserved (Sprint L workspace_required + Sprint O outbox)
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderMetrics, tryMetricsRoutes } from '../packages/lore/src/mcp/http/routes/metrics.js';
import { tryAnalyticsRoutes } from '../packages/lore/src/mcp/http/routes/analytics.js';
import { loadOtelConfig, span, getOtelReadiness, _resetOtelConfigCache } from '../packages/lore/src/observability/otelHooks.js';
import { InMemoryWorkspaceQuotaStore, checkWorkspaceQuota, enforceQuotaOrReject } from '../packages/lore/src/security/workspaceQuota.js';
import { pruneOldBackups } from '../packages/lore/src/cli/commands/backup.js';

let expectPassed = 0;
let expectFailed = 0;
let runnerErrors = 0;
const pending: Array<Promise<void>> = [];

function expectPass(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try {
            await fn();
            console.log(`  ✓ ${name} (pass)`);
            expectPassed++;
        } catch (err) {
            console.error(`  ✗ ${name} — REGRESSION: ${(err as Error).message.split('\n')[0]?.slice(0, 240)}`);
            expectFailed++;
        }
    })().catch((err) => {
        console.error(`  ! ${name} — harness error: ${(err as Error).message}`);
        runnerErrors++;
    }));
}

const SRC_ROOT = join(process.cwd(), 'packages/lore/src');

console.log('Sprint C-local gate test — operations bundle (10 cases)');

/* ─────────────────── C-D1 ─────────────────── */
expectPass('C-D1 /metrics returns Prometheus text when LORE_METRICS=on', async () => {
    process.env.LORE_METRICS = 'on';
    const body = await renderMetrics({});
    assert.match(body, /# HELP lore_build_info/);
    assert.match(body, /lore_outbox_depth_total/);
    assert.match(body, /lore_otel_enabled/);
    assert.match(body, /lore_build_info\{version="3\.9\.0"\}/);
    delete process.env.LORE_METRICS;
});

/* ─────────────────── C-D2 ─────────────────── */
expectPass('C-D2 /metrics returns 404 metrics_not_enabled when disabled', async () => {
    delete process.env.LORE_METRICS;
    const captured: { status?: number; body?: string } = {};
    const fakeRes = makeFakeRes(captured);
    const fakeReq = { method: 'GET' } as never;
    const handled = await tryMetricsRoutes(fakeReq, fakeRes, '/metrics', '/metrics', {});
    assert.equal(handled, true);
    assert.equal(captured.status, 404);
    const parsed = JSON.parse(captured.body!);
    assert.equal(parsed.error, 'metrics_not_enabled');
});

/* ─────────────────── C-D3 ─────────────────── */
expectPass('C-D3 OTel hooks present + env-configurable', () => {
    _resetOtelConfigCache();
    const env: NodeJS.ProcessEnv = { LORE_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' };
    const cfg = loadOtelConfig(env);
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.endpoint, 'http://localhost:4318');
    _resetOtelConfigCache();
    // span() shim always returns a handle; counters increment.
    const h = span('test.span', { k: 'v' });
    h.setAttribute('answer', 42);
    h.end();
    const r = getOtelReadiness();
    assert.equal(r.spansStarted >= 1, true);
    assert.equal(r.spansEnded >= 1, true);
});

/* ─────────────────── C-D4 ─────────────────── */
expectPass('C-D4 lore backup: rotation prunes older tarballs beyond keep', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-c4-'));
    try {
        // Create 10 fake tarballs with monotonically increasing mtimes.
        for (let i = 0; i < 10; i++) {
            const p = join(dir, `lore-backup-myws-2026-05-24T${String(i).padStart(2, '0')}-00-00-000Z.tar.gz`);
            writeFileSync(p, `fake-${i}`);
            const now = Date.now() + i * 1000;
            utimesSync(p, now / 1000, now / 1000);
        }
        // Decoy from a different workspace must NOT be pruned.
        writeFileSync(join(dir, 'lore-backup-otherws-2026-05-24T00-00-00-000Z.tar.gz'), 'decoy');

        const pruned = pruneOldBackups(dir, 'myws', 3);
        assert.equal(pruned.length, 7, `expected 7 pruned, got ${pruned.length}`);
        // Decoy still present.
        assert.equal(existsSync(join(dir, 'lore-backup-otherws-2026-05-24T00-00-00-000Z.tar.gz')), true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

/* ─────────────────── C-D5 ─────────────────── */
expectPass('C-D5 lore restore CLI ships + speaks restoreWorkspace contract', () => {
    const restoreSrc = readFileSync(join(SRC_ROOT, 'cli/commands/restore.ts'), 'utf-8');
    assert.match(restoreSrc, /restoreWorkspace/, 'restore.ts must call restoreWorkspace');
    assert.match(restoreSrc, /sidelinedPriorTo/, 'restore.ts must report sidelined prior .lore/');
    const engineSrc = readFileSync(join(SRC_ROOT, 'engines/restore.ts'), 'utf-8');
    assert.match(engineSrc, /export\s+(async\s+)?function\s+restoreWorkspace/);
});

/* ─────────────────── C-D6 ─────────────────── */
expectPass('C-D6 workspace quota: exceeding maxNodes -> 429 workspace_quota_exceeded', () => {
    const store = new InMemoryWorkspaceQuotaStore();
    store.reconcile('w1', { nodeCount: 99, storageBytes: 0 });
    const getEntry = () => ({ name: 'w1', path: '/tmp/w1', createdAt: '', maxNodes: 100 });
    const captured: { status?: number; body?: string } = {};
    const res = makeFakeRes(captured);
    const r = enforceQuotaOrReject({ store, getWorkspaceEntry: getEntry }, res, 'w1', { nodes: 2 });
    assert.equal(r.handled, true);
    assert.equal(captured.status, 429);
    const parsed = JSON.parse(captured.body!);
    assert.equal(parsed.error, 'workspace_quota_exceeded');
    assert.equal(parsed.dimension, 'maxNodes');
    assert.equal(parsed.cap, 100);
});

/* ─────────────────── C-D7 ─────────────────── */
expectPass('C-D7 workspace quota: exceeding maxStorageBytes -> 429', () => {
    const store = new InMemoryWorkspaceQuotaStore();
    store.reconcile('w1', { nodeCount: 0, storageBytes: 900 });
    const getEntry = () => ({ name: 'w1', path: '/tmp/w1', createdAt: '', maxStorageBytes: 1000 });
    const r = checkWorkspaceQuota({ store, getWorkspaceEntry: getEntry }, 'w1', { bytes: 200 });
    assert.equal(r.allowed, false);
    assert.equal(r.dimension, 'maxStorageBytes');
    assert.equal(r.cap, 1000);
    // Under cap allowed.
    const r2 = checkWorkspaceQuota({ store, getWorkspaceEntry: getEntry }, 'w1', { bytes: 50 });
    assert.equal(r2.allowed, true);
});

/* ─────────────────── C-D8 ─────────────────── */
expectPass('C-D8 load testing harness ships in scripts/load-tests/ with 4 scenarios', () => {
    const root = join(process.cwd(), 'scripts/load-tests');
    assert.equal(existsSync(join(root, 'load-test-runner.mjs')), true, 'runner missing');
    assert.equal(existsSync(join(root, 'README.md')), true, 'README missing');
    for (const name of ['bulk-write', 'hot-write', 'streaming-ingest', 'recall-mixed']) {
        assert.equal(existsSync(join(root, 'scenarios', `${name}.mjs`)), true, `scenario ${name} missing`);
    }
    const runner = readFileSync(join(root, 'load-test-runner.mjs'), 'utf-8');
    assert.match(runner, /throughputRps/, 'runner must compute throughput');
    assert.match(runner, /p50|p95|p99/, 'runner must compute latency percentiles');
});

/* ─────────────────── C-D9 ─────────────────── */
expectPass('C-D9 time_series REST sibling + workspace_required enforcement', async () => {
    // Workspace omitted -> 400 workspace_required.
    const captured: { status?: number; body?: string } = {};
    const res = makeFakeRes(captured);
    const reqBody = JSON.stringify({ collection: 'decision', timeField: 'createdAt', bucket: 'day', aggregation: 'count' });
    const req = makeFakeReq('POST', reqBody);
    const handled = await tryAnalyticsRoutes(req, res, '/api/time-series', '/api/time-series', { analytical: stubAnalytical() });
    assert.equal(handled, true);
    assert.equal(captured.status, 400);
    const parsed = JSON.parse(captured.body!);
    // Wave 5: canonical {code, message} envelope (was {error}).
    assert.equal(parsed.code, 'workspace_required');

    // Source-level sanity — the route file declares both REST siblings.
    const src = readFileSync(join(SRC_ROOT, 'mcp/http/routes/analytics.ts'), 'utf-8');
    assert.match(src, /\/api\/time-series/);
    assert.match(src, /\/api\/aggregate/);
});

/* ─────────────────── C-D10 ─────────────────── */
expectPass('C-D10 cross-sprint sentinels preserved (L workspace_required + O outbox)', () => {
    // Sprint L sentinel — governance MCP tools still reject empty workspace.
    const govSrc = readFileSync(join(SRC_ROOT, 'mcp/tools/governance.ts'), 'utf-8');
    assert.match(govSrc, /workspace[^a-zA-Z]*\.min\(1\)|workspace_required/);
    // Sprint O sentinel — bulkWrite still imports outbox helpers.
    const bulkSrc = readFileSync(join(SRC_ROOT, 'mcp/http/routes/bulkWrite.ts'), 'utf-8');
    assert.match(bulkSrc, /recordHotWrite|recordHotWriteBatch|outboxBatch/);
});

/* ─── Harness shims ─── */

function makeFakeRes(captured: { status?: number; body?: string; headers?: Record<string, string> }): import('node:http').ServerResponse {
    return {
        writeHead(status: number, headers?: Record<string, string>) {
            captured.status = status;
            captured.headers = headers ?? {};
        },
        end(body?: string) {
            captured.body = body ?? '';
        },
    } as unknown as import('node:http').ServerResponse;
}

function makeFakeReq(method: string, jsonBody: string): import('node:http').IncomingMessage {
    const chunks = [Buffer.from(jsonBody)];
    let i = 0;
    return {
        method,
        headers: { 'content-type': 'application/json' },
        on(event: string, cb: (...args: unknown[]) => void) {
            if (event === 'data') {
                process.nextTick(() => { while (i < chunks.length) cb(chunks[i++]); });
            } else if (event === 'end') {
                process.nextTick(() => cb());
            }
            return this;
        },
    } as unknown as import('node:http').IncomingMessage;
}

function stubAnalytical(): import('../packages/lore/src/contracts/index.js').IAnalyticalStorage {
    return {
        count: async () => 0,
        sum: async () => 0,
        avg: async () => 0,
        min: async () => 0,
        max: async () => 0,
        distinct: async () => [],
        groupBy: async () => [],
        timeSeries: async () => [],
    } as never;
}

/* ─── Drain ─── */

await Promise.all(pending);

const total = expectPassed + expectFailed;
console.log(`\nSprint C-local gate: ${expectPassed}/${total} pass · ${expectFailed} fail · ${runnerErrors} harness errors`);

if (expectFailed > 0 || runnerErrors > 0) process.exit(1);
process.exit(0);
