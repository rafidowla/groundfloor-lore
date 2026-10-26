/**
 * reviewShared.ts - request plumbing shared by the review routes (table review queue + link proposals).
 *
 * Two permissions, one pattern:
 *   VIEW (GET)  -> the ordinary `read` scope, workspace-bound via bindRouteTarget({intent:'read'}).
 *   ACT  (POST/DELETE) -> the `review` scope, bindRouteTarget({intent:'review'}). `write` does NOT imply it.
 * Acting on another workspace needs `cross-workspace-write` on top; viewing needs `cross-workspace-read`.
 * Nothing here reads a workspace from anywhere but the request's `workspace` param (query or body); an absent
 * param binds to the token's own workspace, never to the daemon's active one.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getCurrentPrincipal } from '../../../auth/principal.js';
import { bindRouteTarget, isLegacyBypass } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';
import {
    readBoundedBody, parseJsonBody, isInvalidJsonBody, writeInvalidJson, isPayloadTooLarge, writeOversizeError, writeError,
} from '../helpers.js';

/** Review request bodies are small (an id, a corrected value, a note); anything past this is refused with 413. */
export const REVIEW_BODY_MAX_BYTES = 64 * 1024;
/** Page size defaults and ceiling for every review list endpoint. */
export const REVIEW_DEFAULT_LIMIT = 50;
export const REVIEW_MAX_LIMIT = 200;
const WORKSPACE_MAX = 200;

export type ReviewIntent = 'read' | 'review';

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
}

/** The reviewer recorded on every decision: derived from the authenticated principal, never from the request body. */
export function reviewerIdentity(): string {
    const p = getCurrentPrincipal();
    return p ? `${p.kind}:${p.label}`.slice(0, 256) : 'local';
}

/** A workspace param: undefined when absent, null when present but invalid. */
export function parseWorkspaceParam(v: unknown): string | undefined | null {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length === 0 || t.length > WORKSPACE_MAX ? null : t;
}

/**
 * Bind the request to its workspace under `intent`. Returns the workspace, or null after writing the denial/4xx
 * (the caller must return true). `requested` undefined binds to the token's own workspace.
 */
export function bindReviewWorkspace(res: ServerResponse, rawRequested: unknown, intent: ReviewIntent): string | null {
    const requested = parseWorkspaceParam(rawRequested);
    if (requested === null) {
        writeError(res, 400, 'invalid_workspace', `'workspace' must be a non-empty string of at most ${WORKSPACE_MAX} characters`);
        return null;
    }
    if (requested === '*') {
        writeError(res, 403, 'workspace_forbidden', 'workspace "*" is not valid on review routes');
        return null;
    }
    // Off-HTTP legacy bypass (no principal, no binding slot, no param): nothing to confine and no workspace to act on.
    // Detected up front so any later null is unambiguously a denial that already wrote its 4xx.
    if (isLegacyBypass(requested)) { writeError(res, 400, 'workspace_required', "a 'workspace' is required"); return null; }
    return bindRouteTarget(res, { requested, intent });
}

/** An integer query param within [min,max]; undefined when absent, null (after a 400) when invalid. */
export function intParam(res: ServerResponse, sp: URLSearchParams, name: string, min: number, max: number): number | undefined | null {
    const raw = sp.get(name);
    if (raw === null || raw === '') return undefined;
    if (!/^\d{1,9}$/.test(raw)) { writeError(res, 400, `invalid_${name}`, `'${name}' must be an integer ${min}..${max}`); return null; }
    const n = Number(raw);
    if (n < min || n > max) { writeError(res, 400, `invalid_${name}`, `'${name}' must be an integer ${min}..${max}`); return null; }
    return n;
}

/** Read + parse a bounded JSON object body (an empty body is `{}`). Returns null after writing the 4xx. */
export async function readReviewBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
    let text: string;
    try { text = await readBoundedBody(req, REVIEW_BODY_MAX_BYTES); } catch (err) {
        if (isPayloadTooLarge(err)) { writeOversizeError(res, req, REVIEW_BODY_MAX_BYTES); return null; }
        writeError(res, 400, 'invalid_json_body', redactError(err));
        return null;
    }
    if (text.trim() === '') return {};
    try {
        const parsed = parseJsonBody(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            writeError(res, 400, 'invalid_body', 'request body must be a JSON object');
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch (err) {
        if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return null; }
        writeError(res, 500, 'internal_error', redactError(err));
        return null;
    }
}

/** Optional string field with a length cap; undefined when absent, null (after a 400) when invalid. */
export function optionalString(res: ServerResponse, body: Record<string, unknown>, name: string, max: number): string | undefined | null {
    const v = body[name];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string' || v.length > max) { writeError(res, 400, `invalid_${name}`, `'${name}' must be a string of at most ${max} characters`); return null; }
    return v;
}

/**
 * The workspace for an ACT request: the query param, or the body field, or neither. Both given and different is
 * ambiguous and refused so a client cannot pass one value to a proxy check and another to the handler.
 */
export function actWorkspaceParam(res: ServerResponse, query: string | null, body: Record<string, unknown>): { value: string | undefined } | null {
    const fromBody = body['workspace'] ?? body['project'];
    const q = query === null || query === '' ? undefined : query;
    const b = fromBody === undefined || fromBody === null || fromBody === '' ? undefined : fromBody;
    if (q !== undefined && b !== undefined && q !== b) {
        writeError(res, 400, 'workspace_conflict', "'workspace' in the query and in the body must match");
        return null;
    }
    return { value: (q ?? b) as string | undefined };
}
