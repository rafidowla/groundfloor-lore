/**
 * inject/index.ts — context-injection helper entry point (`@groundfloor/lore/inject`).
 *
 * Decided 2026-08-03 (context-injection-helper-placement, workspace `lore`):
 * Lore is only used when the AI remembers to call it. Every app embedding
 * Lore had to independently reinvent "what context matters before this model
 * call" and "what's worth remembering after it" — this module is the shared
 * answer, as a helper the app CALLS EXPLICITLY. It is NOT a network
 * proxy/relay that intercepts LLM traffic automatically — that approach was
 * considered and shelved (too much attack surface, breaks prompt caching,
 * unnecessary since every current consumer is an app we control).
 *
 * Two directions, both live here (not in Lore core) because the cut line is
 * mechanical-vs-judgment, not inbound-vs-outbound:
 *
 * - {@link getRelevantContext} (OUTBOUND) — pure retrieval. `lore.recall()`
 *   already does semantic ranking, so no LLM is needed on this side.
 * - {@link captureIfWorthRemembering} (INBOUND) — needs a judgment call
 *   ("is this worth keeping, and how should it be summarized"), so it needs
 *   an LLM. Lore ships no LLM credentials of its own, so the CALLER supplies
 *   an `llm: (prompt: string) => Promise<string>` callable — this keeps the
 *   helper provider-agnostic, matching Core's own zero-provider-coupling
 *   principle one level up. It is explicitly opt-in AT THE CALL SITE; it
 *   never runs automatically.
 *
 * Architectural rule (enforced by D-025 in scripts/test-arch.mjs): this
 * module may import Lore core; Lore core must NEVER import this module. That
 * one-way boundary is what keeps Lore's write path LLM-free — Lore Core
 * never needs LLM credentials to start, unlike TencentDB-Agent-Memory, which
 * requires two LLM configs just to boot because it entangled memory-write
 * with memory-judgment. This module is deliberately the only place in this
 * codebase that entanglement is allowed to exist.
 *
 * Neither function ever touches a provider-specific message format —
 * `getRelevantContext` returns a plain `string`; `captureIfWorthRemembering`
 * accepts plain `{ input, output }` strings. The app owns its own message
 * shape and decides where to splice the returned text in.
 *
 * # Usage
 *
 * ```ts
 * import { createLore } from '@groundfloor/lore';
 * import { getRelevantContext, captureIfWorthRemembering } from '@groundfloor/lore/inject';
 *
 * const lore = await createLore({ deploymentMode: 'embedded' });
 *
 * // Before a model call — fetch what's worth telling the model.
 * const userMessage = 'What did we decide about the caching layer?';
 * const context = await getRelevantContext(lore, userMessage, {
 *   workspace: 'default',
 *   maxChars: 2000, // optional; defaults to DEFAULT_MAX_CHARS (4000)
 * });
 *
 * const prompt = context
 *   ? `Relevant memory:\n${context}\n\nUser: ${userMessage}`
 *   : `User: ${userMessage}`;
 * const reply = await callMyOwnLlm(prompt); // the app's own provider call — untouched by this module
 *
 * // After the turn — opt-in capture. The app decides when to call this;
 * // it never runs on its own.
 * const capture = await captureIfWorthRemembering(
 *   lore,
 *   { input: userMessage, output: reply },
 *   {
 *     llm: (judgmentPrompt) => callMyOwnLlm(judgmentPrompt), // same or a cheaper model — caller's choice
 *     workspace: 'default',
 *     defaultType: 'decision', // optional override; defaults to 'note'
 *   },
 * );
 * if (capture.stored) console.log('remembered:', capture.nodeId, capture.type);
 *
 * await lore.dispose();
 * ```
 */

export {
    getRelevantContext,
    DEFAULT_MAX_CHARS,
    type GetRelevantContextOpts,
} from './getRelevantContext.js';

export {
    captureIfWorthRemembering,
    type CaptureInteraction,
    type CaptureOpts,
    type CaptureResult,
} from './captureIfWorthRemembering.js';
