<!-- Lore node: lore-rebac-two-layer-2026-05-07 -->

# Lore ReBAC — two-layer model: 5 relation edges + workspace-declared permission schema (Zanzibar-style)

Locked 2026-05-07.

## Decision
ReBAC in Lore uses a two-layer model.

### L1 — Relations (edges, core engine)
Five edge types, locked: `owner, editor, viewer, member, parent`. Subjects: user, group, workspace. Resources: workspace, node, edge. `parent` provides hierarchy/inheritance.

### L2 — Permission schema (workspace-declared, data)
Permission expressions map actions to relations. Authored per workspace via the same schema-driven flow as the rest of the schema (AI-proposed, sandbox, human-approved).

Example:
```
property:
  approve_ticket: editor | owner
  edit_lease:     editor | owner
  transfer_owner: owner
  view:           viewer | editor | owner
```

## Why
- L1 alone (5 edges) covers access scope (Alice on PropertyA vs Bob on PropertyB) but not action nuance (PM can approve tickets, can't transfer ownership).
- Without L2 you either over-grant (collapse roles into editor) or invent per-action edge types (edge explosion).
- L2 is the Zanzibar / SpiceDB / OpenFGA pattern.

## Implementation
- Local: edges in Kùzu, permission expressions evaluated at query time.
- Enterprise: SpiceDB (already aligned with Dataplane).
- Permission schema is workspace data, not code. Lives alongside node/edge schema. Same authoring flow.

## Folded into V2.5 T1
Schema floor + `kind` property + L1 edges + L2 permission-schema authoring. ~1 extra day vs. just L1.
