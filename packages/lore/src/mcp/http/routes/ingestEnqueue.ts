/**
 * ingestEnqueue.ts - admin surface that submits a file to the ingestion coordinator and reads a job back.
 *
 *   POST /api/admin/ingest/enqueue                       submit one file (JSON body, file bytes base64-encoded)
 *   GET  /api/admin/ingest/jobs/<jobId>?workspace=<ws>   state of one job
 *
 * Operator-only, same lane as the link rebuild and the retention sweep: gateRoute (cloud ReBAC; no-op locally),
 * bindDaemonOperatorLane, then requireOperatorForBoundActor. The route sits behind the main dispatcher's gates
 * (localhost Host check, bearer, principal, rate limit), none of which are loosened. A hosted processor never
 * reaches this: it calls back on the separate listener.
 *
 * POST body (application/json):
 *   workspace      required, explicit. Must be a registered workspace that this host ingests; never defaulted.
 *   fileName       required, a bare file name (no path separators, no control characters), at most 255 bytes.
 *   mimeType       required, `type/subtype`.
 *   contentBase64  required, the file bytes, standard base64. Decoded size is capped by LORE_INGEST_ENQUEUE_MAX_BYTES
 *                  (default 25 MiB); a declared Content-Length above the matching wire size gets 413 before any read.
 *   structure      optional StructureSpec ({processorId, profile, outputSchema, itemPath, itemKey, sourceRefs,
 *                  reviewThreshold, instructions, tableName}); unknown keys are refused.
 *   extractorId    optional, pins the extractor.
 *
 * JSON + base64 (not raw bytes) so the file name and structure spec never ride in the URL, where access logs and
 * proxies record them. Cost: about a third more on the wire, and the reader below is bounded to that size.
 *
 * Responses: 202 {jobId, sourceId, created:true, state} for a new job, 200 with created:false for a duplicate (same
 * bytes + same options). Every error is a fixed {code, message}; exception text is never returned.
 *   400 workspace_required | invalid_workspace | invalid_json_body | invalid_file_name | invalid_mime_type |
 *       invalid_file_content | invalid_structure | invalid_job_id
 *   403 operator-only / workspace_forbidden      404 ingestion_unavailable | workspace_not_found | job_not_found
 *   409 ingestion_workspace_not_enabled          413 payload_too_large
 *   422 ingest_policy_violation | ingest_no_processor
 *   500 internal_error                           503 ingest_busy | ingestion_unavailable (host stopping or store unopenable)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import { gateRoute } from '../../../security/routeGate.js';
import { bindDaemonOperatorLane } from '../../../security/routeWorkspaceBinding.js';
import { requireOperatorForBoundActor } from '../../../security/exportGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { writeError, writeJson, writeWorkspaceRequired, parseJsonBody, isInvalidJsonBody } from '../helpers.js';
import {
    PAYLOAD_TOO_LARGE, WORKSPACE_NOT_FOUND, INGEST_UNAVAILABLE, INGEST_WORKSPACE_NOT_ENABLED, INGEST_POLICY_VIOLATION,
    INGEST_NO_PROCESSOR, INGEST_BUSY, INGEST_JOB_NOT_FOUND, INVALID_WORKSPACE, INVALID_FILE_NAME, INVALID_MIME_TYPE,
    INVALID_FILE_CONTENT, INVALID_STRUCTURE, INVALID_JOB_ID,
} from '../errorCodes.js';
import { PolicyViolationError } from '../../../ingestion/policy.js';
import { NoProcessorError } from '../../../ingestion/registry.js';
import type { EnqueueFileArgs, StructureSpec } from '../../../ingestion/coordinator.js';
import type { IngestionHost } from '../../../ingestion/ingestionHost.js';
import { log } from '../../../logger.js';

export interface IngestEnqueueDeps {
    /** The running ingestion host, or null when ingestion is off. Read per request (the host can stop). */
    getIngestionHost: () => IngestionHost | null;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
}

const ENQUEUE_PATH = '/api/admin/ingest/enqueue';
const JOB_PATH = /^\/api\/admin\/ingest\/jobs\/([^/]+)$/;
/** Room for the JSON envelope around the base64 string (workspace, names, a structure spec with a schema). */
const ENVELOPE_SLACK_BYTES = 256 * 1024;
/** Requests allowed to hold file bytes in memory at once; the next one gets 503 + Retry-After. */
export const MAX_INFLIGHT_ENQUEUES = 4;
const RETRY_AFTER_S = 5;
const MAX_NAME_BYTES = 255;
const MAX_WORKSPACE_CHARS = 200;
const JOB_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// Path separators, NUL and every other control character, plus bidi overrides (display spoofing of file names).
// eslint-disable-next-line no-control-regex
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f/\\‪-‮⁦-⁩]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const STRUCTURE_KEYS = new Set(['processorId', 'profile', 'outputSchema', 'itemPath', 'itemKey', 'sourceRefs', 'reviewThreshold', 'instructions', 'tableName']);

let inflight = 0;
/** Test seam: the live in-flight count (must be 0 once every request has finished). */
export function inflightEnqueues(): number { return inflight; }

function errClass(e: unknown): string { return e instanceof Error ? e.constructor.name : typeof e; }

/** Wire size (bytes of the JSON body) that a file of `maxBytes` can legitimately need. */
export function wireCapFor(maxBytes: number): number { return Math.ceil(maxBytes / 3) * 4 + ENVELOPE_SLACK_BYTES; }

class WireTooLarge extends Error { constructor() { super('wire cap exceeded'); this.name = 'WireTooLarge'; } }

function readCapped(req: IncomingMessage, cap: number): Promise<string> {
    return new Promise((resolve, reject) => {
        let bytes = 0; let done = false;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer | string) => {
            if (done) return;
            const b = typeof c === 'string' ? Buffer.from(c) : c;
            bytes += b.length;
            if (bytes > cap) {
                done = true; chunks.length = 0;
                try { req.pause(); } catch { /* already closing */ }
                reject(new WireTooLarge());
                return;
            }
            chunks.push(b);
        });
        req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
        req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
}

function writeTooLarge(res: ServerResponse, req: IncomingMessage, maxBytes: number): void {
    res.writeHead(413, { 'Content-Type': 'application/json', 'Connection': 'close' });
    res.end(JSON.stringify({ code: PAYLOAD_TOO_LARGE, message: 'file exceeds the ingestion enqueue size limit', maxBytes }));
    // Stop reading the rest of the upload once the 413 has flushed.
    const t = setImmediate(() => { try { req.destroy(); } catch { /* already destroyed */ } });
    if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
}

/** A workspace value from the body or the query. Shape only; registration is checked against the host. */
function workspaceShape(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const w = v.trim();
    return w.length > 0 && w.length <= MAX_WORKSPACE_CHARS && !CONTROL_CHARS.test(w) ? w : null;
}

/** Resolves the workspace to an enabled one or writes the answer. Returns the workspace name, or null when it answered. */
function requireEnabledWorkspace(res: ServerResponse, host: IngestionHost, raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') { writeWorkspaceRequired(res); return null; }
    const ws = workspaceShape(raw);
    if (!ws) { writeError(res, 400, INVALID_WORKSPACE, "'workspace' must be a workspace name"); return null; }
    const state = host.workspaceState(ws);
    if (state === 'unknown') { writeError(res, 404, WORKSPACE_NOT_FOUND, 'workspace is not registered'); return null; }
    if (state === 'not_enabled') { writeError(res, 409, INGEST_WORKSPACE_NOT_ENABLED, 'workspace is not enabled for ingestion on this host'); return null; }
    return ws;
}

function validFileName(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0 && v !== '.' && v !== '..'
        && Buffer.byteLength(v, 'utf8') <= MAX_NAME_BYTES && v.trim() === v && !BAD_NAME_CHARS.test(v);
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !CONTROL_CHARS.test(v);

/** Validates a structure spec field by field. Returns the clean spec or null. Unknown keys are refused, never passed on. */
function parseStructure(v: unknown): StructureSpec | null {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!STRUCTURE_KEYS.has(k)) return null;
    if (!str(o['processorId'], 200)) return null;
    const out: StructureSpec = { processorId: o['processorId'] };
    for (const k of ['profile', 'itemPath', 'tableName'] as const) {
        if (o[k] === undefined) continue;
        if (!str(o[k], 200)) return null;
        out[k] = o[k] as string;
    }
    if (o['instructions'] !== undefined) {
        // Free text for the structurer: newlines are legitimate, so only the length is bounded.
        if (typeof o['instructions'] !== 'string' || o['instructions'].length > 8_000) return null;
        out.instructions = o['instructions'];
    }
    if (o['itemKey'] !== undefined) {
        const k = o['itemKey'];
        if (!Array.isArray(k) || k.length === 0 || k.length > 20 || !k.every((x) => str(x, 200))) return null;
        out.itemKey = k as string[];
    }
    if (o['sourceRefs'] !== undefined) { if (typeof o['sourceRefs'] !== 'boolean') return null; out.sourceRefs = o['sourceRefs']; }
    if (o['reviewThreshold'] !== undefined) {
        const t = o['reviewThreshold'];
        if (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > 1) return null;
        out.reviewThreshold = t;
    }
    if (o['outputSchema'] !== undefined) {
        const s = o['outputSchema'];
        if (typeof s !== 'object' || s === null || Array.isArray(s)) return null;
        out.outputSchema = s as Record<string, unknown>;
    }
    return out;
}

/** Decoded byte length of a validated base64 string. */
function decodedLength(b64: string): number {
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    return (b64.length / 4) * 3 - pad;
}

async function handleEnqueue(req: IncomingMessage, res: ServerResponse, host: IngestionHost): Promise<void> {
    const maxBytes = host.enqueueMaxBytes();
    const wireCap = wireCapFor(maxBytes);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > wireCap) { writeTooLarge(res, req, maxBytes); return; }
    if (inflight >= MAX_INFLIGHT_ENQUEUES) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(RETRY_AFTER_S), 'Connection': 'close' });
        res.end(JSON.stringify({ code: INGEST_BUSY, message: 'too many ingestion uploads in progress; retry shortly', retryAfterSec: RETRY_AFTER_S }));
        const t = setImmediate(() => { try { req.destroy(); } catch { /* already destroyed */ } });
        if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
        return;
    }
    inflight++;
    try {
        let text: string;
        try { text = await readCapped(req, wireCap); } catch (err) {
            if (err instanceof WireTooLarge) { writeTooLarge(res, req, maxBytes); return; }
            writeError(res, 400, 'invalid_json_body', 'request body could not be read'); return;
        }
        let body: Record<string, unknown>;
        try {
            const parsed = parseJsonBody(text);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) { writeError(res, 400, 'invalid_json_body', 'request body must be a JSON object'); return; }
            body = parsed as Record<string, unknown>;
        } catch (err) {
            if (isInvalidJsonBody(err)) { writeError(res, 400, 'invalid_json_body', 'request body is not valid JSON'); return; }
            throw err;
        }
        text = '';

        const workspace = requireEnabledWorkspace(res, host, body['workspace']);
        if (!workspace) return;
        const fileName = body['fileName'];
        if (!validFileName(fileName)) { writeError(res, 400, INVALID_FILE_NAME, `'fileName' must be a bare file name (no path separators or control characters, at most ${MAX_NAME_BYTES} bytes)`); return; }
        const mimeType = body['mimeType'];
        if (typeof mimeType !== 'string' || !MIME_RE.test(mimeType)) { writeError(res, 400, INVALID_MIME_TYPE, "'mimeType' must look like type/subtype"); return; }
        let structure: StructureSpec | undefined;
        if (body['structure'] !== undefined) {
            const s = parseStructure(body['structure']);
            if (!s) { writeError(res, 400, INVALID_STRUCTURE, "'structure' is not a valid structure spec"); return; }
            structure = s;
        }
        let extractorId: string | undefined;
        if (body['extractorId'] !== undefined) {
            if (!str(body['extractorId'], 200)) { writeError(res, 400, INVALID_STRUCTURE, "'extractorId' must be a processor id"); return; }
            extractorId = body['extractorId'];
        }
        const b64 = body['contentBase64'];
        if (typeof b64 !== 'string' || b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
            writeError(res, 400, INVALID_FILE_CONTENT, "'contentBase64' must be the file bytes as standard base64"); return;
        }
        if (decodedLength(b64) > maxBytes) { writeTooLarge(res, req, maxBytes); return; }
        const bytes = Buffer.from(b64, 'base64');
        body['contentBase64'] = '';

        let co;
        try { co = await host.coordinatorFor(workspace); } catch (err) {
            log.warn(`[Ingest] enqueue: workspace could not be opened (${errClass(err)})`);
            writeError(res, 503, INGEST_UNAVAILABLE, 'ingestion is not available for this workspace right now'); return;
        }
        const args: EnqueueFileArgs = { workspace, fileName, mimeType, bytes, ...(structure ? { structure } : {}), ...(extractorId ? { extractorId } : {}) };
        try {
            const { job, created } = await co.enqueueFile(args);
            writeJson(res, created ? 202 : 200, { jobId: job.jobId, sourceId: job.sourceId, created, state: job.state });
        } catch (err) {
            if (err instanceof PolicyViolationError) writeError(res, 422, INGEST_POLICY_VIOLATION, 'workspace policy does not allow the requested processor');
            else if (err instanceof NoProcessorError) writeError(res, 422, INGEST_NO_PROCESSOR, 'no processor is available for this file type or the requested structurer');
            else throw err;
        }
    } catch (err) {
        log.error(`[Ingest] enqueue failed (${errClass(err)})`);
        writeError(res, 500, 'internal_error', 'ingestion enqueue failed');
    } finally {
        inflight--;
    }
}

async function handleJobStatus(res: ServerResponse, host: IngestionHost, url: string, rawId: string): Promise<void> {
    let jobId: string;
    try { jobId = decodeURIComponent(rawId); } catch { writeError(res, 400, INVALID_JOB_ID, "job id is not valid"); return; }
    if (!JOB_ID_RE.test(jobId)) { writeError(res, 400, INVALID_JOB_ID, 'job id is not valid'); return; }
    const workspace = requireEnabledWorkspace(res, host, new URL(url, 'http://x').searchParams.get('workspace') ?? undefined);
    if (!workspace) return;
    try {
        let co;
        try { co = await host.coordinatorFor(workspace); } catch (err) {
            log.warn(`[Ingest] job status: workspace could not be opened (${errClass(err)})`);
            writeError(res, 503, INGEST_UNAVAILABLE, 'ingestion is not available for this workspace right now'); return;
        }
        const job = await co.deps.store.getJob(jobId);
        // A job id from another workspace is "not found" here: the lookup is bound to the named workspace.
        if (!job || job.workspace !== workspace) { writeError(res, 404, INGEST_JOB_NOT_FOUND, 'no such job in this workspace'); return; }
        // lastError is processor-supplied text; only whether one exists is returned.
        writeJson(res, 200, { job: {
            jobId: job.jobId, workspace: job.workspace, sourceId: job.sourceId, stage: job.stage, processorId: job.processorId,
            state: job.state, attempts: job.attempts, maxAttempts: job.maxAttempts, nextAttemptAt: job.nextAttemptAt,
            hasError: job.lastError !== null, parentJobId: job.parentJobId, createdAt: job.createdAt, updatedAt: job.updatedAt, completedAt: job.completedAt,
        } });
    } catch (err) {
        log.error(`[Ingest] job status failed (${errClass(err)})`);
        writeError(res, 500, 'internal_error', 'ingestion job lookup failed');
    }
}

export async function tryIngestEnqueueRoutes(
    req: IncomingMessage, res: ServerResponse, url: string, pathname: string, deps: IngestEnqueueDeps,
): Promise<boolean> {
    const isEnqueue = pathname === ENQUEUE_PATH && req.method === 'POST';
    const jobMatch = req.method === 'GET' ? JOB_PATH.exec(pathname) : null;
    if (!isEnqueue && !jobMatch) return false;

    const gate = await gateRoute({ deploymentMode: deps.deploymentMode, dataplane: deps.dataplane }, { permission: isEnqueue ? 'write' : 'read' });
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
    if (!bindDaemonOperatorLane(res, { intent: isEnqueue ? 'write' : 'read' })) return true;
    if (!requireOperatorForBoundActor(res, 'Ingestion enqueue')) return true;

    const host = deps.getIngestionHost();
    if (!host) { writeError(res, 404, INGEST_UNAVAILABLE, 'ingestion is not enabled on this host'); return true; }

    if (isEnqueue) await handleEnqueue(req, res, host);
    else await handleJobStatus(res, host, url, jobMatch![1]!);
    return true;
}
