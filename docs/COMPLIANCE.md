# Lore Core — Compliance & Data Governance

> Audience: an enterprise security/compliance reviewer. This document
> covers audit logging, data retention, legal hold, PII handling,
> encryption posture, and observability — **as implemented in the code
> today**, with honest labelling of what is deferred or relies on the host
> OS. Every claim cites a source file under `packages/lore/src/`.

Companion document: [`SECURITY_MODEL.md`](./SECURITY_MODEL.md) (auth,
ReBAC, isolation, tenant gate, env scrub).

---

## 1. Audit logging

### 1.1 The primary audit log (`src/security/audit.ts`)
Lore writes an **append-only JSON Lines** audit log at
`<LORE_HOME>/audit.jsonl`. The file is created and self-healed to **`0600`
permissions** (owner-only read/write) on every daemon boot
(`audit.ts:108`), so on a multi-user host only the owning OS user can read
it.

**Each entry** (`AuditEntry`, `audit.ts:55`) records:

| Field | Meaning |
|-------|---------|
| `timestamp` | ISO-8601 time of the call |
| `actor` | `{ id, roles }` snapshot of the calling identity |
| `toolName` | The MCP tool / operation name |
| `args` | The arguments the tool received (**callers must redact secrets first** — see 1.3) |
| `result` | `success` \| `denied-by-policy` \| `denied-by-user` \| `error` |
| `resultDetail` | Error message, archived count, etc. |
| `approvalId` | Set when a consent/approval flow gated the call |
| `durationMs` | Wall-clock duration of the operation |

### 1.2 What gets audited
The audit log captures **state-changing and security-relevant operations**
across the daemon. Confirmed call sites include:

- **Admin operations** — `src/mcp/http/routes/admin.ts`
- **Bulk writes** — `src/mcp/http/routes/bulkWrite.ts`
- **Node/edge mutations** — `nodes-delete.ts`,
  `tools/memory/deleteEdge.ts`, `tools/memory/supersedeNode.ts`
- **Ingestion** — `src/mcp/http/routes/ingestion.ts`
- **Evidence operations** — `src/mcp/tools/evidence.ts`
- **Retention sweeps** — logged as `workspace.retention.sweep` with the
  threshold and eligible/archived counts (`src/mcp/services.ts:638`)

The result field distinguishes **denied-by-policy** and **denied-by-user**
from `success` and `error`, so the log is sufficient to answer "was this
action allowed, and who asked" — the substrate primitive the audit log was
built for (`audit.ts:1`).

### 1.3 Redaction discipline
The audit module does **not** redact arguments itself — by design.
Redaction is tool-specific (e.g. `store_edge`'s `relation` is safe to log;
a `set_api_key`'s `apiKey` is not), so each **caller** must redact
secret-bearing args before calling `log()` (`audit.ts:33`). Node IDs are
logged in full, because the audit log *is* the correlation surface — if
you can't see the ID you can't investigate. Compensating controls: the
file is `0600`, perms self-heal on boot, and **stderr** ID leakage is
handled separately by one-way hashing (`src/security/logRedact.ts`).

### 1.4 Specialized audit logs
Two additional append-only logs live per-workspace under `.lore/`:

- **Schema-change audit** (`src/security/schemaChangeAudit.ts`) →
  `schema-changes.jsonl`. Logs node/field/edge/permission-expression
  additions, removals, type/sensitivity changes, the migration strategy
  chosen, and the **approver identity** for reviewed changes.
- **Classification audit** (`src/security/classificationAudit.ts`) — per
  ingest-record classification decisions, for a compliance dashboard's
  "classification accuracy" view.

### 1.5 Pluggable SIEM export (`LORE_AUDIT_EXPORTER`)
For customers who must ingest audit signal into a SIEM, Lore defines a
stable **`AuditLogExporter`** interface (`src/audit/exporter.ts`). The
audit-write path stays untouched: `audit.jsonl` remains the source of
truth, and an attached exporter purely **observes** each successful write
and streams it out (`audit.ts:159`). The contract guarantees a misbehaving
exporter can **never** fail a tool call (errors are caught and swallowed,
`audit.ts:164`).

The exporter is selected by env `LORE_AUDIT_EXPORTER`
(`exporter.ts:129`):

| Value | Status |
|-------|--------|
| `file` | Reference file-tailer (default for local mode) — **implemented** |
| `none` | No exporter; `audit.jsonl` is the only sink — **implemented** |
| `splunk` / `datadog` / `elastic` | Interface drop-in points — **DEFERRED** to cloud activation |

> **Honest labelling:** the concrete Splunk/Datadog/Elastic exporters are
> **not yet wired**. Setting `LORE_AUDIT_EXPORTER=splunk` today logs a
> boot warning and **falls back to `file`** rather than silently dropping
> audit signal (`exporter.ts:22`, `parseExporterChoice`). The interface +
> the file-tailer reference impl ship today; the SIEM wires are part of
> cloud activation.

### 1.6 Rotation & retention of the audit log (`src/security/logRotator.ts`)
The audit log (and the launchd stdout/stderr logs) are rotated **at daemon
boot**: any file larger than **10 MB** (default `maxBytes`) or older than
**7 days** (default `maxAgeDays`) is gzipped to a timestamped sibling and
the original is truncated in place (preserving the inode), with fresh
**`0600`** perms (`logRotator.ts:59`, `:101`). Retention keeps the last
**30** rotated files per log by default (`retainCount`), deleting older
ones. The `tail`/`since` readers refuse files over 25 MB to avoid a
multi-second sync read on an admin poll (`audit.ts:196`).

> **Tamper-evidence gap (honest):** the audit log is append-only at the
> filesystem level and `0600`, but it is **not cryptographically
> tamper-evident** — there is no hash chain or signature linking entries
> (`audit.ts` writes plain JSON lines). A privileged local user who can
> write the file could in principle alter history undetected. A
> hash-chained / signed audit log is a candidate hardening item, not a
> current guarantee.

---

## 2. Data retention, legal hold & PII (`lore maintain`)

### 2.1 Retention via `lore maintain` (`src/cli/commands/maintain.ts`)
Capacity and retention are policy-driven, not hardcoded. `lore maintain`
runs (defaults → `LORE_MAINTAIN_*` env → CLI flags →
`resolveMaintainPolicy`) and performs:

- **Cold-node retention** — nodes that are "cold" (no retrieval/access/
  update per the configured `--cold-signal`) and older than
  `--retention-days` (default 90) are **archived or deleted** per
  `--node-action` (default **archive**, not delete).
- **LanceDB version cleanup** — prunes vector-store versions older than
  `--cleanup-versions-older-than` (default 7d) and compacts fragments.
- **Ephemeral-workspace expiry** — workspaces matching ephemeral patterns
  (e.g. `e2e-*`, `*-smoke`, `*-test`) past their TTL (default 14d).

`--dry-run` reports only (counts, reclaimable bytes, affected items) with
no writes. The command **refuses to run while the daemon is up** (a second
writer against the embedded graph store risks corruption); for online
maintenance the in-process MCP `maintain` tool is used instead
(`maintain.ts:13`).

### 2.2 Legal hold & protection (`src/engines/maintain/selection.ts`)
Retention **never** touches protected data. `isProtected()`
(`selection.ts:46`) exempts a node when **any** of:

- `node.legalHold === true` — an explicit **legal hold** flag,
- `node.status === 'protected'`,
- the node carries any tag in the configured **protect-tags** set
  (`--protect-tags`, default `pinned,protected`).

Protected/held nodes are counted separately (`protectedCount`) and skipped
from any archive/delete action, so a legal hold survives retention sweeps
regardless of age or coldness.

### 2.3 PII handling
- **PII-bearing identifiers in logs are hashed.** Node IDs (which can be
  PII in a personal workspace, e.g. `person:sarah-smith`) are reduced to a
  one-way short hash before landing in stderr logs
  (`src/security/logRedact.ts`).
- **Field-level sensitivity** is part of a workspace's schema; changes to
  a field's sensitivity flag are recorded in the schema-change audit
  (`src/security/schemaChangeAudit.ts`).
- **Irrevocable deletion** is supported at the workspace level: deleting
  a workspace and its on-disk `.lore/` directory (after stopping the daemon)
  permanently removes all data for that workspace. The keyring entry
  (`deleteWorkspaceKey`, `src/security/keyring.ts:108`) should be deleted
  alongside the workspace data to remove the per-workspace key from the OS
  keychain. Note: because Lore does not perform application-layer encryption
  today (see §3.2), key deletion alone does NOT render surviving data
  unreadable — the data must be physically deleted from disk.

---

## 3. Encryption posture (read honestly)

### 3.1 In-transit
- **Cloud mode:** all Dataplane traffic flows through `groundfloor-ts-sdk`
  over HTTPS/TLS (`src/security/dataplaneAuthz.ts`; `DATAPLANE_URL` is the
  HTTPS base). TLS is provided by the SDK/HTTP layer.
- **Local mode:** the daemon binds `127.0.0.1` only
  (`src/mcp/lifecycle.ts:45`), so traffic is loopback and never traverses
  a network.

### 3.2 At-rest — **honest statement**
**Lore Core does not encrypt the live graph or vector store at the
application layer by default. At-rest confidentiality relies on the host
OS / full-disk encryption (e.g. FileVault, BitLocker, LUKS).**

What *does* exist:
- **A per-workspace keyring** (`src/security/keyring.ts`) backed by the OS
  keychain (service `groundfloor-lore`, account `encryption:<workspace>`),
  with generate / retrieve / rotate / delete operations. Keys never touch
  disk; on modern macOS they are hardware-backed (Secure Enclave / Touch ID).
- **Key generation** (`src/security/encryption.ts`) — `generateKey()` mints
  a fresh 256-bit key used by the keyring on first workspace access. The key
  is available for a future encrypted-substrate path; it is not used to
  encrypt any live data today.

What is **NOT** done today (updated for TW-6c, 2026-06-15):
- **No AES-256-GCM encrypt/decrypt primitives ship in `encryption.ts`.**
  They were removed in NW-7h (`AUDIT_FINDINGS_2 ent-encryption-dead-code`)
  because they had no callers — an enterprise reviewer could incorrectly infer
  that the live graph or verbatim store is encrypted. The primitives do NOT
  exist as dead code; they will be reintroduced alongside the call site that
  uses them, not before.
- The live graph store (SurrealDB by default as of v3.13.0; Kùzu for legacy
  per-workspace `graphEngine: kuzu`), the LanceDB vector store, and the
  SQLite relational store are **not** transparently encrypted by Lore at the
  application layer.
- Encrypting a searchable text column breaks `CONTAINS` / full-text search;
  resolving that trade-off is an explicitly deferred decision.

**Bottom line for a reviewer:** treat at-rest protection as **OS/disk
encryption (FileVault, LUKS, BitLocker)** managed by the host operator.
Lore does not provide application-layer at-rest encryption today.
Sensitive secrets (API keys, per-workspace keys) are in the OS keychain,
not on disk.

### 3.3 Secret storage summary
| Secret | Storage | Protection |
|--------|---------|-----------|
| API keys, encryption keys | OS keychain (`groundfloor-lore`) | OS login auth; hardware-backed on modern macOS |
| Daemon session token | `<LORE_HOME>/auth.token` | `0600` owner-only |
| App-token registry | `<LORE_HOME>/auth/registry.json` | `0600`, stores SHA-256 hashes only |
| Audit log | `<LORE_HOME>/audit.jsonl` | `0600`, self-healing perms |

---

## 4. Observability & tracing (read honestly)

### 4.1 Metrics
A Prometheus scrape endpoint (`/metrics`) is exposed, gated by
`LORE_METRICS=on` (default **off**) and localhost-only Host/Origin checks
(`src/security/httpAuth.ts:104`, `src/mcp/http/routes/metrics.ts`). It is
intentionally bearer-free so a local collector can poll without a token;
cloud activation wraps it behind ingress auth.

### 4.2 OpenTelemetry tracing — **PROVISION-ONLY SHIM, NOT IMPLEMENTED**
> **This is the most important honesty point in this document.** Lore
> ships OTel **provisioning knobs and a no-op span shim** — it does **not**
> emit real traces to any collector today.

`src/observability/otelHooks.ts` is explicitly **provision-only**
(`otelHooks.ts:1`). Concretely:

- `LORE_OTEL_EXPORTER_OTLP_ENDPOINT`, `LORE_OTEL_SERVICE_NAME`, and
  `LORE_OTEL_SAMPLING` are read into an `OtelConfig` (`loadOtelConfig`).
- `span(name, attrs)` returns a `SpanHandle` whose `setAttribute()` is a
  **no-op** and whose `end()` only increments an in-process counter
  (`otelHooks.ts:85`–`106`). The comments state plainly: *"No-op in
  provision mode. Cloud activation replaces this with the real OTel
  span.setAttribute call."*
- There is **no `@opentelemetry/sdk-node` dependency and no exporter
  wired.** `getOtelReadiness()` reports `enabled: true` **only** after
  `registerSpanProcessor()` has been called (meaning a real SDK span
  processor was actually attached). Setting the env var is insufficient
  — env-only state is surfaced as `endpointConfigured: true`, distinct
  from `enabled` (which tracks real SDK readiness). The `/metrics` endpoint
  reports `lore_otel_enabled=0` until a real exporter is wired
  (`otelHooks.ts:49-58`, NW-5a fix).

**Why it exists now:** to let call sites mark hot-path span boundaries
(replicator tick, embed enqueue, recall request) today, so when the real
SDK lands the trace names are immediately useful — a single swap point in
`span()`. The concrete collector + SDK wire-up is part of the cloud
activation track, **deferred** (`otelHooks.ts:28`).

**Do not represent Lore as having end-to-end distributed tracing.** It has
the provisioning surface and the call-site instrumentation hooks; the
exporter is not yet built.

---

## 5. Quick compliance-questionnaire answers

| Question | Answer | Source |
|----------|--------|--------|
| Is access audited? | Yes — append-only `0600` JSONL of state-changing/security ops | `security/audit.ts` |
| Are audit logs tamper-evident? | Append-only + `0600`; **not** hash-chained/signed | `security/audit.ts` |
| Can audit go to our SIEM? | Pluggable exporter interface; file/none today, SIEM wires deferred | `audit/exporter.ts` |
| Is data encrypted in transit? | Yes (cloud: TLS via SDK; local: loopback only) | `security/dataplaneAuthz.ts`, `mcp/lifecycle.ts` |
| Is data encrypted at rest? | Relies on OS/disk encryption; **no app-level encryption primitives** (removed NW-7h); live store is not encrypted by Lore | `security/encryption.ts`, `security/keyring.ts` |
| Where are secrets stored? | OS keychain; tokens hashed `0600` on disk | `security/keyring.ts`, `auth/tokens.ts` |
| Retention / legal hold? | Policy-driven `lore maintain`; `legalHold` + protect-tags exempt data | `cli/commands/maintain.ts`, `engines/maintain/selection.ts` |
| Right-to-erasure? | Delete workspace `.lore/` dir + keyring entry; retention can hard-delete (no ciphertext — physical deletion required) | `security/keyring.ts`, `cli/commands/maintain.ts` |
| Distributed tracing? | **Provision-only shim — not implemented** | `observability/otelHooks.ts` |
| Multi-tenant isolation (cloud)? | Hard boot gate on `DATAPLANE_ORG_ID`; per-request `X-Lore-Workspace` | `mcp/services.ts`, `mcp/http/middleware.ts` |

---

## Source map (verify any claim here)

| Capability | File |
|-----------|------|
| Append-only audit log (`0600`) | `src/security/audit.ts` |
| Audit exporter interface (SIEM) | `src/audit/exporter.ts` |
| Schema-change audit | `src/security/schemaChangeAudit.ts` |
| Classification audit | `src/security/classificationAudit.ts` |
| Log rotation & retention | `src/security/logRotator.ts` |
| Stderr PII/ID redaction | `src/security/logRedact.ts` |
| Retention / legal hold / maintain | `src/cli/commands/maintain.ts`, `src/engines/maintain/selection.ts` |
| Key generation (keyring use only; no live encrypt/decrypt) | `src/security/encryption.ts` |
| Per-workspace keyring | `src/security/keyring.ts` |
| OTel provision-only shim | `src/observability/otelHooks.ts` |
| Metrics endpoint | `src/mcp/http/routes/metrics.ts` |
