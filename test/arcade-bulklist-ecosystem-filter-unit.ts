#!/usr/bin/env tsx
/**
 * test/arcade-bulklist-ecosystem-filter-unit.ts — pins the security-review
 * finding: bulkListArcadeNodes (ArcadeGraphStore.bulkList, the fourth
 * LoreGraphHandle.bulkList implementer alongside Kùzu/graphBulkList.ts,
 * Surreal/surrealGraphAggregates.ts, and DataplaneGraph) built its WHERE
 * clause from `types`, `tags`, `project`, and `cursor` but never read
 * `q.ecosystem` — so a caller scoped to one ecosystem (e.g. diagnostic.ts's
 * list_nodes route, post the getGraphContext-removal refactor) would get
 * back nodes from every ecosystem on an Arcade-backed workspace, even though
 * the three sibling engines already honoured the same filter.
 *
 * Pure unit test: fakes ArcadeHttp.query() to apply the SAME filters the
 * function's own `params` bag would carry to a real ArcadeDB WHERE clause —
 * if bulkListArcadeNodes never sets `params['ecosystem']`, the fake has
 * nothing to filter on and returns every ecosystem, reproducing the gap.
 * No live ArcadeDB required.
 */

import { strict as assert } from 'node:assert';
import type { BulkListQuery } from '../packages/lore/src/providers/types.js';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

type FixtureRow = {
  id: string;
  type: string;
  label: string;
  content: string;
  tags: string;
  metadata: string;
  project: string;
  ecosystem: string;
  updatedAt: string;
  createdAt: string;
};

const FIXTURE: FixtureRow[] = [
  { id: 'n1', type: 'decision', label: 'n1', content: '', tags: '[]', metadata: '{}', project: 'proj-a', ecosystem: 'e', updatedAt: '2026-08-01T00:00:03.000Z', createdAt: '2026-08-01T00:00:00.000Z' },
  { id: 'n2', type: 'decision', label: 'n2', content: '', tags: '[]', metadata: '{}', project: 'proj-a', ecosystem: 'e', updatedAt: '2026-08-01T00:00:02.000Z', createdAt: '2026-08-01T00:00:00.000Z' },
  { id: 'other-project', type: 'decision', label: 'op', content: '', tags: '[]', metadata: '{}', project: 'proj-a', ecosystem: 'f', updatedAt: '2026-08-01T00:00:01.000Z', createdAt: '2026-08-01T00:00:00.000Z' },
];

/**
 * Fake ArcadeHttp — applies filters using the SAME params keys
 * bulkListArcadeNodes populates (project, type-N, tag-N, ecosystem,
 * cursor-N), the way a real ArcadeDB WHERE clause bound to those params
 * would. If the function under test never sets `params['ecosystem']`, this
 * fake has no ecosystem key to filter on and returns rows from every
 * ecosystem — which is exactly the pre-fix behaviour this test pins.
 */
function makeFakeHttp() {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  return {
    _calls: calls,
    async query(_db: string, sql: string, params: Record<string, unknown> = {}) {
      calls.push({ sql, params });
      let rows = FIXTURE.slice();
      if (params['project']) rows = rows.filter((r) => r.project === params['project']);
      if (params['ecosystem']) rows = rows.filter((r) => r.ecosystem === params['ecosystem']);
      rows.sort((a, b) => {
        if (a.updatedAt < b.updatedAt) return 1;
        if (a.updatedAt > b.updatedAt) return -1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
      return { result: rows as unknown as Array<Record<string, unknown>> };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function main(): Promise<void> {
  console.log('\n=== arcade bulkList ecosystem filter ===\n');

  const { bulkListArcadeNodes } = await import(
    '../packages/lore/src/engines/arcade/arcadeGraphReads.js'
  );

  await test('ecosystem=f returns ONLY the ecosystem-f node', async () => {
    const http = makeFakeHttp();
    const q: BulkListQuery = { limit: 50, ecosystem: 'f' };
    const page = await bulkListArcadeNodes('tenant1', http, 'LoreNode', q);
    assert.deepEqual(
      page.nodes.map((n) => n['id']),
      ['other-project'],
      'ecosystem=f must return only the fixture row tagged ecosystem=f',
    );
  });

  await test('ecosystem=e EXCLUDES the ecosystem-f node (the actual gap)', async () => {
    const http = makeFakeHttp();
    const q: BulkListQuery = { limit: 50, ecosystem: 'e' };
    const page = await bulkListArcadeNodes('tenant1', http, 'LoreNode', q);
    const ids = page.nodes.map((n) => n['id']);
    assert.ok(!ids.includes('other-project'), 'ecosystem=e must NOT include the ecosystem-f node');
    assert.equal(ids.length, FIXTURE.length - 1, 'ecosystem=e must drop exactly the one ecosystem-f node');
  });

  await test('ecosystem param is bound (not string-interpolated) when present', async () => {
    const http = makeFakeHttp();
    const q: BulkListQuery = { limit: 50, ecosystem: 'e' };
    await bulkListArcadeNodes('tenant1', http, 'LoreNode', q);
    assert.equal(http._calls.length, 1);
    assert.equal(http._calls[0].params['ecosystem'], 'e');
    assert.match(http._calls[0].sql, /ecosystem\s*=\s*:ecosystem/);
  });

  await test('omitted ecosystem filter matches every ecosystem (wildcard convention)', async () => {
    const http = makeFakeHttp();
    const q: BulkListQuery = { limit: 50 };
    const page = await bulkListArcadeNodes('tenant1', http, 'LoreNode', q);
    assert.equal(page.nodes.length, FIXTURE.length, 'no ecosystem filter means every ecosystem is returned');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
