#!/usr/bin/env tsx
/**
 * test/sync-status-engine-unit.ts — K-final regression.
 *
 * The `sync_status` MCP tool (mcp/tools/governance.ts) hardcoded its
 * response's `engine` field to the removed legacy graph engine's name
 * regardless of what the workspace actually declares or the daemon
 * actually runs (which has been SurrealDB by default since 2026-08-21).
 * Fixed to read the real, declared engine via
 * `resolveWorkspaceGraphEngine` — same source of truth the daemon itself
 * uses to open the store.
 *
 * Two cases: a workspace with no `graphEngine` field (the default —
 * SurrealDB) reports `'surreal'`, and a workspace whose workspaces.json
 * still explicitly declares the legacy value reports it back verbatim
 * (the field is a status readout, not a refusal path — refusing a legacy
 * declaration is `LegacyGraphEngineRemovedError`'s job elsewhere).
 *
 * Run: npx tsx test/sync-status-engine-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { registerGovernanceTools, type GovernanceToolsDeps } from '../packages/lore/src/mcp/tools/governance.js';
import type { StorageBundle } from '../packages/lore/src/mcp/services.js';
import type { SyncEngine } from '../packages/lore/src/engines/syncEngine.js';

interface RecordedTool { name: string; handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; }
class FakeMcpServer {
    public tools: RecordedTool[] = [];
    tool(name: string, _d: string, _s: unknown, handler: RecordedTool['handler']) { this.tools.push({ name, handler }); }
}

function parseResult(r: { content: Array<{ text: string }> }): Record<string, unknown> {
    return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

function fakeSyncEngine(): SyncEngine {
    return {
        getStatus: () => ({
            walPending: 0,
            lastSync: '1970-01-01T00:00:00.000Z',
            hasAdapter: false,
            isAutoSyncing: false,
        }),
    } as unknown as SyncEngine;
}

function writeWorkspacesJson(home: string, entries: Array<{ name: string; graphEngine?: string }>): void {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        version: 1,
        active: entries[0]!.name,
        workspaces: entries.map((e) => ({
            name: e.name,
            path: path.join(home, 'workspaces', e.name),
            createdAt: new Date().toISOString(),
            ...(e.graphEngine ? { graphEngine: e.graphEngine } : {}),
        })),
    }, null, 2));
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok   ${name}`); passed++; }
    catch (err) { console.error(`  FAIL ${name}\n       ${(err as Error).stack ?? String(err)}`); failed++; }
}

console.log('\nsync_status reports the real declared graph engine (K-final)\n');

const savedHome = process.env['LORE_HOME'];

await test('sync_status reports "surreal" for a workspace with no graphEngine field (the default)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-syncstatus-'));
    process.env['LORE_HOME'] = home;
    writeWorkspacesJson(home, [{ name: 'w-default' }]);
    try {
        const srv = new FakeMcpServer();
        const deps: GovernanceToolsDeps = {
            store: {} as unknown as StorageBundle,
            getSyncEngine: fakeSyncEngine,
            detectedScope: { workspace: 'w-default', ecosystem: '*' },
        };
        registerGovernanceTools(srv as never, deps);
        const tool = srv.tools.find((t) => t.name === 'sync_status')!;
        const result = parseResult(await tool.handler({ workspace: 'w-default' }));
        assert.equal(result['engine'], 'surreal', `BUG: expected the real default engine, got ${JSON.stringify(result)}`);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

await test('sync_status reports the actual declared value for a workspace with an explicit legacy graphEngine', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-syncstatus-legacy-'));
    process.env['LORE_HOME'] = home;
    writeWorkspacesJson(home, [{ name: 'w-legacy', graphEngine: 'kuzu' }]);
    try {
        const srv = new FakeMcpServer();
        const deps: GovernanceToolsDeps = {
            store: {} as unknown as StorageBundle,
            getSyncEngine: fakeSyncEngine,
            detectedScope: { workspace: 'w-legacy', ecosystem: '*' },
        };
        registerGovernanceTools(srv as never, deps);
        const tool = srv.tools.find((t) => t.name === 'sync_status')!;
        const result = parseResult(await tool.handler({ workspace: 'w-legacy' }));
        assert.equal(result['engine'], 'kuzu', `BUG: must reflect the workspace's own declaration, not a hardcoded value — got ${JSON.stringify(result)}`);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

if (savedHome === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = savedHome;

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
