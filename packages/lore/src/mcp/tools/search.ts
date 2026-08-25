/**
 * search.ts — registrar for the read-only retrieval tools. Each tool lives
 * in its own file under ./search/; this module wires them onto the MCP
 * server in one call.
 *
 *   - search           full-text scan across LoreNodes          (search/searchTool.ts)
 *   - recall           hybrid retrieval + traversal, two modes   (search/recallTool.ts)
 *   - structured_query raw node JSON, no LLM                      (search/structuredQueryTool.ts)
 *
 * Shared helpers (reciprocalRankFusion, buildLanguageHint, estimateTokens)
 * live in search/helpers.ts; the SearchToolsDeps bundle in search/types.ts.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SearchToolsDeps } from './search/types.js';
import { registerSearchTool } from './search/searchTool.js';
import { registerRecallTool } from './search/recallTool.js';
import { registerStructuredQueryTool } from './search/structuredQueryTool.js';

export type { SearchToolsDeps } from './search/types.js';

export function registerSearchTools(mcpServer: McpServer, deps: SearchToolsDeps): void {
    registerSearchTool(mcpServer, deps);
    registerRecallTool(mcpServer, deps);
    registerStructuredQueryTool(mcpServer, deps);
}
