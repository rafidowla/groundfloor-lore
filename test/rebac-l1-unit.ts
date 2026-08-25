#!/usr/bin/env tsx
/**
 * test/rebac-l1-unit.ts — T1b unit tests
 *
 * Exercises:
 *   - DDL idempotency (ensureSchema runs twice, no error)
 *   - grant / revoke / has are exact-match
 *   - grant rejects non-ReBAC relation names
 *   - listSubjectRelations / listResourceGrants / listSubjectGrants
 *   - hasEffective covers:
 *       * direct grant
 *       * grant via group membership (subject -member-> group -editor-> resource)
 *       * grant via parent inheritance (subject -editor-> portfolio -parent<- property)
 *   - findUnknownPermissionRelations across schema
 *
 * Two-property-managers scenario (the case Rafi flagged):
 *   Alice editor-of PropertyA, Bob editor-of PropertyB. Alice CAN edit
 *   leases under PropertyA (via parent inheritance) and CANNOT edit
 *   leases under PropertyB.
 *
 * Shares one store across the process and resets data between tests. The
 * original reason was that repeated open/close cycles segfaulted kuzu-lite's
 * WASM finalizer on macOS; that constraint is gone with the engine, but the
 * shape is kept because it is also simply faster.
 */

import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    RebacStore,
    isRebacRelation,
    findUnknownPermissionRelations,
} from '../packages/lore/src/security/rebac.js';
import {
    DEFAULT_SCHEMA_V2,
    REBAC_RELATION_EDGES,
    type LoreSchemaV2,
} from '../packages/lore/src/schemas/types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void> | void) {
    return Promise.resolve()
        .then(() => fn())
        .then(
            () => {
                console.log(`  ✓ ${name}`);
                passed++;
            },
            (err: Error) => {
                console.error(`  ✗ ${name}`);
                console.error(`    ${err.message}`);
                failed++;
            },
        );
}

// One store for the whole process; data reset between tests.
let _shared: { store: RebacStore; nodes: Set<string> } | null = null;

async function getShared(): Promise<{ store: RebacStore; nodes: Set<string> }> {
    if (_shared) {
        // Reset between tests: clear tuples, then the node set.
        await _shared.store.clearAll();
        _shared.nodes.clear();
        return _shared;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rebac-l1-test-'));
    // The graph node set the endpoint probe answers from. On Kùzu this was a
    // real LoreNode table; the store no longer cares which engine supplies it,
    // which is the point of the injected probe.
    const nodes = new Set<string>();
    const store = new RebacStore(path.join(dir, 'rebac.sqlite'), async (ids) =>
        new Set(ids.filter((id) => nodes.has(id))));
    await store.ensureSchema();
    _shared = { store, nodes };
    process.on('exit', () => {
        try { store.close(); } catch { /* ignore */ }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
    return _shared;
}

function seedNode(nodes: Set<string>, id: string, _label: string): void {
    nodes.add(id);
}

async function main() {
    console.log('rebac L1 — T1b');

    /* ---------- DDL idempotency ---------- */

    await test('ensureSchema is idempotent', async () => {
        const f = await getShared();
        // Already called once in getShared; second and third calls must not throw.
        await f.store.ensureSchema();
        await f.store.ensureSchema();
    });

    /* ---------- isRebacRelation ---------- */

    await test('isRebacRelation accepts the five names and rejects others', () => {
        for (const r of REBAC_RELATION_EDGES.map(e => e.name)) {
            assert.equal(isRebacRelation(r), true, `${r} should be valid`);
        }
        assert.equal(isRebacRelation('superhero'), false);
        assert.equal(isRebacRelation('Owner'), false, 'case-sensitive');
    });

    /* ---------- grant / has / revoke ---------- */

    await test('grant inserts; has detects; revoke removes', async () => {
        const f = await getShared();
        seedNode(f.nodes, 'alice', 'Alice');
        seedNode(f.nodes, 'workspaceA', 'Workspace A');

        assert.equal(
            await f.store.has('alice', 'editor', 'workspaceA'),
            false,
            'no edge yet',
        );

        const created = await f.store.grant({
            subject: 'alice',
            relation: 'editor',
            resource: 'workspaceA',
            grantedBy: 'system',
        });
        assert.equal(created, true);
        assert.equal(
            await f.store.has('alice', 'editor', 'workspaceA'),
            true,
        );

        // Idempotent — second grant returns false (no new edge).
        const again = await f.store.grant({
            subject: 'alice',
            relation: 'editor',
            resource: 'workspaceA',
            grantedBy: 'system',
        });
        assert.equal(again, false, 'grant idempotent');

        const revoked = await f.store.revoke('alice', 'editor', 'workspaceA');
        assert.equal(revoked, true);
        assert.equal(
            await f.store.has('alice', 'editor', 'workspaceA'),
            false,
        );

        const noOp = await f.store.revoke('alice', 'editor', 'workspaceA');
        assert.equal(noOp, false, 'revoke is idempotent');
    });

    /* ---------- grant must not report phantom success ---------- */
    //
    // `grant()` issues `MATCH (s),(r) CREATE (s)-[e]->(r)`. When an endpoint is
    // absent Kùzu binds nothing, creates nothing and raises nothing — and the
    // pre-fix version returned `true`. A false success in an authorization
    // function is the worst shape available here: the caller believes access
    // was granted, every later has() disagrees.
    //
    // Note these run against a LoreNode table the harness has just EMPTIED,
    // which is precisely the state a workspace has when its graph substrate is
    // not Kùzu (DECISIONS.md DEC-SURREAL-REBAC) — not a synthetic one-off id.

    await test('grant with a missing SUBJECT throws and names the subject', async () => {
        const f = await getShared();
        seedNode(f.nodes, 'workspaceA', 'Workspace A');   // resource exists
        await assert.rejects(
            () => f.store.grant({
                subject: 'ghost-subject',
                relation: 'editor',
                resource: 'workspaceA',
                grantedBy: 'system',
            }),
            (err: Error) => {
                assert.equal(err.name, 'RebacGrantFailedError', 'a named, catchable type');
                assert.match(err.message, /ghost-subject/, 'the error names WHICH id is missing');
                assert.match(err.message, /subject/, 'and which ROLE that id played');
                assert.ok(!err.message.includes("resource 'workspaceA'"),
                    'and does not blame the endpoint that was present');
                return true;
            },
        );
    });

    await test('grant with a missing RESOURCE throws and names the resource', async () => {
        const f = await getShared();
        seedNode(f.nodes, 'alice', 'Alice');              // subject exists
        await assert.rejects(
            () => f.store.grant({
                subject: 'alice',
                relation: 'editor',
                resource: 'ghost-resource',
                grantedBy: 'system',
            }),
            (err: Error) => {
                assert.equal(err.name, 'RebacGrantFailedError');
                assert.match(err.message, /ghost-resource/);
                assert.match(err.message, /resource/);
                return true;
            },
        );
    });

    await test('grant with BOTH endpoints missing names both', async () => {
        const f = await getShared();
        await assert.rejects(
            () => f.store.grant({
                subject: 'ghost-s',
                relation: 'owner',
                resource: 'ghost-r',
                grantedBy: 'system',
            }),
            (err: Error) => {
                assert.match(err.message, /ghost-s/);
                assert.match(err.message, /ghost-r/);
                return true;
            },
        );
    });

    await test('a failed grant leaves NO partial state', async () => {
        const f = await getShared();
        seedNode(f.nodes, 'alice', 'Alice');
        await f.store.grant({
            subject: 'alice', relation: 'viewer', resource: 'ghost-resource', grantedBy: 'system',
        }).catch(() => undefined);
        assert.equal(
            await f.store.has('alice', 'viewer', 'ghost-resource'),
            false,
            'the triple must not be readable after the throw',
        );
        assert.deepEqual(
            await f.store.listSubjectGrants('alice'),
            [],
            'and the subject has no grants at all',
        );
    });

    await test('REGRESSION: the happy path is untouched (true, has, idempotent false)', async () => {
        // The fix adds two probes around the CREATE. This asserts they did not
        // change the contract callers already rely on.
        const f = await getShared();
        seedNode(f.nodes, 'alice', 'Alice');
        seedNode(f.nodes, 'workspaceA', 'Workspace A');

        assert.equal(
            await f.store.grant({
                subject: 'alice', relation: 'owner', resource: 'workspaceA', grantedBy: 'system',
            }),
            true,
            'a real grant still returns true',
        );
        assert.equal(await f.store.has('alice', 'owner', 'workspaceA'), true, 'and is readable');
        assert.equal(
            await f.store.grant({
                subject: 'alice', relation: 'owner', resource: 'workspaceA', grantedBy: 'system',
            }),
            false,
            'a repeat is still an idempotent no-op — NOT a throw',
        );
    });

    await test('a self-grant (subject === resource) is not mistaken for a missing endpoint', async () => {
        // The endpoint probe returns ONE row for a self-grant; checking a set
        // rather than a row count is what keeps this from failing spuriously.
        const f = await getShared();
        seedNode(f.nodes, 'selfie', 'Selfie');
        assert.equal(
            await f.store.grant({
                subject: 'selfie', relation: 'parent', resource: 'selfie', grantedBy: 'system',
            }),
            true,
        );
        assert.equal(await f.store.has('selfie', 'parent', 'selfie'), true);
    });

    await test('grant with an ALREADY-EXPIRED expiresAt still succeeds (write, not permission)', async () => {
        // The post-write check must be expiry-INSENSITIVE. Verifying with has()
        // would throw here even though the edge was created correctly — the
        // grant is simply already dead, which is a caller decision, not a
        // substrate fault.
        const f = await getShared();
        seedNode(f.nodes, 'alice', 'Alice');
        seedNode(f.nodes, 'workspaceA', 'Workspace A');
        assert.equal(
            await f.store.grant({
                subject: 'alice',
                relation: 'viewer',
                resource: 'workspaceA',
                grantedBy: 'system',
                expiresAt: '2000-01-01T00:00:00.000Z',
            }),
            true,
            'the write succeeded',
        );
        assert.equal(
            await f.store.has('alice', 'viewer', 'workspaceA'),
            false,
            'but the grant is expired, so it confers nothing',
        );
    });

    // RA2-reaudit2 — time-bound grants must be enforced; an expired edge must
    // not pass has() (previously expiresAt was stored but never checked).
    await test('expired grant is NOT effective; future grant is', async () => {
        const f = await getShared();
        seedNode(f.nodes, 'expsub', 'ExpSubject');
        seedNode(f.nodes, 'expres', 'ExpResource');

        await f.store.grant({ subject: 'expsub', relation: 'viewer', resource: 'expres', grantedBy: 'system', expiresAt: '2000-01-01T00:00:00.000Z' });
        assert.equal(await f.store.has('expsub', 'viewer', 'expres'), false, 'expired grant must not pass');
        assert.deepEqual(await f.store.listSubjectRelations('expsub', 'expres'), [], 'expired grant not listed as effective');

        await f.store.revoke('expsub', 'viewer', 'expres');
        await f.store.grant({ subject: 'expsub', relation: 'viewer', resource: 'expres', grantedBy: 'system', expiresAt: '2999-01-01T00:00:00.000Z' });
        assert.equal(await f.store.has('expsub', 'viewer', 'expres'), true, 'unexpired grant passes');
    });

    await test('grant rejects unknown relation names', async () => {
        const f = await getShared();
        seedNode(f.nodes, 'alice', 'Alice');
        seedNode(f.nodes, 'workspaceA', 'Workspace A');
        await assert.rejects(
            () => f.store.grant({
                subject: 'alice',
                relation: 'superhero' as 'editor',
                resource: 'workspaceA',
                grantedBy: 'system',
            }),
            /not a ReBAC relation/,
        );
    });

    /* ---------- listing ---------- */

    await test('listSubjectRelations / listResourceGrants / listSubjectGrants', async () => {
        const f = await getShared();
        seedNode(f.nodes, 'alice', 'Alice');
        seedNode(f.nodes, 'bob', 'Bob');
        seedNode(f.nodes, 'pA', 'Property A');

        await f.store.grant({ subject: 'alice', relation: 'editor', resource: 'pA', grantedBy: 'sys' });
        await f.store.grant({ subject: 'alice', relation: 'viewer', resource: 'pA', grantedBy: 'sys' });
        await f.store.grant({ subject: 'bob', relation: 'viewer', resource: 'pA', grantedBy: 'sys' });

        const aliceOnPA = await f.store.listSubjectRelations('alice', 'pA');
        assert.deepEqual(aliceOnPA.sort(), ['editor', 'viewer']);

        const grantsOnPA = await f.store.listResourceGrants('pA');
        assert.equal(grantsOnPA.length, 3);
        const subjects = new Set(grantsOnPA.map(g => g.subject));
        assert.ok(subjects.has('alice'));
        assert.ok(subjects.has('bob'));

        const aliceGrants = await f.store.listSubjectGrants('alice');
        assert.equal(aliceGrants.length, 2);
    });

    /* ---------- hasEffective ---------- */

    await test('hasEffective: direct grant satisfies', async () => {
        const f = await getShared();
        seedNode(f.nodes, 'alice', 'Alice');
        seedNode(f.nodes, 'pA', 'Property A');
        await f.store.grant({ subject: 'alice', relation: 'editor', resource: 'pA', grantedBy: 'sys' });
        assert.equal(await f.store.hasEffective('alice', 'editor', 'pA'), true);
    });

    await test('hasEffective: group membership inherits relation', async () => {
        const f = await getShared();
        seedNode(f.nodes, 'alice', 'Alice');
        seedNode(f.nodes, 'editorsGroup', 'Editors group');
        seedNode(f.nodes, 'pA', 'Property A');
        await f.store.grant({ subject: 'alice', relation: 'member', resource: 'editorsGroup', grantedBy: 'sys' });
        await f.store.grant({ subject: 'editorsGroup', relation: 'editor', resource: 'pA', grantedBy: 'sys' });
        assert.equal(
            await f.store.has('alice', 'editor', 'pA'),
            false,
            'no direct edge',
        );
        assert.equal(
            await f.store.hasEffective('alice', 'editor', 'pA'),
            true,
            'effective via group',
        );
    });

    await test('hasEffective: parent inheritance — Lease under PropertyA inherits editor from PropertyA', async () => {
        const f = await getShared();
        seedNode(f.nodes, 'alice', 'Alice');
        seedNode(f.nodes, 'pA', 'Property A');
        seedNode(f.nodes, 'lease1', 'Lease 1');

        await f.store.grant({ subject: 'alice', relation: 'editor', resource: 'pA', grantedBy: 'sys' });
        // Lease1 -parent-> PropertyA. The parent edge points from child to parent.
        await f.store.grant({ subject: 'lease1', relation: 'parent', resource: 'pA', grantedBy: 'sys' });

        assert.equal(
            await f.store.has('alice', 'editor', 'lease1'),
            false,
            'no direct grant on lease1',
        );
        assert.equal(
            await f.store.hasEffective('alice', 'editor', 'lease1'),
            true,
            'editor on parent property propagates down',
        );
    });

    await test('hasEffective: two-property-managers scenario — Alice cannot reach Bob\'s lease', async () => {
        const f = await getShared();
        // The case Rafi flagged. Two PMs, two different properties.
        seedNode(f.nodes, 'alice', 'Alice');
        seedNode(f.nodes, 'bob', 'Bob');
        seedNode(f.nodes, 'pA', 'Property A');
        seedNode(f.nodes, 'pB', 'Property B');
        seedNode(f.nodes, 'leaseA', 'Lease on A');
        seedNode(f.nodes, 'leaseB', 'Lease on B');

        await f.store.grant({ subject: 'alice', relation: 'editor', resource: 'pA', grantedBy: 'sys' });
        await f.store.grant({ subject: 'bob', relation: 'editor', resource: 'pB', grantedBy: 'sys' });
        await f.store.grant({ subject: 'leaseA', relation: 'parent', resource: 'pA', grantedBy: 'sys' });
        await f.store.grant({ subject: 'leaseB', relation: 'parent', resource: 'pB', grantedBy: 'sys' });

        assert.equal(await f.store.hasEffective('alice', 'editor', 'leaseA'), true,
            'Alice can edit Lease A via parent inheritance');
        assert.equal(await f.store.hasEffective('alice', 'editor', 'leaseB'), false,
            'Alice CANNOT edit Lease B (no path)');
        assert.equal(await f.store.hasEffective('bob', 'editor', 'leaseB'), true,
            'Bob can edit Lease B');
        assert.equal(await f.store.hasEffective('bob', 'editor', 'leaseA'), false,
            'Bob CANNOT edit Lease A (no path)');
    });

    /* ---------- findUnknownPermissionRelations ---------- */

    await test('findUnknownPermissionRelations returns empty when all relations are known', () => {
        const schema: LoreSchemaV2 = {
            ...DEFAULT_SCHEMA_V2,
            permissions: {
                decision: {
                    view: 'viewer | editor | owner',
                    edit: 'editor | owner',
                },
            },
        };
        const out = findUnknownPermissionRelations(schema);
        assert.deepEqual(out, []);
    });

    await test('findUnknownPermissionRelations flags unknown relations', () => {
        const schema: LoreSchemaV2 = {
            ...DEFAULT_SCHEMA_V2,
            permissions: {
                decision: {
                    edit: 'editor | superhero | dragon',
                },
            },
        };
        const out = findUnknownPermissionRelations(schema);
        assert.equal(out.length, 1);
        assert.deepEqual(out[0].unknown.sort(), ['dragon', 'superhero']);
    });


    /* ---------- engine independence (replaces the Kùzu-only files) ---------- */

    // These three replace `test/kuzu-rebac-delete-semantics-unit.ts` and
    // `test/rebac-surreal-workspace-unit.ts`, both deleted. Each asserted a fact
    // about ReBAC edges living inside Kùzu — that deleting a LoreNode cascades
    // into the grants, and that a Surreal-backed workspace's empty Kùzu LoreNode
    // table makes grant() a phantom success. Neither statement can be true of a
    // store that no longer lives in a graph engine, so they are replaced by what
    // IS now true rather than adjusted to keep passing.

    await test('a store built without an endpoint probe is REFUSED', async () => {
        // The failure mode this prevents: defaulting to "assume the endpoints
        // exist" would make grant() succeed for ids that are not nodes, which is
        // precisely the phantom-success bug DEC-SURREAL-REBAC documented.
        assert.throws(
            () => new RebacStore(':memory:', undefined as never),
            /requires a nodeExists probe/,
        );
    });

    await test('grants work on ANY engine whose probe reports the endpoints', async () => {
        // The DEC-SURREAL-REBAC hole, closed. On a Surreal-backed workspace the
        // Kùzu LoreNode table existed and was EMPTY, so every grant matched
        // nothing and returned a phantom `true`. The endpoint check is now
        // supplied by the caller, so it reflects whichever graph is real.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rebac-anyengine-'));
        const nonKuzuGraph = new Set(['alice', 'workspaceS']);
        const store = new RebacStore(
            path.join(dir, 'rebac.sqlite'),
            async (ids) => new Set(ids.filter((id) => nonKuzuGraph.has(id))),
        );
        await store.ensureSchema();

        assert.equal(
            await store.grant({ subject: 'alice', relation: 'owner', resource: 'workspaceS', grantedBy: 'system' }),
            true,
            'a grant between two real nodes succeeds — no empty-node-table dead zone',
        );
        assert.equal(await store.has('alice', 'owner', 'workspaceS'), true, 'and it reads back');

        // And the check still bites when an endpoint genuinely is absent.
        await assert.rejects(
            () => store.grant({ subject: 'ghost', relation: 'owner', resource: 'workspaceS', grantedBy: 'system' }),
            /not found as a graph node/,
        );
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await test('deleting a graph node ORPHANS its grants rather than destroying them', async () => {
        // The replaced Kùzu file measured a cascade: deleting a LoreNode wiped
        // the node's semantic edges and then failed, while `DETACH DELETE`
        // destroyed the grants outright — both data loss. Tuples in their own
        // store cannot be cascaded into, so the new failure mode is the opposite
        // one and worth pinning: the grant SURVIVES and now points at nothing.
        //
        // Surviving is the better default for an authorization record — it stays
        // auditable, and `has()` cannot silently start returning true for a
        // recreated id without someone re-granting. But it is not free, so it is
        // asserted rather than assumed.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-rebac-orphan-'));
        const graph = new Set(['alice', 'doomed']);
        const store = new RebacStore(
            path.join(dir, 'rebac.sqlite'),
            async (ids) => new Set(ids.filter((id) => graph.has(id))),
        );
        await store.ensureSchema();
        await store.grant({ subject: 'alice', relation: 'owner', resource: 'doomed', grantedBy: 'system' });

        graph.delete('doomed'); // the node goes away; the store is not told

        assert.equal(await store.has('alice', 'owner', 'doomed'), true,
            'the grant survives the node — no cascade, no silent loss');
        assert.equal((await store.listResourceGrants('doomed')).length, 1,
            'and it stays enumerable, so an audit can find it');
        // Re-granting an orphaned resource is refused, because the endpoint is
        // now genuinely absent — the probe is consulted afresh every time.
        await assert.rejects(
            () => store.grant({ subject: 'alice', relation: 'viewer', resource: 'doomed', grantedBy: 'system' }),
            /not found as a graph node/,
        );
        store.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    /* ---------- summary ---------- */

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('test runner crashed:', err);
    process.exit(1);
});
