/**
 * captureIfWorthRemembering.ts — inbound half of the context-injection helper.
 *
 * Decided 2026-08-03 (context-injection-helper-placement): the INBOUND
 * direction — "was anything in this conversation worth remembering, and how
 * should it be summarized" — needs a judgment call, which means it needs an
 * LLM. Lore/the helper ships no LLM credentials of its own (Lore Core's
 * write path stays LLM-free by design — see D-025 in scripts/test-arch.mjs
 * and the module doc comment in `./index.ts`), so the CALLER supplies an
 * `llm: (prompt: string) => Promise<string>` callable. This keeps the helper
 * provider-agnostic, matching Core's own zero-provider-coupling principle
 * one level up.
 *
 * This function is explicitly OPT-IN AT THE CALL SITE — it does not run on
 * every turn or watch traffic automatically (that's the network-relay/proxy
 * design that was considered and shelved). The app decides when to call it,
 * e.g. once after a conversation turn completes.
 *
 * Node `type` is product vocabulary, not something this schema-agnostic
 * helper hardcodes. `opts.defaultType` (default `'note'`) is both (a) the
 * suggested type offered to the LLM in the judgment prompt and (b) the
 * fallback when the LLM's verdict omits one — the caller fully controls it.
 */

import { randomUUID } from 'node:crypto';
import type { LoreInstance } from '../mcp/server.js';

export interface CaptureInteraction {
    /** The input side of the exchange (e.g. the user's message / prompt). */
    input: string;
    /** The output side of the exchange (e.g. the model's response). */
    output: string;
    /** Optional extra context to include in the judgment prompt (e.g. a
     *  system prompt excerpt, or prior turns) — purely advisory, not stored
     *  verbatim unless the LLM's summary happens to echo it. */
    context?: string;
}

export interface CaptureOpts {
    /** Caller-supplied LLM callable. Receives the judgment prompt this
     *  module builds; must resolve to the model's raw text response. Lore
     *  never calls out to a provider directly — this is the ONLY way an LLM
     *  gets involved in this module. */
    llm: (prompt: string) => Promise<string>;
    /** Target workspace for the write (required — same contract as
     *  `LoreInstance.nodeUpsert`). */
    workspace: string;
    /** Ecosystem for the write. Defaults to '*'. */
    ecosystem?: string;
    /** `nodeData.project`. Defaults to `workspace` (matches the convention
     *  used throughout this codebase's embedded-mode examples/tests). */
    project?: string;
    /** Suggested/fallback node type. Default `'note'`. See module doc — this
     *  is how the caller overrides the type vocabulary without this helper
     *  hardcoding domain-specific types. */
    defaultType?: string;
    /** Node id. Default: a fresh `randomUUID()`. Supply your own for
     *  idempotent/dedupable writes. */
    id?: string;
    /** Extra tags applied to the stored node, if worth keeping. */
    tags?: string[];
    /** Forwarded to `nodeUpsert`. Default true (embed in background; matches
     *  the README's embedded-mode example default). */
    asyncEmbed?: boolean;
}

export interface CaptureResult {
    /** Whether a node was actually written. */
    stored: boolean;
    /** The written node's id, when `stored` is true. */
    nodeId?: string;
    /** The type the node was stored as, when `stored` is true. */
    type?: string;
    /** Human-readable reason — the LLM's stated reason when supplied, or a
     *  stable code (`llm_response_unparseable`, `llm_verdict_incomplete`,
     *  `nodeUpsert_failed: <code>`) when `stored` is false. */
    reason?: string;
}

/** The parsed shape we expect back from the LLM's judgment response. */
interface Verdict {
    worth_keeping: boolean;
    type?: string;
    label?: string;
    content?: string;
    reason?: string;
}

function buildJudgmentPrompt(interaction: CaptureInteraction, defaultType: string): string {
    return [
        'You are deciding whether a conversation turn contains information',
        'worth storing in long-term memory for a future, UNRELATED conversation.',
        '',
        'INPUT:',
        interaction.input,
        '',
        'OUTPUT:',
        interaction.output,
        ...(interaction.context ? ['', 'ADDITIONAL CONTEXT:', interaction.context] : []),
        '',
        'Decide:',
        '1. Is there a durable fact, decision, preference, or correction here',
        '   that would be useful to recall later, with NO other context? Trivial',
        '   chit-chat, already-known facts, and one-off task mechanics are NOT',
        '   worth keeping.',
        '2. If worth keeping, extract a concise memory: a short label (<= 80',
        '   chars) and 1-3 sentences of content, written as a standalone fact',
        '   (it will be read later with none of this conversation attached).',
        `3. Suggest a "type" for this memory (e.g. "${defaultType}", or something`,
        '   more specific if obviously appropriate — this is a free-form label,',
        '   not a fixed enum).',
        '',
        'Respond with ONLY a JSON object — no markdown code fences, no',
        'commentary before or after it:',
        '{"worth_keeping": true|false, "type": "...", "label": "...", "content": "...", "reason": "..."}',
    ].join('\n');
}

/** Tolerates the common LLM habit of wrapping JSON in a ```json fence
 *  despite being told not to. Returns null (never throws) on anything that
 *  doesn't parse to an object carrying a boolean `worth_keeping`. */
function parseVerdict(raw: string): Verdict | null {
    const text = raw.trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced ? fenced[1] : text)?.trim();
    if (!candidate) return null;
    try {
        const parsed: unknown = JSON.parse(candidate);
        if (
            parsed !== null &&
            typeof parsed === 'object' &&
            typeof (parsed as Record<string, unknown>).worth_keeping === 'boolean'
        ) {
            return parsed as Verdict;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * captureIfWorthRemembering — LLM-judged inbound capture.
 *
 * Sends `interaction` through a judgment prompt via the caller-supplied
 * `opts.llm`, and — only if the verdict says it's worth keeping — writes a
 * node via `lore.nodeUpsert(...)`. Never runs automatically; the caller
 * decides when to invoke this (e.g. after a conversation turn).
 *
 * Never throws on a malformed/unparseable LLM response — that's reported as
 * `{ stored: false, reason: 'llm_response_unparseable' }` so a flaky model
 * output doesn't crash the caller's turn. A rejected `opts.llm(...)` promise
 * (e.g. the caller's own network error) is NOT caught here and propagates —
 * that's the caller's own failure to handle, not a capture-judgment outcome.
 */
export async function captureIfWorthRemembering(
    lore: LoreInstance,
    interaction: CaptureInteraction,
    opts: CaptureOpts,
): Promise<CaptureResult> {
    const defaultType = opts.defaultType?.trim() || 'note';
    const prompt = buildJudgmentPrompt(interaction, defaultType);
    const raw = await opts.llm(prompt);
    const verdict = parseVerdict(raw);

    if (!verdict) {
        return { stored: false, reason: 'llm_response_unparseable' };
    }
    if (!verdict.worth_keeping) {
        return { stored: false, reason: verdict.reason?.trim() || 'llm judged this not worth keeping' };
    }

    const label = verdict.label?.trim();
    const content = verdict.content?.trim();
    if (!label || !content) {
        return { stored: false, reason: 'llm_verdict_incomplete: worth_keeping=true but label/content missing' };
    }
    const type = verdict.type?.trim() || defaultType;

    const id = opts.id ?? randomUUID();
    const workspace = opts.workspace;
    const ecosystem = opts.ecosystem ?? '*';
    const project = opts.project ?? workspace;

    const result = await lore.nodeUpsert({
        id,
        workspace,
        ecosystem,
        nodeData: {
            id,
            ecosystem,
            type,
            label,
            content,
            tags: opts.tags ?? [],
            project,
            metadata: JSON.stringify({ capturedVia: 'lore/inject' }),
        },
        asyncEmbed: opts.asyncEmbed ?? true,
    });

    if (!result.ok) {
        return { stored: false, type, reason: `nodeUpsert_failed: ${result.code} - ${result.error.message}` };
    }
    return { stored: true, nodeId: result.node.id, type, reason: verdict.reason?.trim() || undefined };
}
