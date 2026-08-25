#!/usr/bin/env tsx
/**
 * agentic-dba-safety-unit.ts — Regression for the 2026-05-17 adversarial
 * Agentic DBA audit. Each test corresponds to a specific finding from
 * docs/architecture/agent-layer-extraction-2026-05-17.md follow-up.
 *
 * Covers:
 *   1. ReplayContext now carries decidedBy (not just initiator).
 *   2. replayApprovedOp refuses to replay if op.decidedBy is missing
 *      (defense in depth against an upstream store invariant violation).
 *   3. SchemaAuthoringStore.propose rejects removal of NODE_FLOOR_FIELDS.
 *   4. SchemaAuthoringStore.propose rejects removal of EDGE_FLOOR_FIELDS.
 *
 * /migrations/execute endpoint hardening (sandboxId + human approver
 * required) is exercised via E2E in the daemon, not here — too much
 * route setup for a unit. The unit suite covers the underlying
 * authoring + replay primitives that the route fix relies on.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { replayApprovedOp, InMemoryReplayHandlerRegistry } from '../packages/lore/src/security/approvalReplay.js';
import { SchemaAuthoringStore } from '../packages/lore/src/schemas/authoring.js';
import { coerceValue, requireStringParam } from '../packages/lore/src/schemas/migration/opValueHelpers.js';
import type { LoreSchemaV2 } from '../packages/lore/src/schemas/types.js';
import type { SchemaProposal } from '../packages/lore/src/schemas/authoring.js';
import type { PendingOp } from '../packages/lore/src/security/pendingOps.js';
import type { MigrationOp } from '../packages/lore/src/schemas/migration/types.js';

function test(name: string, fn: () => void | Promise<void>): () => Promise<void> {
    return async () => {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            console.error(`  FAIL ${name}`);
            console.error(err);
            process.exitCode = 1;
        }
    };
}

const baseSchema: LoreSchemaV2 = {
    version: 2,
    nodes: [
        { name: 'cre_tenant', kind: 'factual', fields: [
            { name: 'name', type: 'string', required: true },
            { name: 'contact_phone', type: 'string' },
        ]},
    ],
    edges: [],
    permissions: {},
    systemPrompt: 'test',
};

function mkAuthoring(): { store: SchemaAuthoringStore; loreDir: string } {
    const loreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-agentic-dba-'));
    fs.mkdirSync(path.join(loreDir, '.lore'), { recursive: true });
    const store = new SchemaAuthoringStore(path.join(loreDir, '.lore'));
    fs.writeFileSync(path.join(loreDir, '.lore', 'schema.json'), JSON.stringify(baseSchema));
    return { store, loreDir };
}

const tests = [
    test('replayApprovedOp passes ctx.decidedBy to the handler', async () => {
        let capturedDecidedBy: string | null = null;
        const registry = new InMemoryReplayHandlerRegistry();
        registry.register('test_op', async (_args, ctx) => {
            capturedDecidedBy = ctx.decidedBy;
        });
        const op: PendingOp = {
            id: 'op-1',
            operation: 'test_op',
            argsJson: '{}',
            initiator: 'human:rafi',
            workspaceId: 'workspace-a',
            createdAt: new Date().toISOString(),
            status: 'approved',
            decidedBy: 'human:rafi2',
            decidedAt: new Date().toISOString(),
        };
        const result = await replayApprovedOp(op, registry);
        assert.equal(result.kind, 'executed');
        assert.equal(capturedDecidedBy, 'human:rafi2', 'handler must receive the second-party decider, not the original initiator');
    }),

    test('replayApprovedOp refuses to replay when decidedBy is missing', async () => {
        const registry = new InMemoryReplayHandlerRegistry();
        registry.register('test_op', async () => { /* should not run */ });
        const op = {
            id: 'op-2',
            operation: 'test_op',
            argsJson: '{}',
            initiator: 'human:rafi',
            workspaceId: 'workspace-a',
            createdAt: new Date().toISOString(),
            status: 'approved' as const,
            // decidedBy intentionally missing — should fail
        };
        const result = await replayApprovedOp(op as unknown as PendingOp, registry);
        assert.equal(result.kind, 'failed');
        if (result.kind === 'failed') {
            assert.match(result.error.message, /no decidedBy/);
        }
    }),

    test('SchemaAuthoringStore.propose rejects NODE_FLOOR_FIELDS removal (id)', async () => {
        const { store } = mkAuthoring();
        const proposal: SchemaProposal = {
            nextSchema: baseSchema,
            changes: [
                { kind: 'field.removed', target: 'cre_tenant.id', migration: 'lazy' },
            ],
            proposedBy: 'human:rafi',
        };
        await assert.rejects(
            store.propose(proposal),
            (err: Error) => /floor field 'id' is immutable/.test(err.message),
            'removing the id floor field must be rejected at proposal time',
        );
    }),

    test('SchemaAuthoringStore.propose rejects NODE_FLOOR_FIELDS removal (workspace, createdBy)', async () => {
        const { store } = mkAuthoring();
        for (const floorField of ['workspace', 'createdBy', 'kind', 'type']) {
            const proposal: SchemaProposal = {
                nextSchema: baseSchema,
                changes: [
                    { kind: 'field.removed', target: `cre_tenant.${floorField}`, migration: 'lazy' },
                ],
                proposedBy: 'human:rafi',
            };
            await assert.rejects(
                store.propose(proposal),
                (err: Error) => new RegExp(`floor field '${floorField}'`).test(err.message),
                `removing floor field '${floorField}' must be rejected`,
            );
        }
    }),

    test('SchemaAuthoringStore.propose rejects EDGE_FLOOR_FIELDS removal (from, to)', async () => {
        const { store } = mkAuthoring();
        for (const floorField of ['from', 'to', 'createdAt']) {
            const proposal: SchemaProposal = {
                nextSchema: baseSchema,
                changes: [
                    { kind: 'field.removed', target: `leases.${floorField}`, migration: 'lazy' },
                ],
                proposedBy: 'human:rafi',
            };
            await assert.rejects(
                store.propose(proposal),
                (err: Error) => new RegExp(`floor field '${floorField}'`).test(err.message),
                `removing edge floor field '${floorField}' must be rejected`,
            );
        }
    }),

    // Non-floor field happy-path is covered by existing schema-floor
    // and schema-change-audit suites; this file only asserts the new
    // negative paths from the 2026-05-17 adversarial audit.

    // ─── RC2 audit (2026-05-17) Phase 3 additions ─────────────────
    //
    // The brief calls out three edge kinds that needed direct coverage:
    //   workspace.system_prompt_changed       — covered by schema-change-audit
    //                                            suite already; we exercise the
    //                                            proposal-validation path here.
    //   edge_type.added with missing target   — see "change missing target"
    //                                            test below; ProposedChange is
    //                                            the validation boundary, not
    //                                            EdgeTypeSpec.source/target
    //                                            (those don't exist on this
    //                                            schema — relations are
    //                                            labels, not anchored pairs).
    //   field.type_changed incompatible       — exercised below; lossy
    //                                            coercion must leave bad
    //                                            values untouched, never
    //                                            destroy or silently coerce.

    test('field.type_changed requires params.newType (clear error from requireStringParam)', () => {
        const op: MigrationOp = { kind: 'field.type_changed', target: 'know.Order.total', params: {} };
        assert.throws(
            () => requireStringParam(op, 'newType'),
            (err: Error) => /params\.newType to be a non-empty string/.test(err.message),
            'missing newType must produce an actionable param error',
        );
    }),

    test('field.type_changed coercion to integer: incompatible value left unchanged (no data loss)', () => {
        // Lossy contract: values that can't be coerced cleanly are
        // returned as-is. The migration runner counts them as
        // unmodified rather than rewriting them to NaN or null.
        assert.equal(coerceValue('not-a-number', 'integer'), 'not-a-number');
        assert.equal(coerceValue('42abc', 'integer'), 42, 'leading-numeric parses');
        assert.equal(coerceValue(7.9, 'integer'), 7, 'numeric truncates');
        // Null/undefined pass through untouched — preserves "field absent"
        // semantics rather than coercing to 0 / false.
        assert.equal(coerceValue(null, 'integer'), null);
        assert.equal(coerceValue(undefined, 'integer'), undefined);
    }),

    test('field.type_changed coercion to boolean: explicit-only conversion', () => {
        assert.equal(coerceValue('true', 'boolean'), true);
        assert.equal(coerceValue('FALSE', 'boolean'), false);
        assert.equal(coerceValue('1', 'boolean'), true);
        // Unrecognised string → left as-is rather than defaulting to true/false.
        // A noisy string like "maybe" must not silently become a boolean.
        assert.equal(coerceValue('maybe', 'boolean'), 'maybe');
    }),

    test('SchemaAuthoringStore.propose rejects an empty changes array', async () => {
        const { store } = mkAuthoring();
        await assert.rejects(
            store.propose({
                nextSchema: baseSchema,
                changes: [],
                proposedBy: 'human:rafi',
            }),
            /must list at least one change/,
        );
    }),

    test('SchemaAuthoringStore.propose rejects a change missing target (edge_type.added or any other kind)', async () => {
        const { store } = mkAuthoring();
        await assert.rejects(
            store.propose({
                nextSchema: baseSchema,
                changes: [
                    { kind: 'edge_type.added', target: '', migration: 'lazy' },
                ],
                proposedBy: 'human:rafi',
            }),
            /missing target/,
        );
    }),

    test('SchemaAuthoringStore.propose rejects a change missing migration strategy', async () => {
        const { store } = mkAuthoring();
        await assert.rejects(
            store.propose({
                nextSchema: baseSchema,
                changes: [
                    { kind: 'workspace.system_prompt_changed', target: 'workspace', migration: '' as never },
                ],
                proposedBy: 'human:rafi',
            }),
            /missing migration/,
        );
    }),
];

(async () => {
    console.log('agentic-dba-safety-unit');
    for (const t of tests) await t();
    if (process.exitCode) {
        console.error('FAILED');
        process.exit(process.exitCode);
    }
    console.log('PASSED');
})();
