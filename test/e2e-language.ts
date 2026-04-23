#!/usr/bin/env tsx
/**
 * e2e-language.ts — End-to-end smoke for V2.2 multilingual support.
 *
 * Covers the three phases:
 *   Phase A — detection capability + `language` field round-trip
 *   Phase B — queryLanguage hint on search / recall
 *   Phase C — UI endpoint (/api/stats languageBreakdown)
 *
 * Strategy:
 *   - Pure unit tests for the core `detectLanguage()` utility
 *   - HTTP + MCP integration against the live launchd daemon
 *   - Self-cleaning: tagged probe nodes are deleted at the end
 *
 * Usage: npx tsx test/e2e-language.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { detectLanguage } from '../packages/lore/src/engines/language.js';

const DAEMON_URL = 'http://127.0.0.1:3847/mcp';
const HTTP_BASE = 'http://127.0.0.1:3847';
const AUTH_TOKEN_PATH = path.join(os.homedir(), '.groundfloor', 'auth.token');

interface Check { name: string; pass: boolean; detail?: string; }
const checks: Check[] = [];

function record(name: string, pass: boolean, detail?: string): void {
    checks.push({ name, pass, detail });
    const icon = pass ? '✓' : '✗';
    const color = pass ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    console.log(`  ${color}${icon}${reset} ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ─── Phase A — pure detection ─────────────────────────────────── */

function testDetectionPure(): void {
    console.log('\n─── Phase A: detectLanguage() pure function ───');

    const english = 'The quick brown fox jumps over the lazy dog. This is a simple English sentence that should be detected reliably by the franc library since it has enough content to give a high confidence score.';
    const spanish = 'El rápido zorro marrón salta sobre el perro perezoso. Esta es una oración simple en español que debería ser detectada de manera confiable por la biblioteca franc con alta confianza.';
    const japanese = 'これは日本語のサンプルテキストです。言語検出ライブラリのテストのために十分な長さを持っている必要があります。';

    const enResult = detectLanguage(english);
    record('detects English', enResult.language === 'en', `lang=${enResult.language}`);

    const esResult = detectLanguage(spanish);
    record('detects Spanish', esResult.language === 'es', `lang=${esResult.language}`);

    const jaResult = detectLanguage(japanese);
    record('detects Japanese', jaResult.language === 'ja', `lang=${jaResult.language}`);

    const shortResult = detectLanguage('Hi');
    record('short text returns null', shortResult.language === null, `lang=${shortResult.language}`);

    const codeResult = detectLanguage('validateAuth() { return true; }');
    record('code-shaped returns null', codeResult.language === null, `lang=${codeResult.language}`);

    const emptyResult = detectLanguage('');
    record('empty returns null', emptyResult.language === null);

    const nonString = detectLanguage(null as unknown as string);
    record('non-string returns null safely', nonString.language === null && nonString.confidence === 0);
}

/* ─── Phase A — HTTP endpoint ──────────────────────────────────── */

async function testHttpDetect(): Promise<void> {
    console.log('\n─── Phase A: POST /api/language/detect ───');
    const token = fs.readFileSync(AUTH_TOKEN_PATH, 'utf8').trim();

    const call = async (text: string) => {
        const resp = await fetch(`${HTTP_BASE}/api/language/detect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ text }),
        });
        return resp.json() as Promise<{ language: string | null; confidence: number }>;
    };

    const en = await call('The quick brown fox jumps over the lazy dog. This is a simple English sentence that should be detected reliably.');
    record('HTTP English detected', en.language === 'en', `lang=${en.language}`);

    const es = await call('El rápido zorro marrón salta sobre el perro perezoso, con suficiente texto para una detección confiable.');
    record('HTTP Spanish detected', es.language === 'es', `lang=${es.language}`);

    // Missing body → 400
    const badResp = await fetch(`${HTTP_BASE}/api/language/detect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
    });
    record('HTTP rejects missing text', badResp.status === 400, `status=${badResp.status}`);
}

/* ─── Phase A — MCP tool ───────────────────────────────────────── */

async function testMcpDetect(client: Client): Promise<void> {
    console.log('\n─── Phase A: MCP detect_language tool ───');

    const call = async (text: string) => {
        const resp = await client.callTool({ name: 'detect_language', arguments: { text } });
        const content = (resp as { content?: Array<{ text?: string }> }).content;
        const textOut = content?.[0]?.text;
        if (!textOut) return null;
        return JSON.parse(textOut) as { language: string | null; confidence: number };
    };

    const en = await call('The quick brown fox jumps over the lazy dog. This is English prose long enough for reliable detection.');
    record('MCP English detected', en?.language === 'en', `lang=${en?.language}`);

    const ja = await call('これは日本語のサンプルテキストです。言語検出ライブラリのテストのために十分な長さを持っている必要があります。');
    record('MCP Japanese detected', ja?.language === 'ja', `lang=${ja?.language}`);
}

/* ─── Phase A — store_node round-trip ──────────────────────────── */

async function testStoreNodeRoundTrip(client: Client): Promise<string | null> {
    console.log('\n─── Phase A: store_node round-trip with language ───');
    const token = fs.readFileSync(AUTH_TOKEN_PATH, 'utf8').trim();
    const probeId = `e2e-lang-es-${Date.now()}`;

    const storeResp = await client.callTool({
        name: 'store_node',
        arguments: {
            id: probeId,
            type: 'note',
            label: 'Probe ES',
            content: 'Nodo de prueba en español con el tag explícito es.',
            tags: 'e2e,language-test',
            language: 'es',
        },
    });
    const storeText = (storeResp as { content?: Array<{ text?: string }> }).content?.[0]?.text;
    const storeJson = storeText ? JSON.parse(storeText) : null;
    record('store_node with language succeeded', storeJson?.success === true);

    // Read back via HTTP
    const detail = await fetch(`${HTTP_BASE}/api/node?id=${probeId}`, {
        headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json() as Promise<{ node?: { language?: string | null } }>);
    record('language field persisted', detail.node?.language === 'es', `lang=${detail.node?.language}`);

    // Store another node without language → stays null
    const untaggedId = `e2e-lang-untagged-${Date.now()}`;
    await client.callTool({
        name: 'store_node',
        arguments: {
            id: untaggedId,
            type: 'note',
            label: 'Untagged probe',
            content: 'This node has no explicit language tag. Caller did not pass it.',
            tags: 'e2e,language-test',
        },
    });
    const untaggedDetail = await fetch(`${HTTP_BASE}/api/node?id=${untaggedId}`, {
        headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json() as Promise<{ node?: { language?: string | null } }>);
    record('untagged node stays language=null', untaggedDetail.node?.language === null || untaggedDetail.node?.language === undefined);

    // Cleanup both probes
    await client.callTool({ name: 'delete_node', arguments: { id: probeId } });
    await client.callTool({ name: 'delete_node', arguments: { id: untaggedId } });
    return probeId;
}

/* ─── Phase B — hint on recall ─────────────────────────────────── */

async function testPhaseBHint(client: Client): Promise<void> {
    console.log('\n─── Phase B: queryLanguage hint on recall ───');

    // Query in a rare language ('ja') with a small corpus should produce
    // a hint.
    const resp = await client.callTool({
        name: 'recall',
        arguments: {
            topic: 'architecture',
            queryLanguage: 'ja',
        },
    });
    const textOut = (resp as { content?: Array<{ text?: string }> }).content?.[0]?.text;
    const body = textOut ? JSON.parse(textOut) : null;

    const hint = body?.hint as { queryLanguage?: string; corpusLanguageBreakdown?: Record<string, number>; suggestion?: string } | undefined;
    record('recall with rare queryLanguage returns a hint', hint != null, hint ? `hint for ${hint.queryLanguage}` : 'no hint');
    record('hint has suggestion text', typeof hint?.suggestion === 'string' && hint.suggestion.length > 20);

    // Query in no language tag → no hint
    const resp2 = await client.callTool({
        name: 'recall',
        arguments: { topic: 'architecture' },
    });
    const textOut2 = (resp2 as { content?: Array<{ text?: string }> }).content?.[0]?.text;
    const body2 = textOut2 ? JSON.parse(textOut2) : null;
    record('recall without queryLanguage omits hint', body2?.hint == null);
}

/* ─── Phase C — /api/stats includes breakdown ──────────────────── */

async function testPhaseCStatsBreakdown(): Promise<void> {
    console.log('\n─── Phase C: /api/stats exposes languageBreakdown ───');
    const token = fs.readFileSync(AUTH_TOKEN_PATH, 'utf8').trim();
    const stats = await fetch(`${HTTP_BASE}/api/stats`, {
        headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json() as Promise<{ languageBreakdown?: Record<string, number> }>);
    record('languageBreakdown present', stats.languageBreakdown != null);
    record('breakdown is an object', typeof stats.languageBreakdown === 'object');
}

/* ─── Main ─────────────────────────────────────────────────────── */

async function connectMcp(): Promise<Client> {
    const token = fs.readFileSync(AUTH_TOKEN_PATH, 'utf8').trim();
    const transport = new StreamableHTTPClientTransport(new URL(DAEMON_URL), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'e2e-language', version: '1.0.0' });
    await client.connect(transport);
    return client;
}

async function main(): Promise<void> {
    console.log('═══ V2.2 Multilingual E2E ═══');
    console.log(`Daemon: ${DAEMON_URL}`);

    testDetectionPure();
    await testHttpDetect();

    let client: Client | null = null;
    try {
        client = await connectMcp();
    } catch (err) {
        console.error(`\n✗ Cannot connect to daemon: ${(err as Error).message}`);
        record('daemon reachable', false, (err as Error).message);
        printSummary();
        process.exit(1);
    }

    try {
        await testMcpDetect(client);
        await testStoreNodeRoundTrip(client);
        await testPhaseBHint(client);
        await testPhaseCStatsBreakdown();
    } finally {
        await client.close().catch(() => { /* ignore */ });
    }

    printSummary();
}

function printSummary(): void {
    const passed = checks.filter((c) => c.pass).length;
    const failed = checks.length - passed;
    console.log('\n─── Summary ───');
    console.log(`  Passed: ${passed}/${checks.length}`);
    if (failed > 0) {
        console.log(`  Failed: ${failed}`);
        for (const c of checks.filter((c) => !c.pass)) {
            console.log(`    ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
        }
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('\nTest runner crashed:', err);
    process.exit(1);
});
