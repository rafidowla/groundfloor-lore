#!/usr/bin/env tsx
/**
 * sw24-config-reference-unit.ts — SW-24 drift guard.
 *
 * Asserts that every LORE_* / DATAPLANE_* variable found in
 * packages/lore/src/ (via regex scan) is mentioned in
 * docs/CONFIGURATION.md.
 *
 * This is a one-way completeness gate: it flags vars added to source
 * but forgotten in the doc. It does NOT flag doc entries that no
 * longer exist in source (stale docs are caught by review, not by
 * this test, to avoid over-coupling the grep pattern to internal
 * naming).
 *
 * Excluded from the scan:
 *   - LORE_ATLAS_* vars: removed in v3.11.0 (SP-14). Still appear in
 *     an envScrub comment but are no longer read anywhere in Core.
 *   - LORE_MAINTAIN_ prefix entry (bare suffix-stripped form that
 *     appears in a comment in envScrub, not a real var name).
 *   - LORE_ATLAS_ prefix entry (same pattern — comment artifact).
 *   - LORE_STREAM_CONSUMER: appears in source as a comment describing a
 *     future pluggability seam, not a currently-read knob. Documented
 *     in CONFIGURATION.md but excluded from the live-read scan because
 *     grep finds it only in a comment.
 *   - LORE_PROTOCOL: appears as a filename fragment (LORE_PROTOCOL.md),
 *     not an env var.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const srcDir = path.join(repoRoot, 'packages', 'lore', 'src');
const docPath = path.join(repoRoot, 'docs', 'CONFIGURATION.md');

let passed = 0, failed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

/** Vars grep finds in source but which are not active runtime knobs. */
const KNOWN_EXCLUSIONS = new Set<string>([
    // Removed in SP-14; only appear in envScrub comment block.
    'LORE_ATLAS_',
    'LORE_ATLAS_REGISTER_ALL_TOOLS',
    'LORE_ATLAS_REPO_ROOT',
    'LORE_ATLAS_SLIM_TOOLS',
    // Bare prefix artifact from an envScrub comment (not a real var).
    'LORE_MAINTAIN_',
    // File-name fragment, not an env var (appears in setup.ts).
    'LORE_PROTOCOL',
    // Future pluggability seam mentioned only in a comment.
    'LORE_STREAM_CONSUMER',
    // JS local variable name `LORE_HTTP_PORT` — reads from process.env['LORE_PORT'].
    // The actual env var is LORE_PORT (documented).
    'LORE_HTTP_PORT',
    // JS constant `LORE_MCP_URL = 'http://127.0.0.1:3847/mcp'` in setup.ts — not an env var.
    'LORE_MCP_URL',
    // JS constant `LORE_SUBDIR = '.lore'` in syncCallbacks.ts — not an env var.
    'LORE_SUBDIR',
    // Appears only in a comment in http/helpers.ts, not read from process.env.
    'LORE_ACTIVE_WORKSPACE',
    // Appears only in comments referencing the filename DATAPLANE_INTEGRATION.md.
    'DATAPLANE_INTEGRATION',
    // NW-2a — phantom escape hatch. Mentioned in two comments in
    // `src/diagnostics/sweeper.ts` but no code reads it via process.env.
    // The CONFIGURATION.md entry was removed in NW-2a (Lore is a database,
    // not a flag museum). Excluded here so the source→docs drift guard
    // doesn't false-positive on the comment artifact. If a real consumer
    // lands later, wire it through, document it, and remove this entry.
    'LORE_SWEEP_KEEP_ORPHANS',
    // Kuzu-removal Phase 3d (2026-08-21) — the LORE_TABLE_BACKEND=kuzu legacy
    // path (KuzuTableStorage) was deleted; the name survives only in
    // tableStorageFactory.ts's header comment explaining the removal, not as
    // a real process.env read. CONFIGURATION.md's entry was removed with it.
    'LORE_TABLE_BACKEND',
]);

(async () => {
    console.log('SW-24 — CONFIGURATION.md completeness drift guard');

    // ── 1. docs/CONFIGURATION.md exists ────────────────────────────
    await test('docs/CONFIGURATION.md exists', () => {
        assert.ok(fs.existsSync(docPath), `${docPath} not found`);
    });

    // ── 2. Read the doc ─────────────────────────────────────────────
    const docText = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf-8') : '';

    // ── 3. Discover vars in source via grep ─────────────────────────
    let sourceVars: Set<string>;
    await test('source grep succeeds', () => {
        const raw = execSync(
            `grep -rohE "(LORE|DATAPLANE)_[A-Z0-9_]+" "${srcDir}" 2>/dev/null | sort -u`,
            { encoding: 'utf-8', cwd: repoRoot },
        ).trim();
        const all = raw.split('\n').map((v) => v.trim()).filter(Boolean);
        sourceVars = new Set(all.filter((v) => !KNOWN_EXCLUSIONS.has(v)));
        assert.ok(sourceVars.size > 0, 'grep returned zero vars — something is wrong');
        console.log(`    (${sourceVars.size} unique vars found in source after exclusions)`);
    });

    // ── 4. Every source var appears in the doc ──────────────────────
    await test('every LORE_*/DATAPLANE_* var in source appears in CONFIGURATION.md', () => {
        const missing: string[] = [];
        for (const v of sourceVars!) {
            if (!docText.includes(v)) missing.push(v);
        }
        assert.deepEqual(
            missing,
            [],
            `vars found in source but not in docs/CONFIGURATION.md:\n  ${missing.join('\n  ')}`,
        );
    });

    // ── 5. Spot-check 10 specific documented vars ───────────────────
    const spotChecks = [
        'LORE_HOME',
        'LORE_PORT',
        'LORE_DEPLOYMENT_MODE',
        'LORE_EMBEDDING_PROVIDER',
        'LORE_LANCE_POOL_SIZE',
        'LORE_MAINTAIN_RETENTION_DAYS',
        'LORE_OUTBOX_SELFHEAL_INTERVAL_MS',
        'LORE_RECALL_RANKING',
        'DATAPLANE_ORG_ID',
    ];
    for (const v of spotChecks) {
        await test(`spot-check: ${v} appears in CONFIGURATION.md`, () => {
            assert.ok(docText.includes(v), `${v} not found in CONFIGURATION.md`);
        });
    }

    // ── 6. Doc has section headers ──────────────────────────────────
    await test('CONFIGURATION.md has a Quick-Reference Table section', () => {
        assert.ok(docText.includes('Quick-Reference Table'), 'missing Quick-Reference Table section');
    });

    await test('CONFIGURATION.md covers all major groups', () => {
        for (const heading of ['Core / Daemon', 'Embedding', 'Maintenance', 'Observability', 'Outbox']) {
            assert.ok(docText.includes(heading), `missing section heading: ${heading}`);
        }
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
})();
