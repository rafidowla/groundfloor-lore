/**
 * atlasIndexer.ts — Atlas → Lore Code Graph Bridge.
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Phase 3 — graph integration. Drives the in-house parser + resolver
 * pipeline (Phases 1, 2, 2.1) into the developer plugin's existing
 * Kùzu schema (CodeSymbol / CodeFile / CodeRelation). Replaces the
 * gitnexus subprocess in codeIndexer.ts without removing it; both
 * paths coexist behind the LORE_DEV_USE_NEW_PARSER feature flag
 * until Phase 7 retires gitnexus entirely.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 3 (graph integration).
 *
 * Flow:
 *   1. parseRepo(repoRoot) → ParsedFile[] with symbols, imports, calls
 *   2. resolveRepo(repoRoot, parsedFiles) → ParsedRelation[] (calls,
 *      imports, inheritance, contains)
 *   3. For each ParsedSymbol → operations.upsertCodeSymbol(...)
 *      For each ParsedFile → operations.upsertCodeFile(...) +
 *      operations.addFileContains(...)
 *      For each ParsedRelation → operations.addCodeRelation(...)
 *   4. Report counts to caller for observability.
 *
 * The mapping ParsedSymbol → CodeSymbol is intentionally lossy in v1:
 * Atlas captures more (complexity, byteRange, signature, language,
 * parsedAt) than the existing CodeSymbol schema holds. The schema
 * additions land alongside Phase 4's analytics so the Kùzu rows have
 * a place to store complexity / pagerank / churn etc.
 */

import * as path from 'node:path';
import type { PluginGraphContext } from '@lore-core/plugins/types.js';
import { parseRepo } from './parser/index.js';
import { resolveRepo } from './resolver/index.js';
import type { ParsedFile, ParsedRelation, ParsedSymbol } from './parser/types.js';
import type { CodeRelationEdge, CodeSymbol } from './types.js';
import {
    addCodeRelation,
    addFileContains,
    clearCodeSymbols,
    upsertCodeFile,
    upsertCodeSymbol,
} from './operations.js';

export interface AtlasIndexResult {
    repo: string;
    repoRoot: string;
    /** Files actually parsed (excludes skipped). */
    filesParsed: number;
    /** CodeSymbols inserted into Kùzu. */
    symbolsUpserted: number;
    /** CodeFile rows synthesised. */
    filesUpserted: number;
    /** Cross-symbol relation edges inserted. */
    relationsInserted: number;
    /** Per-relation-kind breakdown. */
    relationsByKind: Record<string, number>;
    /** Wall-clock duration for the entire indexing pass. */
    durationMs: number;
}

/**
 * Map a ParsedSymbol into the existing CodeSymbol shape. The Atlas
 * `id` becomes `uid`. Phase 1+ fields (complexity, byteRange.start/end,
 * language) are intentionally dropped here in v1 — Phase 4 extends the
 * Kùzu schema to absorb them so analytics queries stay native.
 */
function parsedSymbolToCodeSymbol(sym: ParsedSymbol, repo: string): CodeSymbol {
    return {
        uid: sym.id,
        name: sym.name,
        kind: sym.kind,
        filePath: sym.file,
        startLine: sym.byteRange.startLine,
        endLine: sym.byteRange.endLine,
        content: '',         // Phase 4 may carry source slice; v1 stores empty string.
        signature: sym.signature,
        returnType: '',      // Atlas doesn't infer return types in v1.
        parameterCount: 0,   // Atlas doesn't yet count params; future enhancement.
        repo,
    };
}

/**
 * Map a ParsedRelation to CodeRelationEdge. Some Atlas relation
 * kinds (`imports`, `contains`) target file-pseudonodes (e.g.,
 * `file:packages/lore/src/foo.ts`) which CodeRelation can store as a
 * targetUid string just like any other symbol id.
 */
function parsedRelationToCodeRelation(rel: ParsedRelation): CodeRelationEdge {
    return {
        sourceUid: rel.sourceId,
        targetUid: rel.targetId,
        type: rel.kind,
        confidence: rel.confidence,
        reason: rel.reason,
    };
}

/**
 * Repo name from a repo root path. Uses the basename — same convention
 * gitnexus uses internally. Caller may override via the optional
 * `repoName` argument (e.g., for monorepo sub-packages).
 */
function deriveRepoName(repoRoot: string, override?: string): string {
    return override ?? path.basename(path.resolve(repoRoot));
}

/**
 * Index a repository using the Atlas pipeline. Replaces gitnexus
 * subprocess invocations.
 *
 * `clearFirst` (default true): drops existing CodeSymbol rows for this
 * repo before re-indexing. Same idempotency posture as the gitnexus
 * codeIndexer's behaviour. Set to false for incremental Phase 5
 * detect-changes flows.
 */
export async function indexRepoWithAtlas(
    ctx: PluginGraphContext,
    repoRoot: string,
    options: { repoName?: string; clearFirst?: boolean } = {},
): Promise<AtlasIndexResult> {
    const startedAt = Date.now();
    const repo = deriveRepoName(repoRoot, options.repoName);
    const clearFirst = options.clearFirst ?? true;

    // 1. Parse.
    const parsed = await parseRepo(repoRoot);

    // 2. Resolve.
    const resolved = await resolveRepo(repoRoot, parsed.files);

    // 3. Optionally clear existing symbols for this repo.
    if (clearFirst) {
        await clearCodeSymbols(ctx, repo);
    }

    // 4. Upsert CodeFiles + CodeSymbols + relations.
    const filesByPath = new Map<string, ParsedFile>();
    for (const f of parsed.files) filesByPath.set(f.path, f);

    const fileLanguageByPath = new Map<string, string>();
    let symbolsUpserted = 0;
    let filesUpserted = 0;
    const seenFiles = new Set<string>();

    // First pass: CodeFile rows.
    for (const file of parsed.files) {
        if (seenFiles.has(file.path)) continue;
        seenFiles.add(file.path);
        await upsertCodeFile(ctx, {
            path: file.path,
            language: file.language,
            loc: file.loc,
            repo,
            lastModified: file.parsedAt,
        });
        filesUpserted += 1;
        fileLanguageByPath.set(file.path, file.language);
    }

    // Second pass: CodeSymbols + FileContains edges.
    for (const sym of resolved.table.all) {
        await upsertCodeSymbol(ctx, parsedSymbolToCodeSymbol(sym, repo));
        symbolsUpserted += 1;
        // Wire FileContains: CodeFile(path) → CodeSymbol(uid).
        await addFileContains(ctx, sym.file, sym.id);
    }

    // Third pass: CodeRelation edges.
    const relationsByKind: Record<string, number> = {};
    let relationsInserted = 0;
    for (const rel of resolved.relations) {
        relationsByKind[rel.kind] = (relationsByKind[rel.kind] ?? 0) + 1;

        // CodeRelation is FROM CodeSymbol TO CodeSymbol per the schema.
        // Atlas's import edges have sourceId = `file:<path>` — those
        // can't go through addCodeRelation (which targets CodeSymbol).
        // For v1 we skip those edges; Phase 4 extends the schema to
        // hold file-level edges (a CodeFile→CodeSymbol "ImportsSymbol"
        // rel table). The `imports` count is still reported so the
        // count is visible.
        if (rel.sourceId.startsWith('file:')) continue;

        await addCodeRelation(ctx, parsedRelationToCodeRelation(rel));
        relationsInserted += 1;
    }

    return {
        repo,
        repoRoot,
        filesParsed: parsed.files.length,
        symbolsUpserted,
        filesUpserted,
        relationsInserted,
        relationsByKind,
        durationMs: Date.now() - startedAt,
    };
}

/**
 * Feature-flag check: caller code (e.g., a refactored codeIndexer.ts
 * or a CLI wrapper) decides which path to take.
 */
export function isAtlasIndexerEnabled(): boolean {
    return process.env['LORE_DEV_USE_NEW_PARSER'] === '1'
        || process.env['LORE_DEV_USE_NEW_PARSER']?.toLowerCase() === 'true';
}
