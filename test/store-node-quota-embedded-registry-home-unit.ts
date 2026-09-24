#!/usr/bin/env tsx
/**
 * test/store-node-quota-embedded-registry-home-unit.ts — Finding 2
 * (post-review, 3.20.2, follow-up to e2abf06a): a WORSE sibling of the
 * same wrong-home bug already fixed in `governance.ts`/`lifecycle.ts`
 * (145f69be) and `mcp/tools/ingestion.ts` (e2abf06a), still live in
 * `mcp/server.ts`'s `createLore()`:
 *
 *     const getWorkspaceEntryForQuota = (ws) =>
 *         loadWorkspaces().workspaces.find((w) => w.name === ws);
 *
 * A bare `loadWorkspaces()` resolves against the process-wide `loreHome()`,
 * not an embedded instance's own home. Unlike the ingestion.ts sibling
 * (which fails CLOSED — `workspace_not_found` denies the call outright),
 * this one fails OPEN: `checkWorkspaceQuota` (security/workspaceQuota.ts)
 * treats "no entry found" as "no quota configured, allow anything." So for
 * an embedded host whose workspace (and its `maxNodes`/`maxStorageBytes`
 * quota) is registered ONLY in its own registry, the per-workspace write
 * quota is SILENTLY UNENFORCED on `store_node` (also `store_edge` and
 * versioning, not exercised here) — an agent can write past the configured
 * cap without ever seeing `workspace_quota_exceeded`.
 *
 * Worse still, plain `loadWorkspaces()` performs a first-run migration
 * that WRITES a `workspaces.json` into whatever home it resolves — for an
 * embedded host that's the process-wide home the review flagged as the
 * "stray file in a foreign home" failure mode already fixed elsewhere.
 *
 * This test seeds a workspace with a `maxNodes` quota configured ONLY in
 * the embedded instance's OWN registry (dirA) — a second, deliberately
 * DIFFERENT process-wide home (dirB, via LORE_HOME) never hears about this
 * workspace at all — and confirms that a `store_node` write which should
 * be denied by that quota IS denied. Pre-fix this test fails: both writes
 * succeed because the quota entry is never found (fail-open). Post-fix:
 * the first write (at cap) succeeds, the second (over cap) is refused with
 * `workspace_quota_exceeded`.
 *
 * Harness: one real embedded `createLore()` boot (SurrealDB default
 * engine), driven over a real MCP client/transport pair — no mocks, no
 * direct core/nodeService calls. Mirrors
 * test/ingestion-embedded-registry-home-unit.ts's dirA/dirB shape.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';

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

/** Patch the maxNodes quota directly onto an already-created workspace
 *  entry — createWorkspace() has no quota-field option, and there is no
 *  dedicated setter (unlike retention/vocabPolicy), so this mirrors what
 *  an operator hand-editing workspaces.json would do. */
function setMaxNodesQuota(home: string, workspaceName: string, maxNodes: number): void {
    const controlFile = path.join(home, 'workspaces.json');
    const file = JSON.parse(fs.readFileSync(controlFile, 'utf8')) as {
        active: string;
        workspaces: Array<{ name: string; maxNodes?: number }>;
    };
    const entry = file.workspaces.find((w) => w.name === workspaceName);
    if (!entry) throw new Error(`setMaxNodesQuota: no workspace "${workspaceName}" in ${controlFile}`);
    entry.maxNodes = maxNodes;
    fs.writeFileSync(controlFile, JSON.stringify(file, null, 2), 'utf8');
}

async function main(): Promise<void> {
    console.log(
        'server.ts createLore() — embedded getWorkspaceEntryForQuota must resolve THIS instance\'s ' +
        'own registry, not the process-wide one (L-033 write quota)',
    );

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-quota-instance-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-quota-processhome-'));
    process.env['LORE_HOME'] = dirB;

    // Registered — and quota-capped — ONLY in dirA's own registry. dirB
    // (process-wide) never hears about "quotaws" at all: if the quota gate
    // resolves against dirB, it bootstraps an unrelated workspaces.json
    // there and finds no "quotaws" entry, so the cap below would be
    // silently ignored instead of enforced.
    createWorkspace('quotaws', {}, dirA);
    setMaxNodesQuota(dirA, 'quotaws', 1);

    const lore = await createLore({ deploymentMode: 'embedded', dataDir: dirA });
    try {
        const mcpServer = lore.createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'store-node-quota-registry-home-test', version: '0.0.1' });
        await client.connect(clientTransport);

        try {
            const first = await client.callTool({
                name: 'store_node',
                arguments: { id: 'quota-node-1', type: 'decision', label: 'first write, at cap', workspace: 'quotaws' },
            }) as unknown as ToolTextResult;

            await test('first write (at maxNodes=1 cap) succeeds', async () => {
                assert.ok(
                    !first.isError,
                    `expected success; got isError=${first.isError} text=${JSON.stringify(first.content)}`,
                );
            });

            const second = await client.callTool({
                name: 'store_node',
                arguments: { id: 'quota-node-2', type: 'decision', label: 'second write, over cap', workspace: 'quotaws' },
            }) as unknown as ToolTextResult;

            await test('second write (over the maxNodes=1 cap) is DENIED — quota resolved from THIS instance\'s own registry, not dirB', async () => {
                assert.ok(
                    second.isError,
                    `expected a workspace_quota_exceeded refusal; got isError=${second.isError} text=${JSON.stringify(second.content)}. ` +
                    `A fail-open success here means getWorkspaceEntryForQuota() resolved against the process-wide ` +
                    `registry (${dirB}) instead of this embedded instance's own registry (${dirA}), so the quota entry was never found.`,
                );
                const parsed = parseToolText<{ error?: string; dimension?: string; cap?: number }>(second);
                assert.equal(parsed.error, 'workspace_quota_exceeded');
                assert.equal(parsed.dimension, 'maxNodes');
                assert.equal(parsed.cap, 1);
            });

            // NOTE: unlike the sibling ingestion.ts test, we do NOT assert
            // "dirB/workspaces.json was never created" here. store_node's
            // write path also runs core/nodeService.ts's resolveVocabVerdict(),
            // which calls a SEPARATE function, getWorkspaceVocabPolicy(workspace)
            // (config/workspaces.ts), with no home argument — an independent,
            // pre-existing instance of the same wrong-home class, out of scope
            // for this fix (not one of the 3 review findings; discovered
            // incidentally while writing this test). That call bootstrap-writes
            // dirB/workspaces.json via a caught, non-fatal path (falls back to
            // vocab decision "accept" on lookup failure, so it doesn't bypass
            // anything security-relevant — just pollutes the wrong home), which
            // would make a "no file in dirB" assertion here fail for a reason
            // unrelated to getWorkspaceEntryForQuota. The two assertions above
            // are the actual proof of the Finding 2 fix (quota enforced,
            // resolved from this instance's own registry) and are unaffected by
            // that separate issue.
        } finally {
            await client.close();
        }
    } finally {
        await lore.dispose();
        try { fs.rmSync(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(dirB, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
