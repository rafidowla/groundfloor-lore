#!/usr/bin/env tsx
/**
 * r4-storage-scope-unit.ts — R4 audit #7. GET /api/storage enumerated EVERY
 * workspace's name + absolute disk path + usage to any scoped token. Fixed by
 * filtering the workspaces[] array to entries the principal may read.
 *
 * Run: npm run test:unit:r4-storage-scope
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { runWithPrincipal, type Principal } from '../packages/lore/src/auth/principal.js';

// Set LORE_HOME BEFORE importing the route (loreHome reads the env).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-storage-'));
process.env.LORE_HOME = HOME;
for (const ws of ['alpha', 'beta']) {
    fs.mkdirSync(path.join(HOME, 'workspaces', ws, '.lore'), { recursive: true });
}
fs.writeFileSync(path.join(HOME, 'workspaces.json'), JSON.stringify({
    workspaces: [
        { name: 'alpha', path: path.join(HOME, 'workspaces', 'alpha') },
        { name: 'beta', path: path.join(HOME, 'workspaces', 'beta') },
    ],
}));

const { handleStorage } = await import('../packages/lore/src/mcp/http/routes/diagnostic/storage.js');

let passed = 0, failed = 0;
function test(name: string, fn: () => void): void {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); failed++; }
}
function res(): ServerResponse & { _status: number; _body: string } {
    const r = { _status: 0, _body: '', writeHead(s: number) { (this as { _status: number })._status = s; return this; }, end(b?: string) { (this as { _body: string })._body = b ?? ''; } };
    return r as unknown as ServerResponse & { _status: number; _body: string };
}
const principal = (ws: string, cross = false): Principal => ({ kind: 'app', workspace: ws, scopes: cross ? ['read', 'cross-workspace-read'] : ['read'], label: 't', allowedWorkspaces: [ws] });
const names = (r: { _body: string }) => (JSON.parse(r._body).workspaces as Array<{ name: string }>).map((w) => w.name);

console.log('R4 #7 — /api/storage filters the workspace enumeration by read scope');

try {
    test('alpha-scoped token sees ONLY alpha (beta name + disk path filtered out)', () => {
        const r = res();
        runWithPrincipal(principal('alpha'), () => handleStorage(r));
        const ns = names(r);
        assert.ok(ns.includes('alpha'), 'own workspace present');
        assert.ok(!ns.includes('beta'), `foreign workspace must be filtered; got ${JSON.stringify(ns)}`);
    });
    test('cross-workspace-read token sees ALL workspaces', () => {
        const r = res();
        runWithPrincipal(principal('alpha', true), () => handleStorage(r));
        const ns = names(r);
        assert.ok(ns.includes('alpha') && ns.includes('beta'), `admin sees all; got ${JSON.stringify(ns)}`);
    });
    test('null principal (legacy/local) sees ALL workspaces', () => {
        const r = res();
        handleStorage(r);
        const ns = names(r);
        assert.ok(ns.includes('alpha') && ns.includes('beta'), `legacy bypass sees all; got ${JSON.stringify(ns)}`);
    });
} finally {
    fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
