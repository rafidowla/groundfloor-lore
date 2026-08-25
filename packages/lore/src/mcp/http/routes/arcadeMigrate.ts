/**
 * arcadeMigrate.ts — operator-only IMPORT route: local-workspace bundle → arcade
 * cell (spike/arcadedb-multitenant, Slice 4, the arcade half of the supported
 * migration).
 *
 *   POST /api/arcade/apps/:tenantId/:appId/import   (operator lane ONLY)
 *
 * The arcade daemon boots NO local substrates, so migration is
 * export-from-local-daemon → import-into-arcade-daemon; the NDJSON bundle is the
 * contract between them. This route consumes that bundle.
 *
 * SECURITY: operator lane only — a tenant `lore_at_*` token 401s exactly as
 * every /api/arcade/* route does (arcadeBoot's requireOperatorPrincipal walls it
 * off before dispatch). All writes use the cell's RAW service-account adapters
 * built from the provisioner registry (readSecretAsync) — NOT a tenant token
 * (tokens may not exist yet; replay must survive rotation/revocation anyway).
 *
 * IDEMPOTENCY & CONCURRENCY: every write is an id-keyed UPSERT, so re-running the
 * whole import converges. A lightweight per-cell in-flight guard makes a
 * concurrent second import of the same cell 409 migration_in_progress. We must
 * NOT nest the provisioner's withCellLock around the import body — provisionApp
 * takes that same non-reentrant per-cell mutex internally, so nesting it
 * self-deadlocks and permanently poisons the lock for the cell. A completed
 * import is recorded in cell_imports (manifest_hash) for observability.
 *
 * EMBEDDING DECISION: CARRY the bundle's embeddings when
 * manifest.embedModelId === the cell embedder's modelId AND embedDim matches the
 * cell's provisioned HNSW dim; else 409 embedding_model_mismatch unless the
 * caller passes {reEmbed:true}, in which case vectors are recomputed.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditLog } from '../../../security/audit.js';
import { bindDaemonOperatorLane } from '../../../security/routeWorkspaceBinding.js';
import { writeJson, writeError } from '../helpers.js';
import * as crypto from 'node:crypto';
import {
    provisionApp,
    getTenantApp,
    readSecretAsync,
    ARCADE_BASE_URL,
} from '../../../engines/arcade/arcadeProvisioner.js';
import { openTokenDbForLifecycle } from '../../../engines/arcade/arcadeAuthResolver.js';
import { ArcadeHttp } from '../../../engines/arcade/arcadeHttp.js';
import { ArcadeGraphStore } from '../../../engines/arcade/arcadeGraphStore.js';
import { ArcadeVectorStore } from '../../../engines/arcade/arcadeVectorStore.js';
import type { LoreNode, LoreEdge } from '../../../providers/types.js';

export interface ArcadeMigrateDeps {
    auditLog?: AuditLog;
    evictCell?: (tenantId: string, appId: string) => void;
    /** Unused here (the import writes via RAW adapters, not the outbox) but
     *  threaded from arcadeBoot for symmetry with the other operator families. */
    outboxStore?: unknown;
}

const ID_RE = /^[a-z0-9]+$/;

interface ManifestLine {
    kind: 'manifest';
    formatVersion: number;
    workspace: string;
    exportedAt: string;
    embedModelId: string;
    embedDim: number;
    counts: { nodes: number; edges: number; verbatim: number };
}

/** An NDJSON bundle line. Parsed leniently; unknown kinds are ignored (forward-
 *  compat). */
type BundleLine =
    | ManifestLine
    | ({ kind: 'node' } & Record<string, unknown>)
    | { kind: 'edge'; sourceId: string; targetId: string; relation: string; metadata?: unknown; createdAt?: string }
    | { kind: 'verbatim'; id: string; text: string; metadata?: Record<string, unknown>; contentHash?: string; embedding?: number[]; embedModelId?: string };

const NODE_CHUNK = 50;

/** Read the entire request body as a string (bounded by the arcade body posture;
 *  we stream-parse line-by-line rather than JSON.parse the whole blob). */
async function readRawBody(req: IncomingMessage, capBytes: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (c: Buffer) => {
            total += c.length;
            if (total > capBytes) {
                reject(new Error('payload_too_large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** ~64MB cap — mirrors the import.ts v0 posture (cap + document; streaming
 *  multipart for larger exports is deliberately out of scope this slice). */
const IMPORT_BODY_CAP = 64 * 1024 * 1024;

/**
 * tryArcadeMigrateRoutes — mounts POST /api/arcade/apps/:t/:a/import. Returns
 * true when it OWNED the request, false to fall through to the next operator
 * family.
 */
export async function tryArcadeMigrateRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: string,
    pathname: string,
    deps: ArcadeMigrateDeps,
): Promise<boolean> {
    const m = /^\/api\/arcade\/apps\/([^/]+)\/([^/]+)\/import$/.exec(pathname);
    if (!m) return false;
    const method = req.method ?? 'GET';
    if (method !== 'POST') {
        writeError(res, 405, 'method_not_allowed', `${method} not allowed on ${pathname}`);
        return true;
    }
    const tenantId = m[1] ?? '';
    const appId = m[2] ?? '';
    if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
    if (!ID_RE.test(tenantId)) {
        writeError(res, 400, 'invalid_identifier', `tenantId must match ${ID_RE}`);
        return true;
    }
    if (!ID_RE.test(appId)) {
        writeError(res, 400, 'invalid_identifier', `appId must match ${ID_RE}`);
        return true;
    }

    let raw: string;
    try {
        raw = await readRawBody(req, IMPORT_BODY_CAP);
    } catch (err) {
        if ((err as Error).message === 'payload_too_large') {
            writeError(res, 413, 'payload_too_large', `import bundle exceeds ${IMPORT_BODY_CAP} bytes`);
            return true;
        }
        throw err;
    }

    // Parse NDJSON line-by-line.
    const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    let manifest: ManifestLine | undefined;
    const nodes: LoreNode[] = [];
    const edges: Array<{ sourceId: string; targetId: string; relation: string; metadata?: unknown }> = [];
    const verbatimRows: Array<{ id: string; text: string; metadata?: Record<string, unknown>; contentHash?: string; embedding?: number[] }> = [];
    const reEmbedRequested = /"reEmbed"\s*:\s*true/.test(lines[0] ?? '');

    try {
        for (const line of lines) {
            const parsed = JSON.parse(line) as BundleLine & { reEmbed?: boolean };
            switch (parsed.kind) {
                case 'manifest':
                    manifest = parsed as ManifestLine;
                    break;
                case 'node': {
                    const { kind: _k, ...rest } = parsed as { kind: string } & Record<string, unknown>;
                    nodes.push(rest as unknown as LoreNode);
                    break;
                }
                case 'edge':
                    edges.push({
                        sourceId: parsed.sourceId,
                        targetId: parsed.targetId,
                        relation: parsed.relation,
                        metadata: parsed.metadata,
                    });
                    break;
                case 'verbatim':
                    verbatimRows.push({
                        id: parsed.id,
                        text: parsed.text,
                        metadata: parsed.metadata,
                        contentHash: parsed.contentHash,
                        embedding: parsed.embedding,
                    });
                    break;
                default:
                    /* unknown kind — forward-compat, ignore */
                    break;
            }
        }
    } catch {
        writeError(res, 400, 'invalid_json', 'import bundle is not valid NDJSON');
        return true;
    }

    if (!manifest || manifest.kind !== 'manifest') {
        writeError(res, 400, 'invalid_request', 'import bundle is missing its manifest (line 1)');
        return true;
    }

    const manifestHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');

    // CONCURRENCY — a concurrent second import of the SAME cell must 409
    // migration_in_progress, NOT block. We use a lightweight per-cell in-flight
    // guard (`importing` Set) for that.
    //
    // CRITICAL — we do NOT wrap the import body in the provisioner's withCellLock
    // here: provisionApp/disableApp/destroyApp/rotateCredential each take
    // withCellLock(tenantId, appId) INTERNALLY on the same `${t}::${a}` key, and
    // that mutex is non-reentrant. Nesting it (outer import lock → inner
    // provisionApp lock, same key) self-deadlocks unconditionally AND permanently
    // poisons the module-level lock for that cell (the outer callback never
    // returns, so `release()` never runs). The in-flight guard below gives us the
    // migration_in_progress 409 without any nesting; the individual provisioner
    // calls still serialize on their own lock against operator ops. The import's
    // bulk writes go straight to ArcadeDB (id-keyed UPSERTs, replay-safe), which
    // the cell lock never protected anyway.
    //
    // The check + set are synchronous and adjacent (no await between), so two
    // concurrent requests cannot both pass the guard.
    if (isImporting(tenantId, appId)) {
        writeError(res, 409, 'migration_in_progress', `an import is already running for cell (${tenantId}, ${appId})`);
        return true;
    }
    markImporting(tenantId, appId, true);

    try {
        const result = await (async () => {
            // 1. Provision (idempotent — takes withCellLock internally).
            await provisionApp({ customerId: tenantId, appId }, manifest!.embedDim ? { embedDim: manifest!.embedDim } : undefined);
            const cell = getTenantApp({ customerId: tenantId, appId });
            if (!cell || cell.status !== 'active') {
                throw new MigrateError(500, 'cell_not_active', `cell (${tenantId}, ${appId}) not active after provision`);
            }
            const secret = await readSecretAsync({ customerId: tenantId, appId });
            if (!secret) {
                throw new MigrateError(500, 'secret_missing', `no service-account secret for cell (${tenantId}, ${appId})`);
            }

            // RAW adapters — service account, 403-walled to this one db.
            const http = new ArcadeHttp({ user: cell.db_user, pass: secret }, ARCADE_BASE_URL);
            const rawGraph = new ArcadeGraphStore({ tenantDb: cell.db, http });
            const rawVector = new ArcadeVectorStore({ tenantDb: cell.db, http });

            // 2. Embedding decision (BEFORE any write, so a mismatch aborts clean).
            const cellModelId = await rawVector.embedModelId();
            const cellDim = await rawVector.embedDim();
            const modelMatches = manifest!.embedModelId === cellModelId && manifest!.embedDim === cellDim;
            if (!modelMatches && !reEmbedRequested) {
                throw new MigrateError(
                    409,
                    'embedding_model_mismatch',
                    `bundle embeddings (${manifest!.embedModelId}/${manifest!.embedDim}) ` +
                        `!= cell embedder (${cellModelId}/${cellDim}); pass {reEmbed:true} to recompute`,
                );
            }
            const embeddingsMode: 'carried' | 're-embedded' = modelMatches && !reEmbedRequested ? 'carried' : 're-embedded';

            const errors: Array<{ id: string; error: string }> = [];
            let importedNodes = 0;
            let importedEdges = 0;
            let importedVerbatim = 0;
            let skipped = 0;

            // 3. Nodes — chunked bulk upsert.
            for (let i = 0; i < nodes.length; i += NODE_CHUNK) {
                const chunk = nodes.slice(i, i + NODE_CHUNK);
                const outcomes = await rawGraph.bulkUpsertNodes(
                    chunk as Array<Omit<LoreNode, 'createdAt' | 'updatedAt' | 'syncedAt'>>,
                );
                for (const o of outcomes) {
                    if (o.ok) importedNodes++;
                    else if (errors.length < 100) errors.push({ id: o.id, error: o.error ?? 'upsert failed' });
                }
            }

            // 4. Edges — read-decide-write is replay-safe.
            for (const e of edges) {
                try {
                    await rawGraph.addEdge(e as LoreEdge);
                    importedEdges++;
                } catch (err) {
                    if (errors.length < 100) errors.push({ id: `${e.sourceId}->${e.targetId}`, error: (err as Error).message });
                }
            }

            // 5. Verbatim — carry (storePrebuilt) or re-embed (store).
            if (embeddingsMode === 'carried') {
                const carryable = verbatimRows
                    .filter((r) => Array.isArray(r.embedding) && r.embedding!.length === cellDim)
                    .map((r) => ({ id: r.id, text: r.text, metadata: r.metadata as never, contentHash: r.contentHash, embedding: r.embedding! }));
                try {
                    await rawVector.storePrebuilt(carryable);
                    importedVerbatim += carryable.length;
                } catch (err) {
                    if (errors.length < 100) errors.push({ id: 'verbatim.carry', error: (err as Error).message });
                }
                skipped += verbatimRows.length - carryable.length;
            } else {
                for (const r of verbatimRows) {
                    try {
                        await rawVector.store({ id: r.id, text: r.text, metadata: r.metadata as never });
                        importedVerbatim++;
                    } catch (err) {
                        if (errors.length < 100) errors.push({ id: r.id, error: (err as Error).message });
                    }
                }
            }

            // 6. Ledger — record the completed import for observability + a
            //    re-import of the same bundle is observable.
            recordImportLedger(tenantId, appId, manifestHash, {
                nodes: importedNodes,
                edges: importedEdges,
                verbatim: importedVerbatim,
            });

            return {
                imported: { nodes: importedNodes, edges: importedEdges, verbatim: importedVerbatim },
                skipped,
                errors,
                embeddings: embeddingsMode,
            };
        })();

        deps.auditLog?.log({
            toolName: 'arcade.migrate.import',
            args: { tenantId, appId, manifestHash: manifestHash.slice(0, 12), imported: result.imported, embeddings: result.embeddings },
            result: 'success',
            resultDetail: '',
            durationMs: 0,
        });
        writeJson(res, 200, result);
        return true;
    } catch (err) {
        if (err instanceof MigrateError) {
            deps.auditLog?.log({
                toolName: 'arcade.migrate.import',
                args: { tenantId, appId },
                result: 'error',
                resultDetail: err.code,
                durationMs: 0,
            });
            writeError(res, err.status, err.code, err.message);
            return true;
        }
        throw err;
    } finally {
        markImporting(tenantId, appId, false);
    }
}

// ── typed migrate error ──────────────────────────────────────────────────────

class MigrateError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'MigrateError';
    }
}

// ── in-flight import guard (per-cell, reject-not-queue) ──────────────────────

const importing = new Set<string>();
function importKey(t: string, a: string): string {
    return `${t}::${a}`;
}
function isImporting(t: string, a: string): boolean {
    return importing.has(importKey(t, a));
}
function markImporting(t: string, a: string, on: boolean): void {
    if (on) importing.add(importKey(t, a));
    else importing.delete(importKey(t, a));
}

// ── cell_imports ledger (registry relational lane) ───────────────────────────

function recordImportLedger(
    tenantId: string,
    appId: string,
    manifestHash: string,
    counts: { nodes: number; edges: number; verbatim: number },
): void {
    const db = openTokenDbForLifecycle();
    db.prepare(
        `INSERT INTO cell_imports (tenant_id, app_id, manifest_hash, counts_json, completed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, app_id, manifest_hash)
           DO UPDATE SET counts_json = excluded.counts_json, completed_at = excluded.completed_at`,
    ).run(tenantId, appId, manifestHash, JSON.stringify(counts), new Date().toISOString());
}
