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
 */

import type { ServerResponse } from 'node:http';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
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

        let nodes;
        try {
            nodes = await listNodesAsOf(readGraph, at, { type, tag, project, ecosystem, limit, unbounded });
        } catch (validationErr) {
            if (validationErr instanceof RangeError) {
                writeError(res, 400, 'bad_request', validationErr.message);
                return;
            }
            throw validationErr;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ at, count: nodes.length, nodes }));
    } catch (err) {
        writeError(res, 500, 'internal_error', redactError(err));
    }
}
