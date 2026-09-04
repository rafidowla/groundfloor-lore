# Operations

How to run, observe, and maintain the Lore daemon in day-to-day operation.
This is the ops counterpart to [`BACKUP_RESTORE.md`](./BACKUP_RESTORE.md) (disaster
recovery) and [`UPGRADE.md`](./UPGRADE.md) (version upgrades + schema migration).

Everything documented here reflects the CLI and HTTP surface as it exists in the
codebase (`packages/lore/src/cli/`, `packages/lore/src/mcp/`). Where a capability
is partial or local-only, it is called out explicitly.

---

## Running the daemon

Lore ships a single binary, `lore`, with two serve modes:

```bash
lore serve            # stdio MCP server (one client, one process)
lore serve --http     # HTTP daemon — multiple IDEs share one process
```

- **stdio mode** (`lore serve`) speaks the MCP protocol over stdin/stdout. This is
  the mode an IDE launches directly when it owns the process lifecycle.
- **HTTP daemon mode** (`lore serve --http`) starts a long-lived Streamable-HTTP
  server so several clients can share one daemon (and one set of open graph
  handles — SurrealDB, the only graph engine — plus LanceDB handles — the
  single-writer constraint makes this the recommended mode for any
  multi-client setup).

### Port

The HTTP daemon listens on **port 3847** by default. Override with the `LORE_PORT`
environment variable:

```bash
LORE_PORT=4000 lore serve --http
```

(Source of truth: `LORE_HTTP_PORT = parseInt(process.env['LORE_PORT'] ?? '3847', 10)`
in `mcp/server.ts`.)

### Deployment mode

`lore` runs in `local` mode by default. Force the mode with the top-level
`--mode` flag or the `LORE_DEPLOYMENT_MODE` env var (CLI > env > config > default):

```bash
lore --mode=cloud serve --http
```

The effective mode is surfaced on `/api/health` as `deploymentMode`.

---

## Health checks

The HTTP daemon exposes two health endpoints (both registered in
`mcp/http/routes/diagnostic.ts`):

### `GET /health` — liveness probe (unauthenticated, no graph touch)

A minimal, cheap probe that never opens the graph. Use this for load-balancer /
container liveness checks.

```bash
curl -s http://localhost:3847/health
```

Returns:

```json
{
  "status": "ok",
  "version": "3.11.0",
  "sessions": 0,
  "backgroundReconnect": { ... },
  "embeddingBackend": "..."
}
```

### `GET /api/health` — full daemon health snapshot (anonymous gets the lite body)

No Bearer token is *required* to reach this endpoint (it's on the same
public-path allowlist as `/health`, so uptime monitors keep working
token-free) — but the body you get back depends on whether you sent one:

- **Anonymous request (no Bearer, or an invalid one):** you get back exactly
  the `/health` lite body above — `status`, `version`, `sessions`,
  `backgroundReconnect`, `embeddingBackend`. Nothing per-workspace, no
  `loreHome`, no rate-limit config.
- **Bearer-authenticated request (a valid session or app token):** you get
  the full snapshot — *status, not data*, but rich enough to spot drift:
  - `status` — `ok` or `orphan_decision_required`
  - `version`, `deploymentMode`, `loreHome`
  - `workspace` (active) plus a `workspaces` block with **per-workspace**
    node/edge counts and `globalTotals` (the "never silent again" rule:
    per-workspace and global counts are never collapsed into one ambiguous
    number)
  - `outbox` — aggregate `depth`, `lagSeconds`, `dead`, and `perWorkspace`
  - `perWorkspaceOutbox` — per-workspace lag/depth vs. backpressure
    threshold, with `overThreshold` flags
  - `dataplane` state, `rateLimit` snapshot, `embeddingBackend`

This split (2026-09-03) closed a local-privilege-escalation gap: the full
body used to be served to *any* local process with no token, leaking
per-workspace node/edge counts, the daemon's data directory, and the live
rate-limit configuration. The arcade-mode boot (`mcp/arcadeBoot.ts`) applies
the same split to its own `/health`/`/api/health` — anonymous gets
`{status, version, mode}`; an authenticated operator additionally gets
`arcadeBaseUrl` and the rate-limiter snapshot.

```bash
curl -s http://localhost:3847/api/health | jq .                              # lite body
curl -s -H "Authorization: Bearer $(cat ~/.groundfloor/auth.token)" \
     http://localhost:3847/api/health | jq .                                 # full snapshot
```

`lore doctor` (below) probes `/api/health` internally to decide whether the daemon
is up, so a healthy `doctor` run implies a reachable health endpoint; it now
authenticates that probe with the local `auth.token` when one is already on
disk at the guessed `LORE_HOME`, so its daemon-reported `loreHome` detection
keeps working, and silently falls back to the env-derived path otherwise.

This local anonymous/Bearer split is a local-mode-only decision. What a
cloud/remote deployment's health endpoint should expose to an unauthenticated
caller (there is no "local process" trust boundary to lean on there) is a
separate, not-yet-designed follow-up — out of scope here.

---

## Metrics (`/metrics`, Prometheus)

The daemon can expose a Prometheus exposition endpoint at `GET /metrics`
(`mcp/http/routes/metrics.ts`).

**It is gated behind `LORE_METRICS` and disabled by default.** With the flag off,
`/metrics` returns `404 metrics_not_enabled`. Enable it by setting one of
`on` / `1` / `true`:

```bash
LORE_METRICS=on lore serve --http
```

Then scrape:

```bash
curl -s http://localhost:3847/metrics
```

Metrics exposed (Prometheus text format, `version=0.0.4`):

| Metric | Description |
| --- | --- |
| `lore_build_info{version}` | Daemon build metadata |
| `lore_outbox_depth{workspace}` | Pending outbox entries per workspace |
| `lore_outbox_lag_seconds{workspace}` | Age of oldest pending entry per workspace |
| `lore_outbox_dead{workspace}` | Entries past retry budget per workspace |
| `lore_outbox_depth_total` | Aggregate pending depth |
| `lore_outbox_lag_seconds_max` | Worst lag across workspaces |
| `lore_workspace_nodes{workspace}` | Node count per workspace |
| `lore_workspace_edges{workspace}` | Edge count per workspace |
| `lore_load_jobs_total{state}` | Load jobs by state |
| `lore_embed_queue_depth` | Pending embedding compute jobs |
| `lore_replicator_tick_total` | Replicator ticks since boot |
| `lore_otel_enabled` | `1` if an OTel OTLP endpoint is configured |
| `lore_otel_spans_started_total` / `lore_otel_spans_ended_total` | Provision-span counters |

Per-workspace node/edge counts are cached for 5s to avoid hammering the graph
engine (SurrealDB, the only graph engine) on every scrape (default Prometheus
scrape intervals are 10–15s). Outbox stats are read fresh on each scrape.

> Caveat: this is the local provision of the metrics surface. The endpoint is
> wired and functional, but the concrete Prometheus scrape stack (alerting rules,
> Grafana dashboards) is a cloud-activation concern and is not shipped in this repo.

### OpenTelemetry

If `LORE_OTEL_EXPORTER_OTLP_ENDPOINT` is set, `lore_otel_enabled` reports `1` and
provision spans are counted. OTel readiness is also reflected in `/metrics`.

---

## Logs

Lore writes operational events to stdout/stderr and to a daemon-wide audit log.

- **stdout/stderr** — boot output, per-request diagnostics, and migration /
  maintenance summaries. When you run the daemon under a process supervisor
  (`launchd`, `systemd`, Docker), capture these streams.
- **`<LORE_HOME>/audit.jsonl`** — a daemon-wide append-only audit trail
  (`LORE_HOME` defaults to `~/.groundfloor/`). This is one of the daemon-wide
  state files alongside `workspaces.json` and `auth.token`.

There is no log-rotation knob inside Lore today; rotate `audit.jsonl` with your
platform's logrotate equivalent if it grows large.

---

## `lore status`

Shows graph statistics and sync status for the active workspace's `.lore/`:

```bash
lore status
```

Reports node/edge counts (via `LocalGraph.getStats()`), the resolved project /
ecosystem mapping (if a workspace registry entry matches the path), and sync
status. Exits non-zero with a hint if no `.lore/` directory exists (run
`lore init` first).

The on-disk graph store is single-writer, and `status` opens it directly (it
has no HTTP path to a daemon the way `doctor` does). Before opening, it probes
for a running daemon the same LORE_PORT-aware way `doctor` does; if one is
reachable, `status` refuses immediately with "store is held by a running Lore
process — set LORE_PORT to reach it, or stop it and retry" rather than
colliding with the daemon's lock ("`lore doctor` can read basic graph counts
through the daemon over HTTP if it has an auth token" is suggested as the
alternative). If no daemon answers `LORE_PORT` but something else still holds
the store, `status` reports the same message and fails fast rather than
sitting through the full multi-second lock-retry budget.

That preflight only refuses when the daemon on `LORE_PORT` is demonstrably
serving **this same `LORE_HOME`** (round E2, 2026-09-03 — it proves ownership
by presenting this home's own `auth.token` as a Bearer and checking the
`/api/health` response's `loreHome` field matches; a home with no
`auth.token` yet has never had a daemon boot against it, so nothing can prove
ownership and the preflight is skipped entirely). Before this fix, `status`
(and every other CLI command sharing this preflight — see below) refused
whenever *any* process answered 200 on that port, even one serving a
completely unrelated `LORE_HOME` — the same port number reused by a second,
unrelated Lore install was enough to block a legitimate command against an
otherwise-free store. If the store turns out to be genuinely locked by
something other than this home's own daemon (a stray CLI process, or a
daemon on the same port serving a different home), the message says so
honestly — "a Lore process answers on port N but reports a different home;
the store is held by another process" — instead of implying it was this
home's own daemon.

---

## `lore doctor`

Diagnoses configuration, filesystem, and daemon connectivity:

```bash
lore doctor          # human-readable
lore doctor --json   # structured findings for scripting
```

`doctor` probes the running daemon's `/api/health` (port 3847 by default — set
`LORE_PORT` if the daemon was started on a different one; `doctor` reads the
same env var the daemon itself honours) to discover the effective `LORE_HOME`
and to confirm the daemon is reachable, then checks config, auth token, and
filesystem layout. In `--json` mode it emits structured
`pass`/`warn`/`fail`/`info` findings — useful in CI or an init agent.

The on-disk graph store is single-writer: only one process may hold it open at
a time. When a daemon is reachable AND an auth token is available, `doctor`
reads graph counts over HTTP (`/api/topology`) instead of opening the store
directly, so it works safely alongside a running daemon. If a daemon is up but
no auth token is found, `doctor` skips the graph check rather than risk a
direct open. If no daemon answers `LORE_PORT` but something else still holds
the store (another CLI command, a daemon on a port `LORE_PORT` doesn't point
at, or a lock that hasn't released yet), `doctor` reports "store is held by a
running Lore process — set LORE_PORT to reach it or stop it" instead of the
raw driver error, and fails fast rather than sitting through the full
multi-second lock-retry budget.

If the daemon `doctor` reaches over `/api/topology` isn't actually serving
the workspace this token belongs to (e.g. the guessed token/home pairing was
wrong, or `LORE_PORT` happens to point at an unrelated Lore install), the
route replies with an HTTP error rather than a graph — `doctor` now reports
that status and error code distinctly (e.g. "Daemon up but /api/topology
refused: 403 workspace_forbidden" or "...400 workspace_required") instead of
collapsing every non-200 response into a generic "unexpected shape" warning
(round E2, 2026-09-03).

### The shared CLI daemon preflight

Applies to `recall`, `sync`, `export`, `init`, and 15 other commands that
open the graph store directly.

Every CLI command that opens the workspace graph directly — not just
`status` and `doctor` — routes through one shared preflight
(`openGraphForCli` in `cli/commands/shared.ts`), plus the equivalent
top-of-command checks in `backup`, `restore`, `maintain`, `compact`, and
`migrate workspace-to-workspace`. All of them share the same home-check
described under `lore status` above: a daemon on `LORE_PORT` only blocks the
command when it proves (via this home's own `auth.token` as a Bearer) that
it is serving *this* `LORE_HOME`. An unrelated daemon reachable on the same
port number — including one running against a workspace that has simply
never had a daemon boot against it yet, e.g. a brand-new `lore init` target
— no longer blocks the command.

`servesHome: false` from that check is not, by itself, proof the store is
safe to touch — it also covers "a process on `LORE_PORT` answered but
rejected this CLI's credential" (a stale, rotated, or corrupted
`auth.token`; round E3, 2026-09-03 — this is distinct from "reports a
different home", which means the daemon DID authenticate the request and
named an unrelated `LORE_HOME`). `lore compact` and `lore maintain`'s
LanceDB-only operations (compaction, version cleanup, ephemeral expiry with
node retention off) treat a rejected credential the same as a confirmed
same-home daemon — refusing unless `--force` — because neither command
otherwise opens the graph store, so unlike the other 18 commands they have
no on-disk lock attempt to fall back on if the port probe is wrong. As a
second, independent layer, both also probe the workspace's own SurrealDB
graph store lock directly (`probeSurrealLock`, no HTTP involved) immediately
before touching LanceDB — a daemon holds a workspace's graph store open
whenever it holds any of that workspace's substrates (including LanceDB)
open, so this catches a real holder the port probe missed entirely (wrong
port, timed-out probe, no `auth.token` on disk to send).

That second layer has one gap of its own: `probeSurrealLock` reports a
workspace's graph store as "free" whenever its `.lore/surreal/` directory
doesn't exist yet, by design — opening a store that isn't there would
*create* one, which is exactly wrong for a lock check. A workspace whose
`.lore/lancedb/` was populated by something that never went through the
daemon's normal write path (a raw script, a partial restore, an external
copy) can therefore have live LanceDB data with no graph store to probe at
all, and looked identical to "nothing here whatsoever". Round E4,
2026-09-03: both `lore compact` and `lore maintain`'s LanceDB-only path now
refuse outright when the workspace's graph store directory is absent —
there is no LanceDB-native lock to fall back on, so an absent store means
"cannot prove safety", not "safe". `lore maintain` runs with node retention
on are unaffected (that path opens/creates the graph store itself right
after this check, which is the real safety net there). Either refusal —
this one or the ones above — is bypassed by `--force`, which now also
prints a one-line notice (`proceeding with --force; daemon/lock checks
skipped`) to stderr at the moment it does so, rather than only ever showing
the warning text in the refusal message an operator who already passed
`--force` up front would never see.

---

## Capacity maintenance (`lore maintain`)

`lore maintain` is the config-driven capacity tool: LanceDB compaction + version
cleanup, cold-node retention, and ephemeral-workspace expiry. The full knob table
(defaults → `LORE_MAINTAIN_*` env → CLI flags) lives in the
[root README, "Capacity maintenance" section](../README.md#capacity-maintenance-lore-maintain).
This section summarizes the operational facts that matter when you run it.

### Two ways to run it

| Surface | When | Safety |
| --- | --- | --- |
| **CLI** `lore maintain` | Offline / scheduled (cron) | **Refuses while the daemon is up** — opening a second graph writer (SurrealDB) risks corruption |
| **MCP `maintain` tool** | Online, inside the daemon | Online-safe — runs in-process |

The CLI preflight checks for a running daemon and refuses (unless `--dry-run`, or
the test-only `--force`). For online maintenance, call the in-process MCP
`maintain` tool instead. A process on `LORE_PORT` that rejects this CLI's
credential is refused the same as a confirmed same-home daemon (it may hold
the store even though it couldn't be proven), and — for the LanceDB-only
path (compaction / version cleanup with node retention off) — a per-workspace
`probeSurrealLock` check catches a holder the port probe cannot see at all;
see "The shared CLI daemon preflight" above.

### Common invocations

```bash
lore maintain --dry-run                              # report only — counts + reclaimable bytes
lore maintain                                        # active workspace, perform
lore maintain --all                                  # every registered workspace
lore maintain --all --cleanup-versions-older-than 3d # tighter version cutoff
lore maintain --json                                 # raw report as JSON
```

### Flags (all override env + defaults)

`--dry-run`, `--all`, `--retention-days <n>`, `--cleanup-versions-older-than <dur>`
(e.g. `7d`, `168h`), `--compact-threshold <n>`, `--ephemeral-ttl-days <n>`,
`--ephemeral-patterns <csv>`, `--protect-tags <csv>`,
`--node-action archive|delete`, `--cold-signal retrieval|access|update`,
`--no-compaction`, `--no-version-cleanup`, `--no-node-retention`, `--no-ephemeral`,
`--json`, `--force`.

Defaults of note: node retention age **90 days**, version-cleanup cutoff **7d**,
compact threshold **200 fragments**, ephemeral TTL **14 days**, protected tags
`pinned,protected` (never touched). See `lore maintain --help` for the inline list.

### Suggested schedule

Run `lore maintain --all` on a cron / launchd timer **while the daemon is stopped**
(e.g. nightly), or use the in-process MCP `maintain` tool on a schedule if you need
the daemon to stay up. Start with `--dry-run` to size the reclaim before letting it
write.

---

## Related ops commands

| Command | Purpose |
| --- | --- |
| `lore storage` | Per-workspace disk usage breakdown + SSD free |
| `lore lint` | Graph health + relationship checks |
| `lore compact` | LanceDB compaction (also offline; refuses while daemon up, or while its store's graph lock is held) |
| `lore workspaces` | List / show / switch / report the active workspace |
| `lore outbox` | Outbox operator tools (drain-failed self-heal sweep). `--no-check-substrate` is SQLite-only and safe to run alongside the daemon; the default `--check-substrate` mode opens the graph store directly and refuses while the daemon is up (or another process holds the store's lock), same as `lore compact` — `--force` bypasses the refusal (not a genuine lock). |
| `lore diagnose` | Tri-substrate consistency diagnostics |

Run `lore --help` for the full command list.
