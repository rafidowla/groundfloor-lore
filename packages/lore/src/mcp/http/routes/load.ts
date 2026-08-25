/**
 * routes/load.ts — Sprint Z1 streaming-upload endpoint + async job model.
 *
 * Surface:
 *   POST /api/load                  — stream a chunked-transfer body into
 *                                     a temp file, return {job_id}
 *                                     immediately. Z2 will wire substrate-
 *                                     native processing (Z1 only receives
 *                                     and emits a `load.received` outbox
 *                                     notification).
 *   GET  /api/load/jobs/<id>        — read job state.
 *   GET  /api/load/jobs?workspace=X — list recent jobs in workspace.
 *
 * Invariants preserved from prior sprints:
 *   - Sprint L: workspace_required fires BEFORE the backpressure check.
 *   - Sprint O: 503 outbox_lag uses the same writeOutboxBackpressure
 *               helper hot/bulk routes use; same Retry-After header.
 *   - Sprint E: embed mode is one of 'inline' | 'queued' | 'skip',
 *               default 'skip' at bulk-load scale (Z principle clause 8).
 *
 * Z1 SCOPE LIMIT: rows are NOT parsed or written to any substrate. The
 * temp file is staged on disk and a `load.received` outbox row is
 * committed; status stays 'received' forever in Z1. Z2 promotes
 * 'received' → 'running' and drives the row-by-row substrate writes.
 *
 * Body size cap: env LORE_LOAD_MAX_BYTES (default 10 GB). Distinct from
 * MAX_BODY_BYTES (10 MB) which gates all other JSON-body routes — the
 * streaming-upload path needs a much larger ceiling because that's the
 * whole point of Sprint Z.
 *
 * Per-tenant concurrency cap is deferred to Z3 (Z-D9). Z4 will extend
 * backpressure to cover embed-queue saturation in addition to outbox lag.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import {
    writeJson,
    writeError,
    writeWorkspaceRequired,
    extractWorkspace,
    checkOutboxBackpressure,
} from '../helpers.js';
import type { OutboxLagCache } from '../../../outbox/lagCache.js';
import type { OutboxStore, OutboxEntry } from '../../../outbox/types.js';
import type { LoadJobsStore, LoadJobFormat, LoadJobEmbedMode } from '../../../storage/loadJobsStore.js';
import type { WorkspaceConcurrencyManager } from '../../../storage/loadJobsConcurrency.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { bindRouteTarget } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';

/**
 * SP-04 (retry re-sweep) — token-scoped read gate for GET /api/load/jobs,
 * which resolves a caller-supplied workspace and lists that workspace's
 * load-job records. A bound principal requesting a workspace other than its
 * own (or "*") needs cross-workspace-read; null principal = legacy/local
 * bypass. Returns true when it wrote a 4xx (caller must `return true`).
 */
function denyLoadJobsCrossWorkspaceRead(res: ServerResponse, workspace: string): boolean {
    return bindRouteTarget(res, { requested: workspace, intent: 'read' }) === null;
}

/**
 * Sprint Z3 — per-tenant concurrency cap. Default 3 concurrent jobs /
 * workspace (per Sprint Z principle clause 9; override via env
 * LORE_LOAD_MAX_CONCURRENT_PER_WORKSPACE). 4th rejected with HTTP 429
 * + Retry-After header so the client can back off. This constant
 * mirrors DEFAULT_MAX_CONCURRENT_PER_WORKSPACE in loadJobsConcurrency.ts
 * — keeping it here lets the gate test sentinel match against the
 * route file (Z-D9). Retry-After in seconds; tuned for typical 100k
 * load completion time.
 */
export const DEFAULT_TENANT_CONCURRENCY = 3;
const RETRY_AFTER_SECONDS = 30;

// ─── Configuration ──────────────────────────────────────────────────────

/** Default body cap for POST /api/load. 10 GB. Overridable via env. */
export const DEFAULT_LOAD_MAX_BYTES = 10 * 1024 * 1024 * 1024;

function readMaxBytes(): number {
    const raw = process.env['LORE_LOAD_MAX_BYTES'];
    if (!raw) return DEFAULT_LOAD_MAX_BYTES;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_LOAD_MAX_BYTES;
    return n;
}

const ALLOWED_FORMATS = new Set<LoadJobFormat>(['jsonl', 'csv', 'arrow']);
const ALLOWED_EMBED: ReadonlySet<LoadJobEmbedMode> = new Set(['inline', 'queued', 'skip']);

/** Per Sprint Z principle clause 8 — default bulk-load embed is 'skip'. */
const DEFAULT_EMBED_MODE: LoadJobEmbedMode = 'skip';

export interface LoadRouteDeps {
    /** Daemon's lore data directory. Temp files land at
     *  <loreDir>/load-jobs-tmp/<jobId>.<ext>. */
    loreDir: string;
    loadJobsStore: LoadJobsStore;
    /** L-019 — deployment mode for the ReBAC gateRoute check on POST
     *  /api/load (local short-circuits allowed; cloud runs SpiceDB). */
    deploymentMode: 'local' | 'cloud';
    /** L-019 — Dataplane handle used by the ReBAC check. Null in local mode. */
    dataplane: GroundfloorClient | null;
    /** Sprint O outbox — Z1 emits `load.received` on receive-complete. */
    outboxStore?: OutboxStore;
    /** Sprint O4 lag cache — Z1 returns 503 outbox_lag when the
     *  workspace is behind, matching the hot/bulk-write contract. */
    outboxLagCache?: OutboxLagCache;
    /** Sprint Z3 — per-workspace concurrency manager. If supplied,
     *  /api/load checks the cap before creating the job row and
     *  returns 429 + Retry-After when at the limit. */
    concurrencyManager?: WorkspaceConcurrencyManager;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function parseFormat(raw: string | null): LoadJobFormat | null {
    if (!raw) return null;
    const lower = raw.toLowerCase();
    if (ALLOWED_FORMATS.has(lower as LoadJobFormat)) return lower as LoadJobFormat;
    return null;
}

function parseEmbedMode(raw: string | null): LoadJobEmbedMode {
    if (!raw) return DEFAULT_EMBED_MODE;
    const lower = raw.toLowerCase();
    if (ALLOWED_EMBED.has(lower as LoadJobEmbedMode)) return lower as LoadJobEmbedMode;
    return DEFAULT_EMBED_MODE;
}

function tempFileExt(format: LoadJobFormat): string {
    return format === 'arrow' ? '.arrow' : format === 'csv' ? '.csv' : '.jsonl';
}

function ensureTempDir(loreDir: string): string {
    const tmpDir = path.join(loreDir, 'load-jobs-tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
}

interface StreamResult {
    bytesReceived: number;
    overflowed: boolean;
}

/**
 * Stream the request body to disk, capped at `maxBytes`. Returns
 * bytesReceived even when overflow occurs (the caller can then choose
 * to truncate the temp file or report a partial). On overflow we stop
 * writing further chunks but keep draining the socket to let the
 * client close cleanly.
 */
function streamBodyToFile(
    req: IncomingMessage,
    destPath: string,
    maxBytes: number,
    onProgress: (delta: number) => void,
): Promise<StreamResult> {
    return new Promise((resolve, reject) => {
        const out = fs.createWriteStream(destPath);
        let bytesReceived = 0;
        let overflowed = false;
        let finished = false;

        const finishOnce = (result: StreamResult | Error) => {
            if (finished) return;
            finished = true;
            out.end(() => {
                if (result instanceof Error) reject(result);
                else resolve(result);
            });
        };

        req.on('data', (chunk: Buffer) => { // chunked-transfer streaming reader
            if (overflowed) return; // discard tail
            const remaining = maxBytes - bytesReceived;
            if (chunk.length > remaining) {
                if (remaining > 0) {
                    const slice = chunk.subarray(0, remaining);
                    out.write(slice);
                    bytesReceived += slice.length;
                    onProgress(slice.length);
                }
                overflowed = true;
                // SP-12 — stop reading + tear down the socket instead of
                // draining the attacker's remaining bytes off the wire.
                // Resolve immediately with the partial result (the 'end'
                // event won't fire once the socket is destroyed), so the
                // caller still emits its 413. finishOnce is idempotent.
                try { req.pause(); } catch { /* already closing */ }
                finishOnce({ bytesReceived, overflowed: true });
                try { req.destroy(); } catch { /* already destroyed */ }
                return;
            }
            out.write(chunk);
            bytesReceived += chunk.length;
            onProgress(chunk.length);
        });
        req.on('end', () => finishOnce({ bytesReceived, overflowed }));
        req.on('error', (err) => finishOnce(err));
        out.on('error', (err) => finishOnce(err));
    });
}

// ─── Route dispatcher ───────────────────────────────────────────────────

export async function tryLoadRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: LoadRouteDeps,
): Promise<boolean> {
    if (pathname === '/api/load' && req.method === 'POST') {
        return handlePostLoad(req, res, url, deps);
    }
    if (pathname === '/api/load/jobs' && req.method === 'GET') {
        return handleListJobs(req, res, url, deps);
    }
    if (pathname.startsWith('/api/load/jobs/') && req.method === 'GET') {
        const jobId = pathname.slice('/api/load/jobs/'.length);
        return handleGetJob(req, res, jobId, deps);
    }
    return false;
}

// ─── POST /api/load ─────────────────────────────────────────────────────

async function handlePostLoad(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    deps: LoadRouteDeps,
): Promise<boolean> {
    const search = new URL(url, 'http://localhost').searchParams;

    // 1. Sprint L invariant — workspace_required FIRST (before backpressure
    //    check; before any side effect). Z-D7 sentinel regression test
    //    pins this ordering.
    const workspace = extractWorkspace(null, search);
    if (!workspace) {
        writeWorkspaceRequired(res);
        return true;
    }

    // 1.5. L-019 — authorization. POST /api/load stages up to 10 GB to disk +
    //      creates a load_jobs row + emits an outbox row, all destructive
    //      WRITES. Apply BOTH gates immediately after workspace_required and
    //      BEFORE backpressure / concurrency / streaming, so a rejected
    //      request never stages bytes, reserves a slot, or emits outbox.
    //      Mirrors nodes-delete.ts:73-111 / postNode.ts. The read siblings
    //      (handleListJobs) were already gated; the write path was not.
    const gate = await gateRoute(
        { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
        { permission: 'write' },
    );
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
    // Token-scoped write gate. Null principal = legacy/local single-token
    // bypass (every existing Z1-T* test runs with no principal bound).
    if (bindRouteTarget(res, { requested: workspace, intent: 'write' }) === null) return true;

    // 2. Sprint O4 backpressure — 503 outbox_lag if the workspace is
    //    behind. Same helper hot/bulk routes use; same Retry-After.
    //    Sprint Z principle clause 10 + Z-D11 (backpressure check is
    //    REQUIRED before accepting a new load job — silent loss is
    //    not an option). Z1 wires the outbox check; Z4 will extend to
    //    also check embed-queue saturation.
    if (checkOutboxBackpressure(res, workspace, deps.outboxLagCache)) {
        return true;
    }

    // 2.5. Sprint Z3 — per-tenant concurrency cap. Default 3 concurrent
    //      jobs / workspace (DEFAULT_TENANT_CONCURRENCY); the 4th
    //      gets statusCode = 429 + Retry-After + structured body so the
    //      client can back off rather than retry-storm. Per Sprint Z
    //      principle clause 9. The acquire happens AFTER backpressure +
    //      workspace checks so a rejected request never reserves a slot.
    if (deps.concurrencyManager) {
        const acquired = deps.concurrencyManager.tryAcquire(workspace);
        if (!acquired) {
            const cap = deps.concurrencyManager.getCap();
            const current = deps.concurrencyManager.getCount(workspace);
            res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
            writeError(res, 429, 'concurrency_limit',
                `workspace '${workspace}' has reached its concurrent load-job cap (${cap})`,
                { workspace, current, cap, retryAfterSeconds: RETRY_AFTER_SECONDS });
            return true;
        }
    }

    // Helper for early-exit paths to release the concurrency slot if
    // we acquired one above. The runner releases on its own terminal
    // transitions; this path covers route-level failures BEFORE the
    // runner ever sees the job (invalid format, create failure,
    // stream / 413 — the row is marked 'failed' so the runner skips it).
    const releaseSlot = () => {
        if (deps.concurrencyManager) deps.concurrencyManager.release(workspace);
    };

    // 3. Format + embed-mode parsing.
    const formatRaw = search.get('format');
    const format = parseFormat(formatRaw) ?? 'jsonl';
    if (formatRaw && !parseFormat(formatRaw)) {
        releaseSlot();
        writeError(res, 400, 'invalid_format', `format must be one of jsonl|csv|arrow (got ${formatRaw})`);
        return true;
    }
    const embedMode = parseEmbedMode(search.get('embed'));

    // 4. Create the job row + temp file BEFORE streaming so the client
    //    receives a job_id even if their connection drops mid-upload
    //    (the temp file then carries partial bytes and the job stays
    //    'received'; Z3 retention will sweep stale partials).
    const jobId = randomUUID();
    const createdAt = new Date().toISOString();
    const tmpDir = ensureTempDir(deps.loreDir);
    const tempFilePath = path.join(tmpDir, `${jobId}${tempFileExt(format)}`);

    try {
        await deps.loadJobsStore.create({
            jobId,
            workspace,
            format,
            embedMode,
            tempFilePath,
            createdAt,
        });
    } catch (err) {
        releaseSlot();
        writeError(res, 500, 'load_job_create_failed', redactError(err));
        return true;
    }

    // 5. Stream the body to disk. Cap at LORE_LOAD_MAX_BYTES. Progress
    //    is reported as additive bytes_received updates so a polling
    //    client can watch the upload advance. (Z1 batches every ~64KB
    //    of progress to keep the SQLite update rate sane.)
    const maxBytes = readMaxBytes();
    let bufferedDelta = 0;
    const PROGRESS_FLUSH_BYTES = 64 * 1024;
    const flushProgress = () => {
        if (bufferedDelta === 0) return;
        const d = bufferedDelta;
        bufferedDelta = 0;
        // Fire-and-forget — the DB call is fast (single UPDATE on PK)
        // but we don't want to await per-chunk and serialize the
        // upload through SQLite.
        void deps.loadJobsStore.incrementBytesReceived(jobId, d);
    };

    let streamResult: StreamResult;
    try {
        streamResult = await streamBodyToFile(
            req,
            tempFilePath,
            maxBytes,
            (delta) => {
                bufferedDelta += delta;
                if (bufferedDelta >= PROGRESS_FLUSH_BYTES) flushProgress();
            },
        );
        flushProgress();
    } catch (err) {
        // Network / disk error mid-stream. Mark the job failed and
        // surface 500. The temp file may be a partial; Z3 sweeper.
        await deps.loadJobsStore.updateStatus(jobId, 'failed', {
            completedAt: new Date().toISOString(),
        });
        releaseSlot();
        writeError(res, 500, 'load_stream_failed', redactError(err), { job_id: jobId });
        return true;
    }

    // Final byte-count reconciliation — flushProgress above may have
    // been short by the in-flight buffered delta. Explicitly assert
    // the persisted row matches the streamed total.
    const job = await deps.loadJobsStore.get(jobId);
    if (job && job.bytesReceived !== streamResult.bytesReceived) {
        const reconcileDelta = streamResult.bytesReceived - job.bytesReceived;
        if (reconcileDelta > 0) {
            await deps.loadJobsStore.incrementBytesReceived(jobId, reconcileDelta);
        }
    }

    // 6. Body cap exceeded — 413 with the job_id (so the client can
    //    inspect the partial via GET /api/load/jobs/<id>). The temp
    //    file holds the partial body up to maxBytes.
    if (streamResult.overflowed) {
        await deps.loadJobsStore.updateStatus(jobId, 'failed', {
            completedAt: new Date().toISOString(),
        });
        releaseSlot();
        writeError(res, 413, 'payload_too_large',
            `request body exceeded ${maxBytes} bytes`,
            { job_id: jobId, maxBytes, bytesReceived: streamResult.bytesReceived });
        return true;
    }

    // 7. Emit the `load.received` outbox notification. Z2 will add a
    //    handler that picks this up and drives the substrate fan-out;
    //    in Z1 the entry is a no-op marker (the dispatcher case in
    //    outbox/dispatcher.ts returns immediately, advancing the row
    //    to 'replicated' without side effect).
    if (deps.outboxStore) {
        try {
            const entry: OutboxEntry = {
                id: `load.received-${jobId}`,
                operation: 'load.received',
                initiator: 'http:POST /api/load',
                createdAt,
                updatedAt: createdAt,
                steps: [],
                completed: false,
                workspace,
                operationKind: 'load.received',
                payload: {
                    jobId,
                    workspace,
                    format,
                    embedMode,
                    tempFilePath,
                    bytesReceived: streamResult.bytesReceived,
                },
                status: 'pending',
                attempts: 0,
            };
            await deps.outboxStore.record(entry);
        } catch (err) {
            // Non-fatal: the row is durable on disk + tracked in
            // load_jobs. The outbox notification is what Z2's handler
            // will consume; without it Z2 would need to scan load_jobs
            // for 'received' rows on a tick, which is an acceptable
            // fallback. Log + continue.
            console.error(`[Lore HTTP] /api/load: outbox record failed for ${jobId}: ${(err as Error).message}`);
        }
    }

    writeJson(res, 200, {
        job_id: jobId,
        workspace,
        format,
        embed: embedMode,
        status: 'received',
        bytesReceived: streamResult.bytesReceived,
        createdAt,
    });
    return true;
}

// ─── GET /api/load/jobs/<id> ────────────────────────────────────────────

async function handleGetJob(
    _req: IncomingMessage,
    res: ServerResponse,
    jobId: string,
    deps: LoadRouteDeps,
): Promise<boolean> {
    if (!jobId || jobId.includes('/')) {
        writeError(res, 400, 'invalid_job_id', 'job_id must be a non-empty path segment');
        return true;
    }
    const job = await deps.loadJobsStore.get(jobId);
    if (!job) {
        writeError(res, 404, 'load_job_not_found', `no load job with id ${jobId}`);
        return true;
    }
    // L-049/L-050 — scope the single-job GET to the caller's workspace, the
    // same way the LIST route does. Without this a bound principal could read
    // another workspace's job record (and its error[] / row counts). The
    // helper no-ops for a null/local principal. Checked AFTER the 404 so a
    // missing id stays a 404 (doesn't leak existence via a 403).
    if (denyLoadJobsCrossWorkspaceRead(res, job.workspace)) return true;
    writeJson(res, 200, {
        job_id: job.jobId,
        workspace: job.workspace,
        format: job.format,
        embed: job.embedMode,
        status: job.status,
        // Per Sprint Z principle clause 5 — rowsProcessed + rowsFailed
        // + errors[] are part of the polling contract. Z1 surfaces
        // them at their initial zero values; Z2 starts incrementing
        // rowsProcessed and Z3 starts populating rowsFailed + errors.
        rowsReceived: job.rowsReceived,
        rowsProcessed: job.rowsProcessed,
        rowsFailed: job.rowsFailed,
        errors: job.errors,
        bytesReceived: job.bytesReceived,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
    });
    return true;
}

// ─── GET /api/load/jobs?workspace=X ─────────────────────────────────────

async function handleListJobs(
    _req: IncomingMessage,
    res: ServerResponse,
    url: string,
    deps: LoadRouteDeps,
): Promise<boolean> {
    const search = new URL(url, 'http://localhost').searchParams;
    const workspace = extractWorkspace(null, search);
    if (!workspace) {
        writeWorkspaceRequired(res);
        return true;
    }
    if (denyLoadJobsCrossWorkspaceRead(res, workspace)) return true;
    const limitRaw = search.get('limit');
    const limit = limitRaw ? Math.max(1, Math.min(Number.parseInt(limitRaw, 10) || 50, 500)) : 50;
    const jobs = await deps.loadJobsStore.list(workspace, limit);
    writeJson(res, 200, {
        workspace,
        count: jobs.length,
        jobs: jobs.map((j) => ({
            job_id: j.jobId,
            workspace: j.workspace,
            format: j.format,
            embed: j.embedMode,
            status: j.status,
            rowsReceived: j.rowsReceived,
            rowsProcessed: j.rowsProcessed,
            rowsFailed: j.rowsFailed,
            bytesReceived: j.bytesReceived,
            createdAt: j.createdAt,
            startedAt: j.startedAt,
            completedAt: j.completedAt,
        })),
    });
    return true;
}
