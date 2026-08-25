# Lore Auth + Sync Design

> Captured 2026-05-10 from a session with Rafi (+ Amin / Plabon for some answers).
> This document is the source of truth for what was decided. Code follows from here.
> If this conflicts with anything else in the repo, this wins until superseded by another decision doc.

## The mental model

**Local Lore = cached client.** **Cloud Lore = source of truth for who-sees-what.**

Closer to Slack-desktop or Notion than a single-user Mac app. The local copy is authoritative for offline use; the cloud is authoritative for sharing + permissions. When sharing changes, local clients reconcile.

### Concrete example (Rafi's words)

> "I'm working on Project 1 and Project 2. I share Project 1 with Amin, Project 2 with Plabon. Amin only receives Project 1 on his machine. Plabon only receives Project 2. If I remove Amin from Project 1, it's removed from Amin's machine."

This means:
- Each user's local Lore holds a **subset** of the workspaces they're authorized to see.
- Sharing is a cloud-side action (admin portal).
- Revocation propagates from cloud → local → workspace dir deleted.
- A user's **own** workspaces (e.g. Personal) sync across their own devices in this same model.

## Decisions made in this session

### Auth model

| Decision | Detail |
|---|---|
| Local mode runs auth | Yes. ReBAC enforces in both local + cloud — no skip path. |
| Operator identity | Bound to a `portal_user` from the JWT. **Not** OS user. (Adjusts PR #27.) |
| Login flow | `lore login` (browser-pop OAuth by default; device-code flow also supported for headless / SSH). |
| Token storage | OS keychain (preferred) with fallback to `<LORE_HOME>/operator.json` mode 0600. |
| ReBAC | Always via `dataplane.checkPermission()` — Lore never talks to SpiceDB directly. The platform's SDK abstracts SpiceDB. |
| Schema mimic | `schemas/portal-mimic.zed` is **contract documentation only**, not a load target. Lore does not push it anywhere. |
| Service-to-service | `LORE_MCP_AUTH_TOKEN` shared secret (PR #21). DEF/Loom uses it; rotated manually for now. |

### Sync model

| Decision | Detail |
|---|---|
| v1 strategy | Simplest-possible: client polls cloud, last-write-wins, full-workspace pull. Upgrade to delta + websockets when scale demands. |
| Revocation latency | Seconds eventually (websocket); minutes via poll is fine for v1. |
| Conflict handling | Last-write-wins for v1. Vector clocks / CRDTs deferred. |
| Sync trigger | Periodic poll + on-demand on user action. |
| Permission gate on push | Client only writes WAL changes for workspaces where the user has `write` per the closed vocabulary. |
| Workspace creation | Cloud-side action (admin portal or self-serve via cloud API). Local mirrors after creation. |

### Permission contract (closed vocabulary)

Per the Groundfloor agent brief — Lore reuses `portal_*` schema as-is, no new object types.

```
administer | read | write | delete | ddl | deploy | manage_members | view_billing
```

Object types: `portal_user`, `portal_account`, `portal_workspace`, `portal_environment`.
Lore does NOT introduce new SpiceDB object types.

Per-route map (v0):
- Read endpoints (`recall`, `search`, `nodes`, `topology`, etc.) → `read`
- Write endpoints (`store_node`, `store_edge`, `store_verbatim`, etc.) → `write`
- Schema mutations (declare collection, plugin schema push) → `ddl`
- Destructive ops (`delete_node`, `forget_person`, drop schema) → `administer` + `confirm: true`
- Admin (orphan resolve, retention sweep, plugin manage) → `administer`
- All gated against the workspace from `X-Lore-Workspace`.

### Row-level scopes

`security_scopes: string[]` on Memory / VerbatimDocument / etc. SpiceDB enforces workspace-grain access (coarse). Lore filters rows by `security_scopes` against the actor's effective scope set (fine). See `packages/lore/src/security/scopeFilter.ts`.

### Sandbox semantics for DDL

- Additive DDL → `ddl` permission, audit-logged.
- Destructive DDL → `administer` + literal `confirm` flag in request body, audit-logged.
- All DDL routes through a single `applySchemaChange(change, actor)` choke point.
- Every DDL CLI command supports `--dry-run`.
- Bootstrap script is the only ReBAC-bypass path (no workspace exists yet to check against).

### HITL (Human In The Loop) — three tiers

| Tier | Today | Example |
|---|---|---|
| `automated` — runs without human input | ✅ in place | most reads, additive writes, store_node |
| `self-confirm` — initiator includes `confirm: true` | ✅ in place | forget_person, drop schema, orphan resolve |
| `second-party` — different human with `administer` must approve before execution | ❌ **not built** | drop a workspace, swap auth tenant |

**To close the gap (queued as a follow-up PR):**
1. `humanApproval: 'automated' | 'self-confirm' | 'second-party'` field on each MCP tool / route declaration.
2. For `second-party`, route writes to a pending-approvals queue (SQLite-backed, at `.lore/pending-ops.sqlite`, locally / Postgres collection in cloud) instead of executing. Returns 202.
3. New endpoints: `GET /api/approvals` (list pending) + `POST /api/approvals/{id}/decision` (approve/reject) — themselves gated by `administer`.
4. Default approver: anyone with `administer` on the same workspace, NOT the initiator.
5. Notification channel for "you have something to approve": email + in-app for v0; Slack later.

## What changes per component

### Lore Core
- **Auth-at-boot**: `lore login` flow → JWT → cached.
- **Sync engine**: evolves from self-sync (WAL) to permission-aware sync. Per-workspace pull/push gated by per-write permission check.
- **Revocation handler**: cloud signals "user X lost access to workspace Y" → local Lore deletes `<LORE_HOME>/workspaces/Y/`.
- **Workspace creation**: cloud-side action; local mirrors after.

### Admin portal (`groundfloor-lore-admin-app`)
Today it's "inspect daemon state." It needs to become:
- User management (invite, deactivate, reset).
- Per-workspace member list — add/remove members, assign role (owner / admin / writer / member).
- Sharing UI ("share Project 1 with Amin as writer").
- Audit log: who shared / revoked / accessed what.
- Lives in the cloud-only flow.

### End-user app (steps #7/#8)
- Login flow first surface.
- Sidebar of accessible workspaces only.
- Real-time-ish update on share changes.
- Local-only mode if cloud unreachable, with sync-resume on reconnect.

### Lore Cloud
- **Sync API** (new): per-user "what workspaces, what versions" + delta push/pull.
- **Sharing API** (new): grant/revoke that updates SpiceDB AND notifies affected users' clients.
- **JWT validation** on every sync call (already shipped in `clerkAuth.ts`; gets activated when CLERK_ISSUER lands).
- **SpiceDB relations** match the `portal_*` schema per the agent brief.

## Stuff already built that survives

- All four `IStorageAdapter` surfaces (graph, verbatim, analytical, tables).
- All MCP tools (read + write across the four surfaces).
- All 200+ unit tests + 15-step wire e2e.
- The `LORE_MCP_AUTH_TOKEN` shared-secret service-to-service path (PR #21).
- The shim-aware `LoreMcpClient` in DEF (PR #9).
- Personal plugin v0.6.0 (Person / Place / PersonalEvent / Memory / Communication / Task / Routine).

## Stuff already built that needs adjustment

| Item | Today | Needed change | Owner |
|---|---|---|---|
| PR #27 operator identity | OS-user-derived `lore operator init --manual` | Becomes the cached JWT subject after `lore login`; manual fallback stays for boot before login completes | Lore team — small refactor |
| `schemas/portal-mimic.zed` | Bundled mimic | Repurpose as contract documentation; `schemas/README.md` already says this | done |
| `bootstrap-dataplane.mjs` | Script that registers tenant + grants relations | Stays. Tenant registration is one-time per Lore install; grants happen via SDK (which abstracts SpiceDB) | done |

## Updated `BUILD_ORDER` impact

| Step | Before | After |
|---|---|---|
| #1 Core contracts | ✅ done | unchanged |
| #2 LocalAdapter | ✅ done | unchanged |
| #3 `--mode` CLI flag | ✅ done | unchanged |
| #4 Seed workspaces | ✅ done | unchanged |
| #5 DEF integration | ✅ done | unchanged |
| #6 Cloud mode | 🟡 partial — adapter umbrella shipped | **expanded scope**: also includes sync engine + sharing API + revocation propagation |
| #7 End-user app design | ⏳ | now has login + sharing-aware UI as core requirements |
| #8 End-user app build | ⏳ | gated on #7 |
| #9 Admin app deploy | ⏳ | **expanded scope**: full user/workspace/sharing management, not just daemon inspection |
| #10 More workspaces | ⏳ | unchanged |

## Open / deferred questions

| # | Question | Status |
|---|---|---|
| A1 | Clerk dev tenant available? | Deferred — no tenant yet. Lore uses operator-identity placeholder until ready. |
| A2–A4 | Clerk claim shapes / TTL | Moot until A1. |
| B5 | Canonical `portal_*` schema location | `groundfloor-client-portal/spicedb/schema.zed` (not yet live). Lore stays SDK-abstracted; mimic is contract doc. |
| C10 | Dataplane tenant model | **Resolved 2026-05-10**: `DATAPLANE_TENANT_ID = portal_account` (per-customer-org). NOT a single "lore" service tenant. See **Tenant model** section below. |
| G23 | End-user app surface (Mac / web / extension)? | Needs design session. |
| G24 | Anchor flow / v0 demo moment | Needs design session. |
| G25 | End-user identity model | Needs design session. |
| Sync v2 | When to upgrade poll → websocket / delta sync | Triggered by scale; not v1. |
| HITL | Pending-approval storage location | Local SQLite (`.lore/pending-ops.sqlite`) / cloud Postgres — confirmed. |
| HITL | Notification channel | Email + in-app v0; Slack later — confirmed. |
| HITL | Approver selection | Anyone with `administer`, not the initiator — confirmed. |

## Tenant model (resolved 2026-05-10)

**`DATAPLANE_TENANT_ID = portal_account`.** Per-customer-org. Not a single Lore-service-wide tenant.

```
portal_account (= Dataplane tenant)     e.g. "account-a-acct-123"
  └─ portal_workspace                   e.g. "Enterprise IT", "Property Portfolio"
        └─ data (nodes / edges / plugins / members)
```

**Implications:**
- Lore Core has **no** static `DATAPLANE_TENANT_ID` env var at boot. Tenant id is resolved **per request** from the JWT's account claim (or an `X-Lore-Account` header).
- Tenant *registration* in Dataplane happens at customer onboarding (admin portal / control plane). **Lore Core never registers a tenant.** The existing `scripts/bootstrap-dataplane.mjs` is wrong on this — its tenant-register call should be removed, and the script becomes "verify the tenant exists + push collections" only.
- Strong cross-customer isolation comes for free — different customers literally hit different Dataplane tenants.
- "Multiple disconnected Lores within one customer org" = multiple `portal_workspace`s within that customer's tenant.

**Code changes this implies (not yet shipped):**
1. `scripts/bootstrap-dataplane.mjs`: drop the `registerTenant` step. Per-customer registration is the platform's job.
2. `services.ts` createGraph / createVectorStore: don't read a static `DATAPLANE_TENANT_ID` env var. Pass a `tenantProvider: () => string` that resolves per-request from the JWT/header — already partly built (see `dataplaneVectorStore.ts:86` `tenantProvider`).
3. The local Lore daemon may serve a user across multiple `portal_account`s (e.g. user has a personal account + a guest seat in a customer org) — the request routing must support that.

## Authoritative Lore decisions referenced

- `lore-build-priority-order-2026-05-09` — 10-step order
- `lore-unified-service-architecture-2026-05-09` — one TS codebase, two adapters
- `lore-plugin-workspace-skill-distinction-2026-05-09` — Plugin / Workspace / Skill
- `lore-analytical-primitive-universal-2026-05-09` — analytical surface universal
- (this doc) `lore-auth-and-sync-design-2026-05-10` — auth + sync model
