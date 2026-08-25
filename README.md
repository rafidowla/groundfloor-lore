# Lore

**A knowledge database built for AI agents to operate.** They write to it,
query it, and evolve its schema — under governance you control.

Your agents already forget everything between sessions. The usual fix is a
rules file. Rules files have one fatal property: when a decision changes, the
file holds both the old sentence and the new one, and nothing in it says which
one won.

Lore is a local database that knows.

![A decision is recorded, then overturned. The agent asks the same question and gets only the current answer — with the old one still on record, linked and explained.](docs/demo/supersession.gif)

```bash
node examples/supersession/demo.mjs
```

That is the whole idea, and it runs in about thirty seconds.

## Why not just a rules file?

Three things people use today instead of Lore, and where each one stops:

| What you use now | Where it breaks |
|---|---|
| `CLAUDE.md`, `.cursorrules` | Stale the moment a decision changes. No history, no way to say "this replaced that," no way to ask what was true in March. |
| Vector memory add-ons | Can fetch a fact. Can't count them, can't group them, can't supersede one, can't put a human gate in front of a schema change. |
| Postgres + a vector extension | Works — and now you are your agent's DBA. Every schema change your agent wants is a ticket for you. |

Lore is the database for the layer above your code: decisions, conventions,
bug patterns, architecture notes — the conclusions, not the source. It has no
opinion about what a node means; that is the writing application's job.

## What it does

- **Supersession with history** — declare that one node replaces another, with
  a reason. The old node stays readable and linked, hidden from results by
  default, and one call restores it. Nothing is inferred and nothing is
  deleted.
- **Real queries, not just similarity** — semantic and keyword search, hybrid
  ranking, graph traversal, plus `aggregate` and `time_series` for
  count/sum/group-by and time-bucketed rollups.
- **Governance with human gates** — additive schema changes an agent can
  propose and one person approves; destructive ones are human-proposed and
  need two different human approvers. Append-only audit log per workspace.
  See [Governance](#governance-the-agentic-dba) for what this covers today.
- **Local-first** — works with zero network. Nothing leaves your machine
  unless you turn on sync.
- **Embeddable or standalone** — run it in-process in your own app with no
  daemon and no port, or run it as a server.
- **Schema-agnostic** — model any domain. Code intelligence is an external
  client, not something baked in.

## Install

> **Pre-release.** Lore is not on the npm registry yet and the public source
> repository is not up yet. Both are in flight. Until then this section is
> accurate only if you already have the source tree.

```bash
npm install && npm run build
npm link                     # makes the `lore` command available globally

lore setup      # one-time: graph, daemon, IDE config
cd your-project
lore init       # initialize a workspace for this repo
lore serve      # start the MCP server
```

**Requires Node 22** (pinned in `.nvmrc`) — the native graph bindings are
built against it and will not load under Node 20.

Try the supersession example without setting anything up:

```bash
node examples/supersession/demo.mjs
```

It writes to a throwaway directory and cleans up after itself.

## How an agent connects

Lore is a general-purpose database, and anything that speaks
[MCP](https://modelcontextprotocol.io/) connects to it directly. Your
application brings its own schema and its own conventions; Lore stores what it
writes and answers what it asks. That is the path this repository gives you.

Be clear about what Lore is *not* doing for you: it has no understanding of
your code. It stores the conclusions an application decided were worth keeping,
and it is the application's job to decide what those are.

We run two of our own applications on it — one adding language-aware code
parsing and blast-radius analysis, one tracking project documents and flagging
scope changes. Neither is publicly available; they are mentioned only as
evidence of the kind of weight this database is built to carry.

## Governance (the Agentic DBA)

The thing that makes an agent-operated database safe to actually give to an
agent. Schema changes move through tiers:

| Change | Who proposes | Who approves |
|---|---|---|
| Additive (new nullable field, new type) | Agent or human | One approver; applies immediately |
| Migration / backfill | Human only | One approver |
| Destructive (drop, rename, retype) | Human only | **Two different humans** |

Destructive changes run **expand → migrate → contract**. Expand and migrate
are reversible; contract is the one-way door, and a data snapshot is taken
before the schema flips so the rows are recoverable. Every decision lands in
an append-only audit log. Self-approval is blocked — the second approver must
be a genuinely different identity.

All of this is in the source-available build. None of it is held back.

**Current limits, stated plainly:**

- Destructive approvals need **daemon mode**. In embedded mode they are
  refused up front, pointing you at `lore serve --http`, rather than queuing
  behind a confirmation step an embedded host cannot reach.

## Embedding Lore in your application

```ts
import { createLore, type NodeWriteResult } from '@groundfloor/lore';

// In-process instance — isolated data dir, no daemon, no port.
const lore = await createLore({
  deploymentMode: 'embedded',
  dataDir: '/path/to/my-data-home', // optional; defaults to ~/.groundfloor
});

const result: NodeWriteResult = await lore.nodeUpsert({
  id: 'decision-001',
  workspace: 'default',
  ecosystem: 'my-project',
  nodeData: {
    type: 'decision',
    label: 'Adopt embedded Lore',
    content: 'Chosen for zero-network, in-process recall.',
    tags: ['architecture'],
  },
  asyncEmbed: true, // embed in background; set false for synchronous
});
if (result.ok) console.log('stored:', result.node.id);

// Hybrid recall — semantic + keyword + graph traversal in one call.
const found = await lore.recall('why did we choose embedded Lore?', {
  workspace: 'default',
  ecosystem: 'my-project',
  mode: 'full',
});

// Tear down cleanly — no process.exit required.
await lore.dispose();
```

Since 3.15.0 the top-level `id` and `ecosystem` are merged into `nodeData` for
you. Supplying them in both places still works, but a *disagreeing* pair is
now refused outright instead of splitting the write across substrates.

### Three deployment modes

| Mode | How to select | What runs |
|---|---|---|
| `'embedded'` | `createLore({ deploymentMode: 'embedded' })` | In-process only; no daemon, no port. |
| `'local'` | `createLore()` or `LORE_DEPLOYMENT_MODE=local` | Daemon (stdio or `--http`), SurrealDB (default) or Kùzu + LanceDB. |
| `'cloud'` | `createLore({ deploymentMode: 'cloud' })` | Daemon routing through Dataplane, our optional hosted multi-tenant backend. Not required to use Lore, and not part of this release. |

### Embedded-mode contracts

- No port is bound. No `SIGINT`/`SIGTERM` handlers are registered.
- No process-global `uncaughtException`/`unhandledRejection` handlers are
  installed — the host's error handling is untouched.
- Two instances with different `dataDir` values are fully isolated on disk.
- `dispose()` runs an ordered graceful-shutdown drain without calling
  `process.exit`. The host owns the process lifecycle.
- Outbox replication (embedding / semantic recall) runs **in-process** — no
  background daemon is needed for `recall` to find your nodes.

See [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md#embedded-mode-library--in-process) and
[docs/API_REFERENCE.md](docs/API_REFERENCE.md#embedded-mode-in-process-api)
for the full API surface and configuration options.

---

## Beyond engineering

Lore is schema-agnostic, so the same store works for any domain an app wants
to persist — not just code. Two more examples, same API, different data:

**Family memory** — small details that are easy to lose track of between
occasional catch-ups.

![An assistant remembers a family update from three weeks earlier](docs/demo/scene2.gif)

**Shared support context** — one agent's notes on a ticket, available to
whoever picks it up next.

![A support agent recalls a colleague's note from the day before](docs/demo/scene3.gif)

---

## Deployment model

**One daemon per human.** Lore is local-first: install on your own machine,
use it there. For teams, each person runs their own daemon and shares
knowledge via sync (self-hosted, or our optional hosted Dataplane). Do not run
one Lore daemon for multiple people on the same machine — it is not supported
and will hit the single-writer lock at scale.

See [docs/DEPLOYMENT_MODEL.md](docs/DEPLOYMENT_MODEL.md) for the design
rationale.

## Architecture

Three substrates, all first-class:

- **Graph** — embedded [SurrealDB](https://surrealdb.com/). Kùzu was fully
  removed 2026-08-21 (see [docs/KUZU_REMOVAL.md](docs/KUZU_REMOVAL.md)).
  Nodes, edges, traversal.
- **Vector** — embedded [LanceDB](https://lancedb.com/). Embeddings for
  semantic recall, generated locally with no API key and no network.
- **Relational** — SQLite. Outbox, migrations, audit log, auth.

```
┌──────────────┐     ┌──────────────┐     ┌─────────────────────────┐
│ Your app or  │────▶│  MCP Server  │────▶│  SurrealDB (default)    │
│  AI agent    │     │              │     │  + LanceDB + SQLite     │
│  (over MCP)  │     │              │     │  (.lore/, local)        │
└──────────────┘     └──────────────┘     └────────────┬────────────┘
                                                       │ sync (optional)
                                                 ┌─────▼───────┐
                                                 │  Remote DB  │
                                                 │  (optional) │
                                                 └─────────────┘
```

Writes are durable before they are acknowledged. The graph write applies
synchronously, so an exact-match read is immediately consistent; embedding for
semantic search catches up in the background, or synchronously if you ask for
it (`asyncEmbed: false`).

See [docs/architecture.md](docs/architecture.md) for full details.

## Capacity maintenance (`lore maintain`)

A Lore store grows unbounded if left alone: LanceDB is append-only/versioned,
so stale versions accumulate and the on-disk footprint balloons. `maintain` is
a first-class, **config-driven** capacity capability every Lore app inherits.
It runs four independently-toggleable operations:

| Operation | What it does |
|-----------|--------------|
| **LanceDB compaction** | Optimizes/compacts fragments per table once a table crosses the fragment threshold. |
| **LanceDB version cleanup** | Prunes versions older than the cutoff — the big disk win on a ballooned store. |
| **Node retention** | Archives (or deletes) cold nodes older than N days, except nodes carrying protected tags. |
| **Ephemeral workspace expiry** | Deletes workspaces matching an ephemeral pattern (e.g. `e2e-*`) older than a TTL. The active and bootstrap workspaces are never touched. |

### Surfaces

- **CLI:** `lore maintain [<workspace>] [--dry-run] [--all] [flags]` — offline tool;
  refuses while the daemon is up (a second writer risks corruption).
- **MCP tool:** `maintain` — runs *inside* the daemon, so it is **online-safe**.
  Defaults to `dry_run=true`; pass `dry_run=false` to apply.
- **Programmatic:** access through `lore.store.storageClient` on a `LoreInstance`
  returned by `createLore()`. The maintenance surface is CLI/MCP-only and is not
  part of the embeddable library API exported from `'@groundfloor/lore'`.

`--dry-run` reports only (counts, reclaimable bytes, workspaces/nodes affected)
and performs **zero** writes. A live run prints a before/after summary. Runs are
idempotent — safe to wire into a nightly cron.

```bash
# Preview the reclaimable disk on the active workspace:
lore maintain --dry-run

# Nightly cron: prune versions older than 3 days across every workspace:
lore maintain --all --cleanup-versions-older-than 3d
```

See [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) for the full
policy-knob reference (retention windows, ephemeral patterns, cold-signal
selection, and more).

## Scale

Validated at roughly 50,000 nodes on a single machine. Larger corpora have not
been measured, and we would rather say so than round up. Single-node locally;
multi-tenant scale-out lives in the hosted Dataplane, which is not part of
this release.

Backup, restore, and per-workspace migration between graph engines all have
first-class CLI commands.

## Development

**Requires Node 22** (`.nvmrc` pins this).

```bash
npm install
npm run build     # compile TypeScript → dist/
npm run start     # run the compiled daemon (requires build first)
npm run cli       # run the CLI (tsx, no build needed)
npm test          # full test suite
```

## Contributing

Issues and PRs welcome. This is an active, daily-driven project — expect
frequent releases. Development is currently solo, with commits landing on
`main`; a formal PR workflow starts when more people are working on it. See
[CHANGELOG.md](CHANGELOG.md) for what's shipped recently.

## Credits

This project builds on the work of several open-source projects:

| Project | Author / Maintainer | License | Role |
| [Kùzu](https://kuzudb.com/) | Kùzu Inc. (Semih Salihoğlu et al.) | MIT | Embedded graph database — the original local engine through v3.x; fully removed 2026-08-21 in favor of SurrealDB (see [docs/KUZU_REMOVAL.md](docs/KUZU_REMOVAL.md)) |
| [SurrealDB](https://surrealdb.com/) | SurrealDB Ltd. | BSL 1.1 | Embedded graph database (default local engine). BSL permits embedding SurrealDB in a product; it does not permit offering SurrealDB itself as a hosted service — Lore does not do the latter. |
| [LanceDB](https://lancedb.com/) | LanceDB Inc. | Apache 2.0 | Embedded vector store for semantic recall |
| [Model Context Protocol](https://modelcontextprotocol.io/) | Anthropic | MIT | Protocol standard for AI tool integration |
| [TypeScript](https://www.typescriptlang.org/) | Microsoft | Apache 2.0 | Language runtime |
| [tsx](https://github.com/privatenumber/tsx) | Hiroki Osame | MIT | TypeScript execution engine |

## License

[Elastic License 2.0](LICENSE).
