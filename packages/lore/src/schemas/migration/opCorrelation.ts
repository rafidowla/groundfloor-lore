/**
 * opCorrelation.ts — shared destructive-op approval correlation.
 *
 * F-M02 / F-M05 / F-M06 / D2-authz-1 / D2-orch-2.
 *
 * Factored out of mcp/http/routes/schema/migrations.ts so that BOTH the
 * direct migration routes (execute / resume / rollback) AND the
 * orchestrator's migrate phase (schemas/orchestration/orchestrator.ts)
 * correlate submitted destructive ops against the approved-ops set using
 * the SAME destructive-kind universe and the SAME (kind,target)
 * canonicalization. Previously the orchestrator only checked 3 row-deleting
 * kinds with a different (verbatim-target) signature, which let the other 6
 * destructive kinds through and could mis-correlate cosmetically-different
 * targets (D2-orch-2).
 */

/**
 * F-M02 — EVERY destructive MigrationOpKind execute/resume/rollback can act
 * on. The correlation must cover all of these, not just the row-DELETING
 * subset {node_type.removed, field.removed, edge_type.removed} the gate
 * previously used: that earlier set let non-row-deleting-but-still-destructive
 * kinds (node_type.renamed, node_type.kind_changed, field.type_changed,
 * field.sensitivity_flipped, permission.changed, permission.removed) be
 * smuggled into an execute/resume/rollback under a benignly-approved sandbox
 * without being checked against the approved op set
 * (approve-benign-then-execute-arbitrary, generalised beyond mass-delete).
 *
 * This is exactly the `MigrationOpKind` union from schemas/migration/types.ts —
 * that union is, by construction, the set of destructive kinds the runner acts
 * on. Purely-additive SchemaChangeKinds (node_type.added / field.added /
 * edge_type.added / permission.added) are NOT in MigrationOpKind and are
 * therefore intentionally absent here, so additive proposals are never
 * over-blocked.
 */
export const DESTRUCTIVE_OP_KINDS = new Set<string>([
    'node_type.removed',
    'node_type.renamed',
    'node_type.kind_changed',
    'field.removed',
    'field.type_changed',
    'field.sensitivity_flipped',
    'edge_type.removed',
    'permission.changed',
    'permission.removed',
]);

/**
 * Destructive kinds whose legitimate decompose output contains NO same-kind
 * approved proposal (the migrate op's kind differs from every proposed change
 * kind). Per R-002's MINIMAL SAFE CLOSURE, correlate these ONLY when the
 * approved set DOES contain a same-kind entry — so the decompose flow is never
 * false-rejected, while a hand-crafted plan that smuggles such an op into a
 * sandbox that legitimately approved that kind is still caught.
 */
export const SKIP_CORRELATION_IF_NO_SAMEKIND = new Set<string>(['node_type.renamed']);

/**
 * F-M05/M06 — canonicalize a destructive-op target before (kind,target)
 * correlation, on BOTH the approved-side signature and the submitted op.
 *
 * The previous gate compared `target` VERBATIM (string equality). Node-type
 * targets are dotted ("<workspace>.<TypeName>", e.g. "know.Tenant") and field/
 * permission targets carry a "<TypeName>.<field>" tail, so a cosmetically
 * different-but-equivalent target — surrounding whitespace or a dot segment
 * with stray internal padding — would NOT match an approved signature and could
 * smuggle an unapproved destructive op past the check (or, symmetrically,
 * false-reject a legitimate one). Normalize deterministically:
 *   - trim outer whitespace,
 *   - split on '.', trim each dotted segment, drop empty segments, rejoin.
 * Both the approved record and the submitted op pass through this same rule, so
 * only a genuinely different target can differ. Additive kinds never reach this
 * (they are not in DESTRUCTIVE_OP_KINDS), so they are unaffected.
 *
 * D2-authz-1 (regression of F-M05/M06) — the earlier version appended
 * `.toLowerCase()`. But graph node-type / target names are CASE-SENSITIVE:
 * `know.Tenant` and `know.tenant` are DISTINCT live types. Lower-casing
 * collapsed them to one approved signature, so an unapproved op on
 * `know.tenant` could match an approval for `know.Tenant`. The fix is to drop
 * `.toLowerCase()` entirely and PRESERVE the case of the type/target name. The
 * documented whitespace/empty-segment cases are still covered by trim +
 * per-segment trim + empty-segment drop; only the unsafe case-folding is gone.
 *
 * Conservative: legitimate happy-path targets (operator + correct sandbox) are
 * byte-identical on both sides today, so canonicalizing both sides is a no-op
 * for them and cannot break the existing schema-routes-unit happy paths.
 */
export function canonicalizeTarget(target: string): string {
    // D2-authz-1 — preserve case; do NOT lower-case graph type/target names.
    return String(target ?? '')
        .trim()
        .split('.')
        .map(seg => seg.trim())
        .filter(seg => seg.length > 0)
        .join('.');
}

/** F-M05/M06 — canonical (kind,target) signature shared by every correlation
 *  site (execute / resume / rollback / orchestrate). kind is matched exactly
 *  (it is a fixed enum string); only target is normalized. */
export function canonicalSig(o: { kind: string; target: string }): string {
    return JSON.stringify([o.kind, canonicalizeTarget(o.target)]);
}

/**
 * F-M02 — true iff op `o` is a destructive op that must be present in the
 * approved set. Strict for all destructive kinds, except the
 * SKIP_CORRELATION_IF_NO_SAMEKIND kinds (node_type.renamed) which are exempt
 * when the approved set has no entry of the same kind (the decompose case).
 */
export function isUnapprovedDestructiveOp(
    o: { kind: string; target: string },
    approvedSigs: ReadonlySet<string>,
    approvedKinds: ReadonlySet<string>,
    sig: (x: { kind: string; target: string }) => string = canonicalSig,
): boolean {
    if (!DESTRUCTIVE_OP_KINDS.has(o.kind)) return false;
    if (approvedSigs.has(sig(o))) return false;
    // Exempt decompose-only kinds when no same-kind approved entry exists.
    if (SKIP_CORRELATION_IF_NO_SAMEKIND.has(o.kind) && !approvedKinds.has(o.kind)) return false;
    return true;
}
