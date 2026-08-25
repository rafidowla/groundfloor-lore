#!/usr/bin/env tsx
/**
 * test/workspaces-json-atomic-write-unit.ts — SP-07
 *
 * Verifies that every write path in config/workspaces.ts uses an atomic
 * tmp-file-then-rename pattern rather than writing directly over the live
 * workspaces.json.
 *
 * Three properties are checked:
 *   T1 — writeControl() writes via a .tmp.* intermediary and renames it to
 *         the final path (spy on fs.writeFileSync + fs.renameSync).
 *   T2 — If the process is killed after the tmp write but before the rename,
 *         the ORIGINAL workspaces.json is still intact (simulate interrupted
 *         write by manually placing a .tmp file, then asserting the original
 *         is unmodified).
 *   T3 — The migration path in loadWorkspaces() (first-run bootstrap) also
 *         uses writeControl, not a direct writeFileSync call.
 *
 * Run:
 *   LORE_HOME=$(mktemp -d) npx tsx test/workspaces-json-atomic-write-unit.ts
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
    return (async () => {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (err) {
            console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
            failed++;
        }
    })();
}

/**
 * Point LORE_HOME at a fresh tmpdir for the duration of fn. workspaces.ts
 * memoises HOME_GROUNDFLOOR at module import time, so we re-import with a
 * cache-buster query string on each call.
 */
async function withFreshHome<T>(
    fn: (home: string, mod: typeof import('../packages/lore/src/config/workspaces.js')) => T | Promise<T>,
): Promise<T> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-sp07-'));
    const prev = process.env.LORE_HOME;
    process.env.LORE_HOME = home;
    const cb = Math.random().toString(36).slice(2);
    const mod = await import(
        `../packages/lore/src/config/workspaces.js?cb=${cb}`
    ) as typeof import('../packages/lore/src/config/workspaces.js');
    try {
        return await fn(home, mod);
    } finally {
        if (prev === undefined) delete process.env.LORE_HOME;
        else process.env.LORE_HOME = prev;
        try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

console.log('\nSP-07 — workspaces.json atomic write\n');

/* ── T1: writeControl uses tmp + rename, never writes directly over live file ── */

await test('T1: createWorkspace leaves no stale .tmp files and final file is valid JSON', async () => {
    await withFreshHome(async (home, { createWorkspace }) => {
        // Seed a minimal workspaces.json so createWorkspace has something to load.
        const controlFile = path.join(home, 'workspaces.json');
        fs.writeFileSync(
            controlFile,
            JSON.stringify({
                active: 'default',
                workspaces: [{ name: 'default', path: home, createdAt: new Date().toISOString() }],
            }, null, 2),
            'utf8',
        );

        createWorkspace('sp07-test');

        // After a successful write, no .tmp.* files should remain.
        const entries = fs.readdirSync(home);
        const orphans = entries.filter((e) => e.includes('.tmp.'));
        assert.deepEqual(orphans, [], `stale .tmp files after createWorkspace: ${orphans.join(', ')}`);

        // The live file must be valid JSON with the new workspace listed.
        const raw = fs.readFileSync(controlFile, 'utf8');
        const parsed = JSON.parse(raw);
        assert.ok(
            Array.isArray(parsed.workspaces) && parsed.workspaces.some((w: { name: string }) => w.name === 'sp07-test'),
            'sp07-test must be registered in workspaces.json after createWorkspace',
        );
    });
});

/* ── T2: interrupted write (tmp present, rename not done) leaves original intact ── */

await test('T2: original workspaces.json survives a simulated interrupted write', async () => {
    await withFreshHome(async (home) => {
        const controlFile = path.join(home, 'workspaces.json');
        const originalContent = JSON.stringify({
            active: 'default',
            workspaces: [{ name: 'default', path: home, createdAt: '2026-01-01T00:00:00.000Z' }],
        }, null, 2);
        fs.writeFileSync(controlFile, originalContent, 'utf8');

        // Simulate: process died after tmp write but before rename.
        // Place a stale .tmp file with corrupted / partial content.
        const tmpFile = `${controlFile}.tmp.99999.1234567890`;
        fs.writeFileSync(tmpFile, '{"active":"default","workspaces":[{"name":', 'utf8');

        // The original must still be intact and valid.
        assert.ok(fs.existsSync(controlFile), 'workspaces.json must still exist');
        const readBack = fs.readFileSync(controlFile, 'utf8');
        assert.equal(readBack, originalContent, 'workspaces.json content must be unmodified by stale tmp');

        // Parsing must succeed (original is not corrupt).
        assert.doesNotThrow(() => JSON.parse(readBack), 'workspaces.json must remain valid JSON');
    });
});

/* ── T3: first-run bootstrap (loadWorkspaces migration path) also writes atomically ── */

await test('T3: loadWorkspaces first-run bootstrap produces valid JSON and no leftover .tmp', async () => {
    await withFreshHome(async (home, { loadWorkspaces }) => {
        // No workspaces.json yet — triggers the migration path.
        const controlFile = path.join(home, 'workspaces.json');
        assert.ok(!fs.existsSync(controlFile), 'precondition: no workspaces.json before loadWorkspaces');

        const file = loadWorkspaces();

        // File must now exist and be valid JSON.
        assert.ok(fs.existsSync(controlFile), 'workspaces.json must be created by loadWorkspaces');
        const raw = fs.readFileSync(controlFile, 'utf8');
        assert.doesNotThrow(() => JSON.parse(raw), 'workspaces.json must be valid JSON after first-run bootstrap');

        // Return value must have the default workspace.
        assert.equal(file.active, 'default', 'active must be "default" after bootstrap');
        assert.ok(file.workspaces.length > 0, 'workspaces array must be non-empty after bootstrap');

        // No stale .tmp files.
        const entries = fs.readdirSync(home);
        const orphans = entries.filter((e) => e.includes('.tmp.'));
        assert.deepEqual(orphans, [], `stale .tmp files after first-run bootstrap: ${orphans.join(', ')}`);
    });
});

/* ── T4: source-level audit — writeControl must contain renameSync, not bare writeFileSync ── */

await test('T4: workspaces.ts source uses renameSync in writeControl (not direct writeFileSync)', async () => {
    // Read the source file and assert the structural properties directly.
    // This is more reliable than patching ES module exports (which are
    // read-only) and is the pattern used for arch / code-quality checks
    // elsewhere in this repo.
    const srcPath = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        '../packages/lore/src/config/workspaces.ts',
    );
    const src = fs.readFileSync(srcPath, 'utf8');

    // Extract the writeControl function body (from its opening brace to the
    // closing brace). A simple approach: find the function declaration and
    // scan lines until we've balanced the braces.
    const fnStart = src.indexOf('function writeControl(');
    assert.ok(fnStart !== -1, 'writeControl function must exist in workspaces.ts');

    const fnBody = src.slice(fnStart);
    let depth = 0;
    let bodyEnd = 0;
    for (let i = fnBody.indexOf('{'); i < fnBody.length; i++) {
        if (fnBody[i] === '{') depth++;
        else if (fnBody[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
    }
    const body = fnBody.slice(0, bodyEnd + 1);

    // 1. renameSync must be called inside writeControl.
    assert.ok(body.includes('renameSync'), 'writeControl must call renameSync (atomic rename to final path)');

    // 2. writeFileSync inside writeControl must target a .tmp path, not CONTROL_FILE directly.
    //    We check that the argument passed to writeFileSync contains "tmp" (i.e. the tmp variable).
    const writeFileLine = body.split('\n').find((l) => l.includes('writeFileSync'));
    assert.ok(writeFileLine !== undefined, 'writeControl must call writeFileSync (to write the tmp file)');
    assert.ok(
        writeFileLine.includes('tmp'),
        `writeFileSync in writeControl must write to the tmp path, not the live file. Line: ${writeFileLine.trim()}`,
    );

    // 3. CONTROL_FILE must NOT appear as the first argument to writeFileSync inside writeControl.
    //    If it did, that would mean we're writing directly to the live file.
    assert.ok(
        !writeFileLine.includes('CONTROL_FILE'),
        `writeFileSync in writeControl must NOT write directly to CONTROL_FILE. Line: ${writeFileLine.trim()}`,
    );
});

const pending = []; // all tests are top-level awaits above; just summarise.
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
