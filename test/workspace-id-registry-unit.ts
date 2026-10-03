#!/usr/bin/env tsx
/**
 * workspace-id-registry-unit.ts — cloud parity C review #6: the permanent workspace id in the registry
 * (config/workspaces.ts, config/workspaceIds.ts) and the cloud registry view (mcp/cloudBootConfig.ts).
 *
 *   - createWorkspace gives an immutable id; rename keeps it; delete-then-recreate gets a new one;
 *     an alias shares its target's id.
 *   - Old registry files without ids load unchanged (and loading never rewrites them).
 *   - Backfill (Dataplane-backed stores only) is atomic, minimal, idempotent, race-safe and
 *     alias-consistent, and never touches path fields.
 *   - Local and embedded hosts leave workspaces.json byte-identical after boot.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
    createWorkspace, registerWorkspaceAlias, renameWorkspace, deleteWorkspace,
    loadWorkspaces, loadWorkspacesIfPresent, type WorkspacesFile,
} from '../packages/lore/src/config/workspaces.js';
import { ensureWorkspaceIds, deriveWorkspaceId, isValidWorkspaceId } from '../packages/lore/src/config/workspaceIds.js';
import { createWorkspaceRegistry } from '../packages/lore/src/mcp/cloudBootConfig.js';
import { resolveSyncAdapterFromEnv } from '../packages/lore/src/mcp/services.js';
import { createLore } from '../packages/lore/src/index.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const mkHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ws-id-'));
const CONTROL = (h: string): string => path.join(h, 'workspaces.json');
const read = (h: string): Buffer => fs.readFileSync(CONTROL(h));
const entry = (f: WorkspacesFile, name: string) => f.workspaces.find((w) => w.name === name)!;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A pre-id registry file: default + a workspace + an alias that points at the same path as `team`. */
function seedLegacy(home: string): { raw: string; teamPath: string; defaultPath: string } {
    const teamPath = path.join(home, 'workspaces', 'team');
    fs.mkdirSync(path.join(teamPath, '.lore'), { recursive: true });
    const raw = JSON.stringify({
        active: 'default',
        workspaces: [
            { name: 'default', path: home, createdAt: '2026-01-01T00:00:00.000Z', graphEngine: 'surreal' },
            { name: 'team', label: 'Team', mode: 'local-only', path: teamPath, createdAt: '2026-02-01T00:00:00.000Z', retention: { hideSupersededInRecall: false } },
            { name: 'team-alias', path: teamPath, createdAt: '2026-03-01T00:00:00.000Z' },
        ],
    }, null, 2);
    fs.writeFileSync(CONTROL(home), raw, 'utf8');
    return { raw, teamPath, defaultPath: home };
}

console.log('cloud parity C review #6: registry ids');
const homes: string[] = [];
const home = (): string => { const h = mkHome(); homes.push(h); return h; };

try {
    await test('createWorkspace assigns a UUID id; the fresh default entry gets one too', () => {
        const h = home();
        const f = loadWorkspaces(h); // fresh home -> default entry
        assert.match(entry(f, 'default').id ?? '', UUID);
        const a = createWorkspace('alpha', undefined, h);
        const b = createWorkspace('beta', undefined, h);
        assert.match(a.id ?? '', UUID);
        assert.notEqual(a.id, b.id);
        assert.notEqual(a.id, entry(f, 'default').id);
    });

    await test('rename keeps the id; delete then recreate under the same name gets a NEW id', () => {
        const h = home();
        loadWorkspaces(h);
        const a = createWorkspace('alpha', undefined, h);
        renameWorkspace('alpha', 'alpha-two', h);
        const renamed = entry(loadWorkspaces(h), 'alpha-two');
        assert.equal(renamed.id, a.id, 'a rename must not change the id');
        deleteWorkspace('alpha-two', h);
        const again = createWorkspace('alpha-two', undefined, h);
        assert.notEqual(again.id, a.id, 'a recreated workspace is a new tenant');
        const reused = createWorkspace('alpha', undefined, h);
        assert.notEqual(reused.id, a.id);
    });

    await test('an alias registered at an existing path shares the target\'s id', () => {
        const h = home();
        loadWorkspaces(h);
        const a = createWorkspace('alpha', undefined, h);
        const al = registerWorkspaceAlias('alpha-alias', a.path, undefined, h);
        assert.equal(al.id, a.id);
        const view = createWorkspaceRegistry(h);
        assert.equal(view.resolveId('alpha-alias'), a.id);
        assert.equal(view.resolveId('alpha'), a.id);
        assert.equal(view.resolveId('nope'), undefined);
        assert.equal(view.has('nope'), false);
    });

    await test('OLD registry files without ids still load, unchanged and un-rewritten', () => {
        const h = home();
        const { raw } = seedLegacy(h);
        const f = loadWorkspaces(h);
        assert.equal(f.workspaces.length, 3);
        assert.ok(f.workspaces.every((w) => w.id === undefined));
        assert.equal(loadWorkspacesIfPresent(h)!.workspaces.length, 3);
        assert.equal(read(h).toString('utf8'), raw, 'loading must not write');
        // the local-mode registry accessors never need an id
        assert.equal(createWorkspaceRegistry(h).has('team'), true);
        assert.equal(read(h).toString('utf8'), raw, 'has()/names() must not write either');
    });

    await test('backfill: ids appear on first resolveId, ONLY the id field is added, path fields and every other field are preserved', () => {
        const h = home();
        const { raw, teamPath, defaultPath } = seedLegacy(h);
        const before = JSON.parse(raw) as WorkspacesFile;
        const view = createWorkspaceRegistry(h);
        const teamId = view.resolveId('team');
        assert.ok(isValidWorkspaceId(teamId));
        const after = JSON.parse(read(h).toString('utf8')) as WorkspacesFile;
        assert.equal(after.active, before.active);
        assert.equal(after.workspaces.length, 3);
        for (const [i, w] of after.workspaces.entries()) {
            const { id, ...rest } = w;
            assert.ok(isValidWorkspaceId(id), `${w.name} has an id`);
            assert.deepEqual(rest, before.workspaces[i], `${w.name}: nothing but id changed`);
        }
        assert.equal(entry(after, 'team').path, teamPath);
        assert.equal(entry(after, 'default').path, defaultPath);
        // alias resolves to the same id as its target; default is distinct
        assert.equal(view.resolveId('team-alias'), teamId);
        assert.notEqual(view.resolveId('default'), teamId);
        assert.equal(teamId, deriveWorkspaceId(teamPath, entry(after, 'team').createdAt));
    });

    await test('backfill is idempotent: a second run writes nothing and returns the same ids', () => {
        const h = home();
        seedLegacy(h);
        const first = ensureWorkspaceIds(h)!;
        const bytes = read(h);
        const ino = fs.statSync(CONTROL(h)).ino;
        const second = ensureWorkspaceIds(h)!;
        assert.deepEqual(second, first);
        assert.ok(bytes.equals(read(h)));
        assert.equal(fs.statSync(CONTROL(h)).ino, ino, 'no rewrite (same inode)');
        // a fresh view over the same home resolves the persisted ids
        assert.equal(createWorkspaceRegistry(h).resolveId('team'), entry(first, 'team').id);
    });

    await test('backfill never creates a registry and never replaces an id that is present (even a malformed one fails closed instead)', () => {
        const h = home();
        assert.equal(ensureWorkspaceIds(h), null);
        assert.equal(fs.existsSync(CONTROL(h)), false);
        const raw = JSON.stringify({ active: 'a', workspaces: [
            { name: 'a', path: path.join(h, 'a'), createdAt: 'x', id: 'keep-this-id' },
            { name: 'bad', path: path.join(h, 'bad'), createdAt: 'x', id: 'has space\u001f' },
        ] }, null, 2);
        fs.writeFileSync(CONTROL(h), raw);
        const view = createWorkspaceRegistry(h);
        assert.equal(view.resolveId('a'), 'keep-this-id');
        assert.equal(view.resolveId('bad'), undefined, 'a malformed id fails closed');
        assert.equal(read(h).toString('utf8'), raw, 'nothing to backfill, nothing written');
    });

    await test('an unwritable registry cannot serve an unstable id: resolveId fails closed', () => {
        const h = home();
        seedLegacy(h);
        fs.chmodSync(h, 0o555); // rename into the directory fails
        try {
            if (process.getuid?.() === 0) return; // root ignores the mode; nothing to prove
            assert.equal(createWorkspaceRegistry(h).resolveId('team'), undefined);
        } finally { fs.chmodSync(h, 0o755); }
    });

    await test('backfill salt: an id-less entry re-created at a deleted legacy workspace\'s path does NOT inherit its id', () => {
        const h = home();
        const { teamPath } = seedLegacy(h);
        const oldId = createWorkspaceRegistry(h).resolveId('team');
        assert.ok(isValidWorkspaceId(oldId));
        // new build: delete (directory stays), then alias a new name onto the leftover directory
        deleteWorkspace('team-alias', h);
        deleteWorkspace('team', h);
        registerWorkspaceAlias('squatter', teamPath, undefined, h);
        const squat = createWorkspaceRegistry(h).resolveId('squatter');
        assert.ok(isValidWorkspaceId(squat));
        assert.notEqual(squat, oldId, 'alias onto a deleted workspace\'s path must not inherit its id');
        // older build: delete-then-recreate writes an id-less entry with the same name and path
        deleteWorkspace('squatter', h);
        const f = loadWorkspaces(h);
        f.workspaces.push({ name: 'team', path: teamPath, createdAt: new Date(Date.now() + 1).toISOString() });
        fs.writeFileSync(CONTROL(h), JSON.stringify(f, null, 2));
        const again = createWorkspaceRegistry(h).resolveId('team');
        assert.ok(isValidWorkspaceId(again));
        assert.notEqual(again, oldId, 'old-build delete-then-recreate must start a fresh id');
        assert.notEqual(again, squat);
    });

    await test('concurrent backfill converges: three processes racing end with ONE id per entry, all agreeing with the file', async () => {
        const h = home();
        seedLegacy(h);
        const child = path.join(path.dirname(new URL(import.meta.url).pathname), 'helpers', 'workspace-id-backfill-child.ts');
        const startAt = Date.now() + 2500;
        const run = (): Promise<Record<string, string | null>> => new Promise((resolve, reject) => {
            const p = spawn(process.execPath, ['--import', 'tsx', child, h, String(startAt), 'default', 'team', 'team-alias'], { stdio: ['ignore', 'pipe', 'inherit'] });
            let out = '';
            p.stdout.on('data', (d) => { out += d; });
            p.on('error', reject);
            p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop()!)) : reject(new Error(`child exit ${code}`))));
        });
        const results = await Promise.all([run(), run(), run()]);
        const onDisk = loadWorkspaces(h);
        for (const n of ['default', 'team', 'team-alias']) {
            const ids = new Set(results.map((r) => r[n]));
            assert.equal(ids.size, 1, `${n}: every process adopted the same id`);
            assert.equal([...ids][0], entry(onDisk, n).id, `${n}: and it is the id on disk`);
        }
        assert.equal(entry(onDisk, 'team').id, entry(onDisk, 'team-alias').id);
        assert.equal(fs.readdirSync(h).filter((f) => f.startsWith('workspaces.json.tmp')).length, 0, 'no temp files left behind');
    });

    await test('LOCAL / EMBEDDED: building the sync adapter and booting an embedded Lore leave workspaces.json byte-identical', async () => {
        // local-sync adapter (key set, local mode): built, never resolved -> nothing written
        const h = home();
        const { raw } = seedLegacy(h);
        const saved = { k: process.env['DATAPLANE_API_KEY'], home: process.env['LORE_HOME'] };
        process.env['DATAPLANE_API_KEY'] = 'k';
        try {
            const adapter = resolveSyncAdapterFromEnv('local', h);
            assert.ok(adapter);
            assert.equal(read(h).toString('utf8'), raw, 'constructing the local-sync adapter must not backfill');
        } finally {
            if (saved.k === undefined) delete process.env['DATAPLANE_API_KEY']; else process.env['DATAPLANE_API_KEY'] = saved.k;
        }
        // embedded host (Atlas / MIRA / PM Helper style): boot, use, dispose
        const e = home();
        const wsPath = path.join(e, 'workspaces', 'emb');
        fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
        const embRaw = JSON.stringify({ active: 'emb', workspaces: [{ name: 'emb', path: wsPath, createdAt: '2026-01-01T00:00:00.000Z' }] }, null, 2);
        fs.writeFileSync(CONTROL(e), embRaw);
        process.env['LORE_HOME'] = e;
        try {
            const lore = await createLore({ deploymentMode: 'embedded', dataDir: e });
            await lore.dispose('test-teardown');
        } finally {
            if (saved.home === undefined) delete process.env['LORE_HOME']; else process.env['LORE_HOME'] = saved.home;
        }
        assert.equal(read(e).toString('utf8'), embRaw, 'an embedded boot must not rewrite workspaces.json');
    });
} finally {
    for (const h of homes) {
        for (let i = 0; i < 8; i++) {
            try { fs.rmSync(h, { recursive: true, force: true }); break; } catch (err) { if (i === 7) throw err; await new Promise((r) => setTimeout(r, 100)); }
        }
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
