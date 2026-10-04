#!/usr/bin/env tsx
/**
 * test/audit-flush-on-dispose-unit.ts — 3.27.1 fix 7.
 *
 * AuditLog.appendEntry chains fs.promises.appendFile and never awaits it, and
 * no teardown awaited flush(): a burst of audited writes followed straight by
 * dispose() lost the queued tail (and, once the host removed its data dir,
 * logged ~N "[audit] append failed: ENOENT"). The audit file is a hash chain,
 * so a lost tail is also a truncation the verifier would have to explain.
 *
 *   T1: 500 audited embedded writes, dispose(), read audit.jsonl WITHOUT
 *       waiting -> every row present, chain verifies, zero append failures
 *       (also after the temp home is removed).
 *   T2: flushAllAuditLogs() covers every live AuditLog (two homes in one process).
 *   T3: a hung appendFile makes dispose() finish within the flush bound + slack
 *       (never hangs shutdown), and warns once.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLore } from '../packages/lore/src/index.js';
import { verifyLiveChain } from '../packages/lore/src/security/auditChain.js';
import { AuditLog } from '../packages/lore/src/security/audit.js';
import { AUDIT_FLUSH_TIMEOUT_MS, flushAllAuditLogs } from '../packages/lore/src/security/auditFlush.js';

let passed = 0, failed = 0;
const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

const N = 500;
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-audit-flush-'));
const lines = (p: string) => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];

async function main() {
    const errors: string[] = [];
    const warns: string[] = [];
    const origErr = console.error, origWarn = console.warn;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); origErr(...a); };
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); origWarn(...a); };

    console.log('3.27.1 fix 7 — audit log flushed on dispose');

    await test(`T1 ${N} audited writes then dispose: every row on disk, chain verifies, no append failures`, async () => {
        const home = mkHome();
        const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });
        const auditPath = path.join(home, 'audit.jsonl');
        const before = lines(auditPath).length;
        for (let i = 0; i < N; i += 100) {
            await lore.nodeUpsertBatch(Array.from({ length: Math.min(100, N - i) }, (_, k) => {
                const id = `flush-${i + k}`;
                return { id, workspace: 'default', ecosystem: 'probe', nodeData: { id, type: 'note', label: id, content: 'x' } };
            }) as any);
        }
        await lore.dispose();
        // NO settle / wait: dispose() itself must have drained the append chain.
        const rows = lines(auditPath);
        assert.equal(rows.length - before, N, `expected ${N} new rows, found ${rows.length - before}`);
        const v = verifyLiveChain(auditPath);
        assert.equal(v.ok, true, `chain broken: ${(v as any).reason ?? ''}`);
        assert.equal((v as any).count, rows.length);
        fs.rmSync(home, { recursive: true, force: true });
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(errors.filter((e) => e.includes('[audit] append failed')).length, 0, 'append failures logged');
    });

    // Runs before the hung-append test: that test deliberately leaves a wedged
    // AuditLog in the process-wide registry, which would time out any later flushAll.
    await test('T2 flushAllAuditLogs covers every live AuditLog (two homes)', async () => {
        const homes = [mkHome(), mkHome()];
        const logs = homes.map((h) => new AuditLog({ path: path.join(h, 'audit.jsonl') }));
        for (const l of logs) for (let i = 0; i < 50; i++) l.log({ toolName: 'lib:test', args: { i }, result: 'success', durationMs: 0 });
        assert.equal(await flushAllAuditLogs(), true);
        for (const h of homes) {
            const p = path.join(h, 'audit.jsonl');
            assert.equal(lines(p).length, 50);
            assert.equal(verifyLiveChain(p).ok, true);
            fs.rmSync(h, { recursive: true, force: true });
        }
    });

    await test('T3 hung appendFile: dispose finishes within the bound + slack and warns', async () => {
        const home = mkHome();
        const lore = await createLore({ deploymentMode: 'embedded', dataDir: home });
        const auditPath = path.join(home, 'audit.jsonl');
        const realAppend = fs.promises.appendFile;
        (fs.promises as any).appendFile = (p: any, ...rest: any[]) =>
            String(p) === auditPath ? new Promise<void>(() => { /* never resolves */ }) : (realAppend as any)(p, ...rest);
        try {
            await lore.nodeUpsert({ id: 'hung-1', workspace: 'default', ecosystem: 'probe',
                nodeData: { id: 'hung-1', type: 'note', label: 'h', content: 'x' } } as any);
            const warnsBefore = warns.length;
            const t0 = Date.now();
            await lore.dispose();
            const took = Date.now() - t0;
            assert.ok(took >= AUDIT_FLUSH_TIMEOUT_MS - 200, `returned too early (${took}ms): did not wait for the flush`);
            assert.ok(took < AUDIT_FLUSH_TIMEOUT_MS + 5_000, `dispose hung ${took}ms`);
            assert.equal(warns.slice(warnsBefore).filter((w) => w.includes('[audit] flush did not complete')).length, 1, 'expected exactly one timeout warning');
        } finally {
            (fs.promises as any).appendFile = realAppend;
            fs.rmSync(home, { recursive: true, force: true });
        }
    });

    console.error = origErr; console.warn = origWarn;
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
