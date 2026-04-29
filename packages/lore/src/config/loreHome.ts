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

/** Returns the absolute Lore data root. */
export function loreHome(): string {
    const fromEnv = process.env['LORE_HOME'];
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
    return path.join(os.homedir(), '.groundfloor');
}

/** Convenience: join one or more path segments under the Lore home. */
export function loreHomePath(...segments: string[]): string {
    return path.join(loreHome(), ...segments);
}
