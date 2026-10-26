/**
 * tableReview.ts - HTTP surface for the structured-table review queue and alias table (Postgres table storage).
 *
 *   VIEW (`read`):
 *     GET    /api/table-review/settings                                 the review confidence threshold
 *     GET    /api/table-review/queue[?table&field&sourceDocumentId&maxConfidence&limit&cursor]
 *     GET    /api/table-review/aliases[?table&field&canonical&includeRemoved&limit&cursor]
 *     GET    /api/table-review/unresolved?table=&field=[&limit&cursor]  spellings with no alias yet
 *   ACT (`review`; NOT implied by `write`):
 *     POST   /api/table-review/confirm   {workspace?, valueId}
 *     POST   /api/table-review/correct   {workspace?, valueId, value, sourcePage?, verifiedQuote?}
 *     POST   /api/table-review/aliases   {workspace?, table, field, canonical, alias?}
 *     DELETE /api/table-review/aliases/:aliasId[?workspace=]            soft-remove
 *
 * Everything is workspace-bound (reviewShared.ts): the table storage is resolved for the bound workspace, and the
 * library API filters every statement by workspace_id, so a value/alias id from another workspace is a plain 404.
 * The reviewer is the authenticated principal, never a body field. The threshold is deliberately read-only here.
 * A workspace on SQLite table storage answers 404 `table_review_unavailable` (the library says not_supported).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import type { LocalGraphRegistry } from '../../../engines/localGraphRegistry.js';
import { resolveTargetTableStorage } from '../../tools/workspaceResolve.js';
import { tableReviewFor, TableReviewError, type TableReviewApi } from '../../../query/tableReview.js';
import { gateRoute } from '../../../security/routeGate.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import { WorkspaceAccessDeniedError } from '../../../security/routeWorkspaceBinding.js';
import { redactError } from '../../../security/logRedact.js';
import { writeError } from '../helpers.js';
import {
    REVIEW_DEFAULT_LIMIT, REVIEW_MAX_LIMIT, actWorkspaceParam, bindReviewWorkspace, intParam, optionalString,
    readReviewBody, reviewerIdentity, writeJson,
} from './reviewShared.js';

export interface TableReviewDeps {
    store: StorageBundle;
    graphRegistry?: LocalGraphRegistry;
    deploymentMode: 'local' | 'cloud';
    dataplane: GroundfloorClient | null;
}

const BASE = '/api/table-review';
const STR_MAX = 1000;
const CURSOR_MAX = 512;
const QUOTE_MAX = 4000;
const ALIAS_ID = /^\d{1,18}$/;

type Op = 'settings' | 'queue' | 'aliases_list' | 'unresolved' | 'confirm' | 'correct' | 'alias_add' | 'alias_remove';
const ACT_OPS: ReadonlySet<Op> = new Set<Op>(['confirm', 'correct', 'alias_add', 'alias_remove']);

function match(method: string, pathname: string): { op: Op; aliasId?: string } | null {
    if (!pathname.startsWith(`${BASE}/`)) return null;
    const tail = pathname.slice(BASE.length + 1);
    const table: Record<string, Partial<Record<string, Op>>> = {
        settings: { GET: 'settings' }, queue: { GET: 'queue' }, unresolved: { GET: 'unresolved' },
        aliases: { GET: 'aliases_list', POST: 'alias_add' }, confirm: { POST: 'confirm' }, correct: { POST: 'correct' },
    };
    if (Object.prototype.hasOwnProperty.call(table, tail)) { const op = table[tail]![method]; return op ? { op } : null; }
    if (method === 'DELETE' && tail.startsWith('aliases/')) return { op: 'alias_remove', aliasId: tail.slice('aliases/'.length) };
    return null;
}

function reviewError(res: ServerResponse, err: TableReviewError): void {
    switch (err.code) {
        case 'not_found': writeError(res, 404, 'not_found', err.message); return;
        case 'conflict': writeError(res, 409, 'conflict', err.message, err.detail ? { detail: err.detail } : undefined); return;
        case 'invalid_argument': writeError(res, 400, 'invalid_argument', err.message); return;
        case 'too_large': writeError(res, 413, 'too_large', err.message); return;
        default: writeError(res, 404, 'table_review_unavailable', err.message);
    }
}

/** A bounded optional string query param: undefined when absent, null (after a 400) when invalid. */
function qStr(res: ServerResponse, sp: URLSearchParams, name: string, max: number): string | undefined | null {
    const v = sp.get(name);
    if (v === null || v === '') return undefined;
    if (v.length > max) { writeError(res, 400, `invalid_${name}`, `'${name}' must be at most ${max} characters`); return null; }
    return v;
}

function reqStr(res: ServerResponse, v: unknown, name: string, max: number): string | null {
    if (typeof v !== 'string' || v.trim() === '' || v.length > max) { writeError(res, 400, `invalid_${name}`, `'${name}' is required: a non-empty string of at most ${max} characters`); return null; }
    return v;
}

export async function tryTableReviewRoutes(
    req: IncomingMessage, res: ServerResponse, url: string, pathname: string, deps: TableReviewDeps,
): Promise<boolean> {
    const m = match(req.method ?? 'GET', pathname);
    if (!m) return false;
    const act = ACT_OPS.has(m.op);
    const gate = await gateRoute({ deploymentMode: deps.deploymentMode, dataplane: deps.dataplane }, {
        permission: act && deps.deploymentMode === 'cloud' ? 'write' : 'read',
    });
    if (!gate.allowed) { writePermissionDenied(res, gate); return true; }

    const sp = new URL(url, 'http://x').searchParams;
    let workspace = bindReviewWorkspace(res, sp.get('workspace') ?? sp.get('project') ?? undefined, act ? 'review' : 'read');
    if (workspace === null) return true;
    let body: Record<string, unknown> = {};
    if (act && m.op !== 'alias_remove') {
        const parsed = await readReviewBody(req, res);
        if (parsed === null) return true;
        body = parsed;
        const requested = actWorkspaceParam(res, sp.get('workspace') ?? sp.get('project'), body);
        if (requested === null) return true;
        workspace = bindReviewWorkspace(res, requested.value, 'review');
        if (workspace === null) return true;
    }
    if (m.op === 'alias_remove' && !ALIAS_ID.test(m.aliasId ?? '')) { writeError(res, 400, 'invalid_alias_id', 'alias id must be the id string returned by the alias list'); return true; }

    try {
        const resolved = await resolveTargetTableStorage(deps.store, deps.graphRegistry, deps.graphRegistry?.activeName() ?? workspace, workspace);
        if (!resolved.ok) {
            // Never list the daemon's other workspaces back to the caller.
            writeError(res, 404, 'workspace_not_found', `workspace '${workspace}' not found`);
            return true;
        }
        let api: TableReviewApi;
        try { api = await tableReviewFor(resolved.tableStorage); } catch (err) {
            if (err instanceof TableReviewError) { reviewError(res, err); return true; }
            throw err;
        }
        await dispatch(res, sp, body, m, api, workspace);
    } catch (err) {
        if (err instanceof TableReviewError) { reviewError(res, err); return true; }
        if (err instanceof WorkspaceAccessDeniedError) { writeError(res, 403, 'workspace_forbidden', 'not authorized for the requested workspace'); return true; }
        writeError(res, 500, 'internal_error', redactError(err));
    }
    return true;
}

async function dispatch(
    res: ServerResponse, sp: URLSearchParams, body: Record<string, unknown>, m: { op: Op; aliasId?: string }, api: TableReviewApi, workspace: string,
): Promise<void> {
    const limitOf = (): number | undefined | null => intParam(res, sp, 'limit', 1, REVIEW_MAX_LIMIT);
    switch (m.op) {
        case 'settings': { writeJson(res, 200, { workspace, settings: await api.getSettings() }); return; }
        case 'queue': {
            const table = qStr(res, sp, 'table', STR_MAX); if (table === null) return;
            const field = qStr(res, sp, 'field', STR_MAX); if (field === null) return;
            const doc = qStr(res, sp, 'sourceDocumentId', STR_MAX); if (doc === null) return;
            const cursor = qStr(res, sp, 'cursor', CURSOR_MAX); if (cursor === null) return;
            const limit = limitOf(); if (limit === null) return;
            const mc = sp.get('maxConfidence');
            let maxConfidence: number | undefined;
            if (mc !== null && mc !== '') {
                maxConfidence = Number(mc);
                if (!/^\d(\.\d{1,6})?$/.test(mc) || maxConfidence < 0 || maxConfidence > 1) { writeError(res, 400, 'invalid_maxConfidence', "'maxConfidence' must be a number 0..1"); return; }
            }
            const page = await api.listQueue({
                ...(table ? { table } : {}), ...(field ? { field } : {}), ...(doc ? { sourceDocumentId: doc } : {}),
                ...(maxConfidence !== undefined ? { maxConfidence } : {}), ...(cursor ? { cursor } : {}), limit: limit ?? REVIEW_DEFAULT_LIMIT,
            });
            writeJson(res, 200, { workspace, ...page });
            return;
        }
        case 'aliases_list': {
            const table = qStr(res, sp, 'table', STR_MAX); if (table === null) return;
            const field = qStr(res, sp, 'field', STR_MAX); if (field === null) return;
            const canonical = qStr(res, sp, 'canonical', STR_MAX); if (canonical === null) return;
            const cursor = qStr(res, sp, 'cursor', CURSOR_MAX); if (cursor === null) return;
            const limit = limitOf(); if (limit === null) return;
            const inc = sp.get('includeRemoved');
            if (inc !== null && inc !== 'true' && inc !== 'false') { writeError(res, 400, 'invalid_includeRemoved', "'includeRemoved' must be true or false"); return; }
            const page = await api.listAliases({
                ...(table ? { table } : {}), ...(field ? { field } : {}), ...(canonical ? { canonical } : {}), ...(cursor ? { cursor } : {}),
                includeRemoved: inc === 'true', limit: limit ?? REVIEW_DEFAULT_LIMIT,
            });
            writeJson(res, 200, { workspace, ...page });
            return;
        }
        case 'unresolved': {
            const table = qStr(res, sp, 'table', STR_MAX); if (table === null) return;
            const field = qStr(res, sp, 'field', STR_MAX); if (field === null) return;
            if (!table || !field) { writeError(res, 400, 'invalid_argument', "'table' and 'field' are required"); return; }
            const cursor = qStr(res, sp, 'cursor', CURSOR_MAX); if (cursor === null) return;
            const limit = limitOf(); if (limit === null) return;
            const page = await api.listUnresolved({ table, field, ...(cursor ? { cursor } : {}), limit: limit ?? REVIEW_DEFAULT_LIMIT });
            writeJson(res, 200, { workspace, ...page });
            return;
        }
        case 'confirm':
        case 'correct': {
            const valueId = body['valueId'];
            if (typeof valueId !== 'string' || !ALIAS_ID.test(valueId)) { writeError(res, 400, 'invalid_valueId', "'valueId' must be the value id string from the review queue"); return; }
            const reviewer = reviewerIdentity();
            if (m.op === 'confirm') { writeJson(res, 200, { workspace, outcome: await api.confirm({ valueId, reviewer }) }); return; }
            if (!('value' in body)) { writeError(res, 400, 'invalid_value', "'value' (the corrected value) is required"); return; }
            const sp2 = body['sourcePage'];
            if (sp2 !== undefined && (typeof sp2 !== 'number' || !Number.isInteger(sp2) || sp2 < 1 || sp2 > 1_000_000)) { writeError(res, 400, 'invalid_sourcePage', "'sourcePage' must be an integer 1..1000000"); return; }
            const quote = optionalString(res, body, 'verifiedQuote', QUOTE_MAX); if (quote === null) return;
            writeJson(res, 200, { workspace, outcome: await api.correct({ valueId, reviewer, value: body['value'], ...(sp2 !== undefined ? { sourcePage: sp2 as number } : {}), ...(quote !== undefined ? { verifiedQuote: quote } : {}) }) });
            return;
        }
        case 'alias_add': {
            const table = reqStr(res, body['table'], 'table', STR_MAX); if (table === null) return;
            const field = reqStr(res, body['field'], 'field', STR_MAX); if (field === null) return;
            const canonical = reqStr(res, body['canonical'], 'canonical', STR_MAX); if (canonical === null) return;
            const alias = optionalString(res, body, 'alias', STR_MAX); if (alias === null) return;
            const out = await api.addAlias({ table, field, canonical, ...(alias !== undefined ? { alias } : {}), createdBy: reviewerIdentity() });
            writeJson(res, out.created ? 201 : 200, { workspace, ...out });
            return;
        }
        case 'alias_remove': {
            writeJson(res, 200, { workspace, ...(await api.removeAlias(m.aliasId!, reviewerIdentity())) });
            return;
        }
    }
}
