/**
 * audit.ts — Append-only tool-call audit log (Phase 4 / C6).
 *
 * Why:
 *   Any workspace — whether it holds developer notes, business records,
 *   or content under regulatory scrutiny — needs the same substrate
 *   primitive: "every time a tool acts on this graph, was it allowed,
 *   what did it do, who asked, when."
 *
 *   Single-user workspaces get this for free — operators can scroll
 *   `lore audit tail` to understand what their IDE's LLM just did to
 *   their graph. Multi-user and regulated deployments get the same
 *   surface with enterprise policies plugging in.
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
 *     surrealdb, lancedb) — adding another would grow install surface.
 *   - Append-only writes are atomic on POSIX for small lines — no
 *     journal, no wal, no file-locking drama.
 *   - `tail -f audit.jsonl | jq` is the debugging UX.
 *   - When we need structured queries (Phase 6+), ingest into SQLite or
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
import type { LoreUser } from './identity.js';
import { currentUser } from './identity.js';
import { loreHomePath } from '../config/loreHome.js';
import type { AuditLogExporter } from '../audit/exporter.js';
import {
    AUDIT_READ_LIMIT,
    ensureAnchor,
    newestArchive,
    readTailHash,
    sha256Hex,
    verifyChainWithHistory as verifyChainWithHistoryImpl,
    verifyLiveChain,
    type VerifyChainResult,
} from './auditChain.js';

// Re-export so existing importers of the verifier result type keep working
// after the verify/anchor logic moved into auditChain.ts (audit fix #3).
export type { VerifyChainResult } from './auditChain.js';

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
    /**
     * NW-7h — tamper-evidence chain link.
     *
     * SHA-256 (hex) of the previous record's serialized form (the
     * exact `JSON.stringify(prevEntry) + '\n'` line that was appended,
     * computed BEFORE this record was written). The first record in a
     * fresh file has `prevHash: null`; every subsequent record chains.
     *
     * An attacker who edits or removes a middle record cannot
     * recompute downstream hashes without rewriting the entire suffix
     * — `verifyChain()` walks the file and fails at the first mismatch,
     * surfacing the index where the chain breaks. This is "honest"
     * tamper-evidence: it does not prevent tampering, but it makes
     * post-hoc tampering detectable.
     *
     * Field is optional in the type so pre-NW-7h records (which had no
     * `prevHash`) still parse — the chain verifier treats a missing
     * field on a legacy entry as `null` and resumes chaining from there.
     */
    prevHash?: string | null;
    /**
     * Audit fix #3 / DEFECT 2 — genesis anchor tie. Present ONLY on the first
     * record of a fresh anchored chain: SHA-256 of the one-time genesis anchor
     * sidecar (`<audit>.anchor`). verifyChain() asserts it matches the on-disk
     * anchor, so a whole-file rewrite that omits or forges it is detected.
     * Absent on every non-genesis record and on legacy (pre-anchor) files.
     */
    anchorHash?: string;
    /**
     * Audit fix #3 / DEFECT 1 — rotation-continuation marker. `'continuation'`
     * on the synthetic first record written into a freshly-rotated live file;
     * absent on every ordinary record.
     */
    kind?: 'continuation';
    /**
     * Audit fix #3 / DEFECT 1 — on a continuation record, the basename of the
     * `.gz` archive the live file was rotated from. Lets verifyChainWithHistory()
     * locate the prior segment and confirm the cross-rotation link.
     */
    rotatedFrom?: string;
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
    /**
     * Sprint B-local — optional cloud-pluggable exporter. When set,
     * each successful audit write is also surfaced to the exporter
     * via onAuditEvent(). Wiring happens in services.ts/server.ts;
     * tests can attach directly via attachExporter().
     *
     * Default null (no exporter) preserves the pre-Sprint-B behavior
     * exactly — audit.jsonl is the only sink.
     */
    private exporter: AuditLogExporter | null = null;

    /**
     * NW-7h — in-memory tail of the chain. Each `log()` call stamps
     * the new record with `prevHash = lastHash` and then updates
     * `lastHash` to the SHA-256 of the JUST-SERIALIZED line. On
     * construction we warm it from the on-disk tail so chaining
     * survives a daemon restart. Null on a fresh file.
     */
    private lastHash: string | null = null;

    /**
     * NW-7h — write-serializer. `fs.promises.appendFile` does NOT
     * guarantee ordering when issued concurrently (each call opens its
     * own fd; the OS may interleave the actual writes). For a hash
     * chain to be verifiable on disk, lines must land in the same
     * order they were produced. We chain each append onto the previous
     * promise so the OS sees one write at a time. Callers still don't
     * await — log() returns immediately — but the on-disk order is now
     * deterministic. This brings back ordering without bringing back
     * the event-loop block that motivated the original sync→async
     * conversion.
     */
    private writeChain: Promise<void> = Promise.resolve();

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
            // NW-7h — warm the chain head from the last on-disk line.
            this.lastHash = readTailHash(this.filePath);
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
        // Audit fix #3 / DEFECT 2 — genesis anchoring. When we're about to write
        // the very first record of a genuinely empty file, mint (or load) the
        // one-time genesis anchor and tie this record to it. Gate on BOTH
        // lastHash === null AND an empty file so a pre-existing legacy log (whose
        // tail warmed lastHash on construction) is never retroactively anchored —
        // that would false-alarm on records written before the anchor existed.
        let anchorHash: string | null = null;
        if (this.lastHash === null && this.isFileEmpty()) {
            anchorHash = ensureAnchor(this.filePath);
        }
        const fullEntry: AuditEntry = {
            timestamp: new Date().toISOString(),
            actor: { id: actor.id, roles: actor.roles },
            toolName: entry.toolName,
            args: entry.args,
            result: entry.result,
            resultDetail: entry.resultDetail,
            approvalId: entry.approvalId,
            durationMs: entry.durationMs,
            // NW-7h — chain link. Stamp the previous record's hash so a
            // verifier can walk forward and detect any mid-file edit.
            prevHash: this.lastHash,
            // DEFECT 2 — only the genesis of a fresh anchored chain carries this.
            ...(anchorHash ? { anchorHash } : {}),
        };
        this.appendEntry(fullEntry);
    }

    /**
     * appendEntry — serialize, advance the in-memory chain head, enqueue the
     * (ordered, non-blocking) append, and surface to the exporter. Shared by
     * log() and onRotated()'s continuation write so both stamp the chain
     * identically.
     *
     * Advancing `lastHash` BEFORE the async append lets concurrent callers
     * observe a monotonically growing chain even when the underlying fs writes
     * interleave. The on-disk order matches the JSON.stringify order because we
     * serialize synchronously here and chain every append through
     * `this.writeChain` (a single append per call) — without that serialization,
     * concurrent appendFile calls can interleave at the OS level and break the
     * verifier. We never await: callers don't depend on durability and the
     * contract is "never fail the tool call because audit failed". (Audit
     * 2026-05-13 moved this off appendFileSync to unblock the event loop.)
     */
    private appendEntry(fullEntry: AuditEntry): void {
        const serialized = JSON.stringify(fullEntry) + '\n';
        this.lastHash = sha256Hex(serialized);
        this.writeChain = this.writeChain
            .then(() => fs.promises.appendFile(this.filePath, serialized, { mode: 0o600 }))
            .catch((err) => {
                console.error(`[audit] append failed: ${(err as Error).message}`);
            });
        // Sprint B-local — additive cloud-pluggable export. The exporter contract
        // demands non-throwing + non-blocking onAuditEvent; a misbehaving custom
        // exporter must NEVER fail a tool call, hence the try/catch.
        if (this.exporter) {
            try { this.exporter.onAuditEvent(fullEntry); }
            catch (err) {
                console.error(`[audit] exporter.onAuditEvent threw (suppressed): ${(err as Error).message}`);
            }
        }
    }

    /** True when the audit file is missing or zero bytes. */
    private isFileEmpty(): boolean {
        try { return !fs.existsSync(this.filePath) || fs.statSync(this.filePath).size === 0; }
        catch { return false; }
    }

    /**
     * attachExporter — wire (or replace) the cloud-pluggable exporter.
     * Sprint B-local. Called from services.ts/server.ts at daemon boot
     * after the audit log is constructed and the chosen exporter has
     * been configured + started.
     *
     * Passing null detaches — useful for tests that want to assert
     * the pre-Sprint-B no-exporter behavior is preserved.
     */
    attachExporter(exporter: AuditLogExporter | null): void {
        this.exporter = exporter;
    }

    /** Test-only accessor — current exporter or null. */
    getExporter(): AuditLogExporter | null { return this.exporter; }

    /**
     * tail — read the last N entries.
     *
     * SP-22: size-guarded — rejects files over 25 MB (rotation should have
     * run by then). Prevents a multi-second sync read + full-file JSON parse
     * on every admin poll. Rotation cap is 10 MB (logRotator default) so the
     * 25 MB limit only fires if rotation was missed for several cycles.
     * (Limit shared with the verifier — see auditChain.AUDIT_READ_LIMIT.)
     */

    tail(n: number): AuditEntry[] {
        if (!fs.existsSync(this.filePath)) return [];
        const stat = fs.statSync(this.filePath);
        if (stat.size > AUDIT_READ_LIMIT) return [];
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
     * Same size-guarded full-read-and-filter. Useful pattern for "show me
     * everything that happened since this morning" without needing a
     * query engine.
     */
    since(isoTimestamp: string): AuditEntry[] {
        if (!fs.existsSync(this.filePath)) return [];
        const cutoffMs = Date.parse(isoTimestamp);
        if (!Number.isFinite(cutoffMs)) return [];
        const stat = fs.statSync(this.filePath);
        if (stat.size > AUDIT_READ_LIMIT) return [];
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

    /**
     * NW-7h — verify the hash chain across the LIVE on-disk file.
     *
     * Returns `{ ok: true, count }` on an intact chain (with a `note` recording
     * whether it was anchored / legacy / a post-rotation continuation), or
     * `{ ok: false, brokenAt, reason }` at the first problem.
     *
     * Anchor-aware (audit fix #3 / DEFECT 2): a fresh chain's genesis record
     * must tie to the on-disk genesis anchor, so a whole-file rewrite or a
     * truncate-to-zero is DETECTED; legacy (pre-anchor) files still verify ok.
     * Cross-rotation continuity is proved by {@link verifyChainWithHistory}.
     *
     * Implementation lives in auditChain.ts (file-size budget); this method is
     * the stable public entry point `lore audit verify` (CLI) calls.
     */
    verifyChain(): VerifyChainResult {
        return verifyLiveChain(this.filePath);
    }

    /**
     * Audit fix #3 / DEFECT 1 — verify continuity across EVERY rotation
     * boundary, gunzipping the `.gz` archives and walking the chain from the
     * anchored genesis (oldest archive) through each continuation record to the
     * live file. Use this for a full-history integrity proof; verifyChain()
     * checks only the live file (and accepts a continuation boundary on faith).
     */
    verifyChainWithHistory(): VerifyChainResult {
        return verifyChainWithHistoryImpl(this.filePath);
    }

    /** Test/CLI accessor — current in-memory chain head hash. */
    getLastHash(): string | null { return this.lastHash; }

    /**
     * Audit fix #3 / DEFECT 1 — call after the audit file may have been
     * rotated/truncated (runLogRotation at boot AND on the periodic interval
     * gzip-archive + truncate audit.jsonl in place).
     *
     * The prior (RA2-26) fix simply reset the in-memory chain head to null, so
     * the new live file began at a fresh "genesis" with NO link back to the
     * archived history — verifyChain stayed self-consistent but an auditor
     * could not prove continuity across the boundary. We now write a synthetic
     * *continuation record* as the first line of the freshly-rotated live file:
     * it carries prevHash = the pre-truncation tail (still held in memory) and
     * a pointer to the `.gz` archive it was rotated from, so
     * verifyChainWithHistory() can walk across the boundary.
     *
     * A statSync no-op when no rotation happened (live file still has bytes), so
     * it stays safe to call unconditionally.
     */
    onRotated(): void {
        try {
            // Live file still has content → nothing was rotated; or a previous
            // onRotated() already wrote the continuation. No-op.
            if (fs.existsSync(this.filePath) && fs.statSync(this.filePath).size > 0) return;
            // Nothing to continue from on a genuinely fresh chain.
            if (this.lastHash === null) return;
            const archive = newestArchive(this.filePath);
            if (!archive) {
                // [DEFECT 2] An empty live file with NO matching archive is not a
                // legitimate rotation — it's an out-of-band truncate-to-zero. Do
                // NOT reset lastHash to null: leaving the in-memory tail intact
                // means the next record's prevHash dangles and verifyChain
                // surfaces the break, instead of silently starting a fresh chain.
                return;
            }
            const actor = currentUser();
            const continuation: AuditEntry = {
                timestamp: new Date().toISOString(),
                actor: { id: actor.id, roles: actor.roles },
                toolName: 'audit:rotation-continuation',
                args: { rotatedFrom: path.basename(archive) },
                result: 'success',
                durationMs: 0,
                prevHash: this.lastHash,
                kind: 'continuation',
                rotatedFrom: path.basename(archive),
            };
            this.appendEntry(continuation);
        } catch { /* best-effort — never fail a tool call over audit bookkeeping */ }
    }

    /**
     * NW-7h — wait for all queued appends to flush to disk. Tests and
     * the `lore audit verify` CLI both want this before reading the
     * file. Regular callers never need to await — fire-and-forget is
     * still the default.
     */
    async flush(): Promise<void> {
        await this.writeChain;
    }
}

/* ─── NW-5b — central audit-coverage primitives ───────────────────
 *
 * Why this exists:
 *   ent-audit-incomplete-coverage (AUDIT_FINDINGS_2.md). Pre-fix,
 *   audit logging was per-route ad-hoc — every new write handler had
 *   to remember to call `deps.auditLog.log({...})`. The PRIMARY write
 *   path (`store_node` MCP + `POST /api/node`) had been quietly
 *   dropped from audit since the file split. Same gap for `store_edge`
 *   / `delete_node` / `mark_stale` (MCP). For a system that markets
 *   "every tool call is auditable", the primary node-upsert NOT being
 *   audited is a credibility-level hole.
 *
 * The fix has two parts:
 *   1. `withMcpAudit(...)` / `withHttpAudit(...)` — thin wrappers
 *      that observe a handler's outcome and emit a single audit row
 *      with consistent fields (actor, workspace, event type,
 *      node/edge id when known, duration, result). Per-call sites
 *      that need richer audit detail still call `auditLog.log()`
 *      directly; the wrappers guarantee the floor.
 *   2. `KNOWN_WRITE_ROUTES` — a static registry of every write
 *      surface that MUST be audited. The NW-5b unit test asserts
 *      each name in this list is covered (either via the wrapper or
 *      a direct .log() call in the handler file). New write surfaces
 *      can't be added silently — the test fails until either the
 *      registry is updated AND the call site is wrapped.
 */

/**
 * The shape of an MCP tool response — duplicated here (rather than
 * imported from the MCP SDK) so security/audit.ts stays free of MCP
 * SDK coupling. Matches the SDK's CallToolResult enough for our
 * audit-outcome read (`isError`).
 */
export interface McpToolResultLike {
    content: ReadonlyArray<unknown>;
    isError?: boolean;
}

/**
 * Context the MCP wrapper extracts from the handler's args + result
 * to decorate the audit row. Stays small on purpose — anything
 * deeper goes through a manual `.log()` call.
 */
export interface McpAuditContext {
    /** Workspace the tool acted on (after resolution, if available). */
    workspace?: string | null;
    /** Primary entity id (node id / edge "src->tgt:rel"). */
    entityId?: string | null;
    /** Optional override of result fields when the handler succeeded
     *  but produced a structured error envelope (e.g. workspace_not_found). */
    resultDetailOverride?: string;
}

/**
 * Wrap an MCP tool handler so that every invocation emits exactly
 * one audit row with consistent fields. The wrapped handler keeps
 * its original async signature; the wrapper observes the resolved
 * value or thrown error and records the outcome.
 *
 * The audit row's `result` is derived from `isError` on the envelope
 * — success when absent or false, error otherwise. Thrown errors
 * are re-thrown after logging (the wrapper never swallows them).
 */
export function withMcpAudit<TArgs, TResult extends McpToolResultLike>(
    auditLog: AuditLog,
    toolName: string,
    extractCtx: (args: TArgs, result: TResult | null, err: Error | null) => McpAuditContext,
    handler: (args: TArgs) => Promise<TResult>,
): (args: TArgs) => Promise<TResult> {
    return async (args: TArgs): Promise<TResult> => {
        const startedAt = Date.now();
        let result: TResult | null = null;
        let err: Error | null = null;
        try {
            result = await handler(args);
            return result;
        } catch (caught) {
            err = caught as Error;
            throw caught;
        } finally {
            try {
                const ctx = extractCtx(args, result, err);
                auditLog.log({
                    toolName,
                    args: {
                        workspace: ctx.workspace ?? null,
                        entityId: ctx.entityId ?? null,
                    },
                    result: err ? 'error' : (result?.isError ? 'error' : 'success'),
                    resultDetail: err
                        ? err.message
                        : (ctx.resultDetailOverride ?? (result?.isError ? 'envelope_error' : undefined)),
                    durationMs: Date.now() - startedAt,
                });
            } catch (logErr) {
                // Audit failures must NEVER fail the tool call. Mirrors
                // the contract in AuditLog.log() — best-effort write.
                console.error(`[audit:withMcpAudit] failed for ${toolName}: ${(logErr as Error).message}`);
            }
        }
    };
}

/**
 * Wrap an HTTP route handler so that every invocation emits exactly
 * one audit row. The handler is called with whatever args it normally
 * takes (req/res/url/deps); the wrapper inspects `res.statusCode`
 * after the handler returns to classify the outcome.
 *
 * extractCtx is called AFTER the handler resolves (or throws) so it
 * can read the parsed body, the resolved workspace, etc. — typically
 * via closure over a shared scratch object the handler writes into.
 */
export interface HttpAuditContext {
    workspace?: string | null;
    entityId?: string | null;
    /** Override status-derived result when the handler returned 200
     *  but the response body indicates a logical failure. */
    resultDetailOverride?: string;
}

export function withHttpAudit<TArgs extends unknown[]>(
    auditLog: AuditLog,
    eventName: string,
    getStatus: (...args: TArgs) => number,
    extractCtx: (args: TArgs, err: Error | null) => HttpAuditContext,
    handler: (...args: TArgs) => Promise<void>,
): (...args: TArgs) => Promise<void> {
    return async (...args: TArgs): Promise<void> => {
        const startedAt = Date.now();
        let err: Error | null = null;
        try {
            await handler(...args);
        } catch (caught) {
            err = caught as Error;
            throw caught;
        } finally {
            try {
                const status = err ? 500 : (getStatus(...args) || 0);
                const ctx = extractCtx(args, err);
                auditLog.log({
                    toolName: eventName,
                    args: {
                        workspace: ctx.workspace ?? null,
                        entityId: ctx.entityId ?? null,
                        status,
                    },
                    result: err
                        ? 'error'
                        : (status >= 200 && status < 300 ? 'success' : 'error'),
                    resultDetail: err
                        ? err.message
                        : (ctx.resultDetailOverride ?? (status >= 400 ? `http_${status}` : undefined)),
                    durationMs: Date.now() - startedAt,
                });
            } catch (logErr) {
                console.error(`[audit:withHttpAudit] failed for ${eventName}: ${(logErr as Error).message}`);
            }
        }
    };
}

/**
 * NW-5b — the authoritative list of write surfaces that MUST be
 * audited. The unit test (`test/nw5b-audit-coverage-unit.ts`) asserts
 * each entry's handler file either imports/uses one of the wrappers
 * above OR calls `auditLog.log(...)` directly. New write routes added
 * without updating this list AND the corresponding handler fail the
 * test — preventing the "added a write, forgot the audit" regression
 * that motivated this fix.
 *
 * Format: tuple of (logical name, absolute repo-relative source path).
 */
export const KNOWN_WRITE_ROUTES: ReadonlyArray<{ name: string; path: string }> = [
    // MCP tools (knowledge-graph mutators)
    { name: 'mcp:store_node',      path: 'packages/lore/src/mcp/tools/memory/storeNode.ts' },
    { name: 'mcp:store_edge',      path: 'packages/lore/src/mcp/tools/memory/storeEdge.ts' },
    { name: 'mcp:delete_node',     path: 'packages/lore/src/mcp/tools/memory/deleteNode.ts' },
    { name: 'mcp:delete_edge',     path: 'packages/lore/src/mcp/tools/memory/deleteEdge.ts' },
    { name: 'mcp:mark_stale',      path: 'packages/lore/src/mcp/tools/memory/markStale.ts' },
    { name: 'mcp:supersede_node',  path: 'packages/lore/src/mcp/tools/memory/supersedeNode.ts' },
    // HTTP write routes
    { name: 'http:post_node',      path: 'packages/lore/src/mcp/http/routes/nodes/postNode.ts' },
    { name: 'http:supersede_node', path: 'packages/lore/src/mcp/http/routes/nodes/supersede.ts' },
    { name: 'http:delete_node',    path: 'packages/lore/src/mcp/http/routes/nodes-delete.ts' },
    { name: 'http:bulk_write',     path: 'packages/lore/src/mcp/http/routes/bulkWrite.ts' },
    { name: 'http:ingestion',     path: 'packages/lore/src/mcp/http/routes/ingestion.ts' },
];
