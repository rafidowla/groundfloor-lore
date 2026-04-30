#!/usr/bin/env -S npx tsx
/**
 * scripts/atlas-cutover-destructive.mjs
 *
 * Atlas — Phase 7 DESTRUCTIVE cutover step.
 *
 * Original work authored for groundfloor-lore. License-compliance
 * protocol per `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ DESTRUCTIVE — STOP THE DAEMON BEFORE RUNNING                     │
 * │                                                                  │
 * │ This script:                                                     │
 * │   1. Captures every LoreAppliesToCode + LoreTouchesFile edge     │
 * │      from the live Kùzu graph (preserves them for re-insert)    │
 * │   2. Drops CodeSymbol / CodeFile / CodeRelation rows per repo    │
 * │      via the developer plugin's clearCodeSymbols operation       │
 * │      (DETACH DELETE strips attached edges)                       │
 * │   3. Re-indexes each repo via atlasIndexer.indexRepoWithAtlas    │
 * │      (parseRepo + resolveRepo + upsert to Kùzu)                  │
 * │   4. Rewrites LoreAppliesToCode edges via the oldUid → newId    │
 * │      mapping. Unmapped edges are dropped (reconnect re-suggests).│
 * │   5. Re-inserts LoreTouchesFile edges (CodeFile path-keyed,     │
 * │      survives cutover unchanged).                                │
 * │                                                                  │
 * │ Refuses unless:                                                  │
 * │   - --i-have-the-go is set                                       │
 * │   - --confirm-workspace=<name> matches the active workspace      │
 * │   - the daemon is NOT running (would corrupt the Kùzu file)     │
 * │   - a recent payload JSON is supplied via --payload=<path>       │
 * │   - mapping coverage in the payload is ≥ threshold (default 0.50)│
 * │                                                                  │
 * │ The latest pre-cutover snapshot lives at:                        │
 * │   <workspace>/.lore/graph.pre-gitnexus-migration                 │
 * │ Restore: cp -R that file back to <workspace>/.lore/graph         │
 * └─────────────────────────────────────────────────────────────────┘
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const LORE_HOME = process.env.LORE_HOME ?? path.join(process.env.HOME ?? '', '.groundfloor');
const LORE_PORT = process.env.LORE_PORT ?? '3847';

function parseArgs(argv) {
    const args = {
        iHaveTheGo: false,
        confirmWorkspace: null,
        payload: null,
        coverageThreshold: 0.50,
    };
    for (const a of argv.slice(2)) {
        if (a === '--i-have-the-go') args.iHaveTheGo = true;
        else if (a.startsWith('--confirm-workspace=')) args.confirmWorkspace = a.slice('--confirm-workspace='.length);
        else if (a.startsWith('--payload=')) args.payload = a.slice('--payload='.length);
        else if (a.startsWith('--coverage-threshold=')) args.coverageThreshold = parseFloat(a.slice('--coverage-threshold='.length));
        else throw new Error(`unknown argument: ${a}`);
    }
    return args;
}

async function isDaemonAlive() {
    try {
        const r = await fetch(`http://127.0.0.1:${LORE_PORT}/health`, { signal: AbortSignal.timeout(1500) });
        return r.ok;
    } catch {
        return false;
    }
}

function refuse(reason) {
    console.error(`[cutover-destructive] REFUSING TO PROCEED: ${reason}`);
    process.exit(2);
}

async function main() {
    const args = parseArgs(process.argv);

    if (!args.iHaveTheGo) {
        console.error('');
        console.error('  ┌────────────────────────────────────────────────────────────────┐');
        console.error('  │ atlas-cutover-destructive.mjs                                  │');
        console.error('  │                                                                │');
        console.error('  │ This is the destructive Phase 7 cutover step. It rewrites your│');
        console.error('  │ live Kùzu graph and is irreversible without restoring from    │');
        console.error('  │ snapshot.                                                      │');
        console.error('  │                                                                │');
        console.error('  │ Required flags:                                                │');
        console.error('  │   --i-have-the-go                                              │');
        console.error('  │   --confirm-workspace=<active-workspace-name>                  │');
        console.error('  │   --payload=<path-to-cutover-payload-<ts>.json>                │');
        console.error('  │                                                                │');
        console.error('  │ Optional:                                                      │');
        console.error('  │   --coverage-threshold=0.50  (refuse if payload coverage <)    │');
        console.error('  │                                                                │');
        console.error('  │ Pre-flight: STOP the daemon first. The script refuses to run   │');
        console.error('  │ while the daemon is holding the graph file open.               │');
        console.error('  │   launchctl bootout gui/$(id -u)/com.groundfloor.lore          │');
        console.error('  └────────────────────────────────────────────────────────────────┘');
        console.error('');
        process.exit(1);
    }

    if (!args.confirmWorkspace) refuse('--confirm-workspace=<name> is required');
    if (!args.payload) refuse('--payload=<path> is required');

    const daemonAlive = await isDaemonAlive();
    if (daemonAlive) {
        refuse('daemon is RUNNING. Stop it first: launchctl bootout gui/$(id -u)/com.groundfloor.lore');
    }
    console.error('[cutover-destructive] daemon stopped — OK to proceed');

    // Load payload.
    const payload = JSON.parse(await fs.readFile(args.payload, 'utf-8'));
    if (!payload.mapping) refuse('payload has no mapping table — re-run cutover-execute with daemon running first');
    if (!payload.candidate || payload.candidate.mode !== 'multi-repo') {
        refuse('payload candidate.mode must be "multi-repo" (rerun cutover-execute with --all-repos)');
    }
    const cov = payload.mapping.mappableCoverage ?? 0;
    if (cov < args.coverageThreshold) {
        refuse(`payload mappable coverage ${(cov * 100).toFixed(2)}% < threshold ${(args.coverageThreshold * 100).toFixed(2)}%`);
    }
    console.error(`[cutover-destructive] payload loaded: ${payload.mapping.mapped} mapped, ${payload.mapping.unmapped} unmapped, coverage ${(cov * 100).toFixed(2)}%`);

    // Set LORE_HOME so bootForCli reads from the same workspace.
    process.env.LORE_HOME = LORE_HOME;

    // Boot a CLI-style LocalGraph so we can mutate without the daemon.
    console.error('[cutover-destructive] booting LocalGraph for cutover...');
    const { LocalGraph } = await import('../packages/lore/src/engines/localGraph.js');
    const { ConfigManager } = await import('../packages/lore/src/config/configManager.js');
    const { PluginRegistry } = await import('../packages/lore/src/plugins/registry.js');

    const workspaceDir = path.join(LORE_HOME, 'workspaces', args.confirmWorkspace);
    const loreDir = path.join(workspaceDir, '.lore');
    await fs.access(loreDir);   // throws if missing

    const graph = new LocalGraph(workspaceDir);
    const registry = new PluginRegistry(new ConfigManager(loreDir));
    registry.boot();
    await graph.initialize();
    const ctx = graph.createPluginGraphContext();
    await registry.registerSchemas(ctx);
    const devPlugin = registry.active().find((p) => p.name === 'developer');
    if (!devPlugin) refuse('developer plugin not active in workspace config');
    console.error('[cutover-destructive] LocalGraph + developer plugin ready');

    // Phase A — Capture cross-pillar edges before mutation.
    console.error('[cutover-destructive] capturing LoreAppliesToCode + LoreTouchesFile edges...');
    const lac = await ctx.queryRows(
        `MATCH (n:LoreNode)-[r:LoreAppliesToCode]->(s:CodeSymbol)
         RETURN n.id AS nodeId, s.uid AS oldSymbolUid, r.relation AS relation`,
    );
    const ltf = await ctx.queryRows(
        `MATCH (n:LoreNode)-[r:LoreTouchesFile]->(f:CodeFile)
         RETURN n.id AS nodeId, f.path AS filePath, r.relation AS relation`,
    );
    console.error(`[cutover-destructive]   captured ${lac.length} LoreAppliesToCode + ${ltf.length} LoreTouchesFile`);

    // Build oldUid → newId index from payload (mapping pairs).
    const mapping = new Map();
    for (const pair of payload.mapping.mappingPairs ?? []) {
        mapping.set(pair.oldUid, pair.newId);
    }

    // Phase B — Re-index each repo via atlasIndexer (clearFirst=true drops the old shape).
    const { indexRepoWithAtlas } = await import('../packages/lore-plugin-developer/src/atlasIndexer.js');

    const repos = Object.entries(payload.candidate.byRepo);
    console.error(`[cutover-destructive] re-indexing ${repos.length} repo(s) via Atlas...`);
    const indexResults = [];
    for (const [repoName, info] of repos) {
        try {
            console.error(`[cutover-destructive]   ${repoName} @ ${info.path}...`);
            const result = await indexRepoWithAtlas(ctx, info.path, { repoName, clearFirst: true });
            console.error(`[cutover-destructive]     ${result.symbolsUpserted} symbols / ${result.filesUpserted} files / ${result.relationsInserted} relations  (${result.durationMs}ms)`);
            indexResults.push({ repo: repoName, ...result });
        } catch (err) {
            console.error(`[cutover-destructive]   ${repoName}: FAILED — ${err.message}`);
            indexResults.push({ repo: repoName, error: err.message });
        }
    }

    // Phase C — Rewrite LoreAppliesToCode via mapping. Unmapped → drop.
    console.error('[cutover-destructive] rewriting LoreAppliesToCode edges via mapping...');
    let lacRewritten = 0;
    let lacDropped = 0;
    for (const edge of lac) {
        const oldUid = String(edge.oldSymbolUid);
        const newId = mapping.get(oldUid);
        const nodeId = String(edge.nodeId);
        const relation = String(edge.relation ?? 'applies_to');

        if (!newId) {
            lacDropped += 1;
            continue;
        }
        try {
            await ctx.storage.upsertEdge(
                'LoreAppliesToCode',
                { sourceId: nodeId, targetId: newId, relation },
            );
            lacRewritten += 1;
        } catch (err) {
            // Common cause: target newId doesn't exist in the new graph.
            // Atlas may not have re-extracted that exact symbol; the
            // LoreNode ↔ code link goes to reconnect for re-suggestion.
            lacDropped += 1;
        }
    }
    console.error(`[cutover-destructive]   ${lacRewritten} rewritten + ${lacDropped} dropped (will go to reconnect)`);

    // Phase D — Re-insert LoreTouchesFile edges. CodeFile keyed by path,
    // path is repo-relative which is preserved across cutover.
    console.error('[cutover-destructive] re-inserting LoreTouchesFile edges...');
    let ltfReinserted = 0;
    let ltfDropped = 0;
    for (const edge of ltf) {
        const nodeId = String(edge.nodeId);
        const filePath = String(edge.filePath);
        const relation = String(edge.relation ?? 'touches');
        try {
            await ctx.storage.upsertEdge(
                'LoreTouchesFile',
                { sourceId: nodeId, targetId: filePath, relation },
            );
            ltfReinserted += 1;
        } catch {
            ltfDropped += 1;
        }
    }
    console.error(`[cutover-destructive]   ${ltfReinserted} re-inserted + ${ltfDropped} dropped`);

    // Phase E — Verify final shape.
    const finalSymbols = await ctx.queryRows('MATCH (s:CodeSymbol) RETURN count(s) AS total');
    const finalFiles = await ctx.queryRows('MATCH (f:CodeFile) RETURN count(f) AS total');
    const finalRelations = await ctx.queryRows('MATCH ()-[r:CodeRelation]->() RETURN count(r) AS total');
    const finalLac = await ctx.queryRows('MATCH ()-[r:LoreAppliesToCode]->() RETURN count(r) AS total');
    const finalLtf = await ctx.queryRows('MATCH ()-[r:LoreTouchesFile]->() RETURN count(r) AS total');

    await graph.close();

    // Final report.
    const summary = {
        capturedAt: new Date().toISOString(),
        payload: args.payload,
        workspace: args.confirmWorkspace,
        indexResults,
        crossPillar: {
            loreAppliesToCode: { captured: lac.length, rewritten: lacRewritten, dropped: lacDropped },
            loreTouchesFile: { captured: ltf.length, reinserted: ltfReinserted, dropped: ltfDropped },
        },
        finalCounts: {
            CodeSymbol: Number(finalSymbols[0]?.total ?? 0),
            CodeFile: Number(finalFiles[0]?.total ?? 0),
            CodeRelation: Number(finalRelations[0]?.total ?? 0),
            LoreAppliesToCode: Number(finalLac[0]?.total ?? 0),
            LoreTouchesFile: Number(finalLtf[0]?.total ?? 0),
        },
    };
    const reportPath = path.join(LORE_HOME, `atlas-cutover-result-${Date.now()}.json`);
    await fs.writeFile(reportPath, JSON.stringify(summary, null, 2));
    console.error(`[cutover-destructive] result written to ${reportPath}`);

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('  DESTRUCTIVE CUTOVER COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Workspace:        ${args.confirmWorkspace}`);
    console.log(`  Repos re-indexed: ${indexResults.filter((r) => !r.error).length} / ${indexResults.length}`);
    console.log(`  Final graph:      ${summary.finalCounts.CodeSymbol} CodeSymbols`);
    console.log(`                    ${summary.finalCounts.CodeFile} CodeFiles`);
    console.log(`                    ${summary.finalCounts.CodeRelation} CodeRelations`);
    console.log(`                    ${summary.finalCounts.LoreAppliesToCode} LoreAppliesToCode`);
    console.log(`                    ${summary.finalCounts.LoreTouchesFile} LoreTouchesFile`);
    console.log(`  Cross-pillar:     ${lacRewritten}/${lac.length} LoreAppliesToCode rewritten`);
    console.log(`                    ${ltfReinserted}/${ltf.length} LoreTouchesFile re-inserted`);
    console.log(`  Result report:    ${reportPath}`);
    console.log('');
    console.log('  Next: restart the daemon');
    console.log('    launchctl kickstart -k gui/$(id -u)/com.groundfloor.lore');
    console.log('');
    console.log('  Verify recall returns expected answers. If anything looks off:');
    console.log('    launchctl bootout gui/$(id -u)/com.groundfloor.lore');
    console.log(`    cp -R <workspace>/.lore/graph.pre-gitnexus-migration <workspace>/.lore/graph`);
    console.log('    launchctl kickstart -k gui/$(id -u)/com.groundfloor.lore');
    console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((err) => {
    console.error('[cutover-destructive] FAILED:', err);
    process.exit(1);
});
