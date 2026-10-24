#!/usr/bin/env tsx
/**
 * test/link-on-arrival-http-bulk-unit.ts - the HTTP bulk lane (POST /api/nodes/bulk)
 * signals the link queue once a node's vector is committed, for both embed modes.
 * Real engines through createLore (flag on), the route driven directly.
 *
 *   LORE_HOME=<scratch> LORE_MODEL_SERVER=0 npx tsx test/link-on-arrival-http-bulk-unit.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';
import { tryBulkWriteRoutes } from '../packages/lore/src/mcp/http/routes/bulkWrite.js';

process.env.LORE_LINK_ON_ARRIVAL = '1';
process.env.LORE_LINK_MIN_SIM = '0.9';
process.env.LORE_LINK_QUIET_MS = '20';
process.env.LORE_LINK_YIELD_MS = '1';

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'link-http-det';
    readonly dtype = 'fp32';
    async initialize(): Promise<void> { /* no-op */ }
    private vec(text: string): number[] {
        const v = new Array(this.dimension).fill(0);
        for (let i = 0; i < text.length; i++) v[i % this.dimension] += text.charCodeAt(i) / 128;
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
        return v.map((x) => x / norm);
    }
    async embed(t: string): Promise<number[]> { return this.vec(t); }
    async embedQuery(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocument(t: string): Promise<number[]> { return this.vec(t); }
    async embedDocumentBatch(ts: string[]): Promise<number[][]> { return ts.map((t) => this.vec(t)); }
}

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}\n    ${(e as Error).stack ?? (e as Error).message}`); failed++; }
}

function req(body: string): IncomingMessage {
    let consumed = false;
    return {
        method: 'POST',
        on(event: string, cb: (chunk?: Buffer | Error) => void) {
            if (event === 'data' && !consumed) { consumed = true; cb(Buffer.from(body, 'utf8')); }
            if (event === 'end') setImmediate(() => cb());
            return this;
        },
    } as unknown as IncomingMessage;
}
function res(): ServerResponse & { _status: number; _body: string } {
    return {
        _status: 0, _body: '',
        writeHead(s: number) { (this as { _status: number })._status = s; return this; },
        setHeader() { return this; },
        end(b?: string) { (this as { _body: string })._body = b ?? ''; },
    } as unknown as ServerResponse & { _status: number; _body: string };
}

const TEXT = (n: number) => `the quarterly lease renewal for the downtown office building was approved by the board variant ${n}`;

async function post(lore: any, embed: 'inline' | 'queued'): Promise<void> {
    const registry = lore._daemon.getGraphRegistry();
    const workspace: string = registry.activeName();
    const deps: any = {
        deploymentMode: 'local', dataplane: null, store: lore.store,
        auditLog: { log: () => undefined }, graphRegistry: registry,
        workspaceVerbatimResolver: lore._daemon.getVerbatimResolver(),
        outboxStore: lore._daemon.outboxWiring?.store, outboxLagCache: lore._daemon.outboxWiring?.lagCache,
    };
    const nodes = [1, 2, 3].map((n) => ({ id: `h${embed}${n}`, type: 'note', label: `h${n}`, content: TEXT(n) }));
    const r = res();
    await tryBulkWriteRoutes(req(JSON.stringify({ workspace, nodes, embed })), r, '/api/nodes/bulk', '/api/nodes/bulk', deps);
    assert.equal(r._status, 200, `status ${r._status} ${r._body.slice(0, 300)}`);
    assert.equal(JSON.parse(r._body).succeeded, 3);
}

console.log('\nlink-on-arrival HTTP bulk lane\n');

for (const embed of ['inline', 'queued'] as const) {
    await test(`POST /api/nodes/bulk embed:${embed} produces links`, async () => {
        const { createLore } = await import('../packages/lore/src/index.js');
        const lore: any = await createLore({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lore-link-http-')), deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider() });
        try {
            await post(lore, embed);
            await lore.awaitEmbeds?.();
            if (embed === 'queued') await new Promise((r) => setTimeout(r, 500));
            await lore.store.linkService.flush();
            const edges = await lore.store.loreGraph.queryEdges({ limit: 1000, offset: 0, relation: 'semantic_neighbor' });
            assert.ok(edges.length >= 2, `expected links, got ${edges.length} (stats ${JSON.stringify(lore.store.linkService.stats())})`);
        } finally { await lore.dispose(); }
    });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
