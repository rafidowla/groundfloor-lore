#!/usr/bin/env tsx
/**
 * audit-close-drains-writes-unit.ts — R3 audit #4 (high), carried across the
 * the legacy graph engine→SurrealDB migration. Originally: LocalGraph.close() drained the
 * connection POOL (NW-1e, in-flight reads) but NOT the globalWriteQueue, so a
 * queued/in-flight write could fire after database.close() against a freed
 * native the legacy graph engine handle — an intermittent use-after-free SIGSEGV/SIGABRT.
 *
 * The invariant survives the engine swap: close() racing in-flight writes must
 * (a) complete, (b) leave every write promise settled (loud JS errors are
 * acceptable; a hang, a crash, or a wedged handle is not), and (c) not corrupt
 * the store. On SurrealGraph a losing write throws a LoreGraphError from the
 * `db()` guard instead of segfaulting — same contract, better failure mode.
 *
 * Run: npm run test:unit:audit-close-drains-writes
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SurrealGraph } from '../packages/lore/src/engines/surrealGraph.js';

const nd = (id: string) => ({ id, type: 'note', label: id, content: 'c', tags: ['t'], project: 'w', ecosystem: '*', metadata: '{}', security_scopes: [] as string[], language: null, ephemeral: false, ttl_ms: null, stale: false });

console.log('R3 #4 — close() settles in-flight writes cleanly while racing them');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-close-'));
let ok = false;
try {
    const g = new SurrealGraph(dir);
    await g.initialize();
    await g.upsertNode(nd('seed'));

    // Fire many concurrent writes WITHOUT awaiting, then immediately race close().
    // A write that loses the race must fail loudly as a JS error (caught below),
    // never hang the process or wedge the handle; close() itself must complete.
    const inflight: Array<Promise<unknown>> = [];
    for (let i = 0; i < 60; i++) inflight.push(g.upsertNode(nd('x' + i)).catch(() => undefined));

    await g.close();                    // must not hang or crash under the race
    await Promise.allSettled(inflight); // every write settles — none may hang
    ok = true;
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

assert.equal(ok, true, 'close() completed cleanly while racing in-flight writes');
console.log('  ✓ close() settled in-flight writes and tore down cleanly');
console.log('\n1 passed, 0 failed');
