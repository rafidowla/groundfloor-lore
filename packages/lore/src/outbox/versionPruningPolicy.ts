/**
 * versionPruningPolicy.ts — the EFFECTIVE version-history policy: whether
 * age-based deletion of `node_versions` rows is enabled, at what retention,
 * and where that setting came from.
 *
 * Owner decision (2026-09-29): version history is never deleted by age
 * unless explicitly enabled. Default = keep forever, for embedded
 * `createLore()` hosts and the daemon alike. When enabled, the default
 * retention is 7 years.
 *
 * Precedence for the pruning switch (highest first):
 *   1. `createLore({ versionHistory: { pruning } })`          -> source 'option'
 *   2. env `LORE_VERSION_PRUNE_ENABLED` (1/true or 0/false)   -> source 'env'
 *   3. env `LORE_VERSION_RETENTION_DAYS` explicitly set to a
 *      positive number (back-compat: the operator asked for a
 *      retention window, so pruning is enabled at that value
 *      and a one-time notice is logged)                       -> source 'env'
 *   4. otherwise disabled                                     -> source 'default'
 *
 * Read-only by design: this is resolved once at boot from host config. No
 * MCP tool, REST route or instance method can change it.
 */

import { resolveVersionHistoryPolicy, type VersionHistoryPolicy } from './versionPolicy.js';

/** 7 years, in days (365 * 7 + 2 leap days). */
export const DEFAULT_PRUNE_RETENTION_DAYS = 2557;

export type VersionPolicySource = 'default' | 'option' | 'env';

export interface EffectiveVersionHistoryPolicy {
    /** True only when age-based deletion was explicitly enabled. */
    enabled: boolean;
    /** Retention window in days; `null` when pruning is disabled. */
    retentionDays: number | null;
    /** Configured per-type overrides. Inert unless `enabled`. */
    retentionDaysByType: Record<string, number>;
    /** Types for which no version row is recorded. Existing rows of these
     *  types are deleted only when `enabled`. */
    skipTypes: string[];
    /** Where the `enabled`/`retentionDays` setting came from. */
    source: VersionPolicySource;
    /** Where `skipTypes` came from. */
    skipTypesSource: VersionPolicySource;
}

let legacyRetentionNoticeLogged = false;

/** Test hook: re-arm the once-per-process back-compat startup notice. */
export function _resetLegacyRetentionNoticeForTests(): void {
    legacyRetentionNoticeLogged = false;
}

function envFlag(raw: string | undefined): boolean | undefined {
    if (raw === undefined) return undefined;
    const v = raw.trim().toLowerCase();
    if (v === '1' || v === 'true') return true;
    if (v === '0' || v === 'false') return false;
    return undefined;
}

function envPositiveDays(raw: string | undefined): number | undefined {
    if (raw === undefined || raw.trim() === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function resolveEffectiveVersionHistoryPolicy(
    option?: VersionHistoryPolicy,
    env: NodeJS.ProcessEnv = process.env,
): EffectiveVersionHistoryPolicy {
    const raw = resolveVersionHistoryPolicy(option);
    const skipTypes = [...(raw?.skipTypes ?? [])];
    const retentionDaysByType = { ...(raw?.retentionDaysByType ?? {}) };
    const skipTypesSource: VersionPolicySource =
        option?.skipTypes !== undefined ? 'option' : skipTypes.length > 0 ? 'env' : 'default';
    const base = { retentionDaysByType, skipTypes, skipTypesSource };

    if (option?.pruning !== undefined) {
        const on = option.pruning.enabled === true;
        return {
            ...base,
            enabled: on,
            retentionDays: on ? (option.pruning.retentionDays ?? DEFAULT_PRUNE_RETENTION_DAYS) : null,
            source: 'option',
        };
    }

    const envDays = envPositiveDays(env['LORE_VERSION_RETENTION_DAYS']);
    const flag = envFlag(env['LORE_VERSION_PRUNE_ENABLED']);
    if (flag === true) {
        return { ...base, enabled: true, retentionDays: envDays ?? DEFAULT_PRUNE_RETENTION_DAYS, source: 'env' };
    }
    if (flag === false) {
        return { ...base, enabled: false, retentionDays: null, source: 'env' };
    }
    if (envDays !== undefined) {
        if (!legacyRetentionNoticeLogged) {
            legacyRetentionNoticeLogged = true;
            console.error(
                `[version-prune] LORE_VERSION_RETENTION_DAYS=${envDays} is set, so age-based version-history ` +
                `pruning is ENABLED at ${envDays} days (back-compat). Version history is otherwise kept forever; ` +
                `set LORE_VERSION_PRUNE_ENABLED=1 to enable it at the 7-year default (${DEFAULT_PRUNE_RETENTION_DAYS} days).`,
            );
        }
        return { ...base, enabled: true, retentionDays: envDays, source: 'env' };
    }
    return { ...base, enabled: false, retentionDays: null, source: 'default' };
}
