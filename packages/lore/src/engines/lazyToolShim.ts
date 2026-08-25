/**
 * lazyToolShim.ts — v1.1.1 lazy-schema tool catalogue (P0 of the §3
 * Phase 6 strategy).
 *
 * Why this exists
 * ───────────────
 * Every MCP-tool registration costs tokens at session init. Claude Code
 * (and most MCP clients) call `tools/list` once per session, and the
 * server returns the full schema for every registered tool. With ~47
 * tools across core, that catalogue announcement runs an estimated
 * 5-10k tokens per session before the agent has even asked anything.
 *
 * The lazy-shim pattern flips that: register only THREE shim tools with
 * MCP, and keep every "real" tool in an in-process registry. The agent
 * fetches a tool's schema on-demand via `lore_tool_schema(name)`, then
 * invokes it via `lore_tool_invoke(name, input)`. A `lore_tool_list()`
 * shim returns the names + 1-line descriptions so the agent can
 * discover what's available without paying for full schemas.
 *
 * Strict opt-in
 * ─────────────
 * Default is OFF. Operators flip it on with `LORE_TOOL_SHIM=on`. This
 * matches the explicit-operator-choice policy from the silent-auto-
 * detect revert: the shim is real value but it's also a UX shape
 * change — agents that don't know about the shim see only three
 * unfamiliar tools and can't auto-discover the catalogue.
 *
 * The CLAUDE.md regen path is the natural place to teach an agent the
 * shim pattern; that doc already auto-formats on `lore setup` (per the
 * Lore Intelligence Protocol). v1.1.1 follow-up: extend that regen to
 * surface the shim contract when LORE_TOOL_SHIM=on.
 *
 * Wiring contract
 * ───────────────
 *   const reg = createLazyToolRegistry();
 *   reg.intercept(mcpServer);                  // before any tool() calls
 *   // ... all the existing mcpServer.tool() calls run; they're captured
 *   reg.installShims(mcpServer);               // at end of createMcpServer
 *
 * After installShims, only `lore_tool_list`, `lore_tool_schema`, and
 * `lore_tool_invoke` are visible to the MCP client. The original 47
 * tools are reachable via the invoke shim.
 *
 * Limitations of v1.1.1 (intentional)
 * ──────────────────────────────────
 * - No partial mode. Either every captured tool goes lazy, or none do.
 *   A "shim some, register the 4 essentials normally" hybrid is a
 *   reasonable v2 — track demand before adding the surface.
 * - Schema conversion uses `zod-to-json-schema` (already a transitive
 *   dep via the MCP SDK). The output shape matches what MCP servers
 *   announce in `tools/list`, so the agent gets exactly the schema it
 *   would have seen at init time — just lazily.
 * - Errors during invoke are returned to the agent verbatim with
 *   ok:false. They are NOT logged separately — the existing
 *   tool-dispatch JSONL already captures every dispatch end-to-end.
 *
 * License: original work for groundfloor-lore.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * One captured tool registration. The handler closure carries everything
 * the original site needed (graph refs, config, etc.) — we just
 * stash it untouched and re-invoke through `lore_tool_invoke`.
 */
interface CapturedTool {
    name: string;
    description: string;
    /**
     * The Zod schema object the original `server.tool()` call passed.
     * Stored as-is so `lore_tool_schema` can convert it to JSON Schema
     * on demand (matches what an MCP `tools/list` would have returned).
     */
    schema: Record<string, z.ZodTypeAny>;
    /**
     * The original handler. Called with the parsed-and-validated input
     * the same way the SDK would have called it.
     */
    handler: (input: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface LazyToolRegistry {
    /**
     * Wrap `mcpServer.tool` so subsequent calls capture into the
     * registry instead of registering with MCP. Idempotent — calling
     * twice on the same server is harmless.
     */
    intercept(server: McpServer): void;
    /**
     * Register the three shim tools with MCP. Call AFTER every "real"
     * tool registration site has run (typically at end-of-
     * createMcpServer). The MCP client will see only these three.
     */
    installShims(server: McpServer): void;
    /**
     * Number of tools captured into the registry. Useful for the
     * startup banner.
     */
    size(): number;
    /**
     * Snapshot of the registered tool names. Used by tests + the
     * boot-time log line.
     */
    names(): string[];
}

/**
 * Build a fresh registry. Call once per `createMcpServer()` (the SDK
 * creates a new McpServer per HTTP session in HTTP mode, so each
 * session gets its own registry — that's correct).
 */
export function createLazyToolRegistry(): LazyToolRegistry {
    const tools = new Map<string, CapturedTool>();

    return {
        intercept(server: McpServer): void {
            const originalTool = (server.tool as unknown as (...args: unknown[]) => unknown).bind(server);
            (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (
                ...args: unknown[]
            ) => {
                // SDK signature is (name, [description], [schema], handler).
                // Description and schema are both optional in the SDK's
                // overloads, but every tool in this codebase passes both.
                // Be defensive: if there are fewer than 4 args, fall
                // through to the original (no shim wrapping possible).
                if (args.length < 4) {
                    return originalTool(...args);
                }
                const name = String(args[0] ?? '');
                const description = String(args[1] ?? '');
                const schema = args[2] as Record<string, z.ZodTypeAny>;
                const handler = args[3] as CapturedTool['handler'];

                // Don't capture the shims themselves — that would create
                // an infinite-loop hazard if `lore_tool_invoke` ended up
                // routing back to itself. Names starting with `lore_tool_`
                // are reserved for the shim surface.
                if (name.startsWith('lore_tool_')) {
                    return originalTool(...args);
                }

                tools.set(name, { name, description, schema, handler });
                // Return undefined to mimic the SDK's `tool()` return
                // contract enough that callsites that don't use the
                // return value keep working. Sites that DO use the
                // return value would need the original — none do today
                // in this codebase (verified by grep).
                return undefined;
            };
        },

        installShims(server: McpServer): void {
            // Register all three shims. These calls intentionally bypass
            // the intercept (the `lore_tool_` name guard above passes
            // them through to the original tool() registration).

            // ── lore_tool_list ─────────────────────────────────────
            // Cheap discovery: returns name + description only. Agents
            // call this once per session to learn the catalogue, then
            // pull schemas with lore_tool_schema as needed.
            server.tool(
                'lore_tool_list',
                'List every Lore tool name + 1-line description. Cheap discovery — call this once per session, then use `lore_tool_schema(name)` to fetch a specific tool\'s input schema, and `lore_tool_invoke(name, input)` to run it. Replaces the full-catalogue announcement that other MCP servers do at `tools/list` time, saving an estimated 5-10k tokens per session.',
                {},
                async () => {
                    const list = Array.from(tools.values())
                        .map((t) => ({ name: t.name, description: t.description }))
                        .sort((a, b) => a.name.localeCompare(b.name));
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({ count: list.length, tools: list }, null, 2),
                        }],
                    };
                },
            );

            // ── lore_tool_schema ───────────────────────────────────
            // Returns the JSON Schema for one tool's input. Equivalent
            // to what an MCP `tools/list` response would have included
            // at session init, but fetched on demand.
            server.tool(
                'lore_tool_schema',
                'Fetch the JSON Schema for one Lore tool\'s input. Use after `lore_tool_list` to pick a tool, then before `lore_tool_invoke` to know the input shape. The returned schema matches what a non-shim MCP server would have announced at `tools/list` time.',
                {
                    name: z.string().describe('Tool name (e.g., "recall", "store_node"). Must be in the list returned by `lore_tool_list`.'),
                },
                async ({ name }: { name: string }) => {
                    const captured = tools.get(name);
                    if (!captured) {
                        return {
                            content: [{
                                type: 'text' as const,
                                text: JSON.stringify({
                                    ok: false,
                                    error: `tool not found: ${name}. Call lore_tool_list to see registered names.`,
                                }, null, 2),
                            }],
                            isError: true,
                        };
                    }
                    // Wrap the field-by-field Zod schema into a single
                    // object schema so JSON Schema conversion preserves
                    // the field-name → field-schema mapping.
                    //
                    // Use Zod v4's built-in `z.toJSONSchema` (added in
                    // 4.x) rather than the external `zod-to-json-schema`
                    // package, which targets Zod v3 internals and produces
                    // empty output against v4 schemas. The output is
                    // JSON Schema draft-7 by default — same shape an MCP
                    // `tools/list` response would have included.
                    const objectSchema = z.object(captured.schema);
                    const jsonSchema = z.toJSONSchema(objectSchema);
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                ok: true,
                                name: captured.name,
                                description: captured.description,
                                inputSchema: jsonSchema,
                            }, null, 2),
                        }],
                    };
                },
            );

            // ── lore_tool_invoke ───────────────────────────────────
            // Validates input against the captured Zod schema, then
            // runs the original handler. Errors return ok:false with
            // the validation message.
            server.tool(
                'lore_tool_invoke',
                'Invoke any Lore tool by name. Validates input against the tool\'s schema (use `lore_tool_schema` to fetch it), then runs the handler. Returns the same shape the underlying tool would have returned. Errors during validation or handler execution come back with ok:false.',
                {
                    name: z.string().describe('Tool name (e.g., "recall"). Must be in `lore_tool_list`.'),
                    input: z.record(z.string(), z.unknown()).describe('Tool input object. Match the schema returned by `lore_tool_schema(name)`.'),
                },
                async ({ name, input }: { name: string; input: Record<string, unknown> }) => {
                    const captured = tools.get(name);
                    if (!captured) {
                        return {
                            content: [{
                                type: 'text' as const,
                                text: JSON.stringify({
                                    ok: false,
                                    error: `tool not found: ${name}. Call lore_tool_list to see registered names.`,
                                }, null, 2),
                            }],
                            isError: true,
                        };
                    }
                    // Validate input through the same Zod schema the
                    // underlying tool would have seen, then call the
                    // handler. Validation failures are surfaced as
                    // ok:false with the issue list.
                    const objectSchema = z.object(captured.schema);
                    const parsed = objectSchema.safeParse(input);
                    if (!parsed.success) {
                        return {
                            content: [{
                                type: 'text' as const,
                                text: JSON.stringify({
                                    ok: false,
                                    error: 'input validation failed',
                                    issues: parsed.error.issues,
                                }, null, 2),
                            }],
                            isError: true,
                        };
                    }
                    try {
                        const result = await captured.handler(parsed.data);
                        return result as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
                    } catch (err) {
                        return {
                            content: [{
                                type: 'text' as const,
                                text: JSON.stringify({
                                    ok: false,
                                    error: `handler threw: ${(err as Error).message}`,
                                }, null, 2),
                            }],
                            isError: true,
                        };
                    }
                },
            );
        },

        size(): number {
            return tools.size;
        },

        names(): string[] {
            return Array.from(tools.keys()).sort();
        },
    };
}
