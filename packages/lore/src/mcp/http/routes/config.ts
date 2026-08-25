/**
 * config.ts — Daemon config, orphaned-resource resolution, language detect.
 *
 *   GET    /api/config             — UI config snapshot (no API keys)
 *   PATCH  /api/config             — partial config update; `apiKey` → keychain
 *   GET    /api/orphan             — current orphan-decision state
 *   POST   /api/orphan             — resolve an orphaned resource (keep|drop|reenable)
 *   POST   /api/language/detect    — language detection over a text sample
 *
 * `/api/orphan` GET/POST are exempt from the orphan-decision gate — the
 * UI must be able to read state and submit a decision while the gate is
 * blocking everything else.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GroundfloorClient } from 'groundfloor-ts-sdk';
import type { StorageBundle } from '../../services.js';
import type { WorkspaceGraph } from '../../../engines/openWorkspaceGraph.js';
import { isWorkspaceGraph } from '../../../engines/requireWorkspaceGraph.js';
import type { ConfigManager } from '../../../config/configManager.js';
import {
    setApiKey,
    hasApiKey,
    deleteApiKey,
} from '../../../config/keychain.js';
import { getCapability } from '../../../providers/llmDispatch.js';
import { gateRoute } from '../../../security/routeGate.js';
import { bindDaemonOperatorLane } from '../../../security/routeWorkspaceBinding.js';
import { writePermissionDenied } from '../../../security/rebacGate.js';
import {
    decideApproval,
    formatSelfConfirmError,
    type HumanApprovalPolicy,
} from '../../../security/humanApproval.js';
import { readBoundedBody, isPayloadTooLarge, writeOversizeError, writeError } from '../helpers.js';
import { redactError } from '../../../security/logRedact.js';
import type { LoreGraphHandle } from '../../../storage/loreStorageClient.js';

// Widened for the Kùzu removal: naming the two CONCRETE classes silently
// excluded SurrealGraph (see engines/htmlExport.ts). Need more than the
// shared handle? Feature-detect and refuse — do not re-narrow to a class.
type LoreGraph = LoreGraphHandle;

/**
 * reconfigureCache is implemented by both local engines (LocalGraph,
 * SurrealGraph) but isn't part of WorkspaceGraph's curated CLI surface
 * (engines/openWorkspaceGraph.ts) — extend locally here, same pattern as
 * topology.ts / edges.ts.
 *
 * DataplaneGraph also implements this method, but as an intentional
 * documented no-op ("kept for API compatibility so PATCH /api/config can
 * call it unconditionally" — engines/dataplaneGraph.ts). Unlike the other
 * requireWorkspaceGraph guards in this batch, an unsupported engine here
 * is a SILENT SKIP rather than a 501: the local read-cache genuinely
 * doesn't apply in cloud mode, and a PATCH that also updates the LLM
 * provider/API key shouldn't fail wholesale over a best-effort cache
 * mirror step. Uses `isWorkspaceGraph` (the no-op-preferring variant)
 * rather than `requireWorkspaceGraph` for exactly that reason.
 */
interface CacheReconfigurableGraph extends WorkspaceGraph {
    reconfigureCache(opts: { enabled?: boolean; ttlSeconds?: number; maxEntries?: number }): void;
}

export interface ConfigDeps {
    store: StorageBundle;
    configManager: ConfigManager;
    /** Allows the route to call `gateRoute` for ReBAC checks. */
    deploymentMode: 'local' | 'cloud';
    /** Dataplane handle used by ReBAC checks. Null in local mode. */
    dataplane: GroundfloorClient | null;
}

export async function tryConfigRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    _url: string,
    pathname: string,
    deps: ConfigDeps,
): Promise<boolean> {
    if (pathname === '/api/orphan' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ blocking: false, orphans: [] }));
        return true;
    }

    // Declarative tier metadata for the drop variant. Owned here so
    // both the back-compat path on /api/orphan (when decision='drop')
    // and the new /api/orphan/drop endpoint share one source of truth.
    const orphanDropPolicy: HumanApprovalPolicy = {
        tier: 'self-confirm',
        confirmToken: 'DROP',
        rationale: 'destructive: drops an orphaned resource + its workspace data',
    };

    if (pathname === '/api/orphan' && req.method === 'POST') {
        // Back-compat: still accepts decision: 'keep' | 'drop' | 'reenable'.
        // For drop, applies the same confirmToken='DROP' policy as the
        // new /api/orphan/drop endpoint. New clients should prefer
        // /api/orphan/drop for the destructive path.
        const gateRead = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'write' },
        );
        if (!gateRead.allowed) { writePermissionDenied(res, gateRead); return true; }
        let body: string;
        try {
            body = await readBoundedBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_json_body', redactError(err));
            return true;
        }
        try {
            const parsed = JSON.parse(body || '{}') as {
                resource?: string;
                plugin?: string; // legacy field — accepted for back-compat
                decision?: 'keep' | 'drop' | 'reenable';
                confirm?: string;
            };
            const resource = parsed.resource ?? parsed.plugin;
            const { decision, confirm } = parsed;
            if (!resource || !decision) {
                writeError(res, 400, 'invalid_request_body', 'resource and decision required');
                return true;
            }
            // RC2 audit (2026-05-17): without the enum check, an
            // adversarial caller sending `decision: 'deletealldata'`
            // was accepted, `resolveOrphan` mapped the unknown value
            // to 'reenabled' silently, and the orphan list was cleared
            // — defeating the gate without any keep/drop/reenable
            // semantics actually running.
            if (decision !== 'keep' && decision !== 'drop' && decision !== 'reenable') {
                writeError(res, 400, 'invalid_request_body', "decision must be one of: 'keep', 'drop', 'reenable'");
                return true;
            }
            if (decision === 'drop') {
                // Extra delete-permission check + declarative confirm.
                const dropGate = await gateRoute(
                    { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
                    { permission: 'delete' },
                );
                if (!dropGate.allowed) { writePermissionDenied(res, dropGate); return true; }
                const d = decideApproval({ policy: orphanDropPolicy, args: { confirm } });
                if (d.kind === 'needs-self-confirm') {
                    const env = formatSelfConfirmError('orphan_drop', d, orphanDropPolicy.rationale);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(env));
                    return true;
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                resolved: resource,
                decision,
                orphanState: { blocking: false, orphans: [] },
                config: {},
            }));
        } catch (err) {
            writeError(res, 400, 'invalid_request_body', redactError(err));
        }
        return true;
    }

    // New endpoint - dedicated drop path. Cleaner contract than
    // /api/orphan with decision='drop': body is just { resource, confirm },
    // declarative tier is the single source of truth, ReBAC gate is
    // 'delete' not 'write'. New clients should use this.
    if (pathname === '/api/orphan/drop' && req.method === 'POST') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'delete' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        let body: string;
        try {
            body = await readBoundedBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_json_body', redactError(err));
            return true;
        }
        try {
            const parsedDrop = JSON.parse(body || '{}') as {
                resource?: string;
                plugin?: string; // legacy field — accepted for back-compat
                confirm?: string;
            };
            const resource = parsedDrop.resource ?? parsedDrop.plugin;
            const { confirm } = parsedDrop;
            if (!resource) {
                writeError(res, 400, 'invalid_request_body', 'resource required');
                return true;
            }
            const d = decideApproval({ policy: orphanDropPolicy, args: { confirm } });
            if (d.kind === 'needs-self-confirm') {
                const env = formatSelfConfirmError('orphan_drop', d, orphanDropPolicy.rationale);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(env));
                return true;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                resolved: resource,
                decision: 'drop',
                orphanState: { blocking: false, orphans: [] },
                config: {},
            }));
        } catch (err) {
            writeError(res, 400, 'invalid_request_body', redactError(err));
        }
        return true;
    }

    // UI config read: returns the live config (without API keys).
    if (pathname === '/api/config' && req.method === 'GET') {
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        try {
            const cfg = deps.configManager.read();
            const hasKey = await hasApiKey(cfg.llmProvider);
            const capability = getCapability(cfg.llmProvider, cfg.llmProvider === 'ollama' ? cfg.ollamaModel : undefined);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...cfg, hasApiKey: hasKey, capability }));
        } catch (err) {
            writeError(res, 500, 'internal_error', redactError(err));
        }
        return true;
    }

    // UI config write: PATCH partial updates. `apiKey` goes to keychain;
    // all other fields merge into .lore/config.json.
    if (pathname === '/api/config' && req.method === 'PATCH') {
        // Daemon-wide config edits (LLM provider, embedding backend,
        // API keys via keychain). Treat as administer.
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'administer' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        // L-068/D-021 — per-token write-scope gate: gateRoute above is a no-op in
        // local mode. Config (LLM provider, embedding backend, API keys) is
        // daemon-wide, not per-workspace, so this uses the daemon-operator lane
        // rather than a single-workspace bind.
        if (!bindDaemonOperatorLane(res, { intent: 'write' })) return true;
        let body: string;
        try {
            body = await readBoundedBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_json_body', redactError(err));
            return true;
        }
        try {
            const update = JSON.parse(body || '{}') as Record<string, unknown>;
            // RC2 audit (2026-05-17): without this, an adversarial
            // caller sending `[1,2,3]` or `true` had the body coerced
            // through configManager.patch with no warning. Reject
            // non-plain-object bodies up front.
            if (!update || typeof update !== 'object' || Array.isArray(update)) {
                writeError(res, 400, 'invalid_request_body', 'body must be a JSON object');
                return true;
            }
            const { apiKey, ...configFields } = update;
            const next = deps.configManager.patch(configFields);
            // TW-6b: keepEmbeddedModelHot removed with the chat surface;
            // no keep-hot mirroring needed.
            // Q1.3 — mirror the read-cache settings to the running local
            // graph so a Settings flip takes effect without a daemon
            // restart. The env killswitch LORE_CACHE_DISABLED=1 still
            // wins. reconfigureCache isn't on LoreGraphHandle; skip
            // silently on an unsupported engine (see CacheReconfigurableGraph
            // doc comment above for why this is a skip, not a 501).
            if (next.localCache && isWorkspaceGraph(deps.store.loreGraph)) {
                (deps.store.loreGraph as CacheReconfigurableGraph).reconfigureCache(next.localCache);
            }
            if (typeof apiKey === 'string' && apiKey.length > 0) {
                const ok = await setApiKey(next.llmProvider, apiKey);
                if (!ok) {
                    writeError(res, 500, 'internal_error', 'keychain write failed');
                    return true;
                }
            } else if (apiKey === null) {
                await deleteApiKey(next.llmProvider);
            }
            const hasKey = await hasApiKey(next.llmProvider);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...next, hasApiKey: hasKey, capability: getCapability(next.llmProvider, next.llmProvider === 'ollama' ? next.ollamaModel : undefined) }));
        } catch (err) {
            writeError(res, 400, 'invalid_request_body', redactError(err));
        }
        return true;
    }

    if (pathname === '/api/language/detect' && req.method === 'POST') {
        // Stateless utility - body in, language code out. No state read
        // or written. Gate as read so cloud actors with read access can
        // still call it.
        const gate = await gateRoute(
            { deploymentMode: deps.deploymentMode, dataplane: deps.dataplane },
            { permission: 'read' },
        );
        if (!gate.allowed) { writePermissionDenied(res, gate); return true; }
        let body: string;
        try {
            body = await readBoundedBody(req);
        } catch (err) {
            if (isPayloadTooLarge(err)) { writeOversizeError(res); return true; }
            writeError(res, 400, 'invalid_json_body', redactError(err));
            return true;
        }
        try {
            const payload = JSON.parse(body || '{}') as { text?: string; threshold?: number; minLength?: number };
            if (typeof payload.text !== 'string') {
                writeError(res, 400, 'invalid_request_body', '`text` (string) is required');
                return true;
            }
            const { detectLanguage } = await import('../../../engines/language.js');
            const result = detectLanguage(payload.text, {
                threshold: payload.threshold,
                minLength: payload.minLength,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch (detectErr) {
            writeError(res, 500, 'internal_error', redactError(detectErr));
        }
        return true;
    }

    return false;
}
