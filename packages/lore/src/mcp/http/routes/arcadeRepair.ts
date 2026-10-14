/**
 * arcadeRepair.ts - 3.34.0 slice 2: operator-only ghost-record repair for one ArcadeDB cell.
 *
 *   POST /api/arcade/apps/:tenant/:app/repair-integrity
 *   body: { dryRun?: boolean (default TRUE), rids?: string[] }
 *
 * A "ghost" is a node record in the `LoreNode` bucket with no `LoreNode[id]` index entry (see
 * engines/arcade/arcadeIntegrity.ts): `WHERE id = :id` cannot see or delete it. This route is the
 * engine-neutral shell around the optional `GraphProvider.integrityScan` / `integrityRemove`
 * capability; it never touches ArcadeDB SQL itself. An engine without the capability (or one that
 * answers `not_supported`) gets an explicit 501 `not_supported`.
 *
 *   dryRun (default)  read-only scan; returns one diagnostic per suspect (rid, id, revision,
 *                     createdAt, scan-found vs index-found) so the next occurrence leaves evidence.
 *   dryRun:false      re-scans, then removes the suspects (or only the requested `rids`) BY `@rid`.
 *                     Every record is re-checked first: one the id lookup can read is a live node
 *                     and is REFUSED; one already gone is `absent`. Re-running is a no-op.
 *
 * Scope + auth: the cell is named by the path and all access goes through that cell's RAW
 * service-account adapters (403-walled to its own database), under the cell lease. Operator lane only
 * (bindDaemonOperatorLane + requireOperatorForBoundActor), mounted in arcadeBoot.ts behind
 * requireOperatorPrincipal; rate-limited in the arcade_migrate bucket (a full scan is heavy). Every
 * call writes an audit row carrying counts and record ids only - never node content.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditLog } from '../../../security/audit.js';
import type { GraphProvider } from '../../../providers/types.js';
import { bindDaemonOperatorLane } from '../../../security/routeWorkspaceBinding.js';
import { requireOperatorForBoundActor } from '../../../security/exportGate.js';
import { writeJson, writeError, readJsonBody, isInvalidJsonBody, writeInvalidJson, isPayloadTooLarge } from '../helpers.js';
import { withCellLease, CellLeaseHeldError } from '../../../engines/arcade/arcadeProvisioner.js';
import { rawAdaptersFor } from './arcadeBackup.js';

export interface ArcadeRepairDeps {
    auditLog?: AuditLog;
}

const ID_RE = /^[a-z0-9]+$/;
const RID_RE = /^#\d+:\d+$/;
const MAX_RIDS = 1000;
const AUDIT_RID_CAP = 50;
const TOOL = 'arcade.repair-integrity';

type IntegrityGraph = Pick<GraphProvider, 'integrityScan' | 'integrityRemove'>;

export async function tryArcadeRepairRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    deps: ArcadeRepairDeps,
): Promise<boolean> {
    const m = /^\/api\/arcade\/apps\/([^/]+)\/([^/]+)\/repair-integrity$/.exec(pathname);
    if (!m) return false;
    if ((req.method ?? 'GET') !== 'POST') {
        writeError(res, 405, 'method_not_allowed', `${req.method ?? 'GET'} not allowed on ${pathname}`);
        return true;
    }
    // The lane intent depends on `dryRun` (a dry run only reads, a real run writes), so the body is
    // parsed and validated first; none of that touches the cell. The operator gates run before any
    // cell access (and this route is mounted only behind requireOperatorPrincipal).
    const tenantId = m[1] ?? '';
    const appId = m[2] ?? '';
    let body: unknown;
    try {
        body = await readJsonBody(req);
    } catch (err) {
        if (isPayloadTooLarge(err)) { writeError(res, 413, 'payload_too_large', 'request body too large'); return true; }
        if (isInvalidJsonBody(err)) { writeInvalidJson(res, err); return true; }
        throw err;
    }
    const opts = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as { dryRun?: unknown; rids?: unknown };
    if (opts.dryRun !== undefined && typeof opts.dryRun !== 'boolean') {
        writeError(res, 400, 'bad_request', '`dryRun` must be a boolean (default true)');
        return true;
    }
    const dryRun = opts.dryRun !== false;
    let rids: string[] | undefined;
    if (opts.rids !== undefined) {
        if (!Array.isArray(opts.rids) || opts.rids.length > MAX_RIDS || !opts.rids.every((r) => typeof r === 'string' && RID_RE.test(r))) {
            writeError(res, 400, 'invalid_rids', `\`rids\` must be an array of at most ${MAX_RIDS} record ids like "#12:3"`);
            return true;
        }
        rids = opts.rids as string[];
    }
    if (!bindDaemonOperatorLane(res, { intent: dryRun ? 'read' : 'write' })) return true;
    // Defence in depth, as arcadeBackup.ts: today only the operator principal reaches this mount.
    if (!requireOperatorForBoundActor(res, 'Arcade integrity repair')) return true;
    if (!ID_RE.test(tenantId)) { writeError(res, 400, 'invalid_identifier', `tenantId must match ${ID_RE}`); return true; }
    if (!ID_RE.test(appId)) { writeError(res, 400, 'invalid_identifier', `appId must match ${ID_RE}`); return true; }

    const startedAt = Date.now();
    try {
        const outcome = await withCellLease(tenantId, appId, async () => {
            const built = await rawAdaptersFor(tenantId, appId);
            if ('error' in built) return { error: built.error } as const;
            return runIntegrityRepair(built.graph as unknown as IntegrityGraph, dryRun, rids);
        });
        if ('error' in outcome) {
            writeError(res, outcome.error.status, outcome.error.code, outcome.error.message);
            return true;
        }
        if (outcome.kind === 'not_supported') {
            deps.auditLog?.log({ toolName: TOOL, args: { tenantId, appId, dryRun }, result: 'error', resultDetail: 'not_supported', durationMs: Date.now() - startedAt });
            writeError(res, 501, 'not_supported', outcome.reason);
            return true;
        }
        deps.auditLog?.log({
            toolName: TOOL,
            args: {
                tenantId, appId, dryRun,
                scanned: outcome.scanned,
                suspects: outcome.suspects.length,
                removed: outcome.removal?.removed.length ?? 0,
                refused: outcome.removal?.refused.length ?? 0,
                rids: (outcome.removal?.removed ?? outcome.suspects.map((s) => s.rid)).slice(0, AUDIT_RID_CAP),
            },
            result: 'success', resultDetail: '', durationMs: Date.now() - startedAt,
        });
        writeJson(res, 200, {
            ok: true,
            dryRun,
            scanned: outcome.scanned,
            suspects: outcome.suspects,
            ...(outcome.removal ? { removed: outcome.removal.removed, absent: outcome.removal.absent, refused: outcome.removal.refused } : {}),
        });
        return true;
    } catch (err) {
        if (err instanceof CellLeaseHeldError) {
            writeError(res, 409, 'cell_lease_held', err.message, { holder: err.holder, retryAfterSec: err.retryAfterSec });
            return true;
        }
        deps.auditLog?.log({ toolName: TOOL, args: { tenantId, appId, dryRun }, result: 'error', resultDetail: (err as Error).name, durationMs: Date.now() - startedAt });
        throw err;
    }
}

type RunOutcome =
    | { kind: 'not_supported'; reason: string }
    | {
          kind: 'ok';
          scanned: number;
          suspects: Array<{ rid: string }>;
          removal?: { removed: string[]; absent: string[]; refused: Array<{ rid: string; reason: string }> };
      };

/** The capability calls, engine-neutral (exported so a test can drive it with any engine's graph). */
export async function runIntegrityRepair(graph: IntegrityGraph, dryRun: boolean, rids: string[] | undefined): Promise<RunOutcome> {
    if (typeof graph.integrityScan !== 'function' || typeof graph.integrityRemove !== 'function') {
        return { kind: 'not_supported', reason: 'this graph engine does not implement the integrity capability' };
    }
    const scan = await graph.integrityScan();
    if (!scan.supported) return { kind: 'not_supported', reason: scan.reason };
    if (dryRun) return { kind: 'ok', scanned: scan.scanned, suspects: scan.suspects };
    const targets = rids ?? scan.suspects.map((s) => s.rid);
    if (targets.length === 0) return { kind: 'ok', scanned: scan.scanned, suspects: scan.suspects, removal: { removed: [], absent: [], refused: [] } };
    const removal = await graph.integrityRemove(targets);
    if (!removal.supported) return { kind: 'not_supported', reason: removal.reason };
    return { kind: 'ok', scanned: scan.scanned, suspects: scan.suspects, removal };
}
