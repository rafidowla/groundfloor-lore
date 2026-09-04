import fs from 'fs';
import path from 'path';
import { openWorkspaceGraph, resolveGraphEngineForPath } from '../../engines/openWorkspaceGraph.js';
import { SyncEngine } from '../../engines/syncEngine.js';
import { ConfigManager } from '../../config/configManager.js';
import { loreHomePath } from '../../config/loreHome.js';
import { readWorkspaceRegistry } from '../../config/workspaceRegistry.js';
import { resolveGraphBasePath } from './shared.js';
import { isDaemonServingHome, DEFAULT_PORT } from './migrateWorkspaceToWorkspaceShared.js';
import { LoreGraphError } from '../../engines/loreGraphError.js';

/**
 * SW-11 — same reasoning as doctor.ts's openGraphForDoctor(): a store held
 * by a process this preflight failed to detect (e.g. a daemon on a port
 * LORE_PORT doesn't name) will not release the lock during this process's
 * lifetime, so sitting through the full 15s openSurreal retry budget only
 * delays the same failure. Shorten it for this one read-only diagnostic
 * open; restored in `finally` so it never leaks into another command.
 */
const STATUS_OPEN_BUDGET_MS = 3_000;

async function openGraphForStatus(basePath: string) {
    const prevBudget = process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
    process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = String(STATUS_OPEN_BUDGET_MS);
    try {
        const graph = openWorkspaceGraph(basePath);
        await graph.initialize();
        return graph;
    } finally {
        if (prevBudget === undefined) delete process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
        else process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = prevBudget;
    }
}

export async function statusCommand(_args: string[]): Promise<void> {
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');

    if (!fs.existsSync(loreDir)) {
        console.error('❌ No .lore/ directory found. Run "lore init" first.');
        process.exit(1);
    }

    // SW-11: this used to open the store unconditionally, with no awareness
    // that a running daemon (on ANY port — LORE_PORT-aware via isDaemonUp)
    // already holds its single-writer lock. That collision surfaced as a
    // ~15s openSurreal retry storm ending in a raw driver stack trace instead
    // of a clear, actionable message. Same preflight + message as `lore
    // doctor` (SW-11, doctor.ts).
    //
    // Round E2, 2026-09-03 — isDaemonUp() alone refused whenever ANY process
    // answered 200 on the port, never checking it was serving THIS home;
    // isDaemonServingHome() only reports true when the daemon's own
    // Bearer-authenticated /api/health confirms it is serving `basePath`.
    const daemonProbe = await isDaemonServingHome(basePath);
    if (daemonProbe.servesHome) {
        console.error(
            `❌ store is held by a running Lore process (port ${DEFAULT_PORT}) — set LORE_PORT to reach it, or stop it and retry "lore status".`,
        );
        console.error('   ("lore doctor" can read basic graph counts through the daemon over HTTP if it has an auth token.)');
        process.exit(1);
    }

    let graph: Awaited<ReturnType<typeof openWorkspaceGraph>>;
    try {
        graph = await openGraphForStatus(basePath);
    } catch (err) {
        const error = err as Error;
        if (error instanceof LoreGraphError && error.operation === 'openSurreal') {
            console.error(daemonProbe.otherDaemonReachable
                ? `❌ a Lore process answers on port ${DEFAULT_PORT} but reports a different home; the store is held by another process.`
                : '❌ store is held by a running Lore process — set LORE_PORT to reach it or stop it');
        } else {
            console.error(`❌ Graph error: ${error.message}`);
        }
        process.exit(1);
        return;
    }

    const stats = await graph.getStats();
    const syncEngine = new SyncEngine(graph, loreDir, null);
    const syncStatus = syncEngine.getStatus();

    let projectName = '*';
    let ecosystem = '*';
    try {
        const reg = readWorkspaceRegistry();
        for (const [name, mapping] of Object.entries(reg.projects)) {
            for (const pathFragment of mapping.paths) {
                if (basePath.includes(pathFragment)) {
                    projectName = name;
                    ecosystem = mapping.ecosystem;
                    break;
                }
            }
        }
    } catch {
        // No registry — fine
    }

    console.log('');
    console.log('  @groundfloor/lore — Status');
    console.log('  ─────────────────────────────────────');
    // Reported, not assumed. This used to print the legacy engine name
    // unconditionally, so a Surreal-backed workspace was described as
    // running an engine it does not run, with a path that does not exist.
    const engine = resolveGraphEngineForPath(basePath).engine;
    console.log(`  Engine:     ${engine === 'surreal' ? 'SurrealDB' : 'legacy graph engine'} (local graph)`);
    console.log(`  Graph:      ${path.join(loreDir, engine === 'surreal' ? 'surreal' : 'graph')}`);
    console.log(`  Project:    ${projectName}`);
    console.log(`  Ecosystem:  ${ecosystem}`);
    console.log('');
    console.log('  Knowledge Graph');
    console.log(`    Nodes:    ${stats.nodeCount}`);
    console.log(`    Edges:    ${stats.edgeCount}`);
    if (Object.keys(stats.typeBreakdown).length > 0) {
        console.log('    Types:');
        for (const [typeName, count] of Object.entries(stats.typeBreakdown)) {
            console.log(`      ${typeName}: ${count}`);
        }
    }
    console.log('');
    console.log('  Sync');
    console.log(`    WAL pending:   ${syncStatus.walPending} entries`);
    console.log(`    Last sync:     ${syncStatus.lastSync === '1970-01-01T00:00:00.000Z' ? 'never' : syncStatus.lastSync}`);
    console.log(`    Remote:        ${syncStatus.hasAdapter ? 'connected' : 'offline (no adapter configured)'}`);
    console.log(`    Auto-sync:     ${syncStatus.isAutoSyncing ? 'running' : 'off'}`);
    console.log('');

    await graph.close();
}
