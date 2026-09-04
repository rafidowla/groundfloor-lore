#!/usr/bin/env tsx
/**
 * test/arcade-delete-outbox-dispatch-unit.ts — QA A2 round-2 finding 3
 * regression (2026-09-03).
 *
 * Every node-delete surface (nodes-delete.ts, deleteNode.ts, lifecycle.ts,
 * changesetWrite.ts) unconditionally records a `verbatim.tombstone` outbox
 * row after tombstoning the verbatim mirror — correct in local mode, where
 * VerbatimStore has a real soft-tombstone. In arcade/cloud mode the resolved
 * `ArcadeVectorStore` has NO tombstone() (only a hard `delete()` — the same
 * "legacy delete" branch those callers' own `canTombstone` check already
 * takes), and BEFORE this fix `engines/arcade/arcadeOutboxWiring.ts`'s
 * DispatcherSubstrates defined no `tombstoneVerbatim` (or `getVerbatim`) at
 * all. So the arcade replicator's dispatch of a `verbatim.tombstone` row
 * threw `UnwiredOperationKindError` on FIRST attempt and the row dead-
 * lettered PERMANENTLY (never applied, never converges) — one dead row per
 * arcade delete, unbounded growth.
 *
 * Fix: arcadeOutboxWiring.ts now wires `tombstoneVerbatim` to
 * `ArcadeVectorStore.delete()` (the substrate's actual terminal-delete
 * semantic) and `getVerbatim` to `ArcadeVectorStore.getById()` (the same
 * content-witness self-heal already uses for `verbatim.upsert`).
 *
 * Shape: drives the REAL `wireArcadeReplicator()` (arcadeOutboxWiring.ts) —
 * not a hand-rolled stand-in for its substrates object — against REAL
 * `ArcadeGraphStore` / `ArcadeVectorStore` instances. Only the HTTP
 * TRANSPORT is faked (ArcadeHttp.prototype.query/command patched to an
 * in-memory per-db store), the same "fake the transport, not the adapter"
 * approach test/arcade-bulklist-ecosystem-filter-unit.ts uses — no live
 * ArcadeDB container required. The tenant-cell registry + secret store are
 * REAL (a scratch LORE_HOME's sqlite registry), seeded directly via
 * `upsertTenantAppRow` so `resolveCell()` (arcadeOutboxWiring.ts) runs its
 * genuine lookup path, not a bypass.
 *
 * Run: npx tsx test/arcade-delete-outbox-dispatch-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// LORE_HOME must be pinned BEFORE any provisioner import resolves
// loreHomePath() (mirrors test/arcade-bulk-embed-completeness-e2e.ts).
const RUN_TAG = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const LORE_HOME = path.join(os.tmpdir(), `arcade-delete-dispatch-lorehome-${RUN_TAG}`);
fs.mkdirSync(LORE_HOME, { recursive: true });
process.env['LORE_HOME'] = LORE_HOME;

import { ArcadeHttp, type ArcadeCommandResult } from '../packages/lore/src/engines/arcade/arcadeHttp.js';
import { wireArcadeReplicator } from '../packages/lore/src/engines/arcade/arcadeOutboxWiring.js';
import { arcadeCellKey } from '../packages/lore/src/engines/arcade/arcadeOutboxLane.js';
import { openRegistryDb, closeRegistryDb, upsertTenantAppRow } from '../packages/lore/src/engines/arcade/arcadeRegistryStore.js';
import { secretRefFor } from '../packages/lore/src/engines/arcade/arcadeProvisioner.js';
import { SqliteOutboxStore } from '../packages/lore/src/outbox/sqliteStore.js';
import { dispatch, verifyApplied, UnwiredOperationKindError, type DispatcherSubstrates } from '../packages/lore/src/outbox/dispatcher.js';
import type { OutboxEntry } from '../packages/lore/src/outbox/types.js';
import type { EmbeddingProvider } from '../packages/lore/src/providers/types.js';

let passed = 0, failed = 0;
const pending: Array<Promise<void>> = [];
function test(name: string, fn: () => Promise<void>): void {
    pending.push((async () => {
        try { await fn(); console.log(`  ✓ ${name}`); passed++; }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`); failed++; }
    })());
}

// ── fake ArcadeDB transport ────────────────────────────────────────────────
//
// Per-db in-memory tables keyed by id. Good enough to prove the DISPATCH
// CONTRACT (does it throw? does the row's effect converge?) without a real
// ArcadeDB server — the same trade-off arcade-bulklist-ecosystem-filter-unit.ts
// makes for bulkListArcadeNodes.
interface FakeRow { [k: string]: unknown }
const nodesByDb = new Map<string, Map<string, FakeRow>>();
const verbatimByDb = new Map<string, Map<string, FakeRow>>();
function tableFor(map: Map<string, Map<string, FakeRow>>, db: string): Map<string, FakeRow> {
    let t = map.get(db);
    if (!t) { t = new Map(); map.set(db, t); }
    return t;
}

let originalQuery: typeof ArcadeHttp.prototype.query;
let originalCommand: typeof ArcadeHttp.prototype.command;

function installFakeArcadeHttp(): void {
    originalQuery = ArcadeHttp.prototype.query;
    originalCommand = ArcadeHttp.prototype.command;
    ArcadeHttp.prototype.query = async function (
        db: string, sql: string, params: Record<string, unknown> = {},
    ): Promise<ArcadeCommandResult> {
        const id = params['id'] as string | undefined;
        if (/FROM\s+LoreNode\b/i.test(sql)) {
            const row = id ? tableFor(nodesByDb, db).get(id) : undefined;
            return { result: row ? [row] : [] };
        }
        if (/FROM\s+LoreVerbatim\b/i.test(sql)) {
            const row = id ? tableFor(verbatimByDb, db).get(id) : undefined;
            return { result: row ? [row] : [] };
        }
        return { result: [] };
    };
    ArcadeHttp.prototype.command = async function (
        db: string, sql: string, params: Record<string, unknown> = {},
    ): Promise<ArcadeCommandResult> {
        const id = params['id'] as string | undefined;
        if (/^DELETE/i.test(sql.trim())) {
            if (/FROM\s+LoreNode\b/i.test(sql) && id) tableFor(nodesByDb, db).delete(id);
            if (/FROM\s+LoreVerbatim\b/i.test(sql) && id) tableFor(verbatimByDb, db).delete(id);
        }
        // Schema DDL / UPSERT — no-op success; this suite never exercises the
        // upsert/store path, only delete + tombstone dispatch.
        return { result: [] };
    };
}
function uninstallFakeArcadeHttp(): void {
    ArcadeHttp.prototype.query = originalQuery;
    ArcadeHttp.prototype.command = originalCommand;
}

class NoopEmbedder implements EmbeddingProvider {
    get modelId() { return 'arcade-dispatch-test-noop'; }
    get dimension() { return 4; }
    async initialize() { /* no-op — never actually embeds in this suite */ }
    private vec() { return [0, 0, 0, 0]; }
    async embed() { return this.vec(); }
    async embedQuery() { return this.vec(); }
    async embedDocument() { return this.vec(); }
    async embedDocumentBatch(texts: string[]) { return texts.map(() => this.vec()); }
}

function baseEntry(over: Partial<OutboxEntry> & { id: string }): OutboxEntry {
    const now = '2026-09-03T00:00:00.000Z';
    return {
        id: over.id,
        operation: over.operation ?? 'op',
        initiator: over.initiator ?? 'test:arcade-dispatch',
        createdAt: over.createdAt ?? now,
        updatedAt: over.updatedAt ?? now,
        steps: over.steps ?? [],
        completed: over.completed ?? false,
        workspace: over.workspace,
        operationKind: over.operationKind,
        payload: over.payload,
        status: over.status,
        sequenceId: over.sequenceId,
    };
}

console.log('\narcade delete/tombstone outbox dispatch — regression (QA A2 round-2 finding 3)\n');

test('wireArcadeReplicator substrates declare tombstoneVerbatim + getVerbatim (were entirely absent before the fix)', async () => {
    installFakeArcadeHttp();
    try {
        const outboxStore = new SqliteOutboxStore(fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-dispatch-store-')));
        const wiring = wireArcadeReplicator({ store: outboxStore, embedder: new NoopEmbedder() });
        const substrates = (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
        assert.equal(typeof substrates.tombstoneVerbatim, 'function',
            'BUG: tombstoneVerbatim is unwired — every verbatim.tombstone row in arcade mode dead-letters');
        assert.equal(typeof substrates.getVerbatim, 'function',
            'BUG: getVerbatim is unwired — verbatim.tombstone self-heal cannot verify convergence');
    } finally {
        uninstallFakeArcadeHttp();
    }
});

test('a delete\'s node.delete + verbatim.tombstone rows both dispatch against arcade substrates without UnwiredOperationKindError, and converge', async () => {
    installFakeArcadeHttp();
    try {
        const tenantId = 'atest1';
        const appId = 'appx1';
        const dbName = 'db_atest1_appx1';
        const secretRef = secretRefFor(tenantId, appId);
        const registryDb = openRegistryDb();
        upsertTenantAppRow(registryDb, {
            tenantId, appId, dbName, dbUser: 'svc_user', dbPass: 'svc_pass',
            secretRef, status: 'active', createdAt: new Date().toISOString(),
        });

        // Seed the fake substrate: a live node + a live verbatim row, as if an
        // earlier create had already landed (mirrors what a real delete finds).
        const nodeId = 'arcade-delete-node';
        tableFor(nodesByDb, dbName).set(nodeId, {
            id: nodeId, type: 'note', label: 'seed', content: 'ARCADE-LIVE-CONTENT',
            tags: '[]', project: '', ecosystem: '*', metadata: '{}',
            createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
        });
        tableFor(verbatimByDb, dbName).set(`lore:${nodeId}`, {
            contentHash: 'h1', text: 'ARCADE-LIVE-CONTENT',
        });

        const outboxStore = new SqliteOutboxStore(fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-dispatch-store2-')));
        const wiring = wireArcadeReplicator({ store: outboxStore, embedder: new NoopEmbedder() });
        const substrates = (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;

        const workspace = arcadeCellKey(tenantId, appId);
        const nodeDeleteEntry = baseEntry({
            id: 'e1', operationKind: 'node.delete', workspace, payload: { id: nodeId },
        });
        const tombstoneEntry = baseEntry({
            id: 'e2', operationKind: 'verbatim.tombstone', workspace,
            payload: { id: `lore:${nodeId}`, reason: 'graph node deleted via /api/node (arcade)' },
        });

        // THE regression: before the fix this threw UnwiredOperationKindError
        // on the tombstone row (node.delete was already wired).
        await dispatch(nodeDeleteEntry, substrates);
        await assert.doesNotReject(
            dispatch(tombstoneEntry, substrates),
            (err) => {
                if (err instanceof UnwiredOperationKindError) {
                    throw new Error(`BUG CONFIRMED: verbatim.tombstone dispatch threw UnwiredOperationKindError against arcade substrates: ${err.message}`);
                }
                return false;
            },
        );

        // Convergence: the substrate no longer holds either row's target.
        assert.equal(tableFor(nodesByDb, dbName).has(nodeId), false, 'node.delete must have removed the graph row');
        assert.equal(tableFor(verbatimByDb, dbName).has(`lore:${nodeId}`), false, 'verbatim.tombstone must have removed the verbatim row (arcade delete semantics)');

        // Self-heal convergence: verifyApplied must now report the tombstone
        // row VERIFIED (absent), the same "verified" shape the local
        // substrate's real soft-tombstone produces — proving replay/self-heal
        // converges in arcade mode too, not just "didn't throw".
        const outcome = await verifyApplied(tombstoneEntry, substrates);
        assert.equal(outcome.verified, true, `verbatim.tombstone must verify as applied post-dispatch — got ${JSON.stringify(outcome)}`);

        closeRegistryDb();
    } finally {
        uninstallFakeArcadeHttp();
    }
});

test('a re-dispatch of the same verbatim.tombstone row is idempotent (already-absent id, no error)', async () => {
    installFakeArcadeHttp();
    try {
        const tenantId = 'atest2';
        const appId = 'appx2';
        const dbName = 'db_atest2_appx2';
        const secretRef = secretRefFor(tenantId, appId);
        const registryDb = openRegistryDb();
        upsertTenantAppRow(registryDb, {
            tenantId, appId, dbName, dbUser: 'svc_user', dbPass: 'svc_pass',
            secretRef, status: 'active', createdAt: new Date().toISOString(),
        });
        // Deliberately NO seeded verbatim row — models a retry after the row
        // was already deleted by a prior dispatch attempt.
        const nodeId = 'arcade-idempotent-node';

        const outboxStore = new SqliteOutboxStore(fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-dispatch-store3-')));
        const wiring = wireArcadeReplicator({ store: outboxStore, embedder: new NoopEmbedder() });
        const substrates = (wiring.replicator as unknown as { substrates: DispatcherSubstrates }).substrates;
        const workspace = arcadeCellKey(tenantId, appId);
        const tombstoneEntry = baseEntry({
            id: 'e1', operationKind: 'verbatim.tombstone', workspace,
            payload: { id: `lore:${nodeId}`, reason: 'retry after prior delete' },
        });

        await dispatch(tombstoneEntry, substrates); // must not throw on an already-absent id
        const outcome = await verifyApplied(tombstoneEntry, substrates);
        assert.equal(outcome.verified, true, 'a tombstone dispatch against an already-absent row must still verify (idempotent delete)');

        closeRegistryDb();
    } finally {
        uninstallFakeArcadeHttp();
    }
});

await Promise.all(pending);
fs.rmSync(LORE_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
