/**
 * fileWatcher.ts — v1.1 incremental indexing on file change.
 *
 * Called by the developer plugin's `onFileChange` hook (wired into
 * core's FileWatcherEngine). For each file event:
 *   - 'add' / 'change': re-parse the file with Atlas, upsert each
 *     parsed symbol, upsert the CodeFile row.
 *   - 'unlink': drop CodeSymbol rows tied to that file path; drop
 *     the CodeFile row.
 *
 * Stale-symbol removal: a 'change' event might rename or delete a
 * symbol. We compute the set of symbols Atlas currently sees in the
 * file and drop any existing CodeSymbol rows under the same filePath
 * whose uid isn't in that set.
 *
 * Limitations of v1:
 *   - No CodeRelation cross-file delta. New calls / imports between
 *     this file and others get added; stale ones from this file are
 *     dropped via the symbol removal cascade. Edges INTO this file
 *     from elsewhere are NOT pruned — those land on the next full
 *     reconnect.
 *   - No re-embed. Verbatim store still has the old embedding under
 *     the old uid; the next reconnect (cursor-based) picks up the
 *     change. v1.1.1 wires the verbatim re-embed into this path.
 *
 * Original work for groundfloor-lore.
 */

import * as path from 'node:path';
import type { PluginGraphContext } from '@lore-core/plugins/types.js';
import { parseFile, getLanguageFor } from './parser/index.js';
import { upsertCodeSymbol, upsertCodeFile, addFileContains } from './operations.js';
import {
    CODE_FILE_COLL,
    CODE_SYMBOL_COLL,
} from './collections.js';

interface FileChangeEvent {
    kind: 'add' | 'change' | 'unlink';
    absPath: string;
    relPath: string;
    repo: string;
}

export async function onFileChangeImpl(
    event: FileChangeEvent,
    ctx: PluginGraphContext,
): Promise<void> {
    // Quick filter: only handle files Atlas knows how to parse.
    const language = getLanguageFor(event.absPath);
    if (language === null && event.kind !== 'unlink') {
        // Unknown language; skip. (Unlink path still runs to clean up
        // CodeFile rows even for unknown extensions.)
        return;
    }

    if (event.kind === 'unlink') {
        await handleUnlink(event, ctx);
        return;
    }

    // 'add' or 'change' — parse + upsert.
    await handleAddOrChange(event, ctx);
}

async function handleAddOrChange(event: FileChangeEvent, ctx: PluginGraphContext): Promise<void> {
    const { kind, absPath, relPath, repo } = event;

    // Parse the file. parseFile resolves the repo root from the path
    // structure; pass the abs file path. Returns null on unsupported
    // languages (already filtered above) or on parse failure.
    let parsed;
    try {
        // parseFile expects the abs file path + a repo root. Find the
        // repo root by walking up from absPath until we hit a directory
        // matching the watched-path entry. For now: derive from event.repo
        // — the registry knows abs path; we resolved relPath against it.
        const repoRoot = absPath.slice(0, absPath.length - relPath.length).replace(/\/$/, '');
        parsed = await parseFile(absPath, repoRoot);
    } catch (err) {
        console.error(`[file-watcher/dev] parseFile failed for ${relPath}: ${(err as Error).message}`);
        return;
    }
    if (!parsed) return;

    // Upsert CodeFile row.
    try {
        await upsertCodeFile(ctx, {
            path: parsed.path,
            language: parsed.language,
            loc: parsed.loc,
            repo,
            lastModified: parsed.parsedAt,
        });
    } catch (err) {
        console.error(`[file-watcher/dev] upsertCodeFile failed: ${(err as Error).message}`);
    }

    // Upsert each ParsedSymbol → CodeSymbol. Atlas's id format is
    // `<file>:<qualifiedName>:<kind>` which is the same uid we use here.
    const seenUids = new Set<string>();
    for (const sym of parsed.symbols) {
        seenUids.add(sym.id);
        try {
            await upsertCodeSymbol(ctx, {
                uid: sym.id,
                name: sym.name,
                kind: sym.kind,
                filePath: sym.file,
                startLine: sym.byteRange.startLine,
                endLine: sym.byteRange.endLine,
                content: '',
                signature: sym.signature,
                returnType: '',
                parameterCount: 0,
                repo,
            });
            await addFileContains(ctx, sym.file, sym.id);
        } catch (err) {
            console.error(`[file-watcher/dev] upsertCodeSymbol failed for ${sym.name}: ${(err as Error).message}`);
        }
    }

    // Stale-symbol removal: drop CodeSymbol rows under this filePath
    // whose uid isn't in seenUids. Catches renames and deletions.
    try {
        const existing = await ctx.storage.find<{ uid: string }>(
            CODE_SYMBOL_COLL,
            { eq: { filePath: parsed.path } },
            { limit: 10_000 },
        );
        const toDrop = existing.filter((s) => !seenUids.has(s.uid)).map((s) => s.uid);
        if (toDrop.length > 0) {
            await ctx.storage.deleteWhere(CODE_SYMBOL_COLL, { in: { uid: toDrop } });
        }
    } catch (err) {
        console.error(`[file-watcher/dev] stale-symbol cleanup failed for ${relPath}: ${(err as Error).message}`);
    }

    // Light log — useful when debugging incremental indexing.
    console.error(`[file-watcher/dev] ${kind} ${relPath} (${parsed.symbols.length} symbols)`);
    void path;  // imported for symmetry; keep for future relPath manipulation
}

async function handleUnlink(event: FileChangeEvent, ctx: PluginGraphContext): Promise<void> {
    const { relPath } = event;
    try {
        await ctx.storage.deleteWhere(CODE_SYMBOL_COLL, { eq: { filePath: relPath } });
        await ctx.storage.deleteWhere(CODE_FILE_COLL, { eq: { path: relPath } });
        console.error(`[file-watcher/dev] unlink ${relPath} — dropped symbols + CodeFile`);
    } catch (err) {
        console.error(`[file-watcher/dev] unlink cleanup failed for ${relPath}: ${(err as Error).message}`);
    }
}
