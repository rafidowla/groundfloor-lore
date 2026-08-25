# Getting Started with Groundfloor Lore

> A knowledge database for Agentic AI — local-first memory for every AI tool you use, in any domain.

## Quick Start (Solo Developer)

```bash
npm install -g @groundfloor/lore
lore setup
```

That's it. `lore setup` will:
- Initialize the local graph (SurrealDB by default; Kùzu remains supported
  per workspace via `graphEngine: 'kuzu'`) under `~/.groundfloor/.lore/`
- Install and start the Lore daemon (background service on port 3847)
- Detect your IDE (Cursor, Antigravity, Claude Code) and configure MCP automatically

### Verify

```bash
lore status                 # Graph stats
lore doctor                 # Health check
curl http://127.0.0.1:3847/health   # Daemon health
```

---

## Architecture

Lore Core is a schema-agnostic knowledge database over **three local
substrates**, fronted by a single daemon. There is no "code graph" inside
Core — code intelligence is the external Atlas client, and team sync is the
hosted Dataplane.

```
┌──────────────────────────────────────────────────────────────┐
│  Lore Daemon (port 3847)                                     │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌────────────┐ │
│  │  Graph    │  │  Vector   │  │ Relational│  │   Sync     │ │
│  │(SurrealDB/│  │ (LanceDB) │  │  (SQLite) │  │  Engine →  │ │
│  │  Kùzu)    │  │ embeddings│  │ outbox,   │  │  Dataplane │ │
│  │ nodes+    │  │ + recall  │  │ migrations│  │ (TS-SDK)   │ │
│  │ edges     │  │           │  │ audit,auth│  │            │ │
│  └───────────┘  └───────────┘  └───────────┘  └────────────┘ │
│        └──────── LoreStorageClient (facade) ────────┘        │
└───────┬───────────────┬──────────────────────────────────────┘
        │               │           │            ▲
   ┌────┴────┐    ┌─────┴─────┐  ┌──┴──────┐  ┌──────┴──────┐
   │ Cursor  │    │Antigravity│  │  Claude │  │   Atlas     │
   │  (MCP)  │    │   (MCP)   │  │  Code   │  │ (code intel,│
   └─────────┘    └───────────┘  │  (MCP)  │  │  ext client)│
                                 └─────────┘  └─────────────┘
```

- **Three substrates:** SurrealDB (graph: nodes + edges + traversal — Kùzu
  was fully removed 2026-08-21, see `docs/KUZU_REMOVAL.md`), LanceDB
  (vector: embeddings for semantic recall), SQLite (relational: outbox,
  migrations, audit, auth, plus tabular collections + SQL aggregates). All
  writes go through `LoreStorageClient`.
- **Local-first:** Works fully offline. No network needed for solo use.
- **Optional sync:** The Sync Engine pushes/pulls team-shared knowledge to a
  hosted **Dataplane** via `groundfloor-ts-sdk`, buffered through a local WAL.
- **One daemon:** All IDEs share a single process — no file lock conflicts.
- **Code intelligence is external:** symbols, call chains, and blast radius
  live in the **Atlas** client, which talks to Lore over the public REST/MCP
  API — not in Core.

---

## CLI Reference

| Command | Description |
|---------|-------------|
| `lore setup` | One-time setup (graph, daemon, IDE config) |
| `lore serve --http` | Start MCP daemon (managed by LaunchAgent) |
| `lore init` | Initialize graph only (low-level) |
| `lore status` | Show graph stats and sync status |
| `lore sync` | Manual push/pull |
| `lore doctor` | Diagnose issues |
| `lore backup` | Back up the active workspace |
| `lore restore` | Restore a workspace from backup |
| `lore migrate` | Run one-off data migrations |
| `lore maintain` | Config-driven capacity maintenance (compaction, retention, expiry) |

---

## Connecting your app (issue a workspace-scoped token)

`lore setup` configures your own IDE automatically. But when a **separate
app** (Atlas, Groundfloor Atlas, Mira-local, or any other client) needs to talk to
your local daemon, do NOT hand it the bootstrap token
(`<LORE_HOME>/auth.token`, also called the "god token" below). Issue that
app its own **workspace-scoped token** instead. This section is the
step-by-step for that.

### Why not the bootstrap token

The bootstrap token is the 64-char hex string the daemon mints for itself at
`<LORE_HOME>/auth.token` (default `~/.groundfloor/auth.token`). Any request
bearing it resolves to a `kind: 'bootstrap'` principal, which the daemon's
workspace-confinement gate treats as a **daemon operator** — equivalent to
an admin, free to read and write **every workspace**, run workspace CRUD,
and touch daemon-wide control operations. That's the right shape for the
one human operating their own daemon. It is the **wrong** shape for an app
integration: if you paste the bootstrap token into Atlas's or Groundfloor Atlas's
config, that app can now read and write every other app's workspace on the
same machine — silently defeating the per-workspace isolation the daemon
otherwise enforces. There is no scope on the bootstrap token to take away;
it is all-or-nothing by construction.

A **workspace-scoped app token** (`lore_<workspace>_<random>`), by contrast,
is confined to exactly the workspace it was issued for (plus whatever
scopes you explicitly grant) and is rejected with `403 workspace_forbidden`
if it ever tries to touch a different workspace. Use one app token per
connected app.

### Step 1 — make sure the target workspace exists

```bash
lore workspaces list
```

If the app needs a workspace that doesn't exist yet, create it first (see
`lore workspaces --help`); `lore auth issue` refuses to mint a token for an
unregistered workspace name.

### Step 2 — issue the token

```bash
lore auth issue --workspace <name> --label "<app-name>" --scopes read,write
```

- `--workspace <name>` (required) — the workspace this token, and only this
  token, will be confined to.
- `--label <text>` — a free-text name so `lore auth list` shows which app
  this token belongs to (e.g. `"atlas-ide"`, `"lorebase-prod"`). Required
  for long-lived tokens; optional (defaults to `ephemeral:<workspace>`) if
  you also pass `--ephemeral` / `--ttl`.
- `--scopes <csv>` — defaults to `read,write` if omitted. Available scopes:
  `read`, `write`, `cross-workspace-read`, `cross-workspace-write`. Grant
  the minimum an integration needs — most single-workspace apps need only
  the default `read,write`. Only add `cross-workspace-read` /
  `cross-workspace-write` if the app genuinely has to aggregate or mutate
  across multiple workspaces; those scopes must be requested explicitly and
  are never granted implicitly.
- `--ephemeral` / `--ttl <duration>` — optional, for short-lived tokens
  (perf runs, scratch integrations). `--ttl` accepts `<n><unit>` with unit
  `s|m|h|d` (e.g. `30m`, `2h`); omitting `--ttl` but passing `--ephemeral`
  defaults to a 1h TTL. Expired tokens are rejected with `401
  token_expired` and swept from the registry automatically.
- `--admin` — operator-recovery only (auto-adds
  `cross-workspace-read`+`cross-workspace-write`). Do not use this for a
  normal app integration; it recreates the same cross-workspace exposure
  this section is warning you away from.
- `--json` — machine-readable output, useful for scripting the handoff.

Example:

```bash
$ lore auth issue --workspace atlas-dev --label "atlas-ide" --scopes read,write
Token issued. Display this ONCE — the daemon does not store the plaintext:

  lore_atlas-dev_C7f...   (43-char base64url secret)

label:     atlas-ide
workspace: atlas-dev
scopes:    read, write
prefix:    lore_atlas-d  (for `lore auth revoke <prefix>`)
```

The plaintext is printed **exactly once**. The daemon never stores it —
only its SHA-256 hash goes into `<LORE_HOME>/auth/registry.json`. If you
lose it, revoke the prefix and issue a new one; there is no recovery.

### Step 3 — hand the token to the app (never the bootstrap token)

Give the app the **`lore_<workspace>_...`** string from Step 2 — as an
environment variable, secret store entry, or config field, whatever that
app's setup expects. The app should present it the same way every other
Lore client does: an `Authorization: Bearer <token>` header on its HTTP
requests to the daemon (default `http://127.0.0.1:3847`).

```bash
curl -s http://127.0.0.1:3847/api/recall?topic=test \
  -H "Authorization: Bearer lore_atlas-dev_C7f..."
```

Never put the bootstrap token (`<LORE_HOME>/auth.token`) in an app's
config. That file is for the daemon's own operator tooling (the CLI reading
it directly off disk, the local UI's one-time bootstrap fetch) — not for
integrations.

### Step 4 — verify it works, and verify it's confined

**It works:**

```bash
curl -s "http://127.0.0.1:3847/api/recall?topic=test&workspace=<name>" \
  -H "Authorization: Bearer <the-app-token>"
```

A `200` with a recall result (even `"hits": 0`) means the token
authenticated and can read its workspace. `/health` (no auth required) only
tells you the daemon is up — it does **not** prove the token works, so use
`/api/recall` (or another `/api/*` route) for this check.

**It's confined:** repeat the same call against a *different* workspace
name — one this token was not issued for:

```bash
curl -s "http://127.0.0.1:3847/api/recall?topic=test&workspace=<a-different-workspace>" \
  -H "Authorization: Bearer <the-app-token>"
```

This must come back `403` with
`{"code":"workspace_forbidden", ...}` (or `scope_missing` /
`workspace_forbidden` depending on which gate rejects first). If it
instead returns `200`, the token was minted with `cross-workspace-read` /
`cross-workspace-write` (or you accidentally handed the app the bootstrap
token) — stop and re-check which token you gave the app.

### Managing tokens afterward

```bash
lore auth list              # every issued token: label, workspace, scopes, status
lore auth revoke <prefix>   # revoke by the prefix shown in `lore auth list` / issue output
```

Revoking is immediate — the next request bearing that token fails auth.
There is no way to "update" a token's scopes in place; revoke and re-issue.

---

## Embedded mode (library / in-process)

Lore can run entirely in-process — no daemon process, no port, no
process-global handlers. This is the right choice for tests, serverless
functions, CLIs, or any host that wants zero network overhead.

### Install

```bash
npm install @groundfloor/lore
```

> **Note on the SDK dependency:** the package currently requires the sibling
> `groundfloor-ts-sdk` repo to be present on the same machine. Publishing to
> a registry is tracked as TW-1b / SW-10 (parked pending SDK team release).

### Quick start

```ts
import { createLore, type NodeWriteResult } from '@groundfloor/lore';

// Allocate an isolated in-process Lore instance.
const lore = await createLore({
  deploymentMode: 'embedded', // in-process; no daemon, no port
  dataDir: '/tmp/my-lore-data', // optional; isolates this instance on disk
});

// Write a node — same orchestration as MCP store_node / POST /api/node.
const result: NodeWriteResult = await lore.nodeUpsert({
  id: 'decision-001',
  workspace: 'default',
  ecosystem: 'my-project',
  nodeData: {
    // id and ecosystem must be repeated here — the graph write reads only
    // nodeData, so the top-level id/ecosystem above are bookkeeping only.
    id: 'decision-001',
    ecosystem: 'my-project',
    type: 'decision',
    label: 'Use embedded Lore',
    content: 'Chosen for zero-network, in-process recall.',
    tags: ['architecture'],
  },
  asyncEmbed: true, // embed in background (non-blocking); false = synchronous
});
if (result.ok) {
  console.log('stored:', result.node.id);
}

// Read back nodes via the storage-client facade.
const node = await lore.store.storageClient.getNode('decision-001');
const hits = await lore.store.storageClient.search(
  'architecture decision',
  5,      // limit
  'default',
  'my-project',
);

// Tear down cleanly — no process.exit required.
await lore.dispose();
```

### Embedding two isolated instances in one process

```ts
import { createLore } from '@groundfloor/lore';

const loreA = await createLore({ deploymentMode: 'embedded', dataDir: '/data/a' });
const loreB = await createLore({ deploymentMode: 'embedded', dataDir: '/data/b' });

// Writes to A are not visible in B and vice versa — fully isolated on disk.
await loreA.nodeUpsert({ id: 'x', workspace: 'default', ecosystem: 'proj',
                         nodeData: { id: 'x', ecosystem: 'proj', type: 'note',
                                     label: 'A-only node', content: '' } });

await loreA.dispose();
await loreB.dispose();
```

### Embedded-mode contracts

| Guarantee | Detail |
|---|---|
| No port | `createLore({ deploymentMode: 'embedded' })` binds no TCP socket. |
| No process handlers | No `SIGINT`/`SIGTERM`, `uncaughtException`, or `unhandledRejection` listeners are installed on the host process. |
| Isolated data | Two instances with different `dataDir` values have fully separate on-disk graphs (SurrealDB or Kùzu + LanceDB). |
| Clean dispose | `dispose()` drains the outbox, closes all handles, and returns. It never calls `process.exit`. |
| In-process replication | Outbox replication (embedding / semantic recall) runs in-process — no background daemon is needed for `search`/`recall` to find newly written nodes. |

### Deployment mode comparison

| `deploymentMode` | Substrates | Transport | Typical use |
|---|---|---|---|
| `'embedded'` | SurrealDB or Kùzu + LanceDB (local) | None (in-process) | Library / test / serverless |
| `'local'` | SurrealDB or Kùzu + LanceDB (local) | stdio or HTTP daemon | Single-user IDE / desktop |
| `'cloud'` | Dataplane (remote) | HTTP daemon | Multi-tenant cloud |

See [docs/API_REFERENCE.md](API_REFERENCE.md#embedded-mode-in-process-api) for
the full `createLore` / `LoreInstance` surface and
[docs/CONFIGURATION.md](CONFIGURATION.md#15-embedded-mode) for configuration
options.

---

## Troubleshooting

### Daemon not running
```bash
curl http://127.0.0.1:3847/health
# If it fails:
launchctl list | grep groundfloor.lore
launchctl load ~/Library/LaunchAgents/com.groundfloor.lore.plist
```

### IDE not connecting
Check your MCP config points to the daemon. Each IDE uses a different schema:

**Cursor** (`~/.cursor/mcp.json`):
```json
{
  "groundfloor-lore": {
    "type": "http",
    "url": "http://127.0.0.1:3847/mcp"
  }
}
```

**Antigravity** (`~/.gemini/antigravity/mcp_config.json`):
```json
{
  "groundfloor-lore": {
    "serverUrl": "http://127.0.0.1:3847/mcp"
  }
}
```

**Claude Code** (`~/.claude/settings.json`, under the `mcpServers` key):
```json
{
  "mcpServers": {
    "groundfloor-lore": {
      "type": "http",
      "url": "http://127.0.0.1:3847/mcp"
    }
  }
}
```

> **Note:** Cursor and Claude Code use `type: "http"` + `url`; Antigravity uses `serverUrl` (no `type` field).
> Run `lore setup` to auto-configure all detected IDEs.
> Or register Claude Code manually: `lore init --mcp claude-code`

### Graph locked / schema error
Stop all Lore processes, then restart the daemon:
```bash
launchctl unload ~/Library/LaunchAgents/com.groundfloor.lore.plist
launchctl load ~/Library/LaunchAgents/com.groundfloor.lore.plist
```
