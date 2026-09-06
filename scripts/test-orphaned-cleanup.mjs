#!/usr/bin/env node
/**
 * test-orphaned-cleanup.mjs — an exported cleanup function must have a
 * production caller.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The 3.18.2 investigation found TWO cleanup functions that were written,
 * documented as running at shutdown, and never wired to anything:
 *
 *   - `WorkspaceVerbatimResolver.closeAll()` — its own docstring said
 *     "`closeAll()` releases handles on shutdown". Zero callers. Every
 *     workspace the outbox replicator touched leaked a LanceDB handle for the
 *     life of the host process.
 *   - `disposeAccessTracker()` — correct, tested, zero PRODUCTION callers.
 *     Had the drain called it, half the embedded-host hang could not have
 *     happened.
 *
 * That is a pattern, not a coincidence, and it is invisible by construction:
 * skipping cleanup throws nothing, fails no test, and leaks silently. Nothing
 * tells you until a long-lived embedding host stops exiting.
 *
 * ── What this catches, and what it does NOT ─────────────────────────────────
 *
 * CATCHES: a top-level `export function`/`export async function` whose name
 * looks like teardown and which nothing under `packages/**\/src` references.
 * Test-only references do NOT count — a function exercised by a unit test but
 * never called in production is exactly the `disposeAccessTracker` case, and
 * is the thing worth surfacing.
 *
 * DOES NOT CATCH: class METHODS, including `closeAll()` above. Deciding
 * whether `resolver.closeAll()` is called needs type resolution — a bare
 * `.closeAll(` search cannot tell one class's method from another's, and this
 * repo has several same-named methods on different classes. Catching that
 * honestly needs the TypeScript language service; this guard is the cheap half
 * and is deliberately scoped so it produces no false positives.
 *
 * Existing orphans are baselined in ORPHAN_ALLOWLIST below, shrink-only: the
 * guard also fails when an allowlisted entry stops violating, so the list
 * cannot silently rot (same ratchet as scripts/test-arch.mjs's allowlists).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'packages', 'lore', 'src');

/**
 * Names that read as teardown. Anchored, and each requires a suffix or an
 * exact match, so ordinary verbs inside a longer word ("disposeOf" yes,
 * "stopwatch" no) don't drag unrelated code in.
 */
const CLEANUP_NAME = /^(close|dispose|stop|shutdown|teardown|destroy|release|unwire)([A-Z0-9_].*)?$/;

/**
 * Known orphans as of 3.18.2. Each entry is `relative/path.ts:functionName`.
 * Wire it up or delete it — do not add to this list without a reason.
 */
const ORPHAN_ALLOWLIST = [
    // Deliberate, and labelled as such at the declaration: a test/ops hook for
    // dropping the cached arcade token-DB handle before deleting the file.
    // There is no production moment that should close it — the handle is
    // process-lived by design.
    'packages/lore/src/engines/arcade/arcadeAuthResolver.ts:closeTokenDb',
];

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
            walk(abs, out);
        } else if (entry.isFile() && /\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
            out.push(abs);
        }
    }
    return out;
}

/** Strip comments and string literals so a name mentioned only in prose or in
 *  an error message is not mistaken for a call site. This is the whole reason
 *  the guard can be strict: `disposeAccessTracker` appears in several doc
 *  comments, and counting those would have hidden it. */
function stripNonCode(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/`(?:\\[\s\S]|[^\\`])*`/g, ' ')
        .replace(/'(?:\\[\s\S]|[^\\'])*'/g, ' ')
        .replace(/"(?:\\[\s\S]|[^\\"])*"/g, ' ');
}

const files = walk(srcRoot);
const code = new Map();          // abs path -> comment/string-stripped source
for (const f of files) code.set(f, stripNonCode(fs.readFileSync(f, 'utf8')));

// 1. Collect exported top-level cleanup functions.
const declRe = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
const candidates = [];
for (const [abs, src] of code) {
    for (const m of src.matchAll(declRe)) {
        if (CLEANUP_NAME.test(m[1])) {
            candidates.push({ name: m[1], file: path.relative(repoRoot, abs), abs });
        }
    }
}

// 2. A candidate is an orphan when no OTHER src file mentions its name.
const violations = [];
for (const c of candidates) {
    const word = new RegExp(`\\b${c.name}\\b`);
    let referenced = false;
    for (const [abs, src] of code) {
        if (abs === c.abs) continue;              // its own file doesn't count
        if (word.test(src)) { referenced = true; break; }
    }
    if (!referenced) violations.push(`${c.file}:${c.name}`);
}

// 3. Apply the shrink-only allowlist, both directions.
const unexpected = violations.filter((v) => !ORPHAN_ALLOWLIST.includes(v));
const stale = ORPHAN_ALLOWLIST.filter((v) => !violations.includes(v));

if (unexpected.length === 0 && stale.length === 0) {
    console.log(
        `✓ Orphaned-cleanup guard passed (${candidates.length} exported cleanup function(s) checked, `
        + `${ORPHAN_ALLOWLIST.length} baselined).`,
    );
    process.exit(0);
}

console.error('✗ Orphaned-cleanup guard failed:\n');
for (const v of unexpected) {
    console.error(`  NO PRODUCTION CALLER: ${v}`);
}
for (const v of stale) {
    console.error(`  STALE ALLOWLIST ENTRY: ${v} — it has a caller now; remove it from ORPHAN_ALLOWLIST`);
}
console.error(
    '\n'
    + 'An exported cleanup function with no production caller is the shape of the\n'
    + '3.18.2 handle leaks: `WorkspaceVerbatimResolver.closeAll()` and\n'
    + '`disposeAccessTracker()` were both correct, both documented as running at\n'
    + 'shutdown, and both called by nothing. Skipping cleanup throws nothing and\n'
    + 'fails no test, so it leaks in silence until a long-lived embedding host\n'
    + 'stops exiting.\n\n'
    + 'Fix it one of three ways:\n'
    + '  1. Wire it up — usually a step in mcp/shutdownDrain.ts.\n'
    + '  2. Delete it, if the thing it cleans up no longer exists.\n'
    + '  3. If it is genuinely called through a path this guard cannot see,\n'
    + '     add it to ORPHAN_ALLOWLIST in scripts/test-orphaned-cleanup.mjs with\n'
    + '     a one-line reason. Note that a test-only caller does NOT count as a\n'
    + '     production caller, deliberately.\n',
);
process.exit(1);
