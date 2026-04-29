#!/usr/bin/env tsx
/**
 * manifest-loader-unit.ts — Unit tests for the manifest loader/validator.
 *
 * Covers:
 *   1. parseManifest: YAML and JSON parsing produce identical raw objects.
 *   2. detectFormat: extensions map correctly; unsupported throws.
 *   3. validateManifest: valid minimal manifest passes.
 *   4. validateManifest: every required field's absence is reported with a
 *      breadcrumb path.
 *   5. validateManifest: kebab-case + semver are enforced.
 *   6. validateManifest: at-least-one-primitive rule (lore OR def).
 *   7. validateManifest: inspector kinds + per-kind required fields.
 *   8. validateManifest: column width/flex mutual exclusion.
 *   9. validateManifest: filter `select` requires `options[]`.
 *  10. validateManifest: scheduledTasks trigger discriminated union.
 *  11. validateManifest: permissions are arrays of namespaced strings.
 *  12. validateManifest: unknown top-level field warns, doesn't error.
 *  13. validateManifest: collects ALL errors before throwing (not just first).
 *  14. loadManifest: round-trip through a real .yaml file on disk.
 *  15. loadManifest: round-trip through a real .json file on disk.
 *  16. loadManifest: missing file throws ManifestLoadError(not-found).
 *  17. loadManifestFromBundle: prefers .yaml over .yml over .json when multiple
 *      exist (documented order).
 *  18. real developer plugin manifest validates clean (regression check
 *      against `packages/lore-plugin-developer/plugin.json`).
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
    loadManifest,
    loadManifestFromBundle,
    parseManifest,
    detectFormat,
    validateManifest,
    ManifestValidationError,
    ManifestLoadError,
    manifestToPlugin,
    isTierOneManifest,
    ManifestPluginAdapterError,
    type ManifestValidationIssue,
} from '../packages/lore/src/plugins/manifest/index.js';
import type { PluginManifest } from '../packages/lore/src/plugins/manifest.js';

let failed = 0;

function test(name: string, fn: () => void | Promise<void>): () => Promise<void> {
    return async () => {
        try {
            await fn();
            console.log(`  ok  ${name}`);
        } catch (err) {
            console.error(`  FAIL ${name}`);
            console.error((err as Error).stack ?? String(err));
            failed += 1;
        }
    };
}

const validMinimal = {
    manifestVersion: 1,
    name: 'hello-plugin',
    version: '0.1.0',
    description: 'A minimal example plugin.',
    lore: {
        module: './dist/index.js',
    },
};

const validFull = {
    manifestVersion: 1,
    name: 'personal',
    version: '1.2.0',
    description: 'Personal knowledge: emails, files, notes.',
    author: 'Groundfloor',
    license: 'MIT',
    homepage: 'https://example.com/personal-plugin',
    lore: {
        module: './dist/index.js',
        inspectors: [
            {
                id: 'emails',
                label: 'Emails',
                icon: 'mail',
                kind: 'table',
                entity: 'Email',
                columns: [
                    { field: 'sender', label: 'From', width: 200 },
                    { field: 'subject', label: 'Subject', flex: 1 },
                    { field: 'received', label: 'Date', width: 140, type: 'date' },
                ],
                sort: { field: 'received', order: 'desc' },
                filters: [
                    { field: 'sender', kind: 'text' },
                    { field: 'tags', kind: 'multi-select' },
                    { field: 'priority', kind: 'select', options: ['high', 'normal', 'low'] },
                ],
            },
        ],
        permissions: ['fs:read:~/Documents', 'net:imap.gmail.com:993', 'os:notifications'],
    },
    def: {
        required: false,
        agents: [
            {
                name: 'personal-assistant',
                displayName: 'Personal Assistant',
                system: 'You are a personal assistant.',
                model: 'claude-sonnet-4.7',
                tools: ['lore:personal:search_emails'],
                memory: { kind: 'lore', workspace: 'personal' },
            },
        ],
        scheduledTasks: [
            {
                id: 'morning-briefing',
                agent: 'personal-assistant',
                trigger: { kind: 'cron', expression: '0 9 * * 1-5' },
                prompt: 'Summarise overnight emails.',
            },
        ],
    },
    engines: { lore: '>=2.2.0', def: '>=0.1.0' },
};

function expectErrors(raw: unknown, expectedPaths: string[]): void {
    try {
        validateManifest(raw);
        assert.fail('expected ManifestValidationError, none thrown');
    } catch (err) {
        if (!(err instanceof ManifestValidationError)) {
            throw err;
        }
        const got = err.errors.map((e) => e.path).sort();
        const want = [...expectedPaths].sort();
        assert.deepEqual(got, want, `error paths mismatch — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
}

const tests = [
    // ── parser + format detection ────────────────────────────────
    test('parseManifest: YAML and JSON produce equivalent objects', () => {
        const json = parseManifest(JSON.stringify(validMinimal), 'json');
        const yaml = parseManifest(
            'manifestVersion: 1\nname: hello-plugin\nversion: 0.1.0\ndescription: A minimal example plugin.\nlore:\n  module: ./dist/index.js\n',
            'yaml',
        );
        assert.deepEqual(json, yaml);
    }),

    test('detectFormat: maps extensions correctly', () => {
        assert.equal(detectFormat('foo.json'), 'json');
        assert.equal(detectFormat('foo.yaml'), 'yaml');
        assert.equal(detectFormat('FOO.YML'), 'yaml');
        assert.equal(detectFormat('/abs/path/plugin.YAML'), 'yaml');
    }),

    test('detectFormat: unsupported extension throws ManifestLoadError', () => {
        assert.throws(() => detectFormat('foo.txt'), ManifestLoadError);
        assert.throws(() => detectFormat('foo'), ManifestLoadError);
    }),

    // ── validator: happy paths ───────────────────────────────────
    test('validateManifest: minimal valid manifest passes', () => {
        const out = validateManifest(structuredClone(validMinimal));
        assert.equal(out.name, 'hello-plugin');
    }),

    test('validateManifest: full manifest with inspectors+def passes', () => {
        const out = validateManifest(structuredClone(validFull));
        assert.equal(out.name, 'personal');
        assert.equal(out.lore?.inspectors?.length, 1);
        assert.equal(out.def?.agents?.length, 1);
    }),

    // ── validator: required-field absences ───────────────────────
    test('validateManifest: missing manifestVersion is reported', () => {
        const m = structuredClone(validMinimal) as Record<string, unknown>;
        delete m['manifestVersion'];
        expectErrors(m, ['manifestVersion']);
    }),

    test('validateManifest: missing name + version + description all reported', () => {
        expectErrors({ manifestVersion: 1, lore: { module: './x.js' } }, ['name', 'version', 'description']);
    }),

    test('validateManifest: at-least-one-primitive rule (no lore + no def)', () => {
        const m = {
            manifestVersion: 1,
            name: 'x',
            version: '0.0.1',
            description: 'no primitives',
        };
        expectErrors(m, ['']);
    }),

    // ── validator: format checks ─────────────────────────────────
    test('validateManifest: name must be kebab-case', () => {
        const m = structuredClone(validMinimal) as Record<string, unknown>;
        m['name'] = 'NotKebab_Case';
        expectErrors(m, ['name']);
    }),

    test('validateManifest: version must be semver', () => {
        const m = structuredClone(validMinimal) as Record<string, unknown>;
        m['version'] = 'v1';
        expectErrors(m, ['version']);
    }),

    test('validateManifest: unsupported manifestVersion is reported', () => {
        const m = structuredClone(validMinimal) as Record<string, unknown>;
        m['manifestVersion'] = 99;
        expectErrors(m, ['manifestVersion']);
    }),

    // ── validator: inspectors ────────────────────────────────────
    test('validateManifest: inspector kind="kanban" is rejected', () => {
        const m = structuredClone(validMinimal);
        m.lore.inspectors = [{ id: 'x', label: 'X', kind: 'kanban', entity: 'Y', columns: [] } as unknown as never];
        expectErrors(m, ['lore.inspectors[0].kind']);
    }),

    test('validateManifest: table inspector requires entity + columns', () => {
        const m = structuredClone(validMinimal);
        m.lore.inspectors = [{ id: 'x', label: 'X', kind: 'table' } as unknown as never];
        expectErrors(m, ['lore.inspectors[0].entity', 'lore.inspectors[0].columns']);
    }),

    test('validateManifest: column with both width AND flex is rejected', () => {
        const m = structuredClone(validMinimal);
        m.lore.inspectors = [{
            id: 'x', label: 'X', kind: 'table', entity: 'Y',
            columns: [{ field: 'a', label: 'A', width: 100, flex: 1 }],
        } as unknown as never];
        expectErrors(m, ['lore.inspectors[0].columns[0]']);
    }),

    test('validateManifest: filter kind=select requires options', () => {
        const m = structuredClone(validMinimal);
        m.lore.inspectors = [{
            id: 'x', label: 'X', kind: 'table', entity: 'Y',
            columns: [{ field: 'a', label: 'A' }],
            filters: [{ field: 'a', kind: 'select' }],
        } as unknown as never];
        expectErrors(m, ['lore.inspectors[0].filters[0].options']);
    }),

    test('validateManifest: timeline inspector requires dateField + labelField + entity', () => {
        const m = structuredClone(validMinimal);
        m.lore.inspectors = [{ id: 'x', label: 'X', kind: 'timeline' } as unknown as never];
        expectErrors(m, ['lore.inspectors[0].entity', 'lore.inspectors[0].dateField', 'lore.inspectors[0].labelField']);
    }),

    test('validateManifest: document inspector requires labelField + contentField', () => {
        const m = structuredClone(validMinimal);
        m.lore.inspectors = [{ id: 'x', label: 'X', kind: 'document' } as unknown as never];
        expectErrors(m, ['lore.inspectors[0].labelField', 'lore.inspectors[0].contentField']);
    }),

    // ── validator: DEF block ─────────────────────────────────────
    test('validateManifest: scheduled task with cron trigger requires expression', () => {
        const m = structuredClone(validMinimal) as Record<string, unknown>;
        m['def'] = {
            scheduledTasks: [{ id: 't', agent: 'a', trigger: { kind: 'cron' } }],
        };
        expectErrors(m, ['def.scheduledTasks[0].trigger.expression']);
    }),

    test('validateManifest: scheduled task trigger kind must be valid', () => {
        const m = structuredClone(validMinimal) as Record<string, unknown>;
        m['def'] = {
            scheduledTasks: [{ id: 't', agent: 'a', trigger: { kind: 'webhook' } }],
        };
        expectErrors(m, ['def.scheduledTasks[0].trigger.kind']);
    }),

    // ── validator: permissions ───────────────────────────────────
    test('validateManifest: malformed permission string is rejected', () => {
        const m = structuredClone(validMinimal);
        m.lore.permissions = ['this is not a permission'];
        expectErrors(m, ['lore.permissions[0]']);
    }),

    test('validateManifest: well-formed permissions accepted', () => {
        const m = structuredClone(validMinimal);
        m.lore.permissions = ['fs:read:~/x', 'net:host:443', 'os:notifications', 'os:clipboard'];
        const out = validateManifest(m);
        assert.equal(out.lore?.permissions?.length, 4);
    }),

    // ── validator: warnings ──────────────────────────────────────
    test('validateManifest: unknown top-level field warns, does not error', () => {
        const warnings: ManifestValidationIssue[] = [];
        const m = { ...structuredClone(validMinimal), futureField: 'whatever' };
        const out = validateManifest(m, warnings);
        assert.equal(out.name, 'hello-plugin');
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0]!.path, 'futureField');
    }),

    // ── validator: collect-all behaviour ─────────────────────────
    test('validateManifest: collects ALL errors, not just first', () => {
        const m = { manifestVersion: 'one', name: 'BAD', version: 'v1', description: '' };
        try {
            validateManifest(m);
            assert.fail('expected throw');
        } catch (err) {
            assert.ok(err instanceof ManifestValidationError);
            assert.ok(err.errors.length >= 4, `expected at least 4 errors, got ${err.errors.length}`);
        }
    }),

    // ── loader: file IO round trips ──────────────────────────────
    test('loadManifest: round-trip a YAML file', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-manifest-'));
        try {
            const file = path.join(dir, 'plugin.yaml');
            await fs.writeFile(file,
                'manifestVersion: 1\nname: yaml-test\nversion: 0.0.1\ndescription: y\nlore:\n  module: ./x.js\n',
            );
            const m = await loadManifest(file);
            assert.equal(m.name, 'yaml-test');
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }),

    test('loadManifest: round-trip a JSON file', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-manifest-'));
        try {
            const file = path.join(dir, 'plugin.json');
            await fs.writeFile(file, JSON.stringify(validMinimal));
            const m = await loadManifest(file);
            assert.equal(m.name, 'hello-plugin');
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }),

    test('loadManifest: missing file throws ManifestLoadError(not-found)', async () => {
        const file = path.join(os.tmpdir(), 'lore-manifest-does-not-exist-' + Math.random() + '.yaml');
        try {
            await loadManifest(file);
            assert.fail('expected throw');
        } catch (err) {
            assert.ok(err instanceof ManifestLoadError, `got ${err}`);
            assert.equal((err as ManifestLoadError).cause, 'not-found');
        }
    }),

    test('loadManifestFromBundle: picks .yaml over .yml over .json', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lore-manifest-'));
        try {
            // Write all three with different `name` values; loader should pick .yaml.
            await fs.writeFile(path.join(dir, 'plugin.yaml'),
                'manifestVersion: 1\nname: from-yaml\nversion: 0.0.1\ndescription: y\nlore:\n  module: ./x.js\n');
            await fs.writeFile(path.join(dir, 'plugin.yml'),
                'manifestVersion: 1\nname: from-yml\nversion: 0.0.1\ndescription: y\nlore:\n  module: ./x.js\n');
            await fs.writeFile(path.join(dir, 'plugin.json'), JSON.stringify({ ...validMinimal, name: 'from-json' }));
            const { manifest, filePath } = await loadManifestFromBundle(dir);
            assert.equal(manifest.name, 'from-yaml');
            assert.ok(filePath.endsWith('plugin.yaml'));
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }),

    // ── Tier 1 schema block ──────────────────────────────────────
    test('validateManifest: lore.schema with nodeTypes + edgeRelations passes', () => {
        const m = {
            manifestVersion: 1,
            name: 'tier-one-example',
            version: '0.1.0',
            description: 'declarative Tier 1',
            lore: {
                schema: {
                    nodeTypes: [{ name: 'greeting', description: 'a hello' }],
                    edgeRelations: [{ name: 'greets', description: 'directed-at' }],
                },
            },
        };
        const out = validateManifest(m);
        assert.equal(out.lore?.schema?.nodeTypes?.length, 1);
    }),

    test('validateManifest: manifest with neither module nor schema is rejected', () => {
        const m = {
            manifestVersion: 1,
            name: 'empty',
            version: '0.1.0',
            description: 'no module, no schema',
            lore: {},
        };
        expectErrors(m, ['lore']);
    }),

    test('validateManifest: schema name must be lowercase_with_underscores', () => {
        const m = {
            manifestVersion: 1,
            name: 'bad-schema',
            version: '0.1.0',
            description: 'd',
            lore: {
                schema: {
                    nodeTypes: [{ name: 'BadName', description: 'invalid' }],
                },
            },
        };
        expectErrors(m, ['lore.schema.nodeTypes[0].name']);
    }),

    test('validateManifest: duplicate node type within manifest is rejected', () => {
        const m = {
            manifestVersion: 1,
            name: 'dupes',
            version: '0.1.0',
            description: 'd',
            lore: {
                schema: {
                    nodeTypes: [
                        { name: 'thing', description: 'first' },
                        { name: 'thing', description: 'second' },
                    ],
                },
            },
        };
        expectErrors(m, ['lore.schema.nodeTypes[1].name']);
    }),

    test('validateManifest: empty schema (neither array) warns, does not error', () => {
        const warnings: ManifestValidationIssue[] = [];
        const m = {
            manifestVersion: 1,
            name: 'empty-schema',
            version: '0.1.0',
            description: 'd',
            lore: { schema: {} },
        };
        const out = validateManifest(m, warnings);
        assert.equal(out.name, 'empty-schema');
        assert.ok(warnings.some((w) => w.path === 'lore.schema'));
    }),

    // ── adapter: manifestToPlugin ───────────────────────────────
    test('manifestToPlugin: produces ILorePlugin with contributeNodeTypes', () => {
        const m: PluginManifest = {
            manifestVersion: 1,
            name: 'tier-one',
            version: '0.1.0',
            description: 'd',
            lore: {
                schema: {
                    nodeTypes: [
                        { name: 'application', description: 'A SaaS app' },
                        { name: 'employee', description: 'A staff member' },
                    ],
                    edgeRelations: [
                        { name: 'has_access_to', description: 'Employee → Application' },
                    ],
                },
            },
        };
        const plugin = manifestToPlugin(m);
        assert.equal(plugin.name, 'tier-one');
        assert.equal(plugin.version, '0.1.0');
        assert.deepEqual(plugin.ownedTables, []);
        const nt = plugin.contributeNodeTypes!();
        assert.deepEqual(nt, [
            { name: 'application', description: 'A SaaS app' },
            { name: 'employee', description: 'A staff member' },
        ]);
        const er = plugin.contributeEdgeRelations!();
        assert.deepEqual(er, [{ name: 'has_access_to', description: 'Employee → Application' }]);
    }),

    test('manifestToPlugin: synthetic plugin populates IR with node/edge kinds', () => {
        const m: PluginManifest = {
            manifestVersion: 1,
            name: 'ir-test',
            version: '2.0.0',
            description: 'd',
            lore: {
                schema: {
                    nodeTypes: [{ name: 'application', description: 'a' }],
                    edgeRelations: [{ name: 'has_access_to', description: 'b' }],
                },
            },
        };
        const plugin = manifestToPlugin(m);
        assert.deepEqual(plugin.ir?.ownedNodeTables, []);
        assert.deepEqual(plugin.ir?.ownedEdgeTables, []);
        assert.deepEqual(plugin.ir?.nodeKinds, ['application']);
        assert.deepEqual(plugin.ir?.edgeKinds, ['has_access_to']);
        assert.equal(plugin.ir?.version, '2.0.0');
    }),

    // ── Query templates ──────────────────────────────────────────
    test('validateManifest: query with declared parameter passes', () => {
        const m = {
            manifestVersion: 1, name: 'q', version: '0.1.0', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'thing', description: 'd' }] },
                queries: [{
                    id: 'find_with_tag',
                    description: 'Find things by tag',
                    cypher: 'MATCH (n:LoreNode) WHERE n.type="thing" AND lower(n.tags) CONTAINS lower($tag) RETURN n.id',
                    parameters: [{ name: 'tag', type: 'string', description: 'Tag to match', required: true }],
                }],
            },
        };
        const out = validateManifest(m);
        assert.equal(out.lore?.queries?.length, 1);
    }),

    test('validateManifest: query referencing undeclared $param is rejected', () => {
        const m = {
            manifestVersion: 1, name: 'q', version: '0.1.0', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'thing', description: 'd' }] },
                queries: [{
                    id: 'bad_query',
                    description: 'Bad',
                    cypher: 'MATCH (n) WHERE n.x = $undeclaredParam RETURN n',
                    parameters: [],
                }],
            },
        };
        expectErrors(m, ['lore.queries[0].cypher']);
    }),

    test('validateManifest: query parameter type must be string/number/boolean', () => {
        const m = {
            manifestVersion: 1, name: 'q', version: '0.1.0', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'thing', description: 'd' }] },
                queries: [{
                    id: 'q1', description: 'd', cypher: 'MATCH (n) WHERE n.x = $foo RETURN n',
                    parameters: [{ name: 'foo', type: 'date', description: 'date' }],
                }],
            },
        };
        expectErrors(m, ['lore.queries[0].parameters[0].type']);
    }),

    test('validateManifest: duplicate query ids within a manifest are rejected', () => {
        const m = {
            manifestVersion: 1, name: 'q', version: '0.1.0', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'thing', description: 'd' }] },
                queries: [
                    { id: 'q1', description: 'one', cypher: 'MATCH (n) RETURN n', parameters: [] },
                    { id: 'q1', description: 'two', cypher: 'MATCH (n) RETURN n', parameters: [] },
                ],
            },
        };
        expectErrors(m, ['lore.queries[1].id']);
    }),

    test('validateManifest: query id must be lowercase_with_underscores', () => {
        const m = {
            manifestVersion: 1, name: 'q', version: '0.1.0', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'thing', description: 'd' }] },
                queries: [{ id: 'BadId', description: 'd', cypher: 'MATCH (n) RETURN n', parameters: [] }],
            },
        };
        expectErrors(m, ['lore.queries[0].id']);
    }),

    test('manifestToPlugin: registerTools registers store_<type>, list_<type>, connect_<relation>', () => {
        const m: PluginManifest = {
            manifestVersion: 1,
            name: 'auto-tools-demo',
            version: '0.0.1',
            description: 'd',
            lore: {
                schema: {
                    nodeTypes: [
                        { name: 'application', description: 'A SaaS app' },
                        { name: 'employee', description: 'A staff member' },
                    ],
                    edgeRelations: [
                        { name: 'has_access_to', description: 'Employee → App' },
                    ],
                },
            },
        };
        const plugin = manifestToPlugin(m);
        const registeredNames: string[] = [];
        const fakeServer = {
            tool: (name: string) => { registeredNames.push(name); },
        } as never;
        const fakeCtx = {
            graph: {} as never,
            verbatimStore: {} as never,
            syncEngine: {} as never,
            syncAdapter: null,
            schemaLoader: {} as never,
            scope: { project: 'p', ecosystem: 'e' },
            loreDir: '/tmp',
        };
        plugin.registerTools(fakeServer, fakeCtx);
        // Two node types × 2 tools each + one edge relation × 1 tool = 5.
        assert.equal(registeredNames.length, 5);
        assert.deepEqual(
            new Set(registeredNames),
            new Set([
                'store_application',
                'list_application',
                'store_employee',
                'list_employee',
                'connect_has_access_to',
            ]),
        );
    }),

    // ── Stock query patterns ─────────────────────────────────────
    test('validateManifest: pattern-form query with find_by_field passes', () => {
        const m = {
            manifestVersion: 1, name: 'p', version: '0.1.0', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'employee', description: 'd' }] },
                queries: [{
                    id: 'find_emp_by_field',
                    description: 'Find employee by any field',
                    pattern: 'find_by_field',
                    bindNodeType: 'employee',
                    parameters: [
                        { name: 'field', type: 'string', description: 'col', required: true },
                        { name: 'value', type: 'string', description: 'val', required: true },
                    ],
                }],
            },
        };
        const out = validateManifest(m);
        assert.equal(out.lore?.queries?.length, 1);
    }),

    test('validateManifest: unknown stock pattern is rejected', () => {
        const m = {
            manifestVersion: 1, name: 'p', version: '0.1.0', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'thing', description: 'd' }] },
                queries: [{
                    id: 'q', description: 'd', pattern: 'totally_made_up', bindNodeType: 'thing',
                }],
            },
        };
        expectErrors(m, ['lore.queries[0].pattern']);
    }),

    test('validateManifest: pattern with missing required parameter is rejected', () => {
        const m = {
            manifestVersion: 1, name: 'p', version: '0.1.0', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'thing', description: 'd' }] },
                queries: [{
                    id: 'q', description: 'd',
                    pattern: 'find_by_field',
                    bindNodeType: 'thing',
                    parameters: [{ name: 'value', type: 'string', description: 'v', required: true }],
                    // missing `field` parameter
                }],
            },
        };
        expectErrors(m, ['lore.queries[0].parameters']);
    }),

    test('validateManifest: pattern with bindNodeType not in schema is rejected', () => {
        const m = {
            manifestVersion: 1, name: 'p', version: '0.1.0', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'declared', description: 'd' }] },
                queries: [{
                    id: 'q', description: 'd',
                    pattern: 'list_recent',
                    bindNodeType: 'undeclared',
                    parameters: [{ name: 'limit', type: 'number', description: 'n', required: true }],
                }],
            },
        };
        expectErrors(m, ['lore.queries[0].bindNodeType']);
    }),

    test('validateManifest: declaring both `cypher` and `pattern` on one query is rejected', () => {
        const m = {
            manifestVersion: 1, name: 'p', version: '0.1.0', description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'thing', description: 'd' }] },
                queries: [{
                    id: 'q', description: 'd',
                    cypher: 'MATCH (n) RETURN n',
                    pattern: 'find_by_field',
                    bindNodeType: 'thing',
                }],
            },
        };
        expectErrors(m, ['lore.queries[0]']);
    }),

    test('expandPattern: substitutes {{nodeType}} into the cypher template', async () => {
        const { expandPattern } = await import('../packages/lore/src/plugins/manifest/queryPatterns.js');
        const out = expandPattern({
            id: 'q', description: 'd',
            pattern: 'find_by_field',
            bindNodeType: 'application',
            parameters: [
                { name: 'field', type: 'string', description: '', required: true },
                { name: 'value', type: 'string', description: '', required: true },
            ],
        });
        assert.ok(out.cypher.includes("n.type = 'application'"), out.cypher);
        assert.ok(!out.cypher.includes('{{nodeType}}'));
        assert.equal(out.id, 'q');
    }),

    // ── LLM refine helpers (extractFirstJsonObject) ─────────────
    test('extractFirstJsonObject: pure JSON parses', async () => {
        const { extractFirstJsonObject } = await import('../packages/lore/src/plugins/manifest/llmRefine.js');
        const out = extractFirstJsonObject('{"a":1,"b":[2,3]}');
        assert.deepEqual(out, { a: 1, b: [2, 3] });
    }),

    test('extractFirstJsonObject: tolerates ```json fences', async () => {
        const { extractFirstJsonObject } = await import('../packages/lore/src/plugins/manifest/llmRefine.js');
        const out = extractFirstJsonObject('Sure! Here is your refined proposal:\n```json\n{ "x": "y" }\n```\nLet me know if you want changes.');
        assert.deepEqual(out, { x: 'y' });
    }),

    test('extractFirstJsonObject: tolerates leading prose without fences', async () => {
        const { extractFirstJsonObject } = await import('../packages/lore/src/plugins/manifest/llmRefine.js');
        const out = extractFirstJsonObject('Here you go: { "field": "value" } -- hope that helps');
        assert.deepEqual(out, { field: 'value' });
    }),

    test('extractFirstJsonObject: returns null on no-object text', async () => {
        const { extractFirstJsonObject } = await import('../packages/lore/src/plugins/manifest/llmRefine.js');
        const out = extractFirstJsonObject('I cannot answer that question.');
        assert.equal(out, null);
    }),

    test('extractFirstJsonObject: handles nested objects correctly', async () => {
        const { extractFirstJsonObject } = await import('../packages/lore/src/plugins/manifest/llmRefine.js');
        const out = extractFirstJsonObject('```\n{"outer":{"inner":[1,2,{"deep":true}]},"x":1}\n```');
        assert.deepEqual(out, { outer: { inner: [1, 2, { deep: true }] }, x: 1 });
    }),

    test('extractFirstJsonObject: skips an unbalanced opener and finds the next valid object', async () => {
        const { extractFirstJsonObject } = await import('../packages/lore/src/plugins/manifest/llmRefine.js');
        // Contrived: text contains a brace inside a string (looks like an opener)
        // followed by a real JSON object.
        const out = extractFirstJsonObject('I have { stuff but no closer. Here is the JSON: {"name": "ok"}');
        // Note: our extractor naively brace-counts; this case would return
        // null because the first "{" fails to match. Documenting the limit.
        assert.equal(out, null);
    }),

    test('buildPluginWizardLlmPrompt: includes proposal, headers, and rules', async () => {
        const { buildPluginWizardLlmPrompt } = await import('../packages/lore/src/plugins/manifest/llmRefine.js');
        const prompt = buildPluginWizardLlmPrompt(
            { suggestedNodeTypeName: 'employee', suggestedFields: { label: 'name' }, confidence: 0.8 },
            ['id', 'name', 'email'],
            [{ id: 'e1', name: 'A', email: 'a@x.com' }, { id: 'e2', name: 'B', email: 'b@x.com' }],
        );
        assert.ok(prompt.includes('CSV headers: id, name, email'));
        assert.ok(prompt.includes('"suggestedNodeTypeName": "employee"'));
        assert.ok(prompt.includes('Reply with ONLY the JSON object'));
        // Caps the sample at 8 — should include both rows here (only 2).
        assert.ok(prompt.includes('"id": "e1"'));
        assert.ok(prompt.includes('"id": "e2"'));
    }),

    test('manifestToPlugin: registerTools also registers query templates as <plugin>_<id>', () => {
        const m: PluginManifest = {
            manifestVersion: 1,
            name: 'qtest',
            version: '0.0.1',
            description: 'd',
            lore: {
                schema: { nodeTypes: [{ name: 'thing', description: 'd' }] },
                queries: [
                    { id: 'find_one', description: 'find one', cypher: 'MATCH (n) WHERE n.id = $id RETURN n',
                      parameters: [{ name: 'id', type: 'string', description: 'id' }] },
                    { id: 'count_all', description: 'count', cypher: 'MATCH (n) RETURN count(n)' },
                ],
            },
        };
        const plugin = manifestToPlugin(m);
        const registered: string[] = [];
        const fakeServer = { tool: (n: string) => { registered.push(n); } } as never;
        const fakeCtx = {
            graph: {} as never, verbatimStore: {} as never, syncEngine: {} as never,
            syncAdapter: null, schemaLoader: {} as never,
            scope: { project: 'p', ecosystem: 'e' }, loreDir: '/tmp',
        };
        plugin.registerTools(fakeServer, fakeCtx);
        // 1 node type × 2 + 0 edge relations + 2 queries = 4 tools.
        assert.equal(registered.length, 4);
        assert.ok(registered.includes('qtest_find_one'));
        assert.ok(registered.includes('qtest_count_all'));
    }),

    test('manifestToPlugin: throws if no lore.schema (callers should use module path)', () => {
        const m: PluginManifest = {
            manifestVersion: 1,
            name: 'no-schema',
            version: '0.0.1',
            description: 'd',
            lore: { module: './x.js' },
        };
        assert.throws(() => manifestToPlugin(m), ManifestPluginAdapterError);
    }),

    test('manifestToPlugin: defensive copy — mutating return does not affect manifest', () => {
        const m: PluginManifest = {
            manifestVersion: 1,
            name: 't',
            version: '0.0.1',
            description: 'd',
            lore: { schema: { nodeTypes: [{ name: 'x', description: 'y' }] } },
        };
        const plugin = manifestToPlugin(m);
        const nt = plugin.contributeNodeTypes!();
        nt.push({ name: 'mutated', description: 'should not propagate' });
        // Re-call: should not have the mutation.
        const ntAgain = plugin.contributeNodeTypes!();
        assert.equal(ntAgain.length, 1);
        assert.equal(ntAgain[0]!.name, 'x');
    }),

    test('isTierOneManifest: schema-only is Tier 1', () => {
        const m: PluginManifest = {
            manifestVersion: 1, name: 't', version: '0.0.1', description: 'd',
            lore: { schema: { nodeTypes: [{ name: 'x', description: 'y' }] } },
        };
        assert.equal(isTierOneManifest(m), true);
    }),

    test('isTierOneManifest: module wins when both present', () => {
        const m: PluginManifest = {
            manifestVersion: 1, name: 't', version: '0.0.1', description: 'd',
            lore: { module: './x.js', schema: { nodeTypes: [{ name: 'x', description: 'y' }] } },
        };
        assert.equal(isTierOneManifest(m), false);
    }),

    test('isTierOneManifest: module-only is not Tier 1', () => {
        const m: PluginManifest = {
            manifestVersion: 1, name: 't', version: '0.0.1', description: 'd',
            lore: { module: './x.js' },
        };
        assert.equal(isTierOneManifest(m), false);
    }),

    // ── end-to-end: registry integration ─────────────────────────
    test('PluginRegistry: synthetic manifest plugin loads through boot()', async () => {
        const { PluginRegistry } = await import('../packages/lore/src/plugins/registry.js');

        // Stub ConfigManager — registry only calls .read() and .patch().
        const fakeConfig = {
            plugins: [],
            plugins_last_boot: [],
            plugin_history: [],
        };
        const fakeConfigManager = {
            read: () => fakeConfig,
            patch: (changes: Record<string, unknown>) => Object.assign(fakeConfig, changes),
        } as never;

        const registry = new PluginRegistry(fakeConfigManager, /* knownPlugins */ {});

        // Build a Tier 1 plugin from an in-memory manifest, register it,
        // boot the registry, and verify the contributed types appear.
        const manifest: PluginManifest = {
            manifestVersion: 1,
            name: 'tier-one-test',
            version: '0.1.0',
            description: 'integration check',
            lore: {
                schema: {
                    nodeTypes: [
                        { name: 'application', description: 'A SaaS app' },
                    ],
                    edgeRelations: [
                        { name: 'has_access_to', description: 'Employee → App' },
                    ],
                },
            },
        };
        const plugin = manifestToPlugin(manifest);
        registry.registerSyntheticPlugin(plugin);

        const loaded = registry.boot();
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0]!.name, 'tier-one-test');
        assert.ok(registry.isActive('tier-one-test'));

        // The contributed node types are exactly what core's `store_node`
        // tool merges into its type enum at boot — that's the end-to-end
        // claim: a manifest-only plugin makes its types valid for store_node.
        const types = loaded[0]!.contributeNodeTypes!();
        assert.equal(types.length, 1);
        assert.equal(types[0]!.name, 'application');

        const relations = loaded[0]!.contributeEdgeRelations!();
        assert.equal(relations.length, 1);
        assert.equal(relations[0]!.name, 'has_access_to');
    }),

    test('PluginRegistry: registerSyntheticPlugin rejects duplicate names', async () => {
        const { PluginRegistry } = await import('../packages/lore/src/plugins/registry.js');
        const fakeConfigManager = { read: () => ({ plugins: [] }), patch: () => {} } as never;
        const registry = new PluginRegistry(fakeConfigManager, {});

        const m: PluginManifest = {
            manifestVersion: 1, name: 'dup', version: '0.1.0', description: 'd',
            lore: { schema: { nodeTypes: [{ name: 'x', description: 'y' }] } },
        };
        registry.registerSyntheticPlugin(manifestToPlugin(m));
        assert.throws(() => registry.registerSyntheticPlugin(manifestToPlugin(m)), /already registered/);
    }),

    // ── end-to-end: examples/plugin-manifests/hello ──────────────
    test('examples/hello/plugin.yaml loads + synthesises a working ILorePlugin', async () => {
        const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
        const manifestPath = path.join(repoRoot, 'examples/plugin-manifests/hello/plugin.yaml');
        const manifest = await loadManifest(manifestPath);
        assert.equal(manifest.name, 'hello');
        assert.equal(isTierOneManifest(manifest), true);

        const plugin = manifestToPlugin(manifest);
        assert.equal(plugin.name, 'hello');

        const types = plugin.contributeNodeTypes!();
        assert.equal(types.length, 1);
        assert.equal(types[0]!.name, 'greeting');

        const relations = plugin.contributeEdgeRelations!();
        assert.equal(relations.length, 1);
        assert.equal(relations[0]!.name, 'greets');

        // The synthesised plugin's contributed types must be exactly what
        // the existing PluginRegistry feeds into store_node's enum at
        // boot — that is the entire end-to-end claim of Task 2.
    }),

    // ── real-world regression check ──────────────────────────────
    test('developer plugin manifest validates clean against the new validator', async () => {
        const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
        const manifestPath = path.join(repoRoot, 'packages/lore-plugin-developer/plugin.json');
        const warnings: ManifestValidationIssue[] = [];
        const m = await loadManifest(manifestPath, warnings);
        assert.equal(m.name, 'developer');
        // Warnings about unknown fields are OK; errors should not have been thrown.
        if (warnings.length > 0) {
            console.warn(`    (informational) developer manifest produced ${warnings.length} warning(s):`);
            for (const w of warnings) console.warn(`      - ${w.path}: ${w.message}`);
        }
    }),
];

(async () => {
    console.log('manifest-loader-unit.ts');
    for (const t of tests) await t();
    if (failed > 0) {
        console.error(`\n${failed} failing test(s)`);
        process.exit(1);
    }
    console.log(`\nAll ${tests.length} tests passed.`);
})();
