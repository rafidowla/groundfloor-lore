/**
 * loreHome — Single source of truth for the Lore data root.
 *
 * Returns the directory under which workspaces, audit logs, auth tokens,
 * model cache, archive sink, and ingestion config all live. Defaults to
 * `~/.groundfloor` for backward compatibility; override with the
 * `LORE_HOME` env variable to relocate the entire data tree.
 *
 * Use this anywhere you would otherwise write
 *   `path.join(os.homedir(), '.groundfloor', ...)`.
 *
 * Why an env var instead of a config file: this path is consulted by
 * the daemon BEFORE any config can be read (it's the directory the
 * config file lives in). Env var is the only cycle-free signal.
 *
 * The `LORE_HOME` env var is allow-listed in src/security/envScrub.ts
 * so the daemon process inherits it through launchd's spawn.
 */

import * as os from 'os';
import * as path from 'path';

/**
 * isTestProcess — true when the running process's entry script lives in a
 * `test/` (or `tests/`) directory.
 *
 * Why this exists: the data-home default is the real user home
 * (`~/.groundfloor`). The test suite is a chain of standalone
 * `tsx test/<name>.ts` processes (see package.json `test`) — none set
 * `LORE_HOME` — so without a guard every test run would create/scribble the
 * operator's real home as a side effect (the empty `workspaces.json` stub that
 * kept reappearing after the local-Lore teardown). Detecting the test entry
 * point covers ALL launch paths (`npm test`, `npm run test:unit:X`, and a bare
 * `tsx test/X.ts`) with one check — there is no central runner to inject env
 * into. The production daemon entry (`mcp/server.ts`, a built `server.js`, or a
 * `bin/` shim) is never under a `test/` segment, so this never trips in prod;
 * and any caller can still force a specific home with `LORE_HOME` / `dataDir`,
 * both of which take precedence over this branch.
 */
function isTestProcess(): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    const sep = path.sep;
    return entry.includes(`${sep}test${sep}`) || entry.includes(`${sep}tests${sep}`);
}

/**
 * resolveLoreHome — Compute the Lore data root with an explicit override.
 *
 * Precedence:
 *   1. `opts.dataDir`        — caller-injected, per-instance (highest).
 *   2. `process.env.LORE_HOME` — process-global env override.
 *   3. isolated temp home    — when running under the test suite (never prod).
 *   4. `~/.groundfloor`      — default.
 *
 * This is the per-instance-safe entry point: a host embedding Lore can
 * pass `{ dataDir }` to pin one instance's home without mutating (or
 * being affected by) the process-wide `LORE_HOME` env var. Two Lore
 * instances in one process can therefore each have their own home.
 */
export function resolveLoreHome(opts?: { dataDir?: string }): string {
    const fromOpts = opts?.dataDir;
    if (fromOpts && fromOpts.trim().length > 0) return fromOpts;
    const fromEnv = process.env['LORE_HOME'];
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
    // Test hygiene: a test process with no explicit home gets an isolated,
    // per-process temp home instead of the operator's real `~/.groundfloor`.
    // Stable within one process (keyed on pid) so a test's reads see its own
    // writes; distinct across the suite's per-file processes so they don't
    // collide. Lives under the OS temp dir, which the OS reclaims.
    if (isTestProcess()) {
        return path.join(os.tmpdir(), `lore-test-home-${process.pid}`);
    }
    return path.join(os.homedir(), '.groundfloor');
}

/**
 * Returns the absolute Lore data root.
 *
 * Back-compat shim over {@link resolveLoreHome}. Reads `process.env.LORE_HOME`
 * on every call (process-global). Prefer `resolveLoreHome({ dataDir })`
 * when you have a per-instance home to inject.
 */
export function loreHome(): string {
    return resolveLoreHome();
}

/** Convenience: join one or more path segments under the Lore home. */
export function loreHomePath(...segments: string[]): string {
    return path.join(loreHome(), ...segments);
}
