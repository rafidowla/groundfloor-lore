/**
 * index.ts — Legal plugin (Phase 6 / P3).
 *
 * The FEATHERWEIGHT exemplar. Demonstrates the minimum viable plugin
 * pattern: schema + prompt + retention. NO custom tools, NO
 * interpretation rules. The LLM uses core's generic store_node /
 * store_edge with the legal schema types; everything else is just
 * vocabulary + instructions.
 *
 * Why this is valuable:
 *   - Shows that adding Lore-native support for a new domain can cost
 *     a day, not a week.
 *   - Proves the featherweight tier of the plugin spectrum works in
 *     production alongside the heavyweight (developer) and mid-weight
 *     (personal) plugins.
 *   - Serves as a copy-paste template for future domain plugins
 *     (medical, academic, finance-basic, research, etc.).
 *
 * Total surface: ~100 LOC across schema + index. No tools.ts file.
 */

import type {
    ILorePlugin,
    PluginContext,
    PluginGraphContext,
    RetentionRule,
} from '@lore-core/plugins/types.js';
import { registerLegalSchema } from './schema.js';

export const legalPlugin: ILorePlugin = {
    name: 'legal',
    version: '0.1.0',
    description: 'Contracts, clauses, parties, jurisdictions — featherweight legal-domain vocabulary.',

    ownedTables: [
        'Contract',
        'Clause',
        'Party',
        'Jurisdiction',
        'ContractContainsClause',
        'ContractInvolvesParty',
        'ContractGovernedBy',
    ],

    nodeTypes: ['Contract', 'Clause', 'Party', 'Jurisdiction'],
    edgeRelations: ['contains', 'involves', 'governed_by'],

    // Q1.4 — Featherweight IR. Legal is the minimum viable plugin:
    // four nodes, three edges, no custom tools. IR keeps pace with
    // the tables declared in schema.ts.
    ir: {
        version: '1.0.0',
        ownedNodeTables: ['Contract', 'Clause', 'Party', 'Jurisdiction'],
        ownedEdgeTables: ['ContractContainsClause', 'ContractInvolvesParty', 'ContractGovernedBy'],
        nodeKinds: ['Contract', 'Clause', 'Party', 'Jurisdiction'],
        edgeKinds: ['contains', 'involves', 'governed_by'],
    },

    uiHints: {
        modeLabel: 'Legal',
        systemPrompt: 'Legal vocabulary active — contracts, clauses, parties, jurisdictions.',
        defaultFilterTypes: ['Contract', 'Clause', 'Party', 'Jurisdiction'],
        cameraFocusTag: 'legal',
    },

    registerTools(_server, _ctx: PluginContext) {
        // Intentional no-op. This plugin contributes schema + prompt
        // only — the user interacts through core's generic store_node /
        // store_edge tools with the legal type names. Tool-free plugins
        // are a first-class pattern.
    },

    async registerSchema(ctx: PluginGraphContext) {
        await registerLegalSchema(ctx);
    },

    /**
     * Phase 1 / C2 — the critical legal-domain LLM guidance:
     *
     *   1. INFORMATION vs. ADVICE. Lawyers are trained on this
     *      distinction; the LLM needs to be too. Information =
     *      "Clause 3.2 says X." Advice = "You should accept clause 3.2."
     *      The prompt forbids advice and requires a referral to counsel
     *      when one would be natural.
     *
     *   2. CITATION REQUIRED. Every factual claim about a contract
     *      must cite the Contract node id AND the Clause sectionRef
     *      if applicable. No "I think the contract says..." — either
     *      cite or decline.
     *
     *   3. TERMINOLOGY. "Consideration" means value exchanged, not
     *      "thought." "Party" is a legal entity, not a social gathering.
     *      The LLM is told which homographs have legal-specific meanings
     *      in this workspace.
     *
     *   4. JURISDICTION AWARE. Contract clauses interpret differently
     *      across jurisdictions. When the user asks about a specific
     *      contract, check its ContractGovernedBy edge and factor in.
     */
    contributeSystemPrompt(_ctx: PluginContext): string | null {
        return [
            'This workspace contains legal documents — contracts, clauses, parties, jurisdictions.',
            '',
            'CRITICAL: distinguish legal INFORMATION from legal ADVICE.',
            '  Information: "Clause 3.2 says X." "Two parties are involved: Acme and Beta."',
            '  Advice:      "You should sign this." "This clause is unenforceable."',
            "Provide information freely when it's grounded in the graph. NEVER provide advice — when the",
            'user asks "should I ...?" or "is this enforceable?", decline and recommend consulting a',
            'licensed attorney in the relevant jurisdiction.',
            '',
            'Citation required: every factual claim about a contract must cite the Contract node id',
            'and the Clause sectionRef if applicable. Do not paraphrase without citation. If the graph',
            "doesn't contain enough context to cite, say so — don't guess.",
            '',
            'Terminology conventions in this workspace:',
            '  - "Consideration" = something of value exchanged between parties (the legal-specific',
            '    meaning, not "thought" or "contemplation").',
            '  - "Party"        = a legal entity bound by the contract (not a social event).',
            '  - "Execute"      = sign into effect (not "run" or "perform").',
            '',
            'Jurisdiction awareness: contracts interpret differently across jurisdictions. When',
            'answering about a specific Contract, consult its ContractGovernedBy edge and factor the',
            "governing jurisdiction into the answer. Don't compare across jurisdictions without flagging",
            "the comparison explicitly.",
        ].join('\n');
    },

    contributeRetentionPolicy(): RetentionRule[] {
        return [
            { nodeType: 'Contract',     condition: 'age', ageThresholdDays: 10_000, action: 'keep-forever' },
            { nodeType: 'Clause',       condition: 'age', ageThresholdDays: 10_000, action: 'keep-forever' },
            { nodeType: 'Party',        condition: 'age', ageThresholdDays: 10_000, action: 'keep-forever' },
            { nodeType: 'Jurisdiction', condition: 'age', ageThresholdDays: 10_000, action: 'keep-forever' },
        ];
    },
};
