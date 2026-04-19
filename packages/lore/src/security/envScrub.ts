/**
 * envScrub.ts — Parent-environment isolation for spawned Lore processes (S9).
 *
 * Problem: when an IDE (Claude Code, Cursor, Antigravity) spawns Lore as
 * an MCP stdio subprocess, the child inherits the parent's full process
 * environment. That typically includes:
 *   - AWS_SECRET_ACCESS_KEY, AWS_ACCESS_KEY_ID
 *   - GITHUB_TOKEN, GITLAB_TOKEN
 *   - ANTHROPIC_API_KEY, OPENAI_API_KEY  (NOT what we use — we load from
 *     keychain — but present nonetheless)
 *   - arbitrary TOKEN/SECRET/PASSWORD vars from .env files the IDE sourced
 *
 * Lore doesn't need any of those. Having them in process memory:
 *   - widens the blast radius if Lore crashes and stderr dumps env
 *   - widens it further if a plugin we don't control inspects env
 *   - increases the damage from any log-redaction gap
 *
 * Fix: scrub to an allowlist at the top of main(), before any module
 * code reads from process.env. The allowlist covers what Lore actually
 * uses + what node needs to run. Everything else is deleted.
 *
 * Called unconditionally (stdio AND http). Helpful even for HTTP daemons
 * launched by launchd — users sometimes run `npx lore serve --http`
 * directly from a shell with a polluted env.
 */

/**
 * Whitelist of environment variables Lore actually needs.
 *
 * Adding new entries requires justification: why does this variable
 * need to reach the Lore process? Prefer reading from ~/.groundfloor/
 * config files over adding envs here.
 */
const ALLOWED_VARS: readonly string[] = [
    // POSIX essentials
    'HOME', 'USER', 'LOGNAME', 'SHELL',
    'PATH', 'TMPDIR', 'TEMP', 'TMP',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ', 'PWD',

    // Node runtime
    'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH',
    'NVM_BIN', 'NVM_DIR',                       // nvm-managed installs
    'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',

    // Lore config
    'LORE_PORT',
    'LORE_LOG_LEVEL',
    'LORE_WORKSPACE',                           // forces a specific active workspace

    // Dataplane — legacy env-sourced; keychain is the preferred path
    'DATAPLANE_URL', 'DATAPLANE_API_KEY',
    'DATAPLANE_TENANT_ID', 'DATAPLANE_ORG_ID',

    // GitNexus subprocess — may need its own env to find node
    'GITNEXUS_HOME',
];

export interface ScrubResult {
    kept: string[];
    droppedCount: number;
    droppedSamples: string[];  // first few dropped names, for debugging
}

/**
 * scrubEnv — delete every env var not in the allowlist.
 *
 * Safe to call exactly once at process startup. Idempotent — a second
 * call is a no-op since everything outside the allowlist is already gone.
 */
export function scrubEnv(extraAllow: readonly string[] = []): ScrubResult {
    const allow = new Set([...ALLOWED_VARS, ...extraAllow]);
    const kept: string[] = [];
    const dropped: string[] = [];

    for (const k of Object.keys(process.env)) {
        if (allow.has(k)) {
            kept.push(k);
        } else {
            dropped.push(k);
            delete process.env[k];
        }
    }

    return {
        kept,
        droppedCount: dropped.length,
        // Show a few dropped names for visibility, but don't log secrets.
        // Names like AWS_SECRET_ACCESS_KEY are sensitive themselves.
        // Log only the first 6 that look innocuous (no KEY/TOKEN/SECRET/PASSWORD).
        droppedSamples: dropped
            .filter((n) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i.test(n))
            .slice(0, 6),
    };
}
