# DEF Local-First — Architecture Decision

> **Decision (2026-04):** DEF will NOT carry its own persistent
> storage layer. It uses Lore as its memory substrate via MCP, and
> embedded SQLite only for transient runtime state. SurrealDB drops
> from "required" to "optional cloud backend" — parallel to the
> Dataplane in Lore.

## The problem

DEF (Decision-Execution Framework — the agent runtime that pairs with
Lore as Primitive #2) currently requires SurrealDB for memory,
agent-run history, and scheduled-task state. SurrealDB is a fine
production database, but it carries a 100MB-class native binary, a
network port, and an ops surface (auth, schema migrations, backups)
that is incompatible with a "build your second brain locally" product
shape.

The Lore product is **local-first by default, cloud-optional**:

| Component | Local | Cloud (optional) |
|-----------|-------|-------------------|
| Lore graph | Kùzu (embedded)         | Dataplane (Postgres + Qdrant) |
| Lore vectors | LanceDB (embedded)    | Dataplane (Qdrant)            |
| DEF memory | (currently SurrealDB)   | (currently SurrealDB)         |
| DEF agent state | (currently SurrealDB) | (currently SurrealDB)      |

DEF is the only primitive that pulls a native server into the local
install. Either we port it to embedded storage, or we delete its
persistent layer entirely. This document picks the second option.

## The decision — DEF has no persistent storage of its own

DEF moves to a "stateless agent runtime" shape:

1. **All durable knowledge** (decisions, plans, conversation memory)
   stored in Lore via MCP. Lore is already the memory substrate; DEF
   was duplicating it.
2. **All transient runtime state** (in-flight conversation, current
   tool call, intermediate results) lives in **embedded SQLite** —
   single file, no server, no port, no migrations crisis when the
   user upgrades.
3. **Scheduled tasks** persist as Lore nodes (`type: 'scheduled-task'`
   with cron + agent fields), so they survive process restarts via
   Lore, not DEF.
4. **Agent-run history** is a stream of Lore nodes (`type: 'agent-run'`
   with `started_at`, `agent`, `tools_called`, `outcome`). Lore's
   timeline inspector renders them; DEF's UI queries them via MCP.
5. **SurrealDB stays available as the cloud backend** (parallel to
   Dataplane), but is no longer the local default. Cloud-mode users
   get team-shared agent state through SurrealDB; local-mode users
   get the same data from Lore.

### What this trades

We give up:
- DEF-specific schema features (live queries, change streams, native
  RPC) for the local case. These exist for cloud-mode if a workspace
  needs them.
- A separate transactional boundary between DEF and Lore. Now any
  agent-run write goes through `lore.store_node` + an MCP roundtrip
  — slightly slower than a direct DB call but bounded by the same
  IPC the rest of the local stack uses.

We gain:
- Zero new processes / ports / native binaries on local install.
- Single source of truth for memory. No "is this in DEF or Lore?"
  ambiguity.
- The user's Lore graph automatically captures every agent
  conversation as memory — without duplicate ingest pipelines.
- Cloud and local diverge only at the storage tier, not the API
  surface.

### What this does NOT change

- DEF still has its own runtime (model providers, tool calling,
  agent loop). Refactor scope is **storage only**.
- The plugin manifest spec stays as-is. Plugins still contribute
  `def.agents` and `def.scheduledTasks` opaquely; DEF still owns
  the schema for those.
- Lore's `ILorePlugin` boundary stays intact. DEF talks to Lore as
  an MCP client, not by importing Lore's internal types.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Lore Shell (Tauri)                      │
│   Renders inspectors + DEF tabs from one plugin manifest     │
└───────────────────┬────────────────────┬─────────────────────┘
                    │                    │
              IPC (Rust)            IPC (Rust)
                    │                    │
        ┌───────────▼───────┐    ┌───────▼─────────┐
        │   Lore daemon     │    │  DEF runtime    │
        │ (launchd/systemd) │    │ (launchd/sysd)  │
        ├───────────────────┤    ├─────────────────┤
        │  Kùzu (graph)     │    │ SQLite (transient) │
        │  LanceDB (vectors)│    │  ↕ MCP client   │
        └─────┬─────────────┘    └─────┬───────────┘
              │ MCP server               │
              └──────────────────────────┘
                  DEF reads/writes durable data via Lore's MCP
```

Both daemons are sibling launchd services (per
`docs/SHELL_LIFECYCLE.md`). The shell never spawns either; closing
the shell never kills either.

### Concrete data flow

| Action                         | Where it goes |
|--------------------------------|---------------|
| User starts a conversation     | DEF SQLite (transient) |
| Agent calls a tool             | DEF SQLite (in-flight)  |
| Conversation completes         | DEF emits `agent-run` to Lore via `store_node`; SQLite row deleted |
| User schedules a recurring task | DEF emits `scheduled-task` node to Lore; cron loop in DEF reads from Lore |
| User searches "what did we decide about X" | Lore's `recall` returns both human-stored decisions AND past agent-run summaries — same query, same surface |
| User restarts the machine      | DEF SQLite empty (transient OK to lose); Lore data fully restored |

## Migration path for existing DEF users

DEF currently in production at any cloud-mode workspace keeps its
SurrealDB. Migration is **opt-in per workspace**:

1. **Phase 5a (this design)**: lock the decision, write migration
   spec, do not break existing installs.
2. **Phase 5b (DEF project)**: implement the SQLite + MCP client
   path in DEF. Ship behind a `DEF_STORAGE=lore` flag.
3. **Phase 5c (DEF project)**: dual-write phase. New installs default
   to `lore`; existing installs stay on SurrealDB until explicitly
   migrated.
4. **Phase 5d (DEF project)**: migration tool reads SurrealDB →
   replays as Lore nodes via MCP. Idempotent. Workspace owner runs
   it at their convenience.
5. **Phase 5e (DEF project)**: SurrealDB becomes purely cloud-tier;
   local default is `lore`.

## Open questions (handed off to DEF project)

These are intentionally not answered here — the DEF project owns the
implementation:

1. **Conversation framing in Lore** — should each turn be a separate
   node, or each conversation a single node with turns in `content`?
   Recall ergonomics suggest the latter; debugging suggests the
   former. The DEF project should pilot both.
2. **Agent-run pruning** — Lore caps at 20k nodes. If DEF emits one
   `agent-run` per conversation, an active user blows the cap in
   weeks. DEF needs a configurable retention policy (e.g. summarise +
   roll up runs older than 30 days).
3. **Tool-call traces** — currently a SurrealDB live-query feed for
   the DEF UI. Replacement: SQLite tail + (optional) NDJSON file?
   Spec defers to DEF.
4. **Multi-DEF instances** — does the DEF runtime support multiple
   workspaces simultaneously, the way Lore does? Today: yes, via
   SurrealDB tenanting. Tomorrow with SQLite: each workspace gets
   its own SQLite file. Confirm this assumption with the DEF project.

## Decision provenance

This decision was driven by the question "DEF right now does not have
a local version — it requires SurrealDB. Shouldn't we make it work
with Kùzu and LanceDB for local deployment?" The answer turned out to
be neither — DEF doesn't need its own embedded graph because Lore
already is one. Lore knowledge node `def-no-local-storage` records
the decision; this file is its human-readable form.

Related decisions:
- `shell-daemon-lifecycle-sibling-not-child` (`docs/SHELL_LIFECYCLE.md`)
  — both daemons are launchd-managed siblings of the shell. Same
  lifecycle contract applies to DEF.
- `two-primitives-one-shell-architecture` — the bundle-level plugin
  manifest carries both `lore.*` and `def.*` contributions; this
  refactor leaves the manifest spec untouched.

## What's blocked on this

- Phase 6 (DEF integration as shell primitive #2) waits on Phase 5b's
  `DEF_STORAGE=lore` mode landing in DEF. Without it, the shell would
  pull SurrealDB into every install — incompatible with the local-
  first product shape.
- Phase 7 (external reference plugins) does not block on this; those
  plugins can declare `def.*` contributions today, and they'll
  activate once DEF's local-first runtime ships.

## Phase 6 — Shell-side discovery (shipped 2026-04-25)

DEF Phase 5b shipped `DEF_STORAGE=lore`, unblocking shell-side
integration. The Lore shell now treats DEF as **primitive #2**
alongside the Lore daemon:

- New IPC command `discover_def` (Tauri Rust) reads the
  `com.groundfloor.def` launchd job state. Read-only, same contract
  as `discover_daemon` — the shell never starts/stops/signals DEF.
- New "DEF runtime" pill in the status panel renders alongside the
  Lore-daemon and Dataplane pills. States: `running · PID N` (green)
  / `loaded · no PID` (orange) / `not loaded` (grey, with the exact
  `launchctl load` command in the tooltip) / `not installed ·
  optional` (grey-italic — most workspaces don't run DEF) /
  `error` (red).
- Manifest-aware warning: when a loaded plugin manifest declares
  `def.required: true` and the DEF runtime isn't running, the DEF
  contributions section shows a red warning that agents and
  scheduled tasks won't execute.
- **No HTTP probe.** Per this document, DEF is an MCP *client*
  (talks to Lore via Lore's MCP), not an HTTP server — so there's
  no port for the shell to ping. Visibility is launchd state only.
  When DEF eventually exposes a control port the shell can extend
  `DiscoverDefReport` with a health field.

The shell-side architecture mirrors the daemon side (sibling launchd
services, neither shell-spawned, see `docs/SHELL_LIFECYCLE.md`). The
launchd-state lookup in `discovery.rs` was refactored into a
parameterised helper so DEF and Lore share one launchctl-output
parser instead of duplicating it.
