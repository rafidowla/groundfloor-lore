#!/usr/bin/env node
/**
 * test-file-sizes.mjs — file-size guardrail.
 *
 * Source-of-truth rule from CLAUDE.md (Architecture / File Sizes):
 *
 *   - Target: ≤ 500 lines per file.
 *   - Hard cap: 800 lines. Files larger fail this test.
 *
 * Baseline model:
 *   We carry `.file-size-baseline.json` listing files that currently
 *   exceed the cap. They are tracked as technical debt; the test fails
 *   ONLY on NEW oversize files (or growth on existing baselined ones
 *   beyond their recorded size). Touching a baselined file is fine —
 *   shrinking it is encouraged. Splitting one is encouraged most.
 *
 *   To refresh the baseline (e.g., after a split): run with --update.
 *
 * Why this exists:
 *   server.ts grew to 6,872 lines because no rule said "stop." This
 *   guard prevents that pattern from recurring. New work that pushes
 *   any file past 800 either splits the file first or adds a baseline
 *   entry with a one-line justification.
 *
 * What this checks:
 *   Every TypeScript file under packages/**\/src/. Skips test/, dist/,
 *   node_modules/, generated files, and anything matched by the
 *   IGNORE list below.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const baselinePath = path.join(repoRoot, '.file-size-baseline.json');

const HARD_CAP = 800;
const TARGET = 500;

const SCAN_ROOTS = [
    'packages',
];

const IGNORE_DIR_NAMES = new Set([
    'node_modules', 'dist', '.git', 'coverage', '__generated__', 'build',
]);


function* walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
        if (IGNORE_DIR_NAMES.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            yield* walk(full);
            continue;
        }
        if (!e.isFile()) continue;
        if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue;
        if (e.name.endsWith('.d.ts')) continue;
        yield full;
    }
}

function countLines(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.length === 0) return 0;
    let lines = 1;
    for (let i = 0; i < content.length; i++) {
        if (content.charCodeAt(i) === 10) lines++;
    }
    if (content.charCodeAt(content.length - 1) === 10) lines--;
    return lines;
}

function loadBaseline() {
    if (!fs.existsSync(baselinePath)) {
        return { note: '', entries: [] };
    }
    try { return JSON.parse(fs.readFileSync(baselinePath, 'utf-8')); }
    catch { return { note: '', entries: [] }; }
}

function relRepo(p) {
    return path.relative(repoRoot, p).replaceAll('\\', '/');
}

const allFiles = [];
for (const root of SCAN_ROOTS) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) allFiles.push(f);
}

const measurements = allFiles
    .map(f => ({ path: relRepo(f), lines: countLines(f) }))
    .sort((a, b) => b.lines - a.lines);

const oversize = measurements.filter(m => m.lines > HARD_CAP);

const shouldUpdate = process.argv.includes('--update');
if (shouldUpdate) {
    const next = {
        note:
            'Files currently exceeding the 800-line hard cap, tracked as technical debt. ' +
            'New oversize files are a CI failure. Splitting these is encouraged. ' +
            "Refresh after a split with: node scripts/test-file-sizes.mjs --update",
        entries: oversize.map(o => ({ path: o.path, lines: o.lines, justification: 'pre-existing' })),
    };
    fs.writeFileSync(baselinePath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    console.log(`✓ Baseline updated: ${next.entries.length} oversize file(s) tracked.`);
    process.exit(0);
}

const baseline = loadBaseline();
const baselineMap = new Map((baseline.entries ?? []).map(e => [e.path, e]));

const violations = [];
for (const m of oversize) {
    const b = baselineMap.get(m.path);
    if (!b) {
        violations.push({ ...m, kind: 'new' });
        continue;
    }
    if (m.lines > b.lines) {
        violations.push({ ...m, kind: 'grew', baseline: b.lines });
    }
}

const warnings = measurements.filter(m => m.lines > TARGET && m.lines <= HARD_CAP);

if (violations.length === 0) {
    const tracked = baselineMap.size;
    const oversizeNow = oversize.length;
    console.log(`✓ File-size guardrail passed (cap=${HARD_CAP}, target=${TARGET}).`);
    if (tracked > 0) {
        console.log(`  ${tracked} legacy oversize file(s) tracked in .file-size-baseline.json — split when touched.`);
    }
    if (warnings.length > 0) {
        console.log(`  ${warnings.length} file(s) over the ${TARGET}-line target (informational; not a failure):`);
        for (const w of warnings.slice(0, 10)) {
            console.log(`    ${w.lines.toString().padStart(5)}  ${w.path}`);
        }
        if (warnings.length > 10) {
            console.log(`    ... and ${warnings.length - 10} more.`);
        }
    }
    void oversizeNow;
    process.exit(0);
}

console.error(`✗ File-size guardrail failed (${violations.length} new violation(s)):`);
for (const v of violations) {
    if (v.kind === 'new') {
        console.error(`  NEW oversize: ${v.path} — ${v.lines} lines (cap=${HARD_CAP})`);
    } else {
        console.error(`  GREW past baseline: ${v.path} — ${v.lines} lines (was ${v.baseline}, cap=${HARD_CAP})`);
    }
}
console.error('');
console.error('Options:');
console.error('  1. Split the file. New extraction goes into a new module under the same directory.');
console.error('  2. If a refactor lands and you want to refresh the baseline:');
console.error('       node scripts/test-file-sizes.mjs --update');
process.exit(1);
