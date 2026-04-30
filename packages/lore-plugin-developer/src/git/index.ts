/**
 * git/index.ts
 *
 * Atlas — Lore developer plugin's tree-sitter code intelligence layer.
 * Git-derived signal surface. Host-agnostic via local `git` binary.
 *
 * Original work authored for groundfloor-lore. Patterns informed by
 * reading GitNexus and jcodemunch source for understanding only — no
 * code copied, no structural mirroring. See `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10 for the license-compliance protocol enforced by
 * `scripts/atlas-license-check.mjs`.
 *
 * Phase: 5 (git signals — host-agnostic).
 *
 * Four modules. All use the local `git` binary; nothing talks to host
 * APIs (GitHub / Bitbucket / GitLab). Per-host PR-state integration
 * (reviewer attention, CI status, comment count) is parked for
 * Phase 9+.
 */

export { fileChurn, repoChurn, churnScore } from './churn.js';
export type { ChurnStats } from './churn.js';

export { symbolLineage, symbolAuthors } from './lineage.js';
export type { BlameLine } from './lineage.js';

export { prRisk } from './prRisk.js';
export type { PrRiskReport, SymbolRiskFactors } from './prRisk.js';

export { detectChanges, getChangedRanges } from './detectChanges.js';
export type { AffectedSymbol, ChangedRange, DetectScope } from './detectChanges.js';
