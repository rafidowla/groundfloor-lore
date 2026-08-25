/**
 * reads.ts — live schema read routes.
 *
 *   GET /api/schema          — live LoreSchemaV2 (describeSchema)
 *   GET /api/schema/summary  — one-line summary
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { describeSchema, summarizeSchema } from '../../../../schemas/describe.js';
import { writeJson, writeError } from '../../helpers.js';
import { PREFIX, type SchemaRoutesDeps } from './shared.js';
import { redactError } from '../../../../security/logRedact.js';

/**
 * Wave 4.2 — the read-scope + workspace-confinement gate now lives in the
 * family dispatcher (trySchemaRoutes → bindRouteTarget with a method-derived
 * intent). A GET is bound with intent='read', so a write-only or
 * foreign-workspace token is already 403'd before any sub-route runs, and the
 * request's target is confirmed to equal the family's wired schemaWorkspace
 * (else 409). The former per-route denySchemaRead(requireReadFromWorkspace(_,
 * undefined)) gate is therefore redundant AND used the literal-undefined target
 * banned by arch rule D-021 — removed here.
 */

/** Returns true once a response has been written. */
export function tryReadRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, deps: SchemaRoutesDeps): boolean {
    if (pathname === PREFIX && req.method === 'GET') {
        try {
            const live = deps.schemaLoader.getV2();
            writeJson(res, 200, describeSchema(live));
        } catch (e) { writeError(res, 500, 'schema_get_failed', redactError(e)); }
        return true;
    }

    if (pathname === `${PREFIX}/summary` && req.method === 'GET') {
        try {
            const live = deps.schemaLoader.getV2();
            writeJson(res, 200, { summary: summarizeSchema(live) });
        } catch (e) { writeError(res, 500, 'schema_summary_failed', redactError(e)); }
        return true;
    }

    return false;
}
