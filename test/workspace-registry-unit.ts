#!/usr/bin/env tsx
/**
 * test/workspace-registry-unit.ts — Phase 1 item 13.
 *
 * Verifies the workspace-paths.json registry helpers and the one-time
 * projects.json → workspace-paths.json migration on first read. See
 * packages/lore/src/config/workspaceRegistry.ts.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let passed = 0;
let failed = 0;

const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => void | Promise<void>) {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); failed++; }
    })());
}

/**
 * The registry helpers compute paths from `loreHomePath()`, which
 * reads `LORE_HOME` from the environment. Each test points it at a
 * fresh tmpdir so the suite never touches the user's real
 * ~/.groundfloor.
 */
async function withFreshLoreHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ws-registry-'));
    const prevHome = process.env.LORE_HOME;
    process.env.LORE_HOME = dir;
    // The loreHome module memoizes; bypass by importing fresh per
    // call via the URL-cache-busting query trick.
    const tag = Math.random().toString(36).slice(2);
    const mod = await import(
        `../packages/lore/src/config/workspaceRegistry.js?cb=${tag}`
    );
    try { return await fn(dir); }
    finally {
        if (prevHome === undefined) delete process.env.LORE_HOME;
        else process.env.LORE_HOME = prevHome;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
        // suppress unused
        void mod;
    }
}

/**
 * Simpler direct path: import once, but pass an explicit home dir
 * via an env override at call time. The helpers only read LORE_HOME
 * lazily through loreHomePath, so setting it before each call works.
 */
import {
    readWorkspaceRegistry,
    writeWorkspaceRegistry,
    upsertWorkspaceMapping,
    workspaceRegistryPath,
    legacyProjectsRegistryPath,
    migrateProjectsJsonToWorkspacesJson,
} from '../packages/lore/src/config/workspaceRegistry.js';

function withTmpHome<T>(fn: () => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ws-'));
    const prev = process.env.LORE_HOME;
    process.env.LORE_HOME = dir;
    try { return fn(); }
    finally {
        if (prev === undefined) delete process.env.LORE_HOME;
        else process.env.LORE_HOME = prev;
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

console.log('workspace registry — Phase 1 item 13');

/* ---------- read / write ---------- */

test('readWorkspaceRegistry returns empty registry when no file exists', () => {
    withTmpHome(() => {
        const reg = readWorkspaceRegistry();
        assert.deepEqual(reg, { projects: {} });
    });
});

test('writeWorkspaceRegistry then readWorkspaceRegistry round-trips', () => {
    withTmpHome(() => {
        const reg = { projects: { foo: { ecosystem: 'eco', paths: ['/foo'] } } };
        writeWorkspaceRegistry(reg);
        const out = readWorkspaceRegistry();
        assert.deepEqual(out, reg);
        // And the file is at workspace-paths.json (not projects.json).
        assert.ok(fs.existsSync(workspaceRegistryPath()));
        assert.ok(!fs.existsSync(legacyProjectsRegistryPath()));
    });
});

test('upsertWorkspaceMapping reports new vs existing', () => {
    const reg = { projects: {} as Record<string, { ecosystem: string; paths: string[] }> };
    const r1 = upsertWorkspaceMapping(reg, 'a', { ecosystem: 'e', paths: ['/a'] });
    assert.equal(r1.alreadyExisted, false);
    const r2 = upsertWorkspaceMapping(reg, 'a', { ecosystem: 'e', paths: ['/a', '/b'] });
    assert.equal(r2.alreadyExisted, true);
    assert.deepEqual(reg.projects.a.paths, ['/a', '/b']);
});

/* ---------- migration ---------- */

test('migration is a no-op when neither file exists', () => {
    withTmpHome(() => {
        const r = migrateProjectsJsonToWorkspacesJson();
        assert.equal(r.migrated, false);
        assert.match(r.reason ?? '', /not present/);
    });
});

test('migration is a no-op when workspace-paths.json already exists', () => {
    withTmpHome(() => {
        fs.mkdirSync(path.dirname(workspaceRegistryPath()), { recursive: true });
        fs.writeFileSync(workspaceRegistryPath(), '{"projects":{}}', 'utf-8');
        fs.writeFileSync(legacyProjectsRegistryPath(), '{"projects":{"x":{"ecosystem":"e","paths":["/x"]}}}', 'utf-8');
        const r = migrateProjectsJsonToWorkspacesJson();
        assert.equal(r.migrated, false);
        assert.match(r.reason ?? '', /already present/);
        // workspace-paths.json untouched
        const out = readWorkspaceRegistry();
        assert.deepEqual(out, { projects: {} });
    });
});

test('migration copies projects.json → workspace-paths.json on first read', () => {
    withTmpHome(() => {
        const legacy = { projects: { videosnap: { ecosystem: 'gf', paths: ['/vs'] } } };
        fs.mkdirSync(path.dirname(legacyProjectsRegistryPath()), { recursive: true });
        fs.writeFileSync(legacyProjectsRegistryPath(), JSON.stringify(legacy), 'utf-8');

        // Read should trigger the migration.
        const reg = readWorkspaceRegistry();
        assert.deepEqual(reg, legacy);
        // Both files now exist.
        assert.ok(fs.existsSync(workspaceRegistryPath()));
        assert.ok(fs.existsSync(legacyProjectsRegistryPath()), 'legacy projects.json must remain for one release cycle');
        // The new file has the same contents.
        const newContents = JSON.parse(fs.readFileSync(workspaceRegistryPath(), 'utf-8'));
        assert.deepEqual(newContents, legacy);
    });
});

test('explicit migration call is idempotent on second invocation', () => {
    withTmpHome(() => {
        const legacy = { projects: { foo: { ecosystem: 'e', paths: ['/foo'] } } };
        fs.mkdirSync(path.dirname(legacyProjectsRegistryPath()), { recursive: true });
        fs.writeFileSync(legacyProjectsRegistryPath(), JSON.stringify(legacy), 'utf-8');
        const r1 = migrateProjectsJsonToWorkspacesJson();
        assert.equal(r1.migrated, true);
        const r2 = migrateProjectsJsonToWorkspacesJson();
        assert.equal(r2.migrated, false);
    });
});

test('migration validates JSON before writing — refuses to corrupt the new file', () => {
    withTmpHome(() => {
        fs.mkdirSync(path.dirname(legacyProjectsRegistryPath()), { recursive: true });
        fs.writeFileSync(legacyProjectsRegistryPath(), '{not json', 'utf-8');
        assert.throws(() => migrateProjectsJsonToWorkspacesJson(), /JSON/i);
        // workspace-paths.json was not created
        assert.ok(!fs.existsSync(workspaceRegistryPath()));
    });
});

test('subsequent writes go to workspace-paths.json, not projects.json', () => {
    withTmpHome(() => {
        // Seed: only legacy file present
        const legacy = { projects: { foo: { ecosystem: 'e', paths: ['/foo'] } } };
        fs.mkdirSync(path.dirname(legacyProjectsRegistryPath()), { recursive: true });
        fs.writeFileSync(legacyProjectsRegistryPath(), JSON.stringify(legacy), 'utf-8');
        const legacySize = fs.statSync(legacyProjectsRegistryPath()).size;

        const reg = readWorkspaceRegistry(); // triggers migration
        upsertWorkspaceMapping(reg, 'bar', { ecosystem: 'e', paths: ['/bar'] });
        writeWorkspaceRegistry(reg);

        // workspace-paths.json now has both rows; projects.json is untouched (same size)
        const wsContents = JSON.parse(fs.readFileSync(workspaceRegistryPath(), 'utf-8'));
        assert.deepEqual(Object.keys(wsContents.projects).sort(), ['bar', 'foo']);
        assert.equal(fs.statSync(legacyProjectsRegistryPath()).size, legacySize);
    });
});

await Promise.all(pending);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
