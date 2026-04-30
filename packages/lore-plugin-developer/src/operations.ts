/**
 * developer/operations.ts — Q2.2 slice 5b. Substrate-portable plugin
 * operations.
 *
 * Every read/write goes through `ctx.storage` (PluginStorage) instead
 * of raw Cypher via `ctx.executeQuery` / `ctx.queryRows`. The same
 * function bodies now compile to Kùzu (local mode) and Dataplane (cloud
 * mode) without changes.
 *
 * Migration notes:
 *   - 5b: storage ops took a substrate-pair lookup ("collName") + a
 *     per-call EdgeShapeHint pinning Kùzu source/target labels.
 *   - 5c (this file): both went away. Plugins pass canonical names from
 *     ./collections.ts (CODE_SYMBOL_COLL, FILE_CONTAINS_COLL, …) and the
 *     adapter resolves substrate-specific names + edge metadata via
 *     declareCollection() (boot-time, see ./index.ts contributeCollectionDecls).
 *   - PluginStorage's mutating methods bump the read cache internally —
 *     the legacy `ctx.bumpEpoch()` calls that surrounded raw Cypher
 *     writes go away.
 *
 * Constraints we accommodate (deliberate, see storage.ts):
 *   - Filters are AND-only. `queryCodeSymbols`'s old "name OR filePath"
 *     contains-match becomes two finds + a JS-side dedup by uid.
 *   - DISTINCT isn't expressible. `ingestFilesFromSymbols` fetches all
 *     symbols then dedupes (filePath, repo) in JS.
 *   - Cross-collection joins aren't expressible. `getCodeSymbolContext`
 *     and `getCrossPillarEdges` walk via traverse() and a follow-up
 *     find() with `in`.
 *
 * Scope:
 *   - CodeFile upsert + FileContains wiring
 *   - CodeSymbol listing + queries
 *   - Cross-pillar edge insertion (LoreAppliesToCode, LoreTouchesFile)
 *   - File-ingestion pass (synthesize CodeFile nodes from existing
 *     CodeSymbols' filePaths + wire the FileContains edges)
 *   - Prune inferred edges in the developer-owned rel tables
 */

import path from 'path';
import type { PluginGraphContext } from '@lore-core/plugins/types.js';
import type { CodeSymbol, CodeRelationEdge, DevActivity } from './types.js';
import {
    CODE_FILE_COLL,
    CODE_RELATION_COLL,
    CODE_SYMBOL_COLL,
    DEV_ACTIVITY_COLL,
    FILE_CONTAINS_COLL,
    LORE_APPLIES_TO_CODE_COLL,
    LORE_NODE_COLL,
    LORE_TOUCHES_FILE_COLL,
} from './collections.js';

function rowToCodeSymbol(row: Record<string, unknown>): CodeSymbol {
    return {
        uid: (row['uid'] as string) ?? '',
        name: (row['name'] as string) ?? '',
        kind: (row['kind'] as string) ?? '',
        filePath: (row['filePath'] as string) ?? '',
        startLine: (row['startLine'] as number) ?? 0,
        endLine: (row['endLine'] as number) ?? 0,
        content: (row['content'] as string) ?? '',
        signature: (row['signature'] as string) ?? '',
        returnType: (row['returnType'] as string) ?? '',
        parameterCount: (row['parameterCount'] as number) ?? 0,
        repo: (row['repo'] as string) ?? '',
    };
}

function rowToLoreNodeLike(row: Record<string, unknown>): Record<string, unknown> {
    return {
        id: (row['id'] as string) ?? '',
        type: (row['type'] as string) ?? '',
        label: (row['label'] as string) ?? '',
        content: (row['content'] as string) ?? '',
        tags: (row['tags'] as string) ?? '',
        project: (row['project'] as string) ?? '',
        ecosystem: (row['ecosystem'] as string) ?? '',
    };
}

/* ─── CodeSymbol write path (used by `lore index`) ────────────── */

export async function upsertCodeSymbol(ctx: PluginGraphContext, symbol: CodeSymbol): Promise<void> {
    await ctx.storage.upsert(CODE_SYMBOL_COLL, 'uid', {
        uid: symbol.uid,
        name: symbol.name,
        kind: symbol.kind,
        filePath: symbol.filePath,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        content: symbol.content,
        signature: symbol.signature,
        returnType: symbol.returnType,
        parameterCount: symbol.parameterCount,
        repo: symbol.repo,
    });
}

export async function addCodeRelation(ctx: PluginGraphContext, edge: CodeRelationEdge): Promise<void> {
    // Existing semantics: CREATE (non-idempotent; legacy code calls this
    // from a controlled re-index path that clears CodeSymbols first).
    await ctx.storage.addEdge(
        CODE_RELATION_COLL,
        edge.sourceUid,
        edge.targetUid,
        { type: edge.type, confidence: edge.confidence, reason: edge.reason },
    );
}

/* ─── CodeSymbol read path (used by MCP tools) ────────────────── */

export async function queryCodeSymbols(
    ctx: PluginGraphContext,
    query: string,
    repo?: string,
    limit: number = 20,
): Promise<CodeSymbol[]> {
    // Legacy semantics matched name OR filePath with a lowercase CONTAINS.
    // Filter is AND-only, so we issue two finds + dedup. Kùzu's CONTAINS
    // is case-sensitive (we lose the lower() on this path); for the
    // matched substrings used by the MCP tool this hasn't been observed
    // to matter, and the alternative was an OR translation we chose not
    // to extend the Filter shape with for the sake of one call site.
    const repoEq = repo ? { eq: { repo } } : {};
    const [byName, byPath] = await Promise.all([
        ctx.storage.find<Record<string, unknown>>(
            CODE_SYMBOL_COLL,
            { contains: { name: query }, ...repoEq },
            { limit },
        ),
        ctx.storage.find<Record<string, unknown>>(
            CODE_SYMBOL_COLL,
            { contains: { filePath: query }, ...repoEq },
            { limit },
        ),
    ]);
    const seen = new Set<string>();
    const merged: CodeSymbol[] = [];
    for (const r of [...byName, ...byPath]) {
        const sym = rowToCodeSymbol(r);
        if (!sym.uid || seen.has(sym.uid)) continue;
        seen.add(sym.uid);
        merged.push(sym);
        if (merged.length >= limit) break;
    }
    return merged;
}

export async function queryCodeSymbolsByName(ctx: PluginGraphContext, name: string): Promise<CodeSymbol[]> {
    try {
        const rows = await ctx.storage.find<Record<string, unknown>>(
            CODE_SYMBOL_COLL,
            { eq: { name } },
        );
        return rows.map(rowToCodeSymbol);
    } catch {
        return [];
    }
}

export async function getCodeSymbolByUid(ctx: PluginGraphContext, uid: string): Promise<CodeSymbol | null> {
    try {
        const row = await ctx.storage.get<Record<string, unknown>>(
            CODE_SYMBOL_COLL,
            'uid',
            uid,
        );
        return row ? rowToCodeSymbol(row) : null;
    } catch {
        return null;
    }
}

export async function getCodeSymbolContext(
    ctx: PluginGraphContext,
    uid: string,
): Promise<{
    symbol: CodeSymbol | null;
    callers: CodeSymbol[];
    callees: CodeSymbol[];
    knowledge: Record<string, unknown>[];
}> {
    const symRow = await ctx.storage.get<Record<string, unknown>>(CODE_SYMBOL_COLL, 'uid', uid);
    const symbol = symRow ? rowToCodeSymbol(symRow) : null;

    // Cross-collection joins aren't expressible in PluginStorage —
    // walk the edges with traverse(), then fetch the connected nodes
    // with find({ in: { uid: [...] } }). Two round-trips per direction;
    // both substrates handle the IN-list translation natively.

    const callerEdges = await ctx.storage.traverse(
        CODE_RELATION_COLL,
        uid,
        'in',
        { filter: { eq: { type: 'CALLS' } } },
    );
    const callerIds = callerEdges.map((e) => e.sourceId).filter(Boolean);
    const callerRows = callerIds.length === 0
        ? []
        : await ctx.storage.find<Record<string, unknown>>(CODE_SYMBOL_COLL, { in: { uid: callerIds } });
    const callers = callerRows.map(rowToCodeSymbol);

    const calleeEdges = await ctx.storage.traverse(
        CODE_RELATION_COLL,
        uid,
        'out',
        { filter: { eq: { type: 'CALLS' } } },
    );
    const calleeIds = calleeEdges.map((e) => e.targetId).filter(Boolean);
    const calleeRows = calleeIds.length === 0
        ? []
        : await ctx.storage.find<Record<string, unknown>>(CODE_SYMBOL_COLL, { in: { uid: calleeIds } });
    const callees = calleeRows.map(rowToCodeSymbol);

    const knowledgeEdges = await ctx.storage.traverse(
        LORE_APPLIES_TO_CODE_COLL,
        uid,
        'in',
    );
    const knowledgeIds = knowledgeEdges.map((e) => e.sourceId).filter(Boolean);
    const knowledgeRows = knowledgeIds.length === 0
        ? []
        : await ctx.storage.find<Record<string, unknown>>(LORE_NODE_COLL, { in: { id: knowledgeIds } });
    const knowledge = knowledgeRows.map(rowToLoreNodeLike);

    return { symbol, callers, callees, knowledge };
}

export async function getCodeRelationsTo(ctx: PluginGraphContext, targetUid: string): Promise<CodeRelationEdge[]> {
    try {
        const edges = await ctx.storage.traverse<{ type?: string; confidence?: number; reason?: string }>(
            CODE_RELATION_COLL,
            targetUid,
            'in',
        );
        return edges.map((e) => ({
            sourceUid: e.sourceId,
            targetUid: e.targetId,
            type: e.edgeProps.type ?? '',
            confidence: e.edgeProps.confidence ?? 1.0,
            reason: e.edgeProps.reason ?? '',
        }));
    } catch {
        return [];
    }
}

/**
 * Phase 7 — depth-tiered blast radius (d1/d2/d3) over the developer
 * plugin's CodeRelation edges. Replaces the gitnexus CLI proxy that
 * formerly powered `code_impact`.
 *
 * Lookup: accepts a CodeSymbol uid OR a bare/qualified name. If a name
 * is supplied, picks the first match by name (callers warn the LLM via
 * the `ambiguous` flag at the tools layer).
 *
 * BFS direction:
 *   - upstream:   walk INCOMING CodeRelation edges (who calls / depends on this)
 *   - downstream: walk OUTGOING CodeRelation edges (what this calls / depends on)
 *
 * Truncation: caps each tier at 200 nodes and the total visited set at
 * 2000 to keep the surface bounded for large blast zones. Real
 * production fan-out beyond this isn't actionable in a single
 * code_impact call anyway — the LLM should narrow the symbol or use
 * code_cypher for arbitrary slice-and-dice.
 */
export async function computeCodeBlastRadius(
    ctx: PluginGraphContext,
    target: string,
    direction: 'upstream' | 'downstream',
    maxDepth: number,
): Promise<{
    symbol: CodeSymbol | null;
    d1: CodeSymbol[];
    d2: CodeSymbol[];
    d3: CodeSymbol[];
}> {
    // 1. Resolve target to a uid. uid format: <repo>::<file>::<name>::<Kind>.
    let symbol: CodeSymbol | null = null;
    if (target.includes('::')) {
        symbol = await getCodeSymbolByUid(ctx, target);
    }
    if (!symbol) {
        const matches = await queryCodeSymbolsByName(ctx, target);
        if (matches.length > 0) symbol = matches[0];
    }
    if (!symbol) {
        return { symbol: null, d1: [], d2: [], d3: [] };
    }

    const TIER_CAP = 200;
    const TOTAL_CAP = 2000;
    const tiers: CodeSymbol[][] = [[], [], []];
    const visited = new Set<string>([symbol.uid]);
    let frontier = new Set<string>([symbol.uid]);

    const depth = Math.max(1, Math.min(maxDepth, 3));
    for (let d = 0; d < depth; d++) {
        const next = new Set<string>();
        for (const uid of frontier) {
            if (visited.size >= TOTAL_CAP) break;
            try {
                const edges = await ctx.storage.traverse<{ type?: string }>(
                    CODE_RELATION_COLL,
                    uid,
                    direction === 'upstream' ? 'in' : 'out',
                );
                for (const e of edges) {
                    const neighbor = direction === 'upstream' ? e.sourceId : e.targetId;
                    if (!neighbor || visited.has(neighbor)) continue;
                    visited.add(neighbor);
                    next.add(neighbor);
                    if (visited.size >= TOTAL_CAP) break;
                }
            } catch {
                // edge fetch failed; skip this hop
            }
        }
        if (next.size === 0) break;
        const nextIds = Array.from(next).slice(0, TIER_CAP);
        const nextRows = await ctx.storage.find<Record<string, unknown>>(CODE_SYMBOL_COLL, { in: { uid: nextIds } });
        tiers[d] = nextRows.map(rowToCodeSymbol);
        frontier = next;
    }

    return { symbol, d1: tiers[0], d2: tiers[1], d3: tiers[2] };
}

export async function getCrossPillarEdges(
    ctx: PluginGraphContext,
    repo: string,
): Promise<{ nodeId: string; symbolUid: string; relation: string }[]> {
    // Two-step substrate-portable join:
    //   1. Find every CodeSymbol in the repo.
    //   2. For each symbol, traverse incoming LoreAppliesToCode.
    // O(N) round-trips per repo. Acceptable at maintenance time (this
    // call only runs as part of a clear-and-reindex pass).
    try {
        const symbols = await ctx.storage.find<Record<string, unknown>>(
            CODE_SYMBOL_COLL,
            { eq: { repo } },
        );
        const out: { nodeId: string; symbolUid: string; relation: string }[] = [];
        for (const s of symbols) {
            const uid = String(s['uid'] ?? '');
            if (!uid) continue;
            const edges = await ctx.storage.traverse<{ relation?: string }>(
                LORE_APPLIES_TO_CODE_COLL,
                uid,
                'in',
            );
            for (const e of edges) {
                out.push({
                    nodeId: e.sourceId,
                    symbolUid: uid,
                    relation: e.edgeProps.relation ?? 'applies_to',
                });
            }
        }
        return out;
    } catch {
        return [];
    }
}

export async function clearCodeSymbols(ctx: PluginGraphContext, repo: string): Promise<number> {
    const count = await ctx.storage.count(CODE_SYMBOL_COLL, { eq: { repo } });
    if (count === 0) return 0;

    if (ctx.storage.mode === 'dataplane') {
        // Cloud edges are independent collections — DETACH DELETE
        // semantics don't apply. Walk the symbols once and clean up
        // their outgoing/incoming edges per-uid before dropping the
        // nodes.
        const symbols = await ctx.storage.find<Record<string, unknown>>(
            CODE_SYMBOL_COLL,
            { eq: { repo } },
            { limit: 100_000 },
        );
        for (const s of symbols) {
            const uid = String(s['uid'] ?? '');
            if (!uid) continue;
            await ctx.storage.deleteEdgesWhere(CODE_RELATION_COLL, { eq: { sourceId: uid } });
            await ctx.storage.deleteEdgesWhere(CODE_RELATION_COLL, { eq: { targetId: uid } });
            await ctx.storage.deleteEdgesWhere(LORE_APPLIES_TO_CODE_COLL, { eq: { targetId: uid } });
            await ctx.storage.deleteEdgesWhere(FILE_CONTAINS_COLL, { eq: { targetId: uid } });
        }
    }

    // Kùzu: DETACH DELETE inside deleteWhere strips attached edges.
    // Cloud: edges already cleaned above; this drops the symbol nodes.
    await ctx.storage.deleteWhere(CODE_SYMBOL_COLL, { eq: { repo } });
    return count;
}

/* ─── DevActivity (team awareness) ────────────────────────────── */

export async function recordDevActivity(ctx: PluginGraphContext, activity: DevActivity): Promise<void> {
    const id = `${activity.dev}::${activity.project}`;
    await ctx.storage.upsert(DEV_ACTIVITY_COLL, 'id', {
        id,
        dev: activity.dev,
        project: activity.project,
        action: activity.action,
        filePath: activity.filePath,
        timestamp: activity.timestamp,
        tool: activity.tool,
    });
}

export async function getActiveDevs(
    ctx: PluginGraphContext,
    project?: string,
    activeWindowMinutes: number = 30,
): Promise<DevActivity[]> {
    try {
        const cutoff = new Date(Date.now() - activeWindowMinutes * 60 * 1000).toISOString();
        // Filter `eq: project` is pushed down; the cutoff stays in JS so
        // we don't re-shape the call as `gte: { timestamp: cutoff }` and
        // accidentally exclude rows the legacy code returned (defensive
        // against minor timestamp-format drift across substrates).
        const filter = project ? { eq: { project } } : {};
        const rows = await ctx.storage.find<Record<string, unknown>>(
            DEV_ACTIVITY_COLL,
            filter,
        );
        return rows
            .map((r) => ({
                dev: (r['dev'] as string) ?? '',
                project: (r['project'] as string) ?? '',
                action: (r['action'] as string) ?? '',
                filePath: (r['filePath'] as string) ?? '',
                timestamp: (r['timestamp'] as string) ?? '',
                tool: (r['tool'] as string) ?? '',
            }))
            .filter((a) => a.timestamp >= cutoff);
    } catch {
        return [];
    }
}

export async function clearStaleActivity(
    ctx: PluginGraphContext,
    olderThanMinutes: number = 60,
): Promise<number> {
    try {
        const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
        const filter = { lt: { timestamp: cutoff } };
        const count = await ctx.storage.count(DEV_ACTIVITY_COLL, filter);
        if (count > 0) await ctx.storage.deleteWhere(DEV_ACTIVITY_COLL, filter);
        return count;
    } catch {
        return 0;
    }
}

/* ─── CodeFile ────────────────────────────────────────────────── */

export async function upsertCodeFile(
    ctx: PluginGraphContext,
    file: { path: string; language?: string; loc?: number; repo?: string; lastModified?: string },
): Promise<void> {
    await ctx.storage.upsert(CODE_FILE_COLL, 'path', {
        path: file.path,
        language: file.language ?? '',
        loc: file.loc ?? 0,
        repo: file.repo ?? '',
        lastModified: file.lastModified ?? new Date().toISOString(),
    });
}

export async function addFileContains(
    ctx: PluginGraphContext,
    filePath: string,
    symbolUid: string,
): Promise<void> {
    // MERGE in legacy code → upsertEdge. Idempotent.
    await ctx.storage.upsertEdge(
        FILE_CONTAINS_COLL,
        filePath,
        symbolUid,
        {},
    );
}

export async function addLoreTouchesFile(
    ctx: PluginGraphContext,
    loreNodeId: string,
    filePath: string,
    relation: string = 'touches',
): Promise<void> {
    // MERGE … SET r.relation = … → upsertEdge.
    await ctx.storage.upsertEdge(
        LORE_TOUCHES_FILE_COLL,
        loreNodeId,
        filePath,
        { relation },
    );
}

/* ─── CodeSymbol ──────────────────────────────────────────────── */

export async function linkKnowledgeToCode(
    ctx: PluginGraphContext,
    nodeId: string,
    symbolUid: string,
    relation: string,
): Promise<void> {
    // Legacy semantics: CREATE (non-idempotent — caller manages dedup
    // via the prune-then-rebuild pattern).
    await ctx.storage.addEdge(
        LORE_APPLIES_TO_CODE_COLL,
        nodeId,
        symbolUid,
        { relation },
    );
}

export async function listCodeFiles(
    ctx: PluginGraphContext,
): Promise<Array<{ path: string; language: string; repo: string }>> {
    try {
        const rows = await ctx.storage.find<Record<string, unknown>>(
            CODE_FILE_COLL,
            {},
        );
        return rows.map((r) => ({
            path: String(r['path'] ?? ''),
            language: String(r['language'] ?? ''),
            repo: String(r['repo'] ?? ''),
        }));
    } catch {
        return [];
    }
}

export async function listCodeSymbols(
    ctx: PluginGraphContext,
    limit: number = 2000,
): Promise<Array<{ uid: string; name: string; kind: string; filePath: string; signature: string; content: string; repo: string; startLine: number; endLine: number }>> {
    try {
        const rows = await ctx.storage.find<Record<string, unknown>>(
            CODE_SYMBOL_COLL,
            {},
            { limit },
        );
        return rows.map((r) => ({
            uid: String(r['uid'] ?? ''),
            name: String(r['name'] ?? ''),
            kind: String(r['kind'] ?? ''),
            filePath: String(r['filePath'] ?? ''),
            signature: String(r['signature'] ?? ''),
            content: String(r['content'] ?? ''),
            repo: String(r['repo'] ?? ''),
            startLine: Number(r['startLine'] ?? 0),
            endLine: Number(r['endLine'] ?? 0),
        }));
    } catch {
        return [];
    }
}

/**
 * listCodeFilesWithPreview — For each CodeFile, concatenates its child
 * symbols' name + signature + content head up to maxBytes. Used by the
 * reconnect embedding pass as a fallback when disk read isn't possible.
 */
export async function listCodeFilesWithPreview(
    ctx: PluginGraphContext,
    maxBytes: number = 2048,
): Promise<Array<{ path: string; language: string; repo: string; preview: string }>> {
    const files = await listCodeFiles(ctx);
    const out: Array<{ path: string; language: string; repo: string; preview: string }> = [];
    for (const f of files) {
        try {
            const rows = await ctx.storage.find<Record<string, unknown>>(
                CODE_SYMBOL_COLL,
                { eq: { filePath: f.path } },
            );
            const symbols = rows.map((r) => ({
                name: String(r['name'] ?? ''),
                kind: String(r['kind'] ?? ''),
                signature: String(r['signature'] ?? ''),
                content: String(r['content'] ?? ''),
            }));
            out.push({ ...f, preview: buildFilePreview(symbols, maxBytes) });
        } catch {
            out.push({ ...f, preview: '' });
        }
    }
    return out;
}

function buildFilePreview(
    symbols: Array<{ name: string; kind: string; signature: string; content: string }>,
    maxBytes: number,
): string {
    const parts: string[] = [];
    let bytes = 0;
    for (const s of symbols) {
        const line = `${s.kind} ${s.name}: ${s.signature || ''}`.trim();
        const head = (s.content || '').split('\n').slice(0, 4).join('\n').slice(0, 300);
        const chunk = `${line}\n${head}`.trim();
        if (!chunk) continue;
        if (bytes + chunk.length > maxBytes) break;
        parts.push(chunk);
        bytes += chunk.length + 2;
    }
    return parts.join('\n\n');
}

/* ─── File-ingestion pass ─────────────────────────────────────── */

export async function ingestFilesFromSymbols(
    ctx: PluginGraphContext,
): Promise<{ filesCreated: number; edgesCreated: number }> {
    // PluginStorage has no DISTINCT — fetch all symbols and dedup by
    // (filePath, repo) in JS. listCodeSymbols caps at 2000 rows by
    // default; bump the limit explicitly so big repos don't lose
    // files in the synthesis.
    const symbols = await listCodeSymbols(ctx, 100_000);

    type Group = { filePath: string; repo: string; uids: string[] };
    const groups = new Map<string, Group>();
    for (const s of symbols) {
        if (!s.filePath) continue;
        const key = `${s.filePath}\0${s.repo}`;
        const g = groups.get(key) ?? { filePath: s.filePath, repo: s.repo, uids: [] };
        g.uids.push(s.uid);
        groups.set(key, g);
    }

    let filesCreated = 0;
    let edgesCreated = 0;
    for (const g of groups.values()) {
        await upsertCodeFile(ctx, {
            path: g.filePath,
            language: inferLanguage(g.filePath),
            repo: g.repo,
        });
        filesCreated++;
        for (const uid of g.uids) {
            if (!uid) continue;
            await addFileContains(ctx, g.filePath, uid);
            edgesCreated++;
        }
    }
    return { filesCreated, edgesCreated };
}

function inferLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        '.ts': 'TypeScript', '.tsx': 'TypeScript',
        '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript',
        '.py': 'Python', '.rs': 'Rust', '.go': 'Go',
        '.java': 'Java', '.kt': 'Kotlin',
        '.rb': 'Ruby', '.php': 'PHP',
        '.c': 'C', '.cpp': 'C++', '.h': 'C', '.hpp': 'C++',
        '.cs': 'C#', '.swift': 'Swift',
        '.sh': 'Shell', '.bash': 'Shell', '.zsh': 'Shell',
        '.md': 'Markdown', '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML',
        '.toml': 'TOML', '.sql': 'SQL',
    };
    return map[ext] ?? 'Unknown';
}

/* ─── Cross-project code-edge counts (for chord overview) ────── */

/**
 * 2026-04-27: counts CodeRelation edges where source.repo ≠ target.repo,
 * grouped by (fromProject, toProject). Feeds the chord diagram so
 * ribbon thickness reflects real code coupling, not just LoreNode
 * cross-project edges.
 *
 * Implementation: single Cypher query, fast even at 15k+ symbols.
 */
export async function getCrossProjectCodeEdgeCounts(
    ctx: PluginGraphContext,
): Promise<Array<{ fromProject: string; toProject: string; count: number }>> {
    try {
        const rows = await ctx.queryRows(
            `MATCH (n:CodeSymbol)-[r:CodeRelation]->(m:CodeSymbol)
             WHERE n.repo <> m.repo AND n.repo IS NOT NULL AND m.repo IS NOT NULL
             RETURN n.repo AS fromProject, m.repo AS toProject, count(r) AS count`,
        );
        return rows.map((r) => ({
            fromProject: String(r['fromProject']),
            toProject: String(r['toProject']),
            count: Number(r['count']) || 0,
        }));
    } catch (err) {
        console.error(`[getCrossProjectCodeEdgeCounts] failed: ${(err as Error).message}`);
        return [];
    }
}

/* ─── Prune own inferred edges ────────────────────────────────── */

export async function pruneInferredDeveloperEdges(
    ctx: PluginGraphContext,
    relationPrefix: string,
): Promise<{ touchesFile: number; appliesToCode: number }> {
    let touchesFile = 0;
    let appliesToCode = 0;
    try {
        touchesFile = await ctx.storage.deleteEdgesWhere(
            LORE_TOUCHES_FILE_COLL,
            { startsWith: { relation: relationPrefix } },
        );
    } catch { /* table may be missing on older graphs */ }
    try {
        appliesToCode = await ctx.storage.deleteEdgesWhere(
            LORE_APPLIES_TO_CODE_COLL,
            { startsWith: { relation: relationPrefix } },
        );
    } catch { /* ignore */ }
    return { touchesFile, appliesToCode };
}
