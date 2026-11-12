/**
 * purgeRaceHarness.ts — shared fixture for the "purge racing a write" unit tests
 * (test/purge-version-lock-race-unit.ts, test/purge-stale-read-race-unit.ts).
 *
 * Real SurrealGraph + real verbatim store + real VersionStore (recordVersion slowed by 40 ms so an
 * unlocked version write would let a purge slip in), and the embedded purge
 * (`deleteNodeEverywhere({ purge: true })`) wired to purge versions.sqlite the way the daemon does.
 *
 * `racingGraph` wraps the real graph and starts the purge from inside one of its calls:
 *   - 'upsertNode' / 'deleteNode': right AFTER that write (the purge then queues on the node lock if
 *     the writer still holds it).
 *   - 'getNode' (nth call for the id): right AFTER the read. When the node lock is held at that
 *     moment (the read is under the lock) the purge can only queue, so the read returns after a short
 *     pause. When it is NOT held (a read outside the lock, the bug) the purge is awaited to the end
 *     before the read returns, so the writer deterministically acts on a stale read.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SurrealGraph } from '../../packages/lore/src/engines/surrealGraph.js';
import { VersionStore } from '../../packages/lore/src/outbox/versionStore.js';
import { makeVerbatimStore } from './testVerbatimStore.js';
import { deleteNodeEverywhere } from '../../packages/lore/src/core/nodeDeleteService.js';
import { nodeWriteLockSize } from '../../packages/lore/src/core/nodeWriteLock.js';
import type { EmbeddingProvider } from '../../packages/lore/src/providers/types.js';

export class ConstEmbed implements EmbeddingProvider {
    get modelId() { return 'purge-lock-race-const'; }
    get dimension() { return 8; }
    async initialize() { /* no-op */ }
    private vec() { return new Array(8).fill(0.1); }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

export const WS = 'default'; // auto-created in the per-pid test LORE_HOME by loadWorkspaces()
const tally = { passed: 0, failed: 0 };
export async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); tally.passed++; console.log(`  ok  ${name}`); }
    catch (e) { tally.failed++; console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? String(e)}`); }
}
export function finish(): never {
    console.log(`\n${tally.passed} passed, ${tally.failed} failed`);
    process.exit(tally.failed === 0 ? 0 : 1);
}
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface Stack { graph: SurrealGraph; store: ReturnType<typeof makeVerbatimStore>; versions: VersionStore }

export async function withStack(fn: (s: Stack) => Promise<void>): Promise<void> {
    const dirs = ['g', 'v', 'ver'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), `lore-plr-${p}-`)));
    const graph = new SurrealGraph(dirs[0]!);
    const store = makeVerbatimStore(dirs[1]!, new ConstEmbed());
    const versions = VersionStore.open(dirs[2]!);
    await graph.initialize(); await store.initialize();
    // Slow, otherwise-unchanged version recording: an unlocked write would let a purge slip in first.
    const realRecord = versions.recordVersion.bind(versions);
    (versions as unknown as { recordVersion: unknown }).recordVersion = async (r: Parameters<typeof realRecord>[0]) => { await sleep(40); realRecord(r); };
    try { await fn({ graph, store, versions }); }
    finally { await store.close().catch(() => undefined); await graph.close().catch(() => undefined); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
}

export const startPurge = (s: Stack, id: string, ws = WS): Promise<unknown> => deleteNodeEverywhere({
    id, workspace: ws, isActive: false, graph: s.graph, resolveVerbatim: async () => s.store,
    verbatimDelete: async () => undefined, getWal: () => ({ append: () => undefined }) as never,
    initiator: 'test:purge', reason: 'test', logPrefix: '[test]', purge: true,
    purgeVersions: (ids, upTo) => { s.versions.purgeNodes(ids, ws, upTo); },
});

export type RaceOn = 'upsertNode' | 'deleteNode' | 'getNode';

/** The real graph, with the purge of `id` started from inside its first `on` call (see the file header). */
export function racingGraph(s: Stack, id: string, on: RaceOn, opts: { nth?: number; ws?: string } = {}): { graph: never; purge: () => Promise<unknown> } {
    let purgeP: Promise<unknown> | null = null;
    let reads = 0;
    const real = s.graph as unknown as Record<string | symbol, unknown>;
    const g = new Proxy(real, {
        get(target, prop) {
            if (prop === 'getNode') return async (x: string) => {
                const r = await s.graph.getNode(x);
                if (on === 'getNode' && x === id && !purgeP && ++reads === (opts.nth ?? 1)) {
                    const lockedRead = nodeWriteLockSize() > 0;
                    purgeP = startPurge(s, id, opts.ws);
                    if (lockedRead) await sleep(30); else await purgeP;
                }
                return r;
            };
            if (prop === 'upsertNode' || prop === 'deleteNode') return async (x: never) => {
                const r = await (prop === 'upsertNode' ? s.graph.upsertNode(x) : s.graph.deleteNode(x));
                if (on === prop && !purgeP) { purgeP = startPurge(s, id, opts.ws); await sleep(0); }
                return r;
            };
            const v = Reflect.get(target, prop, target);
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
    });
    return { graph: g as never, purge: async () => { assert.ok(purgeP, 'purge never started'); return purgeP; } };
}

export const seed = (s: Stack, id: string, status = 'active', extra: Record<string, unknown> = {}): Promise<unknown> => s.graph.upsertNode({
    id, type: 'note', label: id, content: `secret-${id}`, tags: ['t'], project: 'p', ecosystem: '*', metadata: '{}', status, ...extra,
} as never);
export const noVersions = (s: Stack, id: string, ws = WS): void => assert.deepEqual(s.versions.getVersions(id, ws, 100), [], `${id}: no version row may survive the purge`);
export async function assertErased(s: Stack, id: string): Promise<void> {
    assert.equal(await s.graph.getNode(id), null, `${id}: the purged node must not come back`);
    noVersions(s, id);
}

export function fakeReq(body: string, method = 'POST'): IncomingMessage {
    let consumed = false;
    return { method, headers: {}, on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && !consumed) { consumed = true; cb(Buffer.from(body)); } if (ev === 'end') setImmediate(() => cb()); return this; } } as unknown as IncomingMessage;
}
export const fakeRes = (): ServerResponse & { _status: number; _body: string } => ({ _status: 0, _body: '', writeHead(s: number) { (this as { _status: number })._status = s; return this; }, setHeader() { return this; }, end(b?: string) { (this as { _body: string })._body = b ?? ''; } }) as never;

/** Captures `server.tool(...)` registrations so a test can call a real MCP handler. */
export function toolCapture(): { server: never; call: (name: string, args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> } {
    const tools = new Map<string, (a: Record<string, unknown>) => Promise<unknown>>();
    const server = { tool: (name: string, ...rest: unknown[]) => { tools.set(name, rest[rest.length - 1] as never); } };
    return {
        server: server as never,
        call: async (name, args) => {
            const h = tools.get(name);
            assert.ok(h, `tool ${name} not registered`);
            return h(args) as never;
        },
    };
}
