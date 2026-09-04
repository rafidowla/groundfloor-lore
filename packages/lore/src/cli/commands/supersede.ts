import fs from 'fs';
import http from 'http';
import { loreHome, loreHomePath } from '../../config/loreHome.js';
import { withTransactionConflictRetry } from '../../engines/transactionConflictRetry.js';
import { MAX_NODE_FIELD_BYTES, exceedsNodeFieldCap } from '../../engines/nodeFieldLimits.js';
import { openGraphForCli } from './shared.js';
import { DEFAULT_PORT } from './migrateWorkspaceToWorkspaceShared.js';

async function tryHttpSupersede(oldId: string, newId: string, reason: string | undefined): Promise<{ ok: boolean; reason?: string } | null> {
    let token: string | null = null;
    try {
        token = fs.readFileSync(loreHomePath('auth.token'), 'utf-8').trim();
    } catch {
        return null;
    }
    if (!token) return null;
    return new Promise((resolve) => {
        const payload = JSON.stringify({ oldId, newId, reason });
        const req = http.request(
            `http://127.0.0.1:${DEFAULT_PORT}/api/node/supersede`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload).toString(),
                    'Authorization': `Bearer ${token}`,
                },
                timeout: 5000,
            },
            (res) => {
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(body) as { ok: boolean; reason?: string }); } catch { resolve(null); }
                });
            },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(payload);
        req.end();
    });
}

export async function supersedeCommand(args: string[]): Promise<void> {
    const positional = args.filter((a) => !a.startsWith('--'));
    const oldId = positional[0];
    const newId = positional[1];
    if (!oldId || !newId) {
        console.error('usage: lore supersede <oldId> <newId> [--reason "free-form note"]');
        process.exit(1);
    }
    const reasonIdx = args.indexOf('--reason');
    const reason = reasonIdx >= 0 ? args[reasonIdx + 1] : undefined;
    // QA finding 2 (A4 round E, 2026-09-03) — DATA_CONTRACT.md's reason cap
    // (MAX_NODE_FIELD_BYTES, UTF-8 bytes) is enforced by the daemon route
    // (POST /api/node/supersede) when a daemon is running, but the no-daemon
    // fallback below calls graph.supersedeNode() directly with zero
    // validation. Check up front so BOTH paths are capped identically.
    if (reason !== undefined && exceedsNodeFieldCap(reason)) {
        console.error(`✗ --reason exceeds the ${MAX_NODE_FIELD_BYTES}-byte limit`);
        process.exit(1);
    }

    console.log('');
    console.log(`Supersede: ${oldId}  →  ${newId}`);
    if (reason) console.log(`  Reason:  ${reason}`);
    console.log('');

    const httpResult = await tryHttpSupersede(oldId, newId, reason);
    if (httpResult) {
        if (httpResult.ok) {
            console.log(`✓ Marked '${oldId}' as superseded by '${newId}'.`);
            console.log('');
            console.log(`(Routed through the running Lore daemon at 127.0.0.1:${DEFAULT_PORT}.)`);
            return;
        }
        console.error(`✗ Could not supersede: ${httpResult.reason ?? 'unknown'}`);
        console.error('  Common causes: oldId or newId not found, or oldId === newId.');
        process.exit(1);
    }

    const basePath = loreHome();
    // Finding 11 (round E) — the HTTP attempt above already tried the
    // daemon; this direct-open fallback is what used to sit in the ~15s
    // openSurreal retry storm. tryHttpSupersede() above now resolves
    // DEFAULT_PORT (LORE_PORT-aware) instead of a hardcoded 3847, so this
    // fallback fires only when the HTTP attempt genuinely misses the daemon
    // (missing/stale auth token, daemon down, timeout). Refuse fast with a
    // clear message instead of the raw driver error.
    const graph = await openGraphForCli(basePath);
    const result = await graph.supersedeNode(oldId, newId, reason);
    if (result.ok) {
        // Parity with the supersede_node MCP tool / REST route: also record
        // the semantic `supersedes` edge so traverse()/subgraph show the
        // supersession. The daemon path gets this via POST /api/node/supersede;
        // this local fallback has no outbox (a daemon concern), so write the
        // edge directly. Non-fatal: supersededBy stays authoritative.
        try {
            await withTransactionConflictRetry(() => graph.addEdge({
                sourceId: newId,
                targetId: oldId,
                relation: 'supersedes',
                confidence: 'extracted',
                confidenceScore: 1.0,
            }));
        } catch (edgeErr) {
            console.warn(`warn: could not record supersedes edge ${newId}->${oldId} (non-fatal): ${(edgeErr as Error).message}`);
        }
    }
    await graph.close();
    if (result.ok) {
        console.log(`✓ Marked '${oldId}' as superseded by '${newId}'.`);
    } else {
        console.error(`✗ Could not supersede: ${result.reason}`);
        process.exit(1);
    }
}
