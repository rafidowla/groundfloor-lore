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
