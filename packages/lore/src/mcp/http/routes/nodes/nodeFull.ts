/**
 * nodeFull.ts — GET /api/node-full?id=<nodeId>.
 *
 * Fetch the full body of a single node by id. Companion to /api/recall —
 * the CLI's `lore get-full <id>` calls this when the daemon is up so it
 * doesn't fight Kùzu's lock. Path is `/api/node-full` (not
 * `/api/node/full`) to avoid the `/api/node` match.
 */

import type { ServerResponse } from 'node:http';
import { gateRoute } from '../../../../security/routeGate.js';
import { writePermissionDenied } from '../../../../security/rebacGate.js';
import { filterNodesByActorScope } from '../../../../security/scopeFilter.js';
import { resolveReadGraph } from './readGate.js';
import type { NodesDeps } from './types.js';
import { redactError } from '../../../../security/logRedact.js';
import { writeError } from '../../helpers.js';

export async function handleNodeFull(res: ServerResponse, url: string, deps: NodesDeps): Promise<void> {
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'read' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return; }
    try {
        const fullParams = new URL(url, 'http://localhost').searchParams;
        const nodeId = fullParams.get('id') ?? '';
        if (!nodeId) {
            writeError(res, 400, 'bad_request', '`id` query param is required');
            return;
        }
        // SP-04 — node-full was REMOVED from the public Bearer-less
        // allowlist (it dumps full content/metadata). It now also runs
        // workspace_required + token-scoped read gate + workspace-aware
        // resolution like every other /api/* read.
        const readGraph = await resolveReadGraph(res, url, deps);
        if (!readGraph) return;
        const stripped = nodeId.startsWith('lore:') ? nodeId.slice(5) : nodeId;
        const node = await readGraph.getNode(stripped);
        if (!node) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ found: false, id: nodeId }));
            return;
        }
        // 3.1 (2026-08-17) — row-level scope confinement. A node whose
        // security_scopes the bound actor lacks is reported exactly like a
        // missing node — never dumps its full content/metadata.
        if (filterNodesByActorScope([node]).length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ found: false, id: nodeId }));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            found: true,
            id: node.id,
            type: node.type,
            label: node.label,
            project: node.project,
            tags: node.tags,
            content: node.content,
            language: node.language ?? null,
            metadata: node.metadata ?? null,
        }));
    } catch (getFullErr) {
        writeError(res, 500, 'internal_error', redactError(getFullErr));
    }
}
