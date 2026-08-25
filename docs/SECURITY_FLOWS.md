# Lore Core Security Flows

Security model for the Lore MCP runtime — the TypeScript layer that handles plugin loading, tool registration, secret storage, consent gates, and route authorization. This document covers the structural guarantees that prevent user-supplied content from executing arbitrary code, and the runtime gates that protect sensitive operations.

---

## 1. Plugin Trust Model

Lore has two plugin tiers with fundamentally different trust properties.

### Tier 1 — Declarative manifests (user-droppable)

Users can add Tier 1 plugins by dropping YAML or JSON manifest files into `<LORE_HOME>/manifests/<name>/`. The daemon hot-reloads them without a restart.

**These plugins cannot execute arbitrary code.** A manifest is a data file. It can:
- Declare a schema (node types, edge types, property definitions)
- Specify ingest sources (`file:` or `url:` paths for the ingestion engine to crawl)
- Declare settings fields (secrets stored in Keychain, non-secrets in JSON)

A manifest cannot:
- Supply JavaScript or TypeScript
- Register MCP tools (tool registration requires TypeScript via `ILorePlugin.registerTools`)
- Invoke the host process, the network, or the filesystem directly

**Manifest validation** (`packages/lore/src/plugins/manifest/loader.ts`):
- YAML/JSON parsed with strict schema validation
- Ingest spec validated by `validatorIngest.ts`
- Invalid manifests are rejected at load time; daemon startup continues with the valid set
- A malformed manifest produces a warning in logs, not a crash

**Ingest source URLs** are declared in manifests and crawled by the ingestion engine. The URL format is validated structurally, but there is no denylist preventing a manifest from declaring `url: "http://localhost:6000/internal-api"` (SSRF surface — see §6).

### Tier 3 — TypeScript plugins (hardcoded, compiled in)

There are exactly three Tier 3 plugins:

```typescript
// packages/lore/src/plugins/registry.ts:33-38
const BUILTIN_PLUGINS: Map<string, ILorePlugin> = new Map([
    ['developer', developerPlugin],
    ['personal',  personalPlugin],
    ['legal',     legalPlugin],
]);
```

These are **static ES imports** compiled into the binary. There are no dynamic imports, no `require()` from user-supplied paths, no npm registry lookups. Adding a new Tier 3 plugin requires a code change and a rebuild. A user cannot inject TypeScript into this tier at runtime.

**Plugin boundary enforcement** (see `CLAUDE.md` in repo root):
- Core packages (`packages/lore/`) must never import from `packages/lore-plugin-*`
- Violation fails `npm run test:arch`
- ESLint `no-restricted-imports` warns in-editor

### What this means for security

A user with filesystem access to `<LORE_HOME>/manifests/` can install a Tier 1 plugin, but cannot execute code through it. A user who can modify the Lore source and rebuild can add a Tier 3 plugin, but that is the same as modifying the application itself. There is no code-injection surface between these two tiers.

---

## 2. Secret Storage

**File:** `packages/lore/src/config/keychain.ts`

Secrets (API keys, tokens) declared in plugin manifests are stored in the macOS Keychain, not in files or environment variables.

### Storage paths

| Data type | Storage location |
|-----------|-----------------|
| Plugin settings (non-secret) | `<LORE_HOME>/workspaces/<name>/.lore/config.json` |
| Plugin secrets (type: `'secret'`) | macOS Keychain (service: `groundfloor-lore`) |
| Dataplane API key | Keychain preferred; `DATAPLANE_API_KEY` env var as fallback |

### What the HTTP API returns

Plugin settings routes (`packages/lore/src/mcp/http/routes/plugins.ts`) return:
```json
{
  "fieldName": { "set": true }
}
```
Secret values are **never returned** through the HTTP API. The route returns only whether the secret has been set.

### Environment variable isolation

**File:** `packages/lore/src/security/envScrub.ts`

`scrubEnv()` runs at daemon startup before any module reads `process.env`. It deletes every environment variable not on the allowlist, including:
- `AWS_SECRET_ACCESS_KEY`, `AWS_ACCESS_KEY_ID`
- `GITHUB_TOKEN`, `GITLAB_TOKEN`
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`
- Any `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*KEY*` vars the parent IDE sourced

The allowlist contains ~40 entries — POSIX essentials (`HOME`, `PATH`, `TMPDIR`), Node runtime vars (`NODE_ENV`, `NVM_DIR`), and explicitly approved `LORE_*` vars.

Dropped variable names are logged (6 innocuous samples max) but names matching `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH` are excluded from the log to prevent secret names from appearing in stderr.

**Why this matters:** IDEs (Claude Code, Cursor) spawn Lore as an MCP stdio subprocess and the child inherits the parent shell environment. Without scrubbing, IDE secrets would be in Lore's process memory, widening the blast radius of any crash or log-redaction gap.

---

## 3. Approval Gates (Consent)

**File:** `packages/lore/src/security/consent.ts`

Tools registered with `requiresApproval: true` block until a human decision arrives before executing. This is the last-line defense against a motivated prompt injection that gets the LLM to issue a destructive tool call.

### How it works

1. Tool is called (e.g., `delete_node`, `retention.sweep.apply`)
2. Server calls `consentManager.request(toolName, args)` — returns a UUID and a Promise
3. SSE event `approval_needed` is emitted to the chat stream so the UI can show a modal
4. The tool's execution path `await`s the Promise
5. User clicks Approve or Deny in the UI → `POST /api/approval/:id` → `consentManager.resolve(id, approved)`
6. Promise resolves; tool either runs or returns an audit-logged "denied by user" string

### Timeout behavior

- Default timeout: **60 seconds**
- On timeout: Promise resolves with `{ approved: false, reason: 'timeout' }`
- On daemon shutdown: all pending approvals resolve with `{ approved: false, reason: 'shutdown' }`

The tool's execution path always gets a resolved Promise — no hanging awaits on shutdown.

### Which tools require approval

Tools that require approval are flagged at registration time in their `registerTools` hook. Currently includes:
- Node deletion (`action: 'delete'`)
- Retention sweep application
- Personal plugin write operations (diary entry delete, etc.)

---

## 4. Route Authorization

### Local mode

**File:** `packages/lore/src/security/routeGate.ts`

In local mode (`LORE_DEPLOYMENT_MODE=local`), `gateRoute()` always returns `{ allowed: true }`. The daemon runs on a single operator's machine; there is no meaningful multi-tenant identity to enforce against.

```typescript
if (deps.deploymentMode === 'local') {
    return { allowed: true };
}
```

All routes are accessible to any authenticated HTTP caller (the auth token is shared across all local clients).

### Cloud mode

In cloud mode, `gateRoute()` calls `requirePermission()` against the Dataplane SpiceDB instance. The permission check uses:
- **Actor**: Clerk JWT subject (the current user)
- **Resource**: the workspace ID from `AsyncLocalStorage` context (bound by the `X-Lore-Workspace` header middleware)
- **Permission**: `read` for GET routes, `write` for mutations

If no workspace ID is in the request context (missing header, middleware misfired), the gate returns denied with a descriptive error — it does not fail open.

### Rate limiting

**File:** `packages/lore/src/security/rateLimit.ts`

Token bucket limiter, one bucket per endpoint class. In-memory; resets on daemon restart.

| Bucket | Burst | Sustained rate |
|--------|-------|---------------|
| `chat` | 30 | 60 / min |
| `reconnect` | 2 | 5 / 10 min |
| `reconsume` | 2 | 5 / 10 min |
| `extract` | 10 | 30 / min |
| `destructive` (DELETE + known mutations) | 5 | 20 / min |
| `generic` (all other `/api/*`) | 100 | 300 / min |

**`/mcp` is not rate-limited here.** The MCP SDK manages session semantics directly; a per-endpoint bucket would need per-session accounting to be meaningful.

Rate limiting is per-daemon, not per-user. In local mode there is effectively one user, so this distinction doesn't matter. Cloud mode would need per-token sub-buckets (see §6).

---

## 5. MCP Tool Registration

**File:** `packages/lore/src/mcp/createMcpServer.ts`

All tools are registered at daemon startup via `registerXxxTools()` calls or plugin `registerTools` hooks. There is no dynamic tool registration at runtime from external sources.

Tool registration is **additive only at boot time**. Once the daemon is running, the tool catalog is fixed until a restart. Plugins cannot add or remove tools from a running daemon.

Each tool is tagged with its provenance at registration:
```typescript
// registry.ts:191-205
provenance: 'core'        // built-in knowledge tools
provenance: 'plugin:developer'  // tools from the developer plugin
provenance: 'plugin:personal'   // tools from the personal plugin
```

Clients can filter tools by provenance. The shim (`LORE_TOOL_SHIM=on`) hides all tools behind three meta-tools for token savings.

---

## 6. Known Gaps

### SSRF via manifest ingest URLs (Low)

**Location:** `packages/lore/src/plugins/manifest/loader.ts`, `validatorIngest.ts`

Tier 1 manifests can declare `url:` ingest sources. The URL is validated structurally (it's a string) but there is no denylist blocking `http://localhost`, `http://169.254.169.254` (AWS metadata), or other internal addresses.

**Current mitigations:**
- Tier 1 manifests live on the user's local disk — they are not fetched from the network
- The daemon does not currently allow remote manifest installation
- Ingestion only reads data from the URL; it does not execute it

**Recommended fix:** Before the remote-manifest marketplace ships (cloud roadmap item), add a URL denylist in the ingest validator that blocks private IP ranges (RFC 1918, RFC 5735, link-local).

### Local mode has no RBAC (Low)

**Location:** `routeGate.ts:69`

In local mode, all authenticated clients have equal access to all routes. There is no differentiation between an operator and a guest on the same machine.

This is intentional for the single-operator local model. When the user-app (`groundfloor-lore-app`) ships with shared-access scenarios, per-token RBAC will be needed.

### Rate limiting not per-user (Low)

**Location:** `rateLimit.ts`

Buckets are global to the daemon. A single user consuming the `chat` bucket's burst capacity (30 tokens) affects all other local clients.

In local mode (one user) this is fine. Cloud mode should sub-bucket by auth token.

### Unknown bucket fails open (Low)

**Location:** `rateLimit.ts:116–119`

If `classifyRequest()` returns a bucket name not in the config, `tryConsume()` returns `{ allowed: true }`. This shouldn't happen in practice (the classifier only returns known names), but it is a fail-open path.

**Fix:** return `{ allowed: false }` or log a warning for unknown bucket names.

---

## 7. Security-Relevant Files

| File | Purpose |
|------|---------|
| `packages/lore/src/security/envScrub.ts` | Parent-env isolation — allowlist scrub at startup |
| `packages/lore/src/security/consent.ts` | Approval gate for destructive tool calls |
| `packages/lore/src/security/routeGate.ts` | Deployment-mode-aware ReBAC wrapper |
| `packages/lore/src/security/rateLimit.ts` | Token-bucket rate limiter |
| `packages/lore/src/security/rebacGate.ts` | Raw SpiceDB permission check (cloud) |
| `packages/lore/src/config/keychain.ts` | macOS Keychain read/write for secrets |
| `packages/lore/src/plugins/registry.ts` | Hardcoded plugin catalog + provenance tagging |
| `packages/lore/src/plugins/manifest/loader.ts` | Tier 1 manifest parse and validation |
| `packages/lore/src/plugins/manifest/validatorIngest.ts` | Ingest spec schema validation |
| `packages/lore/src/mcp/http/routes/plugins.ts` | Settings management — returns `{set: bool}` only |
| `packages/lore/src/mcp/createMcpServer.ts` | Tool registration entry point |

---

## 8. Threat Model Summary

| Threat | Mitigated? | How |
|--------|-----------|-----|
| User injects TypeScript via plugin | Yes | Only 3 hardcoded Tier 3 plugins; Tier 1 is declarative YAML only |
| Tier 1 manifest executes code | Yes | Manifests are data; no code execution in the manifest loader |
| IDE spawns Lore with secret env vars | Yes | `scrubEnv()` deletes everything not on the allowlist at startup |
| Secret values leak via HTTP API | Yes | Routes return `{set: bool}` only — never the actual value |
| Destructive tool call from prompt injection | Partially | Consent gate on flagged tools; 60s auto-deny; not all tools are flagged |
| Unauthorized access in cloud mode | Yes | ReBAC SpiceDB check per route via `gateRoute()` |
| DoS via expensive route hammering | Partially | Token bucket per endpoint class; not per-user in local mode |
| SSRF via manifest ingest URL | Low risk now | No remote manifest install yet; no URL denylist in place |
| Credential exfiltration via plugin settings API | Yes | Only `{set: bool}` returned; secrets in Keychain |
