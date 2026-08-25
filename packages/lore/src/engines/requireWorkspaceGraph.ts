/**
 * requireWorkspaceGraph.ts — narrow a graph handle to the local-engine surface,
 * by CAPABILITY rather than by class.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT `requireLocalGraph` ──────────────────
 *
 * `assertLocalGraph.ts`'s `requireLocalGraph` asks `graph instanceof LocalGraph`.
 * That question had the right ANSWER for years only because it was never asked
 * of anything but Kùzu and Dataplane: the daemon's `createGraph` returns a
 * `LocalGraph` unconditionally in local mode, and every per-workspace resolver
 * went through `LocalGraphRegistry.getOrOpen`, which is the Kùzu substrate
 * accessor. Once those route through `getGraphHandle` and a Surreal-backed
 * workspace can actually reach a call site, `instanceof LocalGraph` starts
 * REFUSING a perfectly capable engine — the class is not the capability.
 *
 * The real question is "is this a full local graph engine, or the cloud
 * adapter?", and the honest way to ask it is against the surface both local
 * engines implement and `DataplaneGraph` does not.
 *
 * ── WHY THE PROBE IS TWO METHODS AND NOT ONE ────────────────────────────────
 *
 * `bulkListProjected` and `queryEdges` are the paged node scan and the paged
 * edge scan. Everything else on `WorkspaceGraph` beyond `LoreGraphHandle` is
 * built on one of those two, and `DataplaneGraph` implements neither, so they
 * are the narrowest honest discriminator. Probing a single method would pass a
 * partial implementation that then fails deeper in, which is the failure mode
 * this module exists to convert into a named refusal.
 *
 * Deliberately NOT a structural check of every member: that would make adding
 * a method to `WorkspaceGraph` a silent behaviour change at every call site.
 */

import type { WorkspaceGraph } from './openWorkspaceGraph.js';
import { CloudModeUnsupportedError } from './cloudModeUnsupportedError.js';

/**
 * True when `graph` is a local graph engine — Kùzu or SurrealDB — rather than
 * the cloud adapter. Use when the caller genuinely should no-op in cloud mode;
 * prefer `requireWorkspaceGraph` in an HTTP route, where an explicit 501 beats
 * a silent skip.
 */
export function isWorkspaceGraph(graph: unknown): graph is WorkspaceGraph {
    const c = graph as Partial<WorkspaceGraph> | null | undefined;
    return !!c
        && typeof c.bulkListProjected === 'function'
        && typeof c.queryEdges === 'function';
}

/**
 * Narrow to `WorkspaceGraph`, or throw the 501-shaped
 * `CloudModeUnsupportedError` naming the operation.
 *
 * @param graph      the resolved handle (LocalGraph | SurrealGraph | DataplaneGraph)
 * @param operation  what the caller was trying to do, for the error message
 * @param hint       optional detail — why this operation needs a local engine
 */
export function requireWorkspaceGraph(
    graph: unknown,
    operation: string,
    hint?: string,
): WorkspaceGraph {
    if (isWorkspaceGraph(graph)) return graph;
    throw new CloudModeUnsupportedError(operation, hint ?? 'requires the local paged scan surface');
}
