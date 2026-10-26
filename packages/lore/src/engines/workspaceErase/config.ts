/**
 * workspaceErase/config.ts — settings for the honest-delete lifecycle (lane f6b).
 *
 * `LORE_WORKSPACE_ERASE_AFTER_DAYS` is the recovery window: how long a deleted workspace is kept hidden
 * (restorable) before Lore erases everything it controls. There is deliberately NO switch that turns the
 * scheduled erase off — a delete must not be silently disable-able; the window is the only knob.
 */

/** Recovery window used when the setting is unset or unusable. */
export const DEFAULT_ERASE_AFTER_DAYS = 7;

/** Upper bound so `eraseAfter` is always a representable date (10 years). */
export const MAX_ERASE_AFTER_DAYS = 3650;

/**
 * Legacy deletes (a `deleted` record written before the lifecycle existed, with no `eraseAfter`) are NOT
 * erased automatically — no surprise data loss on upgrade. They are listed as "kept — legacy delete" and
 * erased only on request (`lore workspaces erase-now <id>`). Flip this one constant to change the policy.
 */
export const AUTO_ERASE_LEGACY_DELETES = false;

export interface EraseWindow {
    days: number;
    /** True when the env value was present but not a usable integer (the default was used instead). */
    invalid: boolean;
}

/** Parse `LORE_WORKSPACE_ERASE_AFTER_DAYS`: an integer >= 0 (0 = erase at once). Anything else uses the default. */
export function readEraseWindow(env: Record<string, string | undefined> = process.env): EraseWindow {
    const raw = env['LORE_WORKSPACE_ERASE_AFTER_DAYS'];
    if (raw === undefined || raw.trim() === '') return { days: DEFAULT_ERASE_AFTER_DAYS, invalid: false };
    const t = raw.trim();
    if (!/^\d+$/.test(t)) return { days: DEFAULT_ERASE_AFTER_DAYS, invalid: true };
    const n = Number(t);
    if (!Number.isSafeInteger(n) || n > MAX_ERASE_AFTER_DAYS) return { days: DEFAULT_ERASE_AFTER_DAYS, invalid: true };
    return { days: n, invalid: false };
}

export const workspaceEraseAfterDays = (env: Record<string, string | undefined> = process.env): number => readEraseWindow(env).days;

/** Hourly, after a short delay on boot (the tick is cheap when nothing is due). */
export const ERASE_TICK_INTERVAL_MS = 60 * 60 * 1000;
export const ERASE_TICK_FIRST_RUN_MS = 60 * 1000;

/** Retry backoff after a failed/partial erase attempt: 15 min, doubling, capped at 24 h. */
export function eraseRetryDelayMs(failedAttempts: number): number {
    if (failedAttempts <= 0) return 0;
    return Math.min(24 * 60 * 60 * 1000, 15 * 60 * 1000 * 2 ** (failedAttempts - 1));
}

/** Plain-language statement of what Lore cannot reach (shown in the delete response and the docs). */
export const NOT_REACHED_NOTICE =
    'Copies outside Lore — database backups and exports made by an operator — are not erased by Lore; they expire on your own backup schedule.';

/** Consecutive all-`unverifiable` erase attempts after which a deletion becomes `needs-operator` (default). */
export const DEFAULT_MAX_UNVERIFIABLE_ATTEMPTS = 5;
export const MIN_MAX_UNVERIFIABLE_ATTEMPTS = 1;
export const MAX_MAX_UNVERIFIABLE_ATTEMPTS = 100;

/** Parse `LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS`: an integer 1-100. Anything else uses the default. */
export function readMaxUnverifiableAttempts(env: Record<string, string | undefined> = process.env): number {
    const raw = env['LORE_WORKSPACE_ERASE_MAX_UNVERIFIABLE_ATTEMPTS'];
    if (raw === undefined || raw.trim() === '' || !/^\d+$/.test(raw.trim())) return DEFAULT_MAX_UNVERIFIABLE_ATTEMPTS;
    const n = Number(raw.trim());
    return n >= MIN_MAX_UNVERIFIABLE_ATTEMPTS && n <= MAX_MAX_UNVERIFIABLE_ATTEMPTS ? n : DEFAULT_MAX_UNVERIFIABLE_ATTEMPTS;
}
