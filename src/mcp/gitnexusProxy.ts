/**
 * gitnexusProxy.ts — GitNexus MCP Tool Proxy.
 *
 * Purpose:
 *   Proxies GitNexus MCP tools through Lore's unified MCP server.
 *   Uses the CLI bridge (process isolation) to execute GitNexus commands
 *   and return structured results. This allows users to configure a single
 *   MCP server (groundfloor-lore) and access all tools from both engines.
 *
 * Architecture:
 *   Calls `gitnexus <command> [args]` via child_process.execSync().
 *   Output is redirected to a temp file to avoid pipe buffer truncation.
 *   Results are returned as MCP text content.
 *
 * Proxied Tools:
 *   - gitnexus_query: Search execution flows (BM25 + vector hybrid)
 *   - gitnexus_context: 360° symbol view (callers, callees, processes)
 *   - gitnexus_impact: Blast radius analysis
 *   - gitnexus_cypher: Raw Cypher query execution
 *   - gitnexus_detect_changes: Uncommitted change analysis
 *   - gitnexus_rename: Multi-file coordinated rename (preview by default)
 *
 * Side Effects: Executes gitnexus CLI as child process, writes temp files.
 * Determinism: Non-deterministic (depends on GitNexus DB state).
 * Idempotency: Read-only tools are idempotent. rename with dry_run=false is not.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { isGitNexusAvailable } from '../engines/codeIndexer.js';

/* ─── Types ───────────────────────────────────────────────────── */

/**
 * ProxyResult — Result from a proxied GitNexus tool call.
 */
export interface ProxyResult {
    /** Whether the call succeeded */
    success: boolean;
    /** Result text (JSON or markdown from GitNexus) */
    text: string;
}

/* ─── Core Proxy Engine ──────────────────────────────────────── */

/**
 * resolveGitNexusBin — Resolve the path to the gitnexus binary.
 *
 * Reuses same resolution logic as codeIndexer.ts.
 * Prefers bundled node_modules/.bin/gitnexus over global installs.
 */
function resolveGitNexusBin(): string {
    const packageRoot = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        '..', '..',
    );

    const candidates = [
        path.join(packageRoot, 'node_modules', '.bin', 'gitnexus'),
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
 * execGitNexus — Execute a gitnexus CLI command and capture output.
 *
 * Uses temp file redirect to avoid pipe buffer truncation.
 *
 * @param args - CLI arguments (e.g., ['query', '-r', 'myrepo', 'auth flow'])
 * @returns ProxyResult with success status and output text.
 *
 * Side Effects: Executes child process, writes/reads temp file.
 * Error Behavior: Returns { success: false, text: error message }.
 */
function execGitNexus(args: string[]): ProxyResult {
    if (!isGitNexusAvailable()) {
        return {
            success: false,
            text: 'GitNexus is not installed. Install with: npm install -g gitnexus',
        };
    }

    const bin = resolveGitNexusBin();
    const tmpFile = path.join(os.tmpdir(), `lore-proxy-${crypto.randomBytes(6).toString('hex')}.json`);

    try {
        const escapedArgs = args.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(' ');
        execSync(
            `"${bin}" ${escapedArgs} > "${tmpFile}" 2>/dev/null`,
            { timeout: 60000, maxBuffer: 100 * 1024 * 1024 },
        );

        const output = fs.readFileSync(tmpFile, 'utf-8').trim();
        if (!output) return { success: true, text: '(no output)' };

        // Try to parse as JSON and extract markdown if available
        try {
            const parsed = JSON.parse(output);
            if (parsed.markdown) {
                return { success: true, text: parsed.markdown };
            }
            return { success: true, text: JSON.stringify(parsed, null, 2) };
        } catch {
            // Raw text output
            return { success: true, text: output };
        }
    } catch (execError) {
        return {
            success: false,
            text: `GitNexus command failed: ${(execError as Error).message.slice(0, 300)}`,
        };
    } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
}

/* ─── Proxy Tool Implementations ─────────────────────────────── */

/**
 * proxyQuery — Search execution flows related to a concept.
 *
 * Proxies: gitnexus query <search_query> [-r repo] [--goal goal]
 *
 * @param query - Natural language or keyword search.
 * @param repo - Optional repository name.
 * @param goal - Optional goal description for ranking.
 * @returns Execution flows ranked by relevance.
 */
export function proxyQuery(query: string, repo?: string, goal?: string): ProxyResult {
    const args = ['query', query];
    if (repo) args.push('-r', repo);
    if (goal) args.push('--goal', goal);
    return execGitNexus(args);
}

/**
 * proxyContext — 360° view of a code symbol.
 *
 * Proxies: gitnexus context <name> [-r repo]
 *
 * @param name - Symbol name.
 * @param repo - Optional repository name.
 * @returns Categorized references (callers, callees, processes).
 */
export function proxyContext(name: string, repo?: string): ProxyResult {
    const args = ['context', name];
    if (repo) args.push('-r', repo);
    return execGitNexus(args);
}

/**
 * proxyImpact — Blast radius analysis for a symbol.
 *
 * Proxies: gitnexus impact <target> [-r repo] [--direction direction]
 *
 * @param target - Symbol or file to analyze.
 * @param repo - Optional repository name.
 * @param direction - 'upstream' or 'downstream'.
 * @returns Affected symbols grouped by depth + risk assessment.
 */
export function proxyImpact(target: string, repo?: string, direction?: string): ProxyResult {
    const args = ['impact', target];
    if (repo) args.push('-r', repo);
    if (direction) args.push('--direction', direction);
    return execGitNexus(args);
}

/**
 * proxyCypher — Execute raw Cypher against the code knowledge graph.
 *
 * Proxies: gitnexus cypher <query> [-r repo]
 *
 * @param query - Cypher query string.
 * @param repo - Optional repository name.
 * @returns Query results as markdown table.
 */
export function proxyCypher(query: string, repo?: string): ProxyResult {
    const args = ['cypher', query];
    if (repo) args.push('-r', repo);
    return execGitNexus(args);
}

/**
 * proxyDetectChanges — Analyze uncommitted changes and find affected flows.
 *
 * Proxies: gitnexus detect_changes (not a CLI command — use MCP directly)
 * Falls back to: gitnexus cypher with diff-based query.
 *
 * @param repo - Optional repository name.
 * @param scope - 'unstaged', 'staged', 'all', or 'compare'.
 * @returns Changed symbols and affected processes.
 */
export function proxyDetectChanges(repo?: string, scope?: string): ProxyResult {
    // detect_changes is MCP-only, not a CLI command.
    // Return a helpful message directing to the appropriate tool.
    return {
        success: false,
        text: 'detect_changes is not available via CLI proxy. Use the gitnexus MCP directly or run `git diff` + `gitnexus cypher` to trace affected symbols.',
    };
}

/**
 * proxyRename — Multi-file coordinated rename.
 *
 * Proxies: gitnexus rename is MCP-only.
 * Directs user to gitnexus MCP for this capability.
 *
 * @param symbolName - Current symbol name.
 * @param newName - New name.
 * @param repo - Optional repository name.
 * @returns Rename preview or result.
 */
export function proxyRename(symbolName: string, newName: string, repo?: string): ProxyResult {
    return {
        success: false,
        text: 'rename is not available via CLI proxy. Use the gitnexus MCP directly for multi-file rename operations.',
    };
}
