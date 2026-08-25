#!/usr/bin/env tsx
/**
 * test/schema-approve-embedded-unit.ts — ITEM 3 (launch-fixes-2026-08)
 * end-to-end proof over the REAL embedded production entry point.
 *
 * The harness-level suites (phase-a-tools-unit.ts, schema-routes-unit.ts)
 * exercise the gate through captured tool handlers and route functions with
 * a hand-built context. What they CANNOT cover is the production wiring this
 * item added: createLore()'s `effectiveMode` → CreateMcpServerDeps.runMode →
 * PhaseAContext.runMode → gateSchemaApproval. A typo or dropped field
 * anywhere in that chain would leave embedded mode enqueueing destructive
 * schema approves into a queue no embedded host can ever decide (the v3.14.0
 * CHANGELOG known limitation this item closes) while every harness test
 * stayed green.
 *
 * So this suite boots a REAL embedded instance
 * (`createLore({ deploymentMode: 'embedded' })`), connects a REAL MCP client
 * over the SDK's in-memory transport pair to the instance's own
 * `createMcpServer()`, and drives `schema_approve` on a Tier-3 (destructive)
 * proposal through that transport. Assertions:
 *
 *   1. IMMEDIATE structured refusal — isError with code
 *      `destructive_hitl_unavailable_embedded` naming daemon (local) mode.
 *   2. NOTHING enqueued — the instance's REAL pendingOpsStore (reached via
 *      the internal daemon bag, same re-widening cast main() uses) is
 *      queried DIRECTLY and must be empty. A refusal that still enqueues
 *      underneath would be worse than the hang it replaces.
 *   3. The proposal is NOT applied (still pending in the sandbox).
 *   4. An ADDITIVE proposal in the same embedded boot still applies
 *      immediately — non-destructive tiers are unchanged in every mode.
 *
 * The destructive proposal fixture is seeded through the instance's own
 * SchemaAuthoringStore (the MCP schema_propose tool only supports additive
 * addNodeType proposals — richer changes are a documented direct-store path).
 * Only the ENTRY POINT UNDER TEST (schema_approve) goes through the wire.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';
import { buildProposal, type ProposedChange, type SchemaAuthoringStore } from '../packages/lore/src/schemas/authoring.js';
import { DEFAULT_SCHEMA_V2, type LoreSchemaV2 } from '../packages/lore/src/schemas/types.js';
import type { PendingOpsStore } from '../packages/lore/src/security/pendingOps.js';

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

const REMOVE_DOOMED: ProposedChange = {
    kind: 'node_type.removed',
    target: 'know.Doomed',
    migration: 'dual-shape',
};

function schemaWithDoomed(): LoreSchemaV2 {
    return {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [...DEFAULT_SCHEMA_V2.nodeTypes, { name: 'know.Doomed', description: '', kind: 'factual' as const }],
    };
}

/**
 * The public LoreInstance narrows `_daemon` to LoreInternalHandles, but the
 * full DaemonWiring bag travels on the property at runtime — main()
 * re-widens it with exactly this kind of cast (server.ts,
 * "cq-daemon-wiring-leaks-into-public-interface"). This test needs the REAL
 * pendingOpsStore to prove the refusal enqueued nothing.
 */
interface EmbeddedDaemonBag {
    pendingOpsStore: PendingOpsStore;
    phaseAServices: { schemaAuthoring: SchemaAuthoringStore };
}

async function main(): Promise<void> {
    console.log('ITEM 3 — embedded-mode destructive schema_approve refusal (end-to-end, real embedded boot)');

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-item3-embedded-'));
    // Point LORE_HOME at the tmp dir as well: several boot-time lookups
    // (workspaces.json, auth) default to it, and a fresh dir keeps the boot
    // hermetic (fc1-embedded-writes-reads-unit.ts uses the same pattern).
    process.env['LORE_HOME'] = dataDir;

    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    try {
        assert.equal(lore.runMode, 'embedded', 'boot must be in embedded run mode');
        const daemon = lore._daemon as unknown as EmbeddedDaemonBag;

        // Real MCP client over the SDK in-memory transport pair — the same
        // in-process surface an embedding host uses.
        const mcpServer = lore.createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'item3-embedded-test', version: '0.0.1' });
        await client.connect(clientTransport);

        const tools = await client.listTools();
        assert.ok(tools.tools.some((t) => t.name === 'schema_approve'),
            'schema_approve must be registered on the embedded MCP server');

        await test('destructive schema_approve is REFUSED immediately in embedded mode — and NOTHING is enqueued', async () => {
            const sandbox = await daemon.phaseAServices.schemaAuthoring.propose(buildProposal({
                base: schemaWithDoomed(),
                changes: [REMOVE_DOOMED],
                proposedBy: 'human:tester',
                transforms: { removeNodeType: 'know.Doomed' },
            }));

            const result = await client.callTool({
                name: 'schema_approve',
                arguments: {
                    sandboxId: sandbox.sandboxId,
                    approver: 'human:tester',
                    note: 'embedded host attempting a destructive approve',
                    workspace: 'default',
                },
            });

            assert.equal(result.isError, true,
                `expected isError refusal; got ${JSON.stringify(result)}`);
            const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
            assert.match(text, /destructive_hitl_unavailable_embedded/,
                `expected the embedded refusal code; got: ${text}`);
            assert.match(text, /daemon \(local\) mode/,
                `expected the refusal to name daemon (local) mode as the way out; got: ${text}`);

            // THE load-bearing assertion: the REAL queue, queried DIRECTLY.
            const ops = await daemon.pendingOpsStore.list({});
            assert.equal(ops.length, 0,
                `embedded refusal must not enqueue; store holds ${ops.length} op(s): ${JSON.stringify(ops)}`);

            assert.ok(daemon.phaseAServices.schemaAuthoring.getProposal(sandbox.sandboxId),
                'destructive proposal must still be pending — refused, not applied');
        });

        await test('additive schema_approve still applies immediately in the SAME embedded boot', async () => {
            const sandbox = await daemon.phaseAServices.schemaAuthoring.propose(buildProposal({
                base: DEFAULT_SCHEMA_V2,
                changes: [{ kind: 'node_type.added', target: 'know.AddedInEmbedded', migration: 'lazy' }],
                proposedBy: 'human:tester',
                transforms: { addNodeType: { name: 'know.AddedInEmbedded', description: '', kind: 'factual' } },
            }));

            const result = await client.callTool({
                name: 'schema_approve',
                arguments: {
                    sandboxId: sandbox.sandboxId,
                    approver: 'human:tester',
                    workspace: 'default',
                },
            });

            assert.equal(result.isError, undefined,
                `additive approve in embedded mode must succeed; got ${JSON.stringify(result)}`);
            assert.equal(daemon.phaseAServices.schemaAuthoring.getProposal(sandbox.sandboxId), null,
                'additive sandbox cleared — applied immediately');
            const ops = await daemon.pendingOpsStore.list({});
            assert.equal(ops.length, 0, 'additive approve must not touch the queue');
        });

        await client.close();
    } finally {
        await lore.dispose();
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
