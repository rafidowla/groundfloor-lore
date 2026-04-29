/**
 * audit.ts — Append-only tool-call audit log (Phase 4 / C6).
 *
 * Why:
 *   Personal plugin is going to ingest photos, emails, medical records.
 *   Family plugin will eventually run multi-user. Bank-demo plugin will
 *   live under regulatory scrutiny. All three need the same substrate
 *   primitive: "every time a tool acts on this graph, was it allowed,
 *   what did it do, who asked, when."
 *
 *   Today's users (developer workspace, single-user) get this for free —
 *   they can scroll `lore audit tail` to understand what their IDE's
 *   LLM just did to their graph. Tomorrow's regulated customers get the
 *   same surface with enterprise policies plugging in.
 *
 * Shape:
 *   - Append-only JSON Lines at ~/.groundfloor/audit.jsonl (0600).
 *   - Each entry: timestamp, actor, tool, redacted args, result, duration.
 *   - No dependencies — fs.appendFileSync + JSON.stringify is enough.
 *     When the file grows past a threshold, `lore audit rotate` will
 *     roll it (not in scope for C6a; append-only handles years of normal
 *     use before a rotation is even interesting).
 *
 * Why JSONL, not sqlite:
 *   - Zero deps. We already have too many native modules (keytar,
 *     kuzu-lite, lancedb) — adding another would grow install surface.
 *   - Append-only writes are atomic on POSIX for small lines — no
 *     journal, no wal, no file-locking drama.
 *   - `tail -f audit.jsonl | jq` is the debugging UX.
 *   - When we need structured queries (Phase 6+), ingest into Kùzu or
 *     DuckDB offline — don't couple the write-path to query speed.
 *
 * Redaction:
 *   - This module does not redact args itself. Callers MUST redact any
 *     secret-bearing arg (API keys, auth tokens, user-supplied
 *     passwords) before passing to log(). Why: the redaction policy is
 *     tool-specific (store_edge's 'relation' is fine to log; set_api_key's
 *     'apiKey' is not). Core can't know; the tool registration owns it.
 *   - Node IDs are logged in full (not hashed) because the audit log
 *     IS the correlate — if you can't see the ID you can't investigate.
 *     Compensation: audit.jsonl is 0600, S1 self-heal ensures it stays
 *     locked, and logRedact.ts handles *stderr* leakage separately.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { LoreUser } from './identity.js';
import { currentUser } from './identity.js';
import { loreHome, loreHomePath } from '../config/loreHome.js';

export type AuditResult = 'success' | 'denied-by-policy' | 'denied-by-user' | 'error';

export interface AuditEntry {
    /** ISO-8601 timestamp at entry creation. */
    timestamp: string;
    /** Actor snapshot — identity.currentUser() at call time. */
    actor: { id: string; roles: string[] };
    /** Tool name as it appears in the MCP registration. */
    toolName: string;
    /** Args the tool received. Callers must redact secrets first. */
    args: unknown;
    /** Outcome. */
    result: AuditResult;
    /** Free-form detail: error message, approval id, or empty on success. */
    resultDetail?: string;
    /** Approval flow id when consent was requested (C6 consent gate). */
    approvalId?: string;
    /** Wall-clock duration of the tool invocation in ms. */
    durationMs: number;
}

export interface AuditLogOptions {
    /** Path to the JSONL file. Defaults to ~/.groundfloor/audit.jsonl. */
    path?: string;
    /**
     * Whether to log tool calls whose toolName starts with these
     * prefixes. Empty array = log everything (default).
     *
     * Typical use: `[]` ships all tool calls; future configs may opt
     * out of high-volume read tools (e.g. 'stats', 'list_nodes') if
     * the log gets noisy.
     */
    includePrefixes?: string[];
}

export class AuditLog {
    private readonly filePath: string;
    private readonly includePrefixes: string[];

    constructor(options: AuditLogOptions = {}) {
        this.filePath = options.path ?? loreHomePath('audit.jsonl');
        this.includePrefixes = options.includePrefixes ?? [];

        // Ensure the file exists with 0600 perms so tools relying on
        // "it's there to append to" don't need to branch on creation.
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            if (!fs.existsSync(this.filePath)) {
                fs.writeFileSync(this.filePath, '', { mode: 0o600 });
            } else {
                // Self-heal perms (S1 pattern)
                try { fs.chmodSync(this.filePath, 0o600); } catch { /* best-effort */ }
            }
        } catch (err) {
            console.error(`[audit] init failed: ${(err as Error).message}`);
        }
    }

    /**
     * log — append one entry. Sync fs call — audit log writes should
     * be on the hot path (happen before the tool result goes back to
     * the caller) so this is intentionally blocking. The write is
     * small (a few hundred bytes) and POSIX guarantees append atomicity
     * for writes under PIPE_BUF (512 bytes min), which covers our
     * typical entry size. Longer entries may interleave under heavy
     * concurrent writes — acceptable for a single-user-per-machine
     * deployment.
     */
    log(entry: Omit<AuditEntry, 'timestamp' | 'actor'> & { actor?: LoreUser }): void {
        if (this.includePrefixes.length > 0 && !this.includePrefixes.some((p) => entry.toolName.startsWith(p))) {
            return;
        }
        const actor = entry.actor ?? currentUser();
        const fullEntry: AuditEntry = {
            timestamp: new Date().toISOString(),
            actor: { id: actor.id, roles: actor.roles },
            toolName: entry.toolName,
            args: entry.args,
            result: entry.result,
            resultDetail: entry.resultDetail,
            approvalId: entry.approvalId,
            durationMs: entry.durationMs,
        };
        try {
            fs.appendFileSync(this.filePath, JSON.stringify(fullEntry) + '\n', { mode: 0o600 });
        } catch (err) {
            // Never fail the tool call because the audit log failed.
            console.error(`[audit] append failed: ${(err as Error).message}`);
        }
    }

    /**
     * tail — read the last N entries.
     *
     * Naive implementation: read the whole file, split lines, take
     * the last N. Fine for files up to tens of MBs; when the log grows
     * past that a rotation job needs to run first. Not a C6 concern.
     */
    tail(n: number): AuditEntry[] {
        if (!fs.existsSync(this.filePath)) return [];
        const contents = fs.readFileSync(this.filePath, 'utf-8');
        const lines = contents.split('\n').filter(Boolean);
        const slice = lines.slice(Math.max(0, lines.length - n));
        const out: AuditEntry[] = [];
        for (const line of slice) {
            try { out.push(JSON.parse(line) as AuditEntry); }
            catch { /* skip malformed — shouldn't happen, but survivable */ }
        }
        return out;
    }

    /**
     * since — entries strictly after `isoTimestamp`.
     *
     * Same naive full-read-and-filter. Useful pattern for "show me
     * everything that happened since this morning" without needing a
     * query engine.
     */
    since(isoTimestamp: string): AuditEntry[] {
        if (!fs.existsSync(this.filePath)) return [];
        const cutoffMs = Date.parse(isoTimestamp);
        if (!Number.isFinite(cutoffMs)) return [];
        const contents = fs.readFileSync(this.filePath, 'utf-8');
        const lines = contents.split('\n').filter(Boolean);
        const out: AuditEntry[] = [];
        for (const line of lines) {
            try {
                const entry = JSON.parse(line) as AuditEntry;
                if (Date.parse(entry.timestamp) > cutoffMs) out.push(entry);
            } catch { /* skip malformed */ }
        }
        return out;
    }

    /** Absolute path to the underlying file — for CLI / tests. */
    getPath(): string { return this.filePath; }
}
