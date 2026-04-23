/**
 * runtime.ts — MCP-client runtime (Phase 4 / C6b).
 *
 * Responsibilities:
 *   - Read ~/.groundfloor/mcp-servers.json at boot.
 *   - For each enabled server, attempt a connection (stdio or HTTP).
 *   - Discover the server's tools once connected.
 *   - Track live status per server for the /api/mcp-clients surface.
 *   - Clean shutdown (disconnect all clients on daemon stop).
 *
 * What C6b does NOT do yet:
 *   - Proxy external tools into Lore's own mcpServer.tool() surface
 *     (requires JSON-Schema → Zod translation). The `listTools()` call
 *     captures the tool count; actual invocation is the follow-up.
 *   - OAuth flows for servers that need them (Gmail, Drive, etc.).
 *     When those connectors land, they implement IConnector with their
 *     own auth pipeline and call this runtime only for session setup.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
    McpServerConfig,
    McpClientFile,
    McpClientSnapshot,
    McpClientStatus,
} from './types.js';

const CONFIG_PATH = path.join(os.homedir(), '.groundfloor', 'mcp-servers.json');

interface LiveClient {
    config: McpServerConfig;
    status: McpClientStatus;
    statusChangedAt: string;
    toolCount: number;
    lastError?: string;
    client?: Client;
}

export class McpClientRuntime {
    private readonly clients = new Map<string, LiveClient>();

    /**
     * loadConfig — read ~/.groundfloor/mcp-servers.json.
     *
     * Missing file is fine (no servers configured). Malformed file
     * logs a warning and returns empty. Never throws.
     */
    loadConfig(): McpClientFile {
        if (!fs.existsSync(CONFIG_PATH)) return { servers: [] };
        try {
            const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as McpClientFile;
            if (!Array.isArray(parsed.servers)) {
                console.error('[mcp-client] malformed mcp-servers.json: missing servers[]');
                return { servers: [] };
            }
            return parsed;
        } catch (err) {
            console.error(`[mcp-client] failed to read mcp-servers.json: ${(err as Error).message}`);
            return { servers: [] };
        }
    }

    /**
     * connectAll — attempt to connect every enabled server. Returns
     * the number successfully connected.
     *
     * Concurrent: each server is a fire-and-forget Promise so a slow
     * stdio spawn doesn't block the others.
     */
    async connectAll(): Promise<{ attempted: number; connected: number; errored: number }> {
        const cfg = this.loadConfig();
        const enabledServers = cfg.servers.filter((s) => s.enabled !== false);
        let connected = 0;
        let errored = 0;

        await Promise.all(
            enabledServers.map(async (server) => {
                try {
                    await this.connect(server);
                    connected += 1;
                } catch (err) {
                    errored += 1;
                    console.error(`[mcp-client] ${server.name} failed: ${(err as Error).message}`);
                }
            }),
        );

        // Also register disabled servers with 'disabled' state so the UI
        // can render them as known-but-off.
        for (const server of cfg.servers) {
            if (server.enabled === false && !this.clients.has(server.name)) {
                this.clients.set(server.name, {
                    config: server,
                    status: 'disabled',
                    statusChangedAt: new Date().toISOString(),
                    toolCount: 0,
                });
            }
        }

        return { attempted: enabledServers.length, connected, errored };
    }

    /**
     * connect — attempt a single server. Throws on error; caller
     * decides whether to log-and-continue.
     */
    async connect(config: McpServerConfig): Promise<void> {
        this.setLiveClientStatus(config, 'connecting');

        if (config.transport === 'stdio') {
            if (!config.command) throw new Error(`server "${config.name}" missing 'command'`);
            const transport = new StdioClientTransport({
                command: config.command,
                args: config.args ?? [],
                env: config.env,
                cwd: config.cwd,
            });
            const client = new Client(
                { name: 'groundfloor-lore', version: '2.2.0' },
                { capabilities: {} },
            );
            await client.connect(transport);
            // Discover tools once.
            let toolCount = 0;
            try {
                const result = await client.listTools();
                toolCount = result.tools?.length ?? 0;
            } catch (err) {
                // Some servers don't implement tools/list; ignore.
                console.error(`[mcp-client] ${config.name} listTools failed: ${(err as Error).message}`);
            }
            const live = this.clients.get(config.name) ?? {
                config,
                status: 'connected' as McpClientStatus,
                statusChangedAt: new Date().toISOString(),
                toolCount,
            };
            live.client = client;
            live.toolCount = toolCount;
            live.status = 'connected';
            live.statusChangedAt = new Date().toISOString();
            live.lastError = undefined;
            this.clients.set(config.name, live);
        } else if (config.transport === 'http') {
            // HTTP transport deferred — the MCP SDK ships two HTTP
            // transports (SSE + streamable HTTP) and we'd need to
            // pick per-server. Landing stdio first covers the
            // dominant pattern for community MCP servers.
            this.setLiveClientStatus(config, 'error', 'HTTP transport not implemented (C6b deferred; stdio only)');
            throw new Error('HTTP MCP client transport not yet supported');
        } else {
            throw new Error(`unknown transport: ${config.transport}`);
        }
    }

    /**
     * disconnectAll — close every live client cleanly. Called on
     * daemon shutdown so child processes don't hang.
     */
    async disconnectAll(): Promise<void> {
        for (const live of this.clients.values()) {
            if (live.client) {
                try { await live.client.close(); } catch { /* ignore */ }
            }
        }
    }

    /** Snapshot for the /api/mcp-clients surface. */
    list(): McpClientSnapshot[] {
        return Array.from(this.clients.values()).map((live) => ({
            name: live.config.name,
            displayName: live.config.displayName ?? live.config.name,
            transport: live.config.transport,
            scopes: live.config.scopes ?? ['read'],
            status: live.status,
            toolCount: live.toolCount,
            lastStatusChangeAt: live.statusChangedAt,
            lastError: live.lastError,
        }));
    }

    private setLiveClientStatus(config: McpServerConfig, status: McpClientStatus, error?: string): void {
        const existing = this.clients.get(config.name);
        const live: LiveClient = existing ?? {
            config,
            status,
            statusChangedAt: new Date().toISOString(),
            toolCount: 0,
        };
        live.status = status;
        live.statusChangedAt = new Date().toISOString();
        live.lastError = error;
        this.clients.set(config.name, live);
    }
}
