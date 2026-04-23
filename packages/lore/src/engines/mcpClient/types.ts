/**
 * types.ts — MCP-client runtime contracts (Phase 4 / C6).
 *
 * What this is:
 *   Config + status shapes for Lore-as-MCP-client. Separate from the
 *   @modelcontextprotocol/sdk Client class (that's transport plumbing);
 *   this file is the per-deployment config + surface shape.
 *
 * Config location: ~/.groundfloor/mcp-servers.json
 * Shape:
 *   {
 *     "servers": [
 *       {
 *         "name": "gmail",
 *         "displayName": "Gmail",
 *         "transport": "stdio",
 *         "command": "npx",
 *         "args": ["-y", "@community/gmail-mcp"],
 *         "scopes": ["read"],
 *         "enabled": true
 *       },
 *       {
 *         "name": "close-crm",
 *         "transport": "http",
 *         "url": "http://localhost:5050/mcp",
 *         "scopes": ["read", "write"],
 *         "enabled": true
 *       }
 *     ]
 *   }
 *
 * Why two transports:
 *   - stdio: the dominant pattern for community MCP servers (spawned
 *     as child process). No network cost, no auth exchange.
 *   - http: for servers that run separately (your own MCP gateway,
 *     cloud-hosted). Bearer-auth passes through.
 *
 * Scopes:
 *   Advisory metadata for UI display and future policy. A 'write'-
 *   scoped server exposes tools that may mutate external state, and
 *   its tool calls go through the consent gate when flagged. A
 *   'read'-scoped server's tools bypass consent.
 *
 * What's NOT in C6b:
 *   - Proxying external tools into Lore's own MCP surface (schema
 *     translation from JSON-Schema → Zod). Follow-on commit.
 *   - OAuth flows for SSE servers that need them. When Gmail/Drive
 *     connectors arrive, they'll implement IConnector with their own
 *     auth path rather than living on IMcpClient.
 */

export type McpClientTransport = 'stdio' | 'http';

export interface McpServerConfig {
    /** Stable identifier — used as a namespace prefix when proxying tools. */
    name: string;
    /** Human-readable display name. Defaults to `name`. */
    displayName?: string;
    /** Short description. */
    description?: string;
    /** stdio or http. */
    transport: McpClientTransport;

    // stdio-specific
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;

    // http-specific
    url?: string;
    bearerEnv?: string;  // env var name holding bearer token (not the value)
    bearerKeychain?: string;  // keychain account holding bearer token

    /** Tool-capability advisory. Defaults to ['read']. */
    scopes?: Array<'read' | 'write'>;
    /** Whether to attempt connection at boot. */
    enabled?: boolean;
}

export interface McpClientFile {
    servers: McpServerConfig[];
}

/** Live connection state. */
export type McpClientStatus =
    | 'disabled'
    | 'connecting'
    | 'connected'
    | 'disconnected'
    | 'error';

export interface McpClientSnapshot {
    name: string;
    displayName: string;
    transport: McpClientTransport;
    scopes: Array<'read' | 'write'>;
    status: McpClientStatus;
    /** Tools the server advertises (empty if never connected). */
    toolCount: number;
    /** Last time the status field changed. */
    lastStatusChangeAt: string;
    /** Last error message, if status is 'error'. */
    lastError?: string;
}
