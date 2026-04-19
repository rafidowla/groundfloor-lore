# Deployment Model

> Last updated: 2026-04-19
>
> This is a design-intent document. Read this before deploying Lore in any
> form more ambitious than "install on my laptop."

## TL;DR

**One Lore daemon per human.** Install Lore on your own machine. If you
want to share knowledge with a family, team, or organization, each
person runs their own local daemon and they sync to each other via
Dataplane (Lore's cloud layer).

Do not run one Lore daemon for multiple people.

## The Architecture

```
 ┌─────────────────────┐          ┌─────────────────────┐
 │  Alice's machine    │          │  Bob's machine      │
 │                     │          │                     │
 │  Lore daemon        │          │  Lore daemon        │
 │   Kùzu graph        │          │   Kùzu graph        │
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
Dataplane, which is designed for multi-writer coordination (MVCC,
transactions, auth scopes, etc.). Lore's local graph is intentionally
**not** designed for concurrent writers.

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

Lore's local storage is Kùzu (graph) + LanceDB (vectors). Both are
embedded databases: one process opens them exclusively.

- **Kùzu enforces a single writer at a time.** Two processes cannot
  write the same Kùzu database simultaneously. There is no "Kùzu full"
  or "Kùzu enterprise" that lifts this — both the `@kineviz/kuzu-lite`
  package and upstream `kuzu` at v0.11.3 are the same engine with the
  same constraint (verified by smoke test on 2026-04-19; see decision
  node `decision-kuzu-lite-vs-upstream-2026-04-19`).
- **LanceDB is also embedded**, with similar single-writer semantics.

Pointing multiple human users at one daemon would serialize all their
writes through one process, creating exactly the lock-contention
problem that local-first avoids.

### What sync preserves

Dataplane sync does **not** re-introduce the lock-contention problem
inside the local daemon:

- Push reads pending WAL entries into memory, ships them over HTTP.
  No Kùzu lock held across network I/O.
- Pull applies remote nodes/edges per-entry, releasing the Kùzu lock
  between each upsert. Other MCP calls interleave normally.
- Conflict resolution is last-writer-wins on `updatedAt`, resolved
  per-node during the pull loop. No special lock ceremony.
- Runs every 30 seconds in the background. A user-visible yield
  during a network round-trip (~200ms typical) is the only stall, and
  that's the event loop waiting on the network — not Kùzu waiting on
  itself.

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
