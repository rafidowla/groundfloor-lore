# Deployment Model

> Last updated: 2026-08-21 (graph-engine specifics updated for SurrealDB
> default per v3.13.0; three-mode decision recorded 2026-06-19)
>
> This is a design-intent document. Read this before deploying Lore in any
> form more ambitious than "install on my laptop."

## TL;DR

**One Lore daemon per human.** Install Lore on your own machine. If you
want to share knowledge with a family, team, or organization, each
person runs their own local daemon and they sync to each other via
Dataplane (Lore's cloud layer).

Do not run one Lore daemon for multiple people.

## The three deployment modes (decided 2026-06-19)

Lore Core is a **schema-agnostic database** — it is never used "standalone"
by an end user; it is always **fronted by an application** that defines the
schema/vocabulary and the domain meaning (Atlas for code, Loom for digital
employees, etc.). The IDE/agent tools (Claude Code, Cursor, Antigravity)
connect to the *app*, not to Lore directly. Lore is the basement; the app is
the front door. (Don't hard-block direct access — like `psql`, keep the
admin/ops escape hatch — but no app should rely on raw Lore for meaning, and
**no domain schema belongs in Lore Core**.)

A single human's Lore runs in exactly one of three modes (`deploymentMode`,
default `local`):

| Mode | Analogy | Shape |
|---|---|---|
| **`embedded`** | **SQLite** | Lore runs *in-process inside one app*. No port, no daemon. The host app owns the full lifecycle — **including maintenance** (retention/consistency sweeps + LanceDB compaction are gated OFF in embedded; the host must drive the `maintain` tool on its own timer). **Destructive schema changes are refused at proposal time** (see callout below the table). |
| **`local`** | **Postgres on `localhost`** | One shared daemon **per human/machine**, serving **that human's multiple apps**. Each app connects with a **workspace-scoped token** and gets its own **workspace = its own "database"** (own SurrealDB + LanceDB on disk). |
| **`cloud`** | Managed Postgres / RDS | Scalable, multi-tenant, backed by the Dataplane. The deferred path. |

> ⚠️ **Destructive schema changes are REFUSED at proposal time in embedded
> mode** (launch-fixes-2026-08 item 3; previously they enqueued and hung —
> the v3.14.0 CHANGELOG known limitation). A destructive proposal (e.g.
> removing a node type) requires the mandatory second-party HITL
> confirmation step, `POST /api/approvals/{id}/decision` — an **HTTP-only
> endpoint** — and embedded mode has no HTTP port and no MCP-tool
> equivalent. Rather than enqueueing a change no embedded host could ever
> decide, `schema_approve` now refuses destructive proposals immediately
> with the structured error `destructive_hitl_unavailable_embedded`
> ("destructive schema changes require daemon (local) mode…"), and nothing
> is enqueued. To perform destructive schema changes, run the local daemon
> (`lore serve --http`) and approve via the approvals endpoint. Additive
> schema changes are unaffected — they apply immediately in every mode. The
> full embedded confirm path is deferred post-launch.

### Local = the Postgres model (Option i, decided 2026-06-19)

"One daemon per human" (above) is about multiple **people** → each runs their
own daemon, sharing via cloud. The Postgres model is orthogonal: **one
person's multiple apps share that person's one local daemon**, each app on its
own workspace.

This is consistent with the single-writer-per-workspace constraint below:
SurrealDB's embedded backends (`surrealkv://` default, `rocksdb://` alt) and
LanceDB each hold an exclusive lock on their on-disk directory — only one
process may have a given workspace open at a time — and **each workspace is
its own database**. The ONE daemon process is therefore the sole opener of
every workspace, so multiple apps writing *different* workspaces through
*one* daemon never contend — what's forbidden is two *processes* (two
daemons) opening the *same* workspace.

| Postgres | Lore (local mode) |
|---|---|
| One server | One local daemon (per human/machine) |
| Many databases | Many workspaces (each its own SurrealDB + LanceDB) |
| App connects with creds for its DB | App connects with a `lore_<workspace>_…` scoped token |
| Server serves many DBs concurrently | The daemon keeps multiple workspaces open concurrently (`LocalGraphRegistry`) |

### Consequence — workspace isolation is now load-bearing

Because multiple apps genuinely run against *different* workspaces on the same
daemon, **per-request workspace routing and isolation must be airtight**:

- Every workspace-taking operation MUST route to the **requested** workspace
  (resolve via `LocalGraphRegistry`/the verbatim resolver), never the
  boot/active default. A token scoped to workspace A must never read or write
  workspace B's data. (This is the security boundary between apps — and a
  data-correctness boundary even when all apps are the same trusted operator's.)
- Apps SHOULD always name their workspace per request. The legacy
  "active/default workspace" notion — where `POST /api/workspaces/switch`
  **restarts the daemon** — is a wart in the Postgres model (one app must not
  be able to restart the daemon for all the others) and should be retired in
  favor of per-request targeting.

The cross-workspace routing remediation tracked in `docs/audit/` exists to
satisfy this; under the Postgres decision it is a **must-fix**, not a deferred
correctness tail.

## The Architecture

```
 ┌─────────────────────┐          ┌─────────────────────┐
 │  Alice's machine    │          │  Bob's machine      │
 │                     │          │                     │
 │  Lore daemon        │          │  Lore daemon        │
 │   SurrealDB graph   │          │   SurrealDB graph   │
 │   LanceDB           │          │   LanceDB           │
 │   ↑                 │          │   ↑                 │
 │   IDE / CLI         │          │   IDE / CLI         │
 └──────────┬──────────┘          └──────────┬──────────┘
            │                                │
            │      (over HTTPS, optional)    │
            │                                │
            └───────────┐    ┌───────────────┘
                        ▼    ▼
                   ┌────────────┐
                   │  Dataplane │   ← multi-writer cloud
                   │  (Surreal/ │     (handles concurrency,
                   │   BaaS)    │      permissions, sharing)
                   └────────────┘
```

Each human's daemon owns a local graph. Sharing happens through
Dataplane, which is designed for multi-writer coordination across
processes and hosts (MVCC, transactions, auth scopes, etc.). Lore's
local graph is intentionally **not** designed to be opened by more than
one process at a time — see "The technical decision" below for what
that does and doesn't guarantee.

## Why Local-First

### The product decision

Lore is an institutional-knowledge product. Each person builds their
own understanding of a codebase / domain / project, and shares
selectively. That maps cleanly onto "one graph per person, selective
publish/subscribe to shared namespaces." It does not map onto "one big
graph that everyone writes to at once."

This is the same model as Obsidian, Logseq, and Git: local is
authoritative, sync is collaboration.

### The technical decision

Lore's local storage is SurrealDB (graph) + LanceDB (vectors) + SQLite
(relational). Kùzu was fully removed 2026-08-21 (see
`docs/KUZU_REMOVAL.md`) — a workspace whose `workspaces.json` still
declares `graphEngine: 'kuzu'` throws `KuzuEngineRemovedError` rather than
silently opening an empty store. All three engines here are embedded
databases: one process opens them exclusively.

- **Every embedded store here is single-process-exclusive per
  workspace.** SurrealDB's embedded backends (`surrealkv://` default,
  `rocksdb://` alt) take an exclusive lock on the workspace's on-disk
  directory the moment they're opened; a second process cannot open the
  same store until the first releases it. LanceDB has the identical
  property. Two Lore daemons can never open the same workspace
  concurrently.
- **In-process, SurrealDB supports concurrent write transactions** — Lore
  serializes per node id / per edge triple (`engines/writeQueue.ts`'s
  `KeyedMutex`, wired up in `engines/surrealGraph.ts`) for read-decide-write
  atomicity, not because the substrate demands it. This is looser than
  Kùzu's constraint was: Kùzu (removed 2026-08-21 — see
  `docs/KUZU_REMOVAL.md`) allowed exactly one active write transaction at a
  time process-wide, and required every write to serialize through one
  global queue (`engines/writeQueue.ts`'s `WriteQueue`) because concurrent
  write transactions corrupted native memory and crashed the process. That
  history is why the write-serialization machinery here is split into two
  primitives (`WriteQueue` and `KeyedMutex`) rather than one — `WriteQueue`
  is now dead code kept only because deleting it is out of this doc's
  scope, not because anything still needs process-wide write serialization.

Pointing multiple human users at one daemon would still funnel every
workspace through one process — the exclusive-open constraint above
doesn't go away just because SurrealDB tolerates in-process concurrency.
That one process remains the sole permitted opener of each workspace's
store; it doesn't turn into a multi-host, multi-writer server the way
Dataplane is designed to be. Local-first isn't only a lock-contention
argument — see "The product decision" above.

### What sync preserves

Dataplane sync does **not** re-introduce the lock-contention problem
inside the local daemon:

- Push reads pending WAL entries into memory, ships them over HTTP. No
  graph-engine write lock held across network I/O.
- Pull applies remote nodes/edges per-entry, releasing the write
  lock/slot between each upsert (the `globalWriteQueue` slot on a
  Kùzu-backed workspace, the per-key `KeyedMutex` slot on a
  SurrealDB-backed one). Other MCP calls interleave normally.
- Conflict resolution is last-writer-wins on `updatedAt`, resolved
  per-node during the pull loop. No special lock ceremony.
- Runs every 30 seconds in the background. A user-visible yield during
  a network round-trip (~200ms typical) is the only stall, and that's
  the event loop waiting on the network — not the graph engine waiting
  on itself.

So sync is nonblocking to local reads/writes in any meaningful sense.

## What's Enforced in Code

These things already make it hard to deploy Lore as a shared server:

- **Bind address is `127.0.0.1` only.** Daemon does not listen on
  `0.0.0.0`. No way to reach it from another machine without a
  deliberate tunnel.
- **Bearer token + Host/Origin validation** on every HTTP request.
  Even with a tunnel, requests from unexpected origins are rejected.
- **Auth token lives at `~/.groundfloor/auth.token` with 0600 perms.**
  Not trivially shareable.
- **Rate limiting on expensive endpoints** (search, reconnect,
  delete_node).

(See commits `7326b04` (S1) and `48e03a3` (S3) for the implementation.)

## What's Enforced Socially

Technical enforcement stops where user intent starts. The rest is
documentation and design intent:

- **This file.** Make the intent explicit.
- **`lore setup`** prints a one-line note about the local-first model
  on first run.
- **The `LICENSE`** clarifies per-user deployment (future work; not
  done as of 2026-04-19).

If a user goes out of their way to deploy Lore as a multi-user server
anyway, the product will still mostly work for small read-heavy teams
in the short term. But they're outside the supported path, and at
scale they will hit the single-writer lock on reconnect / large
writes. That's a self-correcting UX signal: the right answer is to
migrate to per-user daemons + Dataplane, and that path is documented.

## What This Means For You

**As a solo user:** you are the design target. Install Lore, use it,
enjoy a local graph that's always fast.

**As a team / family:** wait for Dataplane, or self-host your own
Dataplane-equivalent. Running one daemon for multiple people is not
supported.

**As a contributor:** when you add a feature, ask "would this make
sense in a world where every user has their own daemon?" If the
answer is no, the feature probably belongs in Dataplane, not Lore
core.

## Related Documents

- `docs/architecture.md` — full V2 architecture (engines, MCP tools,
  plugin model).
- `DECISIONS.md` — architectural decisions log, including the Kùzu
  lite-vs-upstream comparison and the sync adapter migration.
- `docs/V2.1_status.md` — ongoing session snapshot, current phase,
  deferred items.
