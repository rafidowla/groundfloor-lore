/**
 * scopeResolver.ts — Scope-based query support (T7).
 *
 * "Scope" answers: given a root node and a workspace-declared traversal
 * rule, which node ids are inside that scope?
 *
 * Two flavours, composable:
 *
 *   1. Hierarchy scope — schema-declared. Workspace says "the scope
 *      called 'property-and-descendants' walks the parent edge in the
 *      'down' direction up to depth 8." The resolver returns the set
 *      of node ids that satisfy that traversal from a given root.
 *
 *   2. Permission scope — separate concern, lives in
 *      security/rebacEvaluator.ts. Filter a candidate id set by what
 *      the caller can see.
 *
 * The resolver is substrate-agnostic. Callers supply a tiny
 * GraphAccessor with two methods (neighborsOut, neighborsIn). Both
 * LocalGraph (Kùzu) and DataplaneGraph (cloud) can implement those.
 *
 * Why a resolver, not Cypher: scope rules are workspace-data, not code.
 * They're authored as part of the schema, evolve with the workspace,
 * and have to work against both substrates uniformly. Pre-walking in
 * application code keeps that promise.
 */

import type { LoreSchemaV2, ScopeDirection, ScopeSpec } from '../schemas/types.js';

/**
 * Tiny graph-accessor interface the resolver needs. Substrate-specific
 * adapters implement this against Kùzu, ArangoDB, or any other graph
 * store. Both directions are required because scopes can walk up,
 * down, or both.
 */
export interface ScopeGraphAccessor {
    /**
     * Return ids reachable from `nodeId` along an outgoing edge whose
     * type is in `edgeTypes`. Up to one hop.
     */
    neighborsOut(nodeId: string, edgeTypes: string[]): Promise<string[]>;

    /**
     * Return ids reachable to `nodeId` along an incoming edge whose
     * type is in `edgeTypes`. Up to one hop.
     */
    neighborsIn(nodeId: string, edgeTypes: string[]): Promise<string[]>;

    /**
     * Optional: type lookup for `includeTypes` filtering. If omitted,
     * the resolver does not apply type filtering even when ScopeSpec
     * declares includeTypes — callers get a more permissive set.
     */
    getNodeType?(nodeId: string): Promise<string | null>;
}

export interface ResolveScopeInput {
    rootId: string;
    /** Either an inline ScopeSpec, or a workspace scope-name. */
    spec?: ScopeSpec;
    scopeName?: string;
    schema?: LoreSchemaV2;
}

export interface ResolveScopeResult {
    ids: string[];
    /** Depth at which the BFS terminated. */
    depthReached: number;
    /** True when traversal hit the maxDepth cap before exhausting. */
    truncated: boolean;
}

const DEFAULT_MAX_DEPTH = 8;

export class ScopeResolver {
    constructor(private readonly graph: ScopeGraphAccessor) { }

    /**
     * Resolve a scope to a list of node ids. BFS bounded by maxDepth.
     *
     * Either pass an inline `spec`, or pass `scopeName + schema` to
     * look up a workspace-declared scope. Throws when the named scope
     * is not declared.
     */
    async resolve(input: ResolveScopeInput): Promise<ResolveScopeResult> {
        const spec = resolveSpec(input);

        const maxDepth = spec.maxDepth ?? DEFAULT_MAX_DEPTH;
        const includeRoot = spec.includeRoot ?? true;
        const includeTypes = spec.includeTypes && spec.includeTypes.length > 0
            ? new Set(spec.includeTypes)
            : null;

        const visited = new Set<string>();
        const out = new Set<string>();
        if (includeRoot) {
            out.add(input.rootId);
        }
        visited.add(input.rootId);

        let frontier = [input.rootId];
        let depth = 0;
        let truncated = false;

        while (frontier.length > 0 && depth < maxDepth) {
            depth++;
            const next: string[] = [];
            for (const id of frontier) {
                const neighbors = await this.stepNeighbors(id, spec.viaEdges, spec.direction);
                for (const n of neighbors) {
                    if (visited.has(n)) continue;
                    visited.add(n);
                    next.push(n);
                    out.add(n);
                }
            }
            if (next.length === 0) break;
            frontier = next;
        }
        if (frontier.length > 0 && depth >= maxDepth) {
            truncated = true;
        }

        let ids = Array.from(out);
        if (includeTypes && this.graph.getNodeType) {
            const filtered: string[] = [];
            for (const id of ids) {
                const t = await this.graph.getNodeType(id);
                if (t === null) continue;
                if (includeTypes.has(t)) filtered.push(id);
            }
            ids = filtered;
        }

        return { ids, depthReached: depth, truncated };
    }

    private async stepNeighbors(
        nodeId: string,
        edgeTypes: string[],
        direction: ScopeDirection,
    ): Promise<string[]> {
        switch (direction) {
            case 'up':
                return this.graph.neighborsOut(nodeId, edgeTypes);
            case 'down':
                return this.graph.neighborsIn(nodeId, edgeTypes);
            case 'both': {
                const [u, d] = await Promise.all([
                    this.graph.neighborsOut(nodeId, edgeTypes),
                    this.graph.neighborsIn(nodeId, edgeTypes),
                ]);
                const seen = new Set<string>();
                const out: string[] = [];
                for (const x of [...u, ...d]) {
                    if (seen.has(x)) continue;
                    seen.add(x);
                    out.push(x);
                }
                return out;
            }
        }
    }
}

function resolveSpec(input: ResolveScopeInput): ScopeSpec {
    if (input.spec) return input.spec;
    if (input.scopeName && input.schema) {
        const named = input.schema.scopes?.[input.scopeName];
        if (!named) {
            throw new Error(
                `[scopeResolver] no scope named '${input.scopeName}' in schema. ` +
                `Available: ${Object.keys(input.schema.scopes ?? {}).join(', ') || 'none'}.`,
            );
        }
        return named;
    }
    throw new Error('[scopeResolver] resolve() requires either `spec` or `scopeName + schema`');
}
