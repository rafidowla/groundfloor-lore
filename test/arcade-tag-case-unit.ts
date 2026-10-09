#!/usr/bin/env tsx
/**
 * test/arcade-tag-case-unit.ts — pins the G4 tag-case bug (arcade mode):
 * a node written with tag "Participant:Bob@Example.COM" was returned by the
 * read path as "participant:bob@example.com" but bulk-list / list filters by
 * the lower-cased tag did not find it, because the tags column kept the
 * original case and only the read path lower-cased.
 *
 * Fixed on both sides:
 *   - writes normalise through the shared normalizeTag (lower-case + 64 cut);
 *   - the filters match `tags.toLowerCase() LIKE :tag`, so rows written before
 *     the fix (mixed-case in the column) are found without a data repair.
 *
 * Pure unit test: the fake ArcadeHttp evaluates the `tags.toLowerCase() LIKE`
 * predicate against the stored column text, the way ArcadeDB would. No live
 * ArcadeDB required.
 */

import { strict as assert } from 'node:assert';
import { bulkUpsertNodes } from '../packages/lore/src/engines/arcade/arcadeBulk.js';
import {
  arcadeTagLikePattern,
  bulkListArcadeNodes,
  listNodes,
} from '../packages/lore/src/engines/arcade/arcadeGraphReads.js';
import { MAX_TAG_LENGTH, normalizeTag } from '../packages/lore/src/engines/normalizeTags.js';

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

type Row = {
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

function row(id: string, tags: string): Row {
  return {
    id, type: 'decision', label: id, content: '', tags, metadata: '{}',
    project: 'p', ecosystem: '*', updatedAt: '2026-10-08T00:00:00.000Z',
    createdAt: '2026-10-08T00:00:00.000Z',
  };
}

/** SQL LIKE with only leading/trailing % wildcards (all the code under test emits). */
function like(text: string, pattern: string): boolean {
  assert.ok(pattern.startsWith('%') && pattern.endsWith('%'), `unexpected pattern ${pattern}`);
  return text.toLowerCase().includes(pattern.slice(1, -1));
}

function makeFake(table: Row[]) {
  const sqls: string[] = [];
  return {
    sqls,
    async query(_db: string, sql: string, params: Record<string, unknown> = {}) {
      sqls.push(sql);
      if (sql.startsWith('SELECT id, createdAt, security_scopes')) return { result: [] };
      let rows = table.slice();
      const tagKeys = Object.keys(params).filter((k) => /^tag\d*$/.test(k));
      if (tagKeys.length > 0) {
        assert.ok(
          sql.includes('tags.toLowerCase() LIKE'),
          'tag filter must match case-insensitively against the stored column',
        );
        rows = rows.filter((r) => tagKeys.some((k) => like(r.tags, String(params[k]))));
      }
      return { result: rows as unknown as Array<Record<string, unknown>> };
    },
    // Captures the persisted tags of a bulk upsert into `table`.
    async commandScript(_db: string, _script: string, params: Record<string, unknown>) {
      for (let i = 0; params[`n${i}_id`] !== undefined; i++) {
        table.push(row(String(params[`n${i}_id`]), String(params[`n${i}_tags`])));
      }
      return { result: [] };
    },
    async command() {
      return { result: [] };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const rowToNode = (r: Record<string, unknown>) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ({ id: String(r['id']), tags: JSON.parse(String(r['tags'])) }) as any;

const MIXED = 'Participant:Bob@Example.COM';
const LOWER = 'participant:bob@example.com';

async function main(): Promise<void> {
  await test('normalizeTag lower-cases, trims and cuts to MAX_TAG_LENGTH', () => {
    assert.equal(normalizeTag('  ABC '), 'abc');
    assert.equal(normalizeTag('A'.repeat(100)), 'a'.repeat(MAX_TAG_LENGTH));
    assert.equal(MAX_TAG_LENGTH, 64);
  });

  await test('bulk write persists normalised tags', async () => {
    const table: Row[] = [];
    const http = makeFake(table);
    const out = await bulkUpsertNodes('t', http, [
      { id: 'w1', type: 'decision', label: 'w1', content: '', tags: [MIXED, 'X'.repeat(100)], project: 'p' } as never,
    ], async () => { throw new Error('fallback must not run'); });
    assert.deepEqual(out, [{ id: 'w1', ok: true }]);
    assert.equal(table.length, 1);
    assert.deepEqual(JSON.parse(table[0]!.tags), [LOWER, 'x'.repeat(64)]);
  });

  await test('upper-case tag written -> bulk-list finds it by lower and mixed case', async () => {
    const table: Row[] = [];
    const http = makeFake(table);
    await bulkUpsertNodes('t', http, [
      { id: 'w1', type: 'decision', label: 'w1', content: '', tags: [MIXED], project: 'p' } as never,
    ], async () => { throw new Error('no fallback'); });
    for (const q of [LOWER, MIXED, MIXED.toUpperCase()]) {
      const page = await bulkListArcadeNodes('t', http, 'LoreNode', { tags: [q], limit: 10 } as never);
      assert.deepEqual(page.nodes.map((n) => n.id), ['w1'], `query ${q}`);
    }
  });

  await test('legacy row with mixed-case stored tags is found by lower and mixed case', async () => {
    const table: Row[] = [row('legacy', JSON.stringify([MIXED, 'Other']))];
    const http = makeFake(table);
    for (const q of [LOWER, MIXED]) {
      const page = await bulkListArcadeNodes('t', http, 'LoreNode', { tags: [q], limit: 10 } as never);
      assert.deepEqual(page.nodes.map((n) => n.id), ['legacy'], `query ${q}`);
      assert.deepEqual(page.nodes[0]!.tags, [LOWER, 'other'], 'read path still lower-cases');
    }
    const none = await bulkListArcadeNodes('t', http, 'LoreNode', { tags: ['absent'], limit: 10 } as never);
    assert.equal(none.nodes.length, 0);
  });

  await test('multiple tags are OR-ed case-insensitively', async () => {
    const table: Row[] = [row('a', '["Alpha"]'), row('b', '["BETA"]'), row('c', '["gamma"]')];
    const page = await bulkListArcadeNodes('t', makeFake(table), 'LoreNode', { tags: ['ALPHA', 'beta'], limit: 10 } as never);
    assert.deepEqual(page.nodes.map((n) => n.id).sort(), ['a', 'b']);
  });

  await test('exact membership: a tag that is only a substring of another does not match', async () => {
    const table: Row[] = [row('a', '["bobby"]')];
    const page = await bulkListArcadeNodes('t', makeFake(table), 'LoreNode', { tags: ['bob'], limit: 10 } as never);
    assert.equal(page.nodes.length, 0);
  });

  await test('long mixed-case legacy tag (>64) is found by its normalised form', async () => {
    const long = 'Mixed-Case-' + 'Z'.repeat(120);
    const table: Row[] = [row('long', JSON.stringify([long]))];
    const http = makeFake(table);
    const normalised = normalizeTag(long);
    assert.equal(normalised.length, MAX_TAG_LENGTH);
    for (const q of [normalised, long]) {
      const page = await bulkListArcadeNodes('t', http, 'LoreNode', { tags: [q], limit: 10 } as never);
      assert.deepEqual(page.nodes.map((n) => n.id), ['long'], `query length ${q.length}`);
    }
  });

  await test('long tag written after the fix is found by its normalised form', async () => {
    const long = 'Mixed-Case-' + 'Z'.repeat(120);
    const table: Row[] = [];
    const http = makeFake(table);
    await bulkUpsertNodes('t', http, [
      { id: 'w2', type: 'decision', label: 'w2', content: '', tags: [long], project: 'p' } as never,
    ], async () => { throw new Error('no fallback'); });
    const page = await bulkListArcadeNodes('t', http, 'LoreNode', { tags: [normalizeTag(long)], limit: 10 } as never);
    assert.deepEqual(page.nodes.map((n) => n.id), ['w2']);
  });

  await test('listNodes tag filter is case-insensitive too', async () => {
    const table: Row[] = [row('legacy', JSON.stringify([MIXED]))];
    const http = makeFake(table);
    for (const q of [LOWER, MIXED]) {
      const nodes = await listNodes('t', http, 'LoreNode', rowToNode as never, undefined, q);
      assert.deepEqual(nodes.map((n) => n.id), ['legacy'], `query ${q}`);
    }
  });

  await test('arcadeTagLikePattern: short tags keep the closing quote (exact membership)', () => {
    assert.equal(arcadeTagLikePattern('Foo'), '%"foo"%');
    const p = arcadeTagLikePattern('x'.repeat(80));
    assert.equal(p, `%"${'x'.repeat(64)}%`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
