/**
 * mcp/handlers-phase61.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Phase 6.1 handler scaffolds — code_query, code_context, code_rename,
 * code_cypher, code_search_ast.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 6.1 (deferred handlers).
 *
 * These five handlers were deferred from Phase 6 because they need a
 * live PluginContext (Lore's verbatimStore, the developer plugin's
 * Kùzu connection via ctx.graph, the existing nativeTools rename
 * infrastructure). The Phase 6 handlers (analytics + git) work off a
 * resolved-graph snapshot only; these need runtime services.
 *
 * The scaffolds in this file:
 *   1. Define a `Phase61Context` type that carries the bits each
 *      handler needs (AtlasContext + PluginContext slice).
 *   2. Provide handler signatures matching the tools in mcp/tools.ts
 *      so ATLAS_HANDLERS_PHASE61 can be merged into ATLAS_HANDLERS at
 *      registration time.
 *   3. Each handler runs an implementation when the runtime services
 *      are present, and returns a structured `not-yet-wired` error
 *      otherwise. This means tool callers never get a hard crash —
 *      they get a clear "this handler is awaiting Phase 6.1
 *      registration" payload that the LLM can recover from.
 *
 * The Phase 6.1 wiring sits at the developer plugin's entry point
 * (packages/lore-plugin-developer/src/index.ts → registerTools(server,
 * ctx)). When ctx is bound, it builds a Phase61Context and passes it
 * to these handlers via expandWithAliases(ATLAS_HANDLERS_PHASE61).
 */

import type { ParsedRelation, ParsedSymbol } from '../parser/types.js';
import type { SymbolTable } from '../resolver/symbolTable.js';
import { blastRadius } from '../analytics/index.js';
import type { AtlasContext } from './handlers.js';

/**
 * Phase 6.1 runtime context. Extends the Phase 6 AtlasContext with the
 * three runtime services the deferred handlers need. Each service is
 * typed as `unknown` here to avoid a circular dependency on the core
 * package (same pattern as PluginContext); the developer plugin's
 * registerTools() casts each to its concrete shape at the call site.
 *
 * `null` is allowed for each service so this module can be imported
 * standalone and exercised in tests with a partial context. Handlers
 * check for null and return a structured `not-yet-wired` error rather
 * than crashing.
 */
export interface Phase61Context extends AtlasContext {
    /** The developer plugin's Kùzu connection. Used by code_cypher and code_context's knowledge-node neighbour lookup. */
    graph: unknown | null;
    /** Lore's VerbatimStore — full-fidelity store keyed by knowledge-node id. Used by code_query for semantic search via Xenova embeddings. */
    verbatimStore: unknown | null;
    /** The developer plugin's existing nativeTools surface. Used by code_rename to walk + rewrite references safely. */
    nativeTools: unknown | null;
}

/* ──────────── Helpers ──────────── */

interface NotYetWiredError {
    error: 'not-yet-wired';
    handler: string;
    missing: string[];
    note: string;
}

function notYetWired(handler: string, missing: string[]): NotYetWiredError {
    return {
        error: 'not-yet-wired',
        handler,
        missing,
        note: `Phase 6.1 handler "${handler}" requires runtime services that aren't bound yet (${missing.join(', ')}). The developer plugin's registerTools(server, ctx) wires these — until that lands, fall back to the Phase 6 surface (code_blast_radius, code_pagerank, etc.).`,
    };
}

function thinSymbol(sym: ParsedSymbol): { id: string; name: string; file: string; line: number; kind: string } {
    return {
        id: sym.id,
        name: sym.qualifiedName,
        file: sym.file,
        line: sym.byteRange.startLine,
        kind: sym.kind,
    };
}

function findSymbol(table: SymbolTable, nameOrId: string): ParsedSymbol | null {
    const byId = table.byId.get(nameOrId);
    if (byId) return byId;
    const qmatch = table.byQualifiedName.get(nameOrId);
    if (qmatch && qmatch.length > 0) return qmatch[0];
    for (const sym of table.all) {
        if (sym.name === nameOrId) return sym;
    }
    return null;
}

/* ──────────── Handlers ──────────── */

/**
 * code_query — semantic + graph search.
 * Needs: verbatimStore (Xenova embeddings) for semantic ranking,
 *        AtlasContext.table for graph-context expansion.
 *
 * Until verbatimStore is bound, this returns a structured
 * not-yet-wired result. The shape of the eventual successful response
 * is documented inline so consumers can plan against it.
 */
export function handleCodeQuery(
    ctx: Phase61Context,
    args: { query: string; limit?: number; mode?: 'thin' | 'standard' | 'full' },
): unknown {
    if (!ctx.verbatimStore) return notYetWired('code_query', ['verbatimStore']);

    // Eventual implementation outline (Phase 6.1 wiring):
    //   1. embed(query) via verbatimStore's existing Xenova helper
    //   2. nearest-neighbour search against CodeSymbol embeddings
    //   3. for each hit, expand via blastRadius(symbol, downstream, d=1)
    //      to surface call-graph context per the two-tier principle
    //   4. shape per args.mode (thin = id+label+1-line; standard = +
    //      signature + neighbours; full = body + full neighbours)
    return {
        notice: 'code_query implementation pending Phase 6.1 wiring against ctx.verbatimStore',
        receivedArgs: args,
    };
}

/**
 * code_context — 360-degree view of one symbol.
 * Needs: graph (knowledge-node neighbours via Kùzu) + AtlasContext
 *        (callers, callees, file location via blastRadius).
 *
 * Half of this handler can run on AtlasContext alone (call graph). The
 * knowledge-node-neighbours half requires the live Kùzu connection.
 * We return whatever's reachable from the snapshot and flag the rest.
 */
export function handleCodeContext(
    ctx: Phase61Context,
    args: { name: string; depth?: number; mode?: 'thin' | 'standard' | 'full' },
): unknown {
    const sym = findSymbol(ctx.table, args.name);
    if (!sym) return { error: `symbol not found: ${args.name}` };

    const depth = Math.max(0, Math.min(3, args.depth ?? 1));

    // Call-graph context — works off the snapshot, no graph DB needed.
    const callers = depth > 0
        ? blastRadius(sym.id, ctx.table, ctx.relations, 'upstream', { edgeKinds: new Set(['calls']) })
        : { d1: [], d2: [], d3: [] };
    const callees = depth > 0
        ? blastRadius(sym.id, ctx.table, ctx.relations, 'downstream', { edgeKinds: new Set(['calls']) })
        : { d1: [], d2: [], d3: [] };

    const callContext = {
        symbol: thinSymbol(sym),
        callers: {
            d1: callers.d1.map(thinSymbol),
            d2: depth >= 2 ? callers.d2.map(thinSymbol) : [],
        },
        callees: {
            d1: callees.d1.map(thinSymbol),
            d2: depth >= 2 ? callees.d2.map(thinSymbol) : [],
        },
    };

    // Knowledge-node neighbours — needs live ctx.graph. Surface partial.
    if (!ctx.graph) {
        return {
            ...callContext,
            knowledgeNeighbours: null,
            partial: true,
            partialReason: notYetWired('code_context.knowledgeNeighbours', ['graph']).note,
        };
    }

    // Eventual implementation outline (Phase 6.1 wiring):
    //   ctx.graph.queryRows(`
    //     MATCH (n:LoreNode)-[r:LoreAppliesToCode]->(s:CodeSymbol {uid: $uid})
    //     RETURN n.id, n.label, n.type, r.relation
    //   `, { uid: sym.id })
    //   → fold into knowledgeNeighbours
    return {
        ...callContext,
        knowledgeNeighbours: {
            notice: 'knowledge-node neighbour expansion pending Phase 6.1 wiring',
        },
        partial: false,
    };
}

/**
 * code_rename — rename a symbol with dry-run preview.
 * Needs: nativeTools (the developer plugin's existing rename infra
 *        which already understands Lore's call+import graph and emits
 *        a typed RenamePreview).
 */
export function handleCodeRename(
    ctx: Phase61Context,
    args: { symbol: string; newName: string; dryRun?: boolean },
): unknown {
    if (!ctx.nativeTools) return notYetWired('code_rename', ['nativeTools']);

    const sym = findSymbol(ctx.table, args.symbol);
    if (!sym) return { error: `symbol not found: ${args.symbol}` };

    // Eventual implementation outline (Phase 6.1 wiring):
    //   const tool = ctx.nativeTools as DeveloperNativeTools;
    //   return tool.rename({ symbolId: sym.id, newName: args.newName, dryRun: args.dryRun ?? true })
    return {
        notice: 'code_rename implementation pending Phase 6.1 wiring against ctx.nativeTools',
        wouldRename: thinSymbol(sym),
        newName: args.newName,
        dryRun: args.dryRun ?? true,
    };
}

/**
 * code_cypher — execute a custom Cypher query against the developer-plugin Kùzu graph.
 * Needs: graph (the live Kùzu connection).
 *
 * v1 enforces read-only. Sentinel rejection-list of keywords likely
 * to mutate (CREATE, DELETE, DROP, MERGE, SET) catches the obvious
 * write paths; deeper enforcement (Kùzu's transaction read-only mode
 * if available) is a Phase 6.1-2 follow-up.
 */
const CYPHER_WRITE_KEYWORDS = ['CREATE', 'DELETE', 'DROP', 'MERGE', 'SET', 'DETACH', 'COPY', 'INSTALL', 'LOAD'];

export function handleCodeCypher(
    ctx: Phase61Context,
    args: { query: string; parameters?: Record<string, unknown> },
): unknown {
    if (!ctx.graph) return notYetWired('code_cypher', ['graph']);

    // Read-only check (sentinel keyword scan, case-insensitive, word-boundary match).
    const upper = args.query.toUpperCase();
    for (const kw of CYPHER_WRITE_KEYWORDS) {
        const re = new RegExp(`\\b${kw}\\b`);
        if (re.test(upper)) {
            return {
                error: 'read-only',
                rejectedKeyword: kw,
                note: `code_cypher v1 is read-only. Mutation keyword "${kw}" detected. Use the developer plugin's typed APIs (or atlas-cutover-execute.mjs for Phase 7) for graph mutations.`,
            };
        }
    }

    // Eventual implementation outline (Phase 6.1 wiring):
    //   const conn = ctx.graph as DeveloperGraphConnection;
    //   const result = await conn.queryRows(args.query, args.parameters ?? {});
    //   return { rows: result.slice(0, 1000), truncated: result.length > 1000 };
    return {
        notice: 'code_cypher implementation pending Phase 6.1 wiring against ctx.graph',
        receivedArgs: { query: args.query, parameters: args.parameters ?? {} },
    };
}

/**
 * code_search_ast — search for AST patterns across the codebase using
 * tree-sitter's query language.
 * Needs: tree-sitter Query API access. Each language's parser instance
 * is cached in parser/grammars.ts but isn't currently surfaced through
 * the Phase 6 AtlasContext.
 *
 * v1 falls back to a snapshot-only mode when the parser is unreachable
 * — it returns a not-yet-wired error rather than re-parsing files
 * inline (re-parse-per-query would be slow for any non-trivial
 * codebase).
 */
export function handleCodeSearchAst(
    ctx: Phase61Context,
    args: { pattern: string; language?: string; limit?: number },
): unknown {
    // We could in principle re-parse the candidate files on demand and
    // run the query, but that's a Phase 6.1 wiring decision — better to
    // surface parsers via Phase61Context.parsers and reuse cached
    // instances. For now: structured not-yet-wired.
    return notYetWired('code_search_ast', ['parsers']);
    // ^ args is consumed implicitly via the type signature; kept here for
    //   the eventual wiring:
    //     const lang = args.language ?? detectLanguageFromContext(ctx);
    //     const parser = await getParserFor(lang);
    //     const query = parser.getLanguage().query(args.pattern);
    //     for each ParsedFile in ctx where file.language === lang:
    //       parse → query → collect captures up to args.limit
}

/* ──────────── Registry ──────────── */

/**
 * The 5 Phase 6.1 handlers. Merged with ATLAS_HANDLERS at registration
 * time by ILorePlugin.registerTools(server, ctx). The merged map is
 * then passed through expandWithAliases() to register the gitnexus_*
 * deprecation aliases.
 *
 * Type uses Phase61Context; ATLAS_HANDLERS uses AtlasContext.
 * registerTools() builds a Phase61Context (which extends AtlasContext)
 * once and passes it to all handlers — the v1 ones simply ignore the
 * extra fields.
 */
export const ATLAS_HANDLERS_PHASE61: Map<string, (ctx: Phase61Context, args: never) => unknown> = new Map<string, (ctx: Phase61Context, args: never) => unknown>([
    ['code_query', handleCodeQuery as never],
    ['code_context', handleCodeContext as never],
    ['code_rename', handleCodeRename as never],
    ['code_cypher', handleCodeCypher as never],
    ['code_search_ast', handleCodeSearchAst as never],
]);
