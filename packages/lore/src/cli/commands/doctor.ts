import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { graphStoresOnDisk, openWorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import { SyncEngine } from '../../engines/syncEngine.js';
import type { LoreGraphHandle } from '../../storage/loreStorageClient.js';
import { loreHome, loreHomePath } from '../../config/loreHome.js';
import {
    readWorkspaceRegistry,
    workspaceRegistryPath,
    legacyProjectsRegistryPath,
} from '../../config/workspaceRegistry.js';
import { resolveGraphBasePath } from './shared.js';

export async function doctorCommand(args: string[]): Promise<void> {
    const jsonMode = args.includes('--json');
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: lore doctor [--json]');
        console.log('  Run diagnostic checks against the daemon + filesystem + config.');
        console.log('  --json    Emit structured JSON instead of human-readable output.');
        return;
    }
    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');
    let issues = 0;

    // Architecture: in --json mode we buffer all human-format output
    // and re-emit as structured findings at the end. Lets the existing
    // 54 console.log call sites stay untouched while still giving
    // scripters a machine-readable shape (Loom's def init agent
    // specifically asked for this, 2026-05-17).
    const findings: Array<{ kind: 'pass' | 'warn' | 'fail' | 'info' | 'section' | 'text'; message: string }> = [];
    const origLog = console.log;
    if (jsonMode) {
        console.log = (...parts: unknown[]) => {
            const line = parts.map(p => String(p)).join(' ');
            findings.push(classifyDoctorLine(line));
        };
    }

    // Resolve the effective LORE_HOME up-front — env first, then
    // probe the running daemon's /api/health. Used to find the right
    // auth.token + workspace-paths.json when this shell wasn't
    // launched with LORE_HOME exported. Falls back to env-derived
    // path silently if the daemon is unreachable or its health
    // response predates the loreHome field.
    let effectiveLoreHome = loreHome();
    try {
        const health = await probeJson('/api/health', null);
        const daemonLoreHome = (health as { loreHome?: string } | null)?.loreHome;
        if (daemonLoreHome && daemonLoreHome !== effectiveLoreHome) {
            effectiveLoreHome = daemonLoreHome;
        }
    } catch { /* probe failed; keep env-derived */ }

    console.log('');
    console.log('  @groundfloor/lore — Doctor');
    console.log('  ─────────────────────────────────────');
    if (effectiveLoreHome !== loreHome()) {
        console.log(`  ⓘ Effective LORE_HOME from daemon: ${effectiveLoreHome} (env not set in this shell)`);
    }

    if (fs.existsSync(loreDir)) {
        console.log('  ✓ .lore/ directory exists');
    } else {
        console.log('  ✗ .lore/ directory not found — run "lore init"');
        issues++;
    }

    // Either store counts. This tested only `.lore/graph`, so doctor told the
    // operator to run `lore init` on a healthy Surreal workspace.
    const stores = graphStoresOnDisk(basePath);
    if (stores.any) {
        const which = stores.kuzu && stores.surreal ? 'Kùzu + SurrealDB (post-migration)'
            : stores.surreal ? 'SurrealDB' : 'Kùzu';
        console.log(`  ✓ graph store exists (${which})`);
    } else {
        console.log('  ✗ no graph store found (.lore/graph or .lore/surreal) — run "lore init"');
        issues++;
    }

    if (fs.existsSync(loreDir)) {
        const tokenPath = path.join(effectiveLoreHome, 'auth.token');
        const daemonUp = (await probeHttp('/api/health', null)) === 200;
        if (daemonUp && fs.existsSync(tokenPath)) {
            try {
                const token = fs.readFileSync(tokenPath, 'utf-8').trim();
                const topology = await probeJson('/api/topology', token);
                if (topology && Array.isArray(topology.nodes) && Array.isArray(topology.edges)) {
                    console.log(`  ✓ Graph (via daemon): ${topology.nodes.length} nodes, ${topology.edges.length} edges`);
                } else {
                    console.log('  ⚠ Daemon up but /api/topology returned unexpected shape');
                }
            } catch (err) {
                console.log(`  ⚠ Graph check via daemon failed: ${(err as Error).message}`);
            }
        } else {
            try {
                const graph = openWorkspaceGraph(basePath);
                await graph.initialize();
                const stats = await graph.getStats();
                console.log(`  ✓ Graph readable: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
                await graph.close();
            } catch (graphError) {
                console.log(`  ✗ Graph error: ${(graphError as Error).message}`);
                issues++;
            }
        }
    }

    // Phase 1 item 13 — registry is workspace-paths.json (with one-
    // time migration from legacy projects.json on first read).
    //
    // 2026-05-17: when the env-derived LORE_HOME doesn't match the
    // running daemon's, prefer the daemon's. Avoids the "doctor says
    // registry missing at ~/.groundfloor but daemon uses
    // lore-local-data" confusion that Loom's def init agent ran into.
    // Use the effective LORE_HOME (env or daemon-discovered) so the
    // registry path matches whatever the daemon is actually using.
    let wsRegistryPath = effectiveLoreHome === loreHome()
        ? workspaceRegistryPath()
        : path.join(effectiveLoreHome, 'workspace-paths.json');
    const legacyPath = legacyProjectsRegistryPath();
    if (fs.existsSync(wsRegistryPath) || fs.existsSync(legacyPath)) {
        try {
            const registry = readWorkspaceRegistry();
            const wsCount = Object.keys(registry.projects ?? {}).length;
            const sourceLabel = fs.existsSync(wsRegistryPath) ? 'workspace-paths.json' : 'projects.json (legacy)';
            console.log(`  ✓ Workspace registry: ${wsCount} workspaces registered (source: ${sourceLabel})`);
        } catch {
            console.log('  ✗ Workspace registry exists but is malformed');
            issues++;
        }
    } else {
        console.log(`  ⚠ Workspace registry not found (${wsRegistryPath})`);
    }

    const antigravityConfigPath = path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
    if (fs.existsSync(antigravityConfigPath)) {
        try {
            const mcpConfig = JSON.parse(fs.readFileSync(antigravityConfigPath, 'utf-8'));
            if (mcpConfig.mcpServers?.['groundfloor-lore']) {
                const loreEntry = mcpConfig.mcpServers['groundfloor-lore'];
                const configuredUrl = loreEntry.serverUrl ?? loreEntry.url ?? null;
                if (configuredUrl) {
                    console.log(`  ✓ Antigravity MCP config: groundfloor-lore → ${configuredUrl}`);
                    if (loreEntry.url && !loreEntry.serverUrl) {
                        console.log('  ⚠ Antigravity uses "serverUrl" (not "url") — run "lore setup" to fix');
                        issues++;
                    }
                } else {
                    console.log('  ✗ Antigravity MCP config: no serverUrl or command configured');
                    issues++;
                }
            } else {
                console.log('  ⚠ Antigravity MCP config exists but no groundfloor-lore entry');
            }
        } catch {
            console.log('  ✗ Antigravity MCP config is malformed');
            issues++;
        }
    } else {
        console.log('  ⚠ Antigravity MCP config not found');
    }

    const walPath = path.join(loreDir, 'sync.wal');
    if (fs.existsSync(walPath)) {
        // Sprint 14 — SAFE diagnostic cast. Doctor only calls
        // syncEngine.getStatus().walPending which never dereferences
        // the graph; the constructor just needs a type-shaped slot.
        // No runtime LoreGraphHandle methods are invoked here.
        const syncEngine = new SyncEngine(
            null as unknown as LoreGraphHandle, loreDir, null);
        const walPending = syncEngine.getStatus().walPending;
        console.log(`  ✓ WAL file exists: ${walPending} pending entries`);
    } else {
        console.log('  ⚠ WAL file not found (will be created on first write)');
    }

    const nodeVersion = process.versions.node;
    const majorVersion = parseInt(nodeVersion.split('.')[0], 10);
    if (majorVersion >= 20) {
        console.log(`  ✓ Node.js version: v${nodeVersion}`);
    } else {
        console.log(`  ✗ Node.js version: v${nodeVersion} (requires ≥20)`);
        issues++;
    }


    console.log('');
    console.log('  Security posture');
    console.log('  ─────────────────────────────────────');
    // Use the same effective LORE_HOME the upstream checks resolved
    // (so auth.token + workspaces.json + permission checks all hit
    // the directory the daemon is actually using).
    const dataHome = effectiveLoreHome;

    try {
        const dhStat = fs.statSync(dataHome);
        const dhMode = dhStat.mode & 0o777;
        if (dhMode === 0o700) {
            console.log('  ✓ Data home permissions (~/.groundfloor) = 0700');
        } else {
            console.log(`  ✗ Data home permissions = 0${dhMode.toString(8)} (expected 0700). Daemon restart will self-heal.`);
            issues++;
        }
    } catch {
        console.log('  ⚠ Data home ~/.groundfloor not found');
    }
    try {
        const tokenPath = path.join(dataHome, 'auth.token');
        if (fs.existsSync(tokenPath)) {
            const tokMode = fs.statSync(tokenPath).mode & 0o777;
            if (tokMode === 0o600) {
                console.log('  ✓ Auth token file (0600)');
            } else {
                console.log(`  ✗ Auth token mode = 0${tokMode.toString(8)} (expected 0600)`);
                issues++;
            }
        } else {
            console.log('  ⚠ Auth token not yet generated (daemon not booted)');
        }
    } catch { /* ignore */ }

    try {
        const tokenPath = path.join(dataHome, 'auth.token');
        if (fs.existsSync(tokenPath)) {
            const token = fs.readFileSync(tokenPath, 'utf-8').trim();
            const healthStatus = await probeHttp('/api/health', null);
            if (healthStatus === 200) {
                console.log('  ✓ Daemon /api/health reachable (no auth)');
            } else {
                console.log(`  ⚠ /api/health status=${healthStatus ?? 'unreachable'} — daemon may not be running`);
            }
            const configUnauth = await probeHttp('/api/config', null);
            if (configUnauth === 401) {
                console.log('  ✓ /api/config rejects unauthenticated requests (401)');
            } else if (configUnauth == null) {
                console.log('  ⚠ Daemon unreachable — skipping auth-enforcement check');
            } else {
                console.log(`  ✗ /api/config without auth returned ${configUnauth} (expected 401) — SECURITY GAP`);
                issues++;
            }
            const configAuth = await probeHttp('/api/config', token);
            if (configAuth === 200) {
                console.log('  ✓ /api/config accepts valid bearer (200)');
            } else if (configAuth != null) {
                console.log(`  ✗ /api/config with valid bearer returned ${configAuth} (expected 200)`);
                issues++;
            }
        }
    } catch (authErr) {
        console.log(`  ⚠ Auth posture check failed: ${(authErr as Error).message}`);
    }

    try {
        const { hasWorkspaceKey } = await import('../../security/keyring.js');
        const wsRegistryPath = path.join(dataHome, 'workspaces.json');
        if (fs.existsSync(wsRegistryPath)) {
            const reg = JSON.parse(fs.readFileSync(wsRegistryPath, 'utf-8')) as { workspaces: Array<{ name: string }> };
            let ready = 0;
            for (const ws of reg.workspaces) {
                const has = await hasWorkspaceKey(ws.name);
                if (has) ready++;
            }
            console.log(`  ⓘ Encryption keyring: ${ready}/${reg.workspaces.length} workspace(s) have keys provisioned (S6 primitives; opt-in wiring pending)`);
        }
    } catch (keyErr) {
        console.log(`  ⚠ Keyring check failed: ${(keyErr as Error).message}`);
    }

    try {
        const { execSync } = await import('child_process');
        const auditRaw = execSync('npm audit --json', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
        const audit = JSON.parse(auditRaw) as { metadata?: { vulnerabilities?: Record<string, number> } };
        const v = audit.metadata?.vulnerabilities ?? {};
        const criticalCount = v.critical ?? 0;
        const highCount = v.high ?? 0;
        const moderateCount = v.moderate ?? 0;
        if (criticalCount === 0 && highCount === 0 && moderateCount === 0) {
            console.log('  ✓ npm audit clean (0 vulnerabilities)');
        } else {
            console.log(`  ⚠ npm audit: ${criticalCount} critical, ${highCount} high, ${moderateCount} moderate`);
            if (criticalCount > 0 || highCount > 0) issues++;
        }
    } catch {
        console.log('  ⚠ npm audit not runnable');
    }

    console.log('');
    if (issues === 0) {
        console.log('  All checks passed! ✓');
    } else {
        console.log(`  ${issues} issue${issues > 1 ? 's' : ''} found.`);
    }
    console.log('');

    if (jsonMode) {
        console.log = origLog;
        const filtered = findings.filter(f => f.kind !== 'text' || f.message.trim().length > 0);
        process.stdout.write(JSON.stringify({
            ok: issues === 0,
            issues,
            findings: filtered,
        }, null, 2) + '\n');
        if (issues > 0) process.exitCode = 1;
    }
}

/** Parse a doctor-format line into a structured finding by its leading
 *  glyph. Lines without a recognised glyph are 'text' (section headers,
 *  separators, the closing summary). */
function classifyDoctorLine(rawLine: string): { kind: 'pass' | 'warn' | 'fail' | 'info' | 'section' | 'text'; message: string } {
    const line = rawLine.trim();
    if (!line) return { kind: 'text', message: '' };
    if (line.startsWith('✓ ')) return { kind: 'pass', message: line.slice(2).trim() };
    if (line.startsWith('✗ ')) return { kind: 'fail', message: line.slice(2).trim() };
    if (line.startsWith('⚠ ')) return { kind: 'warn', message: line.slice(2).trim() };
    if (line.startsWith('ⓘ ')) return { kind: 'info', message: line.slice(2).trim() };
    if (line.startsWith('───')) return { kind: 'text', message: '' };
    if (line.startsWith('@groundfloor/lore') || /^[A-Z]/.test(line)) return { kind: 'section', message: line };
    return { kind: 'text', message: line };
}

async function probeHttp(pathname: string, token: string | null): Promise<number | null> {
    return await new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1',
            port: 3847,
            method: 'GET',
            path: pathname,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            timeout: 2000,
        }, (res) => {
            res.resume();
            resolve(res.statusCode ?? null);
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}

async function probeJson(pathname: string, token: string | null): Promise<any | null> {
    return await new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1',
            port: 3847,
            method: 'GET',
            path: pathname,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            timeout: 3000,
        }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return resolve(null); }
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
    });
}
