#!/usr/bin/env tsx
/**
 * test/arcade-node-scopes-unit.ts - Arcade schema v4: LoreNode.security_scopes.
 *
 * Before v4 the Arcade LoreNode vertex had no scopes column, so every Arcade node
 * read back as public and the row-scope read/write gates (which resolve an item's
 * labels from the live graph node FIRST) let a bound actor see and mutate hidden
 * items. v4 stores the labels on the node (JSON string[], like tags) and backfills
 * pre-v4 rows from the canonical `lore:<id>` verbatim row.
 *
 * Pure unit test: an in-memory fake of ArcadeHttp that understands exactly the SQL
 * shapes the Arcade adapters emit. No live ArcadeDB (the real-container proof is
 * test/arcade-write-scopes-real-e2e.ts).
 */

import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { runArcadeRegistryMigrations } from '../packages/lore/src/engines/arcade/arcadeRegistryMigrations.js';
import {
  getTenantAppRow,
  stampTenantAppSchemaVersion,
  upsertTenantAppRow,
} from '../packages/lore/src/engines/arcade/arcadeRegistryStore.js';
import { ArcadeGraphStore } from '../packages/lore/src/engines/arcade/arcadeGraphStore.js';
import {
  ARCADE_SCHEMA_VERSION,
  NODE_PROPS,
  graphSchemaDdl,
} from '../packages/lore/src/engines/arcade/arcadeSchema.js';
import {
  encodeNodeScopes,
  parseNodeScopes,
  resolveNodeScopes,
  upgradeNodeScopes,
} from '../packages/lore/src/engines/arcade/arcadeNodeScopes.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${name}\n    ${(e as Error).message}`);
  }
}

type Row = Record<string, unknown>;

/** In-memory ArcadeDB stand-in for the statements the adapters emit. */
class FakeArcade {
  nodes = new Map<string, Row>();
  /** verbatim rows keyed by FULL id (`lore:<id>`); scopes comma-joined like the real column. */
  verbatim = new Map<string, Row>();
  verbatimTypeExists = true;
  ddl: string[] = [];
  queries: string[] = [];
  scripts: string[] = [];
  failScript = false;

  private upsertInto(id: string, assign: Row): void {
    const prior = this.nodes.get(id) ?? { id };
    this.nodes.set(id, { ...prior, ...assign });
  }

  /** Insert a pre-v4 node: the security_scopes property is simply never set. */
  seedLegacy(id: string, extra: Row = {}): void {
    this.nodes.set(id, { id, type: 'decision', label: id, content: '', tags: '[]', metadata: '{}', project: 'p', ecosystem: '*', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra });
  }

  async command(_db: string, sql: string, params: Row = {}): Promise<{ result: unknown[] }> {
    if (/^UPDATE LoreNode SET .* UPSERT WHERE id = :id$/s.test(sql)) {
      const { id, ...rest } = params;
      this.upsertInto(String(id), { ...rest });
      return { result: [] };
    }
    this.ddl.push(sql);
    return { result: [] };
  }

  async commandScript(_db: string, script: string, params: Row = {}): Promise<{ result: unknown[] }> {
    this.scripts.push(script);
    if (this.failScript) throw new Error('ArcadeDB HTTP 500: boom');
    for (const line of script.split('\n')) {
      let m = /^UPDATE LoreNode SET security_scopes = :(\w+) WHERE id = :(\w+) AND security_scopes IS NULL;$/.exec(line);
      if (m) {
        const row = this.nodes.get(String(params[m[2]!]));
        if (row && (row['security_scopes'] === null || row['security_scopes'] === undefined)) row['security_scopes'] = params[m[1]!];
        continue;
      }
      m = /^UPDATE LoreNode SET (.+) UPSERT WHERE id = :(n\d+_)id;$/.exec(line);
      if (m) {
        const p = m[2]!;
        const assign: Row = {};
        for (const part of m[1]!.split(', ')) {
          const field = part.split(' = ')[0]!;
          assign[field] = params[`${p}${field}`];
        }
        this.upsertInto(String(params[`${p}id`]), assign);
        continue;
      }
      throw new Error(`FakeArcade: unrecognised script line: ${line}`);
    }
    return { result: [] };
  }

  async query(_db: string, sql: string, params: Row = {}): Promise<{ result: Row[] }> {
    this.queries.push(sql);
    let m = /^SELECT id FROM LoreNode WHERE security_scopes IS NULL LIMIT (\d+)$/.exec(sql);
    if (m) {
      const out = [...this.nodes.values()].filter((r) => r['security_scopes'] == null).slice(0, Number(m[1]));
      return { result: out.map((r) => ({ id: r['id'] })) };
    }
    if (/^SELECT name FROM schema:types WHERE name = :n$/.test(sql)) {
      return { result: this.verbatimTypeExists && params['n'] === 'LoreVerbatim' ? [{ name: 'LoreVerbatim' }] : [] };
    }
    if (/^SELECT id, security_scopes FROM LoreVerbatim WHERE id IN :vids$/.test(sql)) {
      const ids = params['vids'] as string[];
      return { result: ids.filter((v) => this.verbatim.has(v)).map((v) => this.verbatim.get(v)!) };
    }
    if (/^SELECT id, createdAt, security_scopes FROM LoreNode WHERE id IN :ids$/.test(sql)) {
      const ids = params['ids'] as string[];
      return { result: ids.filter((i) => this.nodes.has(i)).map((i) => this.nodes.get(i)!) };
    }
    if (/FROM LoreNode WHERE id = :id LIMIT 1$/.test(sql)) {
      const r = this.nodes.get(String(params['id']));
      return { result: r ? [r] : [] };
    }
    if (/FROM LoreNode WHERE id IN :ids$/.test(sql)) {
      const ids = params['ids'] as string[];
      return { result: ids.filter((i) => this.nodes.has(i)).map((i) => this.nodes.get(i)!) };
    }
    if (/FROM LoreNode/.test(sql)) {
      // search / bulkList: return every node; the adapters project them.
      return { result: [...this.nodes.values()] };
    }
    throw new Error(`FakeArcade: unrecognised query: ${sql}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asHttp(): any {
    return this;
  }
}

function makeStore(fake: FakeArcade): ArcadeGraphStore {
  return new ArcadeGraphStore({ tenantDb: 't', http: fake.asHttp() });
}

const base = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'decision', label: id, content: `content of ${id}`, tags: [] as string[],
  project: 'p', ecosystem: '*', metadata: '{}', ...extra,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

async function main(): Promise<void> {
  console.log('\n=== arcade node security_scopes (schema v4) ===\n');

  // ── schema ────────────────────────────────────────────────────────────────
  await test('schema version is 4 and NODE_PROPS declares security_scopes STRING', () => {
    assert.equal(ARCADE_SCHEMA_VERSION, 4);
    assert.ok(NODE_PROPS.some(([n, t]) => n === 'security_scopes' && t === 'STRING'));
  });
  await test('graph DDL creates the property additively (IF NOT EXISTS)', () => {
    const stmts = graphSchemaDdl().filter((s) => s.includes('security_scopes'));
    assert.equal(stmts.length, 1);
    assert.match(stmts[0]!, /CREATE PROPERTY LoreNode\.security_scopes IF NOT EXISTS STRING/);
  });

  // ── codec ─────────────────────────────────────────────────────────────────
  await test('codec: JSON round trip, [] stays [], legacy comma text is a restriction not public', () => {
    assert.equal(encodeNodeScopes(['a', 'b']), '["a","b"]');
    assert.deepEqual(parseNodeScopes('["a","b"]'), ['a', 'b']);
    assert.deepEqual(parseNodeScopes('[]'), []);
    assert.deepEqual(parseNodeScopes(null), []);
    assert.deepEqual(parseNodeScopes('a,b'), ['a', 'b']);
    assert.deepEqual(resolveNodeScopes(['x'], '["y"]'), ['x']);
    assert.deepEqual(resolveNodeScopes([], '["y"]'), []);
    assert.deepEqual(resolveNodeScopes(undefined, '["y"]'), ['y']);
    assert.deepEqual(resolveNodeScopes(undefined, undefined), []);
  });

  // ── writes ────────────────────────────────────────────────────────────────
  await test('upsertNode writes the scopes and returns them', async () => {
    const fake = new FakeArcade();
    const s = makeStore(fake);
    const out = await s.upsertNode(base('n1', { security_scopes: ['team-a'] }));
    assert.deepEqual(out.security_scopes, ['team-a']);
    assert.equal(fake.nodes.get('n1')!['security_scopes'], '["team-a"]');
  });
  await test('new node with scopes omitted is [] (public), stored explicitly', async () => {
    const fake = new FakeArcade();
    const out = await makeStore(fake).upsertNode(base('n1'));
    assert.deepEqual(out.security_scopes, []);
    assert.equal(fake.nodes.get('n1')!['security_scopes'], '[]');
  });
  await test('re-store with scopes omitted keeps the prior labels', async () => {
    const fake = new FakeArcade();
    const s = makeStore(fake);
    await s.upsertNode(base('n1', { security_scopes: ['team-a'] }));
    const out = await s.upsertNode(base('n1', { content: 'edited' }));
    assert.deepEqual(out.security_scopes, ['team-a']);
    assert.equal(out.content, 'edited');
  });
  await test('explicit [] clears the labels', async () => {
    const fake = new FakeArcade();
    const s = makeStore(fake);
    await s.upsertNode(base('n1', { security_scopes: ['team-a'] }));
    const out = await s.upsertNode(base('n1', { security_scopes: [] }));
    assert.deepEqual(out.security_scopes, []);
    assert.equal(fake.nodes.get('n1')!['security_scopes'], '[]');
  });
  await test('explicit array replaces the prior labels', async () => {
    const fake = new FakeArcade();
    const s = makeStore(fake);
    await s.upsertNode(base('n1', { security_scopes: ['team-a'] }));
    const out = await s.upsertNode(base('n1', { security_scopes: ['team-b', 'team-c'] }));
    assert.deepEqual(out.security_scopes, ['team-b', 'team-c']);
  });
  await test('bulkUpsertNodes: new node [] / explicit wins / omitted keeps / explicit [] clears', async () => {
    const fake = new FakeArcade();
    const s = makeStore(fake);
    await s.upsertNode(base('keep', { security_scopes: ['team-a'] }));
    await s.upsertNode(base('clear', { security_scopes: ['team-a'] }));
    await s.upsertNode(base('swap', { security_scopes: ['team-a'] }));
    const res = await s.bulkUpsertNodes([
      base('fresh'),
      base('keep', { content: 'x' }),
      base('clear', { security_scopes: [] }),
      base('swap', { security_scopes: ['team-z'] }),
      base('fresh2', { security_scopes: ['team-q'] }),
    ]);
    assert.ok(res.every((r: { ok: boolean }) => r.ok), JSON.stringify(res));
    assert.equal(fake.nodes.get('fresh')!['security_scopes'], '[]');
    assert.equal(fake.nodes.get('keep')!['security_scopes'], '["team-a"]');
    assert.equal(fake.nodes.get('clear')!['security_scopes'], '[]');
    assert.equal(fake.nodes.get('swap')!['security_scopes'], '["team-z"]');
    assert.equal(fake.nodes.get('fresh2')!['security_scopes'], '["team-q"]');
  });

  // ── reads ─────────────────────────────────────────────────────────────────
  await test('getNode / getNodesByIds / search / bulkList all return the stored scopes', async () => {
    const fake = new FakeArcade();
    const s = makeStore(fake);
    await s.upsertNode(base('hid', { security_scopes: ['team-a'], content: 'zebra' }));
    await s.upsertNode(base('pub', { content: 'zebra' }));
    assert.deepEqual((await s.getNode('hid'))!.security_scopes, ['team-a']);
    assert.deepEqual((await s.getNode('pub'))!.security_scopes, []);
    const many = await s.getNodesByIds(['hid', 'pub']);
    assert.deepEqual(many.get('hid')!.security_scopes, ['team-a']);
    const found = await s.search('zebra', 10);
    assert.deepEqual(found.find((n) => n.id === 'hid')!.security_scopes, ['team-a']);
    assert.deepEqual(found.find((n) => n.id === 'pub')!.security_scopes, []);
    const page = await s.bulkList({ limit: 10 } as never);
    assert.deepEqual(page.nodes.find((n) => n.id === 'hid')!.security_scopes, ['team-a']);
    assert.deepEqual(page.nodes.find((n) => n.id === 'pub')!.security_scopes, []);
  });

  // ── upgrade / backfill ────────────────────────────────────────────────────
  await test('backfill: verbatim scopes copied; damaged verbatim copied as-is (fail closed); no verbatim -> []; counts reported', async () => {
    const fake = new FakeArcade();
    fake.seedLegacy('has-v');
    fake.seedLegacy('no-v');
    fake.seedLegacy('dmg-v');
    fake.seedLegacy('pub-v');
    fake.verbatim.set('lore:has-v', { id: 'lore:has-v', security_scopes: 'team-a,team-b' });
    fake.verbatim.set('lore:dmg-v', { id: 'lore:dmg-v', security_scopes: 'undefined' });
    fake.verbatim.set('lore:pub-v', { id: 'lore:pub-v', security_scopes: '' });
    const r = await upgradeNodeScopes('t', fake.asHttp());
    assert.deepEqual(r, { backfilledFromVerbatim: 2, defaultedPublic: 1, damagedVerbatim: 1 });
    assert.equal(fake.nodes.get('has-v')!['security_scopes'], '["team-a","team-b"]');
    assert.equal(fake.nodes.get('no-v')!['security_scopes'], '[]');
    assert.equal(fake.nodes.get('dmg-v')!['security_scopes'], '["undefined"]');
    assert.equal(fake.nodes.get('pub-v')!['security_scopes'], '[]');
  });
  await test('backfill is idempotent: second run touches nothing', async () => {
    const fake = new FakeArcade();
    fake.seedLegacy('a');
    fake.verbatim.set('lore:a', { id: 'lore:a', security_scopes: 'team-a' });
    await upgradeNodeScopes('t', fake.asHttp());
    const scriptsBefore = fake.scripts.length;
    const r = await upgradeNodeScopes('t', fake.asHttp());
    assert.deepEqual(r, { backfilledFromVerbatim: 0, defaultedPublic: 0, damagedVerbatim: 0 });
    assert.equal(fake.scripts.length, scriptsBefore, 'no further writes');
    assert.equal(fake.nodes.get('a')!['security_scopes'], '["team-a"]');
  });
  await test('backfill never overwrites a node that already has labels (incl. explicit [])', async () => {
    const fake = new FakeArcade();
    fake.seedLegacy('set', { security_scopes: '["mine"]' });
    fake.seedLegacy('empty', { security_scopes: '[]' });
    fake.verbatim.set('lore:set', { id: 'lore:set', security_scopes: 'other' });
    fake.verbatim.set('lore:empty', { id: 'lore:empty', security_scopes: 'other' });
    const r = await upgradeNodeScopes('t', fake.asHttp());
    assert.deepEqual(r, { backfilledFromVerbatim: 0, defaultedPublic: 0, damagedVerbatim: 0 });
    assert.equal(fake.nodes.get('set')!['security_scopes'], '["mine"]');
    assert.equal(fake.nodes.get('empty')!['security_scopes'], '[]');
  });
  await test('backfill on a graph-only cell (no LoreVerbatim type): all [], verbatim never queried', async () => {
    const fake = new FakeArcade();
    fake.verbatimTypeExists = false;
    fake.seedLegacy('a');
    const r = await upgradeNodeScopes('t', fake.asHttp());
    assert.deepEqual(r, { backfilledFromVerbatim: 0, defaultedPublic: 1, damagedVerbatim: 0 });
    assert.ok(!fake.queries.some((q) => q.includes('FROM LoreVerbatim')));
  });
  await test('backfill pages: 450 legacy nodes -> 3 UPDATE scripts, all backfilled', async () => {
    const fake = new FakeArcade();
    for (let i = 0; i < 450; i++) fake.seedLegacy(`n${i}`);
    const r = await upgradeNodeScopes('t', fake.asHttp());
    assert.equal(r.defaultedPublic, 450);
    assert.equal(fake.scripts.length, 3);
    assert.ok([...fake.nodes.values()].every((n) => n['security_scopes'] === '[]'));
  });
  await test('a failed backfill throws, writes nothing half-way, and a retry completes it', async () => {
    const fake = new FakeArcade();
    fake.seedLegacy('a');
    fake.failScript = true;
    await assert.rejects(() => upgradeNodeScopes('t', fake.asHttp()), /boom/);
    assert.equal(fake.nodes.get('a')!['security_scopes'], undefined);
    fake.failScript = false;
    const r = await upgradeNodeScopes('t', fake.asHttp());
    assert.equal(r.defaultedPublic, 1);
    assert.equal(fake.nodes.get('a')!['security_scopes'], '[]');
  });
  await test('no-progress guard: a node that stays NULL after its UPDATE throws instead of looping', async () => {
    const fake = new FakeArcade();
    fake.seedLegacy('stuck');
    // A script that "succeeds" but writes nothing.
    fake.commandScript = async () => ({ result: [] });
    await assert.rejects(() => upgradeNodeScopes('t', fake.asHttp()), /no progress on node stuck/);
  });

  // ── adapter initialize() ties the upgrade to readiness ────────────────────
  await test('initialize() backfills a v3 cell before serving: reads see backfilled labels', async () => {
    const fake = new FakeArcade();
    fake.seedLegacy('hid');
    fake.verbatim.set('lore:hid', { id: 'lore:hid', security_scopes: 'team-a' });
    const s = makeStore(fake);
    const node = await s.getNode('hid');
    assert.deepEqual(node!.security_scopes, ['team-a']);
    assert.ok(fake.ddl.some((d) => d.includes('LoreNode.security_scopes')), 'DDL replayed');
  });
  await test('initialize() with a failing backfill stays stale: every call fails, nothing served', async () => {
    const fake = new FakeArcade();
    fake.seedLegacy('hid');
    fake.failScript = true;
    const s = makeStore(fake);
    await assert.rejects(() => s.getNode('hid'), /boom/);
    await assert.rejects(() => s.getNode('hid'), /boom/);
    fake.failScript = false;
    const node = await s.getNode('hid');
    assert.deepEqual(node!.security_scopes, [], 'retry succeeds once the backfill can run');
  });

  // ── addEdge wording ───────────────────────────────────────────────────────
  await test('addEdge: a missing endpoint throws the local engine\'s edge_endpoint_missing text (hidden == missing for the edge gate)', async () => {
    const fake = new FakeArcade();
    const s = makeStore(fake);
    await s.upsertNode({ id: 'here', type: 'note', label: 'h', content: 'c', tags: [], project: 'w', ecosystem: '*', metadata: '{}', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } as never);
    const edge = (sourceId: string, targetId: string) => ({ sourceId, targetId, relation: 'depends_on' });
    await assert.rejects(() => s.addEdge(edge('here', 'ghost')),
      (e: Error) => e.message === "[LoreGraph:addEdge] edge_endpoint_missing: target 'ghost' not found — the node must be written (and committed) before its edges");
    await assert.rejects(() => s.addEdge(edge('ghost', 'here')), /edge_endpoint_missing: source 'ghost' not found/);
    await assert.rejects(() => s.addEdge(edge('ghost', 'ghost2')), /edge_endpoint_missing: source 'ghost' and target 'ghost2' not found/);
  });

  // ── registry stamp ────────────────────────────────────────────────────────
  await test('registry: a re-provisioned cell is unstamped (0) until stampTenantAppSchemaVersion runs', () => {
    const db = new Database(':memory:');
    runArcadeRegistryMigrations(db);
    upsertTenantAppRow(db, { tenantId: 'c', appId: 'a', dbName: 'c_a', dbUser: 'u', dbPass: null, secretRef: 'r', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(getTenantAppRow(db, 'c', 'a')!.schema_version, 0);
    stampTenantAppSchemaVersion(db, 'c', 'a', ARCADE_SCHEMA_VERSION);
    assert.equal(getTenantAppRow(db, 'c', 'a')!.schema_version, 4);
    // A later upsert (re-provision) must not silently drop the stamp.
    upsertTenantAppRow(db, { tenantId: 'c', appId: 'a', dbName: 'c_a', dbUser: 'u', dbPass: null, secretRef: 'r', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' });
    assert.equal(getTenantAppRow(db, 'c', 'a')!.schema_version, 4);
    db.close();
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
