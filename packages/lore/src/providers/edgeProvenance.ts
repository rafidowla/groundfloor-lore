/**
 * edgeProvenance.ts - engine-neutral edge provenance types (design D3). Re-exported from providers/types.ts.
 */

/**
 * Where an edge came from (edge provenance, design D3). Stored per edge by the
 * SQLite and Postgres graph engines. Rows written before provenance existed
 * have no origin (read as legacy: `provenance` absent).
 */
export const EDGE_ORIGINS = ['caller', 'link_on_arrival', 'reconnect', 'discovery', 'import'] as const;
export type EdgeOrigin = (typeof EDGE_ORIGINS)[number];

/** Provenance of one edge. Every field is optional on write; the engine stamps `createdAt` and defaults `origin` to 'caller'. */
export interface EdgeProvenance {
    origin?: EdgeOrigin;
    /** Link policy that produced the edge (LORE_LINK_POLICY_VERSION for link-on-arrival). */
    policyVersion?: string | null;
    /** Embedding model fingerprint (`modelId@dtype`) the similarity was computed with. */
    modelFingerprint?: string | null;
    /** ISO timestamp the edge row was first written. */
    createdAt?: string;
    /** ISO timestamp the edge was soft-invalidated; null/absent = live. */
    validTo?: string | null;
}

/** The directed triple that identifies one edge. */
export interface EdgeKey {
    sourceId: string;
    targetId: string;
    relation: string;
}

/** Resolved provenance columns for one edge write (what the engines bind). */
export interface EdgeProvenanceColumns {
    origin: EdgeOrigin;
    policyVersion: string | null;
    modelFingerprint: string | null;
    createdAt: string;
}

/** Fill defaults (`origin` 'caller', `createdAt` now) and reject an unknown origin. Throws a plain Error; callers wrap it. */
export function resolveEdgeProvenance(
    p: EdgeProvenance | undefined,
    defaultOrigin: EdgeOrigin,
    now: string = new Date().toISOString(),
): EdgeProvenanceColumns {
    const origin = p?.origin ?? defaultOrigin;
    if (!(EDGE_ORIGINS as readonly string[]).includes(origin)) {
        throw new Error(`invalid_edge_origin: '${String(origin)}' (expected one of ${EDGE_ORIGINS.join(', ')})`);
    }
    return { origin, policyVersion: p?.policyVersion ?? null, modelFingerprint: p?.modelFingerprint ?? null, createdAt: p?.createdAt ?? now };
}

/** The five provenance columns as a row read back from either engine. */
export interface EdgeProvenanceRow {
    origin?: string | null;
    policy_version?: string | null;
    model_fingerprint?: string | null;
    created_at?: string | Date | null;
    valid_to?: string | Date | null;
}

const iso = (v: string | Date | null | undefined): string | undefined => (v == null ? undefined : v instanceof Date ? v.toISOString() : v);

/** Row -> `EdgeProvenance`. Legacy rows (origin NULL) yield no origin/createdAt; `validTo` is always present (null = live). */
export function edgeProvenanceFromRow(row: EdgeProvenanceRow): EdgeProvenance {
    const out: EdgeProvenance = { policyVersion: row.policy_version ?? null, modelFingerprint: row.model_fingerprint ?? null, validTo: iso(row.valid_to) ?? null };
    if (row.origin != null) out.origin = row.origin as EdgeOrigin;
    const created = iso(row.created_at);
    if (created !== undefined) out.createdAt = created;
    return out;
}
