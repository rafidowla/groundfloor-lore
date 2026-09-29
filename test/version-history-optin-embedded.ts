#!/usr/bin/env tsx
/**
 * test/version-history-optin-embedded.ts — MANDATORY integration proof, through
 * a real `createLore({ dataDir })`, that version-history deletion is OPT-IN
 * (owner decision 2026-09-29) and that the effective policy is visible
 * read-only over MCP and the embedded API.
 *
 * Seeds `versions.sqlite` BEFORE createLore() opens it (a host reopening old
 * data), boots a real host, lets its sweeps and the MCP `maintain` tool run,
 * then re-reads the file after dispose().
 *
 *   E1  default options: rows older than 90 days AND older than 7 years survive
 *       (embedded sweep + `maintain` with an explicit retention arg)
 *   E2  versionHistory.pruning.enabled -> 7-year default; only the 10y row goes;
 *       `maintain`'s retention arg can lengthen, never shorten
 *   E3  LORE_VERSION_PRUNE_ENABLED=1 (no option) -> same 7-year cutoff, source env
 *   E4  LORE_VERSION_RETENTION_DAYS=30 alone -> enabled at 30 days
 *   E5  skipTypes with pruning off: existing rows of that type survive
 *   E6  the MCP tool, the REST-visible store policy and the embedded getter agree
 *   E7  nothing exposes a setter (instance methods, MCP tools, maintain schema)
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLore } from '../packages/lore/src/index.js';
import { resolveLoreHome } from '../packages/lore/src/config/loreHome.js';
import { resolveGraphPath } from '../packages/lore/src/mcp/bootSteps.js';
import { VersionStore } from '../packages/lore/src/outbox/versionStore.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}
const grace = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

const DAY = 86_400_000;
const AGES = { tenYears: 3650, fiveYears: 1825, hundredDays: 100, oneDay: 1 } as const;
const ALL = Object.keys(AGES).sort();

const ENV_KEYS = ['LORE_VERSION_PRUNE_ENABLED', 'LORE_VERSION_RETENTION_DAYS', 'LORE_VERSION_PRUNE_SCHEDULE_DISABLED', 'LORE_VERSION_SKIP_TYPES'];
for (const k of ENV_KEYS) delete process.env[k];

function loreDirFor(dataDir: string): string {
    return path.join(resolveGraphPath(resolveLoreHome({ dataDir })), '.lore');
}

function seed(loreDir: string, type = 'note'): void {
    fs.mkdirSync(loreDir, { recursive: true });
    const s = VersionStore.open(loreDir);
    for (const [label, days] of Object.entries(AGES)) {
        s.recordVersion({
            versionId: randomUUID(), nodeId: label, workspace: 'default',
            timestamp: new Date(Date.now() - days * DAY).toISOString(),
            principal: 'test', operation: 'upsert', previousState: null,
            newState: { type, content: 'x'.repeat(3000) }, changesetId: null,
        });
    }
    s.close();
}
function survivors(loreDir: string): string[] {
    const s = VersionStore.open(loreDir);
    try { return Object.keys(AGES).filter((l) => s.getVersions(l, 'default', 10).length > 0).sort(); }
    finally { s.close(); }
}

type Lore = Awaited<ReturnType<typeof createLore>>;
async function withHost<T>(
    name: string,
    opts: Parameters<typeof createLore>[0] & { seedType?: string },
    env: Record<string, string>,
    body: (h: { lore: Lore; client: Client; loreDir: string }) => Promise<T>,
): Promise<{ result: T; left: string[]; loreDir: string }> {
    const dataDir = path.join(process.env.LORE_HOME!, name);
    const loreDir = loreDirFor(dataDir);
    seed(loreDir, opts.seedType);
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    Object.assign(process.env, env);
    const origErr = console.error;
    console.error = () => undefined; // the once-per-process legacy-env notice is asserted in version-history-policy-unit
    let lore: Lore;
    try {
        const { seedType: _s, ...rest } = opts;
        lore = await createLore({ deploymentMode: 'embedded', dataDir, ...rest });
    } finally {
        console.error = origErr;
        for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    const server = lore.createMcpServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: name, version: '0.0.1' });
    await client.connect(ct);
    let result: T;
    try {
        await grace(); // let the embedded sweeper (if scheduled) run
        result = await body({ lore, client, loreDir });
    } finally {
        await client.close();
        await lore.dispose();
    }
    return { result, left: survivors(loreDir), loreDir };
}
const textOf = (r: unknown): string => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? '');

console.log('\nEmbedded createLore — version-history deletion is opt-in\n');

await test('E1: default options — rows older than 90 days AND older than 7 years survive a sweep and `maintain`', async () => {
    const out = await withHost('e1', {}, {}, async ({ lore, client }) => {
        const policy = lore.getVersionHistoryPolicy();
        const maint = JSON.parse(textOf(await client.callTool({
            name: 'maintain', arguments: { dry_run: false, versions_sqlite_retention_days: 1 },
        })));
        return { policy, maint };
    });
    assert.equal(out.result.policy.enabled, false);
    assert.equal(out.result.policy.retentionDays, null);
    assert.equal(out.result.policy.source, 'default');
    assert.equal(out.result.maint.versionsSqlite?.skipped, 'pruning_disabled', JSON.stringify(out.result.maint.versionsSqlite));
    assert.deepEqual(out.left, ALL, 'no version row may be deleted by age with default options');
});

await test('E2: versionHistory.pruning.enabled -> 7-year default; `maintain` cannot shorten it', async () => {
    const out = await withHost('e2', { versionHistory: { pruning: { enabled: true } } }, {}, async ({ lore, client }) => {
        const maint = JSON.parse(textOf(await client.callTool({
            name: 'maintain', arguments: { dry_run: false, versions_sqlite_retention_days: 1 },
        })));
        return { policy: lore.getVersionHistoryPolicy(), maint };
    });
    assert.equal(out.result.policy.enabled, true);
    assert.equal(out.result.policy.retentionDays, 2557);
    assert.equal(out.result.policy.source, 'option');
    assert.deepEqual(out.left, ['fiveYears', 'hundredDays', 'oneDay'], 'only the 10-year-old row is past the 7-year default');
});

await test('E3: LORE_VERSION_PRUNE_ENABLED=1 with no option -> enabled at 7 years, source env', async () => {
    const out = await withHost('e3', {}, { LORE_VERSION_PRUNE_ENABLED: '1' }, async ({ lore }) => lore.getVersionHistoryPolicy());
    assert.equal(out.result.enabled, true);
    assert.equal(out.result.retentionDays, 2557);
    assert.equal(out.result.source, 'env');
    assert.deepEqual(out.left, ['fiveYears', 'hundredDays', 'oneDay']);
});

await test('E4: explicit LORE_VERSION_RETENTION_DAYS=30 alone -> enabled at 30 days', async () => {
    const out = await withHost('e4', {}, { LORE_VERSION_RETENTION_DAYS: '30' }, async ({ lore }) => lore.getVersionHistoryPolicy());
    assert.equal(out.result.enabled, true);
    assert.equal(out.result.retentionDays, 30);
    assert.deepEqual(out.left, ['oneDay']);
});

await test('E5: skipTypes with pruning off does NOT delete existing rows of that type', async () => {
    const out = await withHost(
        'e5', { versionHistory: { skipTypes: ['code_symbol'] }, seedType: 'code_symbol' }, {},
        async ({ lore }) => lore.getVersionHistoryPolicy(),
    );
    assert.deepEqual(out.result.skipTypes, ['code_symbol']);
    assert.equal(out.result.enabled, false);
    assert.deepEqual(out.left, ALL);
});

await test('E6: MCP get_version_history_policy, the embedded getter and the on-disk store agree', async () => {
    const out = await withHost(
        'e6',
        { versionHistory: { pruning: { enabled: true, retentionDays: 5000 }, retentionDaysByType: { note: 9000 }, skipTypes: ['scratch'] } },
        {},
        async ({ lore, client, loreDir }) => {
            const viaMcp = JSON.parse(textOf(await client.callTool({ name: 'get_version_history_policy', arguments: {} })));
            return { viaMcp, viaApi: lore.getVersionHistoryPolicy(), loreDir };
        },
    );
    assert.deepEqual(out.result.viaMcp, out.result.viaApi);
    assert.equal(out.result.viaMcp.enabled, true);
    assert.equal(out.result.viaMcp.retentionDays, 5000);
    assert.deepEqual(out.result.viaMcp.retentionDaysByType, { note: 9000 });
    assert.deepEqual(out.result.viaMcp.skipTypes, ['scratch']);
    assert.equal(out.result.viaMcp.source, 'option');
});

await test('E7: no setter anywhere — instance API, MCP tools, and the maintain schema', async () => {
    await withHost('e7', {}, {}, async ({ lore, client }) => {
        const badMethod = Object.keys(lore).filter((k) => /^(set|update|configure|enable|disable).*(version|histor|prun|retention)/i.test(k));
        assert.deepEqual(badMethod, [], `LoreInstance must not expose a policy setter: ${badMethod.join(',')}`);
        assert.equal(typeof lore.getVersionHistoryPolicy, 'function');
        // The getter hands back a copy: mutating it must not change the policy.
        const p = lore.getVersionHistoryPolicy();
        p.enabled = true; p.retentionDays = 1;
        assert.equal(lore.getVersionHistoryPolicy().enabled, false, 'mutating a returned policy must not enable pruning');

        const tools = (await client.listTools()).tools;
        const names = tools.map((t) => t.name);
        assert.ok(names.includes('get_version_history_policy'));
        const bad = names.filter((n) => /(set|update|configure|enable|disable)_.*(version|histor|prun|retention)/i.test(n));
        assert.deepEqual(bad, [], `no MCP tool may mutate the policy: ${bad.join(',')}`);
        const maintain = tools.find((t) => t.name === 'maintain')!;
        const props = Object.keys((maintain.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
        assert.ok(!props.some((p2) => /^(pruning|prune_enabled|version_pruning|enable_version)/i.test(p2)), `maintain must not accept a switch: ${props.join(',')}`);
        assert.ok(props.includes('versions_sqlite_retention_days'));
    });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
