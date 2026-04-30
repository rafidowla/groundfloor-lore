/**
 * git/lineage.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * `git blame` over symbol byte ranges.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 5 (git signals — host-agnostic).
 *
 * Returns the per-line authorship history of a symbol's source. Useful
 * for "who last touched this function?" / "when was this code written?"
 * questions without needing host-specific PR-state APIs.
 */

import { spawnSync } from 'node:child_process';
import type { ParsedSymbol } from '../parser/types.js';

export interface BlameLine {
    /** Source line number (1-based). */
    line: number;
    /** Commit SHA. */
    sha: string;
    /** Author name (from `git config user.name` at commit time). */
    author: string;
    /** ISO-8601 author timestamp. */
    authorDate: string;
    /** The actual source line text. */
    content: string;
}

const PORCELAIN_HEADER_RE = /^([0-9a-f]{7,40})\s+(\d+)\s+(\d+)/;

/**
 * Run `git blame --line-porcelain` over the symbol's byte-range lines
 * and parse the result. Returns one BlameLine per source line in the
 * range.
 */
export function symbolLineage(repoRoot: string, symbol: ParsedSymbol): BlameLine[] {
    const result = spawnSync(
        'git',
        [
            'blame', '--line-porcelain',
            '-L', `${symbol.byteRange.startLine},${symbol.byteRange.endLine}`,
            '--', symbol.file,
        ],
        { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.status !== 0) return [];

    return parseBlamePorcelain(result.stdout);
}

function parseBlamePorcelain(stdout: string): BlameLine[] {
    const lines: BlameLine[] = [];
    let current: Partial<BlameLine> = {};

    for (const line of stdout.split('\n')) {
        const headerMatch = PORCELAIN_HEADER_RE.exec(line);
        if (headerMatch) {
            // Start of a new line block.
            if (current.line !== undefined && current.content !== undefined) {
                lines.push(current as BlameLine);
            }
            current = {
                sha: headerMatch[1],
                line: parseInt(headerMatch[3], 10),
            };
            continue;
        }
        if (line.startsWith('author ')) {
            current.author = line.slice('author '.length);
        } else if (line.startsWith('author-time ')) {
            const ts = parseInt(line.slice('author-time '.length), 10);
            if (Number.isFinite(ts)) {
                current.authorDate = new Date(ts * 1000).toISOString();
            }
        } else if (line.startsWith('\t')) {
            current.content = line.slice(1);
        }
    }
    if (current.line !== undefined && current.content !== undefined) {
        lines.push(current as BlameLine);
    }
    return lines;
}

/**
 * Convenience: distinct authors for a symbol.
 */
export function symbolAuthors(repoRoot: string, symbol: ParsedSymbol): string[] {
    const blame = symbolLineage(repoRoot, symbol);
    return Array.from(new Set(blame.map((b) => b.author).filter(Boolean)));
}
