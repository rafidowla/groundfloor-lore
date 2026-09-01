#!/usr/bin/env tsx
/**
 * stream-cloud-only-gate-e2e.ts — LIVE-DAEMON proof for the 2026-08-19 launch
 * decision: streaming ingest is CLOUD-ONLY. The warm-lane streaming surface
 * (POST /api/stream/connect + GET /api/stream/sessions) must refuse with a
 * structured 501 stream_ingest_cloud_only in local deployment mode — at
 * dispatch, before a session is opened or any event touches the outbox.
 *
 * Why this suite exists alongside the unit gate tests in S-streaming-unit.ts:
 * the unit tests drive tryStreamRoutes directly; this boots the REAL daemon
 * (isolated HOME, free port, --http, deploymentMode=local) and hits the real
 * HTTP transport, so the dispatcher's deploymentMode threading
 * (mcp/http/dispatcher.ts tryStreamRoutes call site) is exercised end to end.
 *
 * Embedded mode needs no live case here: runMode 'embedded' starts no HTTP
 * transport at all (mcp/server.ts main() returns before createServer), so the
 * route is unreachable from an embedded host by construction; the dispatcher-
 * level deploymentMode type is 'local' | 'cloud' and embedded collapses to
 * 'local' at the substrate level, so any future embedded HTTP path is still
 * caught by the same !== 'cloud' gate.
 *
 * No cloud-mode case by design — cloud is out of scope for this launch.
 *
 * Style mirrors mvp-live-e2e.ts (same spawn/poll helpers).
 */

import assert from 'node:assert/strict';
import { spawnDaemon, waitForReady, fetchAuthToken, cleanup, type DaemonHandle } from './helpers/live-daemon.js';

console.log('stream cloud-only gate E2E (local mode) — real daemon, real HTTP');

async function main(): Promise<void> {
    let h: DaemonHandle | null = null;
    try {
        h = await spawnDaemon();
        const ready = await waitForReady(h.port);
        assert.ok(ready, `daemon never became ready\nLOG:\n${h.log.text}`);
        h.token = await fetchAuthToken(h.port, h.home);
        const base = `http://127.0.0.1:${h.port}`;
        const authHdr = { Authorization: `Bearer ${h.token}`, Origin: base };

        // Sanity: this daemon really is the LOCAL deployment under test.
        const health = await (await fetch(`${base}/api/health`, { headers: { Origin: base } }))
            .json() as { deploymentMode?: string };
        assert.equal(health.deploymentMode, 'local', `expected local mode, got ${health.deploymentMode}`);

        /* ── 1. POST /api/stream/connect → 501 stream_ingest_cloud_only ── */
        // A fully-authenticated, workspace-qualified, well-formed request —
        // the gate (not auth, not validation) must be what refuses it.
        const connect = await fetch(`${base}/api/stream/connect?workspace=default`, {
            method: 'POST',
            headers: { ...authHdr, 'Content-Type': 'application/x-ndjson' },
            body: '{"payload":{"k":"v"}}\n',
        });
        assert.equal(connect.status, 501, `connect expected 501, got ${connect.status}`);
        const connectBody = await connect.text();
        const connectJson = JSON.parse(connectBody) as { code?: string; message?: string };
        assert.equal(connectJson.code, 'stream_ingest_cloud_only', `connect body: ${connectBody}`);
        assert.match(connectJson.message ?? '', /cloud-only/);

        // No session may have been opened: an accepted connect answers 200
        // chunked x-ndjson whose FIRST frame is {"type":"connected",
        // "sessionId":...}. The refused response is a single JSON error doc —
        // assert none of the session artifacts appear.
        assert.ok(!connectBody.includes('"connected"'), 'refused connect must not emit a connected frame');
        assert.ok(!connectBody.includes('sessionId'), 'refused connect must not mint a sessionId');
        assert.ok(
            !(connect.headers.get('content-type') ?? '').includes('x-ndjson'),
            `refused connect must not open an ndjson stream (content-type: ${connect.headers.get('content-type')})`,
        );

        // Outbox stays empty: a live session would have committed the event
        // via LocalStreamConsumer → recordHotWrite before any ack frame.
        const healthAfter = await (await fetch(`${base}/api/health`, { headers: { Origin: base } }))
            .json() as { outbox?: { depth?: number } };
        assert.equal(healthAfter.outbox?.depth ?? 0, 0, 'refused connect must not commit to the outbox');

        /* ── 2. GET /api/stream/sessions → 501, not an empty list ── */
        // A diagnostics listing for a feature that is fully OFF must not
        // answer 200 {count:0} — that would imply the feature half-exists.
        const sessions = await fetch(`${base}/api/stream/sessions?workspace=default`, { headers: authHdr });
        assert.equal(sessions.status, 501, `sessions expected 501, got ${sessions.status}`);
        const sessionsJson = await sessions.json() as { code?: string };
        assert.equal(sessionsJson.code, 'stream_ingest_cloud_only');

        /* ── 3. Gate precedes workspace validation ── */
        // No workspace param: Sprint L would answer 400 workspace_required on
        // a reachable route; the launch gate fires first.
        const noWs = await fetch(`${base}/api/stream/connect`, {
            method: 'POST',
            headers: { ...authHdr, 'Content-Type': 'application/x-ndjson' },
            body: '',
        });
        assert.equal(noWs.status, 501, `workspace-less connect expected 501, got ${noWs.status}`);

        console.log('  ok  /api/stream/connect refused 501 stream_ingest_cloud_only (no session, no outbox write)');
        console.log('  ok  /api/stream/sessions refused 501 (no empty-list implication)');
        console.log('  ok  gate fires before workspace_required');
        console.log('\nPASS — streaming surface is cloud-only on a live local daemon');
    } finally {
        cleanup(h);
    }
}

main().catch((e) => {
    console.error(`\nFAIL — ${(e as Error).message}`);
    process.exit(1);
});
