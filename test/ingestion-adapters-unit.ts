#!/usr/bin/env tsx
/**
 * test/ingestion-adapters-unit.ts — ingestion coordinator slice 1: processor adapters.
 * Hosted/OpenAI-compatible adapters are exercised ONLY against http servers started
 * in-process on 127.0.0.1. Nothing here touches a real processor or any fixed port.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    AiApiExtractProcessor, StructuringV2Processor, LocalStructureProcessor, LocalExtractProcessor, ProcessorError, EndpointNotAllowedError,
    makeAllowlist, CONTRACT_A_VERSION, CONTRACT_B_VERSION, type StructureRequest, type ExtractRequest,
} from '../packages/lore/src/ingestion/index.js';
import { parseExtractCallback, parseStructureCallback } from '../packages/lore/src/ingestion/processors/callbackParse.js';
import { isLoopbackHost } from '../packages/lore/src/ingestion/processors/localStructurer.js';
import { splitPages, buildStructuringText } from '../packages/lore/src/ingestion/pages.js';

let passed = 0; let failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void> | void): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ok  ${name}`); passed++; }
        catch (err) { console.error(`  FAIL ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
interface Mock { origin: string; seen: Seen[]; close(): Promise<void> }
type Handler = (req: Seen, res: http.ServerResponse) => void;
async function mock(handler: Handler): Promise<Mock> {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => { const s = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }; seen.push(s); handler(s, res); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    return { origin: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}
const json = (res: http.ServerResponse, status: number, obj: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const procInfo = { id: 'p', kind: 'extract' as const, locality: 'hosted' as const, version: '1' };

const exReq = (o: Partial<ExtractRequest> = {}): ExtractRequest => ({
    contractVersion: CONTRACT_A_VERSION, jobId: 'job_abc', workspace: 'w', sourceId: 'src_1', fileName: 'Report 2026.pdf', mimeType: 'application/pdf',
    fileUrl: 'https://files.example.invalid/signed?x=1', callbackUrl: 'https://lore.example.invalid/api/ingest/callback/job_abc', callbackBearer: 'tok-for-job', ...o,
});
const stReq = (o: Partial<StructureRequest> = {}): StructureRequest => ({
    contractVersion: CONTRACT_B_VERSION, jobId: 'job_s1', workspace: 'w', sourceId: 'src_1', text: 'Page_Number: 1\nhello', itemPath: 'rows', itemKey: ['id'],
    callbackUrl: 'https://lore.example.invalid/api/ingest/callback/job_s1', callbackBearer: 'tok', ...o,
});

// ── hosted ai-api extractor ───────────────────────────────────────────────
test('hosted extractor: posts the ai-api payload, returns accepted with the remote id', async () => {
    const m = await mock((_r, res) => json(res, 202, { requestID: 'remote-1' }));
    try {
        const p = new AiApiExtractProcessor({ id: 'ai-api-extract', endpoint: m.origin + '/extract', serviceToken: 'svc-secret', engineVersion: 'v1', http: { allowlist: makeAllowlist([m.origin]) } });
        const out = await p.extract(exReq());
        assert.deepEqual(out, { status: 'accepted', remoteRequestId: 'remote-1' });
        const s = m.seen[0]!; const b = JSON.parse(s.body);
        assert.equal(s.method, 'POST'); assert.equal(s.url, '/extract'); assert.equal(s.headers.authorization, 'Bearer svc-secret');
        assert.equal(b.request_id, 'job_abc'); assert.equal(b.callback_url, exReq().callbackUrl); assert.equal(b.bearer_token, 'tok-for-job');
        assert.equal(b.file_path, exReq().fileUrl); assert.equal(b.file_extension_lower, 'pdf'); assert.equal(b.file_name_standardized, 'Report 2026');
        assert.equal(JSON.stringify(b).includes('svc-secret'), false, 'service token never goes in the body');
    } finally { await m.close(); }
});
test('hosted extractor: endpoint off the allowlist is refused BEFORE any request (SSRF)', async () => {
    const m = await mock((_r, res) => json(res, 200, {}));
    try {
        const p = new AiApiExtractProcessor({ id: 'x', endpoint: m.origin + '/extract', engineVersion: 'v1', http: { allowlist: makeAllowlist(['https://ai.example.invalid']) } });
        await assert.rejects(p.extract(exReq()), EndpointNotAllowedError);
        assert.equal(m.seen.length, 0, 'nothing reached the server');
    } finally { await m.close(); }
});
test('hosted extractor: 5xx/429 retryable, 4xx permanent, redirect refused and not followed', async () => {
    const target = await mock((_r, res) => json(res, 200, {}));
    let mode = 503;
    const m = await mock((_r, res) => {
        if (mode === 302) { res.writeHead(302, { location: target.origin + '/internal' }); res.end(); } else json(res, mode, { message: 'x' });
    });
    try {
        const p = new AiApiExtractProcessor({ id: 'x', endpoint: m.origin + '/e', engineVersion: 'v1', http: { allowlist: makeAllowlist([m.origin, target.origin]) } });
        for (const [code, retry] of [[503, true], [429, true], [500, true], [400, false], [401, false], [404, false]] as const) {
            mode = code;
            await assert.rejects(p.extract(exReq()), (e: unknown) => e instanceof ProcessorError && e.retryable === retry && e.statusCode === code, String(code));
        }
        mode = 302;
        await assert.rejects(p.extract(exReq()), (e: unknown) => e instanceof ProcessorError && !e.retryable && /redirect/.test(e.message));
        assert.equal(target.seen.length, 0, 'redirect target was never contacted');
    } finally { await m.close(); await target.close(); }
});
test('hosted adapters: response size cap and request timeout', async () => {
    const m = await mock((r, res) => {
        if (r.url === '/big') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"pad":"' + 'x'.repeat(5000) + '"}'); }
        else { /* never answer */ }
    });
    try {
        const al = makeAllowlist([m.origin]);
        const big = new AiApiExtractProcessor({ id: 'x', endpoint: m.origin + '/big', engineVersion: '1', http: { allowlist: al, maxResponseBytes: 1000 } });
        await assert.rejects(big.extract(exReq()), (e: unknown) => e instanceof ProcessorError && /exceeds/.test(e.message) && !e.retryable);
        const slow = new AiApiExtractProcessor({ id: 'y', endpoint: m.origin + '/slow', engineVersion: '1', http: { allowlist: al, timeoutMs: 150 } });
        await assert.rejects(slow.extract(exReq()), (e: unknown) => e instanceof ProcessorError && e.retryable);
    } finally { await m.close(); }
});
test('hosted extractor: requires fileUrl and callbackUrl (never sends bytes)', async () => {
    const p = new AiApiExtractProcessor({ id: 'x', endpoint: 'http://127.0.0.1:1/e', engineVersion: '1', http: { allowlist: makeAllowlist(['http://127.0.0.1:1']) } });
    await assert.rejects(p.extract(exReq({ fileUrl: undefined, bytes: Buffer.from('x') })), (e: unknown) => e instanceof ProcessorError && !e.retryable);
});

// ── hosted Structuring V2 ─────────────────────────────────────────────────
test('Structuring V2 adapter: maps contract B request onto the V2 payload; content field configurable', async () => {
    const m = await mock((_r, res) => json(res, 202, { request_id: 'r-9' }));
    try {
        const al = makeAllowlist([m.origin]);
        const p = new StructuringV2Processor({ id: 'sv2', endpoint: m.origin + '/structure', engineVersion: 'v2', http: { allowlist: al }, contentField: 'document_text' });
        const out = await p.structure(stReq({ profile: 'rent-roll', outputSchema: { type: 'object' }, sourceRefs: true, reviewThreshold: 0.8, instructions: 'be careful' }));
        assert.deepEqual(out, { status: 'accepted', remoteRequestId: 'r-9' });
        const b = JSON.parse(m.seen[0]!.body);
        assert.equal(b.request_id, 'job_s1'); assert.equal(b.document_text, 'Page_Number: 1\nhello'); assert.equal(b.content, undefined);
        assert.equal(b.profile, 'rent-roll'); assert.equal(b.item_path, 'rows'); assert.deepEqual(b.item_key, ['id']);
        assert.equal(b.source_refs, true); assert.equal(b.review_threshold, 0.8); assert.equal(b.bearer_token, 'tok');
        await assert.rejects(p.structure(stReq({ callbackUrl: undefined })), ProcessorError);
    } finally { await m.close(); }
});

// ── local structurer (OpenAI-compatible) ──────────────────────────────────
const chat = (content: string) => ({ choices: [{ message: { role: 'assistant', content } }] });
test('local structurer: calls /chat/completions deterministically and flags every item for review', async () => {
    const m = await mock((_r, res) => json(res, 200, chat(JSON.stringify({ rows: [{ id: 1 }, { id: 2 }] }))));
    try {
        const p = new LocalStructureProcessor({ id: 'local-llm', baseUrl: m.origin + '/v1', model: 'qwen-test', http: { allowlist: makeAllowlist([m.origin]) } });
        const out = await p.structure(stReq({ outputSchema: { type: 'object' }, instructions: 'Only JSON.' }));
        assert.equal(out.status, 'done');
        if (out.status !== 'done') return;
        assert.deepEqual(out.result.content, { rows: [{ id: 1 }, { id: 2 }] });
        assert.equal(out.result.annotations!.items.length, 2);
        assert.ok(out.result.annotations!.items.every((a) => a.needs_review && a.confidence.score === 0.5 && a.quote_verified === false));
        assert.equal(out.result.processor.locality, 'local'); assert.equal(out.result.processor.version, 'qwen-test');
        const b = JSON.parse(m.seen[0]!.body);
        assert.equal(m.seen[0]!.url, '/v1/chat/completions'); assert.equal(b.temperature, 0); assert.deepEqual(b.response_format, { type: 'json_object' });
        assert.equal(b.messages[1].content, 'Page_Number: 1\nhello'); assert.match(b.messages[0].content, /JSON Schema/);
    } finally { await m.close(); }
});
test('local structurer: malformed model output is a retryable error; missing content is permanent', async () => {
    let reply: unknown = chat('not json');
    const m = await mock((_r, res) => json(res, 200, reply));
    try {
        const p = new LocalStructureProcessor({ id: 'l', baseUrl: m.origin + '/v1', model: 'm', http: { allowlist: makeAllowlist([m.origin]) } });
        await assert.rejects(p.structure(stReq()), (e: unknown) => e instanceof ProcessorError && e.retryable);
        reply = chat('[1,2]');
        await assert.rejects(p.structure(stReq()), (e: unknown) => e instanceof ProcessorError && e.retryable);
        reply = { choices: [] };
        await assert.rejects(p.structure(stReq()), (e: unknown) => e instanceof ProcessorError && !e.retryable);
    } finally { await m.close(); }
});
test('local structurer: a "local" engine must be loopback unless explicitly declared otherwise', () => {
    const al = makeAllowlist(['https://api.example.invalid']);
    assert.throws(() => new LocalStructureProcessor({ id: 'l', baseUrl: 'https://api.example.invalid/v1', model: 'm', http: { allowlist: al } }), /not loopback/);
    assert.doesNotThrow(() => new LocalStructureProcessor({ id: 'l', baseUrl: 'https://api.example.invalid/v1', model: 'm', http: { allowlist: al }, allowNonLoopback: true }));
    for (const h of ['localhost', '127.0.0.1', '127.9.9.9', '[::1]', '::1']) assert.equal(isLoopbackHost(h), true, h);
    for (const h of ['10.0.0.1', 'example.com', '128.0.0.1', 'localhost.evil.com']) assert.equal(isLoopbackHost(h), false, h);
});

// ── local extractor preserves current behaviour ───────────────────────────
test('local extractor: output equals the in-process extractor registry output', async () => {
    const { buildDefaultRegistry } = await import('../packages/lore/src/engines/extractors/index.js');
    const text = Buffer.from('First paragraph.\n\nSecond paragraph about leases.\n');
    const direct = await buildDefaultRegistry().extract(text, 'text/plain');
    const p = new LocalExtractProcessor();
    assert.equal(p.info.locality, 'local'); assert.equal(p.supports('text/plain'), true); assert.equal(p.supports('application/x-nothing'), false);
    const out = await p.extract(exReq({ bytes: text, mimeType: 'text/plain', fileName: 'a.txt', fileUrl: undefined, callbackUrl: undefined }));
    assert.equal(out.status, 'done');
    if (out.status !== 'done') return;
    assert.equal(out.result.text, direct.text); assert.equal(out.result.confidence, direct.confidence); assert.equal(out.result.mimeType, direct.mimeType);
    assert.equal(out.result.jobId, 'job_abc'); assert.equal(out.result.contractVersion, CONTRACT_A_VERSION);
});
test('local extractor: missing bytes and extractor failures are permanent errors', async () => {
    const p = new LocalExtractProcessor();
    await assert.rejects(p.extract(exReq({ bytes: undefined })), (e: unknown) => e instanceof ProcessorError && !e.retryable);
    await assert.rejects(p.extract(exReq({ bytes: Buffer.from('not a pdf'), mimeType: 'application/pdf' })), (e: unknown) => e instanceof ProcessorError && !e.retryable);
});

// ── callback parsing (ai-api envelope) ────────────────────────────────────
const env = (values: unknown, extra: Record<string, unknown> = {}) => ({ data: { requestID: 'job_1', values, format: 'json' }, status: 'success', statusCode: 200, ...extra });
test('callback parse: extract envelope becomes contract A with page chunks', () => {
    const r = parseExtractCallback(env({ content: 'Page_Number: 1\nalpha\nPage_Number: 2\nbeta', totalWords: 4 }), 'job_1', procInfo);
    assert.equal(r.chunks.length, 2); assert.equal(r.chunks[1]!.page, 2); assert.equal(r.jobId, 'job_1');
});
test('callback parse: wrong requestID, error status, and wrong shapes are rejected with the right retryability', () => {
    assert.throws(() => parseExtractCallback({ ...env({ content: 'x' }), data: { requestID: 'other', values: { content: 'x' } } }, 'job_1', procInfo), (e: unknown) => e instanceof ProcessorError && !e.retryable);
    assert.throws(() => parseExtractCallback(env({}, { status: 'error', statusCode: 503, message: 'upstream' }), 'job_1', procInfo), (e: unknown) => e instanceof ProcessorError && e.retryable);
    assert.throws(() => parseExtractCallback(env({}, { statusCode: 422 }), 'job_1', procInfo), (e: unknown) => e instanceof ProcessorError && !e.retryable);
    for (const bad of [null, 'x', {}, { data: null }, env(null), env({ content: 5 })]) assert.throws(() => parseExtractCallback(bad, 'job_1', procInfo), ProcessorError);
});
test('callback parse: structuring annotations are clamped, bounded and default to needs_review', () => {
    const r = parseStructureCallback(env({
        content: { rows: [{ id: 1 }, { id: 2 }] },
        annotations: { items: [{ index: 0, source_page: 3, source_quote: 'q'.repeat(5000), confidence: { score: 7, level: 'High', reasons: ['a'] }, needs_review: false }, { index: 1 }], rejected: [], document: { incomplete: true } },
    }), 'job_1', { ...procInfo, kind: 'structure' });
    assert.equal(r.incomplete, true);
    const [a, b] = r.annotations!.items;
    assert.equal(a!.confidence.score, 1); assert.equal(a!.source_quote!.length, 2000); assert.equal(a!.needs_review, false);
    assert.equal(b!.needs_review, true); assert.equal(b!.confidence.level, 'Low'); assert.equal(b!.confidence.score, 0);
    assert.throws(() => parseStructureCallback(env({ content: { rows: [] }, annotations: { items: [{ index: -1 }] } }), 'job_1', procInfo), ProcessorError);
    assert.throws(() => parseStructureCallback(env({ content: 'str' }), 'job_1', procInfo), ProcessorError);
    assert.throws(() => parseStructureCallback(env({ content: {}, annotations: { items: new Array(10_001).fill({ index: 0 }) } }), 'job_1', procInfo), ProcessorError);
});

// ── page helpers ──────────────────────────────────────────────────────────
test('pages: split on markers and rebuild structuring text with page markers', () => {
    const chunks = splitPages('Page_Number: 1\none\nPage_Number: 2\ntwo');
    assert.deepEqual(chunks.map((c) => c.page), [1, 2]);
    const rebuilt = buildStructuringText('one\ntwo', [{ text: 'one', page: 1 }, { text: 'two', page: 2 }]);
    assert.match(rebuilt, /Page_Number: 1[\s\S]*one[\s\S]*Page_Number: 2[\s\S]*two/);
    assert.deepEqual(splitPages('no markers here'), [], 'unpaged text yields no chunks; the memory writer falls back to the whole text');
});

Promise.all(pending).then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
});
