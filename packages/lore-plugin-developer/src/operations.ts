/**
 * developer/operations.ts — Q2.2 slice 5b. Substrate-portable plugin
 * operations.
 *
 * Every read/write goes through `ctx.storage` (PluginStorage) instead
 * of raw Cypher via `ctx.executeQuery` / `ctx.queryRows`. The same
 * function bodies now compile to Kùzu (local mode) and Dataplane (cloud
 * mode) without changes.
 *
 * Migration notes (slice 5b):
 *   - Substrate names live in `./collections.ts` (Kùzu PascalCase ↔
 *     cloud snake_case). Each call picks the right one via
 *     `collName(ctx.storage, ...)`.
 *   - Edge ops carry an EdgeShapeHint pinning Kùzu source/target labels;
 *     the cloud adapter ignores them. Hints removed in slice 5c by
 *     `declareCollection`.
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
    CODE_FILE,
    CODE_RELATION,
    CODE_SYMBOL,
    DEV_ACTIVITY,
    FILE_CONTAINS,
    HINT_CODE_RELATION,
    HINT_FILE_CONTAINS,
    HINT_LORE_APPLIES_TO_CODE,
    HINT_LORE_TOUCHES_FILE,
    LORE_APPLIES_TO_CODE,
    LORE_NODE,
    LORE_TOUCHES_FILE,
    collName,
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
    await ctx.storage.upsert(collName(ctx.storage, CODE_SYMBOL), 'uid', {
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
        collName(ctx.storage, CODE_RELATION),
        edge.sourceUid,
        edge.targetUid,
        { type: edge.type, confidence: edge.confidence, reason: edge.reason },
        HINT_CODE_RELATION,
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
    const coll = collName(ctx.storage, CODE_SYMBOL);
    const repoEq = repo ? { eq: { repo } } : {};
    const [byName, byPath] = await Promise.all([
        ctx.storage.find<Record<string, unknown>>(
            coll,
            { contains: { name: query }, ...repoEq },
            { limit },
        ),
        ctx.storage.find<Record<string, unknown>>(
            coll,
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
            collName(ctx.storage, CODE_SYMBOL),
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
            collName(ctx.storage, CODE_SYMBOL),
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
    const symColl = collName(ctx.storage, CODE_SYMBOL);
    const relColl = collName(ctx.storage, CODE_RELATION);
    const lacColl = collName(ctx.storage, LORE_APPLIES_TO_CODE);
    const loreColl = collName(ctx.storage, LORE_NODE);

    const symRow = await ctx.storage.get<Record<string, unknown>>(symColl, 'uid', uid);
    const symbol = symRow ? rowToCodeSymbol(symRow) : null;

    // Cross-collection joins aren't expressible in PluginStorage —
    // walk the edges with traverse(), then fetch the connected nodes
    // with find({ in: { uid: [...] } }). Two round-trips per direction;
    // both substrates handle the IN-list translation natively.

    const callerEdges = await ctx.storage.traverse(
        relColl,
        uid,
        'in',
        { filter: { eq: { type: 'CALLS' } } },
        HINT_CODE_RELATION,
    );
    const callerIds = callerEdges.map((e) => e.sourceId).filter(Boolean);
    const callerRows = callerIds.length === 0
        ? []
        : await ctx.storage.find<Record<string, unknown>>(symColl, { in: { uid: callerIds } });
    const callers = callerRows.map(rowToCodeSymbol);

    const calleeEdges = await ctx.storage.traverse(
        relColl,
        uid,
        'out',
        { filter: { eq: { type: 'CALLS' } } },
        HINT_CODE_RELATION,
    );
    const calleeIds = calleeEdges.map((e) => e.targetId).filter(Boolean);
    const calleeRows = calleeIds.length === 0
        ? []
        : await ctx.storage.find<Record<string, unknown>>(symColl, { in: { uid: calleeIds } });
    const callees = calleeRows.map(rowToCodeSymbol);

    const knowledgeEdges = await ctx.storage.traverse(
        lacColl,
        uid,
        'in',
        undefined,
        HINT_LORE_APPLIES_TO_CODE,
    );
    const knowledgeIds = knowledgeEdges.map((e) => e.sourceId).filter(Boolean);
    const knowledgeRows = knowledgeIds.length === 0
        ? []
        : await ctx.storage.find<Record<string, unknown>>(loreColl, { in: { id: knowledgeIds } });
    const knowledge = knowledgeRows.map(rowToLoreNodeLike);

    return { symbol, callers, callees, knowledge };
}

export async function getCodeRelationsTo(ctx: PluginGraphContext, targetUid: string): Promise<CodeRelationEdge[]> {
    try {
        const edges = await ctx.storage.traverse<{ type?: string; confidence?: number; reason?: string }>(
            collName(ctx.storage, CODE_RELATION),
            targetUid,
            'in',
            undefined,
            HINT_CODE_RELATION,
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
        const symColl = collName(ctx.storage, CODE_SYMBOL);
        const lacColl = collName(ctx.storage, LORE_APPLIES_TO_CODE);
        const symbols = await ctx.storage.find<Record<string, unknown>>(
            symColl,
            { eq: { repo } },
        );
        const out: { nodeId: string; symbolUid: string; relation: string }[] = [];
        for (const s of symbols) {
            const uid = String(s['uid'] ?? '');
            if (!uid) continue;
            const edges = await ctx.storage.traverse<{ relation?: string }>(
                lacColl,
                uid,
                'in',
                undefined,
                HINT_LORE_APPLIES_TO_CODE,
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
    const symColl = collName(ctx.storage, CODE_SYMBOL);
    const count = await ctx.storage.count(symColl, { eq: { repo } });
    if (count === 0) return 0;

    if (ctx.storage.mode === 'dataplane') {
        // Cloud edges are independent collections — DETACH DELETE
        // semantics don't apply. Walk the symbols once and clean up
        // their outgoing/incoming edges per-uid before dropping the
        // nodes.
        const relColl = collName(ctx.storage, CODE_RELATION);
        const lacColl = collName(ctx.storage, LORE_APPLIES_TO_CODE);
        const fcColl = collName(ctx.storage, FILE_CONTAINS);
        const symbols = await ctx.storage.find<Record<string, unknown>>(
            symColl,
            { eq: { repo } },
            { limit: 100_000 },
        );
        for (const s of symbols) {
            const uid = String(s['uid'] ?? '');
            if (!uid) continue;
            await ctx.storage.deleteEdgesWhere(relColl, { eq: { sourceId: uid } }, HINT_CODE_RELATION);
            await ctx.storage.deleteEdgesWhere(relColl, { eq: { targetId: uid } }, HINT_CODE_RELATION);
            await ctx.storage.deleteEdgesWhere(lacColl, { eq: { targetId: uid } }, HINT_LORE_APPLIES_TO_CODE);
            await ctx.storage.deleteEdgesWhere(fcColl, { eq: { targetId: uid } }, HINT_FILE_CONTAINS);
        }
    }

    // Kùzu: DETACH DELETE inside deleteWhere strips attached edges.
    // Cloud: edges already cleaned above; this drops the symbol nodes.
    await ctx.storage.deleteWhere(symColl, { eq: { repo } });
    return count;
}

/* ─── DevActivity (team awareness) ────────────────────────────── */

export async function recordDevActivity(ctx: PluginGraphContext, activity: DevActivity): Promise<void> {
    const id = `${activity.dev}::${activity.project}`;
    await ctx.storage.upsert(collName(ctx.storage, DEV_ACTIVITY), 'id', {
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
            collName(ctx.storage, DEV_ACTIVITY),
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
        const coll = collName(ctx.storage, DEV_ACTIVITY);
        const filter = { lt: { timestamp: cutoff } };
        const count = await ctx.storage.count(coll, filter);
        if (count > 0) await ctx.storage.deleteWhere(coll, filter);
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
    await ctx.storage.upsert(collName(ctx.storage, CODE_FILE), 'path', {
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
        collName(ctx.storage, FILE_CONTAINS),
        filePath,
        symbolUid,
        {},
        HINT_FILE_CONTAINS,
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
        collName(ctx.storage, LORE_TOUCHES_FILE),
        loreNodeId,
        filePath,
        { relation },
        HINT_LORE_TOUCHES_FILE,
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
        collName(ctx.storage, LORE_APPLIES_TO_CODE),
        nodeId,
        symbolUid,
        { relation },
        HINT_LORE_APPLIES_TO_CODE,
    );
}

export async function listCodeFiles(
    ctx: PluginGraphContext,
): Promise<Array<{ path: string; language: string; repo: string }>> {
    try {
        const rows = await ctx.storage.find<Record<string, unknown>>(
            collName(ctx.storage, CODE_FILE),
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
            collName(ctx.storage, CODE_SYMBOL),
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
    const symColl = collName(ctx.storage, CODE_SYMBOL);
    const out: Array<{ path: string; language: string; repo: string; preview: string }> = [];
    for (const f of files) {
        try {
            const rows = await ctx.storage.find<Record<string, unknown>>(
                symColl,
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

/* ─── Prune own inferred edges ────────────────────────────────── */

export async function pruneInferredDeveloperEdges(
    ctx: PluginGraphContext,
    relationPrefix: string,
): Promise<{ touchesFile: number; appliesToCode: number }> {
    let touchesFile = 0;
    let appliesToCode = 0;
    try {
        touchesFile = await ctx.storage.deleteEdgesWhere(
            collName(ctx.storage, LORE_TOUCHES_FILE),
            { startsWith: { relation: relationPrefix } },
            HINT_LORE_TOUCHES_FILE,
        );
    } catch { /* table may be missing on older graphs */ }
    try {
        appliesToCode = await ctx.storage.deleteEdgesWhere(
            collName(ctx.storage, LORE_APPLIES_TO_CODE),
            { startsWith: { relation: relationPrefix } },
            HINT_LORE_APPLIES_TO_CODE,
        );
    } catch { /* ignore */ }
    return { touchesFile, appliesToCode };
}
