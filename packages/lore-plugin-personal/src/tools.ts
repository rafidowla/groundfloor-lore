/**
 * tools.ts — Personal plugin MCP tools (Phase 5 / P2).
 *
 * Three MVP tools that cover the central personal-intelligence flows:
 *
 *   recall_person(name)
 *     "Tell me everything you know about Sarah." Returns the Person
 *     node + related Places, upcoming Events, recent Memories, and
 *     explicitly-declared relationships. The grounding for any
 *     personalized LLM answer.
 *
 *   memory_search(query)
 *     Semantic + structured search across Memory nodes. Returns with
 *     occurred_at so the LLM can assemble a timeline.
 *
 *   upcoming(days)
 *     "What's on my radar this week?" PersonalEvents with startsAt
 *     within N days, sorted chronologically.
 *
 * Tools the Personal plugin will need later but NOT in the P2 MVP:
 *   - add_event, add_person, add_memory (plugin-owned write tools that
 *     respect the personal schema). The LLM can use core store_node
 *     with type='Person' etc. in the meantime.
 *   - link_people (declare kinship/friendship edges).
 *   - who_was_at / timeline / upcoming_birthdays (compositions).
 *   - timeline_for (chronological view for a Person).
 *
 * Tool namespacing: MCP tool names are the literal strings below. The
 * developer plugin uses un-namespaced names (code_query, gitnexus_impact)
 * by convention; Personal follows the same style. Future enterprise
 * plugins with overlap potential will want a namespace prefix.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PluginContext, PluginGraphContext } from '@lore-core/plugins/types.js';

export function registerPersonalTools(server: McpServer, ctx: PluginContext): void {
    const graph = ctx.graph as { createPluginGraphContext(): PluginGraphContext };
    const pluginCtx = graph.createPluginGraphContext();

    // ─── recall_person ─────────────────────────────────────────
    server.tool(
        'recall_person',
        "Return everything known about a Person: their details, the places they're linked to, upcoming events, recent memories, declared relationships.",
        {
            name: z.string().describe('Full or partial name — matches against displayName, givenName, or familyName'),
        },
        async ({ name }) => {
            try {
                // Search Person nodes by name — case-insensitive contains match.
                const nameLower = name.toLowerCase();
                const peopleRows = await pluginCtx.queryRows(
                    `MATCH (p:Person)
                     WHERE lower(p.displayName) CONTAINS $q
                        OR lower(p.givenName) CONTAINS $q
                        OR lower(p.familyName) CONTAINS $q
                     RETURN p.id AS id, p.displayName AS displayName,
                            p.givenName AS givenName, p.familyName AS familyName,
                            p.role AS role, p.notes AS notes
                     LIMIT 5`,
                    { q: nameLower },
                );

                if (peopleRows.length === 0) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                match: null,
                                message: `No Person matching "${name}" found.`,
                            }, null, 2),
                        }],
                    };
                }

                // For each match, build a 360° view.
                const profiles = [] as unknown[];
                for (const p of peopleRows) {
                    const id = p.id as string;

                    const livesAt = await pluginCtx.queryRows(
                        `MATCH (:Person {id: $id})-[r:PersonLivesAt]->(pl:Place)
                         RETURN pl.id AS id, pl.displayName AS displayName, pl.kind AS kind, r.since AS since`,
                        { id },
                    );

                    const upcomingEvents = await pluginCtx.queryRows(
                        `MATCH (e:PersonalEvent)-[:PersonInvolves]->(:Person {id: $id})
                         WHERE e.startsAt IS NOT NULL AND e.startsAt <> ''
                         RETURN e.id AS id, e.displayName AS displayName, e.kind AS kind, e.startsAt AS startsAt
                         ORDER BY e.startsAt ASC LIMIT 5`,
                        { id },
                    );

                    const recentMemories = await pluginCtx.queryRows(
                        `MATCH (m:Memory)-[:MemoryInvolves]->(:Person {id: $id})
                         RETURN m.id AS id, m.displayName AS displayName, m.occurredAt AS occurredAt
                         ORDER BY m.occurredAt DESC LIMIT 5`,
                        { id },
                    );

                    const relatedPeople = await pluginCtx.queryRows(
                        `MATCH (:Person {id: $id})-[r:PersonRelatedTo]->(other:Person)
                         RETURN other.id AS id, other.displayName AS displayName, r.relation AS relation`,
                        { id },
                    );

                    profiles.push({
                        id,
                        displayName: p.displayName,
                        givenName: p.givenName,
                        familyName: p.familyName,
                        role: p.role,
                        notes: p.notes,
                        livesAt,
                        upcomingEvents,
                        recentMemories,
                        relatedPeople,
                    });
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ matches: profiles.length, profiles }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
                    isError: true,
                };
            }
        },
    );

    // ─── memory_search ─────────────────────────────────────────
    server.tool(
        'memory_search',
        'Search Memory nodes by text content. Returns with occurred_at so chronology is preserved.',
        {
            query: z.string().describe('Keywords or short phrase to search memory content + displayName'),
            limit: z.number().optional().describe('Max results (default 10)'),
        },
        async ({ query, limit }) => {
            try {
                const q = query.toLowerCase();
                const lim = limit ?? 10;
                const rows = await pluginCtx.queryRows(
                    `MATCH (m:Memory)
                     WHERE lower(m.displayName) CONTAINS $q
                        OR lower(m.content) CONTAINS $q
                     RETURN m.id AS id, m.displayName AS displayName,
                            m.content AS content, m.occurredAt AS occurredAt,
                            m.sourceRef AS sourceRef
                     ORDER BY m.occurredAt DESC
                     LIMIT $lim`,
                    { q, lim },
                );
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            query,
                            count: rows.length,
                            memories: rows,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
                    isError: true,
                };
            }
        },
    );

    // ─── upcoming ─────────────────────────────────────────────
    server.tool(
        'upcoming',
        'Return PersonalEvents scheduled in the next N days, sorted chronologically.',
        {
            days: z.number().optional().describe('Look-ahead window in days (default 14)'),
            limit: z.number().optional().describe('Max events (default 20)'),
        },
        async ({ days, limit }) => {
            try {
                const d = days ?? 14;
                const lim = limit ?? 20;
                const now = new Date().toISOString();
                const cutoff = new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();
                const rows = await pluginCtx.queryRows(
                    `MATCH (e:PersonalEvent)
                     WHERE e.startsAt IS NOT NULL AND e.startsAt <> ''
                        AND e.startsAt >= $now
                        AND e.startsAt <= $cutoff
                     RETURN e.id AS id, e.displayName AS displayName,
                            e.kind AS kind, e.startsAt AS startsAt,
                            e.endsAt AS endsAt, e.notes AS notes
                     ORDER BY e.startsAt ASC LIMIT $lim`,
                    { now, cutoff, lim },
                );
                // Also include people involved in each event.
                const enriched = [] as unknown[];
                for (const r of rows) {
                    const involved = await pluginCtx.queryRows(
                        `MATCH (:PersonalEvent {id: $id})-[:PersonInvolves]->(p:Person)
                         RETURN p.id AS id, p.displayName AS displayName`,
                        { id: r.id as string },
                    );
                    enriched.push({ ...r, involves: involved });
                }
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            windowDays: d,
                            now,
                            cutoff,
                            count: enriched.length,
                            events: enriched,
                        }, null, 2),
                    }],
                };
            } catch (err) {
                return {
                    content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }],
                    isError: true,
                };
            }
        },
    );
}

export const PERSONAL_TOOL_NAMES = [
    'recall_person',
    'memory_search',
    'upcoming',
] as const;
