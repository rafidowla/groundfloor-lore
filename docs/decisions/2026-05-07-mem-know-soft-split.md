<!-- Lore node: lore-mem-know-soft-split-2026-05-07 -->

# Lore mem/know soft split — type-property, not namespace; auto-promote with audit; curator queue opt-in

Locked 2026-05-07 with Rafi.

## Decision
Lore distinguishes episodic memory from semantic knowledge as a **type-level property (`kind: episodic | factual`)**, NOT as separate `mem.*` / `know.*` namespaces.

## Rules
- Every node type declares `kind: episodic | factual` in the workspace schema.
- Episodic nodes: append-only, vector-biased retrieval, decay weights, per-speaker permissions.
- Factual nodes: mutable with audit, graph-biased retrieval, ReBAC permissions.
- AI promotion (episodic patterns → factual assertions) **auto-applies above confidence threshold**, with full audit log. No mandatory human review.
- Workspaces can **opt in** to a curator queue if they want strict review (regulated industries, domain-vertical compliance). Off by default.

## Why soft split, not hard split
- Hard split (mandatory curator per workspace) adds adoption friction. Personal and Developer workspaces don't need human review of every promotion.
- Real value (clean retrieval, audit trail, ReBAC correctness) comes from the type-level property, not human gating.
- Auto-apply + audit = same correctness, ~5 min/week of spot-check for low-governance workspaces vs. 30–60 min/week per workspace under hard split.

## Implementation cost
- Add `kind` to schema floor.
- One promotion edge type (e.g., `supports`) linking episodic → factual.
- One classifier interface at ingest.
- ~5 days code + tests in V2.5.
- Curator queue is a V3.0+ admin app feature, gated by opt-in flag.

## Implications
- Mira, a domain vertical, IT, Personal, Developer all use the same mem/know mechanics; verticals differ in `kind` mix and in whether they enable the curator queue.
- Promotion pipeline (V4+ learning loop) operates on `kind: episodic` nodes, proposing `kind: factual` assertions.
- Permissions model accounts for `kind` — episodic defaults to per-speaker scope, factual to ReBAC workspace scope.

## Supersedes
Earlier framing in this same conversation that proposed hard `mem.*` / `know.*` namespaces with mandatory curator queue.
