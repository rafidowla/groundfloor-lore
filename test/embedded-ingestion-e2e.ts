#!/usr/bin/env tsx
/**
 * test/embedded-ingestion-e2e.ts - the ingestion pipeline through the public `createLore({ ingestion })` option and
 * the `lore.ingestion` handle (no LORE_INGEST_* env), real SQLite stores, deterministic embedder, temp dirs only.
 *
 *   off by default      no option + no env => lore.ingestion === null, no ingestion.sqlite, nothing started
 *   option vs env       false beats LORE_INGEST_ENABLED=1; env alone still enables; LORE_INGEST_CALLBACK_* is ignored
 *   end to end          enqueue text + markdown, runDue, document_chunk memories carry provenance, job succeeded,
 *                       a duplicate enqueue is created:false, getJob is workspace scoped
 *   policy              a hosted processor is refused for a local-only workspace (PolicyViolationError, nothing recorded)
 *   listener            never opens without an explicit `callback`; opens (and closes on dispose) only when asked
 *   scheduler           autoRun:false never ticks; autoRun true processes by itself; bad values throw RangeError
 *   workspaces          a workspace created after boot is eligible; an `workspaces` allowlist rejects the others
 *   process safety      no process-wide listeners, env byte-identical, dispose stops everything and is idempotent
 *
 *   LORE_HOME=<scratch> LORE_MODEL_SERVER=0 npx tsx test/embedded-ingestion-e2e.ts
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

for (const k of Object.keys(process.env)) if (k.startsWith('LORE_INGEST_') || k.startsWith('LORE_LINK_')) delete process.env[k];

class DetEmbedProvider implements EmbeddingProvider {
    readonly dimension = 16;
    readonly modelId = 'embedded-ingest-det';
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
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'lore-emb-ingest-'));
function findFile(dir: string, name: string): string | null {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; } else if (e.name === name) return p;
    }
    return null;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function open(dataDir: string, extra: Record<string, unknown> = {}): Promise<any> {
    const { createLore } = await import('../packages/lore/src/index.js');
    return createLore({ dataDir, deploymentMode: 'embedded', embeddingProvider: new DetEmbedProvider(), modelServer: false, ...extra } as never);
}
const TXT = Buffer.from('The quarterly lease renewal for the downtown office building was approved by the board on Tuesday.');
const MD = Buffer.from('# Renewal notes\n\nThe board approved the downtown lease.\n\n## Terms\n\nFive years, with a break clause at year three.\n');
const listenerCount = (): number => ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection', 'beforeExit', 'exit']
    .reduce((n, e) => n + process.listenerCount(e as never), 0);
async function chunks(lore: any, ids: string[], ws = 'default'): Promise<any[]> {
    const out: any[] = [];
    for (const id of ids) out.push(await lore.store.storageClient.getNode(id, ws));
    return out;
}
const portOpen = async (port: number): Promise<boolean> => {
    const net = await import('node:net');
    return new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
};

console.log('\nembedded ingestion e2e\n');

await test('off by default: ingestion is null, no store file, no extra process listeners, clean dispose', async () => {
    const dir = tmp(); const l0 = listenerCount();
    const lore = await open(dir);
    try {
        assert.equal(lore.ingestion, null);
        await lore.nodeUpsert({ id: 'x', workspace: 'default', ecosystem: '*', nodeData: { id: 'x', type: 'note', label: 'x', content: 'x', project: 'default', ecosystem: '*' } });
        assert.equal(findFile(dir, 'ingestion.sqlite'), null);
        assert.equal(listenerCount(), l0);
    } finally { await lore.dispose(); }
    await lore.dispose();
});

await test('text + markdown end to end: memories with provenance, job succeeded, duplicate created:false', async () => {
    const before = JSON.stringify(Object.entries(process.env).sort());
    const dir = tmp(); const l0 = listenerCount();
    const lore = await open(dir, { ingestion: { scheduler: { autoRun: false } } });
    try {
        assert.ok(lore.ingestion, 'handle present');
        assert.equal(listenerCount(), l0, 'no process-wide handlers added');
        const co = await lore.ingestion.coordinatorFor('default');
        const a = await co.enqueueFile({ workspace: 'default', fileName: 'lease.txt', mimeType: 'text/plain', bytes: TXT });
        const b = await co.enqueueFile({ workspace: 'default', fileName: 'notes.md', mimeType: 'text/markdown', bytes: MD });
        assert.equal(a.created, true); assert.equal(b.created, true);
        assert.equal((await lore.ingestion.getJob('default', a.job.jobId))?.state, 'queued');
        const sum = await lore.ingestion.runDue('default', 10);
        assert.equal(sum.claimed, 2, JSON.stringify(sum)); assert.equal(sum.succeeded, 2, JSON.stringify(sum));
        for (const [r, name] of [[a, 'lease.txt'], [b, 'notes.md']] as const) {
            const job = await lore.ingestion.getJob('default', r.job.jobId);
            assert.equal(job?.state, 'succeeded', `${name}: ${job?.lastError}`);
            assert.ok(job?.resultsWrittenAt, 'results handed to the memory writer');
        }
        await lore.awaitEmbeds?.();
        const { memoryNodeId } = await import('../packages/lore/src/ingestion/memoryWriter.js');
        const [n1] = await chunks(lore, [memoryNodeId(a.job.jobId, 0)]);
        assert.ok(n1, 'document_chunk memory exists');
        assert.equal(n1.type ?? n1.nodeData?.type, 'document_chunk');
        const meta = typeof (n1.metadata ?? n1.nodeData?.metadata) === 'string' ? JSON.parse(n1.metadata ?? n1.nodeData.metadata) : (n1.metadata ?? n1.nodeData?.metadata);
        assert.equal(meta.ingestion.sourceFileName, 'lease.txt');
        assert.equal(meta.ingestion.jobId, a.job.jobId);
        assert.equal(meta.ingestion.sourceId, a.source.sourceId);
        assert.ok(meta.ingestion.processor.id, 'processor recorded');
        const [m1] = await chunks(lore, [memoryNodeId(b.job.jobId, 0)]);
        assert.ok(m1, 'markdown memory exists');
        assert.ok(findFile(dir, 'ingestion.sqlite'), 'the host opened its store under the instance data dir');

        const dup = await co.enqueueFile({ workspace: 'default', fileName: 'lease.txt', mimeType: 'text/plain', bytes: TXT });
        assert.equal(dup.created, false); assert.equal(dup.source.sourceId, a.source.sourceId);
        assert.equal((await lore.ingestion.runDue('default')).claimed, 0, 'duplicate queued no work');
        assert.equal(await lore.ingestion.getJob('other-ws', a.job.jobId), undefined, 'getJob is workspace scoped');
        assert.equal(await lore.ingestion.getJob('default', 'nope'), undefined);
    } finally { await lore.dispose(); }
    assert.equal(listenerCount(), l0, 'no handlers left behind');
    assert.equal(JSON.stringify(Object.entries(process.env).sort()), before, 'env byte-identical');
});

await test('hosted processors are refused for a local-only workspace and nothing is recorded', async () => {
    const cb = { port: 0, publicBaseUrl: 'https://lore.example.test', masterSecret: 'm'.repeat(40) };
    // Hosted structurer registered (explicit callback + a hosted workspace), but `default` stays local-only.
    const lore = await open(tmp(), { ingestion: { scheduler: { autoRun: false }, hostedStructuring: { url: 'https://structurer.invalid/v1', token: 'tok' }, hostedWorkspaces: ['hosted-ws'], callback: cb } });
    try {
        const { PolicyViolationError } = await import('../packages/lore/src/ingestion/policy.js');
        const { HOSTED_STRUCTURER_ID } = await import('../packages/lore/src/ingestion/ingestionHost.js');
        assert.equal(lore.ingestion.status().hostedProcessor, true, 'hosted structurer is registered');
        const co = await lore.ingestion.coordinatorFor('default');
        await assert.rejects(
            co.enqueueFile({ workspace: 'default', fileName: 'p.txt', mimeType: 'text/plain', bytes: TXT, structure: { processorId: HOSTED_STRUCTURER_ID, profile: 'invoice' } }),
            (e: unknown) => e instanceof PolicyViolationError,
        );
        assert.equal((await lore.ingestion.runDue('default')).claimed, 0, 'refused request left no job');
    } finally { await lore.dispose(); }
    // Without any callback config the hosted processor is never even registered: also refused, nothing recorded.
    const bare = await open(tmp(), { ingestion: { scheduler: { autoRun: false }, hostedStructuring: { url: 'https://structurer.invalid/v1', token: 'tok' } } });
    try {
        assert.equal(bare.ingestion.status().hostedProcessor, false);
        assert.equal(bare.ingestion.status().listener.state === 'listening', false);
        const co = await bare.ingestion.coordinatorFor('default');
        await assert.rejects(co.enqueueFile({ workspace: 'default', fileName: 'p.txt', mimeType: 'text/plain', bytes: TXT, structure: { processorId: 'hosted-structuring-v2' } }));
        assert.equal((await bare.ingestion.runDue('default')).claimed, 0);
    } finally { await bare.dispose(); }
});

await test('callback listener: never opens from env or by default; opens only when asked and a hosted workspace exists; closes on dispose', async () => {
    process.env.LORE_INGEST_CALLBACK_PORT = '0';
    process.env.LORE_INGEST_CALLBACK_SECRET = 'x'.repeat(40);
    process.env.LORE_INGEST_CALLBACK_PUBLIC_URL = 'https://lore.example.test';
    try {
        const envOnly = await open(tmp(), { ingestion: { scheduler: { autoRun: false }, hostedStructuring: { url: 'https://structurer.invalid/v1' }, hostedWorkspaces: ['default'] } });
        try { assert.equal(envOnly.ingestion.status().listener.state === 'listening', false, 'callback env alone never opens a socket'); } finally { await envOnly.dispose(); }
    } finally { for (const k of ['PORT', 'SECRET', 'PUBLIC_URL']) delete process.env[`LORE_INGEST_CALLBACK_${k}`]; }

    const local = await open(tmp(), { ingestion: { scheduler: { autoRun: false }, callback: { port: 0, publicBaseUrl: 'https://lore.example.test', masterSecret: 'm'.repeat(40) } } });
    try { assert.notEqual(local.ingestion.status().listener.state, 'listening', 'explicit callback but no hosted structurer/workspace: still no socket'); } finally { await local.dispose(); }

    const on = await open(tmp(), { ingestion: {
        scheduler: { autoRun: false }, hostedStructuring: { url: 'https://structurer.invalid/v1' }, hostedWorkspaces: ['default'],
        callback: { port: 0, publicBaseUrl: 'https://lore.example.test', masterSecret: 'm'.repeat(40) },
    } });
    let port = 0;
    try {
        const st = on.ingestion.status().listener;
        assert.equal(st.state, 'listening', JSON.stringify(st));
        port = st.port as number; assert.ok(port > 0);
        assert.equal(await portOpen(port), true);
    } finally { await on.dispose(); }
    assert.equal(await portOpen(port), false, 'listener closed by dispose');
});

await test('scheduler: autoRun:false never ticks; autoRun processes in the background; bad values throw', async () => {
    const manual = await open(tmp(), { ingestion: { scheduler: { autoRun: false, runIntervalMs: 1000 } } });
    try {
        const co = await manual.ingestion.coordinatorFor('default');
        const r = await co.enqueueFile({ workspace: 'default', fileName: 'm.txt', mimeType: 'text/plain', bytes: TXT });
        await sleep(1600);
        assert.equal((await manual.ingestion.getJob('default', r.job.jobId))?.state, 'queued', 'no background tick');
    } finally { await manual.dispose(); }

    const auto = await open(tmp(), { ingestion: { scheduler: { runIntervalMs: 1000 } } });
    try {
        const co = await auto.ingestion.coordinatorFor('default');
        const r = await co.enqueueFile({ workspace: 'default', fileName: 'a.txt', mimeType: 'text/plain', bytes: TXT });
        let state = '';
        for (let i = 0; i < 40 && state !== 'succeeded'; i++) { await sleep(250); state = (await auto.ingestion.getJob('default', r.job.jobId))?.state ?? ''; }
        assert.equal(state, 'succeeded', 'TickLoop processed the job');
    } finally { await auto.dispose(); }

    for (const bad of [{ scheduler: { runIntervalMs: 1 } }, { scheduler: { batch: 0 } }, { scheduler: { nope: 5 } }, { scheduler: { autoRun: 'yes' } },
        { workspaces: [''] }, { callback: { port: 70000, publicBaseUrl: 'x', masterSecret: 'y' } }, { localLlm: { url: '', model: 'm' } }, { enqueueMaxBytes: 10 }]) {
        await assert.rejects(() => open(tmp(), { ingestion: bad }), RangeError, JSON.stringify(bad));
    }
});

await test('option vs env: false beats LORE_INGEST_ENABLED=1; env alone enables; options beat env tunables', async () => {
    process.env.LORE_INGEST_ENABLED = '1';
    try {
        const off = await open(tmp(), { ingestion: false });
        try { assert.equal(off.ingestion, null); } finally { await off.dispose(); }
        const off2 = await open(tmp(), { ingestion: { enabled: false } });
        try { assert.equal(off2.ingestion, null); } finally { await off2.dispose(); }
        const env = await open(tmp());
        try { assert.ok(env.ingestion, 'no option => env flag decides'); } finally { await env.dispose(); }
        process.env.LORE_INGEST_RUN_INTERVAL_MS = '999999';
        const o = await open(tmp(), { ingestion: { scheduler: { runIntervalMs: 1000 } } });
        try {
            const co = await o.ingestion.coordinatorFor('default');
            const r = await co.enqueueFile({ workspace: 'default', fileName: 'e.txt', mimeType: 'text/plain', bytes: TXT });
            let state = '';
            for (let i = 0; i < 40 && state !== 'succeeded'; i++) { await sleep(250); state = (await o.ingestion.getJob('default', r.job.jobId))?.state ?? ''; }
            assert.equal(state, 'succeeded', 'option interval 1000ms beat env 999999ms');
        } finally { await o.dispose(); }
    } finally { delete process.env.LORE_INGEST_ENABLED; delete process.env.LORE_INGEST_RUN_INTERVAL_MS; }
});

await test('workspaces: one created after boot is eligible; an allowlist rejects the others', async () => {
    const lore = await open(tmp(), { ingestion: { scheduler: { autoRun: false } } });
    try {
        const { createWorkspace } = await import('../packages/lore/src/config/workspaces.js');
        createWorkspace('late-ws', {}, lore.dataHome); // an app creates workspaces after boot
        const co = await lore.ingestion.coordinatorFor('late-ws');
        const r = await co.enqueueFile({ workspace: 'late-ws', fileName: 'l.txt', mimeType: 'text/plain', bytes: TXT });
        assert.equal((await lore.ingestion.runDue('late-ws')).succeeded, 1);
        assert.equal((await lore.ingestion.getJob('late-ws', r.job.jobId))?.state, 'succeeded');
        assert.ok(lore.ingestion.status().workspaces.includes('late-ws'));
    } finally { await lore.dispose(); }
    const fenced = await open(tmp(), { ingestion: { scheduler: { autoRun: false }, workspaces: ['default'] } });
    try {
        await fenced.ingestion.coordinatorFor('default');
        await assert.rejects(() => fenced.ingestion.coordinatorFor('not-allowed'));
    } finally { await fenced.dispose(); }
});

await test('dispose: stops the scheduler and stores, is idempotent, and the process can exit with no handles', async () => {
    const lore = await open(tmp(), { ingestion: { scheduler: { runIntervalMs: 1000 } } });
    const co = await lore.ingestion.coordinatorFor('default');
    await co.enqueueFile({ workspace: 'default', fileName: 'd.txt', mimeType: 'text/plain', bytes: TXT });
    await lore.dispose(); await lore.dispose();
    const handles = (process as any)._getActiveHandles().filter((h: any) => h?.constructor?.name === 'Server' || h?.constructor?.name === 'Socket' && !h.destroyed && h.fd !== 1 && h.fd !== 2 && h.fd !== 0);
    assert.equal(handles.length, 0, `leaked handles: ${handles.map((h: any) => h.constructor.name).join(',')}`);
});

await test('a process using ingestion + link-on-arrival exits by itself after dispose (no leaked timers, sockets or workers)', async () => {
    const { spawn } = await import('node:child_process');
    const home = tmp();
    const script = path.join(home, 'child.mts');
    const idx = path.resolve('packages/lore/src/index.ts');
    fs.writeFileSync(script, `
import { createLore } from ${JSON.stringify(idx)};
const lore = await createLore({ dataDir: ${JSON.stringify(path.join(home, 'data'))}, deploymentMode: 'embedded', modelServer: false,
  embeddingProvider: { dimension: 8, modelId: 'x', dtype: 'fp32', async initialize() {}, async embed() { return new Array(8).fill(0.35); }, async embedQuery() { return new Array(8).fill(0.35); },
    async embedDocument() { return new Array(8).fill(0.35); }, async embedDocumentBatch(t) { return t.map(() => new Array(8).fill(0.35)); } },
  linkOnArrival: true, ingestion: { scheduler: { runIntervalMs: 1000 } } });
const co = await lore.ingestion.coordinatorFor('default');
await co.enqueueFile({ workspace: 'default', fileName: 'c.txt', mimeType: 'text/plain', bytes: Buffer.from('child process text') });
await lore.ingestion.runDue('default');
await lore.dispose();
console.log('CHILD_DISPOSED');
`);
    const env = { ...process.env, LORE_HOME: path.join(home, 'home'), LORE_MODEL_SERVER: '0' };
    const child = spawn(process.execPath, ['--import', 'tsx', script], { env, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    const code = await new Promise<number | null>((res) => {
        const t = setTimeout(() => { child.kill('SIGKILL'); res(-999); }, 60_000);
        child.on('exit', (c) => { clearTimeout(t); res(c); });
    });
    assert.ok(out.includes('CHILD_DISPOSED'), out.slice(-800));
    assert.equal(code, 0, `child must exit on its own (code ${code}; -999 = hung after dispose)\n${out.slice(-800)}`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
