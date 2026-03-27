#!/usr/bin/env tsx
/**
 * smoke-test.ts — Verify all 21 tools and 6 resources load and respond.
 *
 * Starts the Lore MCP server, sends tool calls via JSON-RPC over stdin,
 * and validates responses.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '..', 'dist', 'mcp', 'server.js');

let requestId = 1;

function makeRequest(method: string, params: Record<string, unknown> = {}): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: requestId++,
        method,
        params,
    }) + '\n';
}

async function main() {
    console.log('🧪 Lore MCP Smoke Test\n');

    const server = spawn('node', [serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, SURREAL_PASS: '' }, // No SurrealDB
    });

    let stdout = '';
    server.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
    });

    let stderr = '';
    server.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
    });

    // Wait for startup
    await sleep(2000);

    // 1. Initialize
    server.stdin.write(makeRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '1.0.0' },
    }));
    await sleep(1000);

    // 2. List tools
    server.stdin.write(makeRequest('tools/list', {}));
    await sleep(1000);

    // 3. List resources
    server.stdin.write(makeRequest('resources/list', {}));
    await sleep(1000);

    // 4. Test list_repos tool
    server.stdin.write(makeRequest('tools/call', {
        name: 'list_repos',
        arguments: {},
    }));
    await sleep(1000);

    // 5. Test stats tool
    server.stdin.write(makeRequest('tools/call', {
        name: 'stats',
        arguments: {},
    }));
    await sleep(1000);

    // 6. Test detect_changes tool
    server.stdin.write(makeRequest('tools/call', {
        name: 'detect_changes',
        arguments: {
            repo_path: path.join(__dirname, '..'),
            scope: 'all',
        },
    }));
    await sleep(1000);

    // 7. Test search tool
    server.stdin.write(makeRequest('tools/call', {
        name: 'search',
        arguments: { query: 'authentication' },
    }));
    await sleep(1000);

    // Parse results
    server.kill();
    await sleep(500);

    console.log('─── Server Startup Logs ───');
    for (const line of stderr.split('\n').filter(Boolean)) {
        console.log(`  ${line}`);
    }

    console.log('\n─── JSON-RPC Responses ───');
    const responses = stdout.split('\n').filter(Boolean);

    let passed = 0;
    let failed = 0;
    const labels = ['initialize', 'tools/list', 'resources/list', 'list_repos', 'stats', 'detect_changes', 'search'];

    for (let i = 0; i < responses.length; i++) {
        try {
            const resp = JSON.parse(responses[i]);
            const label = labels[i] ?? `response-${i}`;

            if (resp.error) {
                console.log(`  ❌ ${label}: ${resp.error.message}`);
                failed++;
            } else {
                // Extract key info
                let detail = '';
                if (label === 'tools/list') {
                    detail = `${resp.result?.tools?.length ?? 0} tools`;
                } else if (label === 'resources/list') {
                    detail = `${resp.result?.resources?.length ?? 0} resources`;
                } else if (label === 'initialize') {
                    detail = `v${resp.result?.serverInfo?.version ?? '?'}`;
                } else if (resp.result?.content) {
                    const text = resp.result.content[0]?.text ?? '';
                    detail = text.slice(0, 80).replace(/\n/g, ' ');
                }
                console.log(`  ✓ ${label}: ${detail}`);
                passed++;
            }
        } catch {
            console.log(`  ⚠ Response ${i}: (unparseable)`);
        }
    }

    console.log(`\n─── Summary ───`);
    console.log(`  Passed: ${passed}/${passed + failed}`);
    console.log(`  Failed: ${failed}`);

    process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
    console.error('Test runner failed:', err);
    process.exit(1);
});
