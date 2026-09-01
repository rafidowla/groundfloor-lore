# lore-client

Python client for [Lore Core](../../README.md) — a local-first tri-substrate
(graph + vector + relational) database for AI agent memory.

Lore's storage engines (SurrealDB by default as of v3.13.0, Kùzu
per workspace via `graphEngine: 'kuzu'`, LanceDB, better-sqlite3)
are native Node.js bindings, so this package is **not** an
in-process Python port. It's
two things instead:

1. **`LoreClient`** — a typed (pydantic) wrapper over Lore's REST API
   (`docs/API_REFERENCE.md`).
2. **`LoreSidecar`** — spawns and manages a local `lore serve` daemon as a
   subprocess (isolated data dir, free port, waits for health, fetches an
   auth token), so a Python app doesn't have to separately start/stop a
   service by hand. It's REST-over-a-spawned-process, not true embedding —
   but it gets you the same "just import it and go" ergonomics.

## Install

```bash
cd sdks/python
pip install -e .
# or: uv pip install -e .
```

Requires Python >= 3.9. Runtime deps: `httpx`, `pydantic` (>= 2).

`LoreSidecar` additionally requires, at **run time** (not install time):

- A `groundfloor-lore` checkout with `node_modules` installed (the daemon is
  spawned via `tsx` against the TypeScript source — there's no built/npm-
  published `lore` binary to shell out to yet, see the main repo README).
- **Node 22** on the machine somewhere. Lore's native bindings are built
  against Node 22 and fail `NODE_MODULE_VERSION` checks under Node 20.
  `LoreSidecar` looks for it in this order: `LORE_NODE_BIN` env var → `node`
  on `PATH` if it's already >= 22 → an nvm-managed `v22.x` install under
  `~/.nvm/versions/node/` → `node` on `PATH` as a last resort.

## Quickstart

```python
from lore_client import LoreSidecar

with LoreSidecar(repo_root="/path/to/groundfloor-lore") as sidecar:
    client = sidecar.client

    client.upsert_node(
        id="decision-001",
        type="decision",
        label="Use httpx for the Python SDK",
        workspace="default",
        content="Chosen for first-class async support and a modern API.",
        tags=["architecture", "python-sdk"],
    )

    result = client.recall("what did we decide about the Python HTTP client", workspace="default")
    for hit in result.hits:
        print(hit.id, hit.label, hit.snippet)

# daemon is torn down (whole process group killed, data dir removed) on exit.
```

`repo_root` is auto-discovered by walking up from the current working
directory looking for `packages/lore/src/mcp/server.ts` (or set
`LORE_REPO_ROOT`), so it's often omittable when running from inside a
checkout:

```python
with LoreSidecar() as sidecar:
    ...
```

### Against an already-running daemon

If a `lore serve` daemon is already up (e.g. your own dev daemon, or a
production deployment), skip `LoreSidecar` entirely and talk to it directly.
You'll need a token — either the daemon's bootstrap token, or (preferred for
anything beyond local dev) a workspace-scoped app token minted with
`lore auth issue --workspace <name> --label "<app-name>"` (see the main repo's
`docs/GETTING_STARTED.md` → "Connecting your app"):

```python
from lore_client import LoreClient

client = LoreClient("http://127.0.0.1:3847", token="lore_myworkspace_...")
health = client.health()
```

## What's covered

| Method | REST route |
|---|---|
| `health()` | `GET /health` |
| `health_full()` | `GET /api/health` |
| `upsert_node(...)` | `POST /api/node` |
| `upsert_nodes_bulk(...)` | `POST /api/nodes/bulk` |
| `get_node_full(...)` | `GET /api/node-full` |
| `delete_node(...)` | `DELETE /api/node/:id` |
| `search(...)` | `GET /api/search` |
| `recall(...)` | `GET /api/recall` |
| `list_workspaces()` | `GET /api/workspaces` |
| `create_workspace(...)` | `POST /api/workspaces` |
| `switch_workspace(...)` | `POST /api/workspaces/switch` |
| `LoreClient.fetch_bootstrap_token(...)` | `GET /api/auth/bootstrap` |

That's a deliberately-scoped first pass, not full REST parity — Lore Core
exposes 100+ REST routes (edges, versioning, changesets, schema governance,
sync, ingestion, verbatim, collections, ...; see `docs/API_REFERENCE.md`).
Anything not listed above isn't wrapped yet; call it directly with `httpx`
against the same daemon/token in the meantime.

## A footgun this SDK avoids — and one it doesn't hit in the first place

The main repo's README ("Embedding Lore in your application") calls out a
real gotcha in Lore's **in-process, TypeScript-only** embedded API
(`createLore().nodeUpsert()`): `id` and `ecosystem` must be repeated *both*
at the call's top level *and* inside a nested `nodeData` object, or the write
throws (missing `id`) or silently defaults `ecosystem` to `'*'`.

That specific shape doesn't exist over REST: `POST /api/node`'s body **is**
the node — flat, no `nodeData` wrapper (see
`packages/lore/src/mcp/http/routes/nodes/postNode.ts`, which does
`JSON.parse(body)` straight into the fields it reads). So `upsert_node()`
never had that footgun to work around in the first place. It still takes
`id`/`ecosystem`/etc. as explicit keyword arguments rather than a raw dict,
so you don't have to read the wire format to get the request right, and so
this stays true even if a future Lore release changes the REST body shape
underneath it.

## Real findings from wrapping the live REST surface

Found by actually running this SDK against a real spawned daemon (not just
reading the route source):

- **`GET /api/node-full`'s `metadata` field is a JSON-encoded string, not a
  nested object**, despite reading like one in the route source
  (`metadata: node.metadata ?? null`). `NodeFull.metadata` is typed
  `Optional[str]` here to match the wire reality; `json.loads(...)` it
  yourself if you need the structured value.
- **The bootstrap token is bound to the daemon's boot workspace**
  (`read` + `write` only; no `cross-workspace-*` scopes). Writing to a
  different workspace with it gets `403 workspace_forbidden` — same
  confinement as a workspace-scoped app token (TW-3a). `LoreSidecar`'s
  bootstrap-token client is single-workspace; for multi-workspace use
  from Python, issue and pass a `lore auth issue --workspace <name>`
  app token.
- **Recall's keyword-only fallback is much stricter about phrasing than
  `search()` is.** Right after a write, before the async embedding has
  landed (`vector_index_consulted: false`), `GET /api/recall` runs on
  BM25/keyword matching alone. A single content keyword matches with a
  perfect score, but a natural-language paraphrase with only partial term
  overlap can return **zero** hits for a node that `search()` finds
  instantly with one of its real words. If you call `recall()` immediately
  after `upsert_node()` (rather than waiting for the embedding to land),
  phrase the topic close to the node's actual words, not a paraphrase —
  see the comment in `tests/test_client_live.py` for a reproduced example.

## Known gaps / not done yet

- **No async client.** `LoreClient` is synchronous (`httpx.Client`). `httpx`
  makes an `AsyncLoreClient` twin straightforward to add later; not done in
  this pass.
- **`health_full()` returns a plain `dict`, not a typed model.** `GET
  /api/health`'s snapshot (embedding backend info, per-workspace outbox
  stats, background-reconnect state, ...) is large and evolves often; it
  wasn't worth locking into a pydantic model for a first pass. The other
  ~11 covered endpoints ARE fully typed.
- **REST surface coverage is partial by design** — see the table above.
  Edges, versioning/changesets, schema governance, sync, ingestion,
  verbatim-store, and collections routes aren't wrapped.
- **No cloud/Dataplane mode.** `LoreSidecar` only spawns `deploymentMode:
  'local'` daemons. `LoreClient` itself is transport-agnostic (it's just
  talking REST to a `base_url`), so pointing it at a cloud-mode daemon
  works, but nothing here handles the `X-Lore-Workspace` tenant header
  cloud mode requires.
- **Not published to PyPI.** `pip install -e .` (local/editable) only.
- **`LoreSidecar.switch_workspace()`... don't.** The underlying REST route
  restarts the daemon process; a `LoreSidecar`-managed daemon isn't set up
  to detect and survive that self-restart. Register a workspace and pass
  `workspace=` per-call instead of switching the daemon's active one.

## Tests

```bash
cd sdks/python
pip install -e ".[dev]"
pytest tests/ -v
```

`tests/test_client_live.py` is a real integration test — no mocks. It spawns
an actual daemon via `LoreSidecar` (isolated data dir + free port), stores a
node, reads it back, searches and recalls it, bulk-writes, deletes it, and
tears the daemon down. It needs the same run-time prerequisites as
`LoreSidecar` above (repo checkout with `node_modules`, Node 22 reachable).

## License

[Apache License 2.0](LICENSE) — deliberately more permissive than Lore Core
itself (Elastic License 2.0). The client SDK is Apache-licensed so that any
application talking to Lore over its REST/MCP API has zero license
entanglement with ELv2. The ELv2 hosted-service restriction applies to Lore
Core, not to apps built with this client.
