# Security Advisories

This file documents all open `npm audit` findings for `@groundfloor/lore`.
Format: VEX-style disposition — reachability assessment and remediation or
accepted-with-justification for each finding.

Last updated: 2026-08-12 (Fourth-Pass Audit, then same-day fix-and-verify —
see below). Historical passes (SW-28, NW-5c, TW-1a, TW-6c) are preserved
further down for audit-trail purposes; where the same package reappears in
the Fourth-Pass section, that write-up supersedes the older one.

---

## Summary (current, post-fix)

| Severity | Count | Actionable |
|----------|-------|------------|
| High     | 7     | 2 **FIXED** this pass — genuinely reachable (`sharp`, `mailparser`→`linkify-it`); 5 accepted (verified not reachable) |
| Moderate | 4     | 2 free hygiene bumps (`hono`, MCP SDK — not reachable either way, but zero-risk to take); 2 accepted/monitor (not reachable, blocked upstream) |
| Low      | 1     | 1 accepted (not reachable) |

`npm audit` reported **15 vulnerabilities** when this pass started, up from
the 12 SW-28 tracked (later reduced to 2 by TW-1a) — now **12**, after
fixing the two genuinely-reachable findings below. Most of the original
increase is five packages that didn't exist in the June tree at all —
`sharp`, `onnxruntime-node`, `pdfjs-dist`, `mailparser`, `adm-zip` — which
arrived with the document-extraction pipeline
(`packages/lore/src/engines/extractors/`: PDF/HEIC/email ingestion) added
after the June pass. **Two findings were genuinely reachable** through that
pipeline on untrusted, user-ingested file content — `sharp` (HEIC image
conversion) and `mailparser`→`linkify-it` (email parsing) — dispositioned
**FIX NOW** and then actually fixed the same day, not accepted-and-filed-
away. Everything else in this pass traces back to either an install-time-
only code path or an SDK subsystem (Hono, Express/OAuth helpers) that
Lore's own source never imports — verified by grepping the actual source
tree and reading the installed package internals, not inferred from the
dependency graph alone.

**Resolved since the last pass (TW-1a, 2026-06-15):** the `uuid` (bundled in
exceljs, GHSA-w5hq-g745-h8pq) and `exceljs` (proxy) findings TW-1a left open
as "upstream-blocked" are gone from today's audit — `npm ls uuid` now shows
`uuid@14.0.1 overridden`, closed by the `overrides` entry already present in
`package.json`. That's the exact mechanism recommended below for
`linkify-it`. Every other SW-28/NW-5c finding (esbuild, the original
fast-uri pair, `tmp`, the original protobufjs set, the original hono set,
the original ip-address CVE, `qs`, `nodemailer`) remains resolved as
previously documented; see those sections below for the historical record.

---

## High Severity

### GHSA-gv7w-rqvm-qjhr / GHSA-g7r4-m6w7-qqqr — esbuild (via tsx)

- **Package:** `esbuild` 0.17.0–0.28.0, pulled in by `tsx` (devDependency)
- **Advisories:**
  - GHSA-gv7w-rqvm-qjhr: Missing binary integrity verification in Deno module
    enables RCE via `NPM_CONFIG_REGISTRY`. CVSS 8.1.
  - GHSA-g7r4-m6w7-qqqr: Arbitrary file read on Windows when running the
    esbuild development server. CVSS 2.5 (low).
- **Reachability:** NOT REACHABLE in production. `tsx` and `esbuild` are used
  only as dev/build-time tools (TypeScript runner for tests and dev mode). The
  esbuild dev server is never started; the Deno module path is not used. The
  production binary is plain compiled JS (`tsc` output), with no esbuild
  runtime dependency.
- **Disposition:** ACCEPTED — dev-only tool, attack vectors not triggered.
  Track for upgrade when `tsx` publishes a release pinned to esbuild ≥0.28.1
  without breaking changes.
- **Remediation path:** `npm audit fix` would upgrade `tsx`; safe to do in an
  isolated upgrade sprint. No urgency in the current state.

### GHSA-q3j6-qgpj-74h6 / GHSA-v39h-62p7-jpjc — fast-uri (via @modelcontextprotocol/sdk → ajv)

- **Package:** `fast-uri` ≤3.1.1
- **Advisories:**
  - GHSA-q3j6-qgpj-74h6: Path traversal via percent-encoded dot segments.
    CVSS 7.5.
  - GHSA-v39h-62p7-jpjc: Host confusion via percent-encoded authority
    delimiters. CVSS 7.5.
- **Dependency chain:** `@modelcontextprotocol/sdk` → `ajv` → `fast-uri`
- **Reachability:** PARTIALLY REACHABLE. `fast-uri` is used by `ajv` for URI
  validation inside the MCP SDK's schema validation layer. However, the URI
  strings being validated are MCP tool names and JSON schema `$id` fields from
  our own code — not user-controlled arbitrary URI inputs from the network.
  Path traversal via percent-encoded segments requires attacker-controlled
  URI input passed to `fast-uri` directly, which does not occur in this call
  path.
- **Disposition:** ACCEPTED WITH JUSTIFICATION — URI inputs reaching `fast-uri`
  are developer-controlled schema identifiers, not user-supplied network data.
  Risk is low. Fix is blocked on `@modelcontextprotocol/sdk` releasing an `ajv`
  bump; Lore cannot safely override this transitive dependency unilaterally.
- **Remediation path:** Monitor `@modelcontextprotocol/sdk` releases. Upgrade
  when an SDK version ships with `fast-uri` ≥3.1.2.

### GHSA-66ff-xgx4-vchm / et al — protobufjs (via @huggingface/transformers → onnxruntime-web)

- **Package:** `protobufjs` ≤7.5.7
- **Advisories:**
  - GHSA-66ff-xgx4-vchm: Code injection through bytes field defaults. CVSS n/a.
  - GHSA-75px-5xx7-5xc7: Code generation gadget after prototype pollution.
    CVSS 8.1.
  - GHSA-jvwf-75h9-cwgg: Process-wide DoS via unsafe option paths. CVSS 7.5.
  - GHSA-685m-2w69-288q: DoS via unbounded protobuf recursion. CVSS 7.5.
  - GHSA-2pr8-phx7-x9h3: DoS from crafted field names. CVSS 5.3.
  - GHSA-fx83-v9x8-x52w: Prototype injection in message constructors. CVSS 5.3.
  - GHSA-jggg-4jg4-v7c6: DoS via unbounded recursive JSON expansion. CVSS 5.3.
- **Dependency chain:** `@huggingface/transformers` → `onnxruntime-web` →
  `protobufjs`
- **Reachability:** NOT REACHABLE for code injection. `protobufjs` is used
  internally by `onnxruntime-web` for deserializing ONNX model files. Model
  files are loaded from the local model cache (`~/.groundfloor/models/`) which
  is populated from Hugging Face Hub on first run — not from arbitrary
  user-supplied network input. An attacker would need to tamper with the local
  filesystem model cache to exploit the code-injection vectors, which requires
  local system access (out of scope for network threat model).
- **Disposition:** ACCEPTED — attack vector requires local filesystem write
  access to model files, which is not in our network threat model. DoS vectors
  are similarly gated on ONNX model deserialization, not user-facing inputs.
  Fix is blocked on `@huggingface/transformers` releasing a version that pins
  `onnxruntime-web` to a fixed `protobufjs`.
- **Remediation path:** Monitor `@huggingface/transformers` releases. Upgrade
  when `onnxruntime-web` (or its protobufjs dep) is patched.

### GHSA-ph9p-34f9-6g65 — tmp (via exceljs)

- **Package:** `tmp` <0.2.6
- **Advisory:** Path traversal via unsanitized prefix/postfix — allows a
  crafted prefix/postfix string to escape the intended temp directory.
- **Dependency chain:** `exceljs` → `tmp`
- **Reachability:** NOT REACHABLE. `tmp` inside `exceljs` is used for writing
  temporary workbook files during `.xlsx` generation. The prefix/postfix passed
  to `tmp` by exceljs are its own internal constants, not user-supplied values.
  A user cannot influence the `prefix`/`postfix` arguments via Lore's ingestion
  API.
- **Disposition:** ACCEPTED — exceljs controls the tmp call arguments;
  user-supplied data is not passed as prefix/postfix. Upgrade is blocked on
  exceljs releasing an update to `tmp` ≥0.2.6.
- **Remediation path:** Monitor exceljs releases; upgrade `exceljs` when a
  version with `tmp` ≥0.2.6 is published.

---

## Moderate Severity

### GHSA-q6x5-8v7m-xcrf — @protobufjs/utf8 (transitive via protobufjs → onnxruntime-web)

- **Package:** `@protobufjs/utf8` ≤1.1.0
- **Advisory:** Overlong UTF-8 decoding. CVSS 5.3.
- **Reachability:** NOT REACHABLE — same chain as `protobufjs` above.
  UTF-8 decoding only touches ONNX model binary data from trusted local files.
- **Disposition:** ACCEPTED — same justification as `protobufjs` finding above.

### GHSA-qp7p-654g-cw7p / et al — hono (direct dependency)

- **Package:** `hono` <4.12.21 (Lore pins `^4.12.14`)
- **Advisories:**
  - GHSA-qp7p-654g-cw7p: CSS injection via style object in JSX SSR. CVSS 4.3.
  - GHSA-hm8q-7f3q-5f36: Improper JWT NumericDate validation. CVSS 3.8.
  - GHSA-p77w-8qqv-26rm: Cache middleware leaks across users. CVSS 5.3.
  - GHSA-9vqf-7f2p-gf9v: bodyLimit() bypass for chunked requests. CVSS 6.5.
  - GHSA-69xw-7hcm-h432: Unvalidated JSX tag names → HTML injection. CVSS 4.7.
  - GHSA-xrhx-7g5j-rcj5: IP restriction bypass for non-canonical IPv6. CVSS 5.3.
  - GHSA-3hrh-pfw6-9m5x: Cookie sameSite/priority injection. CVSS 4.3.
  - GHSA-f577-qrjj-4474: JWT middleware accepts any Authorization scheme. CVSS 4.8.
  - GHSA-2gcr-mfcq-wcc3: app.mount() strips undecoded prefix. CVSS 5.3.
- **Reachability:** PARTIALLY REACHABLE. Lore uses Hono for its HTTP REST API.
  However:
  - JSX SSR (GHSA-qp7p): Lore does not use Hono's JSX SSR renderer. Not
    reachable.
  - Cache middleware leak (GHSA-p77w): Lore does not use Hono's built-in cache
    middleware. Not reachable.
  - bodyLimit bypass (GHSA-9vqf): Lore uses bodyLimit on ingestion routes.
    Chunked uploads may bypass the cap. MODERATE RISK — see remediation.
  - JWT scheme acceptance (GHSA-f577): Lore uses its own auth middleware
    (shared-secret + ephemeral tokens), not Hono's JWT helper. Not reachable.
  - IP restriction (GHSA-xrhx): Lore does not use Hono's IP restriction
    middleware. Not reachable.
  - Cookie injection (GHSA-3hrh): Lore does not set cookies. Not reachable.
  - app.mount routing (GHSA-2gcr): Lore uses app.route() with explicit paths,
    not app.mount(). Not reachable.
- **Disposition:** MONITOR — Upgrade hono to ≥4.12.21 at next routine dep bump.
  The bodyLimit bypass (GHSA-9vqf) is the only potentially reachable vector;
  mitigated by existing request-size caps in the ingestion route layer and the
  fact that Lore runs as a local daemon (not internet-facing by default).
- **Remediation path:** `npm install hono@latest` — safe minor version bump,
  no API changes. Target: include in next routine dep-bump sprint.

### GHSA-v2v4-37r5-5v8g — ip-address (via express-rate-limit)

- **Package:** `ip-address` ≤10.1.0
- **Advisory:** XSS in Address6 HTML-emitting methods. CVSS 0 (not scored yet).
- **Dependency chain:** `express-rate-limit` → `ip-address`
- **Reachability:** NOT REACHABLE. The `Address6#toHtml()` method (the
  vulnerable API) is never called by Lore or `express-rate-limit`. The rate
  limiter uses `ip-address` for IP normalization (parsing/comparison), not for
  HTML output. Lore does not render HTML from IP addresses.
- **Disposition:** ACCEPTED — HTML-emitting methods are not invoked.

### GHSA-q8mj-m7cp-5q26 — qs (transitive)

- **Package:** `qs` 6.11.1–6.15.1
- **Advisory:** DoS via `qs.stringify` crash on null/undefined in comma-format
  arrays with `encodeValuesOnly`. CVSS 5.3.
- **Dependency chain:** Transitive — not a direct Lore dependency.
- **Reachability:** NOT REACHABLE. Lore does not call `qs.stringify` with
  comma-format arrays. The affected code path requires explicit opt-in to
  `{arrayFormat: 'comma', encodeValuesOnly: true}`.
- **Disposition:** ACCEPTED — the crashing call signature is not used.

### GHSA-w5hq-g745-h8pq — uuid (via exceljs)

- **Package:** `uuid` <11.1.1 (bundled inside `exceljs`)
- **Advisory:** Missing buffer bounds check in v3/v5/v6 when `buf` is provided.
  CVSS 7.5.
- **Dependency chain:** `exceljs` → `uuid` 10.x
- **Reachability:** NOT REACHABLE. Lore uses exceljs to read XLSX files; it
  does not call uuid v3/v5/v6 with a caller-supplied `buf` parameter. The
  vulnerable API requires explicit caller opt-in to buffer output mode.
- **Disposition:** ACCEPTED — the `buf`-parameter path is not invoked. Fix
  requires exceljs to upgrade its internal uuid dependency.
- **Remediation path:** Monitor exceljs releases; upgrade when exceljs ships
  with uuid ≥11.1.1.

---

## Deprecated Transitive Packages (Low Priority)

These packages appear in `npm audit` output as deprecated warnings. They are
all transitive dependencies (not directly imported by Lore source code).
Fixing them requires upstream changes in the packages that pull them in.

| Package | Version | Deprecated Reason | Pulled in by |
|---------|---------|------------------|--------------|
| `inflight` | 1.x | Memory leak; use lru-cache | archiver (via exceljs) |
| `glob` (v7/v8) | <10 | Old versions unsupported | archiver-utils, rimraf, zip-stream |
| `rimraf` | v2/v3 | Versions <v4 unsupported | exceljs → archiver |
| `fstream` | 1.x | No longer supported | exceljs → archiver |
| `boolean` | 3.x | Package no longer supported | better-sqlite3 |
| `lodash.isequal` | 4.x | Use `util.isDeepStrictEqual` | exceljs |
| `prebuild-install` | 7.x | No longer maintained | better-sqlite3 |
| `uuid` (in exceljs) | 10.x | uuid@10 and below unsupported | exceljs |

These are known and low-priority. Fixing them requires upstream releases from
`exceljs` and `better-sqlite3`. Do not attempt to bump these transitive deps
directly — they are not imported by Lore's own source code and a forced
override risks binary incompatibilities.

---

## Tracking

| Finding | CVE/GHSA | Severity | Status | Next Action |
|---------|----------|----------|--------|-------------|
| esbuild (tsx) | GHSA-gv7w, GHSA-g7r4 | High | Accepted (dev-only) | Upgrade tsx when available |
| fast-uri (MCP SDK) | GHSA-q3j6, GHSA-v39h | High | Accepted | Monitor MCP SDK upgrades |
| protobufjs (transformers) | GHSA-66ff et al | High | Accepted (local files) | Monitor transformers upgrades |
| tmp (exceljs) | GHSA-ph9p | High | Accepted | Monitor exceljs upgrades |
| hono | GHSA-9vqf et al | Moderate | Monitor | Upgrade hono ≥4.12.21 |
| @protobufjs/utf8 | GHSA-q6x5 | Moderate | Accepted | Same as protobufjs above |
| ip-address (rate-limit) | GHSA-v2v4 | Moderate | Accepted (no HTML emit) | Monitor express-rate-limit |
| qs | GHSA-q8mj | Moderate | Accepted | Monitor upstream |
| uuid (exceljs) | GHSA-w5hq | Moderate | Accepted | Monitor exceljs upgrades |

---

## Second-Pass Audit — NW-5c (2026-06-15)

This section documents the second audit pass. Round 1 (SW-28) dispositioned the
12 findings as of 2026-06-13. This pass ran a fresh `npm audit` and actioned
every finding: 8 were closed by lockfile bumps; 4 remain upstream-blocked and
are re-dispositioned below.

### What changed since SW-28

The baseline shifted because `npm update` successfully bumped 8 packages:

| Package | Before | After | Fixed advisory |
|---------|--------|-------|---------------|
| `hono` | 4.12.14 | 4.12.25 | GHSA-qp7p, GHSA-hm8q, GHSA-p77w, GHSA-9vqf, GHSA-69xw, GHSA-xrhx, GHSA-3hrh, GHSA-f577, GHSA-2gcr |
| `tsx` | 4.21.0 | 4.22.4 | (pulls in esbuild 0.28.1) |
| `esbuild` | 0.27.4 | 0.28.1 | GHSA-gv7w, GHSA-g7r4 |
| `fast-uri` | 3.1.0 | 3.1.2 | GHSA-q3j6, GHSA-v39h |
| `express-rate-limit` | 8.3.1 | 8.5.2 | (pulls in ip-address 10.2.0) |
| `ip-address` | 10.1.0 | 10.2.0 | GHSA-v2v4 |
| `qs` | 6.15.0 | 6.15.2 | GHSA-q8mj |
| `tmp` | 0.2.5 | 0.2.7 | GHSA-ph9p |

All bumps were **lockfile-only** (no `package.json` range changes needed; all
patched versions fell within existing semver ranges). `npm audit fix --force`
was NOT used.

**SDK file: link note (SW-10 / NW-5d BLOCKED):** The `groundfloor-ts-sdk`
dependency is currently a `file:../../v3/groundfloor-ts-sdk` path reference.
This means it does not appear in `npm audit` output and cannot be audited by
the registry. This is a known limitation tracked as SW-10 (parked: awaiting
SDK team to publish to a registry). Once SW-10 lands, a follow-up audit pass
must cover the SDK's own dependency tree. Do NOT attempt to audit or fix this
in the current pass.

### Remaining findings after lockfile bumps (4 total: 1 high, 3 moderate)

All four are **upstream-blocked** — no lockfile-only bump is possible without
breaking changes.

---

#### GHSA-66ff-xgx4-vchm / GHSA-75px-5xx7-5xc7 / et al — protobufjs (HIGH, upstream-blocked)

- **Package:** `protobufjs` 7.5.5 (current installed; vuln range ≤7.5.7)
- **Dependency chain:** `@huggingface/transformers` → `onnxruntime-node` +
  `onnxruntime-web` → `protobufjs`
- **Why un-bumpable:** `onnxruntime-node` 1.24.3 (pinned by
  `@huggingface/transformers` 4.1.0) requires `protobufjs` in a range that
  does not include a patched release. `npm audit` reports fixAvailable=true
  but the fix requires upgrading `@huggingface/transformers` to a version that
  pins a newer onnxruntime — which does not yet exist on npm as of 2026-06-15.
  A `--force` bump would break ONNX model deserialization at runtime.
- **Reachability:** NOT REACHABLE for code injection (unchanged from SW-28).
  `protobufjs` is used internally by onnxruntime to deserialize ONNX model
  binary files loaded from the local model cache (`~/.groundfloor/models/`).
  Model files are populated from Hugging Face Hub — not from user-supplied
  network input. Exploiting code injection (GHSA-66ff, GHSA-75px) requires
  writing a crafted protobuf into the local model cache, which requires local
  filesystem write access (out of scope for network threat model). DoS vectors
  (GHSA-jvwf, GHSA-685m, GHSA-2pr8, GHSA-jggg) are similarly gated on ONNX
  model deserialization, not user-facing API inputs.
- **Disposition:** ACCEPTED — attack vectors require local filesystem write
  access; not in the network threat model. This disposition is unchanged from
  SW-28. Will re-evaluate when `@huggingface/transformers` releases an update
  that pins a fixed onnxruntime version.
- **Monitoring posture:** Check `@huggingface/transformers` releases monthly.
  Re-evaluate when onnxruntime ≥1.25.0 ships with a patched `protobufjs`.

---

#### GHSA-q6x5-8v7m-xcrf — @protobufjs/utf8 (MODERATE, upstream-blocked)

- **Package:** `@protobufjs/utf8` 1.1.0 (vuln range ≤1.1.0)
- **Dependency chain:** `protobufjs` → `@protobufjs/utf8`
- **Why un-bumpable:** Same as `protobufjs` above — `@protobufjs/utf8` is a
  pinned sub-dependency of `protobufjs`; upgrading it independently of
  `protobufjs` is not safe.
- **Reachability:** NOT REACHABLE — same analysis as `protobufjs`. UTF-8
  decoding occurs on ONNX model binary data from trusted local files.
- **Disposition:** ACCEPTED — identical justification to `protobufjs`. Resolves
  automatically when the protobufjs chain is upgraded.
- **Monitoring posture:** Same as protobufjs — no independent action needed.

---

#### GHSA-w5hq-g745-h8pq — uuid (MODERATE, upstream-blocked)

- **Package:** `uuid` <11.1.1 (bundled in `exceljs/node_modules/uuid`)
- **Dependency chain:** `exceljs@4.4.0` → own `node_modules/uuid` (10.x)
- **Why un-bumpable:** `npm audit fix` reports the fix as exceljs downgrade to
  3.4.0 (isSemVerMajor=true). exceljs 3.4.0 is a major downgrade; it has a
  different API surface for XLSX reading that would break Lore's document
  ingestion pipeline. No exceljs 4.x release ships a patched uuid.
- **Reachability:** NOT REACHABLE (unchanged from SW-28). Lore calls exceljs
  to read XLSX files; it does not invoke `uuid.v3/v5/v6()` with a
  caller-supplied `buf` parameter. The vulnerable path requires explicit
  opt-in to buffer-output mode.
- **Disposition:** ACCEPTED — the `buf`-parameter path is not invoked. The
  fix (exceljs 3.4.0) would be a regression. Accept until exceljs 4.x ships
  with uuid ≥11.1.1.
- **Monitoring posture:** Watch exceljs changelog for a uuid upgrade in the
  4.x stream. Re-evaluate if Lore begins calling uuid v3/v5/v6 directly.

---

#### exceljs (MODERATE, upstream-blocked)

- **Package:** `exceljs@4.4.0` (reported vulnerable because it bundles uuid <11.1.1)
- **Why un-bumpable:** Same as `uuid` above — the "fix" is a major downgrade
  to 3.4.0. No patched exceljs 4.x is available as of 2026-06-15.
- **Reachability:** NOT REACHABLE — the vulnerability is the bundled uuid
  (analyzed above), not exceljs itself. Lore's XLSX reading path does not
  invoke the vulnerable uuid API.
- **Disposition:** ACCEPTED — the exceljs finding is a proxy for the uuid
  bundling issue. Same justification and monitoring posture as uuid above.

---

### Second-pass tracking table

| Finding | CVE/GHSA | Severity | Resolution | Notes |
|---------|----------|----------|------------|-------|
| hono (9 CVEs) | GHSA-qp7p et al | Moderate | **FIXED** — bumped to 4.12.25 | |
| esbuild (2 CVEs) | GHSA-gv7w, GHSA-g7r4 | High | **FIXED** — bumped to 0.28.1 via tsx@4.22.4 | Was dev-only; now actually patched |
| fast-uri (2 CVEs) | GHSA-q3j6, GHSA-v39h | High | **FIXED** — bumped to 3.1.2 | |
| express-rate-limit | (CVE pending) | Moderate | **FIXED** — bumped to 8.5.2 | |
| ip-address | GHSA-v2v4 | Moderate | **FIXED** — bumped to 10.2.0 via express-rate-limit | |
| qs | GHSA-q8mj | Moderate | **FIXED** — bumped to 6.15.2 | |
| tmp | GHSA-ph9p | High | **FIXED** — bumped to 0.2.7 | |
| tsx (via esbuild) | GHSA-gv7w, GHSA-g7r4 | High | **FIXED** — bumped to 4.22.4 | |
| protobufjs | GHSA-66ff et al | High | ACCEPTED (upstream-blocked) | Monitor @huggingface/transformers |
| @protobufjs/utf8 | GHSA-q6x5 | Moderate | ACCEPTED (upstream-blocked) | Resolves with protobufjs fix |
| uuid (in exceljs) | GHSA-w5hq | Moderate | ACCEPTED (upstream-blocked) | Monitor exceljs 4.x |
| exceljs | (uuid proxy) | Moderate | ACCEPTED (upstream-blocked) | Same as uuid above |

**`npm audit` result after this pass: 4 total (1 high, 3 moderate) — all
upstream-blocked with accepted dispositions above.**

Previous count (SW-28 baseline): 12 total (5 high, 7 moderate).
Net improvement: −8 findings closed by lockfile bumps.

---

## Third-Pass Audit — TW-1a (2026-06-15)

This section documents the third audit pass, performed as part of Wave 1 of
SWARM_QUEUE_3 (TW-1a). Base: `swarm/integration-3` at commit `537a705`.

### What changed since NW-5c

`npm audit fix` (without `--force`) was run in the worktree. It successfully
bumped 4 packages:

| Package | Before | After | Fixed advisories |
|---------|--------|-------|-----------------|
| `protobufjs` | 7.5.5 | 7.6.4 | GHSA-66ff, GHSA-75px, GHSA-jvwf, GHSA-685m, GHSA-2pr8, GHSA-fx83, GHSA-jggg, GHSA-f38q, GHSA-wcpc |
| `@protobufjs/utf8` | 1.1.0 | 1.1.1 | GHSA-q6x5 |
| `nodemailer` | 8.0.5 | 9.0.0 | GHSA-268h, GHSA-wqvq, GHSA-r7g4 |
| `mailparser` | 3.9.8 | 3.9.10 | (transitive; carries nodemailer 9.0.0) |

All bumps are **lockfile-only** (no `package.json` range changes needed; all
patched versions fell within existing semver ranges). `--force` was NOT used.

The NW-5c pass had dispositioned protobufjs as "upstream-blocked" based on
`onnxruntime-web` pinning; however, `npm audit fix` resolved this by finding a
compatible `protobufjs@7.6.4` within the `^7.2.4` range that `onnxruntime-web`
accepts — the lockfile can be updated without breaking binary compatibility.

**SDK file: link note (SW-10 / TW-1b BLOCKED):** The `groundfloor-ts-sdk`
dependency remains a `file:../../v3/groundfloor-ts-sdk` path reference and is
not auditable by the registry. This is tracked as TW-1b (BLOCKED-PARKED,
awaiting SDK publish). Do NOT attempt to audit or fix this in the current pass.

### Remaining findings after lockfile bumps (2 total: 0 high, 2 moderate)

Both are **upstream-blocked** — the same uuid/exceljs findings from NW-5c.
Dispositions are unchanged.

#### GHSA-w5hq-g745-h8pq — uuid (MODERATE, upstream-blocked, unchanged)

- **Package:** `uuid` <11.1.1 (bundled in `exceljs@4.4.0`)
- **Why un-bumpable:** Fix requires downgrading exceljs to 3.4.0 (breaking
  change). No exceljs 4.x with uuid ≥11.1.1 is published as of 2026-06-15.
- **Reachability:** NOT REACHABLE — same analysis as NW-5c. The `buf`-parameter
  path of `uuid.v3/v5/v6` is not invoked by Lore or exceljs's internal call
  paths.
- **Disposition:** ACCEPTED (unchanged from NW-5c) — buf-parameter path not
  invoked; exceljs 3.4.0 would be a regression. Monitor exceljs 4.x releases.

#### exceljs (MODERATE, upstream-blocked, unchanged)

- **Package:** `exceljs@4.4.0` (reported vulnerable because it bundles uuid <11.1.1)
- **Disposition:** ACCEPTED (unchanged from NW-5c) — proxy for the uuid finding
  above; no direct vulnerability in exceljs's own code paths used by Lore.

### Third-pass tracking table

| Finding | GHSA | Severity | Resolution | Notes |
|---------|------|----------|------------|-------|
| protobufjs (9 advisories) | GHSA-66ff et al | High/Moderate | **FIXED** — bumped to 7.6.4 | Lockfile-only |
| @protobufjs/utf8 | GHSA-q6x5 | Moderate | **FIXED** — bumped to 1.1.1 | Lockfile-only |
| nodemailer (3 advisories) | GHSA-268h, GHSA-wqvq, GHSA-r7g4 | Moderate | **FIXED** — bumped to 9.0.0 | Via mailparser@3.9.10 |
| uuid (in exceljs) | GHSA-w5hq | Moderate | ACCEPTED (upstream-blocked) | Unchanged from NW-5c |
| exceljs | (uuid proxy) | Moderate | ACCEPTED (upstream-blocked) | Unchanged from NW-5c |

**`npm audit` result after this pass: 2 total (0 high, 2 moderate) — both
upstream-blocked with accepted dispositions above.**

Previous count (NW-5c baseline): 4 total (1 high, 3 moderate).
Net improvement: −2 findings closed by lockfile bumps (protobufjs chain + nodemailer chain).

---

## Fourth-Pass Audit — 2026-08-12

Fresh `npm audit` (raw JSON captured this pass) shows **15 vulnerabilities**
(1 low, 4 moderate, 10 high, 0 critical) across 473 total dependencies (216
prod, 69 dev, 216 optional). Every finding below was investigated against
the actual installed package internals and Lore's own source — not just the
audit's dependency-chain summary — per the methodology: (1) is it a runtime
dep or dev/build-only, (2) does Lore's own code path actually reach the
vulnerable function, (3) is a non-breaking fix available, (4) disposition.

Five packages here didn't exist in the June tree: `sharp`, `onnxruntime-node`,
`pdfjs-dist`, `mailparser`, `adm-zip`. All five arrived with the extractor
pipeline (`packages/lore/src/engines/extractors/`) that gives Lore's
ingestion tools (`read_document_for_ingestion`, `reprocess_document`,
`/api/ingest/file`, `/api/ingest/reprocess`) the ability to pull text out of
PDFs, HEIC/HEIC images, XLSX, DOCX, and EML files. That pipeline is the
first place in this repo where a `dependencies`/`optionalDependencies`
package runs directly against attacker-controlled *file content* (as
opposed to developer-authored config or locally-cached model files), so it
gets the most scrutiny below.

### sharp — GHSA-f88m-g3jw-g9cj (HIGH, direct dependency, REACHABLE — RESOLVED 2026-08-12)

- **Status: FIXED.** Bumped to `^0.35.3` in `package.json`. `@huggingface/
  transformers` pinned its own nested `sharp@0.34.5` copy that the bare
  version bump alone did not dedupe — added `"sharp": "^0.35.3"` to
  `overrides` as well so every resolution in the tree lands on the fixed
  version (`npm ls sharp` now shows a single `0.35.3 overridden` — no
  second copy). Smoke-tested the exact `sharp(input).jpeg({quality:90})
  .toBuffer()` call `image.ts` uses against a synthetic image; verified
  the output is a valid JPEG. Full test suite green after.
- **Package:** `sharp` 0.34.5 (installed; vulnerable range `<0.35.0`).
  Declared as an `optionalDependency` (`^0.34.5`).
- **Advisory:** Inherited libvips vulnerabilities — CVE-2026-33327 / CVE-2026-33328
  (integer overflow → heap buffer overflow in the generic `vipsload`
  dimension-calculation path; CVSSv4 7.0, high) and CVE-2026-35590 /
  CVE-2026-35591 (heap buffer overflow in the EXIF-tag-range validation used
  across JPEG/TIFF/HEIF decoding). Patched in libvips 8.18.1 / sharp 0.35.0.
- **Reachability: REACHABLE.** `packages/lore/src/engines/extractors/image.ts:86-89`
  (`heicExtractor`) calls `sharp(input).jpeg({ quality: 90 }).toBuffer()`
  directly on raw HEIC/HEIF bytes. `input` is whatever a user or agent asks
  Lore to ingest through `read_document_for_ingestion` / `/api/ingest/file`
  — iPhone photos default to HEIC, so this is a mainstream path, not an edge
  case. The path-allowlist gate (`assertPathAllowed`) restricts *where* the
  file may live on disk; it says nothing about the file's *content*, which
  is exactly the untrusted input this pipeline exists to process. Both bugs
  are format-generic rather than GIF/TIFF-only as a shallow read of the
  advisory's workaround section might suggest: the `vipsload` dimension bug
  sits in libvips' general image-loading path, and the EXIF bug fires on any
  format carrying EXIF metadata — which HEIC/HEIF from iPhones routinely
  does. This is the clearest currently-reachable high-severity finding in
  this pass.
- **Disposition: FIX NOW.** Do not accept-and-defer this one.
- **Remediation path:** `fixAvailable: false` in the raw audit — sharp is
  pre-1.0, so npm treats the 0.34→0.35 bump as a breaking change requiring
  a manual `package.json` edit rather than a lockfile-only fix.
  `@huggingface/transformers` also pins `sharp: ^0.34.5` for its own
  (unrelated, unused-by-Lore) vision-pipeline code, but that only means it
  gets its own nested copy — it doesn't block Lore's own install. Latest is
  `0.35.3`. Bump the `optionalDependencies` range to `^0.35.3`, reinstall,
  and run `npm run test:extractors` plus a manual HEIC-ingestion smoke test
  before shipping — sharp's public API has stayed stable across this
  boundary historically, but the libvips version bump underneath it
  warrants an actual test pass, not just a lockfile edit.

### mailparser / linkify-it — GHSA-v245-v573-v5vm (HIGH, direct + transitive, REACHABLE — RESOLVED 2026-08-12)

- **Status: FIXED.** Added `"linkify-it": ">=5.0.2"` to `overrides`, the
  same mechanism already resolving the June `uuid`/`exceljs` findings.
  `npm ls linkify-it` now shows the overridden version, forcing
  `mailparser`'s exact `5.0.1` pin. Full test suite green after.
- **Package:** `linkify-it` 5.0.1 (vulnerable range `<=5.0.1`), pinned by an
  **exact** version match inside `mailparser`'s own `package.json`
  (`"linkify-it": "5.0.1"`, no caret/tilde) — `mailparser` 3.9.10, declared
  as an `optionalDependency` (`^3.9.8`) of Lore.
- **Advisory:** Quadratic-complexity DoS via the `mailto:` validator's
  scan loop when run against attacker-controlled text. CVSS 7.5.
- **Reachability: REACHABLE.** `packages/lore/src/engines/extractors/eml.ts:48`
  calls `mailparser.simpleParser(input)` directly on raw, fully
  attacker-controlled email bytes — reachable via the same ingestion tools
  as above. `mailparser`'s `textToHtml()`
  (`node_modules/mailparser/lib/mail-parser.js:1132`) runs whenever a
  message has a plain-text body and `skipTextToHtml` isn't set — the
  default, and `eml.ts` passes no options — and calls `linkify.match(str)`
  on that body to auto-generate an HTML view. An email is about as
  adversarial an input as exists: any sender controls the body. A single
  malicious `.eml` (a forwarded phishing email, a synced-mailbox export, a
  message a user asks Lore to index) can hang extraction with a crafted
  `mailto:` string.
- **Disposition: FIX NOW.**
- **Remediation path:** `mailparser`'s exact pin blocks a plain
  `npm update`, but `package.json` already has precedent for exactly this
  situation — the existing `overrides` block already force-bumps two of
  `mailparser`'s other exact-pinned, previously-vulnerable transitive deps
  (`"nodemailer": ">=9.0.1"`, `"uuid": ">=9.0.1"`). That's the same
  mechanism that closed the June `uuid`/`exceljs` findings (confirmed
  resolved this pass — see Summary above). Add
  `"linkify-it": ">=5.0.2"` (the patch release immediately after the
  vulnerable 5.0.1, minimizing API-compat risk) to the same `overrides`
  block, `npm install`, and re-run the extractor tests. Note there's no
  dedicated `.eml` fixture in `npm run test:extractors` today — worth
  adding one alongside this fix, or at minimum manually exercising
  `read_document_for_ingestion` against an `.eml` file to confirm
  `linkify-it` ≥5.0.2 still behaves correctly inside `mailparser`.
- **Note:** the separate `mailparser` row in this audit (high) is the same
  finding re-reported at the direct-dependency level — there is no distinct
  mailparser CVE in this pass. Fixing `linkify-it` resolves both rows.

### pdfjs-dist — GHSA-hq66-cqwq-w95j / CVE-2026-16633 (HIGH, direct dependency, verified NOT reachable today)

- **Package:** `pdfjs-dist` 5.6.205 (vulnerable range `>=5.6.83 <6.2.108`).
  Declared as an `optionalDependency` (`^5.6.205`).
- **Advisory:** "Arbitrary JavaScript execution upon opening a malicious
  PDF." CVSS 8.6.
- This is the finding the task brief flagged as a likely high-priority
  reachable risk, since `pdf.ts` runs on raw ingested PDF bytes. Checked
  against the actual advisory text and the installed package source rather
  than assumed from the title:
  - The upstream advisory itself states the vulnerability requires
    **`enableScripting: true`** — an opt-in the embedding application must
    set explicitly — plus the absence of a Content Security Policy, and
    fires through PDF.js's scripting-sandbox execution path. It also
    requires user interaction.
  - `packages/lore/src/engines/extractors/pdf.ts:61` calls
    `pdfjs.getDocument({ data, verbosity: 0, disableFontFace: true, useSystemFonts: false })`
    — no `enableScripting` option — followed only by `doc.getPage()` /
    `page.getTextContent()` / `doc.getMetadata()`. It never calls
    `page.render()`, never instantiates `AnnotationLayer`, never touches
    the scripting sandbox.
  - Checked the installed bundle directly
    (`node_modules/pdfjs-dist/legacy/build/pdf.mjs`, the exact entry point
    `pdf.ts` imports): the only `enableScripting` reference reachable from
    `getDocument()`'s code paths lives inside `AnnotationLayer.render()` (a
    DOM-rendering class Lore never calls), where it defaults to
    `params.enableScripting === true` — off unless a caller opts in. The
    `PDFScriptingManager` / `getJavaScript()` machinery that actually runs
    untrusted PDF JavaScript doesn't exist anywhere in this bundle — it
    lives in the separate `pdf.sandbox.*.mjs` file and the browser-facing
    PDF.js *viewer* application (`web/app.js`), neither of which `pdf.ts`
    imports.
- **Reachability: NOT REACHABLE today.** `pdf.ts` is a pure "bytes in, text
  out" consumer of the core library's document/text APIs; the vulnerable
  scripting-sandbox path is architecturally absent from the code Lore loads
  and calls.
- **Disposition: MONITOR — not accept-and-forget.** This is a direct
  dependency processing untrusted files by design, and the safety margin
  rests entirely on "we never call `page.render()` / never enable
  scripting" — one careless future PR away from changing (e.g. adding
  thumbnail rendering for the scanned-PDF quality-warning path). Recommend:
  (a) pass an explicit `enableScripting: false` to the `getDocument()` call
  as defense-in-depth so this stays true even as usage grows, and (b) track
  the upgrade to `pdfjs-dist` ≥6.2.108 as routine hygiene rather than
  urgent remediation.
- **Remediation path:** `fixAvailable` proposes `5.5.207` — a *downgrade*
  below the vulnerable band, not a real fix. The actual fix is a
  major-version bump to ≥6.2.108 (`pdfjs-dist` isn't a 0.x package, so 5→6
  is a real breaking-change boundary); verify the
  `pdfjs-dist/legacy/build/pdf.mjs` entry point still exists and behaves
  the same in v6 before bumping `^5.6.205` → `^6.2.108`.

### @hono/node-server — GHSA-frvp-7c67-39w9 (MODERATE, direct-declared but not imported, NOT reachable)

- **Package:** `@hono/node-server` 1.19.14 (installed; vulnerable range
  `<2.0.5`). Declared `^1.19.14` in `dependencies`.
- **Advisory:** Path traversal in `serve-static` on Windows via encoded
  backslash (`%5C`). CVSS 5.9.
- Declared as a DIRECT dependency, but `grep -rn "from '@hono/node-server'"
  packages/lore/src` returns zero matches — nothing in Lore's own code
  imports it. It's declared solely to pin the version
  `@modelcontextprotocol/sdk` resolves internally (the SDK's own
  `package.json` pins `@hono/node-server: ^1.19.9`) — the same pattern
  Lore already uses for `nodemailer`/`uuid` via `overrides`, applied here
  via a direct-dependency version pin instead.
- **Reachability: NOT REACHABLE.** The SDK's `server/streamableHttp.js` —
  which Lore *does* instantiate
  (`packages/lore/src/mcp/http/routes/mcp.ts:56`,
  `new StreamableHTTPServerTransport(...)`) — imports exactly one symbol
  from `@hono/node-server`: `getRequestListener`, defined in
  `dist/index.js`. The vulnerable `serveStatic` function lives in a
  separate file, `dist/serve-static.js`, that neither the SDK nor Lore ever
  imports. Lore's daemon doesn't serve static files at all.
- **Disposition: ACCEPTED** — confirmed not reachable.
- **Remediation path:** `fixAvailable` proposes `2.1.0` (semver-major). Low
  priority given non-reachability, and risky to force unilaterally: the
  SDK itself still pins `^1.19.9`, so a forced v2 could desync from what
  `streamableHttp.js` expects if the `getRequestListener` API changed
  between majors. Wait for the SDK to move to v2 first, or verify
  compatibility before forcing.

### @modelcontextprotocol/sdk (MODERATE, direct dependency, rollup — NOT reachable)

- **Package:** `@modelcontextprotocol/sdk` 1.28.0 installed (declared
  `^1.12.1`).
- Flagged moderate solely via its `@hono/node-server` dependency (same
  GHSA-frvp-7c67-39w9 as above) — no standalone SDK CVE in this pass.
- **Reachability: NOT REACHABLE** — see `@hono/node-server` above.
- **Disposition: ACCEPTED** (not reachable). Free hygiene win available:
  `1.30.0` is in-range (`^1.12.1`) and a minor/patch bump — worth taking at
  the next routine dependency pass, though it doesn't change the
  reachability story either way.

### hono (MODERATE, direct-declared but not imported — 7 advisories, NOT reachable)

- **Package:** `hono` 4.12.25 (installed; vulnerable range `<=4.12.33`).
  Declared `^4.12.14`.
- **Advisories:** GHSA-xgm2-5f3f-mvvc (header de-dup drops a repeated
  value), GHSA-hvrm-45r6-mjfj (JSX context not request-isolated →
  cross-request data disclosure), GHSA-w62v-xxxg-mg59 (XSS via `cx()`
  escaping bypass), GHSA-8j4g-w8fx-2239 (ReDoS in CORS middleware),
  GHSA-f23p-vx2j-j53r (`memo()` cross-user SSR leak), GHSA-79qm-7rj5-m7r9
  (Proxy helper header leak), GHSA-54fx-42gc-7vw4 (ReDoS in language
  middleware).
- **Correction to the SW-28/NW-5c write-up:** those passes assumed "Lore
  uses Hono for its HTTP REST API" and reasoned through each advisory on
  that basis. That's no longer accurate against current source (and may
  not have been accurate then either) — `grep -rn "from 'hono'"
  packages/lore/src` returns **zero matches**. Lore's REST/MCP-HTTP layer
  is hand-rolled on `node:http`
  (`packages/lore/src/mcp/server.ts:1431`, `createServer(...)`, dispatched
  through `mcp/http/dispatcher.ts` and `mcp/http/routes/*.ts`, all typed
  against raw `IncomingMessage`/`ServerResponse`). `hono` is a direct
  dependency purely to pin the version `@modelcontextprotocol/sdk` resolves
  internally (mirroring the `@hono/node-server` situation above); the SDK
  itself only imports `hono` inside its own `examples/` directory, which
  nothing in this dependency tree ever loads.
- **Reachability: NOT REACHABLE** — the `hono` framework is never executed
  by the running daemon.
- **Disposition: ACCEPTED** (verified not reachable — supersedes the June
  "PARTIALLY REACHABLE / bodyLimit bypass" concern, which no longer applies
  since no Hono middleware is ever in the request path).
- **Remediation path:** `fixAvailable: true`, in-range (`^4.12.14` already
  permits ≥4.12.34). `npm update hono` is a free, zero-risk win worth
  taking even though nothing depends on it for security.

### ip-address (HIGH, transitive — SDK's unused OAuth helper, NOT reachable)

- **Package:** `ip-address` 10.2.0 (vulnerable range `<=10.3.0`), pulled in
  by `express-rate-limit` 8.5.2, a dependency of
  `@modelcontextprotocol/sdk`.
- **Advisories:** GHSA-mwp4-54f8-5fhr / GHSA-4xrf-jv44-h6hh /
  GHSA-22jq-vg5j-6vgg — leading-zero-octet / CIDR-suffix / IPv4-mapped
  misclassification, bypassing SSRF and trust-boundary checks.
- **Reachability: NOT REACHABLE.** `express-rate-limit` is imported only
  from the SDK's `server/auth/handlers/*` (OAuth token/authorize/revoke/
  register handlers) — confirmed by grep across the installed SDK — which
  Lore never imports (`grep -rn "@modelcontextprotocol/sdk/server/auth"
  packages/lore/src` returns nothing). Lore has its own independent
  rate-limiting/quota logic (`engines/quotaManager.ts`, the search-gate
  admission control) that doesn't touch this SDK subsystem.
- **Disposition: ACCEPTED** — not reachable.
- **Remediation path:** `fixAvailable: true`, but moot given
  non-reachability.

### body-parser — GHSA-v422-hmwv-36x6 (LOW, transitive — SDK's unused OAuth helper, NOT reachable)

- **Package:** `body-parser` 2.2.2, pulled in by `express` 5.2.1, a
  dependency of `@modelcontextprotocol/sdk`.
- **Advisory:** DoS when an invalid `limit` value silently disables size
  enforcement. CVSS 3.7 (low).
- **Reachability: NOT REACHABLE.** `express` (and therefore
  `body-parser`) is imported only by the SDK's optional OAuth helper
  (`server/auth/**`, and `server/express.js`'s `createMcpExpressApp()`).
  Lore never imports either — confirmed by grep. Lore's own HTTP layer is
  hand-rolled on `node:http` with its own auth (shared-secret + ephemeral
  tokens per this repo's `CLAUDE.md`), not Express or its body-parser.
- **Disposition: ACCEPTED** — not reachable; also low severity even if it
  were.

### brace-expansion (HIGH, deep transitive via exceljs → archiver/unzipper, NOT reachable)

- **Package:** `brace-expansion` 1.1.14 / 2.1.0 (multiple copies in the
  tree), pulled in via `exceljs` (optionalDependency, `^4.4.0`) →
  `archiver` / `unzipper` → `glob` / `minimatch`.
- **Advisories:** GHSA-3jxr-9vmj-r5cp / GHSA-mh99-v99m-4gvg /
  GHSA-rgw5-rvv9-x895 — DoS via exponential/unbounded expansion of `{...}`
  patterns. CVSS up to 7.5.
- **Reachability: NOT REACHABLE, for two independent reasons:**
  1. Lore only ever calls `workbook.xlsx.load()`
     (`packages/lore/src/engines/extractors/xlsx.ts:108`,
     `packages/lore/src/mcp/http/routes/import.ts:225`) — the XLSX *read*
     path. exceljs's ZIP-*write* path (`archiver`, the dependency that
     pulls in `archiver-utils`/`zip-stream`/`brace-expansion`) is never
     invoked; Lore never writes an `.xlsx` file.
  2. Even on the read path (`unzipper` → `fstream` → `rimraf` → `glob`),
     the DoS requires attacker control of the *pattern* argument passed to
     `minimatch`/`brace-expansion` — not the strings being matched. These
     libraries use fixed, internally-defined patterns for their own
     file-cleanup/globbing; attacker-influenced data (a hostile XLSX's
     internal filenames) would only ever appear as the *matched string*,
     never the pattern.
- **Disposition: ACCEPTED** — wrong code path (write-only) and wrong
  argument position for this vulnerability class, even where loaded.
- **Remediation path:** `fixAvailable: true`, but several layers deep
  inside exceljs's own dependency tree; not actionable without an exceljs
  release.

### fast-uri (HIGH, transitive via @modelcontextprotocol/sdk → ajv, partially reachable but low-impact)

- **Package:** `fast-uri` 3.1.2 (vulnerable range `3.0.0–3.1.4`), pulled in
  by `ajv` 8.18.0, a dependency of `@modelcontextprotocol/sdk`.
- **Advisories:** GHSA-v2hh-gcrm-f6hx / GHSA-7p8r-x3mc-p8w7 /
  GHSA-4c8g-83qw-93j6 — host confusion via backslash authority delimiters /
  failed IDN canonicalization. CVSS 7.5 each. **These are three NEW
  advisories** disclosed after the June pass fixed the original
  GHSA-q3j6/GHSA-v39h pair by bumping to 3.1.2 — that same 3.1.2 falls back
  inside these new CVEs' vulnerable range.
- **Reachability: PARTIALLY REACHABLE**, same shape as the June assessment,
  re-verified against current tool schemas. `ajv` uses `fast-uri` to
  validate `format: "uri"` / `$id` / `$ref` fields during JSON-Schema
  validation inside the MCP SDK. What gets validated is the MCP protocol's
  own JSON-RPC envelope and the JSON-Schema Lore generates from its own
  zod tool definitions (`packages/lore/src/mcp/tools/*.ts` use
  `z.string()` etc., not URI-typed fields aimed at a downstream fetch) —
  not arbitrary attacker-supplied URLs that Lore then dereferences. The
  host-confusion bug's impact model (tricking a URL parser into
  misjudging what host a URI points to) has no consequence here because
  nothing downstream of this validation performs a network fetch keyed on
  the validated value.
- **Disposition: ACCEPTED WITH JUSTIFICATION** — same reasoning as June.
  Fix is blocked on `ajv` releasing a version pinning `fast-uri` ≥3.1.5;
  not something Lore can safely override unilaterally without risking
  incompatibilities in the SDK's own validation internals.
- **Remediation path:** Monitor `@modelcontextprotocol/sdk` / `ajv`
  releases.

### protobufjs — GHSA-j3f2-48v5-ccww (MODERATE, transitive via onnxruntime-web, likely not even loaded)

- **Package:** `protobufjs` 7.6.4 (vulnerable range `7.5.0–7.6.4` — note:
  this is a NEW advisory; 7.6.4 was TW-1a's fix target for a different,
  now-resolved set of protobufjs CVEs), pulled in by `onnxruntime-web`
  1.26.0-dev, a dependency of `@huggingface/transformers`.
- **Advisory:** DoS via infinite loop in `.proto` option parsing. CVSS 5.3.
- **Reachability: NOT REACHABLE — more confidently than the June write-up.**
  `packages/lore/src/providers/embeddingBackend.ts:5-21` documents (and
  Lore's provider code confirms) that `@huggingface/transformers` v4 on
  Node.js always routes ONNX inference through `onnxruntime-node` (native),
  never `onnxruntime-web` (the browser/Wasm build). `onnxruntime-web` ships
  in `node_modules` only because it's part of the package's declared
  dependency set for its browser bundle target — Lore's Node process never
  imports it. Even under the older June reasoning (ONNX model files come
  from the local, non-network-facing model cache), this goes one step
  further: the parent module carrying the vulnerable code isn't loaded
  into the process at all under normal operation.
- **Disposition: ACCEPTED** — not reachable (module not loaded).
- **Remediation path:** `fixAvailable: true` per the raw audit, but no
  non-vulnerable 7.x release exists (7.6.4 is the last 7.x version
  published) and `onnxruntime-web`'s own declared range (`^7.2.4`) doesn't
  admit protobufjs 8.x. Blocked upstream; moot given non-reachability.

### adm-zip / onnxruntime-node — GHSA-xcpc-8h2w-3j85 (HIGH, transitive, install-time only, NOT reachable)

- **Package:** `adm-zip` 0.5.16 (vulnerable range `<0.6.0`), pulled in by
  `onnxruntime-node` 1.24.3 (pinned by `@huggingface/transformers` 4.1.0).
- **Advisory:** A crafted ZIP triggers a 4 GB memory allocation (DoS).
  CVSS 7.5.
- The `onnxruntime-node` row in this audit is the same finding propagated
  up one level of the dependency chain — no separate onnxruntime-node CVE.
- **Reachability: NOT REACHABLE at runtime.** `adm-zip` is used exclusively
  by onnxruntime-node's own installer
  (`node_modules/onnxruntime-node/script/install-utils.js:156`,
  `new AdmZip(packageFilePath)`), which unzips the prebuilt native
  onnxruntime binary that onnxruntime-node downloads from its own release
  infrastructure during `npm install`. This runs once, at install time,
  against a package onnxruntime-node's own maintainers publish — not
  against anything a Lore user ingests or any response Lore's daemon
  processes at runtime. This is a supply-chain-trust question about the
  onnxruntime-node release pipeline, orthogonal to Lore's document-
  ingestion surface.
- **Disposition: ACCEPTED** — install-time-only, non-attacker-controlled
  input.
- **Remediation path:** `fixAvailable: false` (no patched adm-zip exists
  within onnxruntime-node's declared `^0.5.16` range). Blocked on an
  onnxruntime-node release.

### @huggingface/transformers (HIGH, direct dependency, rollup — no standalone CVE)

- **Package:** `@huggingface/transformers` 4.1.0.
- No standalone advisory this pass — flagged high only because its
  dependency tree includes `onnxruntime-node` (→ `adm-zip`) and `sharp`,
  both addressed separately above.
- **Reachability / Disposition mirrors the two underlying findings:**
  - Via `onnxruntime-node` → `adm-zip`: NOT REACHABLE (install-time only,
    see above).
  - Via `sharp`: `@huggingface/transformers` bundles its own
    image-preprocessing utilities (`RawImage.toSharp()`) for vision-model
    pipelines. Lore's own use of the library is
    `pipeline('feature-extraction', ...)` (embeddings —
    `packages/lore/src/providers/localEmbeddingProvider.ts:41`) and
    `pipeline('text-generation', ...)` (local LLM fallback —
    `packages/lore/src/providers/llmDispatch.ts:443`) — neither is a
    vision pipeline, so transformers.js's own sharp-based image code is
    not exercised through this package. (Lore's own extractor code
    imports `sharp` *directly* for HEIC conversion — see the standalone
    `sharp` finding above, which **is** reachable, just not via
    `@huggingface/transformers`.)
- **Disposition: MONITOR** (rollup; see component findings for the actual
  risk owners). `fixAvailable: false` — no action possible without an
  upstream `@huggingface/transformers` release repinning
  onnxruntime-node/sharp.

### Fourth-pass tracking table

| Finding | Severity | Reachable? | Disposition | Action |
|---------|----------|------------|--------------|--------|
| sharp | High | **Yes** | **FIX NOW** | Bump `optionalDependencies.sharp` to `^0.35.3`, test |
| mailparser / linkify-it | High | **Yes** | **FIX NOW** | Add `"linkify-it": ">=5.0.2"` to `overrides` |
| pdfjs-dist | High | No (verified) | Monitor | Add `enableScripting: false` defensively; track v6 major bump |
| @hono/node-server | Moderate | No | Accepted | Low-priority major bump, wait on SDK |
| @modelcontextprotocol/sdk | Moderate | No | Accepted | Free bump to 1.30.0 available |
| hono | Moderate | No | Accepted | Free bump — `npm update hono` |
| ip-address | High | No | Accepted | Moot |
| body-parser | Low | No | Accepted | Moot |
| brace-expansion | High | No | Accepted | Blocked deep in exceljs tree |
| fast-uri | High | Partial (low-impact) | Accepted with justification | Monitor ajv releases |
| protobufjs | Moderate | No (module unloaded) | Accepted | Blocked upstream, moot |
| adm-zip / onnxruntime-node | High | No (install-time only) | Accepted | Blocked upstream |
| @huggingface/transformers | High | Rollup | Monitor | See component rows |

**Two action items from this pass, both concrete and low-risk:**
1. Add `"linkify-it": ">=5.0.2"` to the `overrides` block in `package.json`
   (same pattern as the existing `nodemailer`/`uuid` entries).
2. Bump `optionalDependencies.sharp` to `^0.35.3` and test the HEIC
   ingestion path.

---

## Enterprise Honesty Posture — TW-6c (2026-06-15)

This section documents the enterprise-readiness honesty pass from Wave 6 of
SWARM_QUEUE_3 (TW-6c). Evidence IDs: `ent-otel-shim-no-real-exporter`,
`ent-no-encryption-at-rest`, `ent-no-backup-scheduling-dr`.

No new vulnerabilities are introduced. These entries record honest posture
for three capabilities that were previously overclaimed or undocumented.

---

### Posture 1 — OpenTelemetry: provision-only shim, not a real exporter

**Evidence:** `ent-otel-shim-no-real-exporter` (`observability/otelHooks.ts:110`)

**What ships:** `otelHooks.ts` is a provision-only shim. `span()` returns a
no-op handle; `setAttribute()` is a no-op; no OTel JS SDK dependency exists;
no OTLP exporter is wired. The `LORE_OTEL_*` env vars are read and preserved
for future SDK activation, but setting them today produces zero telemetry.

**What was fixed in NW-5a (prior round):** `/metrics` previously reported
`lore_otel_enabled=1` whenever `LORE_OTEL_EXPORTER_OTLP_ENDPOINT` was set,
even though no exporter exists. This was a false claim. NW-5a introduced the
`exporterRegistered` flag: `/metrics` now reports `lore_otel_enabled=0`
unless `registerSpanProcessor()` has been explicitly called (meaning a real
SDK span processor is actually attached). The env var intent is preserved as
`endpointConfigured` (a separate field), distinct from the `enabled` reality.

**TW-6c posture (no code change to otelHooks.ts; already honest):**
- `lore_otel_enabled` in `/metrics` is `0` unless a real exporter is wired.
- `endpointConfigured` reports env-var intent separately from reality.
- `COMPLIANCE.md` §4.2 updated to reflect the corrected `getOtelReadiness()`
  semantics (enabled ≠ endpointConfigured).

**Do not claim OTel distributed tracing is operational.** The provisioning
surface and call-site instrumentation hooks exist; no traces reach any
collector until `registerSpanProcessor()` is called with a real SDK processor.

**Operator action:** to enable OTel, build an exporter module that calls
`registerSpanProcessor()` after constructing a real `@opentelemetry/sdk-node`
span processor. The existing call sites (replicator tick, embed enqueue,
recall request) will emit real spans without further changes. This is part of
the cloud activation track.

---

### Posture 2 — At-rest encryption: OS/disk only; no app-layer primitives

**Evidence:** `ent-no-encryption-at-rest` (`security/encryption.ts:17`)

**What ships:** `encryption.ts` exports only `generateKey()` — a 256-bit key
generator used by `keyring.ts` to mint per-workspace keys stored in the OS
keychain. **No `encrypt()`, `decrypt()`, or `EncryptedPayload` helpers exist.**
They were removed in NW-7h (`AUDIT_FINDINGS_2 ent-encryption-dead-code`)
because they had no callers. Shipping unused crypto primitives next to a
docstring that implied encryption coverage was a credibility risk for
enterprise reviewers.

**Current posture:**
- The live graph store — SurrealDB by default as of v3.13.0 (`.lore/surreal/`),
  or Kùzu (`graph`, `graph.wal`) when a workspace opts in via
  `graphEngine: 'kuzu'` — the LanceDB vector store (`lancedb/`), and the
  SQLite relational store (`tables.sqlite`) are **not**
  encrypted at the application layer.
- At-rest confidentiality relies on **host OS / full-disk encryption**
  (e.g. FileVault on macOS, LUKS/dm-crypt on Linux, BitLocker on Windows).
- Per-workspace keys are generated and stored in the OS keychain
  (`keyring.ts`, service `groundfloor-lore`). They exist today to enable a
  future encrypted-substrate path. That path will reintroduce `encrypt()` /
  `decrypt()` alongside the call site that uses them — not before.
- **`COMPLIANCE.md` §3.2 updated** to remove the stale AES-256-GCM claim
  and replace it with the accurate current posture.

**Enterprise operator guidance:** deploy Lore on a host with full-disk
encryption enabled. The OS-layer key is managed by the operator's disk
encryption solution (FileVault/LUKS/BitLocker), not by Lore. For secrets
(API keys, workspace keys) the OS keychain provides hardware-backed storage
on supported hardware (Secure Enclave / Touch ID on macOS).

---

### Posture 3 — Backup: manual only; no scheduling or DR automation

**Evidence:** `ent-no-backup-scheduling-dr` (`engines/backup.ts:15`)

**What ships:** `lore backup` is a **manual, on-demand, per-workspace
command.** It takes a tamper-evident snapshot (per-file SHA-256 catalog,
post-write integrity verification) and produces a `.tar.gz`. There is no
built-in scheduler, no retention automation beyond the `--keep N` flag, and
no off-host transfer — those require an external scheduler (cron, launchd,
systemd timer) and an operator-managed rsync / cloud-storage copy.

**Honest capability summary:**

| Capability | Status |
|-----------|--------|
| On-demand manual backup | **Implemented** — `lore backup` |
| Per-file SHA-256 integrity catalog | **Implemented** — NW-7h |
| Post-write tarball verification | **Implemented** — NW-7h |
| Local retention rotation (`--keep N`) | **Implemented** |
| Automated scheduling | **NOT implemented** — requires operator cron/launchd |
| Off-host transfer / DR replication | **NOT implemented** — operator rsync/cloud |
| Globally consistent snapshot | **NOT implemented** — no write-mutex; WAL-tolerant only |
| Point-in-time recovery | **NOT implemented** — full snapshot only, no incremental |

**Operator DR guidance (from `docs/BACKUP_RESTORE.md`):**
- Run `lore backup --all --out <outdir>` on a schedule (cron/launchd).
- Copy `<outdir>` off-host (rsync, object storage) for real DR — a backup
  on the same disk does not survive disk failure.
- Run the restore drill from `BACKUP_RESTORE.md` periodically.
- For cleanest snapshots, stop the daemon before running backup; the WAL
  reconciles any tail on the next daemon start after restore.

**`docs/BACKUP_RESTORE.md` already documents this posture accurately.**
No code change to `backup.ts` was needed — the file header at line 15 already
states "tamper-evident backup, not transactionally-consistent backup" and
the docs state explicitly that scheduling and off-host transfer are operator
responsibilities. TW-6c records the posture here for enterprise audit trail.
