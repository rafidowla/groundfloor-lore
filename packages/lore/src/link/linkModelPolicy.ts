/**
 * linkModelPolicy.ts - link thresholds stored PER EMBEDDING MODEL.
 *
 * Cosine scores are not comparable across models (or even dtypes of one model),
 * so the similarity threshold and k are calibrated per model and keyed by the
 * model fingerprint (`embeddingProviderFingerprint`: `modelId@dtype`). A rebuild
 * is triggered when the policy in force no longer matches the one stamped on
 * existing edges.
 *
 * Calibration source: _lore-3.25-handoff/LINK-THRESHOLD-CALIBRATION-2026-10-23.md
 * (passage-vs-passage links from stored vectors; e5-small => 0.80, k 5).
 *
 * Lookup order: exact fingerprint, then the model id with any dtype, then the
 * uncalibrated default (same numbers; logs once per fingerprint so an operator
 * knows the model was never measured). Env vars override all of it (operators).
 */
import { DEFAULT_LOCAL_MODEL_ID } from '../providers/localEmbeddingProvider.js';

export interface ModelLinkPolicy {
    minSim: number;
    k: number;
}

/** Applied to a model with no calibration entry. */
export const UNCALIBRATED_LINK_POLICY: ModelLinkPolicy = { minSim: 0.80, k: 5 };

/**
 * Calibrated models. Keys are fingerprints (`modelId@dtype`) or a bare model id,
 * which matches that model at any dtype.
 */
export const MODEL_LINK_POLICIES: Readonly<Record<string, ModelLinkPolicy>> = {
    [DEFAULT_LOCAL_MODEL_ID]: { minSim: 0.80, k: 5 },
};

const warned = new Set<string>();

export interface ResolvedModelPolicy extends ModelLinkPolicy {
    /** False when the model has no calibration entry (the default numbers are in use). */
    calibrated: boolean;
}

/** Test hook: forget which fingerprints were already logged. */
export function resetUncalibratedWarnings(): void { warned.clear(); }

export function resolveModelLinkPolicy(
    fingerprint: string | null | undefined,
    log: (msg: string) => void = (m) => console.warn(m),
): ResolvedModelPolicy {
    if (fingerprint) {
        const exact = MODEL_LINK_POLICIES[fingerprint];
        if (exact) return { ...exact, calibrated: true };
        const at = fingerprint.lastIndexOf('@');
        const bare = at > 0 ? MODEL_LINK_POLICIES[fingerprint.slice(0, at)] : undefined;
        if (bare) return { ...bare, calibrated: true };
    }
    const key = fingerprint ?? '(unknown)';
    if (!warned.has(key)) {
        warned.add(key);
        log(`[Lore link] embedding model "${key}" has no calibrated link threshold; using the default minSim=${UNCALIBRATED_LINK_POLICY.minSim} k=${UNCALIBRATED_LINK_POLICY.k}. Set LORE_LINK_MIN_SIM / LORE_LINK_K to tune.`);
    }
    return { ...UNCALIBRATED_LINK_POLICY, calibrated: false };
}
