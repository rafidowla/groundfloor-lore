#!/usr/bin/env tsx
/**
 * test/env-scrub-allowlist-unit.ts — guardrail against the
 * "silently scrubbed env var" bug class.
 *
 * Failure mode this catches:
 *   A new feature adds `process.env.LORE_FOO_BAR` somewhere in the
 *   source tree, the author forgets to add 'LORE_FOO_BAR' to
 *   ALLOWED_VARS in envScrub.ts, ships the feature, operators set
 *   the var on the daemon, the var is silently deleted at startup,
 *   the feature never activates. Symptom: "the env var is in
 *   launchctl print's environment block but the feature never
 *   activates" — quoted from envScrub.ts itself, after the 4th time
 *   this bit us.
 *
 *   Caught by this test: every LORE_ / GROUNDFLOOR_ identifier the
 *   source tree reads via process.env must appear in ALLOWED_VARS.
 *   No exceptions — if a read isn't allowlisted, this test fails at
 *   PR time, not after a smoke bench discovers the issue.
 *
 * Scope:
 *   - Scans packages/lore/src + packages/lore-plugin-(name)/src.
 *   - Matches `process.env.LORE_X` and `process.env['LORE_X']`
 *     plus the GROUNDFLOOR_ namespace.
 *   - The allowlist is the literal const ALLOWED_VARS in envScrub.ts;
 *     this test reads that file as text so a refactor that renames
 *     the export doesn't accidentally hide the regression.
 *
 * Out of scope:
 *   - Vars that are in ALLOWED_VARS but NOT read anywhere. Dead
 *     config is fine here; this test catches under-allowlisting,
 *     not over-allowlisting. (Dropping unused entries is a separate,
 *     lower-stakes cleanup.)
 *   - Non-LORE_/GROUNDFLOOR_ vars. Those are deliberately stricter
 *     (Lore's allowlist scrubs everything not on the list); auditing
 *     them is a different exercise.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => { console.log(`  ✓ ${name}`); passed++; },
            (err: Error) => { console.error(`  ✗ ${name}\n    ${err.stack ?? err.message}`); failed++; },
        );
}

/** Walk packages/* recursively, skipping node_modules / dist / hidden. */
function* walkSrc(root: string): IterableIterator<string> {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
        const abs = path.join(root, e.name);
        if (e.isDirectory()) {
            yield* walkSrc(abs);
        } else if (e.isFile() && /\.(ts|tsx|mjs|js)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
            yield abs;
        }
    }
}

/** Scan a file's text for every process.env.<NAME> / process.env['<NAME>']
 *  / process.env["<NAME>"] occurrence where <NAME> starts with LORE_ or
 *  GROUNDFLOOR_. Returns the set of NAMEs found. */
function envReadsIn(text: string): Set<string> {
    const found = new Set<string>();
    // process.env.LORE_FOO
    const dot = /process\.env\.(LORE_[A-Z0-9_]+|GROUNDFLOOR_[A-Z0-9_]+)\b/g;
    // process.env['LORE_FOO']
    const sq = /process\.env\[\s*'(LORE_[A-Z0-9_]+|GROUNDFLOOR_[A-Z0-9_]+)'\s*\]/g;
    // process.env["LORE_FOO"]
    const dq = /process\.env\[\s*"(LORE_[A-Z0-9_]+|GROUNDFLOOR_[A-Z0-9_]+)"\s*\]/g;
    for (const re of [dot, sq, dq]) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) found.add(m[1]);
    }
    return found;
}

/** Pull the allowlist directly out of envScrub.ts as text. Robust
 *  to a future refactor that changes the export name — we look for
 *  the const block by name and parse string literals out of it. */
function readAllowlistFromSource(): Set<string> {
    const file = path.join(repoRoot, 'packages/lore/src/security/envScrub.ts');
    const src = fs.readFileSync(file, 'utf8');
    // Strip JS line + block comments BEFORE searching for the array
    // delimiters. Inline comments like `clamped [1,32]; perf` contain
    // `];` and would otherwise truncate the body parse mid-array.
    const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/\/\/[^\n]*/g, '');        // line comments
    const start = stripped.indexOf('const ALLOWED_VARS');
    assert.ok(start >= 0, 'envScrub.ts: ALLOWED_VARS const not found — refactor without updating this test?');
    // Find the assignment `= [` rather than `indexOf('[')`, because
    // the type annotation `readonly string[]` puts a `[` between the
    // const name and the actual array literal.
    const eqOpen = stripped.indexOf('= [', start);
    assert.ok(eqOpen > 0, 'envScrub.ts: ALLOWED_VARS assignment "= [" not found');
    const openBracket = eqOpen + 2;
    const closeBracket = stripped.indexOf('];', openBracket);
    assert.ok(openBracket > 0 && closeBracket > openBracket, 'envScrub.ts: ALLOWED_VARS array delimiters not found');
    const body = stripped.slice(openBracket, closeBracket);
    const allow = new Set<string>();
    const lit = /'([A-Z][A-Z0-9_]*)'/g;
    let m: RegExpExecArray | null;
    while ((m = lit.exec(body)) !== null) allow.add(m[1]);
    return allow;
}

async function run() {
    console.log('\n=== env-scrub allowlist coverage ===\n');

    const reads = new Map<string, string[]>();   // var → [file:line, ...]
    const pkgRoot = path.join(repoRoot, 'packages');
    for (const file of walkSrc(pkgRoot)) {
        const text = fs.readFileSync(file, 'utf8');
        const found = envReadsIn(text);
        if (found.size === 0) continue;
        // For each finding, also collect line numbers for the diagnostic.
        const lines = text.split('\n');
        for (const name of found) {
            const sites: string[] = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(name)) sites.push(`${path.relative(repoRoot, file)}:${i + 1}`);
            }
            if (!reads.has(name)) reads.set(name, []);
            reads.get(name)!.push(...sites);
        }
    }

    const allow = readAllowlistFromSource();

    await test('every LORE_/GROUNDFLOOR_ env read in packages/** is allowlisted in envScrub.ts', () => {
        const missing: string[] = [];
        for (const [name, sites] of reads.entries()) {
            if (!allow.has(name)) {
                missing.push(`  ${name}\n    read at:\n      ${sites.slice(0, 3).join('\n      ')}`);
            }
        }
        assert.equal(
            missing.length, 0,
            `\n${missing.length} env var(s) read but not in ALLOWED_VARS in packages/lore/src/security/envScrub.ts:\n\n${missing.join('\n\n')}\n\n` +
            `Fix: add each to ALLOWED_VARS with a one-line comment explaining what it controls.\n` +
            `Context: Lore node \`rc3-env-scrub-allowlist-bug\`.\n`,
        );
    });

    await test('scanner finds known reads (sanity)', () => {
        // If this fails the regex broke; the previous test would
        // also report missing entries but the diagnostic would be
        // confusing. This one tells us the scanner itself works.
        assert.ok(reads.has('LORE_HOME'), 'scanner should find LORE_HOME — sanity check broke');
        assert.ok(reads.size >= 10, `scanner found ${reads.size} env reads; expected at least 10`);
    });

    await test('allowlist parser finds entries (sanity)', () => {
        assert.ok(allow.has('LORE_HOME'), 'allowlist parser should find LORE_HOME');
        assert.ok(allow.size >= 30, `allowlist parser found ${allow.size} entries; expected at least 30`);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (reads.size > 0) {
        console.log(`(scanned ${reads.size} distinct env vars across packages/**, ${allow.size} allowlisted)\n`);
    }
    if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
