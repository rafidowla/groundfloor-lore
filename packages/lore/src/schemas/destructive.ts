/**
 * destructive.ts — Phase 1 safety guard for the Agentic DBA flow.
 *
 * Defines which `SchemaChangeKind`s are *destructive* (in the sense
 * "existing data may be invalidated, lost, or its visibility changed
 * if this is approved without a migration plan") and enforces the
 * rule: destructive proposals must come from a human actor.
 *
 * Why this rule:
 *   See `docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md`. An LLM agent in a tool
 *   loop should not be able to propose dropping a field, dropping a
 *   table, changing a column type, renaming a node type, or relaxing
 *   a permission and have a busy human one-click approve it. The
 *   `proposedBy` field already follows a `kind:id` convention
 *   (`ai:claude`, `human:rafi`, `system:auto-installer`) per the
 *   schema-change audit doc; we use that prefix as the actor-kind
 *   signal.
 *
 * This is the cheap step-1 guard from the memo. Future hardening:
 *   - A separate "actor-kind" channel that doesn't trust the
 *     proposer's self-label (e.g. derive from auth token or Clerk
 *     JWT claim).
 *   - Tier-3 second-party HITL queue for the most destructive ops.
 *   - Computed blast radius (row count, reader count, reversibility
 *     cost) so tier routing isn't proposer-dependent at all.
 */

import type { SchemaChangeKind } from '../security/schemaChangeAudit.js';
import type { SchemaProposal } from './authoring.js';

/**
 * Change kinds that may invalidate existing data, remove existing
 * data, or expose previously-restricted data. Proposals containing
 * any of these require a human proposer.
 *
 * Intentionally conservative: `permission.changed` is included
 * because tightening / loosening a permission expression can both
 * leak previously-restricted rows and hide previously-visible rows.
 *
 * Not destructive (additive — agent-allowed):
 *   - node_type.added
 *   - field.added
 *   - edge_type.added
 *   - permission.added
 *   - workspace.system_prompt_changed
 *   - workspace.domain_changed
 */
export const DESTRUCTIVE_CHANGE_KINDS: ReadonlySet<SchemaChangeKind> = new Set([
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

/** True when at least one change in the proposal is destructive. */
export function hasDestructiveChange(proposal: SchemaProposal): boolean {
    for (const c of proposal.changes) {
        if (DESTRUCTIVE_CHANGE_KINDS.has(c.kind)) return true;
    }
    return false;
}

/**
 * Convention: `proposedBy` prefixes are `human:` (a real person, e.g.
 * via the UI / CLI / a Clerk-validated JWT), `ai:` (an LLM agent),
 * or `system:` (a deterministic background process — installer, hot-
 * reload, migration runner). Only `human:` is allowed to propose
 * destructive change kinds.
 *
 * `system:` is intentionally NOT trusted for destructive changes:
 *   automated installers and the like should never need to drop schema;
 *   if one does, that path should be a human-approved release, not
 *   an automatic install-time mutation.
 */
const HUMAN_PROPOSER_PREFIX = 'human:';

export function isHumanProposer(proposedBy: string): boolean {
    return proposedBy.startsWith(HUMAN_PROPOSER_PREFIX);
}

/**
 * Throw if the proposal contains any destructive change kind and the
 * proposer is not a human. Caller (`SchemaAuthoringStore.propose`)
 * invokes this before persisting the sandbox entry, so a rejected
 * proposal leaves no on-disk trace.
 *
 * Error message lists the offending change kinds and the offending
 * proposer so the rejected client can surface a useful message.
 */
export function assertHumanForDestructive(proposal: SchemaProposal): void {
    if (!hasDestructiveChange(proposal)) return;
    if (isHumanProposer(proposal.proposedBy)) return;

    const offending = proposal.changes
        .filter(c => DESTRUCTIVE_CHANGE_KINDS.has(c.kind))
        .map(c => `${c.kind}(${c.target})`)
        .join(', ');

    throw new Error(
        `[schema-authoring] destructive change(s) [${offending}] require a human proposer ` +
        `(proposedBy must begin with "human:"); got "${proposal.proposedBy}". ` +
        `See docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md for the rationale and tier structure.`,
    );
}
