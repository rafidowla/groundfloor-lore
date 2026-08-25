/**
 * shared.ts — types + helpers for the workspace route family.
 *
 * Repo-registry routes (/api/repos*) and the DeveloperApi interface were
 * removed in NW-6a: they permanently returned 503 after the plugin system
 * was removed in v3.11.0. Atlas owns the repo-registry surface.
 */

import type { IncomingMessage } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { AuditLog } from '../../../../security/audit.js';
import { readBoundedBody } from '../../helpers.js';

export interface WorkspacesDeps {
    auditLog: AuditLog;
    /** Allows the route to call `gateRoute` for ReBAC checks. */
    deploymentMode: 'local' | 'cloud';
    /** Dataplane handle used by ReBAC checks. Null in local mode. */
    dataplane: GroundfloorClient | null;
}

/**
 * Read the request body as a string, capped at the helper-wide 10 MB
 * MAX_BODY_BYTES. Rejects with `{ code: 'payload_too_large' }` on
 * overflow so callers can map to HTTP 413 via writeOversizeError.
 */
export function readBody(req: IncomingMessage): Promise<string> {
    return readBoundedBody(req);
}
