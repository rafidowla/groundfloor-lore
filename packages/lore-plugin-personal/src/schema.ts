/**
 * schema.ts — Personal plugin Kùzu schema (Phase 5 / P2).
 *
 * The Personal plugin adds these node types:
 *
 *   Person       Anyone in your life — family, friends, colleagues,
 *                doctors, teachers. Connected to Places (lives_at,
 *                works_at), Events (involves), Memories (involves),
 *                Interests (prefers).
 *
 *   Place        Home, work, schools, restaurants, travel destinations.
 *                Memories and Events occurred_at a Place.
 *
 *   Event        Birthdays, anniversaries, meetings, trips, appointments.
 *                Time-bound. Links to Person via involves.
 *
 *   Memory       A moment worth remembering — a photo, a voice memo,
 *                a journal entry. Has an occurred_at for chronology
 *                and involves links to the people in it.
 *
 * Plus edge tables for the relationships above. Core LoreEdge already
 * exists for generic edges (store_edge, reconnect semantic neighbors);
 * plugin-owned edges go in their own REL tables so they don't pollute
 * core's inferred-edge space and can be pruned independently.
 */

import type { PluginGraphContext } from '@lore-core/plugins/types.js';

export async function registerPersonalSchema(ctx: PluginGraphContext): Promise<void> {
    // ─── Node tables ─────────────────────────────────────────
    await ctx.executeQuery(`
        CREATE NODE TABLE IF NOT EXISTS Person (
            id STRING,
            displayName STRING,
            givenName STRING,
            familyName STRING,
            role STRING,
            notes STRING,
            createdAt STRING,
            updatedAt STRING,
            PRIMARY KEY (id)
        )
    `);

    await ctx.executeQuery(`
        CREATE NODE TABLE IF NOT EXISTS Place (
            id STRING,
            displayName STRING,
            kind STRING,
            address STRING,
            latitude DOUBLE,
            longitude DOUBLE,
            notes STRING,
            createdAt STRING,
            updatedAt STRING,
            PRIMARY KEY (id)
        )
    `);

    await ctx.executeQuery(`
        CREATE NODE TABLE IF NOT EXISTS PersonalEvent (
            id STRING,
            displayName STRING,
            kind STRING,
            startsAt STRING,
            endsAt STRING,
            notes STRING,
            createdAt STRING,
            updatedAt STRING,
            PRIMARY KEY (id)
        )
    `);

    await ctx.executeQuery(`
        CREATE NODE TABLE IF NOT EXISTS Memory (
            id STRING,
            displayName STRING,
            content STRING,
            sourceRef STRING,
            occurredAt STRING,
            createdAt STRING,
            updatedAt STRING,
            PRIMARY KEY (id)
        )
    `);

    // ─── Relationship tables ─────────────────────────────────
    // Each plugin-owned rel table keeps the reconnect.ts prune path
    // simple: the registry hands pruneInferredEdges(prefix) to this
    // plugin, it wipes its own.
    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS PersonLivesAt (
            FROM Person TO Place,
            since STRING,
            confidence STRING DEFAULT 'extracted'
        )
    `);
    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS PersonInvolves (
            FROM PersonalEvent TO Person,
            role STRING,
            confidence STRING DEFAULT 'extracted'
        )
    `);
    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS MemoryInvolves (
            FROM Memory TO Person,
            confidence STRING DEFAULT 'extracted'
        )
    `);
    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS MemoryOccurredAt (
            FROM Memory TO Place,
            confidence STRING DEFAULT 'extracted'
        )
    `);
    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS PersonRelatedTo (
            FROM Person TO Person,
            relation STRING,
            confidence STRING DEFAULT 'extracted'
        )
    `);
}
