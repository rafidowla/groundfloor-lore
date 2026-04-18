/**
 * developer/operations.ts — Kùzu operations owned by the Developer plugin.
 *
 * Every function takes a PluginGraphContext instead of a LocalGraph
 * instance, which keeps the plugin from importing core internals. The
 * core engine has no knowledge of these operations — callers reach them
 * via PluginRegistry.get('developer')?.api.
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
import type { PluginGraphContext } from '../types.js';
import type { CodeSymbol, CodeRelationEdge, DevActivity } from './types.js';

function escapeString(s: string): string {
    return s.replace(/'/g, "''").replace(/\\/g, '\\\\');
}

function rowToCodeSymbol(row: Record<string, unknown>, prefix: string = 's'): CodeSymbol {
    const get = (k: string): unknown => row[k] ?? row[`${prefix}.${k}`];
    return {
        uid: (get('uid') as string) ?? '',
        name: (get('name') as string) ?? '',
        kind: (get('kind') as string) ?? '',
        filePath: (get('filePath') as string) ?? '',
        startLine: (get('startLine') as number) ?? 0,
        endLine: (get('endLine') as number) ?? 0,
        content: (get('content') as string) ?? '',
        signature: (get('signature') as string) ?? '',
        returnType: (get('returnType') as string) ?? '',
        parameterCount: (get('parameterCount') as number) ?? 0,
        repo: (get('repo') as string) ?? '',
    };
}

function rowToLoreNodeLike(row: Record<string, unknown>, prefix: string = 'n'): Record<string, unknown> {
    const get = (k: string): unknown => row[k] ?? row[`${prefix}.${k}`];
    return {
        id: (get('id') as string) ?? '',
        type: (get('type') as string) ?? '',
        label: (get('label') as string) ?? '',
        content: (get('content') as string) ?? '',
        tags: (get('tags') as string) ?? '',
        project: (get('project') as string) ?? '',
        ecosystem: (get('ecosystem') as string) ?? '',
    };
}

/* ─── CodeSymbol write path (used by `lore index`) ────────────── */

export async function upsertCodeSymbol(ctx: PluginGraphContext, symbol: CodeSymbol): Promise<void> {
    await ctx.executeQuery(
        `MERGE (s:CodeSymbol {uid: $uid})
         SET s.name = $name, s.kind = $kind, s.filePath = $filePath,
             s.startLine = $startLine, s.endLine = $endLine,
             s.content = $content, s.signature = $signature,
             s.returnType = $returnType, s.parameterCount = $parameterCount,
             s.repo = $repo`,
        {
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
        },
    );
}

export async function addCodeRelation(ctx: PluginGraphContext, edge: CodeRelationEdge): Promise<void> {
    await ctx.executeQuery(
        `MATCH (a:CodeSymbol {uid: $sourceUid}), (b:CodeSymbol {uid: $targetUid})
         CREATE (a)-[:CodeRelation {type: $type, confidence: $confidence, reason: $reason}]->(b)`,
        {
            sourceUid: edge.sourceUid,
            targetUid: edge.targetUid,
            type: edge.type,
            confidence: edge.confidence,
            reason: edge.reason,
        },
    );
}

/* ─── CodeSymbol read path (used by MCP tools) ────────────────── */

export async function queryCodeSymbols(
    ctx: PluginGraphContext,
    query: string,
    repo?: string,
    limit: number = 20,
): Promise<CodeSymbol[]> {
    const escapedQuery = escapeString(query.toLowerCase());
    let cypher = `MATCH (s:CodeSymbol) WHERE lower(s.name) CONTAINS '${escapedQuery}' OR lower(s.filePath) CONTAINS '${escapedQuery}'`;
    if (repo) cypher += ` AND s.repo = '${escapeString(repo)}'`;
    cypher += ` RETURN s.* LIMIT ${limit}`;
    const rows = await ctx.queryRows(cypher);
    return rows.map((r) => rowToCodeSymbol(r));
}

export async function queryCodeSymbolsByName(ctx: PluginGraphContext, name: string): Promise<CodeSymbol[]> {
    try {
        const rows = await ctx.queryRows(
            `MATCH (s:CodeSymbol) WHERE s.name = '${escapeString(name)}' RETURN s.*`,
        );
        return rows.map((r) => rowToCodeSymbol(r));
    } catch {
        return [];
    }
}

export async function getCodeSymbolByUid(ctx: PluginGraphContext, uid: string): Promise<CodeSymbol | null> {
    try {
        const rows = await ctx.queryRows(
            `MATCH (s:CodeSymbol {uid: '${escapeString(uid)}'}) RETURN s.*`,
        );
        return rows.length > 0 ? rowToCodeSymbol(rows[0]) : null;
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
    const symRows = await ctx.queryRows(
        `MATCH (s:CodeSymbol {uid: '${escapeString(uid)}'}) RETURN s.*`,
    );
    const symbol = symRows.length > 0 ? rowToCodeSymbol(symRows[0]) : null;

    const callerRows = await ctx.queryRows(
        `MATCH (caller:CodeSymbol)-[:CodeRelation {type: 'CALLS'}]->(s:CodeSymbol {uid: '${escapeString(uid)}'})
         RETURN caller.*`,
    );
    const callers = callerRows.map((r) => rowToCodeSymbol(r, 'caller'));

    const calleeRows = await ctx.queryRows(
        `MATCH (s:CodeSymbol {uid: '${escapeString(uid)}'})-[:CodeRelation {type: 'CALLS'}]->(callee:CodeSymbol)
         RETURN callee.*`,
    );
    const callees = calleeRows.map((r) => rowToCodeSymbol(r, 'callee'));

    const knowledgeRows = await ctx.queryRows(
        `MATCH (n:LoreNode)-[:LoreAppliesToCode]->(s:CodeSymbol {uid: '${escapeString(uid)}'})
         RETURN n.*`,
    );
    const knowledge = knowledgeRows.map((r) => rowToLoreNodeLike(r));

    return { symbol, callers, callees, knowledge };
}

export async function getCodeRelationsTo(ctx: PluginGraphContext, targetUid: string): Promise<CodeRelationEdge[]> {
    try {
        const rows = await ctx.queryRows(
            `MATCH (source:CodeSymbol)-[r:CodeRelation]->(target:CodeSymbol {uid: '${escapeString(targetUid)}'})
             RETURN source.uid AS sourceUid, target.uid AS targetUid,
                    r.type AS type, r.confidence AS confidence, r.reason AS reason`,
        );
        return rows.map((row) => ({
            sourceUid: (row.sourceUid as string) ?? '',
            targetUid: (row.targetUid as string) ?? '',
            type: (row.type as string) ?? '',
            confidence: (row.confidence as number) ?? 1.0,
            reason: (row.reason as string) ?? '',
        }));
    } catch {
        return [];
    }
}

export async function getCrossPillarEdges(
    ctx: PluginGraphContext,
    repo: string,
): Promise<{ nodeId: string; symbolUid: string; relation: string }[]> {
    try {
        const rows = await ctx.queryRows(
            `MATCH (n:LoreNode)-[r:LoreAppliesToCode]->(s:CodeSymbol {repo: '${escapeString(repo)}'})
             RETURN n.id AS nodeId, s.uid AS symbolUid, r.relation AS relation`,
        );
        return rows.map((row) => ({
            nodeId: (row.nodeId as string) ?? '',
            symbolUid: (row.symbolUid as string) ?? '',
            relation: (row.relation as string) ?? 'applies_to',
        }));
    } catch {
        return [];
    }
}

export async function clearCodeSymbols(ctx: PluginGraphContext, repo: string): Promise<number> {
    const countRows = await ctx.queryRows(
        `MATCH (s:CodeSymbol {repo: '${escapeString(repo)}'}) RETURN count(s) AS cnt`,
    );
    const count = (countRows[0]?.cnt as number) ?? 0;

    await ctx.executeQuery(
        `MATCH (s:CodeSymbol {repo: '${escapeString(repo)}'})-[r:CodeRelation]->() DELETE r`,
    );
    await ctx.executeQuery(
        `MATCH ()-[r:CodeRelation]->(s:CodeSymbol {repo: '${escapeString(repo)}'}) DELETE r`,
    );
    await ctx.executeQuery(
        `MATCH ()-[r:LoreAppliesToCode]->(s:CodeSymbol {repo: '${escapeString(repo)}'}) DELETE r`,
    );
    await ctx.executeQuery(
        `MATCH (s:CodeSymbol {repo: '${escapeString(repo)}'}) DELETE s`,
    );
    return count;
}

/* ─── DevActivity (team awareness) ────────────────────────────── */

export async function recordDevActivity(ctx: PluginGraphContext, activity: DevActivity): Promise<void> {
    const id = `${activity.dev}::${activity.project}`;
    await ctx.executeQuery(
        `MERGE (a:DevActivity {id: $id})
         SET a.dev = $dev, a.project = $project, a.action = $action,
             a.filePath = $filePath, a.timestamp = $timestamp, a.tool = $tool`,
        {
            id,
            dev: activity.dev,
            project: activity.project,
            action: activity.action,
            filePath: activity.filePath,
            timestamp: activity.timestamp,
            tool: activity.tool,
        },
    );
}

export async function getActiveDevs(
    ctx: PluginGraphContext,
    project?: string,
    activeWindowMinutes: number = 30,
): Promise<DevActivity[]> {
    try {
        const cypher = project
            ? `MATCH (a:DevActivity) WHERE a.project = '${escapeString(project)}' RETURN a`
            : `MATCH (a:DevActivity) RETURN a`;
        const rows = await ctx.queryRows(cypher);
        const cutoff = new Date(Date.now() - activeWindowMinutes * 60 * 1000).toISOString();
        return rows
            .map((row) => {
                const get = (k: string): unknown => row[k] ?? row[`a.${k}`];
                return {
                    dev: (get('dev') as string) ?? '',
                    project: (get('project') as string) ?? '',
                    action: (get('action') as string) ?? '',
                    filePath: (get('filePath') as string) ?? '',
                    timestamp: (get('timestamp') as string) ?? '',
                    tool: (get('tool') as string) ?? '',
                };
            })
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
        const countRows = await ctx.queryRows(
            `MATCH (a:DevActivity) WHERE a.timestamp < '${cutoff}' RETURN count(a) AS cnt`,
        );
        const count = (countRows[0]?.cnt as number) ?? 0;
        if (count > 0) {
            await ctx.executeQuery(
                `MATCH (a:DevActivity) WHERE a.timestamp < '${cutoff}' DELETE a`,
            );
        }
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
    await ctx.executeQuery(
        `MERGE (f:CodeFile {path: $path})
         SET f.language = $language, f.loc = $loc,
             f.repo = $repo, f.lastModified = $lastModified`,
        {
            path: file.path,
            language: file.language ?? '',
            loc: file.loc ?? 0,
            repo: file.repo ?? '',
            lastModified: file.lastModified ?? new Date().toISOString(),
        },
    );
}

export async function addFileContains(
    ctx: PluginGraphContext,
    filePath: string,
    symbolUid: string,
): Promise<void> {
    await ctx.executeQuery(
        `MATCH (f:CodeFile {path: $path}), (s:CodeSymbol {uid: $uid})
         MERGE (f)-[:FileContains]->(s)`,
        { path: filePath, uid: symbolUid },
    );
}

export async function addLoreTouchesFile(
    ctx: PluginGraphContext,
    loreNodeId: string,
    filePath: string,
    relation: string = 'touches',
): Promise<void> {
    await ctx.executeQuery(
        `MATCH (n:LoreNode {id: $id}), (f:CodeFile {path: $path})
         MERGE (n)-[r:LoreTouchesFile]->(f)
         SET r.relation = $relation`,
        { id: loreNodeId, path: filePath, relation },
    );
}

/* ─── CodeSymbol ──────────────────────────────────────────────── */

export async function linkKnowledgeToCode(
    ctx: PluginGraphContext,
    nodeId: string,
    symbolUid: string,
    relation: string,
): Promise<void> {
    await ctx.executeQuery(
        `MATCH (n:LoreNode {id: $nodeId}), (s:CodeSymbol {uid: $symbolUid})
         CREATE (n)-[:LoreAppliesToCode {relation: $relation}]->(s)`,
        { nodeId, symbolUid, relation },
    );
}

export async function listCodeFiles(
    ctx: PluginGraphContext,
): Promise<Array<{ path: string; language: string; repo: string }>> {
    try {
        const rows = await ctx.queryRows(
            `MATCH (f:CodeFile) RETURN f.path AS path, f.language AS language, f.repo AS repo`,
        );
        return rows.map((r) => ({
            path: (r.path ?? '') as string,
            language: (r.language ?? '') as string,
            repo: (r.repo ?? '') as string,
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
        const rows = await ctx.queryRows(
            `MATCH (s:CodeSymbol) RETURN s.uid AS uid, s.name AS name, s.kind AS kind, s.filePath AS filePath, s.signature AS signature, s.content AS content, s.repo AS repo, s.startLine AS startLine, s.endLine AS endLine LIMIT ${limit}`,
        );
        return rows.map((r) => ({
            uid: (r.uid ?? '') as string,
            name: (r.name ?? '') as string,
            kind: (r.kind ?? '') as string,
            filePath: (r.filePath ?? '') as string,
            signature: (r.signature ?? '') as string,
            content: (r.content ?? '') as string,
            repo: (r.repo ?? '') as string,
            startLine: Number(r.startLine ?? 0),
            endLine: Number(r.endLine ?? 0),
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
            const rows = await ctx.queryRows(
                `MATCH (s:CodeSymbol {filePath: $path})
                 RETURN s.name AS name, s.kind AS kind, s.signature AS signature, s.content AS content`,
                { path: f.path },
            );
            const symbols = rows.map((r) => ({
                name: (r.name ?? '') as string,
                kind: (r.kind ?? '') as string,
                signature: (r.signature ?? '') as string,
                content: (r.content ?? '') as string,
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
    const rows = await ctx.queryRows(
        `MATCH (s:CodeSymbol) RETURN DISTINCT s.filePath AS filePath, s.repo AS repo`,
    );
    let filesCreated = 0;
    let edgesCreated = 0;
    for (const row of rows) {
        const filePath = row.filePath as string;
        const repo = (row.repo ?? '') as string;
        if (!filePath) continue;
        await upsertCodeFile(ctx, {
            path: filePath,
            language: inferLanguage(filePath),
            repo,
        });
        filesCreated++;
        const symRows = await ctx.queryRows(
            `MATCH (s:CodeSymbol {filePath: $path}) RETURN s.uid AS uid`,
            { path: filePath },
        );
        for (const sr of symRows) {
            await addFileContains(ctx, filePath, sr.uid as string);
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
        const tf = await ctx.queryRows(
            `MATCH ()-[e:LoreTouchesFile]->() WHERE e.relation STARTS WITH $p RETURN count(e) AS cnt`,
            { p: relationPrefix },
        );
        touchesFile = Number(tf[0]?.cnt ?? 0);
        await ctx.executeQuery(
            `MATCH ()-[e:LoreTouchesFile]->() WHERE e.relation STARTS WITH $p DELETE e`,
            { p: relationPrefix },
        );
    } catch { /* table may be missing on older graphs */ }
    try {
        const ac = await ctx.queryRows(
            `MATCH ()-[e:LoreAppliesToCode]->() WHERE e.relation STARTS WITH $p RETURN count(e) AS cnt`,
            { p: relationPrefix },
        );
        appliesToCode = Number(ac[0]?.cnt ?? 0);
        await ctx.executeQuery(
            `MATCH ()-[e:LoreAppliesToCode]->() WHERE e.relation STARTS WITH $p DELETE e`,
            { p: relationPrefix },
        );
    } catch { /* ignore */ }
    return { touchesFile, appliesToCode };
}
