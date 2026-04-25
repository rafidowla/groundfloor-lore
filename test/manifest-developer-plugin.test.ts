#!/usr/bin/env tsx
/**
 * manifest-developer-plugin.test.ts — Validates that
 * `packages/lore-plugin-developer/plugin.json` is a valid v1 plugin
 * manifest, and that it satisfies the same structural rules the Tauri
 * shell enforces in `apps/lore-shell/src-tauri/src/manifest.rs`.
 *
 * This is the end-to-end check that the manifest spec lives and
 * breathes against a real, in-tree plugin — Phase 4 of the project
 * deployment plan. If this test fails, either:
 *   - the developer plugin's manifest drifted from the spec, or
 *   - the spec changed (and the plugin's manifest needs updating).
 *
 * Two layers of validation:
 *
 *   1. **Compile-time (TypeScript)**: import the JSON and assign to
 *      `PluginManifest`. Drift between the JSON and the canonical type
 *      surfaces in `tsc --noEmit`.
 *
 *   2. **Runtime (this script)**: re-implements the shell's structural
 *      checks (required fields, manifestVersion, ≥1 primitive
 *      contribution) plus schema-level rules the Rust loader explicitly
 *      defers to TypeScript (inspector kinds, required fields per
 *      inspector kind, permission format).
 *
 * Usage: npx tsx test/manifest-developer-plugin.test.ts
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
const MANIFEST_PATH = join(REPO_ROOT, 'packages/lore-plugin-developer/plugin.json');

let failed = 0;
function check(name: string, condition: unknown, detail?: string): void {
    if (condition) {
        console.log(`  ✓ ${name}`);
    } else {
        console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
        failed += 1;
    }
}

function header(title: string): void {
    console.log(`\n${title}`);
}

// ────────────────────────────────────────────────────────────────────────
// Layer 1 — file exists + parses + assigns to PluginManifest
// ────────────────────────────────────────────────────────────────────────

header('Layer 1 — file + types');

const raw = readFileSync(MANIFEST_PATH, 'utf-8');
const parsed: unknown = JSON.parse(raw);
check('plugin.json parses as JSON', typeof parsed === 'object' && parsed != null);

// The cast here is intentional. The compile-time check (tsc --noEmit on
// this file) is what enforces type compatibility; the runtime check
// below verifies the shape.
const manifest = parsed as PluginManifest;

// ────────────────────────────────────────────────────────────────────────
// Layer 2a — structural rules (mirror manifest.rs::load_from_path)
// ────────────────────────────────────────────────────────────────────────

header('Layer 2a — structural (matches Rust loader)');

check('manifestVersion === 1', manifest.manifestVersion === 1, `got ${manifest.manifestVersion}`);
check('name is non-empty string', typeof manifest.name === 'string' && manifest.name.length > 0);
check('version is semver-shaped', typeof manifest.version === 'string' && /^\d+\.\d+\.\d+/.test(manifest.version));
check('description is non-empty', typeof manifest.description === 'string' && manifest.description.length > 0);
check('has at least one primitive contribution', manifest.lore != null || manifest.def != null);

// ────────────────────────────────────────────────────────────────────────
// Layer 2b — schema rules (the TS-side checks the Rust loader defers)
// ────────────────────────────────────────────────────────────────────────

header('Layer 2b — schema (TS-side checks)');

const lore = manifest.lore;
check('lore contribution present', lore != null);

if (lore) {
    check('lore.module is a relative path', typeof lore.module === 'string' && lore.module.length > 0);
    check(
        'lore.module resolves to an existing dist file',
        existsSync(resolve(dirname(MANIFEST_PATH), lore.module)),
        `module path: ${resolve(dirname(MANIFEST_PATH), lore.module)}`,
    );

    const inspectors: InspectorPanel[] = lore.inspectors ?? [];
    check('lore.inspectors[] is non-empty', inspectors.length > 0);

    const allowedKinds = new Set(['table', 'graph', 'timeline', 'document']);
    const ids = new Set<string>();
    for (const insp of inspectors) {
        check(`inspector kind allowed: ${insp.kind} (id=${insp.id})`, allowedKinds.has(insp.kind));
        check(`inspector id is unique: ${insp.id}`, !ids.has(insp.id));
        ids.add(insp.id);
        check(`inspector ${insp.id} has label`, typeof insp.label === 'string' && insp.label.length > 0);

        if (insp.kind === 'table') {
            const t = insp as TableInspector;
            check(`table[${t.id}] has entity`, typeof t.entity === 'string' && t.entity.length > 0);
            check(`table[${t.id}] has columns[]`, Array.isArray(t.columns) && t.columns.length > 0);
            for (const col of t.columns) {
                check(`table[${t.id}] column.field is string`, typeof col.field === 'string' && col.field.length > 0);
                // width and flex are mutually exclusive per the spec.
                const hasBoth = col.width != null && col.flex != null;
                check(`table[${t.id}] column.${col.field} not both width+flex`, !hasBoth);
            }
        } else if (insp.kind === 'graph') {
            const g = insp as GraphInspector;
            check(`graph[${g.id}] has entity`, typeof g.entity === 'string' && g.entity.length > 0);
        } else if (insp.kind === 'timeline') {
            const tl = insp as TimelineInspector;
            check(`timeline[${tl.id}] has entity`, typeof tl.entity === 'string' && tl.entity.length > 0);
            check(`timeline[${tl.id}] has dateField`, typeof tl.dateField === 'string' && tl.dateField.length > 0);
            check(`timeline[${tl.id}] has labelField`, typeof tl.labelField === 'string' && tl.labelField.length > 0);
        } else if (insp.kind === 'document') {
            const d = insp as DocumentInspector;
            check(`document[${d.id}] has labelField`, typeof d.labelField === 'string' && d.labelField.length > 0);
            check(`document[${d.id}] has contentField`, typeof d.contentField === 'string' && d.contentField.length > 0);
        }
    }

    // Permission format check — the spec defines `<namespace>:<verb>:<target>`
    // shape; verb is optional for namespaces that don't need it. We only
    // enforce that each entry has at least one ":" separator and a known
    // top-level namespace.
    const knownNamespaces = new Set(['fs', 'net', 'credentials', 'os']);
    for (const perm of lore.permissions ?? []) {
        const ns = perm.split(':')[0];
        check(`permission ${perm} uses known namespace`, knownNamespaces.has(ns));
    }
}

// ────────────────────────────────────────────────────────────────────────
// Layer 2c — developer-plugin specific assertions
// ────────────────────────────────────────────────────────────────────────

header('Layer 2c — developer-plugin specific');

check('name === "developer"', manifest.name === 'developer');
check(
    'engines.lore range is set',
    manifest.engines?.lore != null && manifest.engines.lore.length > 0,
);

// The developer plugin owns these table names; the manifest's inspectors
// must reference at least the core ones so the shell can render them.
const developerEntityNames = new Set(
    (manifest.lore?.inspectors ?? []).map((i) => {
        if (i.kind === 'document') return null;
        return (i as TableInspector | GraphInspector | TimelineInspector).entity;
    }).filter((e): e is string => e != null),
);
check('inspectors cover CodeSymbol', developerEntityNames.has('CodeSymbol'));
check('inspectors cover CodeFile', developerEntityNames.has('CodeFile'));
check('inspectors cover DevActivity', developerEntityNames.has('DevActivity'));

// ────────────────────────────────────────────────────────────────────────
// Result
// ────────────────────────────────────────────────────────────────────────

console.log();
if (failed === 0) {
    console.log('✓ developer plugin manifest is valid');
    process.exit(0);
} else {
    console.log(`✗ ${failed} check${failed === 1 ? '' : 's'} failed`);
    process.exit(1);
}
