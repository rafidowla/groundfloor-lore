/**
 * developer/schema.ts — Kùzu schema owned by the Developer plugin.
 *
 * Wired to the ILorePlugin.registerSchema() hook so these tables only
 * materialize when the developer plugin is active in config.plugins[].
 *
 * Tables:
 *   CodeSymbol          — functions, classes, methods, interfaces, sections
 *   CodeFile            — the file each symbol lives in (synthesized from
 *                         symbol.filePath on `lore ingest-files`)
 *   DevActivity         — team branch/file activity tracking
 *
 * Rel tables:
 *   CodeRelation        — CodeSymbol → CodeSymbol (call graph, inheritance)
 *   LoreAppliesToCode   — LoreNode → CodeSymbol (knowledge ↔ symbol)
 *   FileContains        — CodeFile → CodeSymbol (structural containment)
 *   LoreTouchesFile     — LoreNode → CodeFile (knowledge ↔ file)
 *
 * All statements use IF NOT EXISTS so re-running the hook is idempotent
 * and safe on graphs that already have the tables from prior boots.
 */

import type { PluginGraphContext } from '@lore-core/plugins/types.js';

export async function registerDeveloperSchema(ctx: PluginGraphContext): Promise<void> {
    await ctx.executeQuery(`
        CREATE NODE TABLE IF NOT EXISTS CodeSymbol (
            uid STRING,
            name STRING,
            kind STRING,
            filePath STRING,
            startLine INT32,
            endLine INT32,
            content STRING,
            signature STRING,
            returnType STRING,
            parameterCount INT32,
            repo STRING,
            PRIMARY KEY (uid)
        )
    `);

    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS CodeRelation (
            FROM CodeSymbol TO CodeSymbol,
            type STRING,
            confidence DOUBLE,
            reason STRING
        )
    `);

    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS LoreAppliesToCode (
            FROM LoreNode TO CodeSymbol,
            relation STRING
        )
    `);

    await ctx.executeQuery(`
        CREATE NODE TABLE IF NOT EXISTS CodeFile (
            path STRING,
            language STRING,
            loc INT32,
            repo STRING,
            lastModified STRING,
            PRIMARY KEY (path)
        )
    `);

    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS FileContains (
            FROM CodeFile TO CodeSymbol
        )
    `);

    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS LoreTouchesFile (
            FROM LoreNode TO CodeFile,
            relation STRING
        )
    `);

    await ctx.executeQuery(`
        CREATE NODE TABLE IF NOT EXISTS DevActivity (
            id STRING PRIMARY KEY,
            dev STRING,
            project STRING,
            action STRING,
            filePath STRING,
            timestamp STRING,
            tool STRING
        )
    `);
}
