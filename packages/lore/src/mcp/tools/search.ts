/**
 * search.ts — registrar for the read-only retrieval tools. Each tool lives
 * in its own file under ./search/; this module wires them onto the MCP
 * server in one call.
 *
 *   - search           full-text scan across LoreNodes          (search/searchTool.ts)
 *   - recall           hybrid retrieval + traversal, two modes   (search/recallTool.ts)
 *   - recall_expand    full bodies for recall's compact:true ids (search/recallExpandTool.ts)
 *   - recall_outcome   feed recall's usefulness into ranking.ts's outcome
 *                      weighting (existing mechanism, recall vocabulary)
 *                                                                 (search/recallOutcomeTool.ts)
 *   - structured_query raw node JSON, no LLM                      (search/structuredQueryTool.ts)
 *
 * Shared helpers (buildLanguageHint, estimateTokens) live in
 * search/helpers.ts; fusion lives in recall/rrf.ts (rrfFuse); the
 * SearchToolsDeps bundle in search/types.ts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchToolsDeps } from './search/types.js';
import { registerSearchTool } from './search/searchTool.js';
import { registerRecallTool } from './search/recallTool.js';
import { registerRecallExpandTool } from './search/recallExpandTool.js';
import { registerRecallOutcomeTool } from './search/recallOutcomeTool.js';
import { registerStructuredQueryTool } from './search/structuredQueryTool.js';

export type { SearchToolsDeps } from './search/types.js';

export function registerSearchTools(mcpServer: McpServer, deps: SearchToolsDeps): void {
    registerSearchTool(mcpServer, deps);
    registerRecallTool(mcpServer, deps);
    registerRecallExpandTool(mcpServer, deps);
    registerRecallOutcomeTool(mcpServer, deps);
    registerStructuredQueryTool(mcpServer, deps);
}
