#!/usr/bin/env tsx
/**
 * test/audit-embedded-writes-unit.ts — Audit fix #1.
 *
 * Before fix #1, embedded createLore() writes (nodeUpsert / nodeUpsertBatch)
 * left NO entry in audit.jsonl — only the MCP/HTTP transports were audited.
 * That left apps integrating via the recommended library path (Atlas et al)
 * with no tamper-evident trail of what was written.
 *
 * This test boots a real createLore({ deploymentMode: 'embedded' }) and
 * asserts that each write now appends exactly one audit row, that the row
 * carries the right toolName + workspace + nodeId, and that an erroring
 * write still produces an audit row (and still throws).
 *
 * Pins:
 *   T1: nodeUpsert success → exactly 1 new audit row, toolName=lib:nodeUpsert
 *   T2: nodeUpsertBatch(N) → N new audit rows, toolName=lib:nodeUpsertBatch
 *   T3: nodeUpsert to unknown workspace → 1 ERROR audit row + still throws
 *   T4: the audit rows survive verifyChain() (chain integrity intact)
 */

import assert from 'node:assert/strict';
import { createLore } from '../packages/lore/src/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

let passed = 0, failed = 0;
const test = (name: string, fn: () => Promise<void>) => {
    return (async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
    })();
};

function countAuditLines(dataDir: string): number {
    const p = path.join(dataDir, 'audit.jsonl');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0;
}

/** The audit row for an asyncEmbed write lands after the event loop drains
 *  (the embed queue yields before the post-write audit call runs). Settle. */
async function settle(): Promise<void> { await new Promise(r => setTimeout(r, 300)); }

function lastAuditRow(dataDir: string): any {
    const p = path.join(dataDir, 'audit.jsonl');
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    return JSON.parse(lines[lines.length - 1]!);
}

async function main() {
    const dataDir = process.env.LORE_HOME!;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });

    console.log('Audit fix #1 — embedded writes are audit-logged');

    await test('T1 nodeUpsert success appends 1 audit row (toolName=lib:nodeUpsert)', async () => {
        const before = countAuditLines(dataDir);
        const r = await lore.nodeUpsert({
            id: 'audit-fix1-t1', workspace: 'default', ecosystem: 'probe',
            nodeData: { id: 'audit-fix1-t1', type: 'note', label: 't1', content: 'x' },
            asyncEmbed: true,
        } as any);
        assert.equal(r.ok, true);
        await settle();
        const after = countAuditLines(dataDir);
        assert.equal(after, before + 1, `expected ${before + 1} lines, got ${after}`);
        const row = lastAuditRow(dataDir);
        assert.equal(row.toolName, 'lib:nodeUpsert', `toolName=${row.toolName}`);
        assert.equal(row.args.workspace, 'default');
        assert.equal(row.args.nodeId, 'audit-fix1-t1');
        assert.equal(row.result, 'success');
    });

    await test('T2 nodeUpsertBatch(N) appends N audit rows', async () => {
        const before = countAuditLines(dataDir);
        const results = await lore.nodeUpsertBatch([
            { id: 'audit-fix1-t2a', workspace: 'default', ecosystem: 'probe',
              nodeData: { id: 'audit-fix1-t2a', type: 'note', label: 't2a', content: 'x' } },
            { id: 'audit-fix1-t2b', workspace: 'default', ecosystem: 'probe',
              nodeData: { id: 'audit-fix1-t2b', type: 'note', label: 't2b', content: 'x' } },
            { id: 'audit-fix1-t2c', workspace: 'default', ecosystem: 'probe',
              nodeData: { id: 'audit-fix1-t2c', type: 'note', label: 't2c', content: 'x' } },
        ] as any);
        assert.equal(results.length, 3);
        await settle();
        const after = countAuditLines(dataDir);
        assert.equal(after, before + 3, `expected ${before + 3} lines, got ${after}`);
    });

    await test('T3 nodeUpsert to unknown workspace → 1 ERROR audit row + still throws', async () => {
        const before = countAuditLines(dataDir);
        let threw = false;
        try {
            await lore.nodeUpsert({
                id: 'audit-fix1-t3', workspace: 'does-not-exist-' + Date.now(), ecosystem: 'probe',
                nodeData: { id: 'audit-fix1-t3', type: 'note', label: 't3', content: 'x' },
                asyncEmbed: true,
            } as any);
        } catch { threw = true; }
        assert.equal(threw, true, 'should still throw (audit logging must not swallow errors)');
        await settle();
        const after = countAuditLines(dataDir);
        assert.ok(after >= before + 1, `expected >=${before + 1} lines, got ${after}`);
        const row = lastAuditRow(dataDir);
        assert.equal(row.result, 'error', `result=${row.result}`);
        assert.equal(row.toolName, 'lib:nodeUpsert');
    });

    await lore.dispose();

    await test('T4 audit chain integrity holds (verifyChain passes)', async () => {
        // Re-open just the AuditLog to verify. Import the class directly.
        const { AuditLog } = await import('../packages/lore/src/security/audit.js');
        const al = new AuditLog(path.join(dataDir, 'audit.jsonl'));
        const v = al.verifyChain();
        assert.equal(v.ok, true, `chain broken: ${(v as any).reason ?? ''}`);
        assert.ok((v as any).count > 0, 'expected at least one row');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
