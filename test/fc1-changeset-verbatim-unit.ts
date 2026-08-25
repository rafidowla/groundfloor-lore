#!/usr/bin/env tsx
/**
 * test/fc1-changeset-verbatim-unit.ts — 2026-08-17 audit finding M7 (cluster 1).
 *
 * commit_changeset / rollback_changeset wrote STRAIGHT to the graph — no
 * verbatim row, no embed, no outbox row — so changeset-created nodes never
 * became searchable, and a rollback left the reverted-away text live in the
 * search index. Both surfaces (MCP tool + REST twin) now route through
 * core/nodeService (outbox/inline verbatim + embed) plus a verbatim
 * tombstone for deletes (mcp/changesetWrite.ts).
 *
 * Harness: the REAL registerVersioningTools + commit_changeset /
 * rollback_changeset tool handlers (FakeMcpServer pattern from
 * sp-quota-changeset-unit.ts), with a Map-backed graph, a recording inline
 * verbatim writer (the storageClient facade seam), and a recording
 * tombstonable boot verbatim store.
 *
 * Run: npx tsx test/fc1-changeset-verbatim-unit.ts
 */

import assert from 'node:assert/strict';
import { registerVersioningTools } from '../packages/lore/src/mcp/tools/versioning.js';
import type { VersioningDeps } from '../packages/lore/src/mcp/tools/versioning.js';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        passed++;
        console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    } catch (err) {
        failed++;
        console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
        console.log(`    ${(err as Error).stack ?? (err as Error).message}`);
    }
}

interface RecordedTool { name: string; handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>; }
class FakeMcpServer {
    public tools: RecordedTool[] = [];
    tool(name: string, _d: string, _s: unknown, handler: RecordedTool['handler']) { this.tools.push({ name, handler }); }
}
const classify = (r: { content: Array<{ text: string }> }): Record<string, unknown> =>
    JSON.parse(r.content[0].text);

type Write = { seq: number; operation: 'upsert_node' | 'delete_node'; payload: Record<string, unknown> };

function makeHarness(writes: Write[]) {
    let status: 'open' | 'committed' | 'rolled_back' = 'open';
    const versions: Array<Record<string, unknown>> = [];
    const versionStore = {
        getChangeset: (id: string) => ({ changesetId: id, workspace: 'dev', status }),
        getChangesetWrites: (_id: string) => writes,
        recordVersion: (v: Record<string, unknown>) => { versions.push(v); },
        updateChangeset: (_id: string, s: typeof status) => { status = s; },
        getVersionsByChangeset: () => versions,
        createChangeset: () => 'cs-1',
        getVersions: () => [], getDiff: () => [], addChangesetWrite: () => 1,
    };
    const nodes = new Map<string, Record<string, unknown>>();
    const graph = {
        nodes,
        async upsertNode(n: Record<string, unknown>) { nodes.set(String(n['id']), n); return n; },
        async getNode(id: string) { return nodes.get(id) ?? null; },
        async deleteNode(id: string) { return nodes.delete(id); },
    };
    const verbatimWrites: Array<{ id: string; text: string }> = [];
    const tombstones: string[] = [];
    const storageClient = {
        verbatimStore: async (doc: { id: string; text: string }) => { verbatimWrites.push({ id: doc.id, text: doc.text }); },
    };
    const loreVerbatim = { tombstone: async (id: string) => { tombstones.push(id); } };
    const deps = {
        versionStore: versionStore as never,
        store: { loreGraph: graph, storageClient, loreVerbatim } as never,
        graphRegistry: undefined,
        detectedScope: { workspace: 'dev', ecosystem: '*' },
    } as unknown as VersioningDeps;
    return { deps, graph, verbatimWrites, tombstones, versions, status: () => status };
}

function tool(deps: VersioningDeps, name: string): RecordedTool {
    const srv = new FakeMcpServer();
    registerVersioningTools(srv as never, deps);
    return srv.tools.find((t) => t.name === name)!;
}

async function main() {
    console.log('M7 — changeset commit/rollback write to EVERY substrate, not just the graph');

    await test('T1.M7a commit upsert lands in graph AND verbatim (searchable); delete tombstones', async () => {
        const h = makeHarness([
            { seq: 0, operation: 'upsert_node', payload: { workspace: 'dev', nodeData: { id: 'cs-n1', type: 'decision', label: 'from changeset', content: 'changeset content' } } },
            { seq: 1, operation: 'delete_node', payload: { workspace: 'dev', node_id: 'cs-old' } },
        ]);
        h.graph.nodes.set('cs-old', { id: 'cs-old', type: 'note' });
        const res = classify(await tool(h.deps, 'commit_changeset').handler({ changeset_id: 'cs-1' }));
        assert.equal(res['status'], 'committed');
        assert.equal(res['applied'], 2);
        assert.ok(h.graph.nodes.has('cs-n1'), 'graph write landed');
        assert.ok(!h.graph.nodes.has('cs-old'), 'graph delete landed');
        assert.ok(h.verbatimWrites.some((d) => d.id === 'lore:cs-n1'),
            `pre-fix: NO verbatim row — the node was never searchable (got ${JSON.stringify(h.verbatimWrites)})`);
        assert.ok(h.tombstones.includes('lore:cs-old'),
            'pre-fix: deleted node text stayed live in the search index');
    });

    await test('T1.M7b rollback restores the verbatim index to the REVERTED state', async () => {
        // Start from a committed changeset: one upsert of a brand-new node
        // (previousState null) and one upsert overwriting an existing node.
        const h = makeHarness([]);
        h.versions.push(
            { nodeId: 'cs-new', workspace: 'dev', operation: 'upsert', previousState: null },
            { nodeId: 'cs-existing', workspace: 'dev', operation: 'upsert', previousState: { id: 'cs-existing', type: 'note', label: 'original', content: 'original text' } },
        );
        // Force status to committed.
        await tool(h.deps, 'commit_changeset'); // tools registered; now flip via handler path:
        // Simpler: drive the fake store directly.
        (h.deps.versionStore as { updateChangeset: (id: string, s: string) => void }).updateChangeset('cs-1', 'committed');
        h.graph.nodes.set('cs-new', { id: 'cs-new', type: 'note', label: 'new', content: 'new text' });
        h.graph.nodes.set('cs-existing', { id: 'cs-existing', type: 'note', label: 'changed', content: 'changed text' });

        const res = classify(await tool(h.deps, 'rollback_changeset').handler({ changeset_id: 'cs-1' }));
        assert.equal(res['status'], 'rolled_back');
        assert.equal(res['reversed'], 2);
        assert.ok(!h.graph.nodes.has('cs-new'), 'created node deleted from graph');
        assert.equal(h.graph.nodes.get('cs-existing')?.['content'], 'original text', 'graph reverted');
        assert.ok(h.tombstones.includes('lore:cs-new'),
            'verbatim for the rolled-back create is tombstoned (pre-fix: stayed searchable)');
        assert.ok(h.verbatimWrites.some((d) => d.id === 'lore:cs-existing'),
            'verbatim re-written with the REVERTED text (pre-fix: post-commit text stayed indexed)');
        const restored = h.verbatimWrites.find((d) => d.id === 'lore:cs-existing')!;
        assert.ok(restored.text.includes('original text'), 'reverted text is what got re-embedded');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('TEST HARNESS FAILED:', e); process.exit(2); });
