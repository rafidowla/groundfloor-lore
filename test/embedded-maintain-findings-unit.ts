#!/usr/bin/env tsx
/**
 * test/embedded-maintain-findings-unit.ts — Defect 3 (3.20.2), POST-REVIEW
 * findings (verdict: changes_requested on commit 0e778b53).
 *
 * Covers the 3 findings that needed code changes:
 *
 *   Finding 1 (MIS-TARGETED DESTRUCTIVE OP) — `wsName` came from a live
 *   registry read while `wsPath` fell back to the BOOT-TIME
 *   `deps.graphBasePath`. If the active workspace changed after boot
 *   (no restart), a `maintain` call would label its report with the NEW
 *   active workspace's name while actually operating on the OLD (boot-time)
 *   workspace's LanceDB.
 *
 *   Finding 2 (FIX REQUIREMENT 4 UNMET) — no wiring existed for embedded
 *   hosts to prune `versions.sqlite`; the daemon-only `versionPruneSweeper`
 *   never runs in embedded mode.
 *
 *   Finding 3 (REQUIREMENT 1 AUDIT PARTLY DEFERRED) — `lifecycle.ts`
 *   (`prune_nodes`) and `governance.ts` (`list_workspaces`) still called
 *   `loadWorkspaces()` with no home argument, defaulting to the
 *   process-wide home instead of the embedded instance's own home. For
 *   `prune_nodes` this could authorize a hard-delete based on the WRONG
 *   registry's `allowHardDelete` flag while operating on the correct
 *   instance's actual graph data.
 *
 * (Finding 4 was a comment-only fix; no behavior to test.)
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';
import { createWorkspace, switchWorkspace } from '../packages/lore/src/config/workspaces.js';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';

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

interface ToolTextResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
}

function parseToolText<T>(result: ToolTextResult): T {
    return JSON.parse(result.content[0]?.text ?? '{}') as T;
}

/* ─────────────────────────────────────────────────────────────────
 * Finding 1 — wsName/wsPath must come from the SAME registry read.
 * ────────────────────────────────────────────────────────────── */
async function testFinding1(): Promise<void> {
    console.log('\nFinding 1 — a post-boot active-workspace switch must not split name/path');

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-f1-instance-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-f1-processhome-'));
    process.env['LORE_HOME'] = dirB;

    // Bootstrap the registry at dirA with two workspaces BEFORE boot so
    // `graphBasePath` (resolved once, at boot, via resolveGraphPath(dataHome))
    // snapshots 'default' (path === dirA itself).
    const second = createWorkspace('second', {}, dirA);

    const lore = await createLore({ deploymentMode: 'embedded', dataDir: dirA });
    try {
        assert.equal(lore.dataHome, dirA, `instance dataHome must be A; got ${lore.dataHome}`);

        // Live switch AFTER boot, no restart — exactly the scenario the
        // review flagged (POST /api/workspaces/switch, or `lore workspaces
        // switch`, before any restart completes).
        switchWorkspace('second', dirA);

        const mcpServer = lore.createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'finding1-test', version: '0.0.1' });
        await client.connect(clientTransport);

        const result = await client.callTool({ name: 'maintain', arguments: { dry_run: true } }) as unknown as ToolTextResult;
        const parsed = parseToolText<{ reports?: Array<{ scopeLabel?: string; lancedb: { lancedbDir?: string } }> }>(result);
        const wsReport = parsed.reports?.[0];

        await test('report scopeLabel names the NEW active workspace (second), not the boot one', async () => {
            assert.equal(wsReport?.scopeLabel, 'workspace:second', `got ${JSON.stringify(wsReport)}`);
        });

        await test('report lancedbDir resolves under the NEW active workspace path, not the boot graphBasePath', async () => {
            const dir = wsReport?.lancedb.lancedbDir;
            assert.ok(dir, `expected lancedb.lancedbDir; got ${JSON.stringify(wsReport)}`);
            assert.ok(
                path.resolve(dir as string).startsWith(path.resolve(second.path)),
                `expected lancedbDir under the NEW active path (${second.path} — a live switch after boot); ` +
                `got ${dir}. A mismatch here means the report's NAME and PATH came from two different ` +
                `registry reads (the exact Finding 1 defect: name says "second", but the boot-time ` +
                `graphBasePath — the OLD "default" workspace — silently ate the write instead).`,
            );
            assert.ok(
                !path.resolve(dir as string).startsWith(path.resolve(dirA, '.lore')),
                `lancedbDir must NOT be the boot-time (old "default") path; got ${dir}`,
            );
        });

        await client.close();
    } finally {
        await lore.dispose();
        try { fs.rmSync(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(dirB, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/* ─────────────────────────────────────────────────────────────────
 * Finding 2 — versions.sqlite pruning must be reachable in embedded mode.
 * ────────────────────────────────────────────────────────────── */
async function testFinding2(): Promise<void> {
    console.log('\nFinding 2 — embedded `maintain` must be able to bound versions.sqlite growth');

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-f2-instance-'));
    const OLD_ROWS = 12;

    // Seed OLD version rows directly (recordVersion accepts an explicit
    // timestamp, so no need to wait on wall-clock time like the LanceDB
    // version horizon does).
    const loreDir = path.join(dirA, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    const seedStore = VersionStore.open(loreDir);
    const oldIso = new Date(Date.now() - 200 * 86_400_000).toISOString();
    for (let i = 0; i < OLD_ROWS; i++) {
        seedStore.recordVersion({
            versionId: `f2-old-${i}`,
            nodeId: `node-${i}`,
            workspace: 'default',
            timestamp: oldIso,
            principal: 'test',
            operation: 'update',
            previousState: { n: i },
            newState: { n: i + 1 },
            changesetId: null,
        });
    }
    seedStore.close();

    const lore = await createLore({ deploymentMode: 'embedded', dataDir: dirA });
    try {
        const mcpServer = lore.createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'finding2-test', version: '0.0.1' });
        await client.connect(clientTransport);

        const dryResult = await client.callTool({
            name: 'maintain',
            arguments: { dry_run: true, versions_sqlite_retention_days: 1 },
        }) as unknown as ToolTextResult;
        const dryParsed = parseToolText<{ versionsSqlite?: { dryRun: boolean; eligibleForCompact: number; alreadyCompacted: number } }>(dryResult);

        await test('dry-run previews versions.sqlite prune via countPrunable without mutating', async () => {
            assert.ok(dryParsed.versionsSqlite, `expected a versionsSqlite field; got ${JSON.stringify(dryParsed)}`);
            assert.equal(dryParsed.versionsSqlite?.dryRun, true);
            assert.ok(
                (dryParsed.versionsSqlite?.eligibleForCompact ?? 0) >= OLD_ROWS,
                `expected eligibleForCompact >= ${OLD_ROWS}; got ${JSON.stringify(dryParsed.versionsSqlite)}`,
            );
        });

        const applyResult = await client.callTool({
            name: 'maintain',
            arguments: { dry_run: false, versions_sqlite_retention_days: 1 },
        }) as unknown as ToolTextResult;
        const applyParsed = parseToolText<{ versionsSqlite?: { dryRun: boolean; softCompacted: number; hardDeleted: number; vacuumed: boolean } }>(applyResult);

        await test('apply run actually prunes versions.sqlite via the SAME sweep the daemon scheduler uses', async () => {
            assert.ok(applyParsed.versionsSqlite, `expected a versionsSqlite field; got ${JSON.stringify(applyParsed)}`);
            assert.equal(applyParsed.versionsSqlite?.dryRun, false);
            assert.ok(
                (applyParsed.versionsSqlite?.softCompacted ?? 0) >= OLD_ROWS,
                `expected softCompacted >= ${OLD_ROWS}; got ${JSON.stringify(applyParsed.versionsSqlite)}`,
            );
            assert.ok(
                (applyParsed.versionsSqlite?.hardDeleted ?? 0) >= OLD_ROWS,
                `expected hardDeleted >= ${OLD_ROWS}; got ${JSON.stringify(applyParsed.versionsSqlite)}`,
            );
            assert.equal(applyParsed.versionsSqlite?.vacuumed, true);
        });

        // disable:['versionsSqlitePrune'] must skip the op entirely — no
        // report field, and (verified below) no further mutation.
        const disabledResult = await client.callTool({
            name: 'maintain',
            arguments: { dry_run: false, disable: ['versionsSqlitePrune'] },
        }) as unknown as ToolTextResult;
        const disabledParsed = parseToolText<{ versionsSqlite?: unknown }>(disabledResult);

        await test('disable:["versionsSqlitePrune"] omits the field and skips the op', async () => {
            assert.equal(disabledParsed.versionsSqlite, undefined, `expected no versionsSqlite field; got ${JSON.stringify(disabledParsed)}`);
        });

        await client.close();
    } finally {
        await lore.dispose();
    }

    // Verify on-disk: the hard-deleted rows are actually gone (re-open a
    // fresh connection after the instance released its own).
    const verifyStore = VersionStore.open(loreDir);
    try {
        await test('the seeded rows are actually gone from node_versions after apply', async () => {
            const remaining = verifyStore.countPrunable(1);
            assert.equal(remaining.alreadyCompacted, 0, `expected 0 still-compacted rows after hard-delete; got ${JSON.stringify(remaining)}`);
        });
    } finally {
        verifyStore.close();
        try { fs.rmSync(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/* ─────────────────────────────────────────────────────────────────
 * Finding 3 — lifecycle.ts/governance.ts must resolve THIS instance's
 * own registry home, not the process-wide default.
 * ────────────────────────────────────────────────────────────── */
async function testFinding3(): Promise<void> {
    console.log('\nFinding 3 — prune_nodes/list_workspaces must not read a foreign registry');

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-f3-instance-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-f3-processhome-'));

    // Seed a FOREIGN registry at dirB (the process-wide LORE_HOME) whose
    // 'default' workspace permissively allows hard-delete — the trap: if
    // prune_nodes reads this instead of dirA's own registry, it will
    // authorize a hard-delete against dirA's actual graph data based on
    // dirB's flag.
    fs.mkdirSync(dirB, { recursive: true });
    const foreignRegistry = {
        active: 'default',
        workspaces: [{ name: 'default', path: dirB, allowHardDelete: true, createdAt: new Date().toISOString() }],
    };
    fs.writeFileSync(path.join(dirB, 'workspaces.json'), JSON.stringify(foreignRegistry, null, 2), 'utf8');
    const dirBBefore = fs.readFileSync(path.join(dirB, 'workspaces.json'), 'utf8');
    process.env['LORE_HOME'] = dirB;

    const lore = await createLore({ deploymentMode: 'embedded', dataDir: dirA });
    try {
        const mcpServer = lore.createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'finding3-test', version: '0.0.1' });
        await client.connect(clientTransport);

        const listResult = await client.callTool({ name: 'list_workspaces', arguments: {} }) as unknown as ToolTextResult;
        const listParsed = parseToolText<{ active?: string; workspaces?: Array<{ name: string; path: string }> }>(listResult);

        await test('list_workspaces reports THIS instance\'s own registry (dirA), not the foreign one (dirB)', async () => {
            assert.equal(listParsed.active, 'default', `got ${JSON.stringify(listParsed)}`);
            const entry = listParsed.workspaces?.find((w) => w.name === 'default');
            assert.ok(entry, `expected a 'default' entry; got ${JSON.stringify(listParsed)}`);
            assert.equal(
                fs.realpathSync(entry!.path), fs.realpathSync(dirA),
                `'default' workspace path must be dirA (this instance's own home); got ${entry?.path} (dirB is ${dirB})`,
            );
        });

        await test('the foreign registry at dirB is never mutated by list_workspaces', async () => {
            const after = fs.readFileSync(path.join(dirB, 'workspaces.json'), 'utf8');
            assert.equal(after, dirBBefore, 'dirB workspaces.json must be byte-identical after the call');
        });

        // The concrete danger the review named: a hard-delete request must be
        // gated by THIS instance's own allowHardDelete (false by default,
        // since dirA's freshly-bootstrapped 'default' entry has no such
        // flag), never by dirB's permissive one.
        const pruneResult = await client.callTool({
            name: 'prune_nodes',
            arguments: { workspace: 'default', dry_run: true, hard_delete: true },
        }) as unknown as ToolTextResult;
        const prunedParsed = parseToolText<{ error?: string }>(pruneResult);

        await test('prune_nodes hard_delete is gated by dirA\'s OWN allowHardDelete, not dirB\'s permissive flag', async () => {
            assert.equal(
                prunedParsed.error, 'hard_delete_not_allowed',
                `expected the hard-delete gate to reject using dirA's own (unset) allowHardDelete; ` +
                `got ${JSON.stringify(prunedParsed)}. If this did NOT reject, prune_nodes read dirB's ` +
                `registry (allowHardDelete:true there) instead of dirA's own — the exact Finding 3 danger.`,
            );
        });

        await client.close();
    } finally {
        await lore.dispose();
        try { fs.rmSync(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(dirB, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

async function main(): Promise<void> {
    console.log('Defect 3 (3.20.2) — post-review findings');
    await testFinding1();
    await testFinding2();
    await testFinding3();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
