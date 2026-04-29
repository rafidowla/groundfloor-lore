/**
 * queryPatterns.ts — Stock query templates Tier 1 plugins reference by name.
 *
 * Many Tier 1 plugins want to do the same handful of things — find a node
 * by a field value, count by a value, list recent records of their type.
 * Writing the Cypher for each is repetitive (every plugin types out the
 * same `MATCH (n:LoreNode) WHERE n.type = '<x>' AND ...` boilerplate)
 * and error-prone (every plugin gets to invent slightly different
 * "case-insensitive substring" or "limit ordering" choices).
 *
 * The stock pattern catalog below codifies the common shapes so a plugin
 * can write:
 *
 *   queries:
 *     - id: find_by_dept
 *       pattern: find_by_field
 *       bindNodeType: employee
 *       description: Find employees by department.
 *       parameters:
 *         - { name: value, type: string, required: true, description: ... }
 *
 * …and get a working query without ever writing Cypher.
 *
 * The expansion is pure: `expandPattern(spec)` returns a `QuerySpec` with
 * the cypher field filled in. `validateManifest` runs expansion as part
 * of validation so unknown patterns surface at validate time, not boot.
 */

import type { RawCypherQuerySpec, QueryParameter } from '../manifest.js';

/**
 * The stock pattern catalog. Each entry knows:
 *   - the Cypher template to emit (with the plugin's type interpolated)
 *   - what parameters the plugin must declare (so a manifest with the
 *     wrong parameter shape fails validation cleanly)
 *
 * Templates use `{{nodeType}}` as the placeholder for the plugin's
 * declared node type — not `$x`, because Kùzu's `$param` is for
 * caller-supplied values, and node-type binding is plugin-time, not
 * call-time.
 */
export interface QueryPattern {
    /** Stable name plugin manifests reference. */
    name: string;
    /** Plain-English description used in error messages and docs. */
    description: string;
    /** Required parameters (by name + type). The manifest's `parameters[]`
     *  must declare each one, with matching types. Extra parameters in
     *  the manifest are allowed (the pattern ignores them). */
    requiredParameters: Array<{ name: string; type: QueryParameter['type'] }>;
    /** Cypher template. `{{nodeType}}` interpolates the plugin's bindNodeType. */
    cypherTemplate: string;
}

export const STOCK_PATTERNS: QueryPattern[] = [
    {
        name: 'find_by_field',
        description: 'Exact-match search on any LoreNode field. Returns id, label, tags, content.',
        requiredParameters: [
            { name: 'field', type: 'string' },
            { name: 'value', type: 'string' },
        ],
        // Kùzu can't parameterise field names safely — `$field` would
        // bind as a value, not a column reference. So we do a CASE on
        // the recognised field set. Anything outside the case → 0 rows.
        // Adding new fields is a deliberate change in this pattern.
        cypherTemplate: `
            MATCH (n:LoreNode)
            WHERE n.type = '{{nodeType}}'
              AND CASE $field
                    WHEN 'label' THEN n.label = $value
                    WHEN 'content' THEN n.content = $value
                    WHEN 'project' THEN n.project = $value
                    WHEN 'ecosystem' THEN n.ecosystem = $value
                    WHEN 'language' THEN n.language = $value
                    WHEN 'id' THEN n.id = $value
                    ELSE false
                  END
            RETURN n.id AS id, n.label AS label, n.tags AS tags, n.content AS content
            ORDER BY n.updatedAt DESC
            LIMIT 100
        `.trim(),
    },
    {
        name: 'find_by_tag_substring',
        description: 'Case-insensitive substring match on the comma-separated tags column. Returns id, label, tags.',
        requiredParameters: [
            { name: 'tag', type: 'string' },
        ],
        cypherTemplate: `
            MATCH (n:LoreNode)
            WHERE n.type = '{{nodeType}}'
              AND lower(n.tags) CONTAINS lower($tag)
            RETURN n.id AS id, n.label AS label, n.tags AS tags
            ORDER BY n.updatedAt DESC
            LIMIT 100
        `.trim(),
    },
    {
        name: 'count_by_field',
        description: 'Count of nodes whose given field equals a value. Returns { hits }.',
        requiredParameters: [
            { name: 'field', type: 'string' },
            { name: 'value', type: 'string' },
        ],
        cypherTemplate: `
            MATCH (n:LoreNode)
            WHERE n.type = '{{nodeType}}'
              AND CASE $field
                    WHEN 'label' THEN n.label = $value
                    WHEN 'content' THEN n.content = $value
                    WHEN 'project' THEN n.project = $value
                    WHEN 'ecosystem' THEN n.ecosystem = $value
                    WHEN 'language' THEN n.language = $value
                    WHEN 'id' THEN n.id = $value
                    ELSE false
                  END
            RETURN count(n) AS hits
        `.trim(),
    },
    {
        name: 'list_recent',
        description: 'List the N most-recently-updated nodes of this plugin\'s type.',
        requiredParameters: [
            { name: 'limit', type: 'number' },
        ],
        // Kùzu doesn't support `LIMIT $param` (literal required). We
        // substitute the limit at expansion time after coercing it from
        // the parameters list — but since limits are caller-supplied,
        // we generate a fixed-LIMIT query and slice client-side instead.
        // Same approach the auto-tools use for list_<type>.
        cypherTemplate: `
            MATCH (n:LoreNode)
            WHERE n.type = '{{nodeType}}'
            RETURN n.id AS id, n.label AS label, n.tags AS tags, n.updatedAt AS updatedAt
            ORDER BY n.updatedAt DESC
            LIMIT 1000
        `.trim(),
    },
];

const PATTERNS_BY_NAME = new Map(STOCK_PATTERNS.map((p) => [p.name, p]));

export function getPattern(name: string): QueryPattern | undefined {
    return PATTERNS_BY_NAME.get(name);
}

export function listPatternNames(): string[] {
    return STOCK_PATTERNS.map((p) => p.name).sort();
}

/**
 * Expand a `pattern`-shaped query spec into a fully-fledged QuerySpec
 * with the cypher field filled in. Throws when the pattern name is
 * unknown OR the manifest's declared parameters don't match the
 * pattern's requirements.
 *
 * The input is the manifest's raw query entry; the output is shape-
 * compatible with the cypher-only QuerySpec the rest of the pipeline
 * already understands.
 */
export interface PatternQueryInput {
    id: string;
    description: string;
    pattern: string;
    bindNodeType: string;
    parameters?: QueryParameter[];
}

export function expandPattern(input: PatternQueryInput): RawCypherQuerySpec {
    const pattern = getPattern(input.pattern);
    if (!pattern) {
        throw new Error(
            `unknown query pattern "${input.pattern}" — known patterns: ${listPatternNames().join(', ')}`,
        );
    }

    const declared = new Map((input.parameters ?? []).map((p) => [p.name, p]));
    const missing: string[] = [];
    const wrongType: string[] = [];
    for (const req of pattern.requiredParameters) {
        const got = declared.get(req.name);
        if (!got) {
            missing.push(`"${req.name}" (${req.type})`);
            continue;
        }
        if (got.type !== req.type) {
            wrongType.push(`"${req.name}" expected ${req.type}, got ${got.type}`);
        }
    }
    if (missing.length > 0 || wrongType.length > 0) {
        const parts: string[] = [];
        if (missing.length > 0) parts.push(`missing parameters: ${missing.join(', ')}`);
        if (wrongType.length > 0) parts.push(wrongType.join('; '));
        throw new Error(`pattern "${input.pattern}" parameter mismatch — ${parts.join('; ')}`);
    }

    const cypher = pattern.cypherTemplate.replaceAll('{{nodeType}}', input.bindNodeType);
    return {
        id: input.id,
        description: input.description,
        cypher,
        parameters: input.parameters ?? [],
    };
}

/**
 * Discriminator: a manifest entry is a pattern-spec when it has the
 * `pattern` field; otherwise it's a raw cypher spec. Used by the
 * validator + boot path to route entries.
 */
export function isPatternQueryEntry(entry: unknown): entry is PatternQueryInput {
    return typeof entry === 'object' && entry !== null
        && typeof (entry as Record<string, unknown>)['pattern'] === 'string';
}
