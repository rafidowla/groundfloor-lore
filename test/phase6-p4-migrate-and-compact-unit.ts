/**
 * test/phase6-p4-migrate-and-compact-unit.ts
 *
 * Phase 6 P4 — built-in `lore migrate workspace-to-workspace` +
 * `lore compact <workspace>` CLI commands. Runs against real
 * SurrealGraph + LanceDB stores on disk (no mocks); each test seeds a
 * fresh source workspace and asserts physical effects.
 *
 * Coverage (spec T1–T7):
 *   T1: 100 LoreNode rows A→B with --filter-type decision (no
 *       --delete-source) → B has 100, A unchanged.
 *   T2: Same with --delete-source → A loses 100, B has 100.
 *   T3: --include-edges migrates only the edges whose BOTH endpoints
 *       are in the moved set.
 *   T4: --include-vectors copies the LanceDB verbatim rows for moved
 *       ids (dedupe by id — repeat run does not duplicate).
 *   T5: --exclude-id-prefix loom-dispatch-,agent-run- filters them out.
 *   T6: --dry-run reports counts; ZERO mutation on either side.
 *   T7: `lore compact <workspace>` reduces the LanceDB on-disk size
 *       after a bunch of deletes have left tombstoned rows.
 *
 * IMPLEMENTATION NOTE — each workspace's SurrealGraph + VerbatimStore
 * is opened EXACTLY ONCE and threaded into `migrateWorkspaceToWorkspace`
 * via the `injected` option. That keeps the production CLI path (which
 * always opens fresh instances) unchanged, and avoids a second
 * SurrealGraph handle contending on the same surrealkv directory lock.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEST_HOME = process.env['LORE_HOME'];
if (!TEST_HOME || TEST_HOME === path.join(process.env['HOME'] ?? '', '.groundfloor')) {
    console.error(
        'ERROR: LORE_HOME must be set to a fresh temp dir before running this test.\n' +
            'Use: LORE_HOME=$(mktemp -d) npx tsx test/phase6-p4-migrate-and-compact-unit.ts',
    );
    process.exit(2);
}

// Pre-create workspaces.json enumerating one (src,dst) pair per test.
const TEST_LABELS = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];

function seedAllWorkspaces(home: string): void {
    const entries = TEST_LABELS.flatMap((label) => {
        const srcPath = path.join(home, 'workspaces', `${label}-src`);
        const dstPath = path.join(home, 'workspaces', `${label}-dst`);
        fs.mkdirSync(path.join(srcPath, '.lore'), { recursive: true });
        fs.mkdirSync(path.join(dstPath, '.lore'), { recursive: true });
        return [
            { name: `${label}-src`, path: srcPath, createdAt: '2026-05-21T00:00:00.000Z' },
            { name: `${label}-dst`, path: dstPath, createdAt: '2026-05-21T00:00:00.000Z' },
        ];
    });
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        active: entries[0]!.name,
        workspaces: entries,
    }, null, 2));
}
seedAllWorkspaces(TEST_HOME!);

const { SurrealGraph } = await import('../packages/lore/src/engines/surrealGraph.js');
const { VerbatimStore } = await import('../packages/lore/src/engines/verbatimStore.js');
const { migrateWorkspaceToWorkspace } = await import('../packages/lore/src/cli/commands/migrateWorkspaceToWorkspace.js');
const { compactCommand } = await import('../packages/lore/src/cli/commands/compact.js');

/* ─── Per-test scaffolding ─────────────────────────────────────── */

interface Scaffold {
    srcName: string;
    dstName: string;
    srcPath: string;
    dstPath: string;
    src: InstanceType<typeof SurrealGraph>;
    dst: InstanceType<typeof SurrealGraph>;
    srcV?: InstanceType<typeof VerbatimStore>;
    dstV?: InstanceType<typeof VerbatimStore>;
}

async function closeScaffold(s: Scaffold): Promise<void> {
    // Close in reverse-init order. Wrapped in try/catch because a
    // close() can throw on already-closed connections; we don't care
    // about per-instance failure during teardown.
    try { await s.srcV?.close(); } catch { /* */ }
    try { await s.dstV?.close(); } catch { /* */ }
    try { await s.src.close(); } catch { /* */ }
    try { await s.dst.close(); } catch { /* */ }
}

async function newScaffold(label: string, withVerbatim = false): Promise<Scaffold> {
    const srcName = `${label}-src`;
    const dstName = `${label}-dst`;
    const srcPath = path.join(TEST_HOME!, 'workspaces', srcName);
    const dstPath = path.join(TEST_HOME!, 'workspaces', dstName);
    const src = new SurrealGraph(srcPath, { workspaceId: srcName });
    const dst = new SurrealGraph(dstPath, { workspaceId: dstName });
    await src.initialize();
    await dst.initialize();
    const s: Scaffold = { srcName, dstName, srcPath, dstPath, src, dst };
    if (withVerbatim) {
        s.srcV = new VerbatimStore(srcPath);
        s.dstV = new VerbatimStore(dstPath);
        await s.srcV.initialize();
        await s.dstV.initialize();
    }
    return s;
}

async function seedDecisions(graph: InstanceType<typeof SurrealGraph>, n: number, idPrefix = 'p4'): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
        const id = `${idPrefix}-dec-${i}`;
        ids.push(id);
        await graph.upsertNode({
            id, type: 'decision', label: `Decision ${i}`,
            content: `seed-content-${i}`,
            tags: 'auto-seed',
            project: 'src', ecosystem: 'default',
            metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
        });
    }
    return ids;
}

/* ─── T1: 100 nodes A→B, no --delete-source ────────────────────── */

async function testT1_filterTypeNoDelete(): Promise<void> {
    const s = await newScaffold('t1');
    await seedDecisions(s.src, 100);
    await s.src.upsertNode({
        id: 'p4-note-keep', type: 'note', label: 'should not move',
        content: '', tags: '', project: 'src', ecosystem: 'default',
        metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
    });

    const report = await migrateWorkspaceToWorkspace({
        from: s.srcName, to: s.dstName, filterTypes: ['decision'],
        apply: true, force: true, onConflict: 'fail',
        injected: { srcGraph: s.src, dstGraph: s.dst },
    });
    assert.equal(report.upserted, 100, `upserted=${report.upserted}`);
    assert.equal(report.sourceDeleted, 0, 'no --delete-source → 0 deleted');

    const srcCount = (await s.src.listNodes('decision', undefined, '*', '*')).length;
    const dstCount = (await s.dst.listNodes('decision', undefined, '*', '*')).length;
    const noteSurvived = await s.src.getNode('p4-note-keep');
    assert.equal(srcCount, 100, 'src decisions unchanged');
    assert.equal(dstCount, 100, 'dst received 100 decisions');
    assert.ok(noteSurvived, 'non-matching node not touched');
    console.log('  ✓ T1: filter-type decision moves 100, source unchanged');
    await closeScaffold(s);
}

/* ─── T2: --delete-source removes from src ─────────────────────── */

async function testT2_deleteSource(): Promise<void> {
    const s = await newScaffold('t2');
    await seedDecisions(s.src, 100);

    const report = await migrateWorkspaceToWorkspace({
        from: s.srcName, to: s.dstName, filterTypes: ['decision'],
        deleteSource: true, apply: true, force: true, onConflict: 'fail',
        injected: { srcGraph: s.src, dstGraph: s.dst },
    });
    assert.equal(report.upserted, 100);
    assert.equal(report.sourceDeleted, 100);

    const srcCount = (await s.src.listNodes('decision', undefined, '*', '*')).length;
    const dstCount = (await s.dst.listNodes('decision', undefined, '*', '*')).length;
    assert.equal(srcCount, 0, 'src empty after delete-source');
    assert.equal(dstCount, 100, 'dst received 100');
    console.log('  ✓ T2: --delete-source clears src + populates dst');
    await closeScaffold(s);
}

/* ─── T3: --include-edges migrates only enclosed edges ─────────── */

async function testT3_includeEdges(): Promise<void> {
    const s = await newScaffold('t3');
    await seedDecisions(s.src, 3);
    await s.src.addEdge({ sourceId: 'p4-dec-0', targetId: 'p4-dec-1', relation: 'depends_on', confidence: 'extracted', confidenceScore: 1 });
    await s.src.upsertNode({
        id: 'p4-note-other', type: 'note', label: 'orphan',
        content: '', tags: '', project: 'src', ecosystem: 'default',
        metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
    });
    await s.src.addEdge({ sourceId: 'p4-dec-2', targetId: 'p4-note-other', relation: 'related_to', confidence: 'extracted', confidenceScore: 1 });

    const report = await migrateWorkspaceToWorkspace({
        from: s.srcName, to: s.dstName, filterTypes: ['decision'],
        includeEdges: true, apply: true, force: true, onConflict: 'fail',
        injected: { srcGraph: s.src, dstGraph: s.dst },
    });
    assert.equal(report.upserted, 3);
    assert.equal(report.edgesCopied, 1, `expected 1 enclosed edge, got ${report.edgesCopied}`);
    console.log('  ✓ T3: --include-edges migrates only edges with both endpoints in moved set');
    await closeScaffold(s);
}

/* ─── T4: --include-vectors copies + dedupes by id ─────────────── */

async function testT4_includeVectorsDedup(): Promise<void> {
    const s = await newScaffold('t4', true);
    await seedDecisions(s.src, 5);
    for (let i = 0; i < 5; i++) {
        await s.srcV!.store({
            id: `lore:p4-dec-${i}`,
            text: `decision body ${i}`,
            metadata: { type: 'decision', label: `Decision ${i}`, tags: 'auto-seed', project: 'src', ecosystem: 'default', updatedAt: new Date().toISOString() },
        });
    }
    const r1 = await migrateWorkspaceToWorkspace({
        from: s.srcName, to: s.dstName, filterTypes: ['decision'],
        includeVectors: true, apply: true, force: true, onConflict: 'fail',
        injected: { srcGraph: s.src, dstGraph: s.dst, srcVerbatim: s.srcV, dstVerbatim: s.dstV },
    });
    assert.equal(r1.vectorsCopied, 5);
    assert.equal(r1.vectorsMissing, 0);

    let foundAll = true;
    for (let i = 0; i < 5; i++) {
        const row = await s.dstV!.getById(`lore:p4-dec-${i}`);
        if (!row || !row.text) foundAll = false;
    }
    assert.ok(foundAll, 'dst verbatim has all 5 ids');

    // Second migration with --on-conflict=overwrite — verifies vector
    // dedupe by id (5 logical nodes, 5 vector rows even after rerun).
    const r2 = await migrateWorkspaceToWorkspace({
        from: s.srcName, to: s.dstName, filterTypes: ['decision'],
        includeVectors: true, apply: true, force: true, onConflict: 'overwrite',
        injected: { srcGraph: s.src, dstGraph: s.dst, srcVerbatim: s.srcV, dstVerbatim: s.dstV },
    });
    assert.equal(r2.vectorsCopied, 5);
    // VerbatimStore.store() is canonical-id-deduped (live row replaced
    // on second write) but ALSO snapshots the prior row into a `#rev`
    // history entry for append-only audit. Dedupe by id is about
    // CANONICAL ids; filter out history rows before counting.
    const allIds = await s.dstV!.listIds('lore:p4-dec-');
    const canonicalIds = allIds.filter((id) => !id.includes('#rev'));
    assert.equal(canonicalIds.length, 5, `dst verbatim deduped canonicals: ${canonicalIds.length} (all=${allIds.length})`);
    console.log('  ✓ T4: --include-vectors copies all + dedupes by id on rerun');
    await closeScaffold(s);
}

/* ─── T5: --exclude-id-prefix filters ──────────────────────────── */

async function testT5_excludeIdPrefix(): Promise<void> {
    const s = await newScaffold('t5');
    const wantPrefix = 'keep-';
    const skipPrefixes = ['loom-dispatch-', 'agent-run-'];
    for (let i = 0; i < 5; i++) {
        await s.src.upsertNode({
            id: `${wantPrefix}dec-${i}`, type: 'decision', label: `keep ${i}`,
            content: '', tags: '', project: 'src', ecosystem: 'default',
            metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
        });
    }
    for (const p of skipPrefixes) {
        for (let i = 0; i < 3; i++) {
            await s.src.upsertNode({
                id: `${p}dec-${i}`, type: 'decision', label: `${p} ${i}`,
                content: '', tags: '', project: 'src', ecosystem: 'default',
                metadata: '{}', language: null, ephemeral: false, ttl_ms: null,
            });
        }
    }

    const report = await migrateWorkspaceToWorkspace({
        from: s.srcName, to: s.dstName, filterTypes: ['decision'],
        excludeIdPrefixes: skipPrefixes,
        apply: true, force: true, onConflict: 'fail',
        injected: { srcGraph: s.src, dstGraph: s.dst },
    });
    assert.equal(report.candidates, 5);
    assert.equal(report.upserted, 5);

    const dstNodes = await s.dst.listNodes('decision', undefined, '*', '*');
    assert.equal(dstNodes.length, 5);
    for (const n of dstNodes) {
        assert.ok(n.id.startsWith(wantPrefix), `dst node leaked excluded prefix: ${n.id}`);
    }
    console.log('  ✓ T5: --exclude-id-prefix filters loom-dispatch- + agent-run-');
    await closeScaffold(s);
}

/* ─── T6: --dry-run reports counts; no mutation ────────────────── */

async function testT6_dryRunNoMutation(): Promise<void> {
    const s = await newScaffold('t6');
    await seedDecisions(s.src, 10);

    const report = await migrateWorkspaceToWorkspace({
        from: s.srcName, to: s.dstName, filterTypes: ['decision'],
        deleteSource: true, apply: false, force: true, onConflict: 'fail',
        injected: { srcGraph: s.src, dstGraph: s.dst },
    });
    assert.equal(report.appliedMode, 'dry-run');
    assert.equal(report.upserted, 10, 'dry-run reports would-be upserts');
    assert.equal(report.sourceDeleted, 10, 'dry-run reports would-be deletes');

    const srcCount = (await s.src.listNodes('decision', undefined, '*', '*')).length;
    const dstCount = (await s.dst.listNodes('decision', undefined, '*', '*')).length;
    assert.equal(srcCount, 10, 'src untouched in dry-run');
    assert.equal(dstCount, 0, 'dst empty in dry-run');
    console.log('  ✓ T6: --dry-run reports counts without mutating');
    await closeScaffold(s);
}

/* ─── T7: lore compact reduces lancedb size after deletes ──────── */

async function testT7_compactReducesLancedbSize(): Promise<void> {
    const s = await newScaffold('t7', true);
    for (let i = 0; i < 200; i++) {
        await s.srcV!.store({
            id: `lore:p4-t7-${i}`,
            text: `seed content for ${i} `.repeat(50),
            metadata: { type: 'decision', label: `T7 ${i}`, tags: '', project: 'src', ecosystem: 'default', updatedAt: new Date().toISOString() },
        });
    }
    for (let i = 0; i < 200; i++) {
        await s.srcV!.delete(`lore:p4-t7-${i}`);
    }
    const lancedbDir = path.join(s.srcPath, '.lore', 'lancedb');
    const sizeBefore = dirSize(lancedbDir);

    await compactCommand([s.srcName, '--lancedb', '--force']);

    const sizeAfter = dirSize(lancedbDir);
    assert.ok(sizeBefore > 0, 'sizeBefore is non-zero');
    assert.ok(sizeAfter < sizeBefore, `compact should reduce size: before=${sizeBefore}B after=${sizeAfter}B`);
    console.log(`  ✓ T7: lore compact reduces lancedb dir size (${sizeBefore}B → ${sizeAfter}B)`);
    await closeScaffold(s);
}

function dirSize(p: string): number {
    if (!fs.existsSync(p)) return 0;
    let total = 0;
    const stack: string[] = [p];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const child = path.join(cur, entry.name);
            try {
                if (entry.isDirectory()) stack.push(child);
                else if (entry.isFile()) total += fs.statSync(child).size;
            } catch { /* file vanished mid-walk; ignore */ }
        }
    }
    return total;
}

/* ─── Runner ───────────────────────────────────────────────────── */
//
// Each test runs in its own child process with its own fresh LORE_HOME:
// the spec's 100-row tests stay isolated from one another (no shared
// stores, no cross-test state), and a hard exit sidesteps any lingering
// async-driver handles. The main process is just the conductor.
//
// (Historically this isolation existed because the legacy engine's native Node
// binding segfaulted after thousands of writes; the engine is SurrealDB
// now, but per-test isolation is still the reliable shape.)
//
// LORE_HOME is per-child (the main process pre-creates and threads
// it in via env), so each child sees a fresh workspaces.json + graph
// state.

type TestFn = () => Promise<void>;
const TESTS: Record<string, TestFn> = {
    t1: testT1_filterTypeNoDelete,
    t2: testT2_deleteSource,
    t3: testT3_includeEdges,
    t4: testT4_includeVectorsDedup,
    t5: testT5_excludeIdPrefix,
    t6: testT6_dryRunNoMutation,
    t7: testT7_compactReducesLancedbSize,
};

async function runOneTestInProcess(name: string): Promise<void> {
    const fn = TESTS[name];
    if (!fn) {
        console.error(`unknown test: ${name}`);
        process.exit(2);
    }
    await fn();
    // Hard-exit so any lingering async Surreal/LanceDB handles can't
    // hold the event loop open — the parent sees a clean exit code.
    process.exit(0);
}

async function runAllTestsInChildren(): Promise<void> {
    console.log('phase6-p4-migrate-and-compact-unit.ts');
    const selfPath = fileURLToPath(import.meta.url);
    const tsxBin = path.join(
        path.dirname(path.dirname(selfPath)),
        'node_modules', '.bin', 'tsx',
    );
    for (const name of Object.keys(TESTS)) {
        const childHome = fs.mkdtempSync(path.join(TEST_HOME!, `${name}-home-`));
        // Re-seed workspaces.json INSIDE the child's LORE_HOME so its
        // config/workspaces.ts module-cache picks up that home.
        seedAllWorkspaces(childHome);
        const result = spawnSync(tsxBin, [selfPath, '--child', name], {
            env: { ...process.env, LORE_HOME: childHome, LORE_P4_CHILD: '1' },
            stdio: ['inherit', 'inherit', 'inherit'],
        });
        if (result.status !== 0) {
            console.error(`child test ${name} exited with code ${result.status}`);
            process.exit(result.status ?? 1);
        }
    }
    console.log('All P4 tests passed.');
}

if (process.env['LORE_P4_CHILD'] === '1') {
    const arg = process.argv[process.argv.indexOf('--child') + 1];
    await runOneTestInProcess(arg);
} else {
    await runAllTestsInChildren();
}
