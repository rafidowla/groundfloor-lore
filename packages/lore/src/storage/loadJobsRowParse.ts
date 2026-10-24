/**
 * loadJobsRowParse.ts - row routing + CSV line parsing for the bulk-load runner.
 *
 * Extracted from loadJobsRunner.ts (which sits at the file-size guard) so the runner can grow link-on-arrival
 * handling without touching the baseline. `routeJsonlObject` is re-exported from loadJobsRunner.ts, so every
 * existing importer keeps working.
 */
import type { ParsedRow } from '../bulkLoader/loaderDispatcher.js';

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Route a parsed JSONL object to its target. Supports three shapes:
 *   - { target: 'graph.node', ... }  — explicit target
 *   - { id, type, label, ...        } — assumed graph.node
 *   - { from, to, relationship      } — assumed graph.edge
 *   - { id, text                    } — assumed verbatim
 * The workspace is force-set from the job (Sprint L invariant —
 * a malicious row can't escape into a different workspace).
 */
export function routeJsonlObject(obj: unknown, workspace: string): ParsedRow | null {
    if (!obj || typeof obj !== 'object') return null;
    const o = obj as Record<string, unknown>;
    const explicit = typeof o['target'] === 'string' ? (o['target'] as string) : null;

    if (explicit === 'graph.node' || (!explicit && typeof o['id'] === 'string' && typeof o['type'] === 'string' && !o['from'])) {
        return {
            target: 'graph.node',
            row: {
                id: String(o['id'] ?? ''),
                type: String(o['type'] ?? ''),
                label: String(o['label'] ?? ''),
                content: String(o['content'] ?? ''),
                tags: o['tags'] as string[] | string | undefined,
                project: o['project'] as string | undefined,
                ecosystem: o['ecosystem'] as string | undefined,
                metadata: typeof o['metadata'] === 'string' ? (o['metadata'] as string) : JSON.stringify(o['metadata'] ?? {}),
                workspace,
            },
        };
    }
    if (explicit === 'graph.edge' || (!explicit && typeof o['from'] === 'string' && typeof o['to'] === 'string')) {
        return {
            target: 'graph.edge',
            row: {
                from: String(o['from'] ?? ''),
                to: String(o['to'] ?? ''),
                relationship: String(o['relationship'] ?? o['rel'] ?? ''),
                workspace,
                metadata: typeof o['metadata'] === 'string' ? (o['metadata'] as string) : JSON.stringify(o['metadata'] ?? {}),
            },
        };
    }
    if (explicit === 'vector') {
        return {
            target: 'vector',
            row: {
                id: String(o['id'] ?? ''),
                text: String(o['text'] ?? ''),
                workspace,
                metadata: o['metadata'] as Record<string, unknown> | undefined,
                ...(typeof o['autolink'] === 'boolean' ? { autolink: o['autolink'] } : {}),
            },
        };
    }
    // Fallback: verbatim if there's any text-y content.
    if (typeof o['id'] === 'string') {
        return {
            target: 'verbatim',
            row: {
                id: String(o['id']),
                text: String(o['text'] ?? ''),
                workspace,
                metadata: o['metadata'] as Record<string, unknown> | undefined,
                ...(typeof o['autolink'] === 'boolean' ? { autolink: o['autolink'] } : {}),
            },
        };
    }
    return null;
}

/** Minimal CSV-line parser — handles quoted strings + escaped quotes.
 *  Doesn't handle embedded newlines inside quoted cells (Z3 will
 *  swap in a proper streaming CSV reader). */
export function parseCsvLine(line: string): string[] {
    const cells: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"') {
                if (line[i + 1] === '"') {
                    cur += '"';
                    i++;
                } else {
                    inQ = false;
                }
            } else {
                cur += ch;
            }
        } else {
            if (ch === ',') {
                cells.push(cur);
                cur = '';
            } else if (ch === '"' && cur === '') {
                inQ = true;
            } else {
                cur += ch;
            }
        }
    }
    cells.push(cur);
    return cells;
}
