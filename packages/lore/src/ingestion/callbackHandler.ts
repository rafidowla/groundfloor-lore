/**
 * ingestion/callbackHandler.ts — framework-agnostic handler for the signed
 * processor callback (`POST /api/ingest/callback/:jobId`).
 *
 * Order matters (cheap and safe checks first, nothing trusted before auth):
 *   1. size cap on the wire bytes
 *   2. job lookup — unknown job and bad signature are indistinguishable (401)
 *   3. authentication with the PROCESSOR's configured scheme (never the request's)
 *   4. optional gzip body (ai-api falls back to gzip on 413) decompressed with a hard output cap,
 *      signature tried on wire bytes then on the decompressed bytes
 *   5. policy re-check, state check (idempotent: terminal jobs ack as duplicates)
 *   6. parse + bound the body, requestID must equal the jobId in the URL
 *   7. write results, mark succeeded, record the delivery id
 */
import { gunzipSync } from 'node:zlib';
import { verifyCallback, type VerifyResult } from './callbackAuth.js';
import type { IngestionCoordinator } from './coordinator.js';
import { ProcessorError, type ExtractResult } from './contracts.js';
import { assertProcessorAllowed } from './policy.js';
import { parseExtractCallback, parseStructureCallback } from './processors/callbackParse.js';

export const MAX_CALLBACK_WIRE_BYTES = 8 * 1024 * 1024;
export const MAX_CALLBACK_DECODED_BYTES = 64 * 1024 * 1024;

export interface CallbackResponse { status: number; body: Record<string, unknown> }
const R = (status: number, code: string, extra: Record<string, unknown> = {}): CallbackResponse => ({ status, body: { code, ...extra } });

export async function handleCallback(
    c: IngestionCoordinator,
    req: { jobId: string; headers: Record<string, string | string[] | undefined>; rawBody: Buffer },
): Promise<CallbackResponse> {
    const store = c.deps.store;
    if (req.rawBody.length > MAX_CALLBACK_WIRE_BYTES) return R(413, 'payload_too_large');
    const job = await store.getJob(req.jobId);
    const scheme = job ? c.deps.registry.callbackScheme(job.processorId) : undefined;
    if (!job || !scheme) return R(401, 'unauthorized');

    const now = c.now();
    const ce = String(req.headers['content-encoding'] ?? '').toLowerCase();
    let body = req.rawBody;
    let v: VerifyResult = verifyCallback(scheme, c.deps.callbackAuth, job.jobId, req.headers, body, now);
    if (!v.ok && ce === 'gzip') {
        try {
            body = gunzipSync(req.rawBody, { maxOutputLength: MAX_CALLBACK_DECODED_BYTES });
            v = verifyCallback(scheme, c.deps.callbackAuth, job.jobId, req.headers, body, now);
        } catch { return R(401, 'unauthorized'); }
    } else if (v.ok && ce === 'gzip') {
        try { body = gunzipSync(req.rawBody, { maxOutputLength: MAX_CALLBACK_DECODED_BYTES }); } catch { return R(400, 'bad_encoding'); }
    }
    if (!v.ok) return R(401, 'unauthorized');

    if (job.state === 'succeeded' || job.state === 'dead_letter') return R(200, 'duplicate_ignored');
    if (job.stage === 'extract' && !c.deps.registry.getExtract(job.processorId)) return R(401, 'unauthorized');

    const info = c.deps.registry.info(job.processorId)!;
    try {
        assertProcessorAllowed(job.workspace, await c.deps.policy.policyFor(job.workspace), info);
    } catch (err) {
        await c.fail(job.jobId, (err as Error).message, false);
        return R(403, 'policy_violation');
    }

    let json: unknown;
    try { json = JSON.parse(body.toString('utf8')); } catch {
        await c.fail(job.jobId, 'callback body is not JSON', false);
        return R(400, 'bad_json');
    }
    try {
        if (job.stage === 'extract') {
            const source = await store.getSource(job.workspace, job.sourceId);
            if (!source) throw new ProcessorError('source record missing', false);
            const r: ExtractResult = parseExtractCallback(json, job.jobId, info);
            r.mimeType = source.mimeType;
            await c.completeExtract(job, source, r);
        } else {
            await c.completeStructure(job, parseStructureCallback(json, job.jobId, info));
        }
    } catch (err) {
        const retryable = err instanceof ProcessorError ? err.retryable : true;
        await c.fail(job.jobId, (err as Error).message, retryable);
        // 200 for a processor-reported failure we have recorded (do not make it redeliver a known-bad result);
        // 500 for our own transient problem so a signed redelivery gets another chance.
        return err instanceof ProcessorError ? R(200, 'failure_recorded') : R(500, 'internal_error');
    }
    await store.recordDelivery(job.jobId, v.deliveryId, now);
    return R(200, 'accepted');
}
