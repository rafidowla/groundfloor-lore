#!/usr/bin/env tsx
/**
 * open-workspace-graph-unit.ts — CLI commands open the engine the workspace
 * declares.
 *
 * ── THE SILENT WRONG ANSWER THIS ENDS ───────────────────────────────────────
 *
 * Twenty-four CLI commands opened the graph with `new LocalGraph(basePath)`.
 * On a workspace whose `graphEngine` is `'surreal'` that is the WRONG database
 * — and it does not fail, because such a workspace keeps a Kùzu database that
 * has a real, EMPTY `LoreNode` table. So `lore status` reported zero nodes,
 * `lore export` wrote an empty file and `lore recall` found nothing, all with
 * exit code 0, on a workspace that was working perfectly.
 *
 * There used to be two mechanisms here. `openWorkspaceGraph` picks the declared
 * engine, and `assertKuzuBackedPath` REFUSED for the six commands that spoke
 * raw Cypher and had no engine-agnostic equivalent. The refusal was correct
 * while it was true — a clean `lore lint` on an unread graph is worse than an
 * error, because someone believes it — but it was never the destination. All
 * six are ported, the guard is deleted, and the invariant at the bottom of this
 * file tightened accordingly: a CLI command may no longer name the Kùzu class
 * AT ALL, with or without a guard.
 *
 * Cross-engine agreement of the ported commands themselves is
 * `test/cli-engine-parity-unit.ts`; this file covers engine RESOLUTION.
 *
 * Run: npx tsx test/open-workspace-graph-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    openWorkspaceGraph,
    resolveGraphEngineForPath,
} from '../packages/lore/src/engines/openWorkspaceGraph.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
    try {
        fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? String(err)}`);
        failed++;
    }
}

/**
 * A LORE_HOME with three registered workspaces: an explicit surreal
 * declaration (sws), a legacy 'kuzu' declaration (kws), and one (bws) with
 * no graphEngine field at all, to test the absent-field/default path on its
 * own. kws is no longer asserted against: honouring an explicit 'kuzu'
 * declaration is transitional behavior that dies with LocalGraph, so it
 * survives here only as the decoy path in the workspaceId-precedence test.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-owg-'));
const kuzuPath = path.join(home, 'workspaces', 'kws');
const surrealPath = path.join(home, 'workspaces', 'sws');
const barePath = path.join(home, 'workspaces', 'bws');
for (const p of [kuzuPath, surrealPath, barePath]) fs.mkdirSync(path.join(p, '.lore'), { recursive: true });
fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
    active: 'kws',
    workspaces: [
        { name: 'kws', path: kuzuPath, createdAt: new Date().toISOString(), graphEngine: 'kuzu' },
        { name: 'sws', path: surrealPath, createdAt: new Date().toISOString(), graphEngine: 'surreal' },
        { name: 'bws', path: barePath, createdAt: new Date().toISOString() },
    ],
}, null, 2));

console.log('openWorkspaceGraph — CLI opens the declared engine');

test('a workspace with no graphEngine field resolves to the default (surreal since 2026-08-11)', () => {
    const r = resolveGraphEngineForPath(barePath, { home });
    assert.equal(r.engine, 'surreal');
    assert.equal(r.workspace, 'bws', 'and the workspace is identified by path alone');
});


test('graphEngine: surreal resolves to surreal, found by PATH not by name', () => {
    // The path lookup is the load-bearing part: CLI commands have a directory,
    // not a workspace name, which is why they all hardcoded Kùzu.
    const r = resolveGraphEngineForPath(surrealPath, { home });
    assert.equal(r.engine, 'surreal');
    assert.equal(r.workspace, 'sws');
});

test('a trailing slash still matches the registered workspace', () => {
    // workspaces.json and a caller-computed path routinely disagree on this.
    assert.equal(resolveGraphEngineForPath(`${surrealPath}/`, { home }).engine, 'surreal');
});

test('an explicit workspaceId wins over path lookup', () => {
    assert.equal(
        resolveGraphEngineForPath(kuzuPath, { workspaceId: 'sws', home }).engine,
        'surreal',
    );
});

test('an unregistered path falls back to the default, it does not throw', () => {
    // A bare `--path`, or a temp dir in a test. Before this module such a
    // caller got a LocalGraph; it must still get one.
    const stray = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-owg-stray-'));
    const r = resolveGraphEngineForPath(stray, { home });
    assert.equal(r.engine, 'surreal');
    assert.equal(r.workspace, null, 'and reports that it matched nothing');
    fs.rmSync(stray, { recursive: true, force: true });
});

test('the factory constructs the engine the workspace declares', () => {
    // The regression in one assertion: before this, every path returned
    // LocalGraph. The load-bearing half now is that a declared engine and
    // the absent-field default BOTH yield SurrealGraph — the Kùzu branch of
    // this factory is on its way out, and nothing may keep asserting it.
    const s = openWorkspaceGraph(surrealPath, { home });
    const b = openWorkspaceGraph(barePath, { home });
    assert.equal(s.constructor.name, 'SurrealGraph');
    assert.equal(b.constructor.name, 'SurrealGraph');
});

test('construction has no side effects on disk', () => {
    // Several commands build a graph and then decide not to use it. `new
    // LocalGraph(...)` did not create anything until initialize(); nor may this.
    const before = fs.readdirSync(path.join(surrealPath, '.lore')).sort();
    openWorkspaceGraph(surrealPath, { home });
    assert.deepEqual(fs.readdirSync(path.join(surrealPath, '.lore')).sort(), before);
});

console.log('the Kùzu class is out of the CLI entirely');

test('no CLI command constructs LocalGraph', () => {
    // The invariant that makes the tests above mean something: a command that
    // builds its own `new LocalGraph(...)` bypasses engine resolution and is
    // back to reading the empty Kùzu table on a Surreal workspace. This
    // replaces the older "constructs LocalGraph AND calls assertKuzuBackedPath"
    // pairing, which permitted the construction as long as it was guarded.
    // Nothing needs that permission any more, so the rule is now flat.
    //
    // A source check because it is a statement about the whole directory
    // rather than about one function's behaviour.
    const dir = path.resolve('packages/lore/src/cli/commands');
    const offenders: string[] = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
        if (fs.readFileSync(path.join(dir, f), 'utf8').includes('new LocalGraph(')) offenders.push(f);
    }
    assert.deepEqual(offenders, [],
        `these bypass openWorkspaceGraph and hardcode Kùzu: ${offenders.join(', ')}`);
});

fs.rmSync(home, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
