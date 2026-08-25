#!/usr/bin/env tsx
/**
 * test/E2-perf-1000-bulk.ts — Sprint E2 perf marker for E-D8.
 *
 * Drives `tryBulkWriteRoutes` with 1000 nodes against an in-memory
 * recording fake graph + verbatim + outbox, default embed-mode
 * 'queued'. Measures wall-time end-to-end through the producer side
 * (per the E-D8 contract: 1000-row bulk producer write < 5000 ms).
 *
 * The measurement is intentionally producer-only — the replicator
 * pickup + actual embed work happens async on the daemon tick, NOT in
 * this hot-path call. Pre-Sprint-E baseline (W9 + inline embed) was
 * 9644 ms for the same shape; the queued-mode default cuts the embed
 * blocking and the producer write completes well under the ceiling.
 *
 * Test daemon perf can be noisy; we run the bulk 5 times and report
 * median + min + max so the marker doc has a defensible number.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';
import type { OutboxEntry, OutboxStore } from '../packages/lore/src/outbox/types.js';

interface FakeNode { id: string; type: string; label: string }
function makeFakeGraph() {
    return {
        async upsertNode(n: FakeNode) {
            return { ...n, project: '*', ecosystem: '*', updatedAt: new Date().toISOString() };
        },
        async addEdge() { /* unused */ },
        async addBidirectionalEdge() { /* unused */ },
        async deleteNode() { return false; },
        async search() { return []; },
    };
}
function makeFakeVerbatim() {
    return {
        async store() { /* unused in queued mode */ },
        async tombstone() {},
        async delete() {},
    };
}
function makeFakeOutbox(): OutboxStore {
    const entries: OutboxEntry[] = [];
    const store: Partial<OutboxStore> = {
        async record(e: OutboxEntry) { entries.push(e); },
        async batchRecord(es: OutboxEntry[]) { for (const e of es) entries.push(e); },
    };
    return store as OutboxStore;
}
function req(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
function res(): ServerResponse & { _status: number; _body: string } {
    const r = { _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}

const RUNS = 5;
const N = 1000;
const timings: number[] = [];

for (let run = 0; run < RUNS; run++) {
    const graph = makeFakeGraph();
    const verbatim = makeFakeVerbatim();
    const outbox = makeFakeOutbox();
    const nodes = Array.from({ length: N }, (_, i) => ({
        id: `perf-${run}-${i}`, type: 'decision',
        label: `Perf ${run}-${i}`, content: `body content ${i} `.repeat(8), tags: 'perf',
    }));
    const r = res();
    const t0 = Date.now();
    await tryBulkWriteRoutes(
        req(JSON.stringify({ workspace: 'wsPerf', nodes })),
        r, '/api/nodes/bulk', '/api/nodes/bulk',
        {
            deploymentMode: 'local', dataplane: null,
            store: { loreGraph: graph, loreVerbatim: verbatim } as never,
            auditLog: { log: () => undefined } as never,
            outboxStore: outbox,
        } as never,
    );
    const dt = Date.now() - t0;
    timings.push(dt);
    if (r._status !== 200) {
        console.error(`run ${run}: status ${r._status} body=${r._body.slice(0, 200)}`);
        process.exit(1);
    }
    const body = JSON.parse(r._body);
    if (body.succeeded !== N) {
        console.error(`run ${run}: succeeded=${body.succeeded} != ${N}`);
        process.exit(1);
    }
}

timings.sort((a, b) => a - b);
const median = timings[Math.floor(timings.length / 2)]!;
const min = timings[0]!;
const max = timings[timings.length - 1]!;
console.log(`E2 1000-node bulk skip-embed perf (queued mode default, N=${RUNS} runs):`);
console.log(`  median: ${median} ms`);
console.log(`  min:    ${min} ms`);
console.log(`  max:    ${max} ms`);
console.log(`  ceiling (E-D8): 5000 ms`);
console.log(`  pre-Sprint-E baseline (W9 inline): 9644 ms`);
if (median >= 5000) {
    console.error(`FAIL: median ${median} ms >= 5000 ms ceiling`);
    process.exit(1);
}
console.log(`PASS: median ${median} ms < 5000 ms ceiling`);
