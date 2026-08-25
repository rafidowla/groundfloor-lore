/**
 * memory.ts — registrar for the knowledge-graph mutation tools. Each tool
 * lives in its own file under ./memory/; this module wires them onto the
 * MCP server in one call.
 *
 *   - store_node       upsert a node + verbatim seed + auto-link hook  (memory/storeNode.ts)
 *   - store_edge       upsert an edge with confidence tier             (memory/storeEdge.ts)
 *   - mark_stale       bulk stale-flag by tag                          (memory/markStale.ts)
 *   - delete_node      hard delete + verbatim tombstone                (memory/deleteNode.ts)
 *   - delete_edge      remove an edge by (source, target, relation)    (memory/deleteEdge.ts)
 *   - supersede_node   soft-supersede oldId -> newId with audit        (memory/supersedeNode.ts)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryToolsDeps } from './memory/types.js';
import { registerStoreNodeTool } from './memory/storeNode.js';
import { registerStoreEdgeTool } from './memory/storeEdge.js';
import { registerMarkStaleTool } from './memory/markStale.js';
import { registerDeleteNodeTool } from './memory/deleteNode.js';
import { registerDeleteEdgeTool } from './memory/deleteEdge.js';
import { registerSupersedeNodeTool } from './memory/supersedeNode.js';

export type { MemoryToolsDeps } from './memory/types.js';

export function registerMemoryTools(mcpServer: McpServer, deps: MemoryToolsDeps): void {
    registerStoreNodeTool(mcpServer, deps);
    registerStoreEdgeTool(mcpServer, deps);
    registerMarkStaleTool(mcpServer, deps);
    registerDeleteNodeTool(mcpServer, deps);
    registerDeleteEdgeTool(mcpServer, deps);
    registerSupersedeNodeTool(mcpServer, deps);
}
