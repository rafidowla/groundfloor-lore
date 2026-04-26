/**
 * codeIndexer.ts — GitNexus → Lore Code Graph Bridge.
 *
 * Purpose:
 *   Uses the GitNexus CLI to query code graph data via Cypher, then imports
 *   all code symbols and relationships into Lore's unified .lore/graph/.
 *   This absorbs GitNexus as an internal engine within Lore.
 *
 * Architecture:
 *   Calls `gitnexus cypher -r <repo> <query>` via child_process.execSync().
 *   GitNexus returns JSON with a markdown table. We parse the table and
 *   write CodeSymbol + CodeRelation entries into the unified Kùzu graph.
 *
 * Flow:
 *   1. Read ~/.gitnexus/registry.json for repo list
 *   2. For each repo, run Cypher queries via gitnexus CLI
 *   3. Parse markdown table results into structured data
 *   4. Upsert CodeSymbol nodes + CodeRelation edges into Lore Kùzu
 *
 * Side Effects:
 *   - Executes gitnexus CLI as child process (read-only queries)
 *   - Writes CodeSymbol + CodeRelation to Lore's .lore/graph/
 *   - Reads ~/.gitnexus/registry.json
 *
 * Determinism: Deterministic for a given GitNexus state.
 * Idempotency: Yes — clears repo symbols before re-import.
 * Performance: ~3-10 seconds per repo depending on symbol count.
 */

import { execSync } from 'child_process';
import type { CodeSymbol, CodeRelationEdge } from './types.js';
import type { DeveloperApi } from './api.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/* ─── Types ───────────────────────────────────────────────────── */

/**
 * GitNexusRepoEntry — A repo entry from the GitNexus registry.
 */
export interface GitNexusRepoEntry {
    /** Repository name */
    name: string;
    /** Absolute path to the repository */
    path: string;
    /** Path to the .gitnexus/ storage directory */
    storagePath: string;
    /** ISO 8601 timestamp of last indexing */
    indexedAt: string;
    /** Latest commit hash at index time */
    lastCommit: string;
    /** Index statistics */
    stats: {
        files: number;
        nodes: number;
        edges: number;
        communities: number;
        processes: number;
        embeddings: number;
    };
}

/**
 * IndexResult — Summary of a code indexing operation.
 */
export interface IndexResult {
    /** Repository that was indexed */
    repo: string;
    /** Number of symbols imported */
    symbolsImported: number;
    /** Number of relations imported */
    relationsImported: number;
    /** Number of symbols that were cleared before import */
    symbolsCleared: number;
    /** Duration in milliseconds */
    durationMs: number;
    /** Errors encountered (non-fatal) */
    errors: string[];
}

/* ─── Registry ────────────────────────────────────────────────── */

/**
 * listGitNexusRepos — Read the GitNexus registry to find indexed repos.
 *
 * @returns Array of indexed repo entries.
 *
 * Side Effects: Reads ~/.gitnexus/registry.json.
 * Error Behavior: Returns empty array if registry doesn't exist.
 */
export function listGitNexusRepos(): GitNexusRepoEntry[] {
    const registryPath = path.join(os.homedir(), '.gitnexus', 'registry.json');

    try {
        const content = fs.readFileSync(registryPath, 'utf-8');
        return JSON.parse(content) as GitNexusRepoEntry[];
    } catch {
        return [];
    }
}

/**
 * getGitNexusRepo — Find a specific repo in the GitNexus registry.
 *
 * @param repoName - Name of the repo to find.
 * @returns The repo entry, or null if not found.
 */
export function getGitNexusRepo(repoName: string): GitNexusRepoEntry | null {
    const repos = listGitNexusRepos();
    return repos.find((repo) => repo.name === repoName) ?? null;
}

/* ─── GitNexus CLI Interface ──────────────────────────────────── */

/**
 * resolveGitNexusBin — Resolve the path to the gitnexus binary.
 *
 * Resolution order:
 *   1. node_modules/.bin/gitnexus (bundled dependency — preferred)
 *   2. NVM global install (user's Node version)
 *   3. Common system paths (/usr/local/bin, /opt/homebrew/bin)
 *   4. Fallback: 'gitnexus' (assumes PATH)
 *
 * Side Effects: Reads filesystem to check candidate paths.
 * Error Behavior: Returns 'gitnexus' (PATH fallback) if no candidate found.
 */
function resolveGitNexusBin(): string {
    // Resolve relative to this package's location
    const packageRoot = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..', '..',
    );

    const candidates = [
        // Bundled dependency (preferred)
        path.join(packageRoot, 'node_modules', '.bin', 'gitnexus'),
        // Global installs
        path.join(os.homedir(), '.nvm/versions/node', process.version, 'bin/gitnexus'),
        '/usr/local/bin/gitnexus',
        '/opt/homebrew/bin/gitnexus',
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    return 'gitnexus';
}

/**
 * isGitNexusAvailable — Check if the gitnexus CLI is installed and working.
 *
 * @returns True if gitnexus CLI responds to --version.
 *
 * Side Effects: Executes gitnexus --version.
 */
export function isGitNexusAvailable(): boolean {
    const bin = resolveGitNexusBin();
    try {
        execSync(`"${bin}" --version`, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

/**
 * generateSymbolUid — Generate a stable UID for a code symbol.
 *
 * Format: `repo::filePath::name::kind`
 *
 * Uses kind (Function, Class, etc.) instead of startLine so UIDs remain
 * stable when code is edited and line numbers shift. This ensures
 * cross-pillar edges (LoreAppliesToCode) survive re-indexing.
 *
 * Trade-off: Two symbols with the same name AND kind in the same file
 * would collide (extremely rare in practice). The MERGE/upsert handles
 * this safely by updating the existing record.
 *
 * @param repo - Repository name.
 * @param filePath - File path relative to repo root.
 * @param name - Symbol name.
 * @param kind - Symbol kind (Function, Class, Method, etc.).
 * @returns Stable UID string.
 */
export function generateSymbolUid(repo: string, filePath: string, name: string, kind: string): string {
    return `${repo}::${filePath}::${name}::${kind}`;
}

/**
 * CypherRow — A parsed row from a GitNexus markdown table result.
 */
type CypherRow = Record<string, string>;

/**
 * runCypher — Execute a Cypher query via the gitnexus CLI.
 *
 * Purpose:
 *   Runs `gitnexus cypher` and captures the full output by redirecting
 *   to a temp file. This bypasses the pipe buffer limit (8KB) that
 *   truncated large JSON results when using stdout capture.
 *
 * @param repoName - GitNexus repo name.
 * @param query - Cypher query string.
 * @returns Parsed rows from the markdown table.
 *
 * Side Effects: Executes gitnexus CLI, writes/reads temp file.
 * Error Behavior: Returns empty array on failure. Cleans up temp file.
 */
function runCypher(repoName: string, query: string): CypherRow[] {
    const bin = resolveGitNexusBin();
    const tmpFile = path.join(os.tmpdir(), `lore-cypher-${crypto.randomBytes(6).toString('hex')}.json`);

    try {
        // Redirect stdout to temp file to bypass pipe buffer limits
        execSync(
            `"${bin}" cypher -r "${repoName}" "${query.replace(/"/g, '\\"')}" > "${tmpFile}" 2>/dev/null`,
            { timeout: 60000, maxBuffer: 100 * 1024 * 1024 },
        );

        // Read the full output from the temp file
        const output = fs.readFileSync(tmpFile, 'utf-8').trim();
        if (!output) return [];

        const parsed = JSON.parse(output);

        // GitNexus returns [] for non-existent node types,
        // and {markdown, row_count} for valid queries.
        if (Array.isArray(parsed) || !parsed.markdown) return [];
        if (parsed.row_count === 0) return [];

        return parseMarkdownTable(parsed.markdown);
    } catch (cliError) {
        const errorMsg = (cliError as Error).message;
        if (!errorMsg.includes('does not exist')) {
            console.error(`  ⚠ Cypher query failed: ${errorMsg.slice(0, 200)}`);
        }
        return [];
    } finally {
        // Always clean up temp file
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

/**
 * runCypherPaginated — Execute a Cypher query with pagination.
 *
 * Adds SKIP/LIMIT to the query and fetches all pages.
 * Prevents JSON truncation on large result sets.
 *
 * @param repoName - GitNexus repo name.
 * @param baseQuery - Cypher query WITHOUT LIMIT/SKIP.
 * @param pageSize - Number of rows per page (default: 100).
 * @returns All rows from all pages.
 */
function runCypherPaginated(repoName: string, baseQuery: string, pageSize: number = 100): CypherRow[] {
    const allRows: CypherRow[] = [];
    let offset = 0;

    while (true) {
        const paginatedQuery = `${baseQuery} SKIP ${offset} LIMIT ${pageSize}`;
        const rows = runCypher(repoName, paginatedQuery);

        if (rows.length === 0) break;

        allRows.push(...rows);
        offset += pageSize;

        // Safety: stop if we've fetched a ridiculous number
        if (allRows.length > 50000) break;
    }

    return allRows;
}

/**
 * parseMarkdownTable — Parse a markdown table into row objects.
 *
 * Input format:
 *   | col1 | col2 | col3 |
 *   | --- | --- | --- |
 *   | val1 | val2 | val3 |
 *
 * @param markdown - Markdown table string.
 * @returns Array of objects with column names as keys.
 */
function parseMarkdownTable(markdown: string): CypherRow[] {
    const lines = markdown.split('\n').filter((line) => line.trim().length > 0);
    if (lines.length < 3) return []; // Need header, separator, at least one data row

    // Parse header
    const headers = lines[0]
        .split('|')
        .map((header) => header.trim())
        .filter((header) => header.length > 0);

    // Skip separator line (index 1), parse data rows
    const rows: CypherRow[] = [];
    for (let rowIndex = 2; rowIndex < lines.length; rowIndex++) {
        const values = lines[rowIndex]
            .split('|')
            .map((value) => value.trim())
            .filter((_, columnIndex, array) => columnIndex > 0 && columnIndex < array.length - 1);

        const row: CypherRow = {};
        for (let columnIndex = 0; columnIndex < headers.length; columnIndex++) {
            row[headers[columnIndex]] = values[columnIndex] ?? '';
        }
        rows.push(row);
    }

    return rows;
}

/* ─── Indexer ─────────────────────────────────────────────────── */

/**
 * GitNexus node types to query for code symbols.
 *
 * Includes all structural code node types from GitNexus's schema.
 * Meta-types (Community, Process) are included because they carry
 * valuable execution flow and module grouping data.
 */
const GITNEXUS_NODE_TYPES = [
    // Core code symbols
    'Function', 'Class', 'Interface', 'Method', 'File',
    'CodeElement', 'Property', 'Constructor', 'Section',
    // Language-specific (Rust, Go)
    'Struct', 'Enum', 'Trait', 'Impl',
];

/**
 * All edge types in GitNexus's CodeRelation table.
 * Previously only queried 4; now querying all 10.
 */
const GITNEXUS_EDGE_TYPES = [
    'CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS',
    'CONTAINS', 'DEFINES', 'HAS_METHOD', 'HAS_PROPERTY',
    'ACCESSES', 'OVERRIDES', 'MEMBER_OF',
];

/**
 * importFromGitNexus — Import a GitNexus repo's code graph into Lore.
 *
 * Purpose:
 *   Queries GitNexus via CLI Cypher, extracts all code symbols and
 *   relationships, and writes them into Lore's unified Kùzu graph.
 *
 * @param repoEntry - The GitNexus repo entry with storage path.
 * @param api - DeveloperApi for the workspace's plugin-owned Kùzu tables.
 * @returns Import result summary.
 *
 * Side Effects:
 *   - Calls gitnexus CLI for Cypher queries (read-only).
 *   - Clears existing code symbols for this repo in Lore.
 *   - Writes CodeSymbol + CodeRelation to Lore Kùzu graph.
 *
 * Error Behavior: Collects non-fatal errors. Returns result summary.
 * Idempotency: Yes — clears and re-imports.
 */
export async function importFromGitNexus(
    repoEntry: GitNexusRepoEntry,
    api: DeveloperApi,
): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let symbolsImported = 0;
    let relationsImported = 0;

    // Verify GitNexus is available
    if (!isGitNexusAvailable()) {
        return {
            repo: repoEntry.name,
            symbolsImported: 0,
            relationsImported: 0,
            symbolsCleared: 0,
            durationMs: Date.now() - startTime,
            errors: ['Code indexer CLI not found. Run `lore setup` to install it.'],
        };
    }

    // Preserve cross-pillar edges before clearing
    const crossPillarEdges = await api.getCrossPillarEdges(repoEntry.name);

    // Clear existing code symbols (and their CodeRelation edges)
    const symbolsCleared = await api.clearCodeSymbols(repoEntry.name);

    // Import symbols from each node type
    for (const nodeType of GITNEXUS_NODE_TYPES) {
        const query = `MATCH (n:${nodeType}) RETURN n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine`;
        const rows = runCypherPaginated(repoEntry.name, query, 50);

        for (const row of rows) {
            const symbolName = row['name'] ?? '';
            const symbolFilePath = row['filePath'] ?? '';
            const startLine = parseInt(row['startLine'] ?? '0', 10);
            const endLine = parseInt(row['endLine'] ?? '0', 10);

            // Stable UID: repo::filePath::name::kind (no line numbers)
            const uid = generateSymbolUid(repoEntry.name, symbolFilePath, symbolName, nodeType);

            try {
                await api.upsertCodeSymbol({
                    uid,
                    name: symbolName,
                    kind: nodeType,
                    filePath: symbolFilePath,
                    startLine,
                    endLine,
                    content: '',
                    signature: '',
                    returnType: '',
                    parameterCount: 0,
                    repo: repoEntry.name,
                });
                symbolsImported++;
            } catch (symbolError) {
                errors.push(`Symbol '${symbolName}' (${nodeType}): ${(symbolError as Error).message}`);
            }
        }
    }

    // Import ALL code relations (10 edge types)
    const edgeTypeFilter = GITNEXUS_EDGE_TYPES.map((edgeType) => `'${edgeType}'`).join(', ');
    const relQuery = `MATCH (a)-[r:CodeRelation]->(b) WHERE r.type IN [${edgeTypeFilter}] RETURN a.name AS srcName, a.filePath AS srcPath, labels(a) AS srcKind, b.name AS dstName, b.filePath AS dstPath, labels(b) AS dstKind, r.type AS relType, r.confidence AS confidence, r.reason AS reason`;
    const relRows = runCypherPaginated(repoEntry.name, relQuery, 50);

    for (const row of relRows) {
        const srcName = row['srcName'] ?? '';
        const srcPath = row['srcPath'] ?? '';
        const srcKind = row['srcKind'] ?? 'CodeElement';
        const dstName = row['dstName'] ?? '';
        const dstPath = row['dstPath'] ?? '';
        const dstKind = row['dstKind'] ?? 'CodeElement';

        const sourceUid = generateSymbolUid(repoEntry.name, srcPath, srcName, srcKind);
        const targetUid = generateSymbolUid(repoEntry.name, dstPath, dstName, dstKind);

        try {
            await api.addCodeRelation({
                sourceUid,
                targetUid,
                type: row['relType'] ?? 'CALLS',
                confidence: parseFloat(row['confidence'] ?? '1.0'),
                reason: row['reason'] ?? '',
            });
            relationsImported++;
        } catch {
            // Relation may reference symbols not yet imported — skip silently
        }
    }

    // Restore preserved cross-pillar edges
    let crossPillarRestored = 0;
    for (const edge of crossPillarEdges) {
        try {
            await api.linkKnowledgeToCode(edge.nodeId, edge.symbolUid, edge.relation);
            crossPillarRestored++;
        } catch {
            // Symbol may have been renamed/removed — edge is orphaned
        }
    }
    if (crossPillarRestored > 0) {
        console.log(`  ✓ ${crossPillarRestored}/${crossPillarEdges.length} cross-pillar edges restored`);
    }

    return {
        repo: repoEntry.name,
        symbolsImported,
        relationsImported,
        symbolsCleared,
        durationMs: Date.now() - startTime,
        errors,
    };
}

/**
 * indexAllRepos — Import all GitNexus-indexed repos into Lore.
 *
 * @param api - DeveloperApi for the workspace's plugin-owned Kùzu tables.
 * @returns Array of results, one per repo.
 */
export async function indexAllRepos(api: DeveloperApi): Promise<IndexResult[]> {
    const repos = listGitNexusRepos();

    if (repos.length === 0) {
        return [{
            repo: '(none)',
            symbolsImported: 0,
            relationsImported: 0,
            symbolsCleared: 0,
            durationMs: 0,
            errors: ['No indexed repos found. Run `lore analyze <path>` first to build the code index for a repo.'],
        }];
    }

    const results: IndexResult[] = [];
    for (const repo of repos) {
        const result = await importFromGitNexus(repo, api);
        results.push(result);
    }

    return results;
}
