#!/usr/bin/env tsx
/**
 * test/store-node-vocab-policy-embedded-registry-home-unit.ts — 3.20.2
 * side-issue fix: `core/nodeService.ts`'s `resolveVocabVerdict()` had the
 * SAME wrong-home bug as the sibling already fixed for write quotas
 * (`mcp/server.ts`'s `getWorkspaceEntryForQuota`, see
 * test/store-node-quota-embedded-registry-home-unit.ts). A bare
 * `getWorkspaceVocabPolicy(workspace)` (no `home` arg) resolves against the
 * process-wide `loreHome()`, not an embedded instance's own registry.
 *
 * Unlike the quota sibling, this one fails CLOSED in the wrong direction:
 * `getWorkspaceVocabPolicy` throws `Unknown workspace` when the name isn't
 * registered at the resolved home, `resolveVocabVerdict`'s catch treats
 * that as a soft policy-read failure and downgrades to `accept`. So an
 * embedded host with a `denylist`/`reject` vocab policy configured on a
 * type would silently let writes of that type through instead of refusing
 * them with `type_not_allowed`.
 *
 * This test seeds a workspace with a denylist+reject vocab policy
 * configured ONLY in the embedded instance's OWN registry (dirA) — a
 * second, deliberately DIFFERENT process-wide home (dirB, via LORE_HOME)
 * never hears about this workspace at all — and confirms a `store_node`
 * write of the denied type IS rejected. Pre-fix this test fails (the write
 * silently succeeds); post-fix it's refused with `type_not_allowed`.
 *
 * Harness: one real embedded `createLore()` boot (SurrealDB default
 * engine), driven over a real MCP client/transport pair — no mocks, no
 * direct core/nodeService calls. Mirrors
 * test/store-node-quota-embedded-registry-home-unit.ts's dirA/dirB shape.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';
import { createWorkspace, setWorkspaceVocabPolicy } from '../packages/lore/src/config/workspaces.js';

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

async function main(): Promise<void> {
    console.log(
        'core/nodeService.ts resolveVocabVerdict() — embedded store_node must resolve THIS instance\'s ' +
        'own registry\'s vocab policy, not the process-wide one',
    );

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vocab-instance-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-vocab-processhome-'));
    process.env['LORE_HOME'] = dirB;

    // Registered — and denylist/reject-policed on type "decision" — ONLY in
    // dirA's own registry. dirB (process-wide) never hears about "vocabws"
    // at all: if the policy lookup resolves against dirB, it throws
    // "Unknown workspace", resolveVocabVerdict's catch swallows that and
    // downgrades to "accept", so the denylist below would be silently
    // bypassed instead of enforced.
    createWorkspace('vocabws', {}, dirA);
    setWorkspaceVocabPolicy('vocabws', { mode: 'denylist', types: ['decision'], onMismatch: 'reject' }, dirA);

    const lore = await createLore({ deploymentMode: 'embedded', dataDir: dirA });
    try {
        const mcpServer = lore.createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'store-node-vocab-registry-home-test', version: '0.0.1' });
        await client.connect(clientTransport);

        try {
            const rejected = await client.callTool({
                name: 'store_node',
                arguments: { id: 'vocab-node-1', type: 'decision', label: 'denylisted type', workspace: 'vocabws' },
            }) as unknown as ToolTextResult;

            await test('write of a denylisted type is REJECTED — vocab policy resolved from THIS instance\'s own registry, not dirB', async () => {
                assert.ok(
                    rejected.isError,
                    `expected a type_not_allowed refusal; got isError=${rejected.isError} text=${JSON.stringify(rejected.content)}. ` +
                    `A silent success here means resolveVocabVerdict() resolved the vocab policy against the ` +
                    `process-wide registry (${dirB}) instead of this embedded instance's own registry (${dirA}), ` +
                    `so the policy lookup threw "Unknown workspace" and was swallowed into a soft "accept".`,
                );
                const parsed = parseToolText<{ error?: string; reason?: string }>(rejected);
                assert.equal(parsed.error, 'type_not_allowed');
            });

            const allowed = await client.callTool({
                name: 'store_node',
                arguments: { id: 'vocab-node-2', type: 'note', label: 'not on the denylist', workspace: 'vocabws' },
            }) as unknown as ToolTextResult;

            await test('write of a non-denylisted type still succeeds (policy is scoped to "decision" only)', async () => {
                assert.ok(
                    !allowed.isError,
                    `expected success; got isError=${allowed.isError} text=${JSON.stringify(allowed.content)}`,
                );
            });
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
