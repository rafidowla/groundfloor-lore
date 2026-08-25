#!/usr/bin/env tsx
/**
 * test/sdk-smoke-e2e.ts — Phase 2 end-to-end proof.
 *
 * Spins up a real `GroundfloorClient` from `groundfloor-ts-sdk`,
 * points it at the live local Lore daemon (default
 * http://127.0.0.1:3847), and exercises the full SDK CRUD flow:
 *   createCollection → insert → get → query → update → delete
 *
 * If this passes, the Phase 2 promise is real: the same SDK code
 * targets Lore (local) or Dataplane (cloud) by changing only the
 * base URL.
 *
 * SKIP behavior: if the daemon isn't reachable on the expected URL
 * the test prints a note and exits 0 (so CI / a fresh checkout
 * without a running daemon don't fail). Run with LORE_BASE_URL +
 * LORE_AUTH_TOKEN to point at a different daemon.
 */

import { strict as assert } from 'node:assert';
import { GroundfloorClient } from 'groundfloor-ts-sdk';

const BASE_URL = process.env.LORE_BASE_URL ?? 'http://127.0.0.1:3847';
const TOKEN = process.env.LORE_AUTH_TOKEN
    ?? process.env.LORE_MCP_AUTH_TOKEN
    ?? '';

async function reachable(): Promise<boolean> {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(`${BASE_URL}/health`, { signal: ctrl.signal });
        clearTimeout(t);
        return r.ok;
    } catch { return false; }
}

async function bootstrapToken(): Promise<string | null> {
    try {
        const r = await fetch(`${BASE_URL}/api/auth/bootstrap`);
        if (!r.ok) return null;
        const j = await r.json() as { token?: string };
        return j.token ?? null;
    } catch { return null; }
}

async function main() {
    if (!await reachable()) {
        console.log('SKIP: Lore daemon not reachable at', BASE_URL);
        console.log('      Start it with `launchctl load -w ~/Library/LaunchAgents/com.groundfloor.lore.plist`');
        console.log('      or set LORE_BASE_URL to point elsewhere.');
        process.exit(0);
    }

    const token = TOKEN || await bootstrapToken();
    if (!token) {
        console.log('SKIP: no Lore auth token available (set LORE_AUTH_TOKEN or ensure /api/auth/bootstrap is reachable)');
        process.exit(0);
    }

    const client = new GroundfloorClient(BASE_URL, token);

    // Unique table per run so back-to-back runs don't collide on PK.
    const tableName = `sdk_smoke_${Date.now()}`;
    const schema = {
        name: tableName,
        description: 'Phase 2 SDK smoke test',
        fields: [
            { name: 'id', field_type: 'string', primary_key: true, required: true },
            { name: 'amount', field_type: 'integer' },
            { name: 'note', field_type: 'string' },
        ],
    };

    console.log(`SDK smoke against ${BASE_URL} (table=${tableName})`);

    /* createCollection */
    const created = await client.createCollection(schema);
    assert.equal(created.name, tableName);
    console.log('  ✓ createCollection');

    /* insert */
    const inserted = await client.insert(tableName, { id: 'row-1', amount: 100, note: 'hello' });
    assert.equal((inserted as { id: string }).id, 'row-1');
    console.log('  ✓ insert');

    /* get */
    const got = await client.get<{ amount: number }>(tableName, 'row-1');
    assert.equal(got.amount, 100);
    console.log('  ✓ get');

    /* query */
    const q = await client.query(tableName, { filter: { eq: { id: 'row-1' } } });
    assert.equal(q.records.length, 1);
    console.log('  ✓ query');

    /* update */
    const updated = await client.update(tableName, { eq: { id: 'row-1' } }, { note: 'updated' });
    assert.equal(updated.updated, 1);
    const after = await client.get<{ note: string }>(tableName, 'row-1');
    assert.equal(after.note, 'updated');
    console.log('  ✓ update');

    /* delete */
    const deleted = await client.delete(tableName, { eq: { id: 'row-1' } });
    assert.equal(deleted.deleted, 1);
    console.log('  ✓ delete');

    /* ── Phase 2.5 bulk variants ───────────────────────────── */

    /* bulkInsert */
    const bulk = await client.bulkInsert(tableName, [
        { id: 'b1', amount: 10 },
        { id: 'b2', amount: 20 },
        { id: 'b3', amount: 30 },
    ]);
    assert.equal(bulk.inserted, 3);
    assert.equal(bulk.total_requested, 3);
    console.log('  ✓ bulkInsert');

    /* count (no filter) */
    const totalCount = await client.count(tableName);
    assert.equal(totalCount, 3);
    console.log('  ✓ count (no filter)');

    /* count (with filter) */
    const filteredCount = await client.count(tableName, { eq: { id: 'b1' } });
    assert.equal(filteredCount, 1);
    console.log('  ✓ count (with filter)');

    /* updateByQuery */
    const updatedByQuery = await client.updateByQuery(tableName, { eq: { id: 'b1' } }, { amount: 999 });
    assert.equal(updatedByQuery.updated, 1);
    console.log('  ✓ updateByQuery');

    /* deleteByQuery */
    const deletedByQuery = await client.deleteByQuery(tableName, { eq: { id: 'b1' } });
    assert.equal(deletedByQuery.deleted, 1);
    console.log('  ✓ deleteByQuery');

    /* truncate (final wipe) */
    const truncated = await client.truncate(tableName);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.deleted, 2); // b2 + b3 left after delete-by-query removed b1
    console.log('  ✓ truncate');

    /* count after truncate */
    const finalCount = await client.count(tableName);
    assert.equal(finalCount, 0);
    console.log('  ✓ count after truncate');

    console.log('\n  Phase 2 + 2.5 SDK parity proven: full SDK CRUD + bulk variants work against local Lore.');
}

main().catch(err => {
    console.error('  ✗ SDK smoke failed:', (err as Error).message);
    process.exit(1);
});
