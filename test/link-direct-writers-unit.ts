#!/usr/bin/env tsx
/**
 * test/link-direct-writers-unit.ts - link-on-arrival signalling from the direct verbatim-store writers (gap 3).
 *
 *   file watcher        makeFileIngestCallback signals `file:<hash>` once the verbatim row commits, and not when the store throws
 *   store_verbatim      NOT wired, by design: it rejects the `lore:` namespace, so its rows are never node rows
 *   POST /api/verbatim  same: pinned so a future relaxation of the id rule forces a signalling decision
 *
 * Run: npx tsx test/link-direct-writers-unit.ts
 */
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeFileIngestCallback } from '../packages/lore/src/mcp/bootSteps.js';
import { registerVerbatimTools } from '../packages/lore/src/mcp/tools/verbatim.js';
import { tryVerbatimRoutes } from '../packages/lore/src/mcp/http/routes/retention/verbatim.js';
import type { LinkItem, LinkSignaler } from '../packages/lore/src/link/linkTypes.js';
import type { WorkspaceGraph } from '../packages/lore/src/engines/openWorkspaceGraph.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

const WS = 'wsl';
interface Sig extends LinkSignaler { calls: Array<{ ws: string; items: LinkItem[] }> }
function recorder(): Sig {
    const calls: Sig['calls'] = [];
    return { calls, signal: (ws, items) => { calls.push({ ws, items: [...items] }); } };
}
const ids = (s: Sig): string[] => s.calls.flatMap((c) => c.items.map((i) => i.id));

// ── file watcher ──
const graph = { upsertNode: async (n: unknown) => n } as unknown as WorkspaceGraph;
const allow = (dir: string) => ({ workspaceRoot: dir, extraRoots: [dir] });
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

console.log('\nfile watcher\n');
await test('signals file:<hash> after the verbatim row commits', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-dw-'));
    try {
        const f = path.join(tmp, 'a.md');
        fs.writeFileSync(f, 'hello');
        const sig = recorder();
        const stored: string[] = [];
        const vs = { store: async (d: { id: string }) => { stored.push(d.id); } };
        makeFileIngestCallback(graph, WS, vs as never, allow(tmp), sig)(f);
        await settle();
        const hash = crypto.createHash('sha256').update(f).digest('hex').slice(0, 12);
        assert.deepEqual(stored, [`lore:file:${hash}`]);
        assert.deepEqual(ids(sig), [`file:${hash}`]);
        assert.equal(sig.calls[0]!.ws, WS);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
await test('no signal when the store throws', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-dw-'));
    try {
        const f = path.join(tmp, 'b.md');
        fs.writeFileSync(f, 'hello');
        const sig = recorder();
        const vs = { store: async () => { throw new Error('embed down'); } };
        makeFileIngestCallback(graph, WS, vs as never, allow(tmp), sig)(f);
        await settle();
        assert.deepEqual(ids(sig), []);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
await test('no signaler (flag off) and no verbatim store are no-ops', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-dw-'));
    try {
        const f = path.join(tmp, 'c.md');
        fs.writeFileSync(f, 'hello');
        const vs = { store: async () => undefined };
        makeFileIngestCallback(graph, WS, vs as never, allow(tmp), null)(f);
        const sig = recorder();
        makeFileIngestCallback(graph, WS, null, allow(tmp), sig)(f);
        await settle();
        assert.deepEqual(ids(sig), [], 'no verbatim store -> no vector -> nothing to link');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

// ── store_verbatim + REST: deliberately NOT wired ──
// Both doors reject the `lore:` namespace (assertSafeVerbatimId), so they can never write a node's canonical row.
// Their rows are plain documents with no graph node: there is nothing for the node linker to link, so no signal.
function rig(linkService: LinkSignaler) {
    const stored: Array<{ id: string }> = [];
    const verbatim = { async getById() { return null; }, async store(d: { id: string }) { stored.push(d); } };
    const store = {
        loreGraph: { async getNode() { return null; } },
        loreVerbatim: verbatim,
        storageClient: { verbatimStore: (d: { id: string }) => verbatim.store(d), getNode: async () => null },
        linkService,
    };
    const deps = { deploymentMode: 'local', dataplane: null, store, detectedScope: { workspace: WS, ecosystem: '*' } };
    return { deps, stored };
}
type ToolBag = Record<string, (a: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>>;
function tools(deps: unknown): ToolBag {
    const bag: ToolBag = {};
    registerVerbatimTools({ tool: (n: string, ...rest: unknown[]) => { const h = rest[rest.length - 1]; if (typeof h === 'function') bag[n] = h as ToolBag[string]; } } as never, deps as never);
    return bag;
}
function fakeRes(): ServerResponse & { _status: number } {
    return { _status: 0, writeHead(s: number) { (this as { _status: number })._status = s; return this; }, end() { /* */ } } as never;
}
function jsonReq(body: unknown): IncomingMessage {
    const raw = JSON.stringify(body);
    let sent = false;
    return {
        method: 'POST', headers: { 'content-type': 'application/json' },
        on(ev: string, cb: (c?: Buffer) => void) {
            if (ev === 'data' && !sent) { sent = true; cb(Buffer.from(raw, 'utf8')); }
            if (ev === 'end') setImmediate(() => cb());
            return this;
        },
    } as never;
}
const rest = async (deps: unknown, body: Record<string, unknown>) => {
    const res = fakeRes();
    await tryVerbatimRoutes(jsonReq(body), res, '/api/verbatim', deps as never, '/api/verbatim');
    return res._status;
};

console.log('\nstore_verbatim / POST /api/verbatim (documented non-writers)\n');
await test('store_verbatim rejects lore: ids, stores plain ids, and never signals', async () => {
    const sig = recorder(); const r = rig(sig);
    const bad = await tools(r.deps)['store_verbatim']!({ id: 'lore:n1', text: 'x', workspace: WS });
    assert.ok(bad.isError);
    assert.match(bad.content[0]!.text, /reserved for node-derived rows/);
    const ok = await tools(r.deps)['store_verbatim']!({ id: 'doc-1', text: 'x', workspace: WS });
    assert.ok(!ok.isError, ok.content[0]!.text);
    assert.deepEqual(r.stored.map((d) => d.id), ['doc-1']);
    assert.deepEqual(ids(sig), []);
});
await test('POST /api/verbatim rejects lore: ids (400), stores plain ids (200), and never signals', async () => {
    const sig = recorder(); const r = rig(sig);
    assert.equal(await rest(r.deps, { id: 'lore:n9', text: 'x', workspace: WS }), 400);
    assert.equal(await rest(r.deps, { id: 'plain', text: 'x', workspace: WS }), 200);
    assert.deepEqual(r.stored.map((d) => d.id), ['plain']);
    assert.deepEqual(ids(sig), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
