#!/usr/bin/env tsx
/**
 * test/schema-destructive-guard-unit.ts — Phase 1 safety guard tests.
 *
 * Verifies that `SchemaAuthoringStore.propose()` rejects destructive
 * change kinds unless the proposer prefix is `human:`, and accepts
 * additive changes from any proposer.
 *
 * See packages/lore/src/schemas/destructive.ts and
 * docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md for the rationale.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    SchemaAuthoringStore,
    buildProposal,
    type ProposedChange,
} from '../packages/lore/src/schemas/authoring.js';
import {
    DESTRUCTIVE_CHANGE_KINDS,
    hasDestructiveChange,
    isHumanProposer,
} from '../packages/lore/src/schemas/destructive.js';
import {
    DEFAULT_SCHEMA_V2,
    type LoreSchemaV2,
} from '../packages/lore/src/schemas/types.js';

let passed = 0;
let failed = 0;

const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

async function withTmp<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-destructive-'));
    try { return await fn(dir); }
    finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}

function seedLiveSchema(workspaceDir: string, schema: LoreSchemaV2 = DEFAULT_SCHEMA_V2) {
    const loreDir = path.join(workspaceDir, '.lore');
    fs.mkdirSync(loreDir, { recursive: true });
    fs.writeFileSync(path.join(loreDir, 'schema.json'), JSON.stringify(schema));
}

const ADDITIVE_CHANGE: ProposedChange = {
    kind: 'node_type.added',
    target: 'know.Tenant',
    migration: 'lazy',
    rationale: 'a domain workspace needs Tenant',
};

const DESTRUCTIVE_REMOVE_FIELD: ProposedChange = {
    kind: 'field.removed',
    target: 'know.Tenant.email',
    migration: 'dual-shape',
    rationale: 'consolidating to primary_email',
};

const DESTRUCTIVE_REMOVE_NODE_TYPE: ProposedChange = {
    kind: 'node_type.removed',
    target: 'know.Tenant',
    migration: 'dual-shape',
};

const DESTRUCTIVE_PERMISSION_CHANGED: ProposedChange = {
    kind: 'permission.changed',
    target: 'know.Tenant.read',
    migration: 'not-applicable',
};

console.log('schema destructive-guard');

/* ---------- classification helpers ---------- */

test('DESTRUCTIVE_CHANGE_KINDS includes all the dangerous kinds', () => {
    const expected = [
        'node_type.removed',
        'node_type.renamed',
        'node_type.kind_changed',
        'field.removed',
        'field.type_changed',
        'field.sensitivity_flipped',
        'edge_type.removed',
        'permission.changed',
        'permission.removed',
    ];
    for (const k of expected) {
        assert.ok(DESTRUCTIVE_CHANGE_KINDS.has(k as any), `missing destructive kind: ${k}`);
    }
});

test('DESTRUCTIVE_CHANGE_KINDS does not include additive kinds', () => {
    const additive = [
        'node_type.added',
        'field.added',
        'edge_type.added',
        'permission.added',
        'workspace.system_prompt_changed',
        'workspace.domain_changed',
    ];
    for (const k of additive) {
        assert.ok(!DESTRUCTIVE_CHANGE_KINDS.has(k as any), `additive kind wrongly flagged: ${k}`);
    }
});

test('hasDestructiveChange flags a proposal with at least one destructive change', () => {
    const proposal = buildProposal({
        base: DEFAULT_SCHEMA_V2,
        changes: [ADDITIVE_CHANGE, DESTRUCTIVE_REMOVE_FIELD],
        proposedBy: 'human:test',
    });
    assert.equal(hasDestructiveChange(proposal), true);
});

test('hasDestructiveChange returns false for purely additive proposals', () => {
    const proposal = buildProposal({
        base: DEFAULT_SCHEMA_V2,
        changes: [ADDITIVE_CHANGE],
        proposedBy: 'ai:claude',
    });
    assert.equal(hasDestructiveChange(proposal), false);
});

test('isHumanProposer recognises the human: prefix', () => {
    assert.equal(isHumanProposer('human:rafi'), true);
    assert.equal(isHumanProposer('human:'), true); // any human: prefix counts
    assert.equal(isHumanProposer('ai:claude'), false);
    assert.equal(isHumanProposer('system:installer'), false);
    assert.equal(isHumanProposer('rafi'), false); // no prefix
});

/* ---------- propose() guard ---------- */

test('propose accepts additive change from ai: proposer', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [ADDITIVE_CHANGE],
            proposedBy: 'ai:claude',
            transforms: { addNodeType: { name: 'know.Tenant', kind: 'factual', description: 'A tenant', fields: [] } as any },
        });
        const sandbox = await store.propose(proposal);
        assert.ok(sandbox.sandboxId);
    });
});

test('propose accepts additive change from system: proposer', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [ADDITIVE_CHANGE],
            proposedBy: 'system:plugin-installer',
            transforms: { addNodeType: { name: 'know.Tenant', kind: 'factual', description: 'A tenant', fields: [] } as any },
        });
        const sandbox = await store.propose(proposal);
        assert.ok(sandbox.sandboxId);
    });
});

test('propose REJECTS destructive change from ai: proposer', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [DESTRUCTIVE_REMOVE_FIELD],
            proposedBy: 'ai:claude',
        });
        await assert.rejects(() => store.propose(proposal), /destructive change/i);
        // and nothing was persisted to sandbox
        const sandboxFiles = fs.readdirSync(path.join(dir, '.lore', 'schema-sandbox'));
        assert.equal(sandboxFiles.length, 0, 'rejected proposal must leave no sandbox file');
    });
});

test('propose REJECTS destructive change from system: proposer (intentionally)', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [DESTRUCTIVE_REMOVE_NODE_TYPE],
            proposedBy: 'system:plugin-installer',
        });
        await assert.rejects(() => store.propose(proposal), /destructive change/i);
    });
});

test('propose REJECTS destructive change from unprefixed proposer', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [DESTRUCTIVE_REMOVE_FIELD],
            proposedBy: 'rafi', // no kind prefix
        });
        await assert.rejects(() => store.propose(proposal), /destructive change/i);
    });
});

test('propose ACCEPTS destructive change from human: proposer', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [DESTRUCTIVE_REMOVE_FIELD],
            proposedBy: 'human:rafi',
        });
        const sandbox = await store.propose(proposal);
        assert.ok(sandbox.sandboxId);
    });
});

test('propose REJECTS mixed proposal (additive + destructive) from ai: proposer', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [ADDITIVE_CHANGE, DESTRUCTIVE_PERMISSION_CHANGED],
            proposedBy: 'ai:claude',
        });
        await assert.rejects(() => store.propose(proposal), /destructive change/i);
    });
});

test('rejection error message names the offending change kinds', async () => {
    await withTmp(async dir => {
        seedLiveSchema(dir);
        const store = new SchemaAuthoringStore(dir);
        const proposal = buildProposal({
            base: DEFAULT_SCHEMA_V2,
            changes: [DESTRUCTIVE_REMOVE_FIELD, DESTRUCTIVE_PERMISSION_CHANGED],
            proposedBy: 'ai:claude',
        });
        try {
            await store.propose(proposal);
            assert.fail('expected throw');
        } catch (err) {
            const msg = (err as Error).message;
            assert.match(msg, /field\.removed/);
            assert.match(msg, /permission\.changed/);
            assert.match(msg, /ai:claude/);
            assert.match(msg, /human:/);
        }
    });
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
