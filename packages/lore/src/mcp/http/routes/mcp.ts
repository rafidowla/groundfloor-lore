/**
 * mcp.ts — Streamable-HTTP MCP transport endpoint.
 *
 *   ALL  /mcp     — MCP protocol over Streamable HTTP. The MCP SDK
 *                   handles GET/POST/DELETE per the Streamable HTTP
 *                   spec; we route all methods through.
 *
 * Session lifecycle:
 *   - Header `mcp-session-id` present + session in activeSessions
 *     → reuse the existing transport
 *   - Otherwise → spawn a fresh McpServer + transport pair, register
 *     onclose to evict from the map, and let the SDK assign a session
 *     id during the first handleRequest call
 *
 * activeSessions is owned by the daemon (server.ts module scope) since
 * the same map is also referenced by the diagnostic family for the
 * /health response.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';

export interface McpTransportDeps {
    /** Per-session McpServer factory. Each new session gets a fresh server. */
    createMcpServer: () => McpServer;
    /** Daemon-wide active-sessions registry. */
    activeSessions: Map<string, StreamableHTTPServerTransport>;
    /** Mark a session as recently active so the idle sweeper doesn't evict it. (Audit 2026-05-13) */
    touchActiveSession: (id: string) => void;
    /** Remove a session AND its last-seen entry so leaks can't accumulate. */
    evictActiveSession: (id: string) => void;
}

export async function tryMcpTransportRoute(
    req: IncomingMessage,
    res: ServerResponse,
    _url: string,
    pathname: string,
    deps: McpTransportDeps,
): Promise<boolean> {
    if (pathname !== '/mcp') return false;

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Route to existing session if header present.
    if (sessionId && deps.activeSessions.has(sessionId)) {
        const existingTransport = deps.activeSessions.get(sessionId)!;
        deps.touchActiveSession(sessionId);
        await existingTransport.handleRequest(req, res);
        return true;
    }

    // New session — create fresh McpServer + transport.
    const sessionTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
    });

    sessionTransport.onclose = () => {
        const sid = sessionTransport.sessionId;
        if (sid) {
            deps.evictActiveSession(sid);
            console.error(`[Lore MCP] Session ${sid.slice(0, 8)}... closed (${deps.activeSessions.size} active)`);
        }
    };

    const sessionServer = deps.createMcpServer();
    await sessionServer.connect(sessionTransport);

    // Store session after connection (sessionId is set during handleRequest).
    await sessionTransport.handleRequest(req, res);

    const newSessionId = sessionTransport.sessionId;
    if (newSessionId) {
        deps.activeSessions.set(newSessionId, sessionTransport);
        deps.touchActiveSession(newSessionId);
        console.error(`[Lore MCP] New session ${newSessionId.slice(0, 8)}... (${deps.activeSessions.size} active)`);
    }
    return true;
}
