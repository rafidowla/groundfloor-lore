#!/usr/bin/env tsx
/**
 * manifest-reference-plugins.test.ts — Phase 7.
 *
 * Validates the bundle-level plugin.json for all reference plugins
 * — both in-tree (developer, personal, legal) and external example
 * scaffolds (banking, rag) — against the v1 manifest spec.
 *
 * Why a separate test from manifest-developer-plugin.test.ts?
 *   - That test pinned the developer plugin specifically (Phase 4).
 *     This one proves the spec is *domain-agnostic* by exercising it
 *     across vocabularies (code, people, contracts, money, documents).
 *   - It also validates the externally-authored examples under
 *     examples/plugin-manifests/, demonstrating that a plugin manifest
 *     written outside the monorepo is held to the same contract.
 *
 * Layered like Phase 4's test:
 *   Layer 1 — file parses + assigns to PluginManifest (compile-time
 *             via tsc --noEmit on this file).
 *   Layer 2a — structural rules (mirror manifest.rs::load_from_path).
 *   Layer 2b — schema rules the Rust loader defers to TS.
 *   Layer 2c — per-plugin entity coverage assertions.
 *
 * Two checks differ between in-tree and external manifests:
 *   - in-tree: lore.module path must resolve to a real dist file.
 *   - external example: lore.module is a placeholder (./dist/index.js);
 *     we only check it's a non-empty relative path. These manifests
 *     are scaffolds for plugin authors; runtime isn't implemented.
 *
 * Usage: npx tsx test/manifest-reference-plugins.test.ts
 * Exit:  0 all green, 1 any failure.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
    PluginManifest,
    InspectorPanel,
    TableInspector,
    GraphInspector,
    TimelineInspector,
    DocumentInspector,
} from '../packages/lore/src/plugins/manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

interface ManifestFixture {
    /** Display name for the test header. */
    label: string;
    /** Absolute path to plugin.json. */
    manifestPath: string;
    /** True for in-tree plugins where dist/ should exist. */
    expectDistResolves: boolean;
    /** Required entities the inspectors must cover (in any kind). */
    requiredEntities: string[];
}

const FIXTURES: ManifestFixture[] = [
    {
        label: 'developer (in-tree)',
        manifestPath: join(REPO_ROOT, 'packages/lore-plugin-developer/plugin.json'),
        expectDistResolves: true,
        requiredEntities: ['CodeSymbol', 'CodeFile', 'DevActivity'],
    },
    {
        label: 'personal (in-tree)',
        manifestPath: join(REPO_ROOT, 'packages/lore-plugin-personal/plugin.json'),
        expectDistResolves: true,
        requiredEntities: ['Person', 'Place', 'PersonalEvent', 'Memory'],
    },
    {
        label: 'legal (in-tree)',
        manifestPath: join(REPO_ROOT, 'packages/lore-plugin-legal/plugin.json'),
        expectDistResolves: true,
        requiredEntities: ['Contract', 'Clause', 'Party'],
    },
    {
        label: 'banking (external example)',
        manifestPath: join(REPO_ROOT, 'examples/plugin-manifests/banking/plugin.json'),
        expectDistResolves: false,
        requiredEntities: ['Account', 'Transaction', 'Counterparty'],
    },
    {
        label: 'rag (external example)',
        manifestPath: join(REPO_ROOT, 'examples/plugin-manifests/rag/plugin.json'),
        expectDistResolves: false,
        requiredEntities: ['Document', 'Chunk', 'Source'],
    },
];

let failed = 0;
let passed = 0;
function check(name: string, condition: unknown, detail?: string): void {
    if (condition) {
        console.log(`    ✓ ${name}`);
        passed += 1;
    } else {
        console.log(`    ✗ ${name}${detail ? ` — ${detail}` : ''}`);
        failed += 1;
    }
}

function header(title: string): void {
    console.log(`\n  ${title}`);
}

const ALLOWED_KINDS = new Set(['table', 'graph', 'timeline', 'document']);
const KNOWN_PERMISSION_NAMESPACES = new Set(['fs', 'net', 'credentials', 'os']);

function validateManifest(fix: ManifestFixture): void {
    console.log(`\n━━━ ${fix.label} ━━━`);

    // ── Layer 1 — file + types ────────────────────────────────
    header('Layer 1 — file + types');
    check(`plugin.json exists at ${fix.manifestPath}`, existsSync(fix.manifestPath));

    const raw = readFileSync(fix.manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    check('plugin.json parses as JSON object', typeof parsed === 'object' && parsed != null);
    const manifest = parsed as PluginManifest;

    // ── Layer 2a — structural ─────────────────────────────────
    header('Layer 2a — structural (matches Rust loader)');
    check('manifestVersion === 1', manifest.manifestVersion === 1, `got ${manifest.manifestVersion}`);
    check('name is non-empty string', typeof manifest.name === 'string' && manifest.name.length > 0);
    check(
        'version is semver-shaped',
        typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version),
    );
    check(
        'description is non-empty',
        typeof manifest.description === 'string' && manifest.description.length > 0,
    );
    check(
        'has at least one primitive contribution',
        manifest.lore != null || manifest.def != null,
    );

    // ── Layer 2b — schema rules ──────────────────────────────
    header('Layer 2b — schema (TS-side checks)');
    const lore = manifest.lore;
    check('lore contribution present', lore != null);
    if (!lore) return;

    check('lore.module is a non-empty relative path', typeof lore.module === 'string' && lore.module.length > 0);

    if (fix.expectDistResolves) {
        check(
            'lore.module resolves to an existing dist file',
            existsSync(resolve(dirname(fix.manifestPath), lore.module)),
            `module path: ${resolve(dirname(fix.manifestPath), lore.module)}`,
        );
    } else {
        // External example — module is a placeholder, dist not built.
        check('lore.module is a relative path (./ or ../)', /^\.\.?\//.test(lore.module));
    }

    const inspectors: InspectorPanel[] = lore.inspectors ?? [];
    check('lore.inspectors[] is non-empty', inspectors.length > 0);

    const ids = new Set<string>();
    for (const insp of inspectors) {
        check(`inspector kind allowed: ${insp.kind} (id=${insp.id})`, ALLOWED_KINDS.has(insp.kind));
        check(`inspector id is unique: ${insp.id}`, !ids.has(insp.id));
        ids.add(insp.id);
        check(`inspector ${insp.id} has label`, typeof insp.label === 'string' && insp.label.length > 0);

        if (insp.kind === 'table') {
            const t = insp as TableInspector;
            check(`table[${t.id}] has entity`, typeof t.entity === 'string' && t.entity.length > 0);
            check(`table[${t.id}] has columns[]`, Array.isArray(t.columns) && t.columns.length > 0);
            for (const col of t.columns) {
                check(
                    `table[${t.id}] column.field is string`,
                    typeof col.field === 'string' && col.field.length > 0,
                );
                const hasBoth = col.width != null && col.flex != null;
                check(`table[${t.id}] column.${col.field} not both width+flex`, !hasBoth);
            }
        } else if (insp.kind === 'graph') {
            const g = insp as GraphInspector;
            check(`graph[${g.id}] has entity`, typeof g.entity === 'string' && g.entity.length > 0);
        } else if (insp.kind === 'timeline') {
            const tl = insp as TimelineInspector;
            check(`timeline[${tl.id}] has entity`, typeof tl.entity === 'string' && tl.entity.length > 0);
            check(
                `timeline[${tl.id}] has dateField`,
                typeof tl.dateField === 'string' && tl.dateField.length > 0,
            );
            check(
                `timeline[${tl.id}] has labelField`,
                typeof tl.labelField === 'string' && tl.labelField.length > 0,
            );
        } else if (insp.kind === 'document') {
            const d = insp as DocumentInspector;
            check(
                `document[${d.id}] has labelField`,
                typeof d.labelField === 'string' && d.labelField.length > 0,
            );
            check(
                `document[${d.id}] has contentField`,
                typeof d.contentField === 'string' && d.contentField.length > 0,
            );
        }
    }

    for (const perm of lore.permissions ?? []) {
        const ns = perm.split(':')[0];
        check(`permission ${perm} uses known namespace`, KNOWN_PERMISSION_NAMESPACES.has(ns));
    }

    // ── Layer 2c — entity coverage ───────────────────────────
    header('Layer 2c — entity coverage');
    const entityNames = new Set(
        inspectors
            .map((i) => {
                if (i.kind === 'document') {
                    return (i as DocumentInspector).entity ?? null;
                }
                return (i as TableInspector | GraphInspector | TimelineInspector).entity;
            })
            .filter((e): e is string => typeof e === 'string' && e.length > 0),
    );
    for (const required of fix.requiredEntities) {
        check(`inspectors cover ${required}`, entityNames.has(required));
    }

    check(
        'engines.lore range is set',
        manifest.engines?.lore != null && manifest.engines.lore.length > 0,
    );
}

console.log('▶ Phase 7 — validating reference plugin manifests\n');

for (const fix of FIXTURES) {
    validateManifest(fix);
}

console.log();
console.log('═══════════════════════════════════════════════════');
if (failed === 0) {
    console.log(`✓ all ${FIXTURES.length} reference manifests valid (${passed} checks)`);
    process.exit(0);
} else {
    console.log(`✗ ${failed} of ${passed + failed} checks failed across ${FIXTURES.length} manifests`);
    process.exit(1);
}
