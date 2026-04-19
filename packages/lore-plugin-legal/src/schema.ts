/**
 * schema.ts — Legal plugin schema (Phase 6 / P3).
 *
 * The Legal plugin is the featherweight exemplar: proves you can add
 * a domain-aware plugin with just schema + prompt, no custom tools.
 * Four node types, one relationship — total surface ~60 lines.
 *
 * Use: a lawyer, contract manager, or anyone dealing with regulated
 * documents. Ingest your contracts as text (PDF extractor produces the
 * raw), then ask Lore questions about them. The prompt hook teaches the
 * LLM the legal conventions (info vs. advice, clause citations).
 */

import type { PluginGraphContext } from '@lore-core/plugins/types.js';

export async function registerLegalSchema(ctx: PluginGraphContext): Promise<void> {
    await ctx.executeQuery(`
        CREATE NODE TABLE IF NOT EXISTS Contract (
            id STRING,
            displayName STRING,
            jurisdiction STRING,
            effectiveDate STRING,
            expiryDate STRING,
            content STRING,
            createdAt STRING,
            updatedAt STRING,
            PRIMARY KEY (id)
        )
    `);

    await ctx.executeQuery(`
        CREATE NODE TABLE IF NOT EXISTS Clause (
            id STRING,
            displayName STRING,
            kind STRING,
            content STRING,
            sectionRef STRING,
            createdAt STRING,
            updatedAt STRING,
            PRIMARY KEY (id)
        )
    `);

    await ctx.executeQuery(`
        CREATE NODE TABLE IF NOT EXISTS Party (
            id STRING,
            displayName STRING,
            kind STRING,
            notes STRING,
            createdAt STRING,
            updatedAt STRING,
            PRIMARY KEY (id)
        )
    `);

    await ctx.executeQuery(`
        CREATE NODE TABLE IF NOT EXISTS Jurisdiction (
            id STRING,
            displayName STRING,
            code STRING,
            createdAt STRING,
            updatedAt STRING,
            PRIMARY KEY (id)
        )
    `);

    // Relationships
    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS ContractContainsClause (
            FROM Contract TO Clause,
            confidence STRING DEFAULT 'extracted'
        )
    `);
    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS ContractInvolvesParty (
            FROM Contract TO Party,
            role STRING,
            confidence STRING DEFAULT 'extracted'
        )
    `);
    await ctx.executeQuery(`
        CREATE REL TABLE IF NOT EXISTS ContractGovernedBy (
            FROM Contract TO Jurisdiction,
            confidence STRING DEFAULT 'extracted'
        )
    `);
}
