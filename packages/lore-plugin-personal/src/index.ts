/**
 * index.ts — Personal plugin (Phase 5 / P2).
 *
 * The flagship plugin. Makes Lore useful for one person in one life:
 * memories, people, places, events — all privately on disk, searchable
 * through the chat interface, grounded in real content the user has
 * ingested (photos, emails, voice memos, documents).
 *
 * MVP scope (what this commit ships):
 *   - Schema: Person, Place, PersonalEvent, Memory + 5 rel tables
 *   - contributeSystemPrompt: warm tone, first-name basis, privacy-strict
 *   - Tools: recall_person, memory_search, upcoming (3 core flows)
 *   - Retention: memories forever; communications archived after 3 years
 *
 * Post-MVP (when a real user demands):
 *   - Interpretation rules (photo EXIF → Memory, email → Communication
 *     with auto-linked Person)
 *   - Write tools (add_event, add_person, link_people)
 *   - Timeline tool (chronological view for a Person or Place)
 *   - Birthdays / anniversaries surfacing
 *   - Communication node type + rel table
 *   - Task + Routine node types
 *
 * Naming convention:
 *   Node types use PascalCase to match their semantic weight and to
 *   distinguish from generic core types (decision, note, bug_pattern
 *   all lowercase). PascalCase reads as proper-noun, lowercase reads
 *   as concept — matches the domain.
 */

import type {
    AnalyticalProjection,
    ILorePlugin,
    PluginContext,
    PluginGraphContext,
    RetentionRule,
} from '@lore-core/plugins/types.js';
import { registerPersonalSchema } from './schema.js';
import { registerPersonalTools, PERSONAL_TOOL_NAMES } from './tools.js';

export const PERSONAL_TOOL_LIST: ReadonlyArray<string> = PERSONAL_TOOL_NAMES;

export const personalPlugin: ILorePlugin = {
    name: 'personal',
    version: '0.1.0',
    description: 'Personal knowledge graph — people, places, events, memories, private by default.',

    // Kùzu tables owned by this plugin. Core checks for collisions at boot
    // across active plugins.
    ownedTables: [
        'Person',
        'Place',
        'PersonalEvent',
        'Memory',
        'PersonLivesAt',
        'PersonInvolves',
        'MemoryInvolves',
        'MemoryOccurredAt',
        'PersonRelatedTo',
    ],

    // Domain node types (distinct from core types like decision / note).
    nodeTypes: ['Person', 'Place', 'PersonalEvent', 'Memory'],
    edgeRelations: ['lives_at', 'involves', 'occurred_at', 'related_to'],

    // Q1.4 — Declarative IR. Four domain nodes (Person, Place,
    // PersonalEvent, Memory) plus five relationship tables that
    // connect them. No overlap with core vocabulary — everything
    // here is plugin-native.
    ir: {
        version: '1.0.0',
        ownedNodeTables: ['Person', 'Place', 'PersonalEvent', 'Memory'],
        ownedEdgeTables: ['PersonLivesAt', 'PersonInvolves', 'MemoryInvolves', 'MemoryOccurredAt', 'PersonRelatedTo'],
        nodeKinds: ['Person', 'Place', 'PersonalEvent', 'Memory'],
        edgeKinds: ['lives_at', 'involves', 'occurred_at', 'related_to'],
    },

    uiHints: {
        modeLabel: 'Personal',
        systemPrompt: 'Personal knowledge graph active — warm tone, private by default.',
        defaultFilterTypes: ['Person', 'Place', 'PersonalEvent', 'Memory'],
        cameraFocusTag: 'personal',
    },

    registerTools(server, ctx: PluginContext) {
        registerPersonalTools(server, ctx);
    },

    async registerSchema(ctx: PluginGraphContext) {
        await registerPersonalSchema(ctx);
    },

    /**
     * Phase 1 / C2 — domain-aware LLM guidance. Sets warm, first-name
     * basis. Privacy-strict: never suggest posting personal details
     * outside the workspace. Time-aware: ground answers in today's
     * date so "upcoming" and "next week" resolve correctly.
     */
    contributeSystemPrompt(_ctx: PluginContext): string | null {
        return [
            'This workspace is personal — prefer warmth over formality. Use first names when addressing or',
            "referring to Person nodes (e.g. \"Sarah\" not \"Ms. Chen\"). Acknowledge relationships naturally.",
            '',
            'Privacy: content here is private by default. Never suggest sharing personal details outside',
            'this workspace, never recommend public posts involving family or medical information, and',
            'treat anything unfamiliar as sensitive unless the user has clearly shared it broadly.',
            '',
            "Time-aware: ground time-sensitive answers in today's actual date. When the user asks about",
            '"upcoming" or "this week," use the upcoming tool with an explicit day window. When they ask',
            '"when did we...", search Memory by occurredAt.',
            '',
            "When asked 'what do I know about <person>?', use recall_person — it returns the 360° view",
            "(places, upcoming events, recent memories, declared relationships). Don't guess from the chat",
            'context alone if the tool is available.',
            '',
            'When the LLM cites a fact from a Memory or Person node, include the node id in the response',
            'so the user can navigate back to the source.',
        ].join('\n');
    },

    /**
     * Phase 5 / C12 — retention policy for personal data.
     *
     * Default policy leans toward KEEPING: memories are the whole point
     * of Lore Personal. Users can override per-workspace later.
     */
    contributeRetentionPolicy(): RetentionRule[] {
        return [
            { nodeType: 'Memory',        condition: 'age', ageThresholdDays: 10_000, action: 'keep-forever' },
            { nodeType: 'Person',        condition: 'age', ageThresholdDays: 10_000, action: 'keep-forever' },
            { nodeType: 'Place',         condition: 'age', ageThresholdDays: 10_000, action: 'keep-forever' },
            { nodeType: 'PersonalEvent', condition: 'age', ageThresholdDays: 10_000, action: 'keep-forever' },
        ];
    },

    /**
     * Q1.5 — personal analytical projections.
     *
     * Three flavors covering the core "shape of my life" questions:
     *   - memories-by-month : time-series, powers the Q1.6 line chart
     *     "when did we do things?" view.
     *   - events-upcoming-by-week : forward-looking time-series for
     *     planning view. Distinct from the `upcoming` MCP tool — that
     *     returns individual events; this returns weekly bucket counts.
     *   - people-by-relation : grouping the relationship graph —
     *     "how many people are family vs colleague vs friend?"
     */
    contributeAnalyticalProjections(): AnalyticalProjection[] {
        return [
            {
                id: 'memories-by-month',
                label: 'Memories by month',
                description: 'Count of memories grouped by the YYYY-MM bucket of their occurredAt date.',
                intentKeywords: ['memory', 'memories', 'month', 'when', 'by', 'timeline'],
                columns: [
                    { name: 'month', kind: 'time', description: 'YYYY-MM' },
                    { name: 'memory_count', kind: 'measure' },
                ],
                async run(ctx: PluginGraphContext) {
                    const rows = await ctx.queryRows(
                        `MATCH (m:Memory)
                         WHERE m.occurredAt IS NOT NULL AND m.occurredAt <> ''
                         RETURN substring(m.occurredAt, 0, 7) AS month, count(m) AS memory_count
                         ORDER BY month`,
                        {},
                    );
                    const ids = await ctx.queryRows(
                        'MATCH (m:Memory) WHERE m.occurredAt IS NOT NULL AND m.occurredAt <> \'\' RETURN m.id AS id',
                        {},
                    );
                    return {
                        columns: [
                            { name: 'month', kind: 'time' as const },
                            { name: 'memory_count', kind: 'measure' as const },
                        ],
                        rows: rows.map((r) => ({
                            month: String(r.month ?? ''),
                            memory_count: Number(r.memory_count ?? 0),
                        })),
                        sourceNodeIds: ids.map((r) => String(r.id ?? '')).filter(Boolean),
                    };
                },
            },
            {
                id: 'people-by-relation',
                label: 'People by declared relation',
                description: 'Count of Person nodes grouped by the PersonRelatedTo relation label (family, friend, colleague, etc.).',
                intentKeywords: ['people', 'person', 'relation', 'family', 'friend', 'colleague', 'how many'],
                columns: [
                    { name: 'relation', kind: 'dimension' },
                    { name: 'person_count', kind: 'measure' },
                ],
                async run(ctx: PluginGraphContext) {
                    const rows = await ctx.queryRows(
                        `MATCH (:Person)-[r:PersonRelatedTo]->(p:Person)
                         RETURN r.relationLabel AS relation, count(DISTINCT p) AS person_count
                         ORDER BY person_count DESC`,
                        {},
                    );
                    const ids = await ctx.queryRows(
                        'MATCH (p:Person) RETURN p.id AS id LIMIT 500',
                        {},
                    );
                    return {
                        columns: [
                            { name: 'relation', kind: 'dimension' as const },
                            { name: 'person_count', kind: 'measure' as const },
                        ],
                        rows: rows.map((r) => ({
                            relation: String(r.relation ?? '(unlabeled)'),
                            person_count: Number(r.person_count ?? 0),
                        })),
                        sourceNodeIds: ids.map((r) => String(r.id ?? '')).filter(Boolean),
                    };
                },
            },
        ];
    },
};
