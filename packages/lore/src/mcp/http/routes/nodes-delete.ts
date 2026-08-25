/**
 * nodes-delete.ts — W8: DELETE /api/node/:id
 *
 * REST sibling of the MCP `delete_node` tool. Hard-deletes a graph
 * node + all its edges and writes an append-only verbatim tombstone
 * at `lore:<id>` so prior content stays recallable for history /
 * audit / undo. Same workspace routing as POST /api/node.
 *
 * Lives in its own file so `nodes.ts` (which carries GET/POST/
 * supersession family) can stay under the 800-line file-size cap.
 *
 * URL: `DELETE /api/node/<id-url-encoded>?workspace=<ws>`
 *   - id is percent-decoded (handles `:` `/` in node ids).
 *   - `lore:` prefix on the id is stripped before graph lookup;
 *     re-added for the verbatim tombstone (matches MCP behavior).
 *
 * Reserved sub-paths (`/api/node/supersede` etc.) are POST/GET-only,
 * but we still explicitly skip them so a future DELETE method on a
 * sibling family doesn't accidentally interpret the suffix as a
 * node id.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import { LocalGraphRegistry, WorkspaceNotFoundError } from '../../../engines/localGraphRegistry.js';
import type { AuditLog } from '../../../security/audit.js';
import { redactId, redactError } from '../../../security/logRedact.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { writeWorkspaceRequired, checkOutboxBackpressure, writeJson, writeError } from '../helpers.js';
import type { OutboxStore } from '../../../outbox/types.js';
import { recordHotWrite } from '../../../outbox/hotLane.js';
import type { OutboxLagCache } from '../../../outbox/lagCache.js';
import type { WorkspaceVerbatimResolver } from '../../../outbox/workspaceVerbatimResolver.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';

// Widened for the Kùzu removal: naming the two CONCRETE classes silently
// excluded SurrealGraph (see engines/htmlExport.ts). Need more than the
// shared handle? Feature-detect and refuse — do not re-narrow to a class.
type LoreGraph = LoreGraphHandle;

export interface NodeDeleteDeps {
    store: StorageBundle;
    auditLog: AuditLog;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
    graphRegistry?: LocalGraphRegistry;
    /** Postgres-model isolation — opens the REQUESTED workspace's VerbatimStore
     *  so the tombstone lands in its LanceDB, not the boot store. Absent
     *  (cloud/tests) → boot store fallback. */
    workspaceVerbatimResolver?: WorkspaceVerbatimResolver;
    /** Sprint O2 — outbox for hot-lane delete (records node.delete +
     *  verbatim.upsert tombstone before substrate writes). */
    outboxStore?: OutboxStore;
    /** Sprint O4 — backpressure lag cache (optional; absent = skip). */
    outboxLagCache?: OutboxLagCache;
}

const RESERVED_SUFFIXES = new Set([
    'supersede',
    'unsupersede',
    'supersession-candidates',
    'lineage',
]);

export async function tryNodeDeleteRoute(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: NodeDeleteDeps,
): Promise<boolean> {
    if (req.method !== 'DELETE') return false;
    if (!pathname.startsWith('/api/node/')) return false;
    const rawSuffix = pathname.slice('/api/node/'.length);
    if (!rawSuffix || RESERVED_SUFFIXES.has(rawSuffix)) return false;

    // L-031 — node hard-delete is destructive; gate on the finer 'delete'
    // permission (mirrors config.ts drop), not the coarser 'write'.
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'delete' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }

    let id: string;
    try {
        id = decodeURIComponent(rawSuffix);
    } catch {
        writeError(res, 400, 'invalid_url_encoding', 'node id path segment is not validly URL-encoded');
        return true;
    }
    if (!id) {
        writeError(res, 400, 'bad_request', 'id required in path');
        return true;
    }
    const stripped = id.startsWith('lore:') ? id.slice(5) : id;

    const sp = new URL(url, 'http://localhost').searchParams;
    const requestedWorkspace = sp.get('workspace') ?? sp.get('project') ?? undefined;

    // Token-scoped write gate — mirrors POST /api/node.
    const principal = getCurrentPrincipal();
    // Sprint L1c — workspace required (writer). Token's bound workspace
    // counts as explicit; no token + no query param → 400.
    const effectiveWorkspace = requestedWorkspace ?? principal?.workspace;
    if (!effectiveWorkspace) { writeWorkspaceRequired(res); return true; }
    // D-021 — bind on the REQUESTED workspace (falls back to the principal's
    // own workspace when the query param is absent, same as effectiveWorkspace
    // above), not a literal-undefined gate.
    if (bindRouteTarget(res, { requested: requestedWorkspace, intent: 'write' }) === null) return true;

    let targetGraph: LoreGraph = deps.store.loreGraph;
    if (deps.graphRegistry) {
        const resolvedWorkspace = effectiveWorkspace;
        try {
            // getGraphHandle honours the workspace's declared engine — getOrOpen
            // is the Kùzu substrate accessor and used to hard-delete against a
            // Surreal workspace's unused, empty Kùzu graph instead, returning
            // `deleted: false`/`node_not_found` even though the real node still
            // exists in Surreal. Still runs assertWorkspaceOpenAllowed.
            targetGraph = await deps.graphRegistry.getGraphHandle(resolvedWorkspace);
        } catch (err) {
            if (err instanceof WorkspaceNotFoundError) {
                writeError(res, 404, 'workspace_not_found', `workspace not found: ${err.requested}`, {
                    requested: err.requested,
                    known: err.known,
                });
                return true;
            }
            throw err;
        }
    }

    // Sprint O4 — backpressure gate.
    if (checkOutboxBackpressure(res, effectiveWorkspace, deps.outboxLagCache)) return true;

    const startedAt = Date.now();
    try {
        // O2: outbox-first — record node.delete before substrate.
        if (deps.outboxStore) {
            await recordHotWrite(deps.outboxStore, {
                workspace: effectiveWorkspace,
                operationKind: 'node.delete',
                payload: { id: stripped },
                initiator: 'http:DELETE /api/node',
                operation: 'node.delete',
            });
        }
        const deleted = await targetGraph.deleteNode(stripped);
        if (!deleted) {
            deps.auditLog.log({
                toolName: 'delete_node',
                args: { id: stripped, surface: 'http' },
                result: 'error',
                resultDetail: 'not-found',
                durationMs: Date.now() - startedAt,
            });
            writeError(res, 404, 'node_not_found', `Node '${id}' not found`, { id });
            return true;
        }

        // Mirror MCP delete_node verbatim handling: tombstone if the
        // store exposes one (LocalVerbatim), else fall back to delete
        // (DataplaneVectorStore lacks tombstone today). Fire-and-forget
        // — the HTTP response should not block on a vector store flush.
        // Postgres-model isolation — tombstone the REQUESTED workspace's
        // LanceDB (the graph delete above already routed to it), not the boot
        // store. getOrOpen is cached; fall back to boot when no resolver.
        const targetVerbatim = deps.workspaceVerbatimResolver
            ? await deps.workspaceVerbatimResolver.getOrOpen(effectiveWorkspace)
            : deps.store.loreVerbatim;
        const verbatim = targetVerbatim as unknown as {
            tombstone?: (id: string, reason: string) => Promise<void>;
            delete: (id: string) => Promise<void>;
        };
        const canTombstone = typeof verbatim.tombstone === 'function';
        const verbatimOp = canTombstone
            ? verbatim.tombstone!(`lore:${stripped}`, 'graph node deleted via DELETE /api/node')
            : verbatim.delete(`lore:${stripped}`);
        verbatimOp.catch((err: unknown) =>
            console.error(`[Lore HTTP] Verbatim tombstone failed for ${redactId(stripped)}: ${redactError(err)}`),
        );

        deps.auditLog.log({
            toolName: 'delete_node',
            args: { id: stripped, surface: 'http' },
            result: 'success',
            durationMs: Date.now() - startedAt,
        });
        writeJson(res, 200, { ok: true, id, tombstoned: canTombstone });
    } catch (err) {
        deps.auditLog.log({
            toolName: 'delete_node',
            args: { id: stripped, surface: 'http' },
            result: 'error',
            resultDetail: (err as Error).message,
            durationMs: Date.now() - startedAt,
        });
        writeError(res, 500, 'internal_error', redactError(err)); // F-COL5
    }
    return true;
}
