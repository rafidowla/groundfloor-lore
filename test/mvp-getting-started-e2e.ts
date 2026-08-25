#!/usr/bin/env tsx
/**
 * mvp-getting-started-e2e.ts — MVP readiness P2: the cold getting-started path
 * a NEW client app (Atlas, Claude Code, Cursor) follows to connect to Lore.
 *
 * From a clean install, over the REAL MCP protocol (Streamable HTTP at /mcp —
 * the transport IDEs/agents actually use, NOT the REST admin surface):
 *   1. fresh daemon boots on an isolated data home (nothing pre-existing).
 *   2. client gets a token (POST /api/auth/bootstrap).
 *   3. MCP initialize → session id → notifications/initialized.
 *   4. tools/list returns the core tools (store_node, recall) by name
 *      (i.e. the tool shim is off by default — agents call tools directly).
 *   5. tools/call store_node writes a memory.
 *   6. tools/call recall reads it back by meaning.
 *
 * If any of this breaks, a brand-new integration can't get off the ground —
 * so this is the "can someone actually start using it" gate.
 */

import assert from 'node:assert/strict';
import { spawnDaemon, waitForReady, fetchAuthToken, cleanup, type DaemonHandle } from './helpers/live-daemon.js';

let passed = 0;
let failed = 0;

/** MCP initialize handshake → returns the session id. */
async function mcpInit(base: string, token: string): Promise<string> {
    const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mvp-getting-started', version: '0.0.1' } } }),
    });
    if (!r.ok) throw new Error(`MCP initialize HTTP ${r.status}: ${await r.text()}`);
    const sid = r.headers.get('mcp-session-id');
    if (!sid) throw new Error('MCP initialize returned no mcp-session-id');
    await r.text();
    await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    return sid;
}

/** Send one JSON-RPC request over MCP, return the parsed `result`. */
async function mcpRpc(base: string, token: string, sid: string, method: string, params: unknown): Promise<{ tools?: Array<{ name: string }>; content?: Array<{ text?: string }>; isError?: boolean }> {
    const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method, params }),
    });
    if (!r.ok) throw new Error(`${method} HTTP ${r.status}: ${await r.text()}`);
    const raw = await r.text();
    const jsonLine = raw.split('\n').map((l) => l.trim()).filter(Boolean)
        .filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).find((l) => l.startsWith('{'));
    if (!jsonLine) throw new Error(`${method}: no JSON-RPC response in body: ${raw.slice(0, 200)}`);
    const parsed = JSON.parse(jsonLine);
    if (parsed.error) throw new Error(`${method} rpc error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
    return parsed.result;
}

/** tools/call → return the tool's text payload. */
async function mcpCallTool(base: string, token: string, sid: string, name: string, args: unknown): Promise<string> {
    const result = await mcpRpc(base, token, sid, 'tools/call', { name, arguments: args });
    if (result?.isError) throw new Error(`tool ${name} error: ${result?.content?.[0]?.text ?? '(no message)'}`);
    const text = result?.content?.[0]?.text;
    if (!text) throw new Error(`tool ${name} returned non-text content`);
    return text;
}

console.log('MVP getting-started E2E — cold install → connect over MCP → store + recall');

async function main(): Promise<void> {
    let h: DaemonHandle | null = null;
    try {
        // 1. fresh daemon on a clean data home.
        h = await spawnDaemon();
        assert.ok(await waitForReady(h.port), `daemon never ready\n${h.log.text}`);
        const base = `http://127.0.0.1:${h.port}`;

        // 2. client obtains a token.
        h.token = await fetchAuthToken(h.port);
        assert.ok(h.token.length > 0, 'bootstrap must return a token');

        // 3. MCP handshake.
        const sid = await mcpInit(base, h.token);
        assert.ok(sid.length > 0, 'MCP session must open');

        // 4. tools/list exposes the core tools by name (shim off by default).
        const list = await mcpRpc(base, h.token, sid, 'tools/list', {});
        const toolNames = (list.tools ?? []).map((t) => t.name);
        assert.ok(toolNames.includes('store_node'), `tools/list must expose store_node; got ${toolNames.slice(0, 12).join(',')}…`);
        assert.ok(toolNames.includes('recall'), 'tools/list must expose recall');

        // 5. store_node over MCP.
        const stored = await mcpCallTool(base, h.token, sid, 'store_node', {
            id: 'getting-started-1', type: 'decision',
            label: 'Use Lore as the memory backend',
            content: 'Atlas will proxy semantic writes and recall to Lore over MCP.',
            tags: 'onboarding', workspace: 'default',
        });
        assert.ok(/success|stored|getting-started-1/i.test(stored), `store_node should confirm the write; got: ${stored.slice(0, 200)}`);

        // 6. recall over MCP returns the stored memory (semantic query, no exact substring).
        let recalledText = '';
        let found = false;
        for (let i = 0; i < 20; i++) {
            recalledText = await mcpCallTool(base, h.token, sid, 'recall', { topic: 'where does memory get stored', workspace: 'default', mode: 'summary' });
            if (recalledText.includes('getting-started-1')) { found = true; break; }
            await new Promise((r) => setTimeout(r, 250));
        }
        assert.ok(found, `recall over MCP must return the stored node; got: ${recalledText.slice(0, 200)}`);

        console.log('  ✓ cold daemon boot on a fresh data home');
        console.log('  ✓ token bootstrap + MCP initialize/session handshake');
        console.log(`  ✓ tools/list exposes the core tools (${toolNames.length} tools incl. store_node, recall)`);
        console.log('  ✓ store_node over MCP → recall over MCP returns it (the Atlas/Claude path works cold)');
        passed = 4;
    } catch (err) {
        failed = 1;
        console.error(`  ✗ ${(err as Error).message}`);
        if (h) console.error(`--- daemon log tail ---\n${h.log.text.slice(-2000)}`);
    } finally {
        cleanup(h);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
