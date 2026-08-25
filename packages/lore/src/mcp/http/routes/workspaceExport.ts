/**
 * workspaceExport.ts — local-daemon workspace EXPORT route: the local half of
 * the supported local-workspace → arcade-cell migration
 * (spike/arcadedb-multitenant, Slice 4).
 *
 *   GET /api/workspaces/:name/export
 *
 * Emits an NDJSON bundle (Content-Type application/x-ndjson): line 1 a manifest,
 * then typed node / edge / verbatim lines. The bundle is the contract consumed
 * by the arcade-daemon import route (mcp/http/routes/arcadeMigrate.ts).
 *
 * ── GATES ────────────────────────────────────────────────────────────────────
 *   - D-021: a concrete target is resolved via bindRouteTarget({requested:name,
 *     intent:'read'}) — never `undefined` (no literal-undefined scope gate). A
 *     workspace token bound to a DIFFERENT workspace 403s here.
 *   - CONSISTENCY PRECONDITION: refuse (409 outbox_not_drained) when the
 *     workspace has pending/failed outbox rows — otherwise the export would
 *     snapshot a graph ahead of its vectors.
 *
 * ── STREAMING BODY ───────────────────────────────────────────────────────────
 * Once both gates pass we stream the bundle as NDJSON. Reads are the same
 * single-writer-consistent reads recall uses:
 *   - nodes:    graph.listNodes(unbounded) — full LoreNode rows incl. lifecycle
 *               columns (supersededBy/staleAt/ephemeral/ttl_ms travel verbatim).
 *   - edges:    graph.queryEdges({limit,offset}) paginated to completion.
 *   - verbatim: the workspace's VerbatimStore.exportRows() — canonical rows with
 *               their RAW stored embedding vectors, so the import CARRIES them
 *               byte-identically (zero re-embed, identical recall ranking) when
 *               the manifest's embedModelId+dim match the cell embedder.
 *
 * The manifest's embedModelId/embedDim come from the workspace VerbatimStore's
 * own embedder — that is the carry/re-embed decision key the import route reads.
 * Counts are computed BEFORE the body is written (headers-first), so a consumer
 * can validate imported == manifest.counts.
 *
 * If the workspace has no graph registry / verbatim resolver wired (e.g. cloud
 * mode), the route 501s rather than emit an empty-but-valid bundle that would
 * look like a successful export of an empty workspace.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { writeError } from '../helpers.js';
import type { OutboxStore } from '../../../outbox/types.js';
import type { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import type { WorkspaceVerbatimResolver } from '../../../outbox/workspaceVerbatimResolver.js';
import type { LoreNode, LoreEdge } from '../../../providers/types.js';

export interface WorkspaceExportDeps {
    /** The daemon relational-lane outbox — for the drain precondition. */
    outboxStore?: OutboxStore;
    /** Per-workspace graph resolver (local mode). Absent in cloud mode. */
    graphRegistry?: LocalGraphRegistry;
    /** Per-workspace verbatim resolver (local mode). Absent in cloud mode. */
    verbatimResolver?: WorkspaceVerbatimResolver;
}

const EDGE_PAGE = 1000;

/**
 * tryWorkspaceExportRoutes — mounts GET /api/workspaces/:name/export. Returns
 * true when it OWNED the request, false to fall through.
 */
export async function tryWorkspaceExportRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    deps: WorkspaceExportDeps,
): Promise<boolean> {
    const m = /^\/api\/workspaces\/([^/]+)\/export$/.exec(pathname);
    if (!m) return false;
    const method = req.method ?? 'GET';
    if (method !== 'GET') {
        writeError(res, 405, 'method_not_allowed', `${method} not allowed on ${pathname}`);
        return true;
    }
    const name = decodeURIComponent(m[1] ?? '');

    // D-021 — resolve a CONCRETE target (never literal-undefined). A workspace
    // token bound to a different workspace 403s here; bindRouteTarget writes the
    // denial envelope and returns null.
    const target = bindRouteTarget(res, { requested: name, intent: 'read' });
    if (target === null) return true;

    // CONSISTENCY PRECONDITION — refuse when the workspace still has pending or
    // failed outbox rows: the export would snapshot a graph ahead of its
    // vectors. Drain first, then re-export.
    if (deps.outboxStore?.listPendingForWorkspace) {
        const pending = await deps.outboxStore.listPendingForWorkspace(target, 1);
        if (pending.length > 0) {
            writeError(
                res,
                409,
                'outbox_not_drained',
                `workspace "${target}" has un-drained outbox rows; drain them before exporting ` +
                    `(the export would snapshot the graph ahead of its vectors)`,
            );
            return true;
        }
    }

    // The streaming body needs the per-workspace substrates. Without them (cloud
    // mode / unwired) fail LOUD rather than emit an empty-looking bundle.
    if (!deps.graphRegistry || !deps.verbatimResolver) {
        writeError(
            res,
            501,
            'export_not_implemented',
            `workspace export requires the local graph + verbatim resolvers, which are not ` +
                `wired in this deployment mode`,
        );
        return true;
    }

    // ── Gather everything BEFORE writing headers ─────────────────────────────
    // We read the full node/edge/verbatim sets up front so (a) any read error
    // surfaces as a clean 5xx envelope instead of a truncated NDJSON stream, and
    // (b) the manifest can carry exact counts (headers-first).
    let nodes: LoreNode[];
    let edges: LoreEdge[];
    let verbatim: { modelId: string; dim: number; rows: Array<{ id: string; text: string; embedding: number[]; contentHash: string; metadata: Record<string, unknown> }> };
    try {
        const graph = await deps.graphRegistry.getGraphHandle(target);
        nodes = await graph.listNodes(undefined, undefined, '*', '*', undefined, { unbounded: true });
        edges = [];
        for (let offset = 0; ; offset += EDGE_PAGE) {
            const page = await graph.queryEdges({ limit: EDGE_PAGE, offset });
            edges.push(...page);
            if (page.length < EDGE_PAGE) break;
        }
        const vstore = await deps.verbatimResolver.getOrOpen(target);
        verbatim = await vstore.exportRows({ project: target });
    } catch (err) {
        // A missing workspace throws workspace_not_found here (getWorkspacePath).
        const msg = (err as Error).message || 'export read failed';
        if (/workspace_not_found|not.*found/i.test(msg)) {
            writeError(res, 404, 'workspace_not_found', `workspace "${target}" not found`);
        } else {
            writeError(res, 500, 'export_failed', `failed to read workspace "${target}" for export: ${msg}`);
        }
        return true;
    }

    // ── Stream the NDJSON bundle ─────────────────────────────────────────────
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
    });

    const write = (obj: unknown): void => {
        res.write(JSON.stringify(obj) + '\n');
    };

    write({
        kind: 'manifest',
        formatVersion: 1,
        workspace: target,
        exportedAt: new Date().toISOString(),
        embedModelId: verbatim.modelId,
        embedDim: verbatim.dim,
        counts: { nodes: nodes.length, edges: edges.length, verbatim: verbatim.rows.length },
    });

    for (const node of nodes) {
        write({ kind: 'node', ...node });
    }
    for (const e of edges) {
        write({
            kind: 'edge',
            sourceId: e.sourceId,
            targetId: e.targetId,
            relation: e.relation,
            ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
            ...(e.confidenceScore !== undefined ? { confidenceScore: e.confidenceScore } : {}),
        });
    }
    for (const r of verbatim.rows) {
        write({
            kind: 'verbatim',
            id: r.id,
            text: r.text,
            metadata: r.metadata,
            contentHash: r.contentHash,
            embedding: r.embedding,
            embedModelId: verbatim.modelId,
        });
    }

    res.end();
    return true;
}
