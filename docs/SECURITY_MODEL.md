# Lore Core — Security Model

> Audience: an enterprise security reviewer evaluating Lore Core for
> deployment. This document describes the security architecture **as the
> code actually implements it today**. Where a capability is partial,
> deferred, or relies on the host OS, it is labelled as such — we would
> rather you read "here is exactly what we do and don't do" than discover
> a gap during a pen test.
>
> Every claim cites the source file that backs it, so each can be
> independently verified against `packages/lore/src/`.

Companion document: [`COMPLIANCE.md`](./COMPLIANCE.md) (audit logging,
retention, encryption posture, observability).

---

## 1. Deployment modes

Lore Core runs in one of two modes, selected by `LORE_DEPLOYMENT_MODE`
(`local` is the default; `cloud` is opt-in):

| Mode | Storage substrate | Tenant scope | Network surface |
|------|-------------------|--------------|-----------------|
| **local** (default) | Embedded SurrealDB + LanceDB + SQLite on the user's disk | Single user, no org | Daemon binds `127.0.0.1` only |
| **cloud** | Groundfloor Dataplane via `groundfloor-ts-sdk` | Multi-tenant, org-scoped | Reaches the Dataplane over TLS |

The mode determines which storage client is wired
(`src/storage/loreStorageClient.ts`): local mode always uses `SurrealGraph`
(`engines/graphEngineSelector.ts`); cloud mode swaps in `DataplaneGraph`
via `LoreStorageClient.fromDataplane(sdk)`.

---

## 2. Network exposure & transport

- **The daemon binds `127.0.0.1` exclusively.** It is not reachable from
  the network. See `src/mcp/lifecycle.ts:45` — `httpServer.listen(port,
  '127.0.0.1', …)`. There is no `0.0.0.0` bind path.
- **In-transit (cloud mode):** all Dataplane traffic flows through
  `groundfloor-ts-sdk` over HTTPS/TLS (`src/security/dataplaneAuthz.ts`
  routes authz calls through the SDK's `fetch`; `DATAPLANE_URL` is the
  base URL). Transport security is the SDK/HTTPS layer's responsibility.
- **In-transit (local mode):** traffic is loopback-only, so it never
  leaves the host.

---

## 3. Request authentication (HTTP daemon)

All daemon HTTP requests pass through three independent layers
(`src/security/httpAuth.ts`, `validateRequest`). A request must clear all
three to be treated as a trusted local action.

### Layer 1 — Host header (DNS-rebinding defense)
Rejects any request whose `Host` header is not exactly
`127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>`
(`isAllowedHost`, `httpAuth.ts:135`). This blocks an attacker who points
their own DNS name at `127.0.0.1` to trick a browser into treating their
origin as same-origin with the daemon. Failure → `403`.

### Layer 2 — Origin header (cross-origin browser defense)
When an `Origin` header is present, it must be `http(s)://localhost:*` or
`http(s)://127.0.0.1:*` / `[::1]` (`isAllowedOrigin`, `httpAuth.ts:124`).
A missing `Origin` is allowed (covers curl, the CLI, and native MCP
clients, all of which are then still covered by the bearer-token
requirement). Failure → `403`.

### Layer 3 — Bearer token (authorization)
All `/api/*` routes — plus `/mcp` and `/v1/*` (the write-capable MCP and
SDK-aligned CRUD surfaces) — require `Authorization: Bearer <token>`
(`httpAuth.ts:119`, `:184`). Two token shapes are accepted:

1. **64-char hex session/shared-secret token.** Minted at daemon boot,
   stored at `<LORE_HOME>/auth.token` with `0600` perms (owner-only). It
   is compared in **constant time** (`constantTimeEqHex`,
   `httpAuth.ts:238`) so a timing side-channel cannot distinguish the
   session token from a shared secret. An optional shared secret supplied
   via `LORE_MCP_AUTH_TOKEN` is accepted alongside the session token in
   cloud mode (`AuthConfig.sharedSecret`).
2. **Per-app workspace-scoped token** of shape
   `lore_<workspace>_<43-char base64url>` (`src/auth/tokens.ts`). These
   are syntactically validated in `httpAuth.ts` and resolved against the
   on-disk registry in HTTP middleware (see §4).

#### Public (bearer-free) paths
A deliberately small allowlist skips the bearer requirement but still
passes Host + Origin validation (`PUBLIC_API_PATHS`, `httpAuth.ts:64`):

- `/health`, `/api/health` — liveness probes. Reaching the route needs no
  bearer, but the RESPONSE BODY still depends on one (2026-09-03 FINDING 4
  fix): an anonymous request gets only the lite liveness shape (`status`,
  `version`, `sessions`, `backgroundReconnect`, `embeddingBackend`); a
  Bearer-authenticated request gets the full snapshot (per-workspace
  counts, `loreHome`, outbox state, the live rate-limit config). Before
  this fix the full body was served to any local process with no token —
  see `docs/OPERATIONS.md`'s Health checks section for the response shapes.
  The arcade-mode boot's own `/health`/`/api/health` (`mcp/arcadeBoot.ts`)
  applies the same split for its operator-only fields (`arcadeBaseUrl`,
  `rateLimit`). This is a local-mode decision only — a cloud/remote
  deployment's equivalent policy is a separate, not-yet-designed follow-up.
- `/api/auth/bootstrap` — the **bootstrap** endpoint the local UI calls
  **once** to fetch its session token. It is protected by Host+Origin
  (a hostile cross-origin tab's `Origin` cannot match localhost), not by
  a bearer (there is no bearer yet at bootstrap time).
- `/metrics` — Prometheus scrape, gated additionally by `LORE_METRICS=on`
  (default off).

Security hardening notes recorded in the source:
- `/mcp` was moved **out** of the bearer-free set (audit 2026-05-13) —
  it carries the full write surface (`httpAuth.ts:96`).
- `/api/node-full` was removed from the public set (SP-04) because it can
  dump a node's full body (potential secrets / source URLs)
  (`httpAuth.ts:74`).

---

## 3a. Response headers

Every HTTP response the daemon writes — every gate rejection (401/403/429),
every `/api/*` and `/v1/*` route, the MCP Streamable-HTTP transport at
`/mcp`, and the OPTIONS preflight — carries a baseline set of browser
security headers, applied once as the first statement of
`src/mcp/http/middleware.ts`'s `runHttpGates` (`applySecurityHeaders`,
`src/mcp/http/helpers.ts`) so there is a single chokepoint every response
passes through before any gate or route writes a byte:

- `X-Content-Type-Options: nosniff` — no MIME-sniffing a JSON body into an
  executable content type.
- `X-Frame-Options: DENY` — nothing should ever be able to frame this
  daemon; it serves no UI.
- `Referrer-Policy: no-referrer` — daemon URLs can carry workspace
  names/ids in the path or query string.
- `Cache-Control: no-store` — API responses sit behind Bearer auth and can
  carry live graph data.
- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` —
  the strict default for every JSON/NDJSON/SSE response.

These are set via `res.setHeader()`, not folded into a `writeHead()` call,
so Node's own header-merge rule lets an individual route override just the
one header it needs (e.g. `routes/stream.ts`'s own `Cache-Control:
no-cache, no-transform` on its chunked NDJSON response) while every other
response inherits the defaults untouched.

`GET /api/export/html` (`routes/static.ts`) is the one response that is
actually rendered as a page in a browser (the self-contained vis-network
snapshot from `src/engines/htmlExport.ts`), so it overrides the default CSP
with a page-specific policy (`buildHtmlExportCsp`, `src/mcp/http/
helpers.ts`) scoped to exactly what that template needs: the SRI-pinned
vis-network CDN script is allow-listed by origin, and the page's one inline
`<script>` and one inline `<style>` block carry a fresh per-response
`nonce` (never `'unsafe-inline'`).

No HSTS: the daemon only ever listens on loopback plain HTTP (see §2 —
`127.0.0.1` exclusively). HSTS forces a browser to upgrade future requests
to HTTPS for an origin; there is no HTTPS variant of this loopback origin
to upgrade to.

---

## 4. Per-app workspace tokens (`src/auth/tokens.ts`)

For connecting external apps (Claude Code, Atlas, Loom) without handing
over daemon-wide control, Lore issues **workspace-scoped, scoped-capability
tokens**:

- **Format:** `lore_<workspace>_<32 random bytes, base64url>`. The
  workspace prefix is informational; the registry is the source of truth.
- **Storage:** `<LORE_HOME>/auth/registry.json`, `0600` perms. The file
  stores **SHA-256 hashes** of token plaintext, never the plaintext
  (`tokens.ts:121`, `writeRegistry`/`sha256Hex`). A stolen registry does
  not equal stolen tokens.
- **Scopes** (`TokenScope`, `tokens.ts:37`): `read`, `write`,
  `cross-workspace-read`, `cross-workspace-write`. An operator mints the
  minimum scope an integration needs.
- **Ephemeral / TTL tokens:** `expiresAt` can be set at issue time
  (`ttlMs`); expired tokens fail auth with `token_expired` and are dropped
  by a periodic sweeper (`sweepExpiredTokens`, `startTokenSweeper`,
  `tokens.ts:283`).
- **Revocation:** `revokeByPrefix` (`tokens.ts:376`) revokes by token
  prefix; revoked tokens fail lookup immediately.
- **Local-only:** the registry is never synced to cloud and never
  committed.

### Cloud-mode end-user auth — Clerk JWT (`src/security/clerkAuth.ts`)
In cloud mode, end-user requests carry a Clerk-issued JWT. The validator
(`compileClerkValidator`) verifies the token against the configured Clerk
issuer's JWKS (signature, `exp`, `iss`, and optional `aud`), extracts the
`portal_user` id from `sub`, and binds an actor context to the request
(`bindActorToRequest`). It is **env-gated**: when `CLERK_ISSUER` is unset
the validator is a no-op, preserving local mode and transitional cloud
deploys. Service-to-service callers presenting `LORE_MCP_AUTH_TOKEN` are
matched earlier in `httpAuth.ts` and never reach Clerk validation
(`clerkAuth.ts:18`).

**Three identity paths, summarized:**

| Caller | Credential | Verified in |
|--------|-----------|-------------|
| Local UI / CLI | Boot session token (64-hex) | `httpAuth.ts` |
| Connected app | `lore_<ws>_…` registry token | `tokens.ts` + middleware |
| Service-to-service (cloud) | `LORE_MCP_AUTH_TOKEN` shared secret | `httpAuth.ts` |
| Cloud end-user | Clerk JWT | `clerkAuth.ts` |

---

## 5. Authorization — the ReBAC permission model

Lore implements **Relationship-Based Access Control (ReBAC)** in two
layers, encoded by the `lore-rebac-two-layer` design.

### L1 — Relation edges (`src/security/rebac.ts`)
Five platform-locked relation types — **owner, editor, viewer, member,
parent** — are stored as a dedicated SQLite table (`lore_rebac_edge`, via
`better-sqlite3`), kept separate from the graph substrate entirely — not
just from semantic edges — so permission queries and audit paths stay
operationally distinct (and so the table can later cut over to
SpiceDB in cloud mode). The `RebacStore` DAO provides
`grant` / `revoke` / `has`, plus **`hasEffective`** (`rebac.ts:194`),
which resolves a permission through:

1. a direct `subject --relation--> resource` edge,
2. group inheritance (`subject --member--> group --relation--> resource`),
3. ancestor inheritance, walking `parent` edges upward from the resource
   (a **bounded BFS**, `maxDepth` default 8, so cycles or pathological
   depth cannot stall a check).

Each grant records `grantedBy` and an optional `expiresAt` for audit.

### L2 — Permission schema evaluator (`src/security/rebacEvaluator.ts`)
A workspace declares permission expressions per resource type, e.g.
`approve_ticket: editor | owner`. `RebacEvaluator.check()` looks up the
resource type's action, parses the OR-expression into relation terms, and
asks `hasEffective` for each term until one matches. The grammar is
intentionally narrow (OR of relation names; AND/NOT deferred to the
SpiceDB cloud evaluator). Crucially, every denial returns a **structured
reason** (`no-schema`, `no-action`, `unknown-relation`,
`no-relation-matches`) so audit logs can explain *why* a check failed
(`rebacEvaluator.ts:120`).

### Cloud HTTP gate (`src/security/rebacGate.ts` + `dataplaneAuthz.ts`)
In cloud mode, HTTP routes can opt into a SpiceDB-backed gate via
`requirePermission`, which relays a CheckPermission to the Dataplane for
the actor's `lore__user` subject against a `lore__workspace` (or other
`lore__*`) resource. The permission vocabulary is a **closed set**
(`administer | read | write | delete | ddl | deploy | manage_members |
view_billing`, `rebacGate.ts:53`) enforced at compile time so a typo
cannot silently produce an always-false check.

### Local-mode authorization caveat (NW-7h, `ent-local-mode-no-rbac`)
**ReBAC is enforced cosmetically only in local mode.** The L1 and L2
data structures (`lore_rebac_edge`, the evaluator) exist in every
workspace, but local mode is single-operator by design: the only
"actor" is the human who owns the on-disk `.lore/` directory, and that
human can bypass any in-process gate by reading or writing files
directly with their OS user account. Local mode ships **one bearer
token + one keychain unlock** — there is no per-user authorization to
enforce against. The `rebacGate.ts` permission check returns
`{ allowed: true, reason: 'local_mode_no_actor' }` in local mode
because there is no Dataplane to consult.

If you need **tenant-isolated RBAC with per-user audit attribution**,
you need **cloud mode + Dataplane** (§8). The SpiceDB-backed evaluator
on the Dataplane side is what makes ReBAC actually enforced, because
the storage substrate is no longer on the requesting user's disk. A
deployment that requires RBAC for compliance reasons MUST run in cloud
mode; using local mode for that purpose would mis-state the security
posture.

---

## 6. Default-deny posture

Lore fails **closed** at every authorization decision point:

- **Permission checks return `false` on any malformed response.**
  `checkPermission` (`dataplaneAuthz.ts:106`) returns `true` only when the
  engine clearly says allowed; any malformed envelope → `false`.
- **No actor → denied.** `requirePermission` returns
  `{ allowed: false, reason: 'no_actor' }` when no actor is bound
  (`rebacGate.ts:99`).
- **L2 evaluator denies on missing schema/action/relation** rather than
  defaulting to allow (`rebacEvaluator.ts:120`).
- **Auth validator denies unrecognized bearer shapes** — a token that is
  neither legacy-hex nor a well-formed app token → `401`
  (`httpAuth.ts:204`).
- **Corrupt token registry is treated as empty** (no tokens valid)
  rather than crashing or allowing (`tokens.ts:99`).
- **Cloud mode refuses to boot without an org id** (see §8) rather than
  defaulting to a shared tenant.

---

## 7. Workspace isolation

A **workspace** is the unit of data isolation. Each workspace owns its own
storage tree at `<LORE_HOME>/workspaces/<name>/.lore/`:

- `surreal` — its own SurrealDB database (nodes + edges), the only graph
  engine.
- `lancedb/` — its own LanceDB vector store.
- `tables.sqlite` — relational store, including the `lore_rebac_edge`
  permission table (see §5).
- `config.json`, `repo-tags.json` — per-workspace settings.

Switching workspaces swaps which `.lore/` directory the daemon reads.
Because each workspace is a **physically separate database**, a query in
one workspace cannot traverse into another's nodes or vectors.

**Cross-workspace access is an explicit, scoped capability, not a default.**
- Aggregating across all workspaces (`workspace="*"`, `crossProject=true`)
  on the public `/api/recall` path is refused when no principal is bound
  (`httpAuth.ts:81`).
- Per-app tokens must carry `cross-workspace-read` / `cross-workspace-write`
  scope to act beyond their bound workspace (`tokens.ts:37`).
- **Cloud mode** requires the `X-Lore-Workspace` header on every `/api/*`
  request; without it the request is rejected
  (`src/mcp/http/middleware.ts:293`). The workspace id is then bound to
  the request via `bindWorkspaceToRequest`
  (`middleware.ts:305`), and every Dataplane read/write is scoped to that
  workspace.

The per-workspace key in `keyring.ts` is currently used only as a
keychain integration marker (see §11 — no Lore-side ciphertext exists
today). If a future encrypted substrate is wired, each workspace's
key is independent: deleting one workspace's key would render only
that workspace's ciphertext unreadable (`src/security/keyring.ts:43`).

---

## 8. Cloud tenant-isolation gate — `DATAPLANE_ORG_ID` (SW-05)

In cloud mode the **org id** scopes every read and write at the Dataplane.
A previous version fell back to the literal string `'default'` when
`DATAPLANE_ORG_ID` was unset — across six call sites — silently collapsing
**every tenant into one org** (cross-tenant data mixing).

This is now a **hard boot gate** (`requireDataplaneOrgId`,
`src/mcp/services.ts:60`): in cloud mode, if `DATAPLANE_ORG_ID` is unset
the daemon **refuses to start** with an explicit error rather than
defaulting. The two graph/storage factories that build Dataplane-bound
services call this gate before constructing the client
(`services.ts:100`, `:215`). Local mode never reaches the gate — it has no
org and uses `LocalGraph` / `VerbatimStore` — so local behavior is
unchanged.

> Honest caveat: two **legacy** keychain-upgrade paths
> (`services.ts:256`, `:306`) still read `DATAPLANE_ORG_ID ?? 'default'`
> directly. These run only in cloud mode, after the boot gate has already
> refused an unset org id, so the fallback is unreachable in practice —
> but the literal still appears in the source and is on the cleanup list.

---

## 9. Parent-environment scrub (`src/security/envScrub.ts`)

When an IDE spawns Lore as an MCP stdio subprocess, the child inherits the
parent's full environment — typically including `AWS_SECRET_ACCESS_KEY`,
`GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and arbitrary `*_TOKEN` / `*_SECRET`
vars sourced from the IDE's `.env`. Lore needs none of these, and holding
them in process memory widens the blast radius of any crash, log leak, or
redaction gap.

`scrubEnv()` deletes every environment variable **not on an explicit
allowlist** (`ALLOWED_VARS`, `envScrub.ts:34`).

**It runs only when Lore OWNS the process** — the daemon entry `main()`
(stdio *and* HTTP), which is reached behind `isProcessEntrypoint()` and is
the one call site that passes `createLore({ ownsProcess: true })`. A library
consumer that calls `createLore()` directly gets **no scrub**, in every
deployment mode.

That gate is load-bearing, not a nicety. `process.env` is process-GLOBAL: when
Lore is embedded in a host application, scrubbing it deletes the **host's** own
configuration. This shipped as a live defect (S9-EMBEDDED-ENV-SCRUB) — an
embedder lost `OPENROUTER_API_KEY` mid-process and every subsequent LLM call
failed with a misleading upstream `401`, while the key sat present and valid in
the host's `.env.local`. It reproduced in **all three** deployment modes, since
the scrub precedes mode resolution, and it fired even when Lore's own init
threw. Ownership — not `deploymentMode` — is the correct predicate: a host may
legitimately construct an in-process instance in `local` or `cloud` mode.
Regression coverage: `test/sp17-env-scrub-timing-unit.ts` (part A). The allowlist covers POSIX
essentials, the Node runtime, and Lore's own `LORE_*` / `DATAPLANE_*`
config knobs — nothing else survives. Adding an entry requires
justification; the source comments note this is a default-deny allowlist,
not a denylist. Dropped-variable names are logged only when they look
innocuous (names matching `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH` are
not echoed, since the *name* can itself be sensitive — `envScrub.ts:184`).

---

## 10. Secret storage

- **Encryption keys and API keys** live in the **OS keychain**
  (service `groundfloor-lore`), not on disk (`src/security/keyring.ts`).
  On macOS this is hardware-backed (Secure Enclave / Touch ID) for modern
  machines; keychain unlock happens at user login.
- **The daemon session token** (`auth.token`) and the **app-token registry**
  (`auth/registry.json`) are written `0600` (owner-only) and the registry
  stores only SHA-256 hashes.
- **Stderr logs redact node IDs**, which can be PII in a personal
  workspace, to a one-way short hash (`src/security/logRedact.ts`).

---

## 11. Known gaps (read this)

An honest accounting for your review:

- **No application-level encryption-at-rest.** Lore Core does **not**
  encrypt the live graph store (SurrealDB, the only graph engine), the
  LanceDB vector store, or the verbatim text on disk. At-rest
  confidentiality relies on OS/disk
  encryption (FileVault, LUKS, dm-crypt) for the user running the
  daemon. NW-7h removed the unused AES-GCM primitives that previously
  shipped alongside an inaccurate "verbatim opt-in flag" docstring —
  see `src/security/encryption.ts` for the residual scope (key
  generation for the keychain integration only). The keyring still
  mints a per-workspace key (`keyring.ts`) so a future encrypted
  substrate can be introduced with the call site, not before. See
  `COMPLIANCE.md §Encryption` for the operator-facing statement.
- **OpenTelemetry tracing is a provision-only shim**, not a wired
  exporter. See `COMPLIANCE.md §Observability`.
- **Audit log is hash-chained but not signed.** Since NW-7h, every
  record carries a `prevHash` field — SHA-256 of the previous record's
  serialized line — and `AuditLog.verifyChain()` (also exposed as
  `lore audit verify` over the CLI) detects any mid-file edit. This is
  **tamper-evident**, not tamper-proof: an attacker with daemon-side
  write access can rewrite the entire tail to re-link the chain. A
  cryptographic signature (per-record HMAC anchored to an off-host
  key) would close that gap and is deferred.
- **Local-mode ReBAC is cosmetic only.** See §5 — RBAC is enforced
  meaningfully in cloud mode (Dataplane + SpiceDB). Local mode has one
  bearer token and one operator with disk access. A deployment with an
  RBAC compliance requirement MUST run in cloud mode.
- **The L2 permission grammar is OR-only** today; AND/NOT semantics land
  in the SpiceDB cloud evaluator first.

---

## 12. Dependency vulnerability policy

CI (`bitbucket-pipelines.yml`) runs `npm audit --omit=dev --audit-level=high`
after install, failing the pipeline on any high/critical vulnerability in a
production dependency; dev-only tooling and moderate/low findings are out of
scope for that gate and are tracked instead in `docs/SECURITY_ADVISORIES.md`.
Renovate (`renovate.json`, installed via the Mend app for Bitbucket Cloud)
keeps dependencies current with weekly lockfile-only maintenance, grouped
minor/patch PRs, and immediate, unscheduled PRs for security advisories.

### Tracked exceptions to the high-severity gate (2026-09-03)

`npm audit fix` (non-breaking) was applied for `fast-uri`, `deepmerge-ts`,
`qs`, and `@xmldom/xmldom`, closing 6 of the 10 findings open at the time
the gate above was added. Two high-severity findings remain open and would
fail the gate on its first run; both were already assessed as NOT REACHABLE
/ ACCEPTED in `docs/SECURITY_ADVISORIES.md` (Fourth-Pass Audit, 2026-08-12)
before this gate existed, and no reachable fix exists yet:

- **`adm-zip` `<0.6.0`** (GHSA-xcpc-8h2w-3j85, via `onnxruntime-node` →
  `@huggingface/transformers`) — install-time only (unzips a prebuilt
  onnxruntime binary during `npm install`, never touches user-ingested
  content). No patched `adm-zip` exists in `onnxruntime-node`'s declared
  range (`fixAvailable: false`); the only path forward is an upstream
  `@huggingface/transformers` major release repinning `onnxruntime-node`.
- **`pdfjs-dist` `>=5.6.83 <6.2.108`** (GHSA-hq66-cqwq-w95j) — the
  vulnerable scripting-sandbox path requires `enableScripting: true`, which
  `packages/lore/src/engines/extractors/pdf.ts` never sets and which is
  architecturally absent from the `pdf.mjs` entry point it imports.
  Fixed in `pdfjs-dist@6.2.108`, a breaking major-version bump (5→6),
  deliberately deferred rather than taken as part of this dependency-audit
  pass.

**Update (2026-09-04, decision by Rafi):** the blanket `|| echo ...`
soft-fail above has been replaced. The CI step now runs
`scripts/audit-dependencies.mjs`, which parses `npm audit --omit=dev
--audit-level=high --json` and hard-fails the pipeline on *any*
high/critical advisory except the two GHSA IDs named above
(`GHSA-xcpc-8h2w-3j85` for adm-zip, `GHSA-hq66-cqwq-w95j` for pdfjs-dist),
which are matched explicitly against an `ALLOWLIST` const in that script
(kept in sync with this section). A genuinely new high/critical finding
now blocks the merge instead of only printing a warning. Remove an entry
from `ALLOWLIST` (and this section) once its fix lands.

---

## Source map (verify any claim here)

| Capability | File |
|-----------|------|
| Daemon localhost bind | `src/mcp/lifecycle.ts` |
| HTTP auth (Host/Origin/Bearer, constant-time) | `src/security/httpAuth.ts` |
| Per-app workspace tokens (hashed, scoped, TTL) | `src/auth/tokens.ts` |
| Clerk JWT validation (cloud) | `src/security/clerkAuth.ts` |
| ReBAC L1 relation edges | `src/security/rebac.ts` |
| ReBAC L2 permission evaluator | `src/security/rebacEvaluator.ts` |
| Cloud SpiceDB gate / authz wrapper | `src/security/rebacGate.ts`, `src/security/dataplaneAuthz.ts` |
| Cloud workspace/tenant binding | `src/mcp/http/middleware.ts` |
| Response security headers (nosniff/frame-deny/CSP/etc.) | `src/mcp/http/helpers.ts` (`applySecurityHeaders`, `buildHtmlExportCsp`), wired in `src/mcp/http/middleware.ts` |
| `DATAPLANE_ORG_ID` boot gate | `src/mcp/services.ts` (`requireDataplaneOrgId`) |
| Env scrub | `src/security/envScrub.ts` |
| Keychain key storage | `src/security/keyring.ts` |
| Stderr ID redaction | `src/security/logRedact.ts` |
