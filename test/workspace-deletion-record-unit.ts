#!/usr/bin/env tsx
/**
 * workspace-deletion-record-unit.ts — cloud purge slice 1: every workspace deletion writes a durable
 * record (config/deletedWorkspaces.ts) BEFORE the registry entry is removed.
 *
 *   - The record is on disk before the registry changes; an append failure throws and leaves
 *     workspaces.json byte-identical.
 *   - Aliases that still keep the data live write no record; id-less entries record a derived id.
 *   - A torn last line is tolerated on read and never corrupts the next append.
 *   - liveWorkspaceIds covers stored ids, both derived forms and aliases, without writing anything.
 *   - Purge events fold into per-id state alongside the latest deletion record.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    createWorkspace, registerWorkspaceAlias, deleteWorkspace, loadWorkspaces, type WorkspaceEntry,
} from '../packages/lore/src/config/workspaces.js';
import { deriveWorkspaceId } from '../packages/lore/src/config/workspaceIds.js';
import {
    appendPurgeEvent, deletionLogPath, liveWorkspaceIds, readDeletionLog, recordWorkspaceDeletion,
} from '../packages/lore/src/config/deletedWorkspaces.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const homes: string[] = [];
const home = (): string => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ws-del-'));
    homes.push(h);
    return h;
};
const CONTROL = (h: string): string => path.join(h, 'workspaces.json');
const logLines = (h: string): string[] =>
    fs.existsSync(deletionLogPath(h)) ? fs.readFileSync(deletionLogPath(h), 'utf8').split('\n').filter(Boolean) : [];

/** Write a registry by hand (to get id-less legacy entries). */
function seed(h: string, workspaces: Array<Record<string, unknown>>): void {
    fs.writeFileSync(CONTROL(h), JSON.stringify({ active: 'default', workspaces: [
        { name: 'default', id: 'default-id', path: h, createdAt: '2026-01-01T00:00:00.000Z' }, ...workspaces,
    ] }, null, 2));
}

console.log('cloud purge: workspace deletion record');
const savedOrg = process.env['DATAPLANE_ORG_ID'];
const savedMode = process.env['LORE_DEPLOYMENT_MODE'];
delete process.env['LORE_DEPLOYMENT_MODE'];

try {
    await test('the record is written, and the registry entry is removed afterwards', () => {
        const h = home();
        loadWorkspaces(h);
        const a = createWorkspace('alpha', undefined, h);
        process.env['DATAPLANE_ORG_ID'] = 'org-7';
        const before = fs.readFileSync(CONTROL(h), 'utf8');
        assert.equal(logLines(h).length, 0);
        deleteWorkspace('alpha', h);
        const lines = logLines(h);
        assert.equal(lines.length, 1);
        const rec = JSON.parse(lines[0]!);
        assert.deepEqual(
            Object.keys(rec),
            ['v', 'event', 'id', 'idSource', 'name', 'path', 'createdAt', 'deletedAt', 'orgId', 'mode'],
        );
        assert.equal(rec.v, 1);
        assert.equal(rec.event, 'deleted');
        assert.equal(rec.id, a.id);
        assert.equal(rec.idSource, 'stored');
        assert.equal(rec.name, 'alpha');
        assert.equal(rec.path, a.path);
        assert.equal(rec.createdAt, a.createdAt);
        assert.equal(rec.orgId, 'org-7');
        assert.equal(rec.mode, 'local');
        assert.ok(!Number.isNaN(Date.parse(rec.deletedAt)));
        assert.notEqual(fs.readFileSync(CONTROL(h), 'utf8'), before, 'the registry entry is gone');
        assert.ok(!loadWorkspaces(h).workspaces.some((w) => w.name === 'alpha'));
        delete process.env['DATAPLANE_ORG_ID'];
        createWorkspace('beta', undefined, h);
        deleteWorkspace('beta', h);
        assert.equal(JSON.parse(logLines(h)[1]!).orgId, null, 'no DATAPLANE_ORG_ID -> null');
    });

    await test('an append failure throws and leaves the registry byte-identical', () => {
        const h = home();
        loadWorkspaces(h);
        createWorkspace('alpha', undefined, h);
        const before = fs.readFileSync(CONTROL(h));
        fs.mkdirSync(deletionLogPath(h)); // a directory where the log file should be -> open fails
        assert.throws(() => deleteWorkspace('alpha', h));
        assert.ok(fs.readFileSync(CONTROL(h)).equals(before), 'workspaces.json must not change');
        assert.ok(loadWorkspaces(h).workspaces.some((w) => w.name === 'alpha'));
    });

    await test('guard failures (active / unknown / bootstrap) write no record', () => {
        const h = home();
        loadWorkspaces(h);
        assert.throws(() => deleteWorkspace('nope', h));
        assert.throws(() => deleteWorkspace('default', h));
        assert.equal(logLines(h).length, 0);
    });

    await test('an alias still in the registry keeps the data live: no record', () => {
        const h = home();
        loadWorkspaces(h);
        const a = createWorkspace('alpha', undefined, h);
        registerWorkspaceAlias('alpha-view', a.path, undefined, h);
        deleteWorkspace('alpha', h);
        assert.equal(logLines(h).length, 0, 'the alias remains -> same id is still live');
        deleteWorkspace('alpha-view', h);
        const recs = logLines(h).map((l) => JSON.parse(l));
        assert.equal(recs.length, 1, 'the last holder of the id records it');
        assert.equal(recs[0].id, a.id);
        assert.equal(recs[0].name, 'alpha-view');
    });

    await test('an id-less same-path sibling inherits a stored id on backfill: no record', () => {
        const h = home();
        const p = path.join(h, 'workspaces', 'shared');
        seed(h, [
            { name: 'owner', id: 'owner-id', path: p, createdAt: '2026-02-01T00:00:00.000Z' },
            { name: 'legacy-alias', path: p, createdAt: '2026-03-01T00:00:00.000Z' },
        ]);
        deleteWorkspace('owner', h);
        assert.equal(logLines(h).length, 0);
    });

    await test('an id-less entry records its derived id (idSource "derived")', () => {
        const h = home();
        const p = path.join(h, 'workspaces', 'legacy');
        seed(h, [{ name: 'legacy', path: p, createdAt: '2026-02-01T00:00:00.000Z' }]);
        deleteWorkspace('legacy', h);
        const rec = JSON.parse(logLines(h)[0]!);
        assert.equal(rec.id, deriveWorkspaceId(p, '2026-02-01T00:00:00.000Z'));
        assert.equal(rec.idSource, 'derived');
        // No createdAt -> path-only derivation, createdAt recorded as null.
        const p2 = path.join(h, 'workspaces', 'older');
        seed(h, [{ name: 'older', path: p2 }]);
        deleteWorkspace('older', h);
        const rec2 = JSON.parse(logLines(h)[1]!);
        assert.equal(rec2.id, deriveWorkspaceId(p2));
        assert.equal(rec2.createdAt, null);
        // An id-less entry whose path another remaining entry shares is an alias: no record.
        const p3 = path.join(h, 'workspaces', 'twin');
        seed(h, [{ name: 'twin-a', path: p3, createdAt: 'x' }, { name: 'twin-b', path: p3, createdAt: 'y' }]);
        deleteWorkspace('twin-a', h);
        assert.equal(logLines(h).length, 2);
    });

    await test('a torn last line is tolerated on read and does not corrupt the next append', () => {
        const h = home();
        loadWorkspaces(h);
        createWorkspace('alpha', undefined, h);
        createWorkspace('beta', undefined, h);
        deleteWorkspace('alpha', h);
        fs.appendFileSync(deletionLogPath(h), '{"v":1,"event":"deleted","id":"torn-id","na'); // crash mid-write
        let log = readDeletionLog(h);
        assert.equal(log.byId.size, 1);
        assert.equal(log.skippedLines, 1);
        assert.ok(!log.byId.has('torn-id'));
        deleteWorkspace('beta', h); // must start a fresh line, not extend the torn one
        log = readDeletionLog(h);
        assert.equal(log.byId.size, 2, 'the new record after a torn tail is intact');
        assert.equal(log.skippedLines, 1);
        // Garbage of every kind is skipped and counted; a missing file is an empty log.
        fs.appendFileSync(deletionLogPath(h), '\nnot json\n[]\n{"v":2,"event":"deleted","id":"x"}\n{"v":1,"event":"mystery","id":"y"}\n\n');
        assert.equal(readDeletionLog(h).skippedLines, 5);
        const empty = readDeletionLog(home());
        assert.equal(empty.byId.size, 0);
        assert.equal(empty.skippedLines, 0);
    });

    await test('liveWorkspaceIds: stored ids, both derived forms, aliases; writes nothing', () => {
        const h = home();
        const pa = path.join(h, 'a');
        const pb = path.join(h, 'b');
        const entries = [
            { name: 'stored', id: 'id-1', path: pa, createdAt: 't1' },
            { name: 'stored-alias', id: 'id-1', path: pa, createdAt: 't2' },
            { name: 'legacy', path: pb, createdAt: 't3' },
            { name: 'legacy-empty-id', id: '', path: pb + '2', createdAt: 't4' },
            { name: 'legacy-no-ts', path: pb + '3' },
        ] as WorkspaceEntry[];
        const live = liveWorkspaceIds(entries);
        assert.ok(live.has('id-1'));
        assert.ok(live.has(deriveWorkspaceId(pb, 't3')), 'path + createdAt form');
        assert.ok(live.has(deriveWorkspaceId(pb)), 'path-only form');
        assert.ok(live.has(deriveWorkspaceId(pb + '2', 't4')));
        assert.ok(live.has(deriveWorkspaceId(pb + '3')));
        assert.ok(!live.has(deriveWorkspaceId(pa, 't1')), 'a stored-id entry contributes no derived id');
        assert.equal(live.size, 6);
        assert.deepEqual(fs.readdirSync(h), [], 'computing live ids writes nothing');
        assert.equal(liveWorkspaceIds([]).size, 0);
    });

    await test('purge events fold into per-id state next to the latest deletion record', () => {
        const h = home();
        const e = (name: string, id: string): WorkspaceEntry => ({ name, id, path: `/x/${name}`, createdAt: 'c' });
        recordWorkspaceDeletion(e('one', 'id-one'), [], h, new Date('2026-10-01T00:00:00Z'));
        recordWorkspaceDeletion(e('one-again', 'id-one'), [], h, new Date('2026-10-02T00:00:00Z'));
        recordWorkspaceDeletion(e('two', 'id-two'), [], h);
        const p1 = appendPurgeEvent({ id: 'id-one', connection: 'conn-a', status: 'partial', collections: { lore_node: { deleted: 3 } } }, h);
        assert.equal(p1.v, 1);
        assert.equal(p1.event, 'purge');
        appendPurgeEvent({ id: 'id-one', connection: 'conn-a', status: 'complete', collections: { lore_node: { deleted: 5 } }, at: '2026-10-03T00:00:00.000Z' }, h);
        appendPurgeEvent({ id: 'id-never-deleted', connection: 'conn-a', status: 'unverifiable', collections: {} }, h);
        const log = readDeletionLog(h);
        assert.equal(log.skippedLines, 0);
        assert.equal(log.byId.size, 3);
        const one = log.byId.get('id-one')!;
        assert.equal(one.deletion?.name, 'one-again', 'latest deletion record wins');
        assert.equal(one.deletion?.deletedAt, '2026-10-02T00:00:00.000Z');
        assert.equal(one.lastPurge?.status, 'complete', 'last purge event wins');
        assert.equal(one.lastPurge?.at, '2026-10-03T00:00:00.000Z');
        assert.deepEqual(one.lastPurge?.collections, { lore_node: { deleted: 5 } });
        assert.equal(log.byId.get('id-two')?.lastPurge, undefined);
        assert.equal(log.byId.get('id-never-deleted')?.deletion, undefined);
        assert.equal(log.byId.get('id-never-deleted')?.lastPurge?.status, 'unverifiable');
    });
} finally {
    if (savedOrg === undefined) delete process.env['DATAPLANE_ORG_ID']; else process.env['DATAPLANE_ORG_ID'] = savedOrg;
    if (savedMode === undefined) delete process.env['LORE_DEPLOYMENT_MODE']; else process.env['LORE_DEPLOYMENT_MODE'] = savedMode;
    for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
