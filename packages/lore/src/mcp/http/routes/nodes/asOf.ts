/**
 * asOf.ts — GET /api/nodes/as-of — bi-temporal "as-of" query.
 *
 * Thin HTTP wrapper around core/temporalQuery.ts's `listNodesAsOf`. Returns
 * nodes whose validFrom/validUntil window covers the requested instant (or
 * that never set a window — always valid). Query semantics only: Core does
 * not decide which nodes SHOULD be time-windowed or resolve conflicts
 * between overlapping windows — that judgment is the caller's.
 *
 * Query params: `workspace` (required, via resolveReadGraph) selects WHICH
 * physical graph is read; `at` (required — ISO 8601 timestamp); `type?`,
 * `tag?`, `project?`, `ecosystem?`, `limit?`, `unbounded?` are the same
 * within-workspace filters GET /api/nodes and /api/node/supersession-
 * candidates use (project/ecosystem default to '*' — no filter).
 *
 * "AS OF" IS VALID TIME (default and only mode): `at` is matched against each
 * node's validFrom/validUntil — "how things were then". It is NOT recorded
 * time ("what we knew on date D"); this route has no recorded-time mode.
 * Both window ends are INCLUSIVE; an unset validUntil means still valid.
 *
 * PAGING: `limit` caps the page of MATCHING nodes (the valid-time filter runs
 * in the store, so a page is full whenever enough matches exist), ordered
 * updatedAt desc, id asc. When a page comes back full the response carries
 * `nextCursor`; pass it back as `cursor` for the next page (null = done).
 * Row-level security_scopes filtering still happens after the page is read,
 * so a page with rows hidden from the caller can return fewer than `limit`.
 */

import type { ServerResponse } from 'node:http';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { filterNodesByActorScope } from '../../../../security/scopeFilter.js';
import { redactHiddenSuccessors } from '../../../../security/nodePointers.js';
import { resolveReadGraph } from './readGate.js';
import type { NodesDeps } from './types.js';
import { redactError } from '../../../../security/logRedact.js';
import { writeError } from '../../helpers.js';
import { listNodesAsOf } from '../../../../core/temporalQuery.js';

export async function handleNodesAsOf(res: ServerResponse, url: string, deps: NodesDeps): Promise<void> {
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'read' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return; }
    try {
        const params = new URL(url, 'http://localhost').searchParams;
        const at = params.get('at') ?? '';
        if (!at) {
            writeError(res, 400, 'bad_request', '`at` query param (ISO 8601 timestamp) is required');
            return;
        }
        // SP-04 — same workspace-required + token-scoped read gate every
        // other /api/node* read route runs (see readGate.ts).
        const readGraph = await resolveReadGraph(res, url, deps);
        if (!readGraph) return;

        const type = params.get('type') ?? undefined;
        const tag = params.get('tag') ?? undefined;
        const project = params.get('project') ?? undefined;
        const ecosystem = params.get('ecosystem') ?? undefined;
        const limitParam = Number(params.get('limit'));
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
        const unbounded = params.get('unbounded') === 'true';
        let after: { updatedAt: string; id: string } | undefined;
        const cursorParam = params.get('cursor');
        if (cursorParam) {
            after = decodeCursor(cursorParam);
            if (!after) {
                writeError(res, 400, 'bad_request', '`cursor` is not a valid as-of cursor (use the `nextCursor` of a previous response)');
                return;
            }
        }

        let nodes;
        try {
            nodes = await listNodesAsOf(readGraph, at, { type, tag, project, ecosystem, limit, unbounded, after });
        } catch (validationErr) {
            if (validationErr instanceof RangeError) {
                writeError(res, 400, 'bad_request', validationErr.message);
                return;
            }
            throw validationErr;
        }
        // Row-level security_scopes confinement (finding #20). `listNodesAsOf`
        // is a valid-time WINDOW over each node's CURRENT row (validFrom /
        // validUntil), not a historical snapshot, so the row's current scopes
        // are the only ones that exist to check — a node is returned only if
        // the bound actor may see it today (never widens). Hidden rows are
        // dropped silently and `count` reflects the visible set. Unbound
        // actor ⇒ no filtering.
        const visible = await redactHiddenSuccessors(
            filterNodesByActorScope(nodes),
            (ids) => readGraph.getNodesByIds(ids),
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const pageSize = limit !== undefined ? Math.min(Math.floor(limit), 10_000) : 10_000;
        const last = nodes[nodes.length - 1];
        const nextCursor = !unbounded && last && nodes.length >= pageSize ? encodeCursor(last.updatedAt, last.id) : null;
        res.end(JSON.stringify({ at, count: visible.length, nodes: visible, nextCursor }));
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}

function encodeCursor(updatedAt: string, id: string): string {
    return Buffer.from(JSON.stringify({ u: updatedAt, i: id }), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): { updatedAt: string; id: string } | undefined {
    try {
        const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { u?: unknown; i?: unknown };
        return typeof v.u === 'string' && typeof v.i === 'string' ? { updatedAt: v.u, id: v.i } : undefined;
    } catch {
        return undefined;
    }
}
