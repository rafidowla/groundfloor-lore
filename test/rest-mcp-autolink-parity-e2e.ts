#!/usr/bin/env tsx
/**
 * rest-mcp-autolink-parity-e2e.ts — launch-readiness backlog (2026-08-19)
 * finding #4: "POST /api/node never fires autolink, so REST-written knowledge
 * produces a permanently edgeless graph node while an identical MCP write
 * does not."
 *
 * That diagnosis was written against docs, not runtime: the autolink wiring
 * on the REST route actually landed the day BEFORE the backlog doc, in
 * 22c428e ("Audit fix #5" / functional-correctness low #26, 2026-08-17/18 —
 * postNode.ts resolves `autolinkGraph`/`autolinkVerbatim` per-workspace
 * exactly like mcp/tools/memory/storeNode.ts and both feed the shared
 * core/nodeService.nodeUpsert hook). This suite is the RUNTIME proof at the
 * two real production entry points, side by side — the comparison the
 * existing coverage never made:
 *
 *   - functional-correctness-cluster4-unit.ts (1.3/1.4/3.1) drives
 *     nodeService.nodeUpsert DIRECTLY — not the HTTP route / MCP tool.
 *   - audit-embedded-autolink-isolation-unit.ts + fc-round5-bulk-autolink-
 *     workspace-e2e.ts cover the EMBEDDED + bulkIngest paths, not REST-vs-MCP.
 *   - remediation-gap2-neighbor-leak-unit.ts covers GET /api/node neighbour
 *     SCOPE filtering, not autolink creation parity.
 *   - autolink-drain-before-dispose-unit.ts covers shutdown draining.
 *
 * Flow (one fresh daemon, isolated HOME, local mode):
 *   1. Seed a related node via REST and wait for the outbox/embedder to
 *      drain so its vector is searchable (autolink candidates come from the
 *      verbatim vector index).
 *   2. Write node R via the REAL REST route (HTTP POST /api/node) and node M
 *      via the REAL MCP store_node tool (Streamable HTTP tools/call), with
 *      IDENTICAL payloads — same label/content/tags/workspace; only the id
 *      differs (same id would make the second write an update, not a
 *      comparison).
 *   3. Autolink is fire-and-forget on the ingest tracker, so poll
 *      GET /api/node for each written node until its 1-hop neighbour list
 *      shows a semantic_neighbor edge to the seed.
 *   4. Assert BOTH surfaces acquired the edge. If exactly one surface links,
 *      the backlog finding is real and this suite fails loud.
 */

import assert from 'node:assert/strict';
import { spawnDaemon, waitForReady, fetchAuthToken, cleanup, type DaemonHandle } from './helpers/live-daemon.js';

let passed = 0;
let failed = 0;

/* ─── MCP-over-HTTP helpers (same handshake shape as mvp-getting-started-e2e) ─── */

async function mcpInit(base: string, token: string): Promise<string> {
    const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rest-mcp-autolink-parity', version: '0.0.1' } } }),
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

async function mcpCallTool(base: string, token: string, sid: string, name: string, args: unknown): Promise<string> {
    const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name, arguments: args } }),
    });
    if (!r.ok) throw new Error(`tools/call ${name} HTTP ${r.status}: ${await r.text()}`);
    const raw = await r.text();
    const jsonLine = raw.split('\n').map((l) => l.trim()).filter(Boolean)
        .filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).find((l) => l.startsWith('{'));
    if (!jsonLine) throw new Error(`tools/call ${name}: no JSON-RPC response in body: ${raw.slice(0, 200)}`);
    const parsed = JSON.parse(jsonLine) as { error?: { message?: string }; result?: { isError?: boolean; content?: Array<{ text?: string }> } };
    if (parsed.error) throw new Error(`tools/call ${name} rpc error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
    const result = parsed.result;
    if (result?.isError) throw new Error(`tool ${name} error: ${result.content?.[0]?.text ?? '(no message)'}`);
    const text = result?.content?.[0]?.text;
    if (!text) throw new Error(`tool ${name} returned non-text content`);
    return text;
}

/* ─── neighbour polling ─── */

interface NeighborRow { id: string; relation: string }

/** GET /api/node → the centre's 1-hop neighbours (both directions; outgoing
 *  edges carry the bare relation, incoming are prefixed with '← '). */
async function fetchNeighbors(base: string, headers: Record<string, string>, id: string): Promise<NeighborRow[]> {
    const r = await fetch(`${base}/api/node?id=${encodeURIComponent(id)}&workspace=default`, { headers });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`GET /api/node?id=${id} → HTTP ${r.status}: ${await r.text()}`);
    const body = await r.json() as { neighbors?: NeighborRow[] };
    return body.neighbors ?? [];
}

/** Autolink is fire-and-forget (tracked on the daemon's ingest tracker, not
 *  reachable from outside) — poll until the edge appears or the budget runs
 *  out. The first autolink after boot may also pay the ONNX model load. */
async function waitForSemanticEdge(base: string, headers: Record<string, string>, fromId: string, toId: string, timeoutMs = 120_000): Promise<NeighborRow[]> {
    const deadline = Date.now() + timeoutMs;
    let last: NeighborRow[] = [];
    while (Date.now() < deadline) {
        last = await fetchNeighbors(base, headers, fromId);
        if (last.some((n) => n.id === toId && n.relation.replace(/^←\s*/, '') === 'semantic_neighbor')) return last;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return last;
}

console.log('REST vs MCP autolink parity E2E — identical payload, both surfaces must acquire semantic edges');

async function main(): Promise<void> {
    let h: DaemonHandle | null = null;
    try {
        h = await spawnDaemon();
        assert.ok(await waitForReady(h.port), `daemon never ready\n${h.log.text}`);
        h.token = await fetchAuthToken(h.port, h.home);
        const base = `http://127.0.0.1:${h.port}`;
        const authHdr = { Authorization: `Bearer ${h.token}`, Origin: base };
        const jsonHdr = { ...authHdr, 'Content-Type': 'application/json' };
        const postJson = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: jsonHdr, body: JSON.stringify(body) });
        const sid = await mcpInit(base, h.token);

        /* ── 1. seed a related node both writes should link to ─────────── */
        // Identical label/content/tags across seed + both writes ⇒ identical
        // embedded text ⇒ cosine ~1.0, far above reconnectOneNode's default
        // minSim 0.65. Only the ids differ, so any missing edge is a wiring
        // difference, not a similarity-threshold flake.
        const SEED_ID = 'parity-seed-node';
        const REST_ID = 'parity-rest-write';
        const MCP_ID = 'parity-mcp-write';
        const shared = {
            type: 'decision',
            label: 'Autolink parity probe — shared text',
            content: 'autolink parity probe: identical text so REST and MCP writes embed to the same vector and must both draw a semantic_neighbor edge to the seed',
            tags: 'parity,autolink,launch-readiness',
            workspace: 'default',
        };
        const seed = await postJson('/api/node', { id: SEED_ID, ...shared });
        assert.ok(seed.status === 200 || seed.status === 201, `seed write failed: ${seed.status} ${await seed.text()}`);

        // The seed's canonical verbatim row lands via the outbox (async
        // LanceDB apply). Autolink candidates come from that index, so wait
        // for the pipeline to drain before either probed write fires its hook.
        // FINDING 4 (2026-09-03): `outbox` is now only in the Bearer-
        // authenticated /api/health body — an anonymous probe would read
        // `hb.outbox` as undefined and the `?? 0` fallback would falsely
        // report "drained" on the very first poll.
        let drained = false;
        for (let i = 0; i < 240; i++) {
            const hb = await (await fetch(`${base}/api/health`, { headers: authHdr })).json() as { outbox?: { depth?: number } };
            if ((hb.outbox?.depth ?? 0) === 0) { drained = true; break; }
            await new Promise((r) => setTimeout(r, 250));
        }
        assert.ok(drained, 'outbox never drained to 0 after the seed write — embed/replication pipeline stalled');

        /* ── 2. identical writes through the two REAL surfaces ─────────── */
        const rest = await postJson('/api/node', { id: REST_ID, ...shared });
        assert.ok(rest.status === 200 || rest.status === 201, `REST write failed: ${rest.status} ${await rest.text()}`);

        const mcpText = await mcpCallTool(base, h.token, sid, 'store_node', { id: MCP_ID, ...shared });
        assert.ok(JSON.parse(mcpText).success === true, `MCP store_node failed: ${mcpText.slice(0, 300)}`);

        /* ── 3 + 4. both writes must acquire the semantic edge to the seed ── */
        const restNeighbors = await waitForSemanticEdge(base, authHdr, REST_ID, SEED_ID);
        const restLinked = restNeighbors.some((n) => n.id === SEED_ID && n.relation.replace(/^←\s*/, '') === 'semantic_neighbor');

        const mcpNeighbors = await waitForSemanticEdge(base, authHdr, MCP_ID, SEED_ID);
        const mcpLinked = mcpNeighbors.some((n) => n.id === SEED_ID && n.relation.replace(/^←\s*/, '') === 'semantic_neighbor');

        assert.ok(
            restLinked,
            `REST-written node acquired NO semantic_neighbor edge to the seed — the backlog finding is REAL. neighbours: ${JSON.stringify(restNeighbors)}`,
        );
        console.log('  ✓ REST POST /api/node write acquired a semantic_neighbor edge to the seed');
        passed++;

        assert.ok(
            mcpLinked,
            `MCP store_node write acquired NO semantic_neighbor edge to the seed. neighbours: ${JSON.stringify(mcpNeighbors)}`,
        );
        console.log('  ✓ MCP store_node write acquired a semantic_neighbor edge to the seed');
        passed++;

        // The actual parity claim: with identical payloads the two surfaces
        // agree. Both directions were asserted above; this is the explicit
        // side-by-side verdict so a future regression on EITHER surface fails
        // one named check.
        assert.equal(
            restLinked, mcpLinked,
            `REST and MCP disagree on autolink for identical payloads (rest=${restLinked}, mcp=${mcpLinked})`,
        );
        console.log('  ✓ parity: REST and MCP produce the same autolink result for identical payloads');
        passed++;
    } catch (err) {
        failed = 1;
        console.error(`  ✗ ${(err as Error).message}`);
        if (h) console.error(`--- daemon log tail ---\n${h.log.text.slice(-3000)}`);
    } finally {
        cleanup(h);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
