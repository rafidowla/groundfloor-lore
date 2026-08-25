/**
 * verbatim.ts — verbatim-store lifecycle routes.
 *
 *   POST /api/verbatim/reap       — find/reap orphan verbatim rows
 *   POST /api/verbatim/tombstone  — manually tombstone one row
 *   GET  /api/verbatim/get        — single canonical row read
 *   GET  /api/verbatim/history    — revision history for a row
 *   POST /api/verbatim            — store_verbatim REST sibling
 *   GET  /api/verbatim/search     — search_verbatim REST sibling
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerbatimStore } from '../../../../engines/verbatimStore.js';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { isPayloadTooLarge, writeOversizeError, writeError } from '../../helpers.js';
import { resolveTargetGraph } from '../../../tools/workspaceResolve.js';
import { bindRouteTarget, isLegacyBypass } from '../../../../security/routeWorkspaceBinding.js';
import { type RetentionDeps, readBody } from './shared.js';
import { redactError } from '../../../../security/logRedact.js';
import { assertSafeVerbatimId, isRevisionHistoryId } from '../../../../engines/verbatimHistory.js';
import { hybridVerbatimSearch } from '../../../../engines/verbatimHybridSearch.js';

/** Returns true once a response has been written. */
export async function tryVerbatimRoutes(req: IncomingMessage, res: ServerResponse, url: string, deps: RetentionDeps, pathname: string): Promise<boolean> {
    if (pathname === '/api/verbatim/reap' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'delete' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode, so without this a read-only app token could invoke this
        // mutating route. RA2-reaudit2 — reap/tombstone operate on the
        // BOOT/active verbatim store (deps.store.loreVerbatim), so bind to the
        // active workspace, not the caller's own (dropping the prior boot-scope
        // leak of passing detectedScope.workspace straight to the raw gate).
        // The pure legacy/direct-call bypass (no principal, no slot, no
        // requested workspace) is the ONE case bindRouteTarget returns null
        // without writing a denial — reap/tombstone then fall through to
        // deps.store.loreVerbatim (the boot store) regardless. Detect it up
        // front so a real denial (null after a written 4xx) is never mistaken
        // for it; never depend on res.headersSent (stub responses don't track).
        if (!isLegacyBypass(deps.detectedScope?.workspace) &&
            bindRouteTarget(res, { requested: deps.detectedScope?.workspace, intent: 'write' }) === null) return true;
        let body: string;
        try {
            body = await readBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'bad_request', redactError(err));
            return true;
        }
        try {
            const parsed = JSON.parse(body || '{}') as { apply?: boolean; prefix?: string };
            const prefix = parsed.prefix ?? 'lore:';
            const apply = parsed.apply === true;
            const store = deps.store.loreVerbatim as unknown as {
                listIds?: (p?: string) => Promise<string[]>;
                tombstone?: (id: string, reason: string) => Promise<void>;
            };
            if (typeof store.listIds !== 'function' || typeof store.tombstone !== 'function') {
                writeError(res, 501, 'not_supported', 'reap not supported by current vector store backend');
                return true;
            }
            // SP-21: cap to prevent 100k+ serial getNode round-trips in one request.
            // Reap is idempotent — re-call with a different prefix or repeat until
            // the response contains no orphans to process the full corpus in batches.
            const REAP_PAGE_CAP = 10_000;
            const rawIds = await store.listIds(prefix);
            const allIds = rawIds.length > REAP_PAGE_CAP ? rawIds.slice(0, REAP_PAGE_CAP) : rawIds;
            const reapTruncated = rawIds.length > REAP_PAGE_CAP;
            const orphans: string[] = [];
            let alive = 0;
            for (const vid of allIds) {
                // Skip history snapshots — only the canonical row presence
                // determines whether the node has a live counterpart in
                // the graph. Anchored suffix match (audit 5.6): an id merely
                // CONTAINING '#rev' (URL fragment etc.) is canonical.
                if (isRevisionHistoryId(vid)) continue;
                // Only `lore:`-prefixed rows are graph-node-derived (the
                // node write path always keys the verbatim row
                // `lore:<nodeId>`), so only those can be orphans OF THE
                // GRAPH. Everything else — namespaced ids (symbol:, file:)
                // AND bare ids such as the content-hash ids store_verbatim's
                // own docs recommend — belongs to the direct-write caller,
                // who never created a graph node for it BY DESIGN.
                // Audit cluster 5 (2026-08-17): previously a bare id fell
                // through to getNode(id) → null → "orphan" → tombstoned,
                // silently destroying every direct store_verbatim document.
                const isLore = vid.startsWith('lore:');
                if (!isLore) {
                    alive++;
                    continue;
                }
                const nid = vid.slice('lore:'.length);
                const node = await deps.store.storageClient.getNode(nid);
                if (node == null) orphans.push(vid);
                else alive++;
            }
            let tombstoned = 0;
            let tombstoneFailed = 0;
            if (apply) {
                for (const id of orphans) {
                    // 1.M10 — tombstone() now throws on real failures;
                    // isolate per row and surface the count rather than
                    // aborting the reap or reading as success.
                    try {
                        await store.tombstone(id, 'graph node missing — discovered via /api/verbatim/reap');
                        tombstoned++;
                    } catch (tErr) {
                        tombstoneFailed++;
                        console.error(`[Lore HTTP] reap tombstone failed for ${id}: ${redactError(tErr)}`);
                    }
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                prefix,
                apply,
                inspected: allIds.length,
                alive,
                orphans: orphans.length,
                tombstoned,
                ...(tombstoneFailed > 0 ? { tombstone_failed: tombstoneFailed } : {}),
                sample: orphans.slice(0, 20),
                ...(reapTruncated ? { truncated: true, totalIds: rawIds.length } : {}),
            }));
        } catch (reapErr) {
            writeError(res, 500, 'internal_error', redactError(reapErr));
        }
        return true;
    }

    // Manually tombstone a verbatim row. Used by admin / cleanup flows
    // that need to mark content superseded without going through the
    // graph delete_node path. POST body: { id, reason }.
    if (pathname === '/api/verbatim/tombstone' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'delete' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode, so without this a read-only app token could invoke this
        // mutating route. RA2-reaudit2 — reap/tombstone operate on the
        // BOOT/active verbatim store (deps.store.loreVerbatim), so bind to the
        // active workspace, not the caller's own. The pure legacy/direct-call
        // bypass is the ONE null-without-denial case — tombstone then falls
        // through to the boot store regardless. Detect it up front; never depend
        // on res.headersSent (stub responses don't track it).
        if (!isLegacyBypass(deps.detectedScope?.workspace) &&
            bindRouteTarget(res, { requested: deps.detectedScope?.workspace, intent: 'write' }) === null) return true;
        let body: string;
        try {
            body = await readBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'bad_request', redactError(err));
            return true;
        }
        try {
            const parsed = JSON.parse(body || '{}') as { id?: string; reason?: string };
            if (!parsed.id) {
                writeError(res, 400, 'invalid_request', '`id` is required in POST body');
                return true;
            }
            const store = deps.store.loreVerbatim as unknown as { tombstone?: (id: string, reason: string) => Promise<void> };
            if (typeof store.tombstone !== 'function') {
                writeError(res, 501, 'not_supported', 'tombstone not supported by current vector store backend');
                return true;
            }
            await store.tombstone(parsed.id, parsed.reason ?? 'manual tombstone via /api/verbatim/tombstone');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, id: parsed.id }));
        } catch (tsErr) {
            writeError(res, 500, 'internal_error', redactError(tsErr));
        }
        return true;
    }

    // V2 (Sprint V) — single verbatim row read. Symmetric MCP sibling
    // is `get_verbatim`. Returns the stored text + contentHash for one
    // canonical id (e.g. `lore:my-decision`), or 404 if the row doesn't
    // exist. Differs from /api/verbatim/history (which returns every
    // revision); this returns just the current canonical content.
    //   GET /api/verbatim/get?id=<canonicalId>
    if (pathname === '/api/verbatim/get' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // R3 #1/D-021 — get reads the boot/active workspace's verbatim store;
        // bind to the active workspace (not the caller's own) so a
        // foreign-workspace token cannot read it. The pure legacy/direct-call
        // bypass is the ONE null-without-denial case — get then falls through to
        // the boot store regardless. Detect it up front; never depend on
        // res.headersSent (stub responses don't track it — that was masking a
        // real cross-workspace 403).
        if (!isLegacyBypass(deps.detectedScope?.workspace) &&
            bindRouteTarget(res, { requested: deps.detectedScope?.workspace, intent: 'read' }) === null) return true;
        try {
            const getParams = new URL(url, 'http://localhost').searchParams;
            const getId = getParams.get('id') ?? '';
            if (!getId) {
                writeError(res, 400, 'invalid_request', '`id` query param is required (canonical verbatim id, e.g. lore:my-decision)');
                return true;
            }
            const store = deps.store.loreVerbatim as unknown as VerbatimStore;
            if (typeof store.getById !== 'function') {
                writeError(res, 501, 'not_supported', 'verbatim get not supported by current vector store backend');
                return true;
            }
            const row = await store.getById(getId);
            if (!row) {
                // Not a `writeError` case: this is a data-shaped 404 payload
                // (`found: false`) that callers pattern-match on, not the
                // canonical error envelope. Status code (404) is unchanged.
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ found: false, id: getId }));
                return true;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                found: true,
                id: getId,
                text: row.text ?? '',
                contentHash: row.contentHash ?? '',
            }));
        } catch (getErr) {
            writeError(res, 500, 'internal_error', redactError(getErr));
        }
        return true;
    }

    // Verbatim revision history. Returns the canonical row
    // (current/tombstone) plus every prior `<id>#rev*` snapshot, newest
    // first. Used by the UI history panel and by audit / "what changed
    // and why" lookups.
    //   GET /api/verbatim/history?id=<canonicalId>
    if (pathname === '/api/verbatim/history' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // R3 #1/D-021 — history reads the boot/active store; bind to the active
        // workspace. The pure legacy/direct-call bypass is the ONE null-without-
        // denial case — history then falls through to the boot store regardless.
        // Detect it up front; never depend on res.headersSent (stub responses
        // don't track it — that was masking a real cross-workspace 403).
        if (!isLegacyBypass(deps.detectedScope?.workspace) &&
            bindRouteTarget(res, { requested: deps.detectedScope?.workspace, intent: 'read' }) === null) return true;
        try {
            const histParams = new URL(url, 'http://localhost').searchParams;
            const histId = histParams.get('id') ?? '';
            if (!histId) {
                writeError(res, 400, 'invalid_request', '`id` query param is required (canonical verbatim id, e.g. lore:my-decision)');
                return true;
            }
            const store = deps.store.loreVerbatim as unknown as VerbatimStore;
            if (typeof store.getHistory !== 'function') {
                writeError(res, 501, 'not_supported', 'history not supported by current vector store backend');
                return true;
            }
            const revisions = await store.getHistory(histId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: histId, revisions, count: revisions.length }));
        } catch (histErr) {
            writeError(res, 500, 'internal_error', redactError(histErr));
        }
        return true;
    }

    // store_verbatim REST sibling.
    //   POST /api/verbatim
    //   body: { id, text, workspace, source?, label?, tags?, sourceCreatedAt? }
    if (pathname === '/api/verbatim' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode, so without this a read-only app token could invoke this
        // mutating route. The bind is applied AFTER the body is parsed (below),
        // on the REQUESTED workspace `p.workspace` (the actual write target via
        // resolveTargetGraph), not the caller's own. Null principal =
        // local/legacy bypass (preserved).
        let body: string;
        try { body = await readBody(req); }
        catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'bad_request', redactError(err));
            return true;
        }
        try {
            const p = JSON.parse(body || '{}') as {
                id?: string; text?: string; workspace?: string;
                source?: string; label?: string; tags?: string; sourceCreatedAt?: string;
            };
            if (!p.id || !p.text || !p.workspace) {
                writeError(res, 400, 'invalid_request', 'id, text, workspace required');
                return true;
            }
            // 2.5 — reject 'lore:' namespace + '#rev' suffix (direct write must
            // not overwrite a node's canonical row or forge revision history).
            try {
                assertSafeVerbatimId(p.id, 'POST /api/verbatim');
            } catch (err) {
                writeError(res, 400, 'invalid_verbatim_id', redactError(err));
                return true;
            }
            // RA2-reaudit2 — bind to the REQUESTED workspace (the
            // resolveTargetGraph target below). Binding on the caller's own
            // (default) let an A-scoped token store_verbatim into workspace B.
            if (bindRouteTarget(res, { requested: p.workspace, intent: 'write' }) === null) return true;
            const doc = {
                id: p.id, text: p.text,
                metadata: { type: p.source, label: p.label, tags: p.tags, updatedAt: p.sourceCreatedAt },
            };
            // L-012/L-026 — write to the REQUESTED workspace's LanceDB
            // (Postgres-model isolation), mirroring the GET /api/verbatim/search
            // sibling + MCP store_verbatim. resolveTargetGraph validates the
            // workspace; the resolver opens its VerbatimStore. Fall back to the
            // boot store when no registry/resolver (cloud/tests).
            const resolvedStore = await resolveTargetGraph(
                deps.store, deps.graphRegistry, deps.detectedScope?.workspace ?? '', p.workspace,
            );
            if (!resolvedStore.ok) {
                if ('missing' in resolvedStore) {
                    writeError(res, 400, 'workspace_required', 'pass workspace=<name> as body field or query param');
                    return true;
                }
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${resolvedStore.requested}`, { requested: resolvedStore.requested, known: resolvedStore.known });
                return true;
            }
            if (deps.workspaceVerbatimResolver) {
                const ws = await deps.workspaceVerbatimResolver.getOrOpen(resolvedStore.resolvedWorkspace);
                await ws.store(doc);
            } else {
                await deps.store.storageClient.verbatimStore(doc);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, id: p.id }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    // search_verbatim REST sibling.
    //   GET /api/verbatim/search?q=<query>&workspace=X&limit=N&includeText=true
    if (pathname === '/api/verbatim/search' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const qp = new URL(url, 'http://localhost').searchParams;
            const q = qp.get('q') ?? '';
            const workspace = qp.get('workspace') ?? '';
            const limitRaw = parseInt(qp.get('limit') ?? '10', 10);
            const limit = Math.min(isNaN(limitRaw) ? 10 : Math.max(1, limitRaw), 100);
            const includeText = qp.get('includeText') !== 'false';
            if (!q || !workspace) {
                writeError(res, 400, 'invalid_request', 'q and workspace query params required');
                return true;
            }
            // R3 #1/D-021 — search routes to the REQUESTED workspace's store;
            // bind so a foreign-workspace token cannot pass workspace=<other>
            // and read it.
            if (bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null) return true;
            // L-012 — route the search to the REQUESTED workspace's verbatim
            // store (Postgres-model isolation), not the boot/active store.
            // resolveTargetGraph validates the workspace name and, when the
            // registry is absent (cloud / tests), returns the boot store so
            // behavior is unchanged. Then read the workspace's LanceDB via the
            // verbatim resolver (mirrors memory/deleteNode.ts), falling back to
            // the boot singleton when no resolver is wired.
            const activeWs = deps.detectedScope?.workspace ?? '';
            const resolvedSearch = await resolveTargetGraph(
                deps.store, deps.graphRegistry, activeWs, workspace,
            );
            if (!resolvedSearch.ok) {
                if ('missing' in resolvedSearch) {
                    writeError(res, 400, 'workspace_required', 'pass workspace=<name> as a query param');
                    return true;
                }
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${resolvedSearch.requested}`, { requested: resolvedSearch.requested, known: resolvedSearch.known });
                return true;
            }
            const targetVerbatim = deps.workspaceVerbatimResolver
                ? await deps.workspaceVerbatimResolver.getOrOpen(resolvedSearch.resolvedWorkspace)
                : deps.store.loreVerbatim;
            const searchStore = targetVerbatim as unknown as VerbatimStore | undefined;
            // Cluster-5 medium (2026-08-18) — this route is documented as
            // hybrid BM25+vector but only ran the vector half. Fuse both
            // scorers (RRF; unranked BM25 fallbacks contribute nothing).
            const usable = searchStore && typeof searchStore.search === 'function';
            type VerbatimSearchHit = { id: string; score: number; text: string; metadata: Record<string, unknown> | null };
            const hits = await hybridVerbatimSearch<VerbatimSearchHit>(
                usable
                    ? (searchStore as never)
                    : {
                        search: (q: string, l: number) => deps.store.storageClient.verbatimSearch(q, l),
                        bm25Search: (q: string, l: number) => deps.store.storageClient.verbatimBm25Search(q, l),
                    } as never,
                q, limit,
            );
            const rows = hits.map((f) => ({
                id: f.hit.id,
                score: f.score,
                text: includeText ? f.hit.text : undefined,
                snippet: includeText ? undefined : f.hit.text.slice(0, 240),
                source: (f.hit.metadata as Record<string, unknown> | null | undefined)?.['type'],
                label: (f.hit.metadata as Record<string, unknown> | null | undefined)?.['label'],
                matchedBy: f.matchedBy,
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ workspace, query: q, count: rows.length, rows }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    return false;
}
