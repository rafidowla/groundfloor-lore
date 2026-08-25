#!/usr/bin/env node
/**
 * measure-shim-savings.mjs — measures the token savings from LORE_TOOL_SHIM.
 *
 * Connects to the live Lore daemon, calls tools/list, and reports:
 *   - Number of tools exposed
 *   - Byte size of the full tools/list response
 *   - Approximate token count (bytes / 4, GPT-style heuristic)
 *
 * Run this twice — once with the daemon in normal mode (LORE_TOOL_SHIM unset),
 * once with LORE_TOOL_SHIM=on — and compare the outputs to get the real
 * shim savings.
 *
 * Usage
 *   node scripts/measure-shim-savings.mjs
 *   node scripts/measure-shim-savings.mjs --json   # machine-readable output
 *
 * License: original work for groundfloor-lore.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_URL = 'http://127.0.0.1:3847';
const jsonMode = process.argv.includes('--json');

function readAuthToken() {
    const candidates = [
        path.join(process.env.LORE_HOME ?? '', 'auth.token'),
        path.join(process.env.HOME ?? '', '.groundfloor', 'auth.token'),
        path.join(process.env.HOME ?? '', 'Downloads/AiDev/BitBucket/lore-workspace/auth.token'),
    ].filter(Boolean);
    for (const c of candidates) {
        try {
            const txt = fs.readFileSync(c, 'utf-8').trim();
            if (txt) return txt;
        } catch { /* try next */ }
    }
    return null;
}

async function probeDaemon() {
    try {
        const r = await fetch(`${DAEMON_URL}/health`, {
            signal: AbortSignal.timeout(1500),
        });
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    }
}

async function openSession(token) {
    const r = await fetch(`${DAEMON_URL}/mcp`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'measure-shim-savings', version: '1.0.0' },
            },
        }),
    });
    if (!r.ok) throw new Error(`initialize HTTP ${r.status}: ${await r.text()}`);
    const sid = r.headers.get('mcp-session-id');
    if (!sid) throw new Error('no mcp-session-id header');
    await r.text(); // drain
    // Send initialized notification
    await fetch(`${DAEMON_URL}/mcp`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            accept: 'application/json, text/event-stream',
            'mcp-session-id': sid,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    return sid;
}

async function toolsList(token, sid) {
    const r = await fetch(`${DAEMON_URL}/mcp`, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            accept: 'application/json, text/event-stream',
            'mcp-session-id': sid,
        },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
        }),
    });
    if (!r.ok) throw new Error(`tools/list HTTP ${r.status}: ${await r.text()}`);
    const rawBody = await r.text();
    const rawBytes = Buffer.byteLength(rawBody, 'utf-8');

    // Parse the SSE response to extract the JSON-RPC result
    const lines = rawBody.split('\n').map(l => l.trim()).filter(Boolean);
    const dataLines = lines.filter(l => l.startsWith('data: ')).map(l => l.slice(6)).filter(l => l.startsWith('{'));
    if (dataLines.length === 0) throw new Error(`no JSON in tools/list response: ${rawBody.slice(0, 200)}`);

    const parsed = JSON.parse(dataLines[0]);
    const tools = parsed?.result?.tools ?? [];
    const resultText = dataLines[0]; // the JSON string the client receives
    const resultBytes = Buffer.byteLength(resultText, 'utf-8');

    return { tools, rawBytes, resultBytes, rawBody };
}

async function callTool(token, sid, name, args) {
    const r = await fetch(`${DAEMON_URL}/mcp`, {
        method: 'POST',
        signal: AbortSignal.timeout(10000),
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            accept: 'application/json, text/event-stream',
            'mcp-session-id': sid,
        },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name, arguments: args },
        }),
    });
    if (!r.ok) throw new Error(`tools/call HTTP ${r.status}: ${await r.text()}`);
    const raw = await r.text();
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const dataLines = lines.filter(l => l.startsWith('data: ')).map(l => l.slice(6)).filter(l => l.startsWith('{'));
    if (dataLines.length === 0) throw new Error(`no JSON in tools/call response`);
    const parsed = JSON.parse(dataLines[0]);
    // JSON-RPC level error (e.g. invalid request)
    if (parsed.error) throw new Error(`rpc error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
    const result = parsed?.result;
    // MCP tool-level error — SDK wraps "tool not found" and handler errors
    // as isError:true in the content, NOT as a JSON-RPC error.
    if (result?.isError) {
        const errText = result?.content?.[0]?.text ?? '(no message)';
        throw new Error(`tool error: ${errText}`);
    }
    const text = result?.content?.[0]?.text ?? '';
    return { bytes: Buffer.byteLength(text, 'utf-8'), text };
}

function approxTokens(bytes) {
    // GPT-style heuristic: ~4 bytes per token for English/JSON
    return Math.round(bytes / 4);
}

function fmt(n) { return n.toLocaleString(); }

async function main() {
    const health = await probeDaemon();
    if (!health) {
        console.error('Daemon unreachable at', DAEMON_URL);
        process.exit(1);
    }

    const token = readAuthToken();
    if (!token) {
        console.error('auth.token not found');
        process.exit(1);
    }

    const sid = await openSession(token);

    // ── 1. tools/list measurement ──────────────────────────────────────────
    const { tools, resultBytes } = await toolsList(token, sid);
    const toolCount = tools.length;
    const toolListTokens = approxTokens(resultBytes);

    // Per-tool breakdown: sorted by schema size descending
    const toolSizes = tools.map(t => {
        const schemaStr = JSON.stringify(t);
        return {
            name: t.name,
            bytes: Buffer.byteLength(schemaStr, 'utf-8'),
        };
    }).sort((a, b) => b.bytes - a.bytes);

    // ── 2. Typical session pattern ─────────────────────────────────────────
    // Simulate: tools/list + recall + search + one code tool = common agent session.
    // In shim mode these tools aren't directly callable — we route through
    // lore_tool_invoke instead. In normal mode we call them directly.
    let shimActive = false;
    let shimListBytes = 0;
    let shimSchemaFetchBytes = 0;
    try {
        const shimListResult = await callTool(token, sid, 'lore_tool_list', {});
        shimActive = true;
        shimListBytes = shimListResult.bytes;
        const schemaResult = await callTool(token, sid, 'lore_tool_schema', { name: 'recall' });
        shimSchemaFetchBytes = schemaResult.bytes;
    } catch {
        shimActive = false;
    }

    const sessionToolCalls = [];
    const SAMPLE_CALLS = [
        ['recall',            { topic: 'auth', mode: 'summary' }],
        ['search',            { query: 'embedding provider', limit: 3 }],
        ['code_blast_radius', { symbol: 'createMcpServer' }],
    ];

    for (const [name, args] of SAMPLE_CALLS) {
        // In shim mode, real tools are only reachable via lore_tool_invoke.
        const [callName, callArgs] = shimActive
            ? ['lore_tool_invoke', { name, input: args }]
            : [name, args];
        try {
            const res = await callTool(token, sid, callName, callArgs);
            sessionToolCalls.push({ name, bytes: res.bytes });
        } catch (err) {
            sessionToolCalls.push({ name, bytes: 0, error: err.message.slice(0, 60) });
        }
    }

    const sessionCallBytes = sessionToolCalls.reduce((s, t) => s + t.bytes, 0);
    const sessionTotalBytes = resultBytes + sessionCallBytes;
    const sessionTotalTokens = approxTokens(sessionTotalBytes);

    // ── Output ─────────────────────────────────────────────────────────────
    if (jsonMode) {
        const result = {
            mode: shimActive ? 'shim-on' : 'shim-off',
            toolsListBytes: resultBytes,
            toolsListTokens: toolListTokens,
            toolCount,
            toolSizesTop10: toolSizes.slice(0, 10),
            sessionToolCalls,
            sessionTotalBytes,
            sessionTotalTokens,
            shimActive,
            ...(shimActive ? { shimListBytes, shimSchemaFetchBytes } : {}),
        };
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    // Human-readable output
    const shimLabel = shimActive ? '  [SHIM IS ACTIVE]' : '';
    console.log('');
    console.log(`╔══════════════════════════════════════════════════════╗`);
    console.log(`║      Lore tools/list token measurement               ║`);
    console.log(`╚══════════════════════════════════════════════════════╝`);
    console.log('');
    console.log(`Mode:             ${shimActive ? 'SHIM ON  (LORE_TOOL_SHIM=on)' : 'normal   (LORE_TOOL_SHIM unset)'}`);
    console.log(`Tools exposed:    ${toolCount}${shimLabel}`);
    console.log(`tools/list bytes: ${fmt(resultBytes)} B`);
    console.log(`tools/list ~tok:  ~${fmt(toolListTokens)} tokens  (bytes ÷ 4)`);
    console.log('');
    console.log(`Top 10 largest tool schemas:`);
    for (const t of toolSizes.slice(0, 10)) {
        const bar = '█'.repeat(Math.min(30, Math.round(t.bytes / 100)));
        console.log(`  ${t.name.padEnd(28)} ${fmt(t.bytes).padStart(6)} B  ${bar}`);
    }
    console.log('');
    console.log(`Typical session (tools/list + 3 tool calls):`);
    console.log(`  tools/list:      ${fmt(resultBytes)} B`);
    for (const tc of sessionToolCalls) {
        const label = tc.error ? `ERROR: ${tc.error.slice(0, 40)}` : `${fmt(tc.bytes)} B`;
        console.log(`  ${tc.name.padEnd(20)} ${label}`);
    }
    console.log(`  ─────────────────────────`);
    console.log(`  Total:           ${fmt(sessionTotalBytes)} B  (~${fmt(sessionTotalTokens)} tokens)`);

    if (shimActive) {
        // Two realistic shim scenarios:
        //   A) Pre-taught: agent knows tool names from CLAUDE.md; skips lore_tool_list
        //      and lore_tool_schema; calls lore_tool_invoke directly.
        //   B) Cold discovery: agent calls lore_tool_list + 3 schemas before invoking.
        const schemaFetchPerTool = shimSchemaFetchBytes; // one schema fetch
        const coldDiscovery = shimListBytes + (SAMPLE_CALLS.length * schemaFetchPerTool);
        const taughtTotal    = resultBytes + sessionCallBytes;
        const coldTotal      = resultBytes + coldDiscovery + sessionCallBytes;
        console.log('');
        console.log(`Shim discovery costs:`);
        console.log(`  lore_tool_list (all 45 names+desc): ${fmt(shimListBytes)} B`);
        console.log(`  lore_tool_schema per tool:          ${fmt(shimSchemaFetchBytes)} B`);
        console.log(`  3 schemas for this session:         ${fmt(SAMPLE_CALLS.length * schemaFetchPerTool)} B`);
        console.log('');
        console.log(`Session totals (shim on vs normal-mode baseline):`);
        console.log(`  Pre-taught agent (no discovery):    ${fmt(taughtTotal)} B  (~${fmt(approxTokens(taughtTotal))} tok)`);
        console.log(`  Cold-discovery agent:               ${fmt(coldTotal)} B  (~${fmt(approxTokens(coldTotal))} tok)`);
        console.log(`  Normal mode baseline:               see shim-off run`);
    } else {
        console.log('');
        console.log(`To measure shim mode:`);
        console.log(`  1. Add LORE_TOOL_SHIM=on to launchd plist (EnvironmentVariables section)`);
        console.log(`  2. launchctl bootout + bootstrap (or kickstart after plist reload)`);
        console.log(`  3. node scripts/measure-shim-savings.mjs`);
    }
    console.log('');
}

main().catch(err => {
    console.error('fatal:', err.message);
    process.exit(1);
});
