#!/usr/bin/env -S npx tsx
/**
 * scripts/atlas-cutover-recover-lac.mjs
 *
 * Atlas — Phase 7 cutover post-flight recovery for LoreAppliesToCode.
 *
 * The destructive cutover script's first run had a bug: it called
 * ctx.storage.upsertEdge() with an OBJECT instead of positional
 * (sourceId, targetId, props) args. The `upsertEdge` helper silently
 * no-op'd, so the 478 captured LoreAppliesToCode edges never made it
 * back into the post-cutover graph.
 *
 * This recovery script:
 *   1. Refuses unless the daemon is stopped (we open the live graph
 *      directly via @kineviz/kuzu-lite — daemon would conflict on
 *      the file lock).
 *   2. Opens the pre-cutover SNAPSHOT in a separate Kùzu instance.
 *   3. Reads LoreAppliesToCode (nodeId, oldSymbolUid, relation).
 *   4. Translates each oldSymbolUid → newId via the payload mapping.
 *   5. Opens the LIVE graph and inserts edges via raw Cypher MATCH+CREATE
 *      (bypasses storage.upsertEdge — uses Kùzu's native MERGE-equivalent).
 *   6. Reports counts.
 *
 * Required:
 *   --i-have-the-go
 *   --confirm-workspace=<name>
 *   --payload=<path-to-cutover-payload-<ts>.json>
 *   --snapshot=<path-to-graph.pre-gitnexus-migration>
 *
 * License-compliance per docs/PLAN_replace_gitnexus_in_developer_plugin.md
 * section 10.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const LORE_HOME = process.env.LORE_HOME ?? path.join(process.env.HOME ?? '', '.groundfloor');
const LORE_PORT = process.env.LORE_PORT ?? '3847';

function parseArgs(argv) {
    const args = { iHaveTheGo: false, confirmWorkspace: null, payload: null, snapshot: null };
    for (const a of argv.slice(2)) {
        if (a === '--i-have-the-go') args.iHaveTheGo = true;
        else if (a.startsWith('--confirm-workspace=')) args.confirmWorkspace = a.slice('--confirm-workspace='.length);
        else if (a.startsWith('--payload=')) args.payload = a.slice('--payload='.length);
        else if (a.startsWith('--snapshot=')) args.snapshot = a.slice('--snapshot='.length);
        else throw new Error(`unknown argument: ${a}`);
    }
    return args;
}

function refuse(reason) {
    console.error(`[recover-lac] REFUSING: ${reason}`);
    process.exit(2);
}

async function main() {
    const args = parseArgs(process.argv);

    if (!args.iHaveTheGo) {
        console.error('Pass --i-have-the-go --confirm-workspace=<name> --payload=<path> --snapshot=<path>');
        process.exit(1);
    }
    if (!args.confirmWorkspace) refuse('--confirm-workspace required');
    if (!args.payload) refuse('--payload required');
    if (!args.snapshot) refuse('--snapshot required');

    // Daemon must be STOPPED — we hold the live graph file lock here.
    const r = await fetch(`http://127.0.0.1:${LORE_PORT}/health`).catch(() => null);
    if (r?.ok) refuse('daemon is RUNNING. Stop it: launchctl bootout gui/$(id -u)/com.groundfloor.lore');
    console.error('[recover-lac] daemon stopped — OK to proceed');

    // Load payload + build mapping.
    const payload = JSON.parse(await fs.readFile(args.payload, 'utf-8'));
    const mapping = new Map();
    for (const pair of payload.mapping?.mappingPairs ?? []) {
        mapping.set(pair.oldUid, pair.newId);
    }
    console.error(`[recover-lac] mapping: ${mapping.size} oldUid → newId pairs`);

    const liveGraphPath = path.join(LORE_HOME, 'workspaces', args.confirmWorkspace, '.lore', 'graph');
    await fs.access(liveGraphPath);

    const { Database, Connection } = await import('@kineviz/kuzu-lite');

    // Phase 1 — read LoreAppliesToCode from snapshot.
    console.error(`[recover-lac] opening snapshot at ${args.snapshot}...`);
    const snapDb = new Database(args.snapshot);
    const snapConn = new Connection(snapDb);
    const snapResult = await snapConn.query(
        `MATCH (n:LoreNode)-[r:LoreAppliesToCode]->(s:CodeSymbol)
         RETURN n.id AS nodeId, s.uid AS oldSymbolUid, r.relation AS relation`,
    );
    const lac = await snapResult.getAll();
    snapResult.close?.();
    console.error(`[recover-lac] read ${lac.length} LoreAppliesToCode edges from snapshot`);

    // Pre-translate. Group by status so we know what to write.
    const toWrite = [];
    let unmapped = 0;
    for (const edge of lac) {
        const oldUid = String(edge['oldSymbolUid'] ?? '');
        const nodeId = String(edge['nodeId'] ?? '');
        const relation = String(edge['relation'] ?? 'applies_to');
        const newId = mapping.get(oldUid);
        if (!newId) {
            unmapped += 1;
            continue;
        }
        toWrite.push({ nodeId, newId, relation });
    }
    console.error(`[recover-lac] ${toWrite.length} to write + ${unmapped} unmapped (will go to reconnect)`);

    // Close snapshot before opening live (releases file handles cleanly).
    // kuzu-lite docs say close on Connection then on Database.
    snapConn.close?.();
    snapDb.close?.();

    // Phase 2 — open live graph and write edges via raw Cypher MATCH+CREATE.
    console.error(`[recover-lac] opening live graph at ${liveGraphPath}...`);
    const liveDb = new Database(liveGraphPath);
    const liveConn = new Connection(liveDb);

    // Verify live graph has the new-shape symbols.
    const probe = await liveConn.query('MATCH (s:CodeSymbol) RETURN count(s) AS total');
    const probeRows = await probe.getAll();
    probe.close?.();
    const liveSymbolCount = Number(probeRows[0]?.['total'] ?? 0);
    console.error(`[recover-lac] live graph has ${liveSymbolCount} CodeSymbols`);
    if (liveSymbolCount === 0) refuse('live graph has 0 CodeSymbols — cutover incomplete or wrong target');

    // Insert edges. Use MERGE to be idempotent (safe to re-run this script).
    let written = 0;
    let writeErrors = 0;
    const errors = [];
    for (const e of toWrite) {
        try {
            const escapedNode = e.nodeId.replace(/'/g, "\\'");
            const escapedSym = e.newId.replace(/'/g, "\\'");
            const escapedRel = e.relation.replace(/'/g, "\\'");
            const cypher = `
                MATCH (n:LoreNode {id: '${escapedNode}'}), (s:CodeSymbol {uid: '${escapedSym}'})
                MERGE (n)-[r:LoreAppliesToCode]->(s)
                ON CREATE SET r.relation = '${escapedRel}'
                ON MATCH SET r.relation = '${escapedRel}'
            `;
            const res = await liveConn.query(cypher);
            res.close?.();
            written += 1;
        } catch (err) {
            writeErrors += 1;
            if (errors.length < 5) errors.push({ ...e, error: err.message });
        }
    }

    // Final count.
    const finalCheck = await liveConn.query('MATCH ()-[r:LoreAppliesToCode]->() RETURN count(r) AS total');
    const finalRows = await finalCheck.getAll();
    finalCheck.close?.();
    const finalCount = Number(finalRows[0]?.['total'] ?? 0);

    liveConn.close?.();
    liveDb.close?.();

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('  LAC RECOVERY COMPLETE');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Snapshot edges:   ${lac.length}`);
    console.log(`  Mapped:           ${toWrite.length}`);
    console.log(`  Unmapped:         ${unmapped} (drop — go to reconnect)`);
    console.log(`  Written:          ${written}`);
    console.log(`  Errors:           ${writeErrors}`);
    console.log(`  Final LAC count:  ${finalCount}`);
    if (errors.length > 0) {
        console.log('  Sample errors:');
        for (const e of errors) console.log(`    ${e.oldUid ?? e.newId}: ${e.error}`);
    }
    console.log('');
    console.log('  Next: launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.groundfloor.lore.plist');
    console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((err) => {
    console.error('[recover-lac] FAILED:', err);
    process.exit(1);
});
