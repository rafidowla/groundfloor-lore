/**
 * sweepAbort.ts — the response an ABORTED graph sweep gets.
 *
 * One concern: what `/api/graph/reconnect` and `/api/graph/reconsume` do when
 * `reconnectGraph` comes back with `aborted: true`. Extracted from
 * `ingestion.ts` (at the 800-line cap, see CLAUDE.md's file-size budget) and
 * worth its own module anyway, because both routes must answer identically and
 * the previous copy-per-route answered "HTTP 200, audit `success`" on both.
 *
 * ─── Why an abort is not a success ───────────────────────────────────────
 *
 * `shouldAbort` stops the sweep at a page boundary, mid-corpus, and
 * `reconnectGraph` then skips the entire edge-application phase (prune +
 * insert against handles about to close is how edges get lost). So an aborted
 * run has scanned page 1 of N and applied NOTHING. Reporting 200 + `result:
 * 'success'` told the operator their explicit "rebuild my edges" call had
 * happened when it had not — the same hollow success the never-started
 * (`runTracked` returned null) branch already refuses to report with its 503.
 *
 * The 503 also has to be visible to the CURSOR decision, which is the part
 * that actually loses data: `/api/graph/reconnect` writes
 * `<ws>/.lore/reconnect.state.json` with `lastReconnectAt = now`, and the next
 * `incremental: true` run resolves `since` from it. Stamping it after an
 * aborted sweep makes every future incremental run filter to
 * `updatedAt > <abort time>` — so every node the sweep never reached is
 * skipped forever, with no error and no log. That is strictly worse than the
 * use-after-close the abort path replaced: that lost edges RECOVERABLY (a
 * later `reconnect` rebuilt them); this makes the recovery tool itself skip
 * them. A cursor may only advance over ground the sweep actually covered.
 *
 * License: original work for groundfloor-lore.
 */

import type { ServerResponse } from 'node:http';
import type { AuditLog } from '../../../security/audit.js';
import { writeError } from '../helpers.js';

interface AbortedSweep {
    candidatesScanned: number;
    coreEdgesInserted: number;
    applied: boolean;
}

/**
 * Audit the abort as an error and answer 503. `cursorNote` is appended to the
 * operator-facing message by the one route that keeps a cursor.
 */
export function writeSweepAborted(
    res: ServerResponse,
    auditLog: AuditLog,
    opts: {
        toolName: 'graph.reconnect' | 'graph.reconsume';
        code: 'reconnect_aborted' | 'reconsume_aborted';
        args: Record<string, unknown>;
        approvalId?: string;
        durationMs: number;
        result: AbortedSweep;
        cursorNote?: string;
    },
): void {
    const { toolName, code, args, approvalId, durationMs, result, cursorNote } = opts;
    auditLog.log({
        toolName,
        args,
        result: 'error',
        resultDetail: `aborted mid-sweep (shutdown in progress) after ${result.candidatesScanned} node(s); no edges applied${cursorNote ? '; cursor NOT advanced' : ''}`,
        ...(approvalId ? { approvalId } : {}),
        durationMs,
    });
    writeError(
        res, 503, code,
        `Lore began shutting down mid-sweep; the rebuild stopped early and applied nothing.${cursorNote ? ` ${cursorNote}` : ''} Re-run after restart.`,
        {
            aborted: true,
            candidatesScanned: result.candidatesScanned,
            coreEdgesInserted: result.coreEdgesInserted,
            applied: result.applied,
        },
    );
}
