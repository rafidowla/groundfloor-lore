import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { graphStoresOnDisk, openWorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import { SyncEngine } from '../../engines/syncEngine.js';
import type { LoreGraphHandle } from '../../storage/loreStorageClient.js';
import { LoreGraphError } from '../../engines/loreGraphError.js';
import { loreHome, loreHomePath } from '../../config/loreHome.js';
import {
    readWorkspaceRegistry,
    workspaceRegistryPath,
    legacyProjectsRegistryPath,
} from '../../config/workspaceRegistry.js';
import { resolveGraphBasePath } from './shared.js';
import { isDaemonUp, DEFAULT_PORT } from './migrateWorkspaceToWorkspaceShared.js';

/**
 * SW-11 — doctor's own diagnostic open must not sit in the full 15s
 * openSurreal retry storm. A store held by a running daemon (one doctor
 * failed to detect, e.g. because it's on a non-default LORE_PORT the caller
 * forgot to export) will never release the lock during this process's
 * lifetime, so retrying for the full production budget just delays the same
 * failure. Cut the budget way down for this one read-only diagnostic call;
 * a real daemon holds the lock well past this window, while a transient
 * just-closed lock (the driver releases it asynchronously — see
 * openSurreal's own comment) still gets a couple of retries.
 */
const DOCTOR_OPEN_BUDGET_MS = 3_000;

/**
 * Open the workspace graph for doctor's own read, with the shortened lock
 * budget above. Scoped via a temporary env override (the only knob
 * openSurreal exposes) and restored in `finally` so it never leaks into any
 * other command running in this process.
 */
async function openGraphForDoctor(basePath: string) {
    const prevBudget = process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
    process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = String(DOCTOR_OPEN_BUDGET_MS);
    try {
        const graph = openWorkspaceGraph(basePath);
        await graph.initialize();
        return graph;
    } finally {
        if (prevBudget === undefined) delete process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
        else process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = prevBudget;
    }
}

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
    // Finding (2026-09-03, json-throw): set when the diagnostic body below
    // throws something not already caught internally (e.g. an unexpected
    // fs/registry error outside the WAL check's own try/catch above). In
    // --json mode this used to mean the JSON envelope was never emitted at
    // all — main() printed a plain-text fatal line and stdout stayed empty,
    // breaking any caller that only reads stdout. Non-json mode is
    // unaffected: it still rethrows below so `[lore] Fatal error: …` prints
    // exactly as it always has.
    let fatalMessage: string | null = null;

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

    // SW-11: the diagnostic body below can throw (e.g. an
    // unexpected fs/registry error) before reaching the JSON emission at
    // the bottom. Previously that left console.log monkey-patched into the
    // findings buffer for the rest of the process, so whatever printed the
    // resulting error never reached the terminal. Restore it in `finally`
    // regardless of how the body exits.
    try {
        // Resolve the effective LORE_HOME up-front — env first, then
        // probe the running daemon's /api/health. Used to find the right
        // auth.token + workspace-paths.json when this shell wasn't
        // launched with LORE_HOME exported. Falls back to env-derived
        // path silently if the daemon is unreachable or its health
        // response predates the loreHome field.
        //
        // FINDING 4(c) (2026-09-03) — /api/health now returns the lite body
        // (no `loreHome`) to an anonymous caller; only a Bearer-authenticated
        // request gets the full snapshot, so this probe must authenticate to
        // keep working. Reuses this file's own convention (see the tokenPath
        // resolution a few lines down) that the auth token lives at
        // `<effectiveLoreHome>/auth.token` — best-effort read of THAT guessed
        // path, since the corrected loreHome isn't known yet. When no token is
        // there (fresh install, or a daemon home this guess can't see), the
        // probe just runs anonymously as before and gets the lite body — no
        // `loreHome` to read, so this silently keeps the existing env-derived
        // fallback exactly as it did pre-fix (unchanged try/catch below).
        let effectiveLoreHome = loreHome();
        // Finding 11 follow-up (round E) — the daemon's active workspace
        // name, when this early guess-token probe reaches the authenticated
        // body. Reused below so the /api/topology probe can send the
        // ?workspace= the route requires (SP-04 workspace_required); a
        // fresh probe with the CORRECTED token covers the case where this
        // one came back anonymous (no `workspace` field on the lite body).
        let daemonWorkspace: string | undefined;
        try {
            const guessTokenPath = path.join(effectiveLoreHome, 'auth.token');
            const guessToken = fs.existsSync(guessTokenPath) ? fs.readFileSync(guessTokenPath, 'utf-8').trim() : null;
            const health = (await probeJson('/api/health', guessToken)).body as { loreHome?: string; workspace?: string } | null;
            const daemonLoreHome = health?.loreHome;
            if (daemonLoreHome && daemonLoreHome !== effectiveLoreHome) {
                effectiveLoreHome = daemonLoreHome;
            }
            daemonWorkspace = health?.workspace;
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
            const which = stores.legacyGraph && stores.surreal ? 'legacy graph engine + SurrealDB (post-migration)'
                : stores.surreal ? 'SurrealDB' : 'legacy graph engine';
            console.log(`  ✓ graph store exists (${which})`);
        } else {
            console.log('  ✗ no graph store found (.lore/graph or .lore/surreal) — run "lore init"');
            issues++;
        }

        if (fs.existsSync(loreDir)) {
            const tokenPath = path.join(effectiveLoreHome, 'auth.token');
            // SW-11: this used to be `probeHttp('/api/health') === 200` against a
            // hardcoded port 3847. A daemon on a non-default LORE_PORT went
            // undetected, so doctor fell through to a direct store open and
            // collided with the daemon's single-writer lock — a 15s retry storm
            // ending in a raw driver error. isDaemonUp() honours LORE_PORT and
            // also counts a 401/403 health response as "up".
            const daemonUp = await isDaemonUp();
            if (daemonUp && fs.existsSync(tokenPath)) {
                try {
                    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
                    // Finding 11 follow-up (round E) — /api/topology requires
                    // ?workspace= (SP-04 workspace_required gate); doctor
                    // never sent it, so this call always 400'd and fell into
                    // the "unexpected shape" warning below instead of real
                    // counts. Reuse the workspace name the earlier /api/health
                    // probe returned; if that one came back anonymous (no
                    // `workspace` field), ask again with the now-correct token.
                    const workspaceForTopology = daemonWorkspace
                        ?? ((await probeJson('/api/health', token)).body as { workspace?: string } | null)?.workspace;
                    const topologyPath = workspaceForTopology
                        ? `/api/topology?workspace=${encodeURIComponent(workspaceForTopology)}`
                        : '/api/topology';
                    const { status: topologyStatus, body: topologyBody } = await probeJson(topologyPath, token);
                    const topology = topologyBody as { nodes?: unknown; edges?: unknown; error?: string } | null;
                    if (topology && Array.isArray(topology.nodes) && Array.isArray(topology.edges)) {
                        console.log(`  ✓ Graph (via daemon): ${topology.nodes.length} nodes, ${topology.edges.length} edges`);
                    } else if (topologyStatus === 403) {
                        // Round E2, 2026-09-03 (low) — this daemon rejected the
                        // request for the resolved workspace (e.g. it answers
                        // this port for a DIFFERENT LORE_HOME/workspace than
                        // the one this token belongs to). Previously
                        // indistinguishable from a genuine shape mismatch.
                        console.log(`  ⚠ Daemon up but /api/topology refused: 403 ${topology?.error ?? 'workspace_forbidden'}`);
                    } else if (topologyStatus === 400) {
                        console.log(`  ⚠ Daemon up but /api/topology refused: 400 ${topology?.error ?? 'workspace_required'}`);
                    } else if (topologyStatus != null) {
                        console.log(`  ⚠ Daemon up but /api/topology returned ${topologyStatus} (unexpected shape)`);
                    } else {
                        console.log('  ⚠ Daemon up but /api/topology returned unexpected shape');
                    }
                } catch (err) {
                    console.log(`  ⚠ Graph check via daemon failed: ${(err as Error).message}`);
                }
            } else if (daemonUp) {
                // Daemon is up and holds the store's lock, but there's no token to
                // reach it over HTTP. Opening the store directly here would just
                // collide with that lock — say so instead of retrying into the
                // same failure.
                console.log(`  ⚠ Daemon is up (port ${DEFAULT_PORT}) but no auth token found at ${tokenPath} — skipping graph check (set LORE_HOME to the daemon's data dir, or stop the daemon to check the store directly)`);
            } else {
                try {
                    const graph = await openGraphForDoctor(basePath);
                    const stats = await graph.getStats();
                    console.log(`  ✓ Graph readable: ${stats.nodeCount} nodes, ${stats.edgeCount} edges`);
                    await graph.close();
                } catch (graphError) {
                    const err = graphError as Error;
                    if (err instanceof LoreGraphError && err.operation === 'openSurreal') {
                        console.log('  ✗ Graph error: store is held by a running Lore process — set LORE_PORT to reach it or stop it');
                    } else {
                        console.log(`  ✗ Graph error: ${err.message}`);
                    }
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

        // Finding (2026-09-03, json-throw): sync.wal replaced by a directory
        // (EISDIR) or made unreadable (EACCES) used to throw out of the whole
        // diagnostic body — in --json mode that meant NO JSON at all reached
        // stdout (see the outer catch below for the other half of that fix).
        // A bad WAL file is exactly the kind of thing doctor exists to
        // report, so turn it into a ⚠ finding instead of aborting.
        try {
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
        } catch (walErr) {
            console.log(`  ⚠ WAL check failed: ${(walErr as Error).message}`);
            issues++;
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
    } catch (err) {
        // Finding (2026-09-03, json-throw): something outside every inner
        // try/catch above still threw (e.g. .lore/sync.wal handling is now
        // guarded, but a genuinely unanticipated fs/registry error elsewhere
        // in the body is not exhaustively enumerable). In text mode, keep
        // the pre-existing contract — rethrow so main().catch prints
        // `[lore] Fatal error: …` — no change there. In --json mode, that
        // rethrow used to leave stdout completely empty; emit a valid
        // envelope instead so a caller parsing --json output never gets
        // nothing back.
        if (!jsonMode) throw err;
        fatalMessage = (err as Error)?.message ?? String(err);
    } finally {
        if (jsonMode) {
            console.log = origLog;
        }
    }

    if (jsonMode) {
        const filtered = findings.filter(f => f.kind !== 'text' || f.message.trim().length > 0);
        process.stdout.write(JSON.stringify({
            ok: issues === 0 && fatalMessage === null,
            issues,
            ...(fatalMessage !== null ? { fatal: fatalMessage } : {}),
            findings: filtered,
        }, null, 2) + '\n');
        if (issues > 0 || fatalMessage !== null) process.exitCode = 1;
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
            port: DEFAULT_PORT,
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

/**
 * Result of {@link probeJson}. `status` is the HTTP status code the daemon
 * actually returned (`null` when the request never got a response at all —
 * connection refused, timeout, or a transport error). `body` is the parsed
 * JSON body regardless of status code (so a 403/400 error body — e.g.
 * `{ error: 'workspace_forbidden' }` — is still readable), or `null` when
 * there was no response, or the response body wasn't valid JSON.
 *
 * Finding (round E2, 2026-09-03, low) — this used to collapse EVERY non-200
 * response (403 workspace_forbidden, 400 workspace_required, or a genuine
 * shape mismatch) into a single `null`, so callers could only ever report
 * "unexpected shape" — indistinguishable from an actual daemon bug. Callers
 * that care can now report the real status + error code.
 */
interface ProbeJsonResult {
    status: number | null;
    body: unknown;
}

async function probeJson(pathname: string, token: string | null): Promise<ProbeJsonResult> {
    return await new Promise((resolve) => {
        const req = http.request({
            host: '127.0.0.1',
            port: DEFAULT_PORT,
            method: 'GET',
            path: pathname,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            timeout: 3000,
        }, (res) => {
            const status = res.statusCode ?? null;
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve({ status, body: JSON.parse(body) }); } catch { resolve({ status, body: null }); }
            });
        });
        req.on('error', () => resolve({ status: null, body: null }));
        req.on('timeout', () => { req.destroy(); resolve({ status: null, body: null }); });
        req.end();
    });
}
