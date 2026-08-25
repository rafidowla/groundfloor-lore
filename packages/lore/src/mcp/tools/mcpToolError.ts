/**
 * mcpToolError.ts — Consistent, leak-free error envelope for MCP tools.
 *
 * Audit fix #4. Before this, every MCP tool's catch block returned
 * `Error: ${(error as Error).message}` directly to the MCP client. The
 * underlying engines (Kùzu, LanceDB) frequently echo node ids, file
 * paths, or fragments of node content in their exception strings, so a
 * prompt-injected agent (or any caller) could probe for internals via
 * the error text. The HTTP routes learned this lesson (SW-14: redactError
 * + generic `internal_error`); the MCP surface never got the same fix.
 *
 * This module is the MCP-side mirror of that pattern:
 *   - The FULL error message (redacted of quoted ids) goes to the server
 *     log at 0600, where the operator can debug it.
 *   - The caller gets the REDACTED message (no raw engine strings, no
 *     node content, no ids/paths).
 *
 * The redacted message is preserved (rather than fully blanked to a bare
 * "internal_error") because MCP tool results are how agents recover — a
 * generic string with zero detail is hostile to legitimate interactive
 * debugging. The redaction strips the dangerous part (ids/paths/content
 * fragments) and keeps the safe part (the error class/category).
 */
import { redactError } from '../../security/logRedact.js';

/** The minimal logger surface mcpToolError uses (so tests can pass a stub). */
export interface McpErrorLogger {
    error(message: unknown, context?: Record<string, unknown>): void;
}

/**
 * The error-envelope shape returned to MCP clients. Matches the inline
 * `{ content: [{ type: 'text', text }], isError: true }` literal the tools
 * previously built by hand. Includes the MCP SDK's `[x: string]: unknown`
 * index signature so the returned object is assignable to `CallToolResult`
 * when a tool handler's return type is the union of this and a success
 * branch — without it, TS rejects the union at the `server.tool(...)` call.
 */
export interface McpToolErrorResult {
    content: Array<{ type: 'text'; text: string }>;
    isError: true;
    [x: string]: unknown;
}

/**
 * Build the safe error envelope + emit the server-log line.
 *
 * @param toolName  Tool identifier for the log line (e.g. "store_node").
 * @param error     The thrown error.
 * @param log       The logger (server log at 0600). Optional so unit
 *                  tests can pass a no-op or undefined.
 * @param detail    Extra non-sensitive context for the log line only
 *                  (e.g. "workspace=alpha"). Never reaches the caller.
 */
export function mcpToolError(
    toolName: string,
    error: unknown,
    log?: McpErrorLogger | null,
    detail?: string,
): McpToolErrorResult {
    const safeMessage = redactError(error);
    // Full redacted detail → operator log only.
    log?.error(`[Lore MCP] ${toolName} failed${detail ? ` (${detail})` : ''}: ${safeMessage}`);
    // Caller sees the redacted message (ids/paths stripped), not the raw
    // engine string and never the full stack.
    return {
        content: [{ type: 'text', text: `Error: ${safeMessage}` }],
        isError: true,
    };
}
