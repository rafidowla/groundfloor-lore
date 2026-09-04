#!/usr/bin/env tsx
/**
 * wave4-multi-app-isolation-e2e.ts — Wave 4.1 LOCAL-MODE WORKSPACE CONFINEMENT,
 * live-daemon adversarial multi-app isolation E2E.
 *
 * Companion to mvp-live-e2e.ts §3 (which proves the auth boundary for the
 * bootstrap token only). This proves the boundary holds for TWO independent
 * APP TOKENS bound to two DIFFERENT workspaces, driving the real public HTTP
 * surface against ONE live daemon — the load-bearing local-mode guarantee
 * that "workspace == database, token == app" actually confines an app to its
 * own data no matter what it asks for (URL segment, query param, body field,
 * or the X-Lore-Workspace header).
 *
 * Chokepoint under test: packages/lore/src/security/routeWorkspaceBinding.ts
 * (bindRouteTarget / bindDaemonOperatorLane / assertWorkspaceOpenAllowed),
 * wired at the edge in mcp/http/middleware.ts and installed per-request by
 * mcp/http/dispatcher.ts's runWithRouteBindingSlotIfLocal.
 *
 * SETUP: boot ONE local daemon with an isolated HOME. Create two workspaces,
 * ws-a and ws-b, via the bootstrap token. Seed each with a sentinel node.
 * Mint two app tokens directly into the daemon's own token registry (via
 * issueToken(), pointed at the daemon's LORE_HOME — the same registry file
 * the daemon's HTTP auth gate reads on every request, so no daemon restart
 * is needed for a freshly-minted token to become valid):
 *   - A     = workspace ws-a, scopes [read, write]           (no cross-* scopes)
 *   - B-RO  = workspace ws-b, scopes [read]                  (read-only, no write)
 *
 * MATRIX: token A attempts EVERY representative control-plane + data-plane
 * op against workspace ws-b (node write/read, workspace delete/rename/
 * retention, schema propose, sync push/pull, daemon restart/logs,
 * admin/stats, audit export) via each addressing vector (query param, body
 * field, URL segment, X-Lore-Workspace header) and MUST get 403
 * workspace_forbidden for every cross-workspace attempt, while A's
 * own-workspace ops succeed. B-RO (read-only) proves scope AND workspace are
 * both enforced.
 *
 * Assertions use a soft collector (record + continue) rather than throwing
 * `assert` calls, for one deliberate reason: the daemon-restart row (§ROW 4)
 * exercises a route that, if the confinement gate is defeated, causes the
 * live daemon to actually shut down (POST /api/daemon/restart -> 202 ->
 * requestShutdown()). A hard `assert.equal` there would abort the process
 * mid-suite via an uncaught throw racing the daemon's exit, losing every
 * later row's result. The restart probe is therefore ISOLATED and run LAST,
 * with an explicit abort-and-report if the daemon actually restarts, so a
 * regression there is reported precisely instead of taking the whole run
 * down with a confusing ECONNREFUSED cascade.
 *
 * No framework; same tsx-run + spawn-helper style as mvp-live-e2e.ts.
 */

import { spawnDaemon, waitForReady, fetchAuthToken, cleanup, type DaemonHandle } from './helpers/live-daemon.js';

let passed = 0;
let failed = 0;
const results: string[] = [];

function record(cond: boolean, label: string, detail?: string): void {
    // `detail` is passed as an already-evaluated string by every call site
    // below (template literals that may read a Response body). Bodies are
    // read AT MOST ONCE per response across this file — never re-read a
    // body already interpolated into a `record()` detail string.
    if (cond) {
        results.push(`  ✓ ${label}`);
        passed++;
    } else {
        results.push(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
        failed++;
    }
}

/** Hard precondition — setup steps that make the rest of the suite meaningless
 *  if they fail (can't mint tokens, can't create workspaces, etc). Throws. */
function must(cond: boolean, label: string): void {
    if (!cond) throw new Error(`precondition failed: ${label}`);
    results.push(`  ✓ ${label}`);
    passed++;
}

console.log('Wave 4 multi-app isolation E2E (local mode) — adversarial cross-workspace matrix over live HTTP');

async function main(): Promise<void> {
    let h: DaemonHandle | null = null;
    try {
        h = await spawnDaemon();
        const ready = await waitForReady(h.port);
        if (!ready) throw new Error(`daemon never became ready\nSTDERR:\n${h.log.text}`);
        h.token = await fetchAuthToken(h.port, h.home);
        const base = `http://127.0.0.1:${h.port}`;
        const origin = base;

        const hdr = (token: string, extra: Record<string, string> = {}) => ({
            Authorization: `Bearer ${token}`,
            Origin: origin,
            ...extra,
        });
        const jsonHdr = (token: string, extra: Record<string, string> = {}) => ({
            ...hdr(token, extra),
            'Content-Type': 'application/json',
        });
        const get = (token: string, p: string, extra: Record<string, string> = {}) =>
            fetch(`${base}${p}`, { headers: hdr(token, extra) });
        const postJson = (token: string, p: string, body: unknown, extra: Record<string, string> = {}) =>
            fetch(`${base}${p}`, { method: 'POST', headers: jsonHdr(token, extra), body: JSON.stringify(body) });
        const putJson = (token: string, p: string, body: unknown, extra: Record<string, string> = {}) =>
            fetch(`${base}${p}`, { method: 'PUT', headers: jsonHdr(token, extra), body: JSON.stringify(body) });
        const delReq = (token: string, p: string, extra: Record<string, string> = {}) =>
            fetch(`${base}${p}`, { method: 'DELETE', headers: hdr(token, extra) });

        // FINDING 4 (2026-09-03): deploymentMode is only in the Bearer-
        // authenticated /api/health body — an anonymous probe now gets the
        // lite liveness shape instead.
        const health = await (await fetch(`${base}/api/health`, { headers: hdr(h.token) })).json() as { deploymentMode?: string };
        must(health.deploymentMode === 'local', `daemon booted in local mode (got ${health.deploymentMode})`);

        /* ── SETUP: two workspaces + two app tokens ────────────────────────
         * Workspace CRUD is a daemon-operator-lane op (bindDaemonOperatorLane)
         * so it must go through the bootstrap token. */
        const wsA = 'wave4-ws-a';
        const wsB = 'wave4-ws-b';
        for (const name of [wsA, wsB]) {
            const mk = await postJson(h.token, '/api/workspaces', { name });
            must(mk.status === 200 || mk.status === 201, `create workspace ${name} via bootstrap (got ${mk.status})`);
        }

        /* ── Mint two app tokens directly into the daemon's own registry ───
         * issueToken() (auth/tokens.ts) writes SHA-256 hashes to
         * <LORE_HOME>/auth/registry.json — the exact file the daemon's HTTP
         * auth gate (resolveByPlaintext) reads on every request. No daemon
         * restart is needed: the registry is read fresh per lookup. Point
         * this PROCESS's LORE_HOME at the daemon's home (h.home/.groundfloor)
         * so issueToken writes into the SAME registry the daemon reads —
         * otherwise this test process's own isolated test-home (see
         * config/loreHome.ts's isTestProcess() branch) would get a token the
         * daemon never sees. */
        process.env['LORE_HOME'] = `${h.home}/.groundfloor`;
        const { issueToken } = await import('../packages/lore/src/auth/tokens.js');

        const tokenA = issueToken({ workspace: wsA, label: 'wave4-app-a', scopes: ['read', 'write'] }).token;
        const tokenBRO = issueToken({ workspace: wsB, label: 'wave4-app-b-ro', scopes: ['read'] }).token;
        must(true, 'minted app token A (ws-a, read+write) and B-RO (ws-b, read-only)');

        // Seed sentinel nodes via each token's OWN workspace (own-workspace
        // write — must succeed, and doubles as the "own ops succeed" proof).
        const seedA = await postJson(tokenA, '/api/node', {
            id: 'wave4-sentinel-a', type: 'note', label: 'sentinel A', content: 'lives only in ws-a', tags: 'wave4', workspace: wsA,
        });
        must(seedA.status === 200 || seedA.status === 201, `seed sentinel node in ws-a via A (got ${seedA.status})`);

        // B-RO cannot write (read-only) — seed ws-b's sentinel via a
        // short-lived FULL-scope token minted just for ws-b, so this works
        // regardless of which workspace the daemon itself booted into
        // (bootstrap is confined to ITS OWN boot workspace and holds no
        // cross-workspace scope, so it cannot be relied on to seed ws-b).
        const tokenBSeed = issueToken({ workspace: wsB, label: 'wave4-app-b-seed', scopes: ['read', 'write'] }).token;
        const seedB = await postJson(tokenBSeed, '/api/node', {
            id: 'wave4-sentinel-b', type: 'note', label: 'sentinel B', content: 'lives only in ws-b', tags: 'wave4', workspace: wsB,
        });
        must(seedB.status === 200 || seedB.status === 201, `seed sentinel node in ws-b via a full-scope ws-b token (got ${seedB.status})`);

        // Baseline snapshot of ws-b used to assert "bit-identical after" for
        // the isolation matrix below.
        const statsB = async (): Promise<{ nodeCount: number }> => {
            const r = await get(tokenBSeed, `/api/stats?workspace=${wsB}`);
            const j = await r.json() as { nodeCount?: number };
            return { nodeCount: j.nodeCount ?? -1 };
        };
        const retentionB = async (): Promise<string> => {
            const r = await get(tokenBSeed, `/api/workspaces/${wsB}/retention`);
            return r.status === 200 ? await r.text() : `<status ${r.status}>`;
        };
        const baselineStatsB = await statsB();
        const baselineRetentionB = await retentionB();
        must(baselineStatsB.nodeCount >= 1, 'ws-b baseline stats count the seeded sentinel');

        /* ══════════════════ ROW 1 — ISOLATION MATRIX ══════════════════════
         * Token A (ws-a) attacks ws-b through every vector. Every attempt
         * must 403 workspace_forbidden AND leave ws-b's state untouched. */
        const r1 = await postJson(tokenA, '/api/node', {
            id: 'wave4-a-writes-into-b', type: 'note', label: 'breach attempt', content: 'A tries to write into B via body field', tags: 'attack', workspace: wsB,
        });
        record(r1.status === 403, 'ROW 1a: A write into ws-b via body.workspace field must 403', `got ${r1.status} ${await r1.text().catch(() => '')}`);

        const r2 = await get(tokenA, `/api/node?id=wave4-sentinel-b&workspace=${wsB}`);
        record(r2.status === 403, 'ROW 1b: A read ws-b via ?workspace= query param must 403', `got ${r2.status}`);

        const r3 = await get(tokenA, `/api/stats?workspace=${wsB}`);
        record(r3.status === 403, 'ROW 1c: A stats on ws-b via ?workspace= must 403', `got ${r3.status}`);

        const r4 = await get(tokenA, `/api/workspaces/${wsB}/retention`);
        record(r4.status === 403, 'ROW 1d: A retention-read on ws-b via URL path segment must 403', `got ${r4.status}`);

        const r5 = await delReq(tokenA, `/api/workspaces/${wsB}`);
        record(r5.status === 403, 'ROW 1e: A delete ws-b via URL path segment must 403', `got ${r5.status}`);

        const r6 = await postJson(tokenA, '/api/workspaces/rename', { oldName: wsB, newName: 'wave4-hijacked' });
        record(r6.status === 403, 'ROW 1f: A rename ws-b via body fields must 403', `got ${r6.status}`);

        const afterStatsB = await statsB();
        const afterRetentionB = await retentionB();
        record(afterStatsB.nodeCount === baselineStatsB.nodeCount, 'ROW 1g: ws-b node count unchanged after the isolation matrix',
            `before=${baselineStatsB.nodeCount} after=${afterStatsB.nodeCount}`);
        record(afterRetentionB === baselineRetentionB, 'ROW 1h: ws-b retention policy unchanged after the isolation matrix');

        /* ══════════════════ ROW 2 — HEADER VECTOR AT THE EDGE ═════════════
         * X-Lore-Workspace: ws-b on a request authenticated as A must 403 at
         * the MIDDLEWARE layer, before any route (and therefore before any
         * audit-worthy side effect) runs. */
        const r7 = await get(tokenA, '/api/stats', { 'X-Lore-Workspace': wsB });
        record(r7.status === 403, 'ROW 2: X-Lore-Workspace naming a foreign workspace 403s at the edge', `got ${r7.status}`);
        if (r7.status === 403) {
            // Wave 5 cleanup (RC audit): middleware.ts's local-mode workspace
            // backstop now emits the canonical {code, message} envelope
            // (was {error, reason}). Same machine code string, moved field.
            const r7body = await r7.json() as { code?: string };
            record(r7body.code === 'workspace_forbidden', 'ROW 2b: edge denial code is workspace_forbidden', JSON.stringify(r7body));
        }

        /* ══════════════════ ROW 3 — DEFAULTING ═════════════════════════════
         * A with NO workspace anywhere lands in ws-a ONLY. */
        const r8 = await postJson(tokenA, '/api/node', {
            id: 'wave4-a-default-write', type: 'note', label: 'default write', content: 'no workspace specified anywhere',
        });
        record(r8.status === 200 || r8.status === 201, 'ROW 3a: A default write (no workspace anywhere) succeeds in own ws', `got ${r8.status} ${await r8.text().catch(() => '')}`);
        const readOwn = await get(tokenA, `/api/node?id=wave4-a-default-write&workspace=${wsA}`);
        record(readOwn.status === 200, 'ROW 3b: defaulted write is readable back from ws-a', `got ${readOwn.status}`);
        const afterDefaultStatsB = await statsB();
        record(afterDefaultStatsB.nodeCount === baselineStatsB.nodeCount, 'ROW 3c: defaulted write from A does NOT appear in ws-b');

        /* ══════════════════ ROW 4 — DAEMON-OPERATOR LANE (non-destructive) ─
         * Workspace CRUD / audit export / admin stats with an app token (A)
         * must 403; with bootstrap must 2xx; a read-only token (B-RO) must
         * 403 for a write op. Daemon restart/logs are probed separately,
         * LAST, in an isolated + guarded block below (see file header). */
        const rCreateA = await postJson(tokenA, '/api/workspaces', { name: 'wave4-illegit' });
        record(rCreateA.status === 403, 'ROW 4a: app token A creating a workspace must 403', `got ${rCreateA.status}`);

        const rCreateBoot = await postJson(h.token, '/api/workspaces', { name: 'wave4-legit-boot' });
        record(rCreateBoot.status === 200 || rCreateBoot.status === 201, 'ROW 4b: bootstrap creating a workspace must succeed', `got ${rCreateBoot.status} ${await rCreateBoot.text().catch(() => '')}`);

        const rAdminStatsA = await postJson(tokenA, '/api/admin/stats', {});
        record(rAdminStatsA.status === 403, 'ROW 4c: app token A must not reach cross-workspace /api/admin/stats', `got ${rAdminStatsA.status}`);

        const rAdminStatsBoot = await postJson(h.token, '/api/admin/stats', {});
        record(rAdminStatsBoot.status === 200, 'ROW 4d: bootstrap /api/admin/stats must succeed', `got ${rAdminStatsBoot.status}`);
        if (rAdminStatsBoot.status === 200) {
            const adminStatsBody = await rAdminStatsBoot.json() as { byWorkspace?: Record<string, unknown> };
            record(
                !!adminStatsBody.byWorkspace && wsA in adminStatsBody.byWorkspace && wsB in adminStatsBody.byWorkspace,
                'ROW 4e: bootstrap /api/admin/stats enumerates both ws-a and ws-b',
                JSON.stringify(adminStatsBody.byWorkspace),
            );
        }

        const rAuditA = await get(tokenA, '/api/audit?tail=5');
        record(rAuditA.status === 403, 'ROW 4f: app token A must not reach the daemon-wide audit export', `got ${rAuditA.status}`);
        const rAuditBoot = await get(h.token, '/api/audit?tail=5');
        record(rAuditBoot.status === 200, 'ROW 4g: bootstrap audit export must succeed', `got ${rAuditBoot.status}`);

        const rDeleteBRO = await delReq(tokenBRO, `/api/workspaces/${wsA}`);
        record(rDeleteBRO.status === 403, 'ROW 4h: read-only B-RO deleting ws-a must 403 (no write scope)', `got ${rDeleteBRO.status}`);

        /* ══════════════════ ROW 5 — SYNC (Wave 4.3) ════════════════════════
         * POST /api/sync/push with A drains ws-a's WAL only; A targeting
         * ws-b via ?workspace= 403s; B-RO's own-workspace status reads
         * succeed, cross-workspace status reads 403. */
        const rSyncPushA = await postJson(tokenA, '/api/sync/push', {});
        record(rSyncPushA.status === 200, 'ROW 5a: A sync push on its own workspace succeeds', `got ${rSyncPushA.status} ${await rSyncPushA.text().catch(() => '')}`);

        const rSyncPushCross = await postJson(tokenA, `/api/sync/push?workspace=${wsB}`, {});
        record(rSyncPushCross.status === 403, 'ROW 5b: A sync push targeting ws-b must 403', `got ${rSyncPushCross.status}`);

        const rSyncStatusOwn = await get(tokenBRO, `/api/sync/status?workspace=${wsB}`);
        record(rSyncStatusOwn.status === 200, 'ROW 5c: B-RO sync status on its own workspace succeeds', `got ${rSyncStatusOwn.status}`);

        const rSyncStatusCross = await get(tokenBRO, `/api/sync/status?workspace=${wsA}`);
        record(rSyncStatusCross.status === 403, 'ROW 5d: B-RO sync status on ws-a must 403', `got ${rSyncStatusCross.status}`);

        /* ══════════════════ ROW 6 — SCHEMA (Wave 4.2) ══════════════════════
         * propose with A + ?workspace=ws-b -> 403 (scope, A has no
         * cross-workspace-read/write and ws-b isn't A's own workspace); a
         * FULL-scope non-boot-workspace token targeting its OWN (non-boot)
         * workspace -> 409 schema_workspace_not_active (4.2 Step-1 honest
         * refusal, since schema authoring is still boot-workspace-only). */
        const rSchemaProposeA = await postJson(tokenA, `/api/schema/proposals?workspace=${wsB}`, {
            kind: 'node_type.added', target: 'know.Wave4Probe', proposedBy: 'human:wave4-e2e',
        });
        record(rSchemaProposeA.status === 403, 'ROW 6a: A schema-propose targeting ws-b must 403 (scope)', `got ${rSchemaProposeA.status} ${await rSchemaProposeA.text().catch(() => '')}`);

        const rSchemaProposeOwn = await postJson(tokenBSeed, `/api/schema/proposals?workspace=${wsB}`, {
            kind: 'node_type.added', target: 'know.Wave4Probe', proposedBy: 'human:wave4-e2e',
        });
        const schemaProposeOwnBody = await rSchemaProposeOwn.text();
        record(rSchemaProposeOwn.status === 409, 'ROW 6b: full-scope token proposing on its OWN non-boot workspace must 409 schema_workspace_not_active', `got ${rSchemaProposeOwn.status} ${schemaProposeOwnBody}`);
        if (rSchemaProposeOwn.status === 409) {
            // schema.ts's 409 goes through writeError() (helpers.ts), whose wire
            // shape is {code, message, ...extras} — NOT the {error, reason}
            // envelope bindRouteTarget/bindDaemonOperatorLane use. Assert the
            // shape this route actually emits.
            const schemaBody = JSON.parse(schemaProposeOwnBody) as { code?: string };
            record(schemaBody.code === 'schema_workspace_not_active', 'ROW 6c: 409 body carries schema_workspace_not_active', JSON.stringify(schemaBody));
        }

        /* ══════════════════ ROW 7 — OWN-WORKSPACE OPS SUCCEED ══════════════
         * Every op A attempted against ws-b above must succeed when A
         * targets its OWN workspace ws-a — proves the matrix is testing
         * confinement, not just blanket denial. */
        const rOwnRetention = await get(tokenA, `/api/workspaces/${wsA}/retention`);
        record(rOwnRetention.status === 200, 'ROW 7a: A reading its OWN workspace retention succeeds', `got ${rOwnRetention.status}`);

        const rOwnStats = await get(tokenA, `/api/stats?workspace=${wsA}`);
        record(rOwnStats.status === 200, 'ROW 7b: A reading its OWN workspace stats succeeds', `got ${rOwnStats.status}`);

        const rOwnRetentionPatch = await putJson(tokenBSeed, `/api/workspace/retention`, { hideSupersededInRecall: true });
        record(rOwnRetentionPatch.status === 200, 'ROW 7c: full-scope ws-b token patching its own active-workspace retention succeeds', `got ${rOwnRetentionPatch.status}`);

        /* ══════════════════ ROW 8 — DAEMON RESTART / LOGS (isolated, LAST) ─
         * Run last and guarded: if the confinement gate is defeated for
         * these two daemon-wide, workspace-less ops, POST /api/daemon/restart
         * actually shuts the daemon down (202 -> requestShutdown()), which
         * would otherwise take the rest of the suite down with it. Probe logs
         * FIRST (harmless either way), then restart LAST. */
        const rLogsA = await get(tokenA, '/api/daemon/logs?tail=5');
        record(rLogsA.status === 403, 'ROW 8a: app token A must not be able to read daemon logs', `got ${rLogsA.status}`);

        const rLogsBoot = await get(h.token, '/api/daemon/logs?tail=5');
        record(rLogsBoot.status === 200, 'ROW 8b: bootstrap can read daemon logs', `got ${rLogsBoot.status}`);

        const rRestartA = await postJson(tokenA, '/api/daemon/restart', {});
        if (rRestartA.status === 403) {
            record(true, 'ROW 8c: app token A must not be able to restart the daemon');
            // Canary: daemon must still be alive (it correctly refused).
            const stillAlive = await waitForReady(h.port, 3000);
            record(stillAlive, 'ROW 8d: daemon still alive/answering after the denied restart attempt');
        } else {
            // GENUINE GAP, not a test bug: bindDaemonOperatorLane({ intent:
            // 'write' }) with NO `requested` degenerates to
            // requireWriteToWorkspace(principal, principal.workspace), which
            // trivially passes for ANY write-scoped app token (it's checking
            // the token against ITS OWN workspace). Daemon-wide, workspace-
            // less ops (restart, logs) need a stronger gate than the
            // generic daemon-operator lane provides when called with no
            // `requested` target — e.g. require principal.kind !== 'app', or
            // require cross-workspace-write unconditionally for these two
            // routes specifically.
            record(false, 'ROW 8c: app token A must not be able to restart the daemon',
                `got ${rRestartA.status} — CONFIRMED GAP: bindDaemonOperatorLane({intent:'write'}) with no ` +
                `'requested' target lets ANY write-scoped app token through (target defaults to the token's ` +
                `own workspace, which trivially self-authorizes). The daemon has now been told to restart; ` +
                `remaining assertions are skipped.`);
        }

        for (const line of results) console.log(line);
    } catch (err) {
        failed += 1;
        console.error(`  ✗ ${(err as Error).message}`);
        for (const line of results) console.log(line);
        if (h) console.error(`--- daemon log tail ---\n${h.log.text.slice(-3000)}`);
    } finally {
        cleanup(h);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
