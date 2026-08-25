#!/usr/bin/env tsx
/**
 * sw15-ingestion-allowlist-unit.ts — pins the SW-15 (A5) fixes:
 *
 *  1. MCP and HTTP ingestion resolve the SAME effective allowlist for a
 *     given LORE_WATCH_PATHS. Both surfaces now call loadAllExtraRoots(),
 *     so the merged (ingestion.json + watch-paths) root set is identical.
 *
 *  2. LORE_WATCH_PATHS system roots ("/", "/etc", …) and paths outside the
 *     user's home are NOT silently honored as readable ingestion roots.
 *     Previously loadWatchPathsAsRoots() accepted any absolute path.
 *
 * Fails on base (MCP used loadExtraIngestionRoots → divergent allowlist;
 * loadWatchPathsAsRoots accepted "/"); passes on the SW-15 branch.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Static imports use only symbols that exist on BOTH base and branch, so
// the behavioral tests below run (and fail) on base rather than erroring at
// module-load. isWatchRootSafe is new on the branch and is imported lazily.
import {
    loadAllExtraRoots,
    loadExtraIngestionRoots,
    loadWatchPathsAsRoots,
} from '../packages/lore/src/security/pathAllowlist.js';
const mod = await import('../packages/lore/src/security/pathAllowlist.js') as {
    isWatchRootSafe?: (root: string, home?: string) => boolean;
};

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sw15-'));
}
function cleanup(d: string): void {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
}

let passed = 0, failed = 0;
const test = (name: string, fn: () => void): void => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
};

const savedWatch = process.env.LORE_WATCH_PATHS;
const restoreWatch = (): void => {
    if (savedWatch === undefined) delete process.env.LORE_WATCH_PATHS;
    else process.env.LORE_WATCH_PATHS = savedWatch;
};

console.log('SW-15 — ingestion allowlist consistency + watch-path validation');

/* ─── (1) MCP and HTTP resolve the SAME effective allowlist ──────── */
//
// Both the MCP ingestion tools (mcp/tools/ingestion.ts) and the HTTP
// ingestion route (mcp/http/routes/ingestion.ts) now pass
// loadAllExtraRoots(loreHome()) as `extraRoots`. We assert that the
// loader source MCP uses equals what HTTP uses, for the same env. This
// pins the unification — on base the two surfaces called different
// loaders and diverged whenever LORE_WATCH_PATHS was set.
// The MCP ingestion tools read `extraRoots` from whatever loader they
// import; the HTTP route uses loadAllExtraRoots(). We pin BOTH:
//  (a) the source files agree on the loader (effective policy identical), and
//  (b) when LORE_WATCH_PATHS is set, the two loaders actually diverge unless
//      MCP switched — i.e. on base loadExtraIngestionRoots ≠ loadAllExtraRoots.
function mcpExtraRootsLoader(): 'all' | 'narrow' {
    const src = fs.readFileSync(
        path.join(here, '..', 'packages', 'lore', 'src', 'mcp', 'tools', 'ingestion.ts'),
        'utf-8',
    );
    return /extraRoots:\s*loadAllExtraRoots\(/.test(src) ? 'all' : 'narrow';
}
function httpExtraRootsLoader(): 'all' | 'narrow' {
    const src = fs.readFileSync(
        path.join(here, '..', 'packages', 'lore', 'src', 'mcp', 'http', 'routes', 'ingestion.ts'),
        'utf-8',
    );
    return /extraRoots:\s*loadAllExtraRoots\(/.test(src) ? 'all' : 'narrow';
}

test('MCP and HTTP ingestion select the SAME extra-roots loader', () => {
    assert.equal(mcpExtraRootsLoader(), httpExtraRootsLoader(),
        'MCP and HTTP ingestion must use the same allowlist loader');
});

test('MCP and HTTP resolve identical effective allowlist for a given LORE_WATCH_PATHS', () => {
    const tmp = mkTmp();
    const home = os.homedir();
    const watched = path.join(home, 'sw15-watched-dir');
    try {
        fs.writeFileSync(
            path.join(tmp, 'ingestion.json'),
            JSON.stringify({ roots: [path.join(home, 'Notes')] }),
        );
        process.env.LORE_WATCH_PATHS = watched;

        // Resolve each surface's effective roots through the loader its
        // source actually selects. On base MCP='narrow' (drops the watch
        // path) while HTTP='all' (keeps it) → the sets differ → fails.
        const pick = (which: 'all' | 'narrow'): string[] =>
            which === 'all' ? loadAllExtraRoots(tmp) : loadExtraIngestionRoots(tmp);
        const mcpRoots = pick(mcpExtraRootsLoader());
        const httpRoots = pick(httpExtraRootsLoader());

        assert.deepEqual(mcpRoots, httpRoots,
            'MCP and HTTP must resolve the same effective allowlist');
        assert.ok(httpRoots.includes(watched),
            'valid watch path must be in the effective allowlist');
    } finally { cleanup(tmp); restoreWatch(); }
});

/* ─── (2) LORE_WATCH_PATHS system roots are rejected/clamped ─────── */
test('LORE_WATCH_PATHS="/" is NOT honored as an ingestion root', () => {
    const tmp = mkTmp();
    try {
        process.env.LORE_WATCH_PATHS = '/';
        assert.deepEqual(loadWatchPathsAsRoots(), [],
            'root "/" must be dropped, not silently allowed');
        // And it must not leak into the merged set either.
        assert.ok(!loadAllExtraRoots(tmp).includes('/'),
            '"/" must not appear in loadAllExtraRoots');
    } finally { cleanup(tmp); restoreWatch(); }
});

test('LORE_WATCH_PATHS system roots and out-of-home paths are dropped; valid stays', () => {
    const tmp = mkTmp();
    const home = os.homedir();
    const valid = path.join(home, 'sw15-keep');
    try {
        process.env.LORE_WATCH_PATHS =
            ['/', '/etc', '/usr', '/var/log', '/private/etc', '/tmp/elsewhere', valid].join(':');
        const got = loadWatchPathsAsRoots();
        assert.deepEqual(got, [valid],
            `only the under-home path should survive; got ${JSON.stringify(got)}`);
    } finally { cleanup(tmp); restoreWatch(); }
});

test('isWatchRootSafe — system roots false, under-home true, home-itself false', () => {
    const isWatchRootSafe = mod.isWatchRootSafe;
    assert.ok(typeof isWatchRootSafe === 'function',
        'isWatchRootSafe must be exported (SW-15)');
    const home = os.homedir();
    for (const sys of ['/', '/etc', '/usr', '/bin', '/var', '/System', '/Library']) {
        assert.equal(isWatchRootSafe(sys, home), false, `${sys} must be unsafe`);
    }
    assert.equal(isWatchRootSafe(home, home), false, 'home itself must be unsafe (too broad)');
    assert.equal(isWatchRootSafe(path.join(home, 'Documents'), home), true);
    assert.equal(isWatchRootSafe(path.join(home, 'a', 'b', 'c'), home), true);
    assert.equal(isWatchRootSafe('/tmp/outside-home', home), false);
    assert.equal(isWatchRootSafe('relative/path', home), false);
    // Prefix-pitfall: "/etc-ish" is NOT "/etc" and is not under home → false,
    // but the point is it's not mistaken for the system root /etc.
    assert.equal(isWatchRootSafe('/etcetera', home), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
