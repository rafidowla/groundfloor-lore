/**
 * test/schema-floor-unit.ts — T1a unit tests
 *
 * Exercises:
 *   - Floor constants exist and have the right shape
 *   - DEFAULT_SCHEMA_V2 validates clean
 *   - kind defaults to 'factual' under legacy migration
 *   - ReBAC L1 relation edges are exposed and present in defaults
 *   - validation catches: invalid kind, duplicate names, floor collisions,
 *     unknown permission relations, ReBAC field redefinition
 *   - SchemaLoader returns both legacy and V2 shapes; missing file → defaults
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    NODE_FLOOR_FIELDS,
    EDGE_FLOOR_FIELDS,
    REBAC_RELATION_EDGES,
    REBAC_RELATION_EDGE_NAMES,
    DEFAULT_NODE_KIND,
    DEFAULT_SCHEMA_V2,
    SCHEMA_FORMAT_VERSION,
    validateSchema,
    type LoreSchemaV2,
} from '../packages/lore/src/schemas/types.js';
import {
    SchemaLoader,
} from '../packages/lore/src/schemas/loader.js';
import {
    migrateLegacySchema,
    type LegacyLoreSchema,
} from '../packages/lore/src/schemas/types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${(err as Error).message}`);
        failed++;
    }
}

function withTempDir<T>(fn: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-schema-test-'));
    try {
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

console.log('schema floor — T1a');

/* ---------- Floor constants ---------- */

test('NODE_FLOOR_FIELDS contains the seven required fields', () => {
    const expected = [
        'id', 'type', 'workspace', 'ingestedAt',
        'provenance', 'createdBy', 'kind',
    ];
    assert.deepEqual([...NODE_FLOOR_FIELDS], expected);
});

test('EDGE_FLOOR_FIELDS contains the five required fields', () => {
    const expected = ['from', 'to', 'type', 'createdAt', 'createdBy'];
    assert.deepEqual([...EDGE_FLOOR_FIELDS], expected);
});

test('default node kind is factual', () => {
    assert.equal(DEFAULT_NODE_KIND, 'factual');
});

/* ---------- ReBAC L1 ---------- */

test('REBAC_RELATION_EDGES has exactly the five locked relation types', () => {
    assert.deepEqual(
        [...REBAC_RELATION_EDGE_NAMES],
        ['owner', 'editor', 'viewer', 'member', 'parent'],
    );
    assert.equal(REBAC_RELATION_EDGES.length, 5);
});

test('default schema includes all five ReBAC relation edges', () => {
    const present = new Set(DEFAULT_SCHEMA_V2.edgeTypes.map(e => e.name));
    for (const r of REBAC_RELATION_EDGE_NAMES) {
        assert.ok(present.has(r), `missing ReBAC relation '${r}' in default schema`);
    }
});

/* ---------- Default schema ---------- */

test('DEFAULT_SCHEMA_V2 validates clean', () => {
    const result = validateSchema(DEFAULT_SCHEMA_V2);
    assert.ok(result.valid, `errors: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
});

test('DEFAULT_SCHEMA_V2 declares each core node type with kind=factual', () => {
    // SP-09: the default schema is now entirely factual — all domain-specific
    // episodic types (agent-run, agent-run-summary) were removed because they
    // belong to Loom, not Lore Core. Every remaining node type must be factual.
    for (const nt of DEFAULT_SCHEMA_V2.nodeTypes) {
        assert.equal(nt.kind, 'factual', `${nt.name} should be factual`);
    }
    const kinds = new Set(DEFAULT_SCHEMA_V2.nodeTypes.map(nt => nt.kind));
    assert.ok(kinds.has('factual'), 'default schema should have factual node types');
    assert.ok(!kinds.has('episodic'), 'default schema should have no episodic types (domain-specific; belongs in client schema)');
});

/* ---------- SP-09: schema-agnostic regression gate ---------- */

test('SP-09: DEFAULT_SCHEMA_V2 contains no domain-specific (Loom/Atlas) node types', () => {
    // Regression gate: ensures Core never re-acquires domain types that belong
    // in client application schemas (Loom agent types, Atlas code-intel types, etc.).
    const DOMAIN_TYPES = [
        'agent-run', 'agent-run-summary', 'scheduled-task', // Loom-domain
        'file_ref', 'code_symbol',                          // Atlas-domain
    ];
    const names = new Set(DEFAULT_SCHEMA_V2.nodeTypes.map(nt => nt.name));
    for (const t of DOMAIN_TYPES) {
        assert.ok(!names.has(t), `DEFAULT_SCHEMA_V2 must not contain domain type '${t}' (belongs in client schema)`);
    }
});

test('SP-09: DEFAULT_SCHEMA_V2 systemPrompt is empty (no developer-persona prompt)', () => {
    // The default schema carries no developer-specific context.
    // Each client application supplies its own systemPrompt in schema.json.
    assert.equal(
        DEFAULT_SCHEMA_V2.systemPrompt.trim(),
        '',
        'DEFAULT_SCHEMA_V2.systemPrompt must be empty — domain context belongs in client schemas',
    );
});

test('SP-09: DEFAULT_SCHEMA_V2 contains exactly the six generic knowledge types', () => {
    const EXPECTED = new Set([
        'decision', 'convention', 'note',
        'bug_pattern', 'architecture', 'troubleshooting',
    ]);
    const actual = new Set(DEFAULT_SCHEMA_V2.nodeTypes.map(nt => nt.name));
    for (const t of EXPECTED) {
        assert.ok(actual.has(t), `DEFAULT_SCHEMA_V2 must contain generic type '${t}'`);
    }
    assert.equal(actual.size, EXPECTED.size, `DEFAULT_SCHEMA_V2 must have exactly ${EXPECTED.size} node types; got ${actual.size}`);
});

/* ---------- Legacy migration ---------- */

test('legacy schema migrates with kind=factual default', () => {
    const legacy: LegacyLoreSchema = {
        domain: 'Test',
        description: 'A legacy schema.',
        nodeTypes: ['memory', 'observation'],
        edgeRelations: ['saw', 'said'],
        systemPrompt: 'be helpful',
    };
    const v2 = migrateLegacySchema(legacy);
    assert.equal(v2.version, SCHEMA_FORMAT_VERSION);
    assert.equal(v2.nodeTypes.length, 2);
    for (const nt of v2.nodeTypes) {
        assert.equal(nt.kind, DEFAULT_NODE_KIND);
    }
    const edgeNames = v2.edgeTypes.map(e => e.name);
    assert.ok(edgeNames.includes('saw'));
    assert.ok(edgeNames.includes('said'));
    for (const r of REBAC_RELATION_EDGE_NAMES) {
        assert.ok(edgeNames.includes(r), `migrated schema should include ReBAC '${r}'`);
    }
});

test('legacy migration drops duplicates that collide with ReBAC names', () => {
    const legacy: LegacyLoreSchema = {
        domain: 'Test', description: '',
        nodeTypes: [],
        edgeRelations: ['owner', 'custom'],
        systemPrompt: '',
    };
    const v2 = migrateLegacySchema(legacy);
    const ownerEdges = v2.edgeTypes.filter(e => e.name === 'owner');
    assert.equal(ownerEdges.length, 1, 'owner should appear exactly once');
    assert.equal(
        ownerEdges[0].description,
        'Subject has full control of the resource.',
        'ReBAC owner description should win over legacy',
    );
});

/* ---------- Validation: errors ---------- */

test('validation flags invalid kind', () => {
    const bad: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [
            { name: 'bogus', description: '', kind: 'whatever' as 'factual' },
        ],
    };
    const r = validateSchema(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("invalid kind 'whatever'")));
});

test('validation flags duplicate node types', () => {
    const bad: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [
            { name: 'thing', description: '', kind: 'factual' },
            { name: 'thing', description: '', kind: 'factual' },
        ],
    };
    const r = validateSchema(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("duplicate node type 'thing'")));
});

test('validation flags field that collides with floor', () => {
    const bad: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [
            {
                name: 'thing', description: '', kind: 'factual',
                fields: [{ name: 'id', type: 'string' }],
            },
        ],
    };
    const r = validateSchema(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('collides with floor field')));
});

test('validation flags fields declared on a ReBAC relation edge', () => {
    const bad: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        edgeTypes: [
            ...DEFAULT_SCHEMA_V2.edgeTypes,
            {
                name: 'editor', description: 'override',
                fields: [{ name: 'extra', type: 'string' }],
            },
        ],
    };
    const r = validateSchema(bad);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.includes('platform-locked')));
});

test('validation flags permission expression with unknown relation', () => {
    const bad: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [
            { name: 'property', description: '', kind: 'factual' },
        ],
        permissions: {
            property: {
                approve_ticket: 'editor | superhero',
            },
        },
    };
    const r = validateSchema(bad);
    assert.equal(r.valid, false);
    assert.ok(
        r.errors.some(e => e.includes("unknown relation 'superhero'")),
        `errors: ${JSON.stringify(r.errors)}`,
    );
});

test('validation accepts permission expression using only ReBAC relations', () => {
    const ok: LoreSchemaV2 = {
        ...DEFAULT_SCHEMA_V2,
        nodeTypes: [
            { name: 'property', description: '', kind: 'factual' },
        ],
        permissions: {
            property: {
                view: 'viewer | editor | owner',
                approve_ticket: 'editor | owner',
                transfer_owner: 'owner',
            },
        },
    };
    const r = validateSchema(ok);
    assert.ok(r.valid, `unexpected errors: ${JSON.stringify(r.errors)}`);
});

/* ---------- Loader ---------- */

test('SchemaLoader returns defaults when no schema.json present', () => {
    withTempDir(dir => {
        const loader = new SchemaLoader(dir);
        const v2 = loader.getV2();
        assert.equal(v2.version, SCHEMA_FORMAT_VERSION);
        assert.deepEqual(v2.nodeTypes.length, DEFAULT_SCHEMA_V2.nodeTypes.length);
        const legacy = loader.get();
        assert.ok(legacy.nodeTypes.includes('decision'));
        assert.ok(legacy.edgeRelations.includes('owner'));
    });
});

test('SchemaLoader migrates a legacy schema.json on load', () => {
    withTempDir(dir => {
        const loreDir = path.join(dir, '.lore');
        fs.mkdirSync(loreDir, { recursive: true });
        const legacy: LegacyLoreSchema = {
            domain: 'Family',
            description: 'family workspace',
            nodeTypes: ['Person', 'Event'],
            edgeRelations: ['lives_with', 'attended'],
            systemPrompt: 'family helper',
        };
        fs.writeFileSync(
            path.join(loreDir, 'schema.json'),
            JSON.stringify(legacy),
        );
        const loader = new SchemaLoader(dir);
        const v2 = loader.getV2();
        assert.equal(v2.domain, 'Family');
        const personNode = v2.nodeTypes.find(n => n.name === 'Person');
        assert.ok(personNode, 'Person node should be present');
        assert.equal(personNode!.kind, 'factual');
        const edgeNames = v2.edgeTypes.map(e => e.name);
        assert.ok(edgeNames.includes('lives_with'));
        for (const r of REBAC_RELATION_EDGE_NAMES) {
            assert.ok(edgeNames.includes(r), `should include ReBAC '${r}'`);
        }
        const legacyShape = loader.get();
        assert.ok(legacyShape.nodeTypes.includes('Person'));
        assert.ok(legacyShape.edgeRelations.includes('owner'));
    });
});

test('SchemaLoader reads a V2 schema.json directly', () => {
    withTempDir(dir => {
        const loreDir = path.join(dir, '.lore');
        fs.mkdirSync(loreDir, { recursive: true });
        const v2: Partial<LoreSchemaV2> = {
            version: SCHEMA_FORMAT_VERSION,
            domain: 'workspace-a',
            description: 'a domain workspace',
            nodeTypes: [
                { name: 'Tenant', description: 'A tenant.', kind: 'factual' },
                { name: 'Conversation', description: 'A chat.', kind: 'episodic', appendOnly: true },
            ],
            edgeTypes: [
                ...REBAC_RELATION_EDGES,
                { name: 'leases', description: 'tenant leases a unit' },
            ],
            permissions: {
                Tenant: { view: 'viewer | editor | owner' },
            },
            systemPrompt: 'domain helper',
        };
        fs.writeFileSync(
            path.join(loreDir, 'schema.json'),
            JSON.stringify(v2),
        );
        const loader = new SchemaLoader(dir);
        const got = loader.getV2();
        assert.equal(got.domain, 'workspace-a');
        const tenant = got.nodeTypes.find(n => n.name === 'Tenant');
        const convo = got.nodeTypes.find(n => n.name === 'Conversation');
        assert.equal(tenant!.kind, 'factual');
        assert.equal(convo!.kind, 'episodic');
        assert.equal(convo!.appendOnly, true);
    });
});

/* ---------- Summary ---------- */

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
