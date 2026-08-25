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
  handles — SurrealDB by default as of v3.13.0, Kùzu remains supported per
  workspace — plus LanceDB handles — the single-writer constraint makes this
  the recommended mode for any multi-client setup).

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

### `GET /api/health` — full daemon health snapshot (unauthenticated)

A richer status snapshot. It stays unauthenticated by design — it reports *status,
not data* — but it surfaces enough to spot drift:

- `status` — `ok` or `orphan_decision_required`
- `version`, `deploymentMode`, `loreHome`
- `workspace` (active) plus a `workspaces` block with **per-workspace** node/edge
  counts and `globalTotals` (the "never silent again" rule: per-workspace and
  global counts are never collapsed into one ambiguous number)
- `outbox` — aggregate `depth`, `lagSeconds`, `dead`, and `perWorkspace`
- `perWorkspaceOutbox` — per-workspace lag/depth vs. backpressure threshold, with
  `overThreshold` flags
- `dataplane` state, `rateLimit` snapshot, `embeddingBackend`

```bash
curl -s http://localhost:3847/api/health | jq .
```

`lore doctor` (below) probes `/api/health` internally to decide whether the daemon
is up, so a healthy `doctor` run implies a reachable health endpoint.

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
engine (SurrealDB by default as of v3.13.0, Kùzu per workspace) on every
scrape (default Prometheus scrape intervals are 10–15s). Outbox stats are read
fresh on each scrape.

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

---

## `lore doctor`

Diagnoses configuration, filesystem, and daemon connectivity:

```bash
lore doctor          # human-readable
lore doctor --json   # structured findings for scripting
```

`doctor` probes the running daemon's `/api/health` (on port 3847) to discover the
effective `LORE_HOME` and to confirm the daemon is reachable, then checks config,
auth token, and filesystem layout. In `--json` mode it emits structured
`pass`/`warn`/`fail`/`info` findings — useful in CI or an init agent.

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
| **CLI** `lore maintain` | Offline / scheduled (cron) | **Refuses while the daemon is up** — opening a second graph writer (SurrealDB or Kùzu) risks corruption |
| **MCP `maintain` tool** | Online, inside the daemon | Online-safe — runs in-process |

The CLI preflight checks for a running daemon and refuses (unless `--dry-run`, or
the test-only `--force`). For online maintenance, call the in-process MCP
`maintain` tool instead.

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
| `lore compact` | LanceDB compaction (also offline; refuses while daemon up) |
| `lore workspaces` | List / show / switch / report the active workspace |
| `lore outbox` | Outbox operator tools (drain-failed self-heal sweep) |
| `lore diagnose` | Tri-substrate consistency diagnostics |

Run `lore --help` for the full command list.
