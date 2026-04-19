/**
 * consent.ts — Approval gate for high-impact tool calls (Phase 4 / C6).
 *
 * What this is:
 *   A promise-based registry of pending approvals. When a tool flagged
 *   `requiresApproval: true` gets called, the server calls
 *   consent.request(), which returns a Promise that resolves when the
 *   user either approves (via POST /api/approval/:id) or the timeout
 *   fires (auto-deny).
 *
 *   The tool's execution path awaits that Promise before doing the work.
 *   If the user denies, the tool call returns an audit-logged "denied
 *   by user" error without touching the graph.
 *
 * Why:
 *   Even with S7's prompt-side mitigations, a motivated injection can
 *   get the LLM to issue a destructive tool call. Consent is the
 *   last-line defense: the user gets a modal ("Agent wants to delete
 *   node X. [Approve] [Deny]") before anything destructive happens.
 *
 * Design notes:
 *   - The server emits SSE `approval_needed` on the chat stream so the
 *     UI can render a modal mid-stream. For non-chat tool callers
 *     (CLI, direct HTTP), the CLI prints a prompt and calls /api/
 *     approval/:id programmatically.
 *   - Approval IDs are UUIDs. Not meant to be secret — the caller
 *     already authenticated. IDs just route the response back to the
 *     right waiter.
 *   - Default timeout: 60 seconds. Long enough for a human; short
 *     enough that a forgotten approval doesn't park an LLM session.
 *   - On daemon shutdown, all pending approvals reject with "daemon
 *     shutting down" so callers can fail cleanly.
 *
 * Scope:
 *   - Registry + resolve API here.
 *   - Tool-registration flag (`requiresApproval: true`) + pre-execute
 *     hook wired in server.ts.
 *   - HTTP endpoint POST /api/approval/:id in server.ts.
 *   - SSE event in /api/chat when chat-initiated tool needs approval.
 *   - UI modal: follow-up (the API exists for Phase 5 Personal-plugin).
 */

import { randomUUID } from 'node:crypto';

export interface PendingApproval {
    id: string;
    toolName: string;
    args: unknown;
    requestedAt: string;
    /** Epoch ms when this approval auto-denies. */
    timeoutAt: number;
    /** Any context the UI should render (e.g. warnings, summary). */
    context?: string;
}

interface PendingInternal extends PendingApproval {
    resolve: (result: { approved: boolean; reason?: string }) => void;
    timeoutHandle: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class ConsentManager {
    private readonly pending = new Map<string, PendingInternal>();

    /**
     * request — register a new approval and return the id + a Promise
     * the caller awaits.
     *
     * The Promise resolves when either (a) HTTP approval lands or
     * (b) timeout fires. Rejection is reserved for catastrophic errors
     * like shutdown; under normal flow the Promise always resolves
     * with `{approved: boolean, reason?}`.
     */
    request(
        toolName: string,
        args: unknown,
        opts: { timeoutMs?: number; context?: string } = {},
    ): { id: string; wait: Promise<{ approved: boolean; reason?: string }>; snapshot: PendingApproval } {
        const id = randomUUID();
        const requestedAt = new Date().toISOString();
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timeoutAt = Date.now() + timeoutMs;

        const wait = new Promise<{ approved: boolean; reason?: string }>((resolve) => {
            const timeoutHandle = setTimeout(() => {
                if (this.pending.delete(id)) {
                    resolve({ approved: false, reason: 'timeout' });
                }
            }, timeoutMs);
            this.pending.set(id, {
                id,
                toolName,
                args,
                requestedAt,
                timeoutAt,
                context: opts.context,
                resolve,
                timeoutHandle,
            });
        });

        const snapshot: PendingApproval = {
            id, toolName, args, requestedAt, timeoutAt, context: opts.context,
        };
        return { id, wait, snapshot };
    }

    /**
     * resolve — called by the HTTP handler when the user submits a
     * decision. Returns true if the approval was found and resolved;
     * false if it didn't exist (already timed out or bad id).
     */
    resolve(id: string, approved: boolean, reason?: string): boolean {
        const entry = this.pending.get(id);
        if (!entry) return false;
        clearTimeout(entry.timeoutHandle);
        this.pending.delete(id);
        entry.resolve({ approved, reason });
        return true;
    }

    /** List currently-pending approvals — drives the UI "pending" panel. */
    list(): PendingApproval[] {
        return Array.from(this.pending.values()).map(({ id, toolName, args, requestedAt, timeoutAt, context }) => ({
            id, toolName, args, requestedAt, timeoutAt, context,
        }));
    }

    /**
     * shutdown — resolve every pending approval as denied with reason
     * 'shutdown'. Called when the daemon stops to avoid leaving callers
     * awaiting a resolved-never Promise.
     */
    shutdown(): void {
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timeoutHandle);
            entry.resolve({ approved: false, reason: 'shutdown' });
        }
        this.pending.clear();
    }
}
