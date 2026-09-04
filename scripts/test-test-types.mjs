#!/usr/bin/env node
/**
 * test-test-types.mjs — type-check the TEST tree, with a shrink-only quarantine.
 *
 * WHY THIS EXISTS
 *
 * `tsconfig.json` scopes `include` to `packages/lore/src/**` so `npm run build`
 * emits exactly the shipped tree. A side effect nobody intended: `tsc --noEmit`
 * in the `test` script never looked at `test/` at all. So every "make the field
 * REQUIRED so tsc catches a call site that forgets it" safety net — of which
 * this codebase has several, e.g. `AutolinkHandles.tracker` and now
 * `BulkIngestDeps.autolinkTracker` — did not cover `test/`, which is where new
 * call sites are most often written. Two `nodeUpsert` calls in
 * test/node-service-unit.ts omitted `tracker` and silently registered their
 * autolinks on the process-global tracker; the type said REQUIRED and nothing
 * checked.
 *
 * HOW IT WORKS
 *
 * One `tsc -p tsconfig.test.json` run over src + test. Errors are grouped by
 * file and COUNTED, then compared against `.test-type-baseline.json`, which
 * maps each quarantined file to its allowed error COUNT:
 *
 *   - a test file with errors that is NOT in the baseline  → FAIL (new breakage)
 *   - a quarantined file with MORE errors than baselined   → FAIL (new breakage
 *                                                            inside quarantine)
 *   - a quarantined file with FEWER errors than baselined  → FAIL (ratchet down:
 *                                                            re-run --update)
 *   - a baseline file with NO errors                       → FAIL (stale entry;
 *                                                            remove it — same
 *                                                            stale-entry ratchet
 *                                                            D-021 uses)
 *   - errors under packages/lore/src                       → FAIL always; that
 *                                                            tree has never had
 *                                                            a quarantine
 *
 * ─── Why COUNTS, not a file list ─────────────────────────────────────────
 *
 * The first cut quarantined WHOLE FILES (`if (quarantined.has(f)) continue;`),
 * which reopened the exact hole this gate was built to close. 104 of ~450 test
 * files were quarantined, and 5 of the 25 files that touch nodeUpsert /
 * runBulkIngest / autolink were among them:
 *
 *   test/sprint-O-outbox-property.ts, test/audit-node-field-cap-unit.ts,
 *   test/audit-embedded-writes-unit.ts, test/id-alphabet-roundtrip-unit.ts,
 *   test/nw7e-legacy-engine-teardown-unit.ts
 *
 * A whole-file skip means such a file can accumulate BRAND-NEW type errors —
 * including a newly-omitted required `tracker` / `autolinkTracker`, the very
 * defect the gate exists for — and the gate still reports OK. And the
 * stale-entry ratchet could only ever evict a file once it was 100% clean, so
 * partial progress bought nothing. Counting makes every quarantined file
 * ratchet monotonically: an added error fails, a removed error must be banked.
 *
 * The baseline only ever shrinks. Fix errors, run --update, commit the smaller
 * numbers.
 *
 * License: original work for groundfloor-lore.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(root, '.test-type-baseline.json');
const UPDATE = process.argv.includes('--update');

function runTsc() {
    try {
        execFileSync('npx', ['tsc', '-p', 'tsconfig.test.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return '';
    } catch (err) {
        // tsc exits non-zero when it reports errors; the diagnostics are on stdout.
        return `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
}

/** file -> every `path(line,col): error TSxxxx:` record, in order. */
function groupByFile(output) {
    const byFile = new Map();
    for (const line of output.split('\n')) {
        const m = /^([^()\s][^(]*)\((\d+),\d+\): error TS\d+:/.exec(line);
        if (!m) continue;
        const file = m[1].replaceAll('\\', '/');
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file).push(line.trim());
    }
    return byFile;
}

const output = runTsc();
const byFile = groupByFile(output);

const srcFailures = [...byFile.keys()].filter((f) => f.startsWith('packages/'));
const testFailures = [...byFile.keys()].filter((f) => f.startsWith('test/')).sort();

/** The quarantine as `file -> allowed error count`. */
function countsFor(files) {
    const out = {};
    for (const f of files) out[f] = byFile.get(f).length;
    return out;
}

if (UPDATE) {
    writeFileSync(BASELINE, `${JSON.stringify({
        note: 'Test files that do not yet type-check, mapped to their CURRENT error COUNT. SHRINK-ONLY: a count may never rise and a file may never be added without a review conversation; removing a file is the goal. A count that DROPS must be banked here (the gate fails until you do), so partial progress ratchets instead of leaving headroom for new breakage. Regenerate with: node scripts/test-test-types.mjs --update',
        quarantined: countsFor(testFailures),
    }, null, 2)}\n`);
    const total = testFailures.reduce((n, f) => n + byFile.get(f).length, 0);
    console.log(`[test-types] baseline updated: ${testFailures.length} quarantined test file(s), ${total} error(s)`);
    process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const raw = baseline.quarantined ?? {};
if (Array.isArray(raw)) {
    console.error('[test-types] FAIL\n');
    console.error('  .test-type-baseline.json still uses the legacy FILE-LIST quarantine, which lets a');
    console.error('  quarantined file accumulate brand-new type errors undetected (see this script\'s header).');
    console.error('  Regenerate the count-based baseline with: node scripts/test-test-types.mjs --update');
    process.exit(1);
}
const quarantined = new Map(Object.entries(raw));

const problems = [];

for (const f of srcFailures) {
    problems.push(`  ${f} — type errors under packages/lore/src (never quarantined):\n      ${byFile.get(f)[0]}`);
}

for (const f of testFailures) {
    const allowed = quarantined.get(f);
    const actual = byFile.get(f).length;
    if (allowed === undefined) {
        problems.push(`  ${f} — NEW type error in a test file:\n      ${byFile.get(f)[0]}`);
        continue;
    }
    if (actual > allowed) {
        problems.push(
            `  ${f} — quarantined for ${allowed} error(s) but now has ${actual}. ` +
            `A quarantined file may not accumulate NEW breakage:\n      ${byFile.get(f)[actual - 1]}`,
        );
        continue;
    }
    if (actual < allowed) {
        problems.push(
            `  ${f} — improved from ${allowed} to ${actual} error(s). Bank it: ` +
            'node scripts/test-test-types.mjs --update (leaving the old count would allow new errors back in).',
        );
    }
}

const stale = [...quarantined.keys()].filter((f) => !byFile.has(f)).sort();
for (const f of stale) {
    problems.push(`  ${f} — quarantined but now type-checks CLEAN. Remove it from .test-type-baseline.json (the quarantine must only shrink).`);
}

const quarantinedErrors = [...quarantined.values()].reduce((a, b) => a + b, 0);

if (problems.length > 0) {
    console.error('[test-types] FAIL\n');
    console.error(problems.join('\n'));
    console.error(`\n${testFailures.length} failing test file(s), ${quarantined.size} quarantined (${quarantinedErrors} error(s) allowed), ${stale.length} stale.`);
    console.error('Fix the file, or — if a quarantined file legitimately changed — run: node scripts/test-test-types.mjs --update');
    process.exit(1);
}

console.log(`[test-types] OK — packages/lore/src + test/ type-check (${quarantined.size} test file(s) still quarantined, ${quarantinedErrors} error(s) allowed)`);
