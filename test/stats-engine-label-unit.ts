#!/usr/bin/env tsx
/**
 * stats-engine-label-unit.ts — Lore 3.35.0 (k): the `stats` / `lore_status` MCP tools
 * must report the engine a workspace ACTUALLY uses. A SQLite-backed workspace used to be
 * labelled 'legacy graph engine + lancedb (local)'.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-engine-label-'));
process.env['LORE_HOME'] = HOME;

const { createWorkspace, setWorkspaceGraphEngine, setWorkspaceVectorEngine } = await import('../packages/lore/src/config/workspaces.js');
const { LocalGraphRegistry } = await import('../packages/lore/src/engines/localGraphRegistry.js');
const { engineReport } = await import('../packages/lore/src/mcp/tools/engineLabels.js');

let passed = 0, failed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ok   ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n       ${(e as Error).message}`); failed++; }
};

const mk = (name: string, graph: 'surreal' | 'sqlite', vector: 'lance' | 'sqlite') => {
    createWorkspace(name, undefined, HOME);
    setWorkspaceGraphEngine(name, graph, HOME);
    setWorkspaceVectorEngine(name, vector, HOME);
};
mk('all-sqlite', 'sqlite', 'sqlite');
mk('surreal-lance', 'surreal', 'lance');
mk('sqlite-lance', 'sqlite', 'lance');
mk('surreal-sqlite', 'surreal', 'sqlite');
const reg = new LocalGraphRegistry({ home: HOME });

console.log('stats engine label (3.35.0 k)');
test('SQLite graph + SQLite verbatim -> "sqlite (local)", never the legacy label', () => {
    const r = engineReport(reg, 'all-sqlite');
    assert.equal(r.engine, 'sqlite (local)');
    assert.equal(r.verbatimEngine, 'sqlite');
    assert.ok(!/legacy|lancedb/i.test(r.engine));
});
test('Surreal + Lance keeps its historical label', () => {
    assert.deepEqual(engineReport(reg, 'surreal-lance'), { engine: 'surrealdb (local)', verbatimEngine: 'lancedb' });
});
test('mixed homes name both substrates', () => {
    assert.deepEqual(engineReport(reg, 'sqlite-lance'), { engine: 'sqlite + lancedb (local)', verbatimEngine: 'lancedb' });
    assert.deepEqual(engineReport(reg, 'surreal-sqlite'), { engine: 'surrealdb + sqlite (local)', verbatimEngine: 'sqlite' });
});
test('no registry (cloud) -> dataplane', () => {
    assert.deepEqual(engineReport(undefined, 'x'), { engine: 'dataplane (cloud)' });
});

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
