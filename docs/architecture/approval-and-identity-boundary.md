# Design note — Approval enforcement vs. identity: what belongs in Lore vs. the app above it

> Author: working notes captured 2026-06-18 (deep-audit follow-up discussion).
> Status: design decision, recording where two responsibilities live.
> Companion to: `SCHEMA_CHANGE_SAFETY_MEMO.md` (the destructive-change model),
> `admin_model.md` (daemon vs. workspace admin), and the audit artifacts in
> `docs/audit/` (the criticals/highs that hardened the destructive surface).

## The question in one paragraph

Lore Core is a **schema-agnostic, multi-client database** (graph + vector +
relational). Destructive operations (dropping a node type / field / edge type,
running a data migration) are gated by a two-part control: a per-operation
**approval** and, for the destructive tier, a **second human approver** (the
HITL pending-ops queue). Two questions came up: (1) does the *two-person
approval* belong inside Lore or in the application layer above it, and (2) does
*strengthening identity* (proving the approver is a real, distinct human — SSO /
MFA) belong inside Lore or above it? This note records the answer and why.

## The principle

The repo's standing rule (see root `CLAUDE.md`) is: **"Is this database
infrastructure, or domain logic?"** Infrastructure that protects data integrity
*regardless of which client connects* belongs in Lore Core. Workflow, policy,
presentation, and who-is-a-real-person belong in the client/edge above it.

Apply that to a classic database analogy:
- A database **enforces** its own constraints and permissions — it does not
  trust each connecting app to self-police, because a second app (or a raw API
  call) would bypass an app-only check.
- A database **authenticates credentials/roles** ("is this token valid, what may
  it do") — it does **not** run logins or verify that a credential maps to a
  real, distinct human. That is authentication, done at the edge by an identity
  provider (IdP).

## The decision

| Concern | Belongs | Why |
|---|---|---|
| **Approval enforcement gate** — refuse an unapproved destructive op; require the 2nd approver's identity to differ from the 1st; bind a migration to exactly the approved op set | **In Lore Core** | Lore is the shared chokepoint. Multiple apps + direct REST/MCP callers write to it. An app-only gate is bypassable by another caller. The gate is data-integrity infrastructure. |
| **Approval policy + workflow + UI** — which changes require a 2nd approver *for this business*, the approval inbox/notifications, the "Approve" screen | **App layer above Lore** | This is domain/workflow. Lore exposes the mechanism (the pending-ops queue + the distinct-identity rule); the app decides the policy and presents it to people. |
| **Identity verification** — proving the approver is a real, distinct human (login, SSO/OIDC, MFA) | **App / IdP above Lore** | A database consumes a *trusted identity claim*; it does not perform authentication. Lore should trust a signed claim from an IdP and enforce authz + distinct-identity on top of it. |

One line: **Lore enforces the mechanism; the app/IdP supplies verified identity
and the workflow.** Lore's job is to *trust and enforce*, not to *authenticate
the person*.

## Where the code sits today (2026-06-18)

Enforced **inside Lore** (correct placement — keep it here):
- The destructive-change **gate**: token write-scope is required; the actor must
  be stamped `human:*` (AI/automated actors are refused); the migration-execute
  path is bound to the approved proposal's op set (audit C2 / L-002), and the
  same correlation now guards the changeset-commit and orchestration-migrate
  paths (audit R-005 / R-001).
- The **two-person rule**: the pending-ops (HITL) queue *is* wired in the daemon.
  A destructive schema approval is **enqueued** (not applied immediately) and a
  **different** admin must approve it; self-approval is blocked (the 2nd
  approver's identity must differ from the initiator).

The **soft spot** (and why it's an *above-Lore* fix, not a Lore fix):
- "Who counts as a human / which person" is currently a **caller-asserted**
  `human:<id>` string. Lore enforces "the 2nd identity must differ from the 1st,"
  but it does not independently verify that those identities map to two real,
  distinct humans — because nothing above it is vouching for identity today.
- Lore already has the **hook** to consume a real IdP: in cloud mode it can read
  a Clerk/JWT identity claim. So the fix is **stand up a real IdP above Lore (or
  in the app/gateway) and have Lore trust its verified claims** — turning the
  `human:` label from an honor-system assertion into a verified claim. This is
  *not* "build login into the database."

## Implications / what this means for future work

- **Do NOT move the approval gate up into an app.** It must stay at the shared
  Lore chokepoint or it becomes bypassable. Apps add policy + UI on top, not the
  enforcement.
- **The approval UI + policy is an app deliverable** (there is no Lore UI; that
  lives in `../groundfloor-lore-app/`). Lore exposes the queue + decision API for
  the app to drive.
- **Strengthening approval identity = an IdP/edge deliverable**, with Lore
  consuming verified claims. Tracked as the hardening lever behind both the
  rename/retype residual (`docs/audit` R-002) and approvals generally.
- The two-person mechanism is only as strong as the distinctness of the issued
  identities: it holds when tokens/identities are issued to actually-distinct
  people; it cannot detect one person holding two tokens until a real IdP backs
  the identities.
