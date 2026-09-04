import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { loreHome } from '../../config/loreHome.js';
import { openWorkspaceGraph, type WorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import { LoreGraphError } from '../../engines/loreGraphError.js';
import { isDaemonServingHome, DEFAULT_PORT, type DaemonHomeProbe } from './migrateWorkspaceToWorkspaceShared.js';

export function findRepoRoot(): string {
    let currentDirectory = process.cwd();
    while (currentDirectory !== path.dirname(currentDirectory)) {
        if (fs.existsSync(path.join(currentDirectory, '.git'))) {
            return currentDirectory;
        }
        currentDirectory = path.dirname(currentDirectory);
    }
    return process.cwd();
}

export function resolveGraphBasePath(): string {
    return loreHome();
}

export function isDaemonRunning(): boolean {
    try {
        execSync('curl -s --max-time 2 http://127.0.0.1:3847/health', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export function writeMcpConfig(
    configPath: string,
    serverName: string,
    entry: Record<string, string>,
): void {
    let config: Record<string, unknown> = { mcpServers: {} };

    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch {
            // Corrupted config — start fresh
        }
    }

    if (!config['mcpServers'] || typeof config['mcpServers'] !== 'object') {
        config['mcpServers'] = {};
    }

    (config['mcpServers'] as Record<string, unknown>)[serverName] = entry;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n', 'utf-8');
}

/**
 * Finding 11 follow-up (round E) — `lore doctor` and `lore status` got a
 * LORE_PORT-aware daemon preflight + shortened openSurreal budget (SW-11),
 * but the other 18 CLI commands that open the workspace graph directly
 * (recall, sync, embed, verbatim, supersede, markStale, getFull, resolve,
 * export, reconnect, report, lint, diagnose, retention, setup, init,
 * migrateEmbedding, migrate) still called `openWorkspaceGraph` + `initialize()`
 * with none of that, so a store already held by a running daemon (reachable
 * or not on the port this command happened to check) sat through the full
 * ~15s single-writer retry storm and surfaced a raw driver error instead of
 * a clear one. This is the one place that guard now lives, so every direct
 * opener gets it by construction instead of by each command remembering to
 * re-implement doctor.ts's openGraphForDoctor()/status.ts's
 * openGraphForStatus() pattern.
 *
 * Same two layers as those two:
 *   1. isDaemonServingHome() (LORE_PORT-aware, home-aware — round E2,
 *      2026-09-03) — refuse before even attempting to open, but ONLY when a
 *      daemon on that port is demonstrably serving THIS resolved
 *      `LORE_HOME` (its `/api/health` Bearer body's `loreHome` matches).
 *      isDaemonUp() alone used to refuse whenever ANY process answered 200
 *      on the port, regardless of whose home it served — false-positive
 *      refusing `lore init` on a brand-new home, or any command against an
 *      unrelated, unlocked home, whenever some other Lore install happened
 *      to be reachable on the same port number.
 *   2. A shortened LORE_SURREAL_OPEN_BUDGET_MS around the open itself, for
 *      the residual case where something holds the lock without answering
 *      an HTTP health endpoint for THIS home (a false negative from (1), a
 *      daemon for a different home, or a bare holder process / test
 *      harness) — same friendly message (honest about a same-port
 *      different-home daemon when one was seen), reached by catching the
 *      LoreGraphError instead of the preflight.
 *
 * Commands that already try their own HTTP path to the daemon first
 * (verbatim, supersede, markStale, getFull, recall, export, report) keep
 * that logic untouched — it is not this helper's job to rewire it — and
 * call this only on their post-HTTP direct-open fallback. Those HTTP relay
 * helpers now resolve DEFAULT_PORT (LORE_PORT-aware, this same shared
 * constant) instead of each keeping its own hardcoded-3847 copy, so a
 * daemon on a non-default LORE_PORT is reached there directly; this
 * fallback still catches the residual case — a daemon their relay missed
 * for some other reason (no auth token yet, daemon down, timeout) — instead
 * of colliding with the lock.
 */
const CLI_OPEN_BUDGET_MS = 3_000;

/** Thrown by openGraphForCli when a running Lore process holds (or is
 *  believed to hold) the store's single-writer lock. Commands that want to
 *  wrap the message (e.g. with their own recovery instructions) can catch
 *  this type specifically instead of pattern-matching on `.message`. */
export class CliDaemonLockError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliDaemonLockError';
    }
}

export interface OpenGraphForCliOptions {
    /** Passed through to openWorkspaceGraph, when the caller already knows it. */
    workspaceId?: string;
    /** One-line hint appended to the refusal message — name this command's
     *  own (or another command's) HTTP alternative when one exists. */
    httpAlternativeHint?: string;
    /** Shortened openSurreal retry budget (ms) for this open. Defaults to
     *  CLI_OPEN_BUDGET_MS; override only for a good, documented reason. */
    openBudgetMs?: number;
}

function cliDaemonLockMessage(hint?: string, probe?: DaemonHomeProbe): string {
    // Round E2, 2026-09-03 — when the direct-open below still hit a real
    // lock AND the preflight saw a daemon on this port that reported a
    // DIFFERENT `loreHome`, say so: the generic "held by a running Lore
    // process" message previously implied it was OUR daemon, which is
    // misleading when it demonstrably wasn't.
    //
    // Round E3, 2026-09-03 (finding, low) — that "different home" wording
    // was ALSO shown when the daemon never told us whose home it serves at
    // all, because it rejected our credential (401/403, or a 200 with no
    // `loreHome`) — see DaemonHomeProbe.credentialRejected. Saying "reports
    // a different home" in that case is simply false: it reported nothing
    // about its home, only that our token didn't work. Distinguish the two.
    let base: string;
    if (probe?.credentialRejected) {
        base = `a Lore process on port ${DEFAULT_PORT} rejected this CLI's credential; it may hold this store — regenerate the token or stop it and retry.`;
    } else if (probe?.otherDaemonReachable) {
        base = `a Lore process answers on port ${DEFAULT_PORT} but reports a different home; the store is held by another process.`;
    } else {
        base = `store is held by a running Lore process (port ${DEFAULT_PORT}) — set LORE_PORT to reach it, or stop it and retry.`;
    }
    return hint ? `${base} ${hint}` : base;
}

/**
 * Open + initialize the workspace graph the way every CLI command that
 * opens it directly should: refuse fast with `CliDaemonLockError` when a
 * running Lore daemon already holds the store's lock, instead of sitting
 * through the full ~15s openSurreal retry storm and surfacing a raw driver
 * error. See the block comment above for the two-layer detection this
 * mirrors from doctor.ts/status.ts.
 *
 * Callers that do NOT already wrap the open in their own try/catch can call
 * this directly and let a `CliDaemonLockError` bubble to `main().catch` in
 * cli/index.ts, which prints `[lore] Fatal error: <message>` and exits 1 —
 * the same outcome those commands already had on any other open failure,
 * just with a clear message instead of a raw one.
 */
export async function openGraphForCli(
    basePath: string,
    options: OpenGraphForCliOptions = {},
): Promise<WorkspaceGraph> {
    const { workspaceId, httpAlternativeHint, openBudgetMs = CLI_OPEN_BUDGET_MS } = options;

    // Round E2, 2026-09-03 — the home whose auth.token (and hence whose
    // daemon, if any) is relevant here is always the resolved LORE_HOME,
    // not necessarily `basePath` (e.g. retention.ts passes a specific
    // registered workspace's own directory, which can live anywhere on
    // disk while still being served by the one daemon bound to LORE_HOME).
    const home = loreHome();
    const probe = await isDaemonServingHome(home);
    if (probe.servesHome) {
        throw new CliDaemonLockError(cliDaemonLockMessage(httpAlternativeHint));
    }

    const prevBudget = process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
    process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = String(openBudgetMs);
    try {
        const graph = workspaceId !== undefined
            ? openWorkspaceGraph(basePath, { workspaceId })
            : openWorkspaceGraph(basePath);
        await graph.initialize();
        return graph;
    } catch (err) {
        if (err instanceof LoreGraphError && err.operation === 'openSurreal') {
            throw new CliDaemonLockError(cliDaemonLockMessage(httpAlternativeHint, probe));
        }
        throw err;
    } finally {
        if (prevBudget === undefined) delete process.env['LORE_SURREAL_OPEN_BUDGET_MS'];
        else process.env['LORE_SURREAL_OPEN_BUDGET_MS'] = prevBudget;
    }
}
