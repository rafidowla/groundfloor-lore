/**
 * nodes.ts — dispatcher for the single-node CRUD + supersession + traversal
 * routes. Each endpoint lives in its own file under ./nodes/; this module
 * just matches (pathname, method) and delegates.
 *
 *   GET    /api/node                         — node + 1-hop neighbors        (nodes/getNode.ts)
 *   POST   /api/node                         — upsert (mirrors store_node)    (nodes/postNode.ts)
 *   GET    /api/node-full                    — node body alone (CLI get-full) (nodes/nodeFull.ts)
 *   GET    /api/subgraph                     — multi-hop BFS for "Look in"    (nodes/subgraph.ts)
 *   POST   /api/node/supersede               — soft-supersede (oldId → newId) (nodes/supersede.ts)
 *   POST   /api/node/unsupersede             — reverse a supersession         (nodes/supersede.ts)
 *   GET    /api/node/supersession-candidates — vector-similarity scan, cached (nodes/supersessionCandidates.ts)
 *   GET    /api/node/lineage                 — full superseded-by chain       (nodes/lineage.ts)
 *   GET    /api/nodes/as-of                  — bi-temporal "as-of" query      (nodes/asOf.ts)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NodesDeps } from './nodes/types.js';
import { handleGetNode } from './nodes/getNode.js';
import { handleSubgraph } from './nodes/subgraph.js';
import { handleSupersede, handleUnsupersede } from './nodes/supersede.js';
import { handleSupersessionCandidates } from './nodes/supersessionCandidates.js';
import { handleLineage } from './nodes/lineage.js';
import { handleNodeFull } from './nodes/nodeFull.js';
import { handlePostNode } from './nodes/postNode.js';
import { handleNodesAsOf } from './nodes/asOf.js';

export type { NodesDeps } from './nodes/types.js';

export async function tryNodesRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: NodesDeps,
): Promise<boolean> {
    if (pathname === '/api/node' && req.method === 'GET') {
        await handleGetNode(res, url, deps);
        return true;
    }
    if (pathname === '/api/subgraph' && req.method === 'GET') {
        await handleSubgraph(res, url, deps);
        return true;
    }
    if (pathname === '/api/node/supersede' && req.method === 'POST') {
        await handleSupersede(req, res, url, deps);
        return true;
    }
    if (pathname === '/api/node/unsupersede' && req.method === 'POST') {
        await handleUnsupersede(req, res, url, deps);
        return true;
    }
    if (pathname === '/api/node/supersession-candidates' && req.method === 'GET') {
        await handleSupersessionCandidates(res, url, deps);
        return true;
    }
    if (pathname === '/api/node/lineage' && req.method === 'GET') {
        await handleLineage(res, url, deps);
        return true;
    }
    if (pathname === '/api/node-full' && req.method === 'GET') {
        await handleNodeFull(res, url, deps);
        return true;
    }
    if (pathname === '/api/node' && req.method === 'POST') {
        await handlePostNode(req, res, url, deps);
        return true;
    }
    if (pathname === '/api/nodes/as-of' && req.method === 'GET') {
        await handleNodesAsOf(res, url, deps);
        return true;
    }
    return false;
}
