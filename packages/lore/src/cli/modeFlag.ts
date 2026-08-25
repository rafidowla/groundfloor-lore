/**
 * modeFlag.ts — `--mode=local|cloud` CLI flag parser.
 *
 * Lifted out of cli/index.ts so tests can import it without triggering
 * the CLI bootstrap (which auto-dispatches the command on import).
 *
 * Precedence is documented in `resolveDeploymentMode` in
 * `config/configManager.ts`: CLI flag > env var > config > default.
 * The CLI layer writes the parsed value to `LORE_DEPLOYMENT_MODE`
 * before any subcommand runs, so the existing env path picks it up.
 */

export interface ParsedModeFlag {
    /** argv with `--mode <m>` / `--mode=<m>` / `-m <m>` removed. */
    args: string[];
    /** Parsed mode value, or null when the flag was absent. */
    mode: 'local' | 'cloud' | null;
    /** Non-null when the flag was present but the value was invalid. */
    error: string | null;
}

export function parseModeFlag(rawArgs: string[]): ParsedModeFlag {
    const out: string[] = [];
    let raw: string | null = null;
    for (let i = 0; i < rawArgs.length; i++) {
        const a = rawArgs[i];
        if (a === '--mode' || a === '-m') {
            raw = rawArgs[i + 1] ?? '';
            i += 1;
            continue;
        }
        if (a.startsWith('--mode=')) {
            raw = a.slice('--mode='.length);
            continue;
        }
        out.push(a);
    }
    if (raw === null) return { args: out, mode: null, error: null };
    const norm = raw.trim().toLowerCase();
    if (norm !== 'local' && norm !== 'cloud') {
        return { args: out, mode: null, error: `--mode must be 'local' or 'cloud' (got '${raw}')` };
    }
    return { args: out, mode: norm, error: null };
}
