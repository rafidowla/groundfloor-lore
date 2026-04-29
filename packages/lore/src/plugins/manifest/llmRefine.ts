/**
 * llmRefine.ts — Prompt construction + response parsing for the
 * wizard's LLM-escalation path.
 *
 * Extracted from server.ts so we can unit-test the prompt shape (so it
 * can't regress unnoticed) and the JSON extractor (which has to tolerate
 * code fences, leading prose, whitespace, and partial responses from
 * smaller models).
 *
 * The actual LLM dispatch + HTTP wiring stays in server.ts; this module
 * is pure functions.
 */

/**
 * Construct the prompt sent to the user's BYOK LLM when escalating a
 * low-confidence heuristic schema proposal.
 *
 * Goals: short, structured, asks for JSON back. Includes the heuristic's
 * existing proposal so the model refines rather than re-proposes from
 * scratch. Caps the sample at 8 rows so the prompt stays within token
 * budget for embedded/small models.
 */
export function buildPluginWizardLlmPrompt(
    proposal: Record<string, unknown>,
    headers: string[],
    rows: Array<Record<string, string>>,
): string {
    const truncated = rows.slice(0, 8);
    return [
        'You are helping a user create a Lore knowledge-graph plugin from a CSV.',
        'A heuristic detector has already proposed a schema. Refine it using the sample rows.',
        '',
        'Heuristic proposal (JSON):',
        '```json',
        JSON.stringify(proposal, null, 2),
        '```',
        '',
        `CSV headers: ${headers.join(', ')}`,
        '',
        'Sample rows (JSON):',
        '```json',
        JSON.stringify(truncated, null, 2),
        '```',
        '',
        'Return ONLY a JSON object with the same shape as the heuristic proposal:',
        '{',
        '  "suggestedNodeTypeName": "<lowercase_singular>",',
        '  "suggestedFields": { "label"?: "<col>", "content"?: "<col>", "project"?: "<col>", "tags"?: "<col>", "language"?: "<col>" },',
        '  "suggestedIdStrategy": { "kind": "column", "column": "<col>" } | { "kind": "hash", "columns": ["<col>", ...] },',
        '  "notes": ["<one-line reason for any change>", ...]',
        '}',
        '',
        'Rules:',
        '- Only suggest column names that actually appear in the headers above.',
        '- Prefer kind:column for the id strategy when one column is unique.',
        '- The label field is required — pick the most human-readable column.',
        '- Keep the same node type name unless it is genuinely wrong.',
        'Reply with ONLY the JSON object, no preamble, no code fence.',
    ].join('\n');
}

/**
 * Pull the first balanced top-level JSON object out of a string.
 * Tolerates ```json fences, leading/trailing prose, or whitespace.
 * Returns null if no parseable object is found.
 *
 * Why we don't trust the LLM to emit clean JSON despite asking nicely:
 * smaller models routinely add a "Sure! Here's the refined proposal:"
 * preamble or wrap the result in code fences against instruction.
 * This parser handles both gracefully.
 */
export function extractFirstJsonObject(text: string): unknown | null {
    // Strip code fences first if present.
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
    const candidate = fenceMatch?.[1] ?? text;
    // Find the first balanced { ... } block.
    let depth = 0;
    let start = -1;
    for (let i = 0; i < candidate.length; i++) {
        const ch = candidate[i];
        if (ch === '{') {
            if (depth === 0) start = i;
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0 && start >= 0) {
                const slice = candidate.slice(start, i + 1);
                try {
                    return JSON.parse(slice);
                } catch {
                    // Not balanced JSON despite paired braces; keep scanning.
                    start = -1;
                }
            }
        }
    }
    return null;
}
