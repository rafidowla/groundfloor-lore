#!/usr/bin/env tsx
/**
 * test/ingestion-embedded-registry-home-unit.ts — Finding 3 (post-review,
 * 3.20.2) sibling bug in `mcp/tools/ingestion.ts`, left unfixed when the
 * identical defect was patched in `governance.ts` / `lifecycle.ts` on this
 * branch (commit 145f69be).
 *
 * `read_document_for_ingestion` and `import_data` both call
 * `getWorkspacePath(resolved.resolvedWorkspace)` with NO home argument to
 * locate the workspace's on-disk path for the quota-inspection gate
 * (`inspectDataHome`). `getWorkspacePath` defaults to the process-wide
 * `loreHome()` registry, not an embedded instance's own `dataHome`.
 *
 * For an embedded host (its own `dataDir`, separate from the process-wide
 * `LORE_HOME`) whose requested workspace is registered ONLY in its own
 * registry (not in the process-wide one), `getWorkspacePath` THROWS
 * `workspace_not_found` — the quota gate's `catch` block treats that as a
 * fail-closed error, so the tool returns `isError: true` instead of doing
 * any ingestion at all. This isn't just mis-targeted (like Finding 1) —
 * ingestion is fully broken for that workspace.
 *
 * Both tools are ALSO resolved earlier in their handlers via
 * `resolveTargetGraph(deps.store, deps.graphRegistry, ...)`, which DOES
 * correctly consult the embedded instance's own registry (through
 * `LocalGraphRegistry`). So the resolution succeeds up to that point, and
 * only the later bare `getWorkspacePath(...)` call trips over the foreign
 * registry — exactly the shape Finding 3 already fixed in
 * `list_workspaces` / `prune_nodes`.
 *
 * Finding 3 (post-review, 3.20.2) — strengthened assertions. The original
 * version of this test only checked `!result.isError`, which is a weak
 * proxy: a regression that swallowed `workspace_not_found` and silently
 * fell through (rather than truly resolving the right home) could still
 * leave `isError` false, since the actual document bytes are read via the
 * `filePath` argument directly (through `assertPathAllowed`), NOT through
 * the registry-resolved workspace path the quota gate computes — so
 * "returns the right content" does not by itself prove the quota gate
 * used the right home.
 *
 * We can't force a deterministic quota *deny* here the way the sibling
 * `store-node-quota-embedded-registry-home-unit.ts` test does for
 * `store_node` (`maxNodes` cap): `decideQuota()` in `ingestion.ts` is
 * always called as `decideQuota({ breakdown })` with no
 * `explicitBudgetBytes` override, so its budget derives from
 * `computeBudget()` — real free disk space on whatever machine runs the
 * test (`min(50GB, 20% free)`, floor 1GB). Forcing a "red tier" outcome
 * deterministically would mean writing tens of GB of real data, which
 * isn't viable for a unit test.
 *
 * Instead we add a precise, deterministic detector for the EXACT original
 * bug shape: a bare `getWorkspacePath(name)` (no home argument) resolves
 * through `loadWorkspaces()`, and `loadWorkspaces()` bootstrap-writes a
 * `workspaces.json` into whatever home it's given if one doesn't already
 * exist there. dirB (the process-wide `LORE_HOME`) is a fresh temp dir
 * with none — so if the quota gate's `getWorkspacePath()` call ever
 * resolves against dirB instead of dirA (the embedded instance's own
 * registry, via `deps.graphRegistry.homeDir()`), a `dirB/workspaces.json`
 * gets created as a side effect, REGARDLESS of whether that call then
 * throws (fail-closed, `secondws` absent from dirB) or — under some
 * future regression that also registers a same-named decoy — succeeds.
 * Asserting `dirB/workspaces.json` was never created pins the test to the
 * actual resolved home, not just the pass/fail outcome, satisfying the
 * review's "assert on ... the instance's own dataDir, not just didn't
 * throw" requirement without depending on real disk-space state.
 */

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createLore } from '../packages/lore/src/index.js';
import { createWorkspace } from '../packages/lore/src/config/workspaces.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✓ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).stack ?? (err as Error).message}`);
        failed++;
    }
}

interface ToolTextResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
}

function parseToolText<T>(result: ToolTextResult): T {
    return JSON.parse(result.content[0]?.text ?? '{}') as T;
}

/* ─────────────────────────────────────────────────────────────────
 * Shared setup: an embedded instance (dirA) whose own registry has a
 * SECOND workspace that the process-wide registry (dirB, LORE_HOME)
 * does not know about at all.
 * ────────────────────────────────────────────────────────────── */
async function withEmbeddedInstance<T>(
    fn: (ctx: { dirA: string; dirB: string; client: Client; textFile: string }) => Promise<T>,
): Promise<T> {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ingest-instance-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lore-ingest-processhome-'));
    process.env['LORE_HOME'] = dirB;

    // Registered ONLY in dirA's own registry — dirB (process-wide) has
    // never heard of it. This is the trap: resolveTargetGraph (routed via
    // deps.graphRegistry, scoped to dirA) finds it fine; a bare
    // getWorkspacePath(name) with no home argument defaults to dirB and
    // throws workspace_not_found.
    createWorkspace('secondws', {}, dirA);

    // A file under dirA (the boot-time graphBasePath / workspaceRoot for
    // the 'default' workspace) is allowed by assertPathAllowed's
    // workspaceRoot rule regardless of which named workspace the call
    // targets — the allowlist is about WHERE the bytes are, not which
    // logical workspace the call is scoped to.
    const textFile = path.join(dirA, 'ingest-note.txt');
    fs.writeFileSync(textFile, 'hello from the embedded instance\n', 'utf8');

    const lore = await createLore({ deploymentMode: 'embedded', dataDir: dirA });
    try {
        const mcpServer = lore.createMcpServer();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await mcpServer.connect(serverTransport);
        const client = new Client({ name: 'ingestion-registry-home-test', version: '0.0.1' });
        await client.connect(clientTransport);
        try {
            return await fn({ dirA, dirB, client, textFile });
        } finally {
            await client.close();
        }
    } finally {
        await lore.dispose();
        try { fs.rmSync(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(dirB, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/* ─────────────────────────────────────────────────────────────────
 * read_document_for_ingestion — the quota-gate getWorkspacePath() call.
 * ────────────────────────────────────────────────────────────── */
async function testReadDocumentForIngestion(): Promise<void> {
    console.log('\nread_document_for_ingestion — quota gate must resolve THIS instance\'s own registry');

    await withEmbeddedInstance(async ({ dirB, client, textFile }) => {
        const result = await client.callTool({
            name: 'read_document_for_ingestion',
            arguments: { filePath: textFile, workspace: 'secondws' },
        }) as unknown as ToolTextResult;

        await test('does not fail with a foreign-registry workspace_not_found error', async () => {
            assert.ok(
                !result.isError,
                `expected success; got isError=${result.isError} text=${JSON.stringify(result.content)}. ` +
                `A workspace_not_found error here means getWorkspacePath() resolved against the ` +
                `process-wide registry (${dirB}) instead of this embedded instance's own registry.`,
            );
        });

        await test('returns the extracted document content', async () => {
            const parsed = parseToolText<{ content?: string }>(result);
            assert.ok(
                parsed.content?.includes('hello from the embedded instance'),
                `expected extracted content; got ${JSON.stringify(parsed)}`,
            );
        });

        await test('quota gate resolved THIS instance\'s own registry — dirB was never bootstrap-written', async () => {
            // A bare loadWorkspaces() (the original bug) migrates/creates
            // workspaces.json in whatever home it's given. dirB (process-wide
            // LORE_HOME) starting with no control file and ending with none
            // is a direct, deterministic witness that the quota gate's
            // getWorkspacePath() call resolved against dirA, not dirB —
            // independent of whether a wrong-home resolution would have
            // thrown or succeeded.
            assert.ok(
                !fs.existsSync(path.join(dirB, 'workspaces.json')),
                `expected no workspaces.json under the process-wide home ${dirB}; the quota gate should never ` +
                `bootstrap-write a foreign registry as a side effect of resolving "secondws"`,
            );
        });
    });
}

/* ─────────────────────────────────────────────────────────────────
 * import_data — the quota-gate getWorkspacePath() call on the bulk path.
 * ────────────────────────────────────────────────────────────── */
async function testImportData(): Promise<void> {
    console.log('\nimport_data — quota gate must resolve THIS instance\'s own registry');

    await withEmbeddedInstance(async ({ dirB, client }) => {
        const csv = 'name,amount\nwidget,10\ngadget,20\n';
        const result = await client.callTool({
            name: 'import_data',
            arguments: {
                format: 'csv',
                filename: 'rows.csv',
                data: Buffer.from(csv, 'utf8').toString('base64'),
                mapping: {
                    entityType: 'test_row',
                    fields: { name: 'label', amount: 'content' },
                },
                workspace: 'secondws',
            },
        }) as unknown as ToolTextResult;

        await test('does not fail with a foreign-registry workspace_not_found error', async () => {
            assert.ok(
                !result.isError,
                `expected success; got isError=${result.isError} text=${JSON.stringify(result.content)}. ` +
                `A workspace_not_found error here means getWorkspacePath() resolved against the ` +
                `process-wide registry (${dirB}) instead of this embedded instance's own registry.`,
            );
        });

        await test('reports rows imported', async () => {
            const parsed = parseToolText<{ imported?: number; rowsImported?: number; results?: unknown[] }>(result);
            const anyCount =
                parsed.imported ?? parsed.rowsImported ?? (Array.isArray(parsed.results) ? parsed.results.length : undefined);
            assert.ok(
                (anyCount ?? 0) > 0,
                `expected a positive row/import count; got ${JSON.stringify(parsed)}`,
            );
        });

        await test('quota gate resolved THIS instance\'s own registry — dirB was never bootstrap-written', async () => {
            // See the identical assertion in testReadDocumentForIngestion for
            // the full rationale: a bare loadWorkspaces() (the original bug)
            // would have migrated/created workspaces.json in dirB as a side
            // effect of resolving "secondws" for the import_data quota gate.
            assert.ok(
                !fs.existsSync(path.join(dirB, 'workspaces.json')),
                `expected no workspaces.json under the process-wide home ${dirB}; the quota gate should never ` +
                `bootstrap-write a foreign registry as a side effect of resolving "secondws"`,
            );
        });
    });
}

async function main(): Promise<void> {
    console.log('ingestion.ts — embedded instance must not resolve getWorkspacePath() against the process-wide registry');
    await testReadDocumentForIngestion();
    await testImportData();
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

await main();
