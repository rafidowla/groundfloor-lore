#!/usr/bin/env tsx
/**
 * test/embedded-maintain-target-unit.ts — Defect 3 (3.20.2):
 * `maintain` resolves its LanceDB target from the PROCESS-WIDE Lore home
 * (LORE_HOME / ~/.groundfloor) instead of the instance's own `dataDir`.
 *
 * Repro (Atlas ask LORE-ASK-EMBEDDED-MAINTAIN-TARGET.md):
 *   createLore({ deploymentMode: 'embedded', dataDir: A }) with LORE_HOME=B,
 *   a table with >20 versions in A/.lore/lancedb, then the instance's own
 *   `maintain` tool over an in-memory MCP transport.
 *
 * Expected after the fix:
 *   - the report lists that table (versions >= 21, eligibleOldVersions >= 20)
 *   - the reported lancedb dir is under A
 *   - B is untouched: no workspaces.json created there
 *
 * Today: tables are not probed at all (empty `lancedb.tables`,
 * eligibleOldVersions 0) and B gains a workspaces.json.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`);
        failed++;
    }
}

const TABLE = 'defect3_probe';
const VERSION_WRITES = 21;

/** Build a table with >20 versions directly in the instance's own lancedb dir. */
async function seedVersions(lancedbDir: string): Promise<number> {
    fs.mkdirSync(lancedbDir, { recursive: true });
    const lancedb = await import('@lancedb/lancedb');
    const db = await lancedb.connect(lancedbDir);
    const table = await db.createTable(TABLE, [{ id: 'seed-0', n: 0 }], { mode: 'overwrite' });
    for (let i = 1; i < VERSION_WRITES; i++) {
        await table.add([{ id: `seed-${i}`, n: i }]);
    }
    return (await table.listVersions()).length;
}

interface MaintainReportShape {
    ok?: boolean;
    reports?: Array<{
        scopeLabel?: string;
        lancedb: {
            tables: Array<{ name: string }>;
            eligibleOldVersions: number;
            reclaimableBytesEstimate?: number;
            tableBytes?: number;
            lancedbDir?: string;
        };
        probes?: Array<{ name: string; versions: number; eligibleOldVersions: number }>;
    }>;
}

async function main(): Promise<void> {
    console.log('Defect 3 — embedded `maintain` must target the instance dataDir, not LORE_HOME');

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-d3-instance-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-d3-processhome-'));
    process.env['LORE_HOME'] = dirB;
    // Keep the version horizon short so a freshly written version is eligible.
    const bEntriesBefore = fs.readdirSync(dirB).sort();

    const lore = await createLore({ deploymentMode: 'embedded', dataDir: dirA });
    try {
        assert.equal(lore.runMode, 'embedded', 'boot must be in embedded run mode');
        assert.equal(lore.dataHome, dirA, `instance dataHome must be A; got ${lore.dataHome}`);

        const lancedbDirA = path.join(dirA, '.lore', 'lancedb');
        const seeded = await seedVersions(lancedbDirA);
        assert.ok(seeded >= VERSION_WRITES, `seed must produce >=${VERSION_WRITES} versions; got ${seeded}`);
        console.log(`  · seeded ${seeded} versions in ${lancedbDirA}`);

        const mcpServer = lore.createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'defect3-test', version: '0.0.1' });
        await client.connect(clientTransport);

        // parseDuration's finest unit is seconds (policy.ts:109), so '1s' +
        // a short wait is the shortest horizon that makes the seeded versions
        // eligible. (The ask's "1m" would need a 60s-old table.)
        await new Promise((r) => setTimeout(r, 1500));
        const result = await client.callTool({
            name: 'maintain',
            arguments: { dry_run: true, cleanup_versions_older_than: '1s' },
        });
        const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
        console.log(`  · maintain raw: ${text.slice(0, 900)}`);
        const parsed = JSON.parse(text) as MaintainReportShape;
        const wsReport = parsed.reports?.[0];

        await test('dry-run report probes the INSTANCE dataDir table (>=21 versions, >=20 eligible)', async () => {
            assert.ok(wsReport, 'expected a per-workspace report');
            assert.ok(
                (wsReport as { lancedb: { eligibleOldVersions: number } }).lancedb.eligibleOldVersions >= VERSION_WRITES - 1,
                `expected eligibleOldVersions >= ${VERSION_WRITES - 1}; got ${JSON.stringify(wsReport?.lancedb)}`,
            );
        });

        await test('report names the resolved lancedb dir, and it is under A', async () => {
            const dir = wsReport?.lancedb.lancedbDir;
            assert.ok(dir, `expected lancedb.lancedbDir in the report; got ${JSON.stringify(wsReport?.lancedb)}`);
            assert.ok(
                path.resolve(dir as string).startsWith(path.resolve(dirA)),
                `resolved lancedb dir must be under A (${dirA}); got ${dir}`,
            );
        });

        await test('the process-wide home B is untouched (no workspaces.json created)', async () => {
            const after = fs.readdirSync(dirB).sort();
            assert.deepEqual(after, bEntriesBefore,
                `B must be untouched; before=${JSON.stringify(bEntriesBefore)} after=${JSON.stringify(after)}`);
        });

        // Non-dry-run: the prune must actually happen against A's own table,
        // and B must still be untouched afterward.
        const applyResult = await client.callTool({
            name: 'maintain',
            arguments: { dry_run: false, cleanup_versions_older_than: '1s' },
        });
        const applyText = (applyResult.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
        console.log(`  · apply raw: ${applyText.slice(0, 900)}`);

        await test('apply run prunes old versions on the INSTANCE table down to 1-2', async () => {
            const lancedb = await import('@lancedb/lancedb');
            const db = await lancedb.connect(lancedbDirA);
            const table = await db.openTable(TABLE);
            const versionsAfter = (await table.listVersions()).length;
            assert.ok(
                versionsAfter >= 1 && versionsAfter <= 2,
                `expected 1-2 versions remaining after prune; got ${versionsAfter}`,
            );
            const versionsDir = path.join(lancedbDirA, `${TABLE}.lance`, '_versions');
            const manifestCount = fs.existsSync(versionsDir)
                ? fs.readdirSync(versionsDir).filter((f) => f.endsWith('.manifest')).length
                : 0;
            assert.equal(
                manifestCount, versionsAfter,
                `_versions manifest count (${manifestCount}) must match listVersions() (${versionsAfter})`,
            );
        });

        await test('after apply, the process-wide home B is still untouched', async () => {
            const after = fs.readdirSync(dirB).sort();
            assert.deepEqual(after, bEntriesBefore,
                `B must be untouched; before=${JSON.stringify(bEntriesBefore)} after=${JSON.stringify(after)}`);
        });

        // The Atlas workaround (calling lore.store.rawVerbatim().compact()
        // itself and using `disable` to skip this tool's own lance ops) must
        // still resolve and report the instance's own lancedb dir.
        const disabledResult = await client.callTool({
            name: 'maintain',
            arguments: { dry_run: true, disable: ['compaction', 'versionCleanup', 'ephemeralExpiry'] },
        });
        const disabledText = (disabledResult.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
        const disabledParsed = JSON.parse(disabledText) as MaintainReportShape;
        const disabledWsReport = disabledParsed.reports?.[0];

        await test('disable:[...] (Atlas workaround path) still reports the instance lancedb dir', async () => {
            const dir = disabledWsReport?.lancedb.lancedbDir;
            assert.ok(dir, `expected lancedb.lancedbDir even with lance ops disabled; got ${JSON.stringify(disabledWsReport?.lancedb)}`);
            assert.ok(
                path.resolve(dir as string).startsWith(path.resolve(dirA)),
                `resolved lancedb dir must be under A (${dirA}) even when disabled; got ${dir}`,
            );
        });

        await client.close();
    } finally {
        await lore.dispose();
        try { fs.rmSync(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(dirB, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
