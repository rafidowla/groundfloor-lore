/**
 * resolver/stackGraphs.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Stack Graphs adapter — wraps the upstream runtime; sidecar invocation lives here if no JS binding ships.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 2 (cross-file resolution — Stack Graphs path, DEFERRED).
 *
 * Phase 0 documented Stack Graphs (Apache 2.0) as the primary
 * cross-file resolver, with a Rust sidecar fallback if no JS/WASM
 * binding existed. At Phase 2 kickoff (2026-04-30) we audited:
 *
 *   - github/stack-graphs ships only Rust crates as of this date.
 *   - The npm `tree-sitter-stack-graphs` package is a placeholder
 *     (no `main` entry, no working JS interface).
 *   - Adding a Rust sidecar binary would introduce a build-time +
 *     ship-time dependency the rest of the project doesn't carry.
 *
 * Decision: ship Phase 2 v1 with the per-language fallback resolver
 * shims (symbolTable.ts + importGraph.ts + inheritance.ts). This
 * file remains a stub until either:
 *
 *   - Stack Graphs publishes a working JS / WASM binding, OR
 *   - Atlas hits a measurable resolution-quality issue that the
 *     fallback shims can't address (e.g. interface dispatch errors
 *     in Java / TS that affect customer-facing analytics).
 *
 * When that day comes, this file gains a TypeScript adapter that:
 *   1. Spawns or links the upstream stack-graphs runtime.
 *   2. Builds a stack graph per ParsedFile.
 *   3. Resolves names via the runtime instead of our heuristics.
 *   4. Returns ParsedRelation[] edges that the orchestrator merges
 *      with import / inheritance / call edges from the fallback path.
 */

/**
 * Marker constant kept so this module exists in the import graph but
 * doesn't try to do anything yet. Replace with the real adapter when
 * Stack Graphs becomes viable.
 */
export const STACK_GRAPHS_DEFERRED = true;

/**
 * Future signature placeholder. Concrete shape will land alongside the
 * actual integration. Documented here so the orchestrator's expected
 * call shape stays clear:
 *
 *   resolveWithStackGraphs(files, ctx): Promise<ParsedRelation[]>
 */
