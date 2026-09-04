#!/usr/bin/env tsx
/**
 * nw4c-secondary-indexes-unit.ts — NW-4c outcome pin.
 *
 * NW-4c was opened to add secondary indexes on `LoreNode` so hot list /
 * cursor readers stop doing full table scans. Investigation found the
 * embedded legacy graph engine did NOT expose
 * `CREATE INDEX` DDL — the Cypher parser rejected every variant. The
 * task closed as `NOT-A-BUG: legacy-engine-limitation`; the remediation
 * is the documented design note in `docs/PERFORMANCE_NOTES.md` plus
 * the bounded-query guards that were already in place.
 *
 * The legacy graph engine was removed entirely (Phase 3d, 2026-08-21), so the live
 * parser-probe half and the localGraph.ts/localGraphReads.ts
 * source-scan halves died with the engine. What stays pinned:
 *
 *   (b) DEFAULT_LIST_NODES_CAP is still in place — the bounded-query
 *       guard that mitigates unbounded scans. Without it, no-arg
 *       `listNodes` would scan the whole table again.
 *
 *   (c) PERFORMANCE_NOTES.md exists and references the limitation —
 *       so any future contributor who thinks "we should add CREATE
 *       INDEX" finds the explanation before repeating the experiment.
 *
 * Run: LORE_HOME=$(mktemp -d) npx tsx test/nw4c-secondary-indexes-unit.ts
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_LIST_NODES_CAP } from '../packages/lore/src/engines/loreNodeRow.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function main(): Promise<void> {
    // ─── (b) Bounded-query guard pin ─────────────────────────────────
    // The mitigation for the missing index is the SW-18 default cap
    // on listNodes. If someone removes it, the audit risk returns.
    // DEFAULT_LIST_NODES_CAP now lives in loreNodeRow.ts (relocated Phase 3a,
    // legacy graph-engine removal: it's pure/engine-agnostic and shared by every substrate
    // that produces a LoreNode-shaped row) — assert on its VALUE, not on
    // which file textually declares it, so this pin survives the next
    // relocation instead of rotting on it.
    assert.equal(
        DEFAULT_LIST_NODES_CAP,
        10_000,
        'DEFAULT_LIST_NODES_CAP must remain 10_000 — it is the mitigation for the missing index',
    );
    console.log(`[b] OK — DEFAULT_LIST_NODES_CAP=10_000 still guards listNodes`);

    // ─── (c) Design-note presence pin ────────────────────────────────
    // PERFORMANCE_NOTES.md is the durable record of what we tried and
    // why we did not add fake DDL. If it disappears, this test fails so
    // the next contributor doesn't repeat the experiment.
    const perfNotesPath = path.join(ROOT, 'docs/PERFORMANCE_NOTES.md');
    assert.ok(fs.existsSync(perfNotesPath), 'docs/PERFORMANCE_NOTES.md must exist (NW-4c design note)');
    const perfNotes = fs.readFileSync(perfNotesPath, 'utf8');
    assert.match(perfNotes, /perf-listnodes-bulklist-fullscan-no-index/, 'PERFORMANCE_NOTES.md must reference the audit finding');
    assert.match(perfNotes, /CREATE INDEX/, 'PERFORMANCE_NOTES.md must document the CREATE INDEX limitation');
    assert.match(perfNotes, /DEFAULT_LIST_NODES_CAP/, 'PERFORMANCE_NOTES.md must call out the bounded-query mitigation');

    const upgrade = fs.readFileSync(path.join(ROOT, 'docs/UPGRADE.md'), 'utf8');
    assert.match(upgrade, /PERFORMANCE_NOTES\.md/, 'UPGRADE.md must link to PERFORMANCE_NOTES.md so operators find the limitation');
    console.log(`[c] OK — docs/PERFORMANCE_NOTES.md + UPGRADE.md cross-link present`);

    console.log(`\nnw4c-secondary-indexes-unit.ts: all checks passed`);
}

main().catch((e) => {
    console.error('nw4c-secondary-indexes-unit.ts: unexpected failure:', e);
    process.exit(1);
});
