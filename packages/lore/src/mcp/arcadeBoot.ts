/**
 * arcadeBoot.ts — the db-per-app ArcadeDB cloud boot path
 * (spike/arcadedb-multitenant, slice 2 W1 + W4).
 *
 * WHY A SEPARATE BOOT: arcade mode never brings up the local graph engine /
 * LanceDB / LocalGraphRegistry / sync / watchers / daemon maintenance timers. Tenant
 * graph+vector live in ONE ArcadeDB database per customer-app; the daemon's
 * only local state is the SQLite/JSONL RELATIONAL LANE (outbox + audit +
 * provisioning/token registry). Delegating here keeps server.ts's local/cloud
 * substrate path provably untouched (the arcade branch returns before any of
 * it runs) and keeps server.ts inside its file-size budget.
 *
 * WHAT BOOTS (this pass):
 *   - Boot preflight: require ARCADE_BASE_URL + a real root credential (fail
 *     loud rather than fall back to the compiled-in spike default).
 *   - The relational lane: AuditLog (audit.jsonl, hash-chained, 0600),
 *     SqliteOutboxStore (daemon-local durability), and the provisioning/token
 *     registry with its versioned migrations run at open.
 *   - The operator control-plane HTTP surface (routes/arcadeAdmin.ts), gated
 *     by an operator-only token. Everything else 501s deny-by-default
 *     ({code:'not_supported_in_arcade_mode'}) — no route silently touches a
 *     local substrate.
 *
 * WHAT DOES NOT BOOT: LocalGraph, LanceDB/VerbatimStore,
 * LocalGraphRegistry, sync engine/poller, source watchers, schema-authoring,
 * and ALL daemon maintenance timers. The bounded tenant DATA plane (cell pool
 * + per-request cell binding) is a following slice; here every data verb 501s.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import { log } from '../logger.js';
import { VERSION } from '../version.js';
import { AuditLog } from '../security/audit.js';
import { SqliteOutboxStore } from '../outbox/sqliteStore.js';
import { ensureAuthToken, getAuthTokenPath } from '../security/authToken.js';
import { runWithPrincipal, type Principal } from '../auth/principal.js';
import { runWithRouteBindingSlot } from '../security/routeWorkspaceBinding.js';
import { writeError, writeJson } from './http/helpers.js';
import { tryArcadeAdminRoutes } from './http/routes/arcadeAdmin.js';
import { tryArcadePolicyRoutes } from './http/routes/arcadePolicy.js';
import { tryArcadeMigrateRoutes } from './http/routes/arcadeMigrate.js';
import { tryArcadeBackupRoutes } from './http/routes/arcadeBackup.js';
import { tryArcadeDataRoutes } from './http/routes/arcadeData.js';
import {
    ARCADE_BASE_URL,
    provisioningDbPath,
} from '../engines/arcade/arcadeProvisioner.js';
import { getRootSecretStore, resolveRootPassword } from '../engines/arcade/arcadeSecretStore.js';
import { ArcadeCellPool, setArcadeCellPool } from '../engines/arcade/arcadeCellPool.js';
import { wireArcadeReplicator, type ArcadeReplicatorHandle } from '../engines/arcade/arcadeOutboxWiring.js';
import { OutboxLagCache, readEnvLagCacheConfig } from '../outbox/lagCache.js';
import { RateLimiter, buildDefaultBuckets } from '../security/rateLimit.js';
import {
    arcadeBucketConfigs,
    classifyArcadeRequest,
    arcadeTenantKeyFromPath,
} from '../security/arcadeRateClassifier.js';
import { hashToken } from '../engines/arcade/arcadeAuthResolver.js';
import { preflightKmsSelfTest } from '../engines/arcade/arcadeSecretStore.js';
import type { LoreInstance } from './server.js';

/** The tenant bearer prefix (arcadeAuthResolver.mintToken). Only a bearer with
 *  this prefix is a candidate tenant data-plane credential; anything else on a
 *  data path is an operator credential (or garbage) and is walled off. */
const TENANT_TOKEN_PREFIX = 'lore_at_';

const LORE_HTTP_PORT = parseInt(process.env['LORE_PORT'] ?? '3847', 10);

/**
 * ArcadeDaemonHandle — the arcade equivalent of DaemonWiring, carried on the
 * public instance's `_daemon` slot. main() reads it (via a trusted internal
 * cast) to open the listener under --http.
 */
export interface ArcadeDaemonHandle {
    /** Bind the operator control-plane HTTP listener + signal handlers. */
    startArcadeListener(): Promise<void>;
    /** The daemon-local relational lane (SQLite outbox + audit). Exposed so the
     *  following data-plane slice can outbox-first arcade writes without
     *  re-constructing the store. */
    readonly outboxStore: SqliteOutboxStore;
    readonly auditLog: AuditLog;
}

/**
 * requireOperatorPrincipal — the arcade listener's auth gate.
 *
 * The operator credential is the daemon token (auth.token → 64-hex, mapped to
 * a `bootstrap` principal) or the shared-secret (LORE_MCP_AUTH_TOKEN → a
 * `shared-secret` principal). BOTH resolve to the daemon-operator lane inside
 * bindDaemonOperatorLane.
 *
 * CRITICAL SECURITY PROPERTY: a tenant `lore_at_*` bearer is NOT 64-hex and is
 * NOT the shared secret, so it maps to NO principal here and is REJECTED 401
 * before any route runs. This closes the one bypass a naive gate would leave:
 * bindDaemonOperatorLane treats a `null` principal as a legacy/local ALLOW, so
 * the listener must NEVER admit a route with a null principal in arcade mode.
 * By constructing a concrete operator principal (or rejecting), the control
 * plane can only ever run for a genuine daemon operator.
 *
 * Returns the bound Principal on success; writes the 401 envelope and returns
 * null on failure (caller must return).
 */
function requireOperatorPrincipal(
    req: IncomingMessage,
    res: ServerResponse,
    authToken: string,
    sharedSecret: string | undefined,
): Principal | null {
    const authHeader = (req.headers.authorization ?? '') as string;
    const bearer = authHeader.trim().replace(/^Bearer\s+/i, '');
    if (!bearer) {
        writeError(res, 401, 'auth_required', 'operator Bearer token required');
        return null;
    }
    const lower = bearer.toLowerCase();
    if (/^[a-f0-9]{64}$/i.test(bearer) && lower === authToken.toLowerCase()) {
        // The human operator's daemon token — full daemon-operator lane.
        return {
            kind: 'bootstrap',
            workspace: 'arcade-operator',
            scopes: ['read', 'write'],
            label: 'bootstrap',
        };
    }
    if (sharedSecret && lower === sharedSecret.toLowerCase()) {
        return {
            kind: 'shared-secret',
            workspace: 'arcade-operator',
            scopes: ['read', 'write', 'cross-workspace-read', 'cross-workspace-write'],
            label: 'shared-secret',
        };
    }
    // Anything else (tenant lore_at_* token, unknown, malformed) → 401. The
    // control-plane token wall is REAL route-reachable code, not a comment.
    writeError(res, 401, 'operator_token_required', 'not a daemon-operator credential');
    return null;
}

/**
 * isOperatorBearer — true when the request's Bearer matches the daemon
 * operator token or the shared secret (the same two credentials
 * `requireOperatorPrincipal` accepts), false otherwise (missing, malformed,
 * a tenant `lore_at_*` token, or unknown).
 *
 * FINDING 4(b) (2026-09-03, Rafi DECISION) — kept separate from
 * `requireOperatorPrincipal` because that function WRITES a 401 + returns
 * on failure; the health branch below must stay 200 either way (a liveness
 * probe never fails auth) and only chooses which body to send.
 */
export function isOperatorBearer(req: IncomingMessage, authToken: string, sharedSecret: string | undefined): boolean {
    const authHeader = (req.headers.authorization ?? '') as string;
    const bearer = authHeader.trim().replace(/^Bearer\s+/i, '');
    if (!bearer) return false;
    const lower = bearer.toLowerCase();
    if (/^[a-f0-9]{64}$/i.test(bearer) && lower === authToken.toLowerCase()) return true;
    if (sharedSecret && lower === sharedSecret.toLowerCase()) return true;
    return false;
}

/**
 * arcadeDispatch — the arcade listener's request router. Health + operator
 * control plane only; everything else 501s deny-by-default so no request can
 * silently fall back to a local substrate that does not exist in this mode.
 */
async function arcadeDispatch(
    req: IncomingMessage,
    res: ServerResponse,
    deps: {
        authToken: string;
        sharedSecret: string | undefined;
        auditLog: AuditLog;
        pool: ArcadeCellPool;
        /** Slice-4 — the daemon relational-lane outbox, threaded so the migrate
         *  operator route can refuse an export/import against un-drained rows AND
         *  the tenant data plane records writes outbox-first (producer side). */
        outboxStore: SqliteOutboxStore;
        /** Slice-4 — the shared backpressure lag cache the replicator refreshes
         *  each tick; the tenant data plane reads it (per-cell keyed) to 503
         *  outbox_lag under lag. */
        outboxLagCache: OutboxLagCache;
        /** FINDING 4(a) — merged edge-relation enum threaded into the tenant
         *  data plane so POST /api/edge's pre-validation gate matches local.
         *  Schema-agnostic in arcade mode (the app owns the schema), so this is
         *  undefined by default — exactly the local no-domain-schema case, where
         *  the enum check is skipped and addEdge surfaces the backend error. */
        edgeRelations?: ReadonlyArray<string>;
        /** Slice-5 — the arcade rate limiter (operator control plane + tenant
         *  data plane). /health is exempt. */
        limiter: RateLimiter;
    },
): Promise<void> {
    const url = req.url ?? '/';
    const pathname = url.split('?')[0] ?? '/';
    const method = req.method ?? 'GET';

    // Health is unauthenticated (matches local mode's public /health) AND exempt
    // from rate limiting — checked before the limiter so /health never 429s.
    //
    // FINDING 4(b) (2026-09-03, Rafi DECISION) — an anonymous caller gets only
    // the lite liveness shape; the operator-scoped rate-limit snapshot +
    // ARCADE_BASE_URL (an internal endpoint, not for tenant/anonymous eyes)
    // are surfaced only once the request presents a valid operator Bearer.
    // Mirrors the local-mode split in diagnostic/health.ts handleHealth.
    if ((pathname === '/health' || pathname === '/api/health') && method === 'GET') {
        if (!isOperatorBearer(req, deps.authToken, deps.sharedSecret)) {
            writeJson(res, 200, { status: 'ok', version: VERSION, mode: 'arcade' });
            return;
        }
        writeJson(res, 200, {
            status: 'ok',
            version: VERSION,
            mode: 'arcade',
            arcadeBaseUrl: ARCADE_BASE_URL,
            rateLimit: deps.limiter.getConfigSnapshot(),
        });
        return;
    }

    // ── RATE LIMIT (slice 5) ─────────────────────────────────────────────
    // Classify + debit BEFORE auth/routing so an abusive principal is throttled
    // cheaply. Keying: operator ops key on the operator credential label+prefix
    // (isolating one operator's churn) plus a per-cell tenantKey from the path;
    // tenant data-plane keys on hashToken(bearer) prefix (W9 per-principal model).
    const bucketClass = classifyArcadeRequest(pathname, method);
    if (bucketClass !== null) {
        const bearer = (req.headers.authorization ?? '').toString().trim().replace(/^Bearer\s+/i, '');
        const isOperatorPath = pathname.startsWith('/api/arcade/');
        const principalKey = isOperatorPath
            ? `op:${bearer ? bearer.slice(0, 8) : 'anon'}`
            : `at:${bearer ? hashToken(bearer).slice(0, 8) : 'anon'}`;
        const tenantKey = isOperatorPath ? arcadeTenantKeyFromPath(pathname) : undefined;
        const verdict = deps.limiter.tryConsume(bucketClass, { principalKey, tenantKey });
        res.setHeader('X-RateLimit-Limit', String(verdict.limit));
        res.setHeader('X-RateLimit-Remaining', String(verdict.remaining));
        res.setHeader('X-RateLimit-Reset', String(verdict.resetSec));
        if (!verdict.allowed) {
            res.setHeader('Retry-After', String(verdict.retryAfterSec));
            writeError(res, 429, 'rate_limited', 'rate limit exceeded', {
                retryAfterSec: verdict.retryAfterSec,
            });
            return;
        }
    }

    // Operator control plane — require a daemon-operator principal, then run
    // the route family inside the principal + route-binding slot so
    // bindDaemonOperatorLane sees exactly the machinery it does in local mode.
    // A tenant lore_at_* token is NOT a daemon-operator credential, so it 401s
    // here (requireOperatorPrincipal's wall) — the control plane is off-limits
    // to tenants, unchanged.
    if (pathname.startsWith('/api/arcade/')) {
        const principal = requireOperatorPrincipal(req, res, deps.authToken, deps.sharedSecret);
        if (!principal) return;
        await runWithPrincipal(principal, () =>
            // A daemon-wide operator lane names no workspace; seed the slot with
            // an empty target (bindDaemonOperatorLane with requested:undefined
            // never reads target — it only sets lane='daemon-operator' on pass).
            runWithRouteBindingSlot({ target: '', lane: 'workspace' }, async () => {
                // Operator-route families, tried in order. Each returns true once
                // it owns the request. Policy + migrate are Slice-4 additions;
                // admin is the pre-existing onboarding surface. All gate through
                // bindDaemonOperatorLane — a tenant token can never reach any of
                // them (the listener already walled it off above).
                if (await tryArcadePolicyRoutes(req, res, pathname, { auditLog: deps.auditLog })) return;
                // Backup/restore operator family (Slice-5). Tried before migrate
                // so /backup + /restore are owned here; migrate keeps /import.
                if (
                    await tryArcadeBackupRoutes(req, res, url, pathname, {
                        auditLog: deps.auditLog,
                        outboxStore: deps.outboxStore as unknown as {
                            statsByWorkspace?: () => Promise<Record<string, { depth: number }>>;
                        },
                        evictCell: (tenantId, appId) => deps.pool.evictCell(tenantId, appId),
                    })
                )
                    return;
                if (
                    await tryArcadeMigrateRoutes(req, res, url, pathname, {
                        auditLog: deps.auditLog,
                        outboxStore: deps.outboxStore,
                        evictCell: (tenantId, appId) => deps.pool.evictCell(tenantId, appId),
                    })
                )
                    return;
                const handled = await tryArcadeAdminRoutes(req, res, url, pathname, {
                    auditLog: deps.auditLog,
                    evictToken: (t) => deps.pool.evictToken(t),
                    evictCell: (tenantId, appId) => deps.pool.evictCell(tenantId, appId),
                    // Slice-4 — destroyApp purges the cell's outbox lane too.
                    outboxStore: deps.outboxStore,
                });
                if (!handled) {
                    writeError(res, 404, 'not_found', `unmatched arcade admin path: ${method} ${pathname}`);
                }
            }),
        );
        return;
    }

    // ── TENANT DATA PLANE (Slice 3) ──────────────────────────────────────
    // Any other /api/* path is a candidate tenant data route. The reach-defining
    // input is the Bearer ALONE (arcadeAuthResolver invariant): resolve it to a
    // cell, bind, and delegate to the local route families (arcadeData.ts). The
    // allowlist inside tryArcadeDataRoutes decides what is reachable; unmatched
    // families fall through to the 501 deny-by-default below.
    if (pathname.startsWith('/api/')) {
        const bearer = (req.headers.authorization ?? '').toString().trim().replace(/^Bearer\s+/i, '');
        const looksOperator =
            bearer.length > 0 &&
            (/^[a-f0-9]{64}$/i.test(bearer) ||
                (deps.sharedSecret !== undefined && bearer.toLowerCase() === deps.sharedSecret.toLowerCase()));
        if (looksOperator) {
            // A daemon-operator credential (64-hex daemon token / shared secret)
            // on a DATA route. Operators are not cell-bound and have no data-plane
            // reach in arcade mode; wall them off explicitly so an operator token
            // never accidentally reads/writes tenant data. Checked FIRST so an
            // operator token can never be treated as a (missing) tenant token.
            writeError(
                res,
                403,
                'tenant_token_required',
                'this is a tenant data route; a daemon-operator credential has no data-plane reach in arcade mode (use a lore_at_* token)',
            );
            return;
        }
        // FINDING 4(b) — a tenant `lore_at_*` token OR a MISSING/non-operator
        // bearer on a data route both go through tryArcadeDataRoutes. On an
        // ALLOWLISTED data path the pool.resolve gate maps a missing/unknown
        // token onto the frozen 401 auth_required envelope (the tenant-facing
        // contract), instead of the ambiguous 501 the empty-bearer case fell
        // through to before. A NON-allowlisted data path still returns
        // handled=false → the 501 deny-by-default below fires unchanged (no
        // token enumeration on paths we don't serve).
        const handled = await tryArcadeDataRoutes(req, res, url, pathname, bearer, {
            pool: deps.pool,
            auditLog: deps.auditLog,
            edgeRelations: deps.edgeRelations,
            // Slice-4 PRODUCER side — record tenant writes outbox-first (the
            // replicator drains them to the cell) + backpressure via the lag
            // cache, both cell-keyed inside tryArcadeDataRoutes.
            outboxStore: deps.outboxStore,
            outboxLagCache: deps.outboxLagCache,
        });
        if (handled) return;
        // fall through to 501 for a non-allowlisted data path.
    }

    // DENY-BY-DEFAULT — every non-arcade, non-allowlisted family
    // (workspaces/sync/ingestion/import/load/schema/mcp/... and the deferred
    // data verbs) fails LOUD in arcade mode rather than half-wiring to an absent
    // local substrate.
    writeError(
        res,
        501,
        'not_supported_in_arcade_mode',
        `${method} ${pathname} is not available in arcade mode (this daemon exposes only the arcade control plane in this build)`,
    );
}

/**
 * createArcadeInstance — the entry server.ts's createLore() delegates to when
 * the effective mode is 'arcade'. Runs the boot preflight + relational-lane
 * construction, then returns a LoreInstance whose `_daemon` carries the
 * listener starter. The listener itself is opened by main() under --http.
 *
 * The returned instance's local/cloud-substrate methods (nodeUpsert, recall,
 * search, bulkIngest, createMcpServer, ...) are NOT applicable in arcade mode
 * and throw a clear error — an arcade daemon is driven over HTTP, not the
 * in-process embeddable API.
 */
export async function createArcadeInstance(input: {
    dataHome: string;
    loreDir: string;
}): Promise<LoreInstance> {
    const { dataHome, loreDir } = input;

    // ── boot preflight ───────────────────────────────────────────────────
    // (a) ARCADE_BASE_URL must be set (the provisioner reads it; a missing
    //     base URL would silently default to localhost, masking a misconfig).
    if (!process.env['ARCADE_BASE_URL']) {
        throw new Error(
            '[arcadeBoot] arcade mode requires ARCADE_BASE_URL to be set ' +
                '(the ArcadeDB HTTP endpoint, e.g. http://localhost:2480).',
        );
    }
    // (b) a real root credential must resolve (fail loud — never the spike
    //     default in arcade mode; resolveRootPassword enforces this).
    await resolveRootPassword(getRootSecretStore());
    // (c) if the secret backend is kms, self-test the envelope key (fail-closed):
    //     validate the KEK resolves + a canary DEK round-trips. No-op otherwise.
    await preflightKmsSelfTest();
    log.info(`[Lore MCP] arcade mode: ArcadeDB endpoint ${ARCADE_BASE_URL}`);

    // ── relational lane (SQLite/JSONL at LORE_HOME — never inside ArcadeDB) ─
    // AuditLog: hash-chained audit.jsonl for every control-plane op.
    const auditLog = new AuditLog();
    // Outbox: daemon-local durability store. Constructed here (its file lives
    // under loreDir) so the following data-plane slice can outbox-first arcade
    // writes; the provisioning/token registry migrations run lazily on the
    // first provisioner/authResolver call (openRegistryDb / openTokenDb).
    const outboxStore = new SqliteOutboxStore(loreDir);
    // Touch the registry path so a misconfigured LORE_HOME fails at boot, not
    // on the first provision call.
    log.info(`[Lore MCP] arcade provisioning registry at ${provisioningDbPath()}`);
    log.info(`[Lore MCP] arcade outbox at ${outboxStore.path}`);

    // ── operator token (same auth.token file local/cloud use) ────────────
    const authToken = ensureAuthToken(dataHome);
    const sharedSecret = process.env['LORE_MCP_AUTH_TOKEN'] || undefined;
    log.info(`[Lore MCP] Auth token at ${getAuthTokenPath(dataHome)} (0600)`);

    // ── tenant data-plane cell pool (Slice 3) ────────────────────────────
    // Caches the heavy per-cell pair (ArcadeHttp + stores + facade) keyed by
    // sha256(token), LRU-bounded, evicted on revoke/disable/destroy by the
    // arcadeAdmin routes. resolvePrincipal still re-runs per request (fail-
    // closed). Registered process-wide so any operator-lane caller reaches the
    // same instance the data dispatcher uses.
    const cellPool = new ArcadeCellPool();
    setArcadeCellPool(cellPool);

    // ── arcade outbox backpressure lag cache (Slice 4) ───────────────────
    // Refreshed each replicator tick from the shared store's aggregateStats
    // (keyed by the `arcade:<t>:<a>` lane column); the tenant data plane reads it
    // per-cell to 503 outbox_lag under lag. One instance, shared producer+
    // consumer, mirroring the local daemon wiring.
    const outboxLagCache = new OutboxLagCache(readEnvLagCacheConfig());

    // ── arcade rate limiter (Slice 5) ────────────────────────────────────
    // Cloud-mode defaults (per-principal buckets) MERGED with the arcade-specific
    // classes (arcade_provision/arcade_migrate/arcade_admin). autoSweep evicts
    // idle buckets; stopped in shutdown. Operator ops key on operator label+prefix
    // (+ per-cell tenantKey); tenant data plane keys on hashToken(bearer) prefix.
    const limiter = new RateLimiter(
        'cloud',
        { ...buildDefaultBuckets('cloud'), ...arcadeBucketConfigs() },
        { autoSweep: true },
    );

    // ── arcade outbox CONSUMER (Slice 4) ─────────────────────────────────
    // The replicator drains the ONE shared daemon outbox, fanning each row out
    // to its cell's RAW ArcadeDB adapters (resolved by the `arcade:<t>:<a>` lane
    // key). Arcade mode DOES own its timers (the embedded-mode gate doesn't
    // apply), so it is started after boot and stopped in shutdown. The PRODUCER
    // side (tenant routes recording outbox rows) is now wired in arcadeData.ts, so
    // the replicator drains real tenant writes; it also refreshes the lag cache
    // each tick.
    const arcadeReplicator: ArcadeReplicatorHandle = wireArcadeReplicator({
        store: outboxStore,
        lagCache: outboxLagCache,
    });

    let httpServer: HttpServer | null = null;

    // FINDING 4(a) — the edge-relation enum threaded into the tenant data plane.
    // Lore Core in arcade mode is SCHEMA-AGNOSTIC: the app owns its schema and
    // Lore loads no domain edge-relation vocabulary here, so there is no core
    // enum to gate against — undefined skips the POST /api/edge enum pre-check
    // and lets addEdge surface the backend error, byte-matching the local
    // no-domain-schema case. The dep exists so a future arcade build that DOES
    // carry a merged enum has a wired seam, rather than the gate silently drifting
    // from local.
    const edgeRelations: ReadonlyArray<string> | undefined = undefined;

    const startArcadeListener = async (): Promise<void> => {
        httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
            arcadeDispatch(req, res, { authToken, sharedSecret, auditLog, pool: cellPool, outboxStore, outboxLagCache, edgeRelations, limiter }).catch((err: unknown) => {
                log.error(`[Lore MCP] uncaught arcade dispatch error: ${(err as Error)?.stack ?? String(err)}`);
                if (!res.headersSent) {
                    writeError(res, 500, 'internal_error', 'internal error');
                }
            });
        });
        await new Promise<void>((resolve) => {
            httpServer!.listen(LORE_HTTP_PORT, '127.0.0.1', () => {
                log.info(`[Lore MCP] arcade control plane listening on http://127.0.0.1:${LORE_HTTP_PORT}`);
                resolve();
            });
        });
        // Arcade mode owns its timers (the embedded-mode maintenance gate does
        // not apply) — start the outbox replicator after the listener binds.
        arcadeReplicator.start();
        log.info('[Lore MCP] arcade outbox replicator started');
        const shutdown = (reason: string): void => {
            log.info(`[Lore MCP] arcade shutdown (${reason})`);
            try { limiter.stopSweeper(); } catch { /* already stopped */ }
            void arcadeReplicator.stop();
            try { httpServer?.close(); } catch { /* already closing */ }
            try { outboxStore.close(); } catch { /* already closed */ }
            process.exit(0);
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    };

    const daemonHandle: ArcadeDaemonHandle = { startArcadeListener, outboxStore, auditLog };

    const unsupported = (name: string): never => {
        throw new Error(
            `[arcadeBoot] ${name}() is not available in arcade mode — an arcade daemon is ` +
                `driven over HTTP (the arcade control/data plane), not the in-process embeddable API.`,
        );
    };

    const instance: LoreInstance = {
        // No local/cloud storage bundle in arcade mode; the tenant substrate is
        // per-cell and resolved per-request in the data-plane slice.
        store: undefined as unknown as LoreInstance['store'],
        deploymentMode: 'cloud',
        runMode: 'arcade',
        dataHome,
        createMcpServer: () => unsupported('createMcpServer'),
        nodeUpsert: () => Promise.reject(new Error('[arcadeBoot] nodeUpsert unsupported in arcade mode')),
        bulkIngest: () => Promise.reject(new Error('[arcadeBoot] bulkIngest unsupported in arcade mode')),
        nodeUpsertBatch: () => Promise.reject(new Error('[arcadeBoot] nodeUpsertBatch unsupported in arcade mode')),
        awaitEmbeds: () => Promise.resolve(),
        recall: () => Promise.reject(new Error('[arcadeBoot] recall unsupported in arcade mode')),
        search: () => Promise.reject(new Error('[arcadeBoot] search unsupported in arcade mode')),
        dispose: async () => {
            try { limiter.stopSweeper(); } catch { /* ignore */ }
            try { await arcadeReplicator.stop(); } catch { /* ignore */ }
            try { httpServer?.close(); } catch { /* ignore */ }
            try { outboxStore.close(); } catch { /* ignore */ }
        },
        _daemon: daemonHandle as unknown as LoreInstance['_daemon'],
    };

    return instance;
}
