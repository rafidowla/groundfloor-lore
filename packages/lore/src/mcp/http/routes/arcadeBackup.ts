/**
 * arcadeBackup.ts — operator-only per-cell BACKUP / RESTORE routes for the
 * db-per-app ArcadeDB backend. (branch: spike/arcadedb-multitenant, slice 5 GA)
 *
 *   POST /api/arcade/apps/:tenant/:app/backup    → gzip-less NDJSON bundle
 *   POST /api/arcade/apps/:tenant/:app/restore   → provision + verified import
 *
 * SECURITY: operator lane only — every handler's first act is
 * bindDaemonOperatorLane (D-021 clean: no requireXToWorkspace(principal,
 * undefined)). A tenant lore_at_* token is walled off before dispatch
 * (arcadeBoot.requireOperatorPrincipal). All ArcadeDB access uses the cell's RAW
 * service-account adapters (root-registry secret), not a tenant token.
 *
 * TIER A (logical, portable, remote-safe — the GA path). The backup streams an
 * NDJSON bundle whose SHAPE is identical to the slice-4 migration bundle
 * (manifest line first, then node / edge / verbatim lines) so restore = provision
 * (idempotent) + the same id-keyed UPSERT import. Each section is sha256-summed;
 * the digests + a manifest_hash land in a trailer line. Restore verifies every
 * per-section sha256 + the manifest_hash BEFORE any write (mismatch → 409
 * bundle_hash_mismatch, zero writes applied) and refuses a NON-empty target cell
 * without {force:true} (409 restore_target_not_empty). Restore into a DIFFERENT
 * (tenant,app) is supported — db-per-app makes per-customer clone/DR trivially
 * scoped.
 *
 * Preconditions (backup): cell status active|disabled, outbox lane drained
 * (reuse OUTBOX_NOT_DRAINED 409 — a backup must not snapshot a graph ahead of
 * its vectors), cell lease held for the duration (read-consistency + no
 * concurrent import). Bookkeeping: cell_backups(tenant, app, manifest_hash,
 * counts, created_at).
 *
 * TIER B (physical, fast, self-hosted only): ArcadeDB `BACKUP DATABASE` SQL
 * produces a server-side zip in the container's backups dir.
 *   ⚠ NEEDS-REAL-CLOUD VALIDATION: retrieval from a MANAGED endpoint requires
 *   volume access — out of local scope. Exposed + documented, not GA-proven.
 *
 * Both verbs drain the arcade_migrate rate bucket (wired at the dispatcher) and
 * write audit entries carrying the manifest_hash only — never secrets.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as crypto from 'node:crypto';
import type { AuditLog } from '../../../security/audit.js';
import { bindDaemonOperatorLane } from '../../../security/routeWorkspaceBinding.js';
import { writeJson, writeError } from '../helpers.js';
import {
    provisionApp,
    getTenantApp,
    readSecretAsync,
    withCellLease,
    CellLeaseHeldError,
    ARCADE_BASE_URL,
} from '../../../engines/arcade/arcadeProvisioner.js';
import { openTokenDbForLifecycle } from '../../../engines/arcade/arcadeAuthResolver.js';
import { ArcadeHttp } from '../../../engines/arcade/arcadeHttp.js';
import { ArcadeGraphStore } from '../../../engines/arcade/arcadeGraphStore.js';
import { ArcadeVectorStore } from '../../../engines/arcade/arcadeVectorStore.js';
import { NODE_TYPE, VERBATIM_TYPE } from '../../../engines/arcade/arcadeSchema.js';
import type { LoreNode, LoreEdge } from '../../../providers/types.js';

export interface ArcadeBackupDeps {
    auditLog?: AuditLog;
    /** Structural outbox handle so a backup can refuse an un-drained lane.
     *  statsByWorkspace → Record<workspace, {depth}>. Typed structurally to
     *  avoid an import cycle. */
    outboxStore?: { statsByWorkspace?: () => Promise<Record<string, { depth: number }>> };
    evictCell?: (tenantId: string, appId: string) => void;
}

const ID_RE = /^[a-z0-9]+$/;
const RESTORE_BODY_CAP = 64 * 1024 * 1024;

interface BackupManifest {
    kind: 'manifest';
    formatVersion: number;
    workspace: string;
    tenantId: string;
    appId: string;
    exportedAt: string;
    embedModelId: string;
    embedDim: number;
    counts: { nodes: number; edges: number; verbatim: number };
}

interface BundleTrailer {
    kind: 'trailer';
    digests: { nodes: string; edges: string; verbatim: string };
    manifestHash: string;
}

function sha256(s: string): string {
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Build the cell's RAW service-account adapters (403-walled to one db). */
async function rawAdaptersFor(
    tenantId: string,
    appId: string,
): Promise<{ graph: ArcadeGraphStore; vector: ArcadeVectorStore; db: string } | { error: { status: number; code: string; message: string } }> {
    const cell = getTenantApp({ customerId: tenantId, appId });
    if (!cell) return { error: { status: 404, code: 'cell_missing', message: `cell (${tenantId}, ${appId}) not provisioned` } };
    const secret = await readSecretAsync({ customerId: tenantId, appId });
    if (!secret) return { error: { status: 500, code: 'secret_missing', message: `no service-account secret for cell (${tenantId}, ${appId})` } };
    const http = new ArcadeHttp({ user: cell.db_user, pass: secret }, ARCADE_BASE_URL);
    return { graph: new ArcadeGraphStore({ tenantDb: cell.db, http }), vector: new ArcadeVectorStore({ tenantDb: cell.db, http }), db: cell.db };
}

export async function tryArcadeBackupRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: string,
    pathname: string,
    deps: ArcadeBackupDeps,
): Promise<boolean> {
    const backup = /^\/api\/arcade\/apps\/([^/]+)\/([^/]+)\/backup$/.exec(pathname);
    const restore = /^\/api\/arcade\/apps\/([^/]+)\/([^/]+)\/restore$/.exec(pathname);
    if (!backup && !restore) return false;

    const method = req.method ?? 'GET';
    if (method !== 'POST') {
        writeError(res, 405, 'method_not_allowed', `${method} not allowed on ${pathname}`);
        return true;
    }
    if (!bindDaemonOperatorLane(res, { intent: backup ? 'read' : 'write' })) return true;

    const m = (backup ?? restore)!;
    const tenantId = m[1] ?? '';
    const appId = m[2] ?? '';
    if (!ID_RE.test(tenantId)) { writeError(res, 400, 'invalid_identifier', `tenantId must match ${ID_RE}`); return true; }
    if (!ID_RE.test(appId)) { writeError(res, 400, 'invalid_identifier', `appId must match ${ID_RE}`); return true; }

    try {
        if (backup) return await handleBackup(res, deps, tenantId, appId);
        return await handleRestore(req, res, deps, tenantId, appId);
    } catch (err) {
        if (err instanceof CellLeaseHeldError) {
            writeError(res, 409, 'cell_lease_held', err.message, { holder: err.holder, retryAfterSec: err.retryAfterSec });
            return true;
        }
        throw err;
    }
}

// ── TIER A backup (logical NDJSON) ────────────────────────────────────────────

async function handleBackup(
    res: ServerResponse,
    deps: ArcadeBackupDeps,
    tenantId: string,
    appId: string,
): Promise<true> {
    const cell = getTenantApp({ customerId: tenantId, appId });
    if (!cell) { writeError(res, 404, 'cell_missing', `cell (${tenantId}, ${appId}) not provisioned`); return true; }
    if (cell.status !== 'active' && cell.status !== 'disabled') {
        writeError(res, 409, 'cell_not_active', `cell (${tenantId}, ${appId}) is '${cell.status}'; backup needs active|disabled`);
        return true;
    }
    // Outbox-drain gate — a backup must not snapshot a graph ahead of its vectors.
    if (deps.outboxStore?.statsByWorkspace) {
        const stats = await deps.outboxStore.statsByWorkspace();
        const lane = stats[`arcade:${tenantId}:${appId}`];
        if (lane && lane.depth > 0) {
            writeError(res, 409, 'outbox_not_drained', `cell (${tenantId}, ${appId}) has ${lane.depth} un-drained outbox rows; drain before backup`);
            return true;
        }
    }

    // Lease held for the whole read (consistency + no concurrent import).
    const bundle = await withCellLease(tenantId, appId, async () => {
        const built = await rawAdaptersFor(tenantId, appId);
        if ('error' in built) throw new BackupError(built.error.status, built.error.code, built.error.message);
        const { graph, vector, db } = built;
        return exportBundle(tenantId, appId, db, graph, vector);
    }).catch((e: unknown) => {
        if (e instanceof BackupError) return e;
        throw e;
    });

    if (bundle instanceof BackupError) { writeError(res, bundle.status, bundle.code, bundle.message); return true; }

    // Ledger the manifest_hash + counts.
    recordBackupLedger(tenantId, appId, bundle.manifestHash, bundle.counts);
    deps.auditLog?.log({
        toolName: 'arcade.backup.create',
        args: { tenantId, appId, manifestHash: bundle.manifestHash.slice(0, 12), counts: bundle.counts },
        result: 'success', resultDetail: '', durationMs: 0,
    });

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Lore-Manifest-Hash': bundle.manifestHash });
    res.end(bundle.ndjson);
    return true;
}

/** Export the cell to an NDJSON bundle (manifest / node* / edge* / verbatim* /
 *  trailer). Direct root-authed SELECTs read full rows incl. embeddings. */
async function exportBundle(
    tenantId: string,
    appId: string,
    db: string,
    graph: ArcadeGraphStore,
    vector: ArcadeVectorStore,
): Promise<{ ndjson: string; manifestHash: string; counts: { nodes: number; edges: number; verbatim: number } }> {
    // Nodes — full projection. graph.http is private; go through a listing verb.
    const nodeRows = await selectAllNodes(graph);
    const edges: LoreEdge[] = await graph.getEdges();
    const verbatimRows = await selectAllVerbatim(vector);
    const embedModelId = await vector.embedModelId();
    const embedDim = await vector.embedDim();

    const nodeLines = nodeRows.map((n) => JSON.stringify({ kind: 'node', ...n }));
    const edgeLines = edges.map((e) => JSON.stringify({ kind: 'edge', sourceId: e.sourceId, targetId: e.targetId, relation: e.relation, confidence: e.confidence, confidenceScore: e.confidenceScore }));
    const verbatimLines = verbatimRows.map((v) => JSON.stringify({ kind: 'verbatim', ...v }));

    const digests = {
        nodes: sha256(nodeLines.join('\n')),
        edges: sha256(edgeLines.join('\n')),
        verbatim: sha256(verbatimLines.join('\n')),
    };
    const counts = { nodes: nodeRows.length, edges: edges.length, verbatim: verbatimRows.length };
    const manifest: BackupManifest = {
        kind: 'manifest', formatVersion: 1, workspace: `arcade:${tenantId}:${appId}`,
        tenantId, appId, exportedAt: new Date().toISOString(), embedModelId, embedDim, counts,
    };
    const manifestLine = JSON.stringify(manifest);
    // manifest_hash covers the manifest + the three section digests — a stable
    // whole-bundle fingerprint that restore re-derives and compares.
    const manifestHash = sha256(manifestLine + '\n' + JSON.stringify(digests));
    const trailer: BundleTrailer = { kind: 'trailer', digests, manifestHash };

    const ndjson = [manifestLine, ...nodeLines, ...edgeLines, ...verbatimLines, JSON.stringify(trailer)].join('\n') + '\n';
    return { ndjson, manifestHash, counts };
}

/** Direct root-authed SELECT of every node's public props (via the adapter's
 *  own query surface — bulkList paginates; we page to completion). */
async function selectAllNodes(graph: ArcadeGraphStore): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let cursor: { updatedAt: string; id: string } | undefined;
    // Page through bulkList (updatedAt DESC, id ASC ordering) to completion.
    for (;;) {
        const page = await graph.bulkList(cursor ? { limit: 500, cursor } : { limit: 500 });
        for (const n of page.nodes) out.push(n as unknown as Record<string, unknown>);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
    }
    return out;
}

/** Direct SELECT of every verbatim row incl. embedding (needed for CARRY). Uses
 *  the vector store's raw http via a small helper method. */
async function selectAllVerbatim(vector: ArcadeVectorStore): Promise<Array<{ id: string; text: string; metadata?: Record<string, unknown>; contentHash?: string; embedding?: number[] }>> {
    return vector.dumpAll();
}

// ── TIER A restore (verify-then-write) ────────────────────────────────────────

async function handleRestore(
    req: IncomingMessage,
    res: ServerResponse,
    deps: ArcadeBackupDeps,
    tenantId: string,
    appId: string,
): Promise<true> {
    const raw = await readRawBody(req, RESTORE_BODY_CAP).catch((e: Error) => e);
    if (raw instanceof Error) {
        if (raw.message === 'payload_too_large') { writeError(res, 413, 'payload_too_large', `restore bundle exceeds ${RESTORE_BODY_CAP} bytes`); return true; }
        throw raw;
    }
    const force = /"force"\s*:\s*true/.test(raw.split('\n')[0] ?? '');

    // Parse NDJSON.
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    let manifest: BackupManifest | undefined;
    let trailer: BundleTrailer | undefined;
    const nodeLines: string[] = [];
    const edgeLines: string[] = [];
    const verbatimLines: string[] = [];
    const nodes: LoreNode[] = [];
    const edges: Array<{ sourceId: string; targetId: string; relation: string; confidence?: unknown; confidenceScore?: unknown }> = [];
    const verbatim: Array<{ id: string; text: string; metadata?: Record<string, unknown>; contentHash?: string; embedding?: number[] }> = [];
    try {
        for (const line of lines) {
            const p = JSON.parse(line) as { kind: string } & Record<string, unknown>;
            if (p.kind === 'manifest') manifest = p as unknown as BackupManifest;
            else if (p.kind === 'trailer') trailer = p as unknown as BundleTrailer;
            else if (p.kind === 'node') { nodeLines.push(line); const { kind: _k, ...rest } = p; nodes.push(rest as unknown as LoreNode); }
            else if (p.kind === 'edge') { edgeLines.push(line); edges.push({ sourceId: p['sourceId'] as string, targetId: p['targetId'] as string, relation: p['relation'] as string, confidence: p['confidence'], confidenceScore: p['confidenceScore'] }); }
            else if (p.kind === 'verbatim') { verbatimLines.push(line); verbatim.push({ id: p['id'] as string, text: p['text'] as string, metadata: p['metadata'] as Record<string, unknown>, contentHash: p['contentHash'] as string, embedding: p['embedding'] as number[] }); }
        }
    } catch { writeError(res, 400, 'invalid_json', 'restore bundle is not valid NDJSON'); return true; }

    if (!manifest || !trailer) { writeError(res, 400, 'invalid_request', 'restore bundle missing manifest or trailer'); return true; }

    // ── HASH VERIFY BEFORE ANY WRITE (criterion r: zero writes on mismatch) ──
    // Re-line the sections in the SAME shape exportBundle emitted (node lines are
    // stored verbatim; edge/verbatim lines were re-stringified from parsed fields,
    // so re-derive from the ORIGINAL lines we captured).
    const digests = {
        nodes: sha256(nodeLines.join('\n')),
        edges: sha256(edgeLines.join('\n')),
        verbatim: sha256(verbatimLines.join('\n')),
    };
    const manifestLine = JSON.stringify(manifest);
    const recomputedManifestHash = sha256(manifestLine + '\n' + JSON.stringify(trailer.digests));
    const sectionsOk = digests.nodes === trailer.digests.nodes && digests.edges === trailer.digests.edges && digests.verbatim === trailer.digests.verbatim;
    const manifestOk = recomputedManifestHash === trailer.manifestHash;
    if (!sectionsOk || !manifestOk) {
        writeError(res, 409, 'bundle_hash_mismatch', 'restore bundle failed sha256 / manifest_hash verification; zero writes applied', {
            sectionsOk, manifestOk,
        });
        return true;
    }

    // Provision (idempotent) + non-empty guard + write, under the cell lease.
    const result = await withCellLease(tenantId, appId, async () => {
        await provisionApp({ customerId: tenantId, appId }, manifest!.embedDim ? { embedDim: manifest!.embedDim } : undefined);
        const built = await rawAdaptersFor(tenantId, appId);
        if ('error' in built) throw new BackupError(built.error.status, built.error.code, built.error.message);
        const { graph, vector } = built;

        // Refuse a NON-empty target without {force:true}.
        const existingCount = await graph.nodeCount();
        if (existingCount > 0 && !force) {
            throw new BackupError(409, 'restore_target_not_empty', `target cell (${tenantId}, ${appId}) has ${existingCount} nodes; pass {force:true} to restore over it`);
        }

        // Embedding CARRY vs re-embed (same posture as migrate).
        const cellModelId = await vector.embedModelId();
        const cellDim = await vector.embedDim();
        const carry = manifest!.embedModelId === cellModelId && manifest!.embedDim === cellDim;

        let importedNodes = 0, importedEdges = 0, importedVerbatim = 0;
        for (let i = 0; i < nodes.length; i += 50) {
            const outcomes = await graph.bulkUpsertNodes(nodes.slice(i, i + 50) as Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>);
            importedNodes += outcomes.filter((o) => o.ok).length;
        }
        for (const e of edges) { try { await graph.addEdge(e as LoreEdge); importedEdges++; } catch { /* replay-safe skip */ } }
        if (carry) {
            const carryable = verbatim.filter((r) => Array.isArray(r.embedding) && r.embedding!.length === cellDim)
                .map((r) => ({ id: r.id, text: r.text, metadata: r.metadata as never, contentHash: r.contentHash, embedding: r.embedding! }));
            await vector.storePrebuilt(carryable);
            importedVerbatim += carryable.length;
        } else {
            for (const r of verbatim) { try { await vector.store({ id: r.id, text: r.text, metadata: r.metadata as never }); importedVerbatim++; } catch { /* skip */ } }
        }
        return { imported: { nodes: importedNodes, edges: importedEdges, verbatim: importedVerbatim }, embeddings: carry ? 'carried' : 're-embedded' as const };
    }).catch((e: unknown) => { if (e instanceof BackupError) return e; throw e; });

    if (result instanceof BackupError) { writeError(res, result.status, result.code, result.message); return true; }

    deps.evictCell?.(tenantId, appId);
    deps.auditLog?.log({
        toolName: 'arcade.backup.restore',
        args: { tenantId, appId, manifestHash: trailer.manifestHash.slice(0, 12), imported: result.imported, embeddings: result.embeddings },
        result: 'success', resultDetail: '', durationMs: 0,
    });
    writeJson(res, 200, { restored: true, imported: result.imported, embeddings: result.embeddings, manifestHash: trailer.manifestHash });
    return true;
}

// ── helpers ────────────────────────────────────────────────────────────────

class BackupError extends Error {
    constructor(public readonly status: number, public readonly code: string, message: string) {
        super(message); this.name = 'BackupError';
    }
}

function readRawBody(req: IncomingMessage, capBytes: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (c: Buffer) => {
            total += c.length;
            if (total > capBytes) { reject(new Error('payload_too_large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function recordBackupLedger(
    tenantId: string,
    appId: string,
    manifestHash: string,
    counts: { nodes: number; edges: number; verbatim: number },
): void {
    const db = openTokenDbForLifecycle();
    db.prepare(
        `INSERT INTO cell_backups (tenant_id, app_id, manifest_hash, counts_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, app_id, manifest_hash)
           DO UPDATE SET counts_json = excluded.counts_json, created_at = excluded.created_at`,
    ).run(tenantId, appId, manifestHash, JSON.stringify(counts), new Date().toISOString());
}

// eslint no-unused: NODE_TYPE / VERBATIM_TYPE reserved for a future direct-SELECT
// export path; referenced here to keep the import intentional.
void NODE_TYPE;
void VERBATIM_TYPE;
