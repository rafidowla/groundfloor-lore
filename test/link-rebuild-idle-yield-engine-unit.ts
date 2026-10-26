#!/usr/bin/env tsx
/**
 * test/link-rebuild-idle-yield-engine-unit.ts - the per-engine default of the idle rebuild pause:
 *   - config: SQLite 200 ms, everything else 10 ms; an explicit LORE_LINK_REBUILD_IDLE_YIELD_MS (valid) wins for both engines;
 *     a junk / out-of-range env value falls back to each engine's own default
 *   - programmatic override: rebuildIdleYieldMs sets both engines unless rebuildIdleYieldMsSqlite is given too
 *   - rebuildIdleYieldFor picks the field by engine name
 *   - the rebuilder accepts a per-workspace function for idleYieldMs, and falls back to yieldMs when it throws
 *   - the host wiring (discoveryHostFields) resolves a workspace's engine from workspaces.json, so a sqlite workspace gets 200 and a postgres one 10
 *
 * Run: npx tsx test/link-rebuild-idle-yield-engine-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LINK_DEFAULTS, applyLinkOverrides, loadLinkConfig, rebuildIdleYieldFor } from '../packages/lore/src/link/linkConfig.js';
import { discoveryHostFields } from '../packages/lore/src/link/createLinkService.js';
import { P_NEW, cleanupTmps, engines, makeRebuilder, runToEnd, seedWorld } from './helpers/linkRebuildWorld.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    try { await fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? String(err)}`); }
}

console.log('config: per-engine default');
await test('defaults: SQLite 200, Postgres / other 10', () => {
    assert.equal(LINK_DEFAULTS.rebuildIdleYieldMs, 10);
    assert.equal(LINK_DEFAULTS.rebuildIdleYieldMsSqlite, 200);
    const c = loadLinkConfig({});
    assert.equal(rebuildIdleYieldFor(c, 'sqlite'), 200);
    for (const e of ['postgres', 'surreal', null, undefined]) assert.equal(rebuildIdleYieldFor(c, e), 10, `engine ${String(e)}`);
});
await test('an explicit env value wins for both engines (including 0)', () => {
    for (const v of ['0', '75', '60000']) {
        const c = loadLinkConfig({ LORE_LINK_REBUILD_IDLE_YIELD_MS: v });
        assert.equal(rebuildIdleYieldFor(c, 'sqlite'), Number(v), `sqlite ${v}`);
        assert.equal(rebuildIdleYieldFor(c, 'postgres'), Number(v), `postgres ${v}`);
    }
});
await test('junk / out-of-range env falls back to each engine own default', () => {
    for (const bad of ['999999', '-1', 'abc']) {
        const c = loadLinkConfig({ LORE_LINK_REBUILD_IDLE_YIELD_MS: bad });
        assert.equal(rebuildIdleYieldFor(c, 'sqlite'), 200, `sqlite ${bad}`);
        assert.equal(rebuildIdleYieldFor(c, 'postgres'), 10, `postgres ${bad}`);
    }
});
await test('programmatic rebuildIdleYieldMs sets both engines; an explicit SQLite value stays separate; bad value throws', () => {
    const both = applyLinkOverrides(LINK_DEFAULTS, { rebuildIdleYieldMs: 0 });
    assert.equal(rebuildIdleYieldFor(both, 'sqlite'), 0);
    assert.equal(rebuildIdleYieldFor(both, 'postgres'), 0);
    const split = applyLinkOverrides(LINK_DEFAULTS, { rebuildIdleYieldMs: 5, rebuildIdleYieldMsSqlite: 300 });
    assert.equal(rebuildIdleYieldFor(split, 'sqlite'), 300);
    assert.equal(rebuildIdleYieldFor(split, 'postgres'), 5);
    const sqliteOnly = applyLinkOverrides(LINK_DEFAULTS, { rebuildIdleYieldMsSqlite: 20 });
    assert.equal(rebuildIdleYieldFor(sqliteOnly, 'sqlite'), 20);
    assert.equal(rebuildIdleYieldFor(sqliteOnly, 'postgres'), 10);
    assert.throws(() => applyLinkOverrides(LINK_DEFAULTS, { rebuildIdleYieldMsSqlite: -1 }), RangeError);
});

console.log('\nrebuilder: per-workspace idle yield');
{
    const eng = engines(null)[0]!;
    const slept = async (idleYieldMs: number | ((ws: string) => number)): Promise<number[]> => {
        const w = await eng.open(); await seedWorld(w);
        const out: number[] = [];
        const rb = makeRebuilder(w, P_NEW, { batchSize: 5, yieldMs: 500, idleYieldMs, isBusy: () => false, maxWaitMs: 100, sleep: async (ms) => { out.push(ms); } });
        const st = await runToEnd(rb);
        assert.equal(st.status, 'done');
        rb.close(); await w.close();
        return out.filter((ms) => ms !== 50);
    };
    await test('a function idleYieldMs is asked per workspace and its value is slept', async () => {
        const asked: string[] = [];
        const s = await slept((ws) => { asked.push(ws); return 37; });
        assert.ok(s.length > 0 && s.every((ms) => ms === 37), `slept ${JSON.stringify(s)}`);
        assert.ok(asked.length > 0 && asked.every((ws) => typeof ws === 'string' && ws.length > 0));
    });
    await test('the function value is still capped at yieldMs', async () => {
        const s = await slept(() => 9_999);
        assert.ok(s.length > 0 && s.every((ms) => ms === 500), `slept ${JSON.stringify(s)}`);
    });
    await test('a throwing or non-finite function falls back to yieldMs (the safe, slower pause)', async () => {
        const t = await slept(() => { throw new Error('engine lookup failed'); });
        assert.ok(t.length > 0 && t.every((ms) => ms === 500), `throw: ${JSON.stringify(t)}`);
        const n = await slept(() => Number.NaN);
        assert.ok(n.length > 0 && n.every((ms) => ms === 500), `NaN: ${JSON.stringify(n)}`);
    });
}

console.log('\nhost wiring');
await test('discoveryHostFields.graphEngineOf reads the engine from workspaces.json, and that picks the pause', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-idle-yield-'));
    try {
        const ws = (name: string, graphEngine: string) => ({ name, id: `id-${name}`, path: path.join(home, name), createdAt: '2026-10-25T00:00:00.000Z', graphEngine });
        fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({ active: 'a-sqlite', workspaces: [ws('a-sqlite', 'sqlite'), ws('b-pg', 'postgres')] }));
        const f = discoveryHostFields(undefined, home, () => ({ depth: () => 0, hasPendingForWorkspace: () => false }), () => undefined);
        const cfg = loadLinkConfig({});
        assert.equal(typeof f.graphEngineOf, 'function');
        assert.equal(rebuildIdleYieldFor(cfg, f.graphEngineOf!('a-sqlite')), 200);
        assert.equal(rebuildIdleYieldFor(cfg, f.graphEngineOf!('b-pg')), 10);
        assert.equal(rebuildIdleYieldFor(cfg, f.graphEngineOf!('not-registered')), 10, 'an unregistered workspace resolves to the default engine, not sqlite');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

cleanupTmps();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
