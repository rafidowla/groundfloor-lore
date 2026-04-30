/**
 * analytics/_shims.d.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Module shims for graphology ecosystem packages without bundled types.
 *
 * Original work authored for groundfloor-lore. License-compliance
 * protocol per docs/PLAN_replace_gitnexus_in_developer_plugin.md
 * section 10.
 *
 * Phase: 4 (architectural analytics).
 */

declare module 'graphology-pagerank' {
    import type { AbstractGraph } from 'graphology-types';
    export default function pagerank(
        graph: AbstractGraph,
        options?: {
            alpha?: number;
            tolerance?: number;
            maxIterations?: number;
            getEdgeWeight?: string | null;
        },
    ): Record<string, number>;
}
