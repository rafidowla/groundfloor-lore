/**
 * test/maintain-unit.ts
 *
 * Unit tests for the config-driven `maintain` capability:
 *   - policy resolution (defaults, env, explicit overrides, precedence)
 *   - duration / list parsing
 *   - ephemeral pattern matching + tag parsing
 *   - retention selection (protect_tags + recency)
 *   - ephemeral workspace selection (pattern + ttl + active/bootstrap guards)
 *   - orchestrator: dry-run does ZERO writes
 *   - orchestrator: destructive ops blocked while a write session is active
 *   - orchestrator: per-table error isolation
 *
 * Run: npx tsx test/maintain-unit.ts
 */

import * as assert from 'node:assert/strict';

import {
    MAINTAIN_DEFAULTS,
    resolveMaintainPolicy,
    parseDuration,
    parseList,
} from '../packages/lore/src/engines/maintain/policy.js';
import {
    matchesAnyPattern,
    parseTags,
    isProtected,
    selectRetentionCandidates,
    selectEphemeralWorkspaces,
    type NodeForSelection,
    type WorkspaceForSelection,
} from '../packages/lore/src/engines/maintain/selection.js';
import { runMaintenance } from '../packages/lore/src/engines/maintain/maintain.js';
import type {
    LanceMaintainerPort, LanceTableProbe, LanceTableResult,
    NodeStorePort, WorkspaceRegistryPort, SafetyPort,
} from '../packages/lore/src/engines/maintain/ports.js';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000; // fixed clock

// ── policy resolution ───────────────────────────────────────────────────────

function testPolicyDefaults(): void {
    const p = resolveMaintainPolicy({}, { skipEnv: true });
    assert.equal(p.retentionDays, 90);
    assert.equal(p.cleanupVersionsOlderThanMs, 7 * DAY);
    assert.equal(p.compactFragmentThreshold, 200);
    assert.equal(p.ephemeralWorkspaceTtlDays, 14);
    assert.deepEqual(p.ephemeralWorkspacePatterns, ['e2e-*', '*-smoke', '*-test']);
    assert.deepEqual(p.protectTags, ['pinned', 'protected']);
    assert.equal(p.nodeRetentionAction, 'archive');
    assert.deepEqual(p.enabled, { compaction: true, versionCleanup: true, nodeRetention: true, ephemeralExpiry: true });
    console.log('  ✓ defaults resolve to spec values');
}

function testPolicyEnvLayer(): void {
    const saved = { ...process.env };
    try {
        process.env.LORE_MAINTAIN_RETENTION_DAYS = '30';
        process.env.LORE_MAINTAIN_CLEANUP_VERSIONS_OLDER_THAN = '48h';
        process.env.LORE_MAINTAIN_PROTECT_TAGS = 'keep,hold';
        process.env.LORE_MAINTAIN_COMPACTION = 'off';
        const p = resolveMaintainPolicy({});
        assert.equal(p.retentionDays, 30, 'env retention');
        assert.equal(p.cleanupVersionsOlderThanMs, 48 * 3_600_000, 'env duration parsed');
        assert.deepEqual(p.protectTags, ['keep', 'hold'], 'env tags');
        assert.equal(p.enabled.compaction, false, 'env disable flag');
        assert.equal(p.enabled.versionCleanup, true, 'untouched flag stays default');
    } finally {
        process.env = saved;
    }
    console.log('  ✓ env layer overrides defaults');
}

function testPolicyOverridePrecedence(): void {
    const saved = { ...process.env };
    try {
        process.env.LORE_MAINTAIN_RETENTION_DAYS = '30';
        // Explicit override must beat env.
        const p = resolveMaintainPolicy({ retentionDays: 5, enabled: { ephemeralExpiry: false } });
        assert.equal(p.retentionDays, 5, 'explicit override wins over env');
        assert.equal(p.enabled.ephemeralExpiry, false);
        assert.equal(p.enabled.compaction, true);
    } finally {
        process.env = saved;
    }
    console.log('  ✓ explicit overrides beat env beats defaults');
}

function testParsing(): void {
    assert.equal(parseDuration('7d'), 7 * DAY);
    assert.equal(parseDuration('168h'), 168 * 3_600_000);
    assert.equal(parseDuration('30m'), 30 * 60_000);
    assert.equal(parseDuration('604800s'), 604800 * 1000);
    assert.equal(parseDuration('14'), 14 * DAY, 'bare integer = days');
    assert.throws(() => parseDuration('soon'), /Invalid duration/);
    assert.throws(() => parseDuration('7days'), /Invalid duration/);
    assert.deepEqual(parseList('a, b ,c'), ['a', 'b', 'c']);
    assert.deepEqual(parseList('e2e-*  *-smoke'), ['e2e-*', '*-smoke']);
    assert.equal(MAINTAIN_DEFAULTS.retentionDays, 90, 'defaults object intact');
    console.log('  ✓ duration + list parsing');
}

// ── pattern matching + tags ──────────────────────────────────────────────────

function testPatternMatching(): void {
    const pats = ['e2e-*', '*-smoke', '*-test'];
    assert.equal(matchesAnyPattern('e2e-checkout', pats), true);
    assert.equal(matchesAnyPattern('nightly-smoke', pats), true);
    assert.equal(matchesAnyPattern('regression-test', pats), true);
    assert.equal(matchesAnyPattern('E2E-Upper', pats), true, 'case-insensitive');
    assert.equal(matchesAnyPattern('production', pats), false);
    assert.equal(matchesAnyPattern('teste2e', pats), false, 'no substring false-positive');
    assert.equal(matchesAnyPattern('test', ['test']), true, 'exact, no wildcard');
    assert.equal(matchesAnyPattern('a.b', ['a.b']), true, 'dot is literal not regex');
    assert.equal(matchesAnyPattern('axb', ['a.b']), false, 'dot not treated as wildcard');
    console.log('  ✓ glob pattern matching');
}

function testTagsAndProtection(): void {
    assert.deepEqual(parseTags('Pinned, Foo'), ['pinned', 'foo']);
    assert.deepEqual(parseTags('["A","B"]'), ['a', 'b'], 'JSON-array tag string');
    assert.deepEqual(parseTags(''), []);
    assert.deepEqual(parseTags(null), []);
    const protect = ['pinned', 'protected'];
    assert.equal(isProtected({ id: '1', tags: 'pinned,x' }, protect), true, 'tag match');
    assert.equal(isProtected({ id: '2', tags: 'x,y' }, protect), false);
    assert.equal(isProtected({ id: '3', tags: '', status: 'protected' }, protect), true, 'status protected');
    assert.equal(isProtected({ id: '4', tags: '', legalHold: true }, protect), true, 'legal hold');
    console.log('  ✓ tag parsing + protection');
}

// ── retention selection ──────────────────────────────────────────────────────

function testRetentionSelection(): void {
    const policy = resolveMaintainPolicy({ retentionDays: 90 }, { skipEnv: true });
    const old = new Date(NOW - 200 * DAY).toISOString();
    const recent = new Date(NOW - 10 * DAY).toISOString();
    const nodes: NodeForSelection[] = [
        { id: 'cold-1', tags: 'x', updatedAt: old },
        { id: 'cold-2', tags: '', updatedAt: old },
        { id: 'protected-old', tags: 'pinned', updatedAt: old },     // protected → never candidate
        { id: 'protected-status', tags: '', status: 'protected', updatedAt: old },
        { id: 'recent', tags: 'x', updatedAt: recent },              // recent → skip
        { id: 'no-ts', tags: 'x' },                                  // missing ts → treated old → candidate
    ];
    const sel = selectRetentionCandidates(nodes, policy, NOW);
    const ids = sel.candidates.map((n) => n.id).sort();
    assert.deepEqual(ids, ['cold-1', 'cold-2', 'no-ts']);
    assert.equal(sel.protectedCount, 2, 'two protected');
    assert.equal(sel.recentCount, 1, 'one recent');
    assert.equal(sel.inspected, 6);
    // Protection checked BEFORE recency: a protected+recent node counts protected.
    const sel2 = selectRetentionCandidates(
        [{ id: 'pr', tags: 'pinned', updatedAt: recent }], policy, NOW,
    );
    assert.equal(sel2.protectedCount, 1);
    assert.equal(sel2.recentCount, 0);
    console.log('  ✓ retention selection respects protect_tags + recency');
}

function testColdSignalSelection(): void {
    const old = new Date(NOW - 200 * DAY).toISOString();
    const recent = new Date(NOW - 5 * DAY).toISOString();
    // Node edited long ago (cold by updatedAt) BUT retrieved recently.
    const nodes: NodeForSelection[] = [
        { id: 'retrieved-recently', tags: '', updatedAt: old, last_retrieved_at: recent, lastAccessedAt: recent },
        { id: 'browsed-only', tags: '', updatedAt: old, last_retrieved_at: '', lastAccessedAt: recent }, // viewed in graph, never retrieved
        { id: 'never-touched', tags: '', updatedAt: old, last_retrieved_at: '', lastAccessedAt: '' },     // falls back to updatedAt (old)
    ];

    // Default 'retrieval': only deliberate retrieval keeps a node warm.
    const retr = resolveMaintainPolicy({ retentionDays: 90 }, { skipEnv: true });
    assert.equal(retr.coldSignal, 'retrieval', 'default cold signal');
    const sRetr = selectRetentionCandidates(nodes, retr, NOW);
    assert.deepEqual(sRetr.candidates.map((n) => n.id).sort(), ['browsed-only', 'never-touched'],
        'retrieval signal: browsing does NOT save a node; only retrieval does');

    // 'access': any read (incl. graph view) keeps a node warm.
    const acc = resolveMaintainPolicy({ retentionDays: 90, coldSignal: 'access' }, { skipEnv: true });
    const sAcc = selectRetentionCandidates(nodes, acc, NOW);
    assert.deepEqual(sAcc.candidates.map((n) => n.id), ['never-touched'],
        'access signal: a recently-viewed node is spared');

    // 'update': legacy proxy — access times ignored entirely.
    const upd = resolveMaintainPolicy({ retentionDays: 90, coldSignal: 'update' }, { skipEnv: true });
    const sUpd = selectRetentionCandidates(nodes, upd, NOW);
    assert.deepEqual(sUpd.candidates.map((n) => n.id).sort(), ['browsed-only', 'never-touched', 'retrieved-recently'],
        'update signal: all three are cold by updatedAt');
    console.log('  ✓ cold_signal selection (retrieval/access/update) with updatedAt fallback');
}

// ── ephemeral workspace selection ────────────────────────────────────────────

function testEphemeralSelection(): void {
    const policy = resolveMaintainPolicy({ ephemeralWorkspaceTtlDays: 14 }, { skipEnv: true });
    const old = new Date(NOW - 30 * DAY).toISOString();
    const young = new Date(NOW - 2 * DAY).toISOString();
    const wss: WorkspaceForSelection[] = [
        { name: 'e2e-old', path: '/home/workspaces/e2e-old', createdAt: old },
        { name: 'nightly-smoke', path: '/home/workspaces/nightly-smoke', createdAt: old },
        { name: 'e2e-young', path: '/home/workspaces/e2e-young', createdAt: young },
        { name: 'developer', path: '/home/workspaces/developer', createdAt: old }, // non-matching
        { name: 'e2e-active', path: '/home/workspaces/e2e-active', createdAt: old }, // active guard
        { name: 'e2e-boot', path: '/home', createdAt: old },                         // bootstrap guard
    ];
    const sel = selectEphemeralWorkspaces(wss, policy, NOW, { activeName: 'e2e-active', bootstrapPath: '/home' });
    const names = sel.candidates.map((w) => w.name).sort();
    assert.deepEqual(names, ['e2e-old', 'nightly-smoke'], 'only old matching, non-guarded');
    assert.equal(sel.tooYoungCount, 1, 'e2e-young too young');
    console.log('  ✓ ephemeral selection: pattern + ttl + active/bootstrap guards');
}

// ── orchestrator fakes ───────────────────────────────────────────────────────

class FakeLance implements LanceMaintainerPort {
    optimizeCalls: string[] = [];
    constructor(private readonly probes: LanceTableProbe[], private readonly failOn: Set<string> = new Set()) {}
    async probe(): Promise<LanceTableProbe[]> { return this.probes; }
    async optimizeTable(name: string): Promise<LanceTableResult> {
        this.optimizeCalls.push(name);
        if (this.failOn.has(name)) throw new Error(`boom-${name}`);
        return { name, beforeBytes: 100, afterBytes: 40, bytesReclaimed: 60, versionsRemoved: 3, fragmentsRemoved: 2, compacted: true };
    }
}
class FakeNodes implements NodeStorePort {
    archived: string[] = []; deleted: string[] = [];
    constructor(private readonly nodes: NodeForSelection[]) {}
    async listAll(): Promise<NodeForSelection[]> { return this.nodes; }
    async archive(id: string): Promise<void> { this.archived.push(id); }
    async delete(id: string): Promise<void> { this.deleted.push(id); }
}
class FakeWorkspaces implements WorkspaceRegistryPort {
    deleted: string[] = [];
    constructor(private readonly wss: WorkspaceForSelection[], private readonly active: string, private readonly boot: string) {}
    list(): WorkspaceForSelection[] { return this.wss; }
    activeName(): string { return this.active; }
    bootstrapPath(): string { return this.boot; }
    delete(name: string): { bytesFreed: number } { this.deleted.push(name); return { bytesFreed: 1234 }; }
}
const safety = (active: boolean): SafetyPort => ({ async writeActive() { return active; } });

const oldIso = new Date(NOW - 200 * DAY).toISOString();

async function testDryRunZeroWrites(): Promise<void> {
    const policy = resolveMaintainPolicy({}, { skipEnv: true });
    const lance = new FakeLance([{ name: 't1', bytes: 100, versions: 5, eligibleOldVersions: 3, fragments: 300 }]);
    const nodes = new FakeNodes([{ id: 'cold', tags: 'x', updatedAt: oldIso }]);
    const wss = new FakeWorkspaces([{ name: 'e2e-x', path: '/h/workspaces/e2e-x', createdAt: oldIso }], 'default', '/h');
    const report = await runMaintenance(policy, { lance, nodes, workspaces: wss, safety: safety(false) }, { dryRun: true, now: NOW });

    assert.equal(lance.optimizeCalls.length, 0, 'NO optimize in dry-run');
    assert.equal(nodes.archived.length, 0, 'NO archive in dry-run');
    assert.equal(nodes.deleted.length, 0, 'NO delete in dry-run');
    assert.equal(wss.deleted.length, 0, 'NO workspace delete in dry-run');
    // But it still reports what WOULD happen.
    assert.equal(report.lancedb.eligibleOldVersions, 3);
    assert.equal(report.nodes.candidates, 1);
    assert.deepEqual(report.workspaces.expired, ['e2e-x']);
    console.log('  ✓ dry-run does zero writes but reports candidates');
}

async function testLockedBlocksDestructive(): Promise<void> {
    const policy = resolveMaintainPolicy({}, { skipEnv: true });
    const lance = new FakeLance([{ name: 't1', bytes: 100, versions: 5, eligibleOldVersions: 3, fragments: 300 }]);
    const nodes = new FakeNodes([{ id: 'cold', tags: 'x', updatedAt: oldIso }]);
    const wss = new FakeWorkspaces([{ name: 'e2e-x', path: '/h/workspaces/e2e-x', createdAt: oldIso }], 'default', '/h');
    // writeActive=true, allowOnline not set → destructive blocked.
    const report = await runMaintenance(policy, { lance, nodes, workspaces: wss, safety: safety(true) }, { dryRun: false, now: NOW });
    assert.equal(lance.optimizeCalls.length, 0, 'optimize blocked while writing');
    assert.equal(nodes.archived.length, 0, 'archive blocked while writing');
    assert.equal(wss.deleted.length, 0, 'workspace delete blocked while writing');
    const locked = report.operations.filter((o) => o.skippedReason === 'locked').map((o) => o.operation).sort();
    assert.deepEqual(locked, ['compaction', 'ephemeralExpiry', 'nodeRetention', 'versionCleanup']);

    // allowOnline overrides the lock.
    const lance2 = new FakeLance([{ name: 't1', bytes: 100, versions: 5, eligibleOldVersions: 3, fragments: 300 }]);
    const nodes2 = new FakeNodes([{ id: 'cold', tags: 'x', updatedAt: oldIso }]);
    const wss2 = new FakeWorkspaces([{ name: 'e2e-x', path: '/h/workspaces/e2e-x', createdAt: oldIso }], 'default', '/h');
    await runMaintenance(policy, { lance: lance2, nodes: nodes2, workspaces: wss2, safety: safety(true) }, { dryRun: false, allowOnline: true, now: NOW });
    assert.equal(lance2.optimizeCalls.length, 1, 'allowOnline lets optimize run');
    assert.equal(nodes2.archived.length, 1, 'allowOnline lets archive run');
    assert.equal(wss2.deleted.length, 1, 'allowOnline lets expiry run');
    console.log('  ✓ active write session blocks destructive ops unless --online');
}

async function testErrorIsolation(): Promise<void> {
    const policy = resolveMaintainPolicy({ compactFragmentThreshold: 1 }, { skipEnv: true });
    const lance = new FakeLance(
        [
            { name: 'good1', bytes: 100, versions: 5, eligibleOldVersions: 2, fragments: 10 },
            { name: 'bad', bytes: 100, versions: 5, eligibleOldVersions: 2, fragments: 10 },
            { name: 'good2', bytes: 100, versions: 5, eligibleOldVersions: 2, fragments: 10 },
        ],
        new Set(['bad']),
    );
    const report = await runMaintenance(policy, { lance, safety: safety(false) }, { dryRun: false, now: NOW });
    assert.deepEqual(lance.optimizeCalls.sort(), ['bad', 'good1', 'good2'], 'all tables attempted');
    assert.equal(report.lancedb.tables.length, 2, 'two succeeded');
    const vcErrors = report.operations.find((o) => o.operation === 'versionCleanup')!.errors;
    assert.ok(vcErrors.some((e) => e.includes('bad') && e.includes('boom-bad')), 'failure captured, not thrown');
    assert.equal(report.lancedb.totalBytesReclaimed, 120, 'reclaim summed across the 2 good tables');
    console.log('  ✓ per-table error isolation');
}

async function testNodeDeleteAction(): Promise<void> {
    const policy = resolveMaintainPolicy({ nodeRetentionAction: 'delete' }, { skipEnv: true });
    const nodes = new FakeNodes([
        { id: 'cold', tags: 'x', updatedAt: oldIso },
        { id: 'pinned', tags: 'pinned', updatedAt: oldIso },
    ]);
    const report = await runMaintenance(policy, { nodes, safety: safety(false) }, { dryRun: false, now: NOW });
    assert.deepEqual(nodes.deleted, ['cold'], 'cold deleted, pinned protected');
    assert.equal(nodes.archived.length, 0);
    assert.equal(report.nodes.deleted, 1);
    assert.equal(report.nodes.protectedSkipped, 1);
    console.log('  ✓ node_action=delete hard-deletes cold, spares protected');
}

async function testDisabledOps(): Promise<void> {
    const policy = resolveMaintainPolicy({ enabled: { compaction: false, versionCleanup: false } }, { skipEnv: true });
    const lance = new FakeLance([{ name: 't', bytes: 1, versions: 1, eligibleOldVersions: 0, fragments: 1 }]);
    const report = await runMaintenance(policy, { lance, safety: safety(false) }, { dryRun: false, now: NOW });
    assert.equal(lance.optimizeCalls.length, 0, 'disabled lancedb ops never call optimize');
    const dis = report.operations.filter((o) => o.skippedReason === 'disabled').map((o) => o.operation).sort();
    assert.ok(dis.includes('compaction') && dis.includes('versionCleanup'));
    console.log('  ✓ per-operation disable flags honored');
}

// ── runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('maintain unit tests');
    testPolicyDefaults();
    testPolicyEnvLayer();
    testPolicyOverridePrecedence();
    testParsing();
    testPatternMatching();
    testTagsAndProtection();
    testRetentionSelection();
    testColdSignalSelection();
    testEphemeralSelection();
    await testDryRunZeroWrites();
    await testLockedBlocksDestructive();
    await testErrorIsolation();
    await testNodeDeleteAction();
    await testDisabledOps();
    console.log('\n✓ All maintain unit tests passed.');
}

main().catch((err) => {
    console.error('✗ maintain-unit:', err);
    process.exit(1);
});
