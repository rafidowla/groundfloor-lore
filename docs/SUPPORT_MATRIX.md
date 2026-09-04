# Support Matrix

This document defines the tested and supported configurations for
`@groundfloor/lore` (Lore Core daemon), covering OS/architecture, Node.js
version, and native binary constraints.

---

## Node.js Version Support

### Recommended range: `>=20 <23`

| Node version | Status | Notes |
|-------------|--------|-------|
| 18.x | Not supported | `better-sqlite3` 12.x does not ship Node 18 prebuilts |
| 20.x (LTS) | **Supported** | Tested on 20.19.3 (current dev baseline) |
| 22.x (LTS) | **Supported** | `better-sqlite3` ships Node 22 prebuilts |
| 23.x | Not supported | No prebuilt binaries from `better-sqlite3` for Node 23 |
| 24.x | Experimental | `better-sqlite3` 12.10.0 ships Node 24 prebuilts; untested in CI |

The `engines` field in `package.json` is set to `"node": ">=20 <23"` — this
matches the tested range. Node 24+ may work if `better-sqlite3` has prebuilts,
but is not validated. Lore does not use any Node 21/23-only APIs.

### Why the upper bound?

`better-sqlite3` ships prebuilt native binaries per Node major version. At
version 12.10.0 the supported Node engines are `20.x || 22.x || 23.x || 24.x ||
25.x || 26.x`. However, Node 23 is an odd (non-LTS) release and CI is only
run on 20.x and 22.x. Node 24+ is not yet validated. We recommend staying on
LTS lines (20, 22).

---

## Operating System and Architecture

### Supported (prebuilt binaries available)

| OS | Arch | Supported | Notes |
|----|------|-----------|-------|
| macOS | arm64 (Apple Silicon) | **Yes** | Primary dev platform |
| macOS | x64 (Intel) | **Yes** | Prebuilts available |
| Linux | x64 (glibc) | **Yes** | Production-recommended |
| Linux | arm64 (glibc) | **Yes** | Prebuilts available |
| Linux | x64 (musl/Alpine) | **Yes** | LanceDB ships musl variants |
| Linux | arm64 (musl/Alpine) | **Yes** | LanceDB ships musl variants |
| Windows | x64 | Experimental | LanceDB ships win32-x64; `sharp` prebuilts available; not tested in CI |
| Windows | arm64 | Not validated | Binaries exist for LanceDB; `better-sqlite3` may need compile |

### Why macOS x64 and Linux x64/arm64 are the primary targets

Lore Core uses four native packages that ship prebuilt binaries:

1. **`@lancedb/lancedb` 0.27.2** — Ships optional prebuilts for:
   - `@lancedb/lancedb-darwin-arm64`
   - `@lancedb/lancedb-linux-arm64-gnu`
   - `@lancedb/lancedb-linux-arm64-musl`
   - `@lancedb/lancedb-linux-x64-gnu`
   - `@lancedb/lancedb-linux-x64-musl`
   - `@lancedb/lancedb-win32-arm64-msvc`
   - `@lancedb/lancedb-win32-x64-msvc`
   Note: no `darwin-x64` binary is shipped; macOS x64 falls back to
   `darwin-arm64` via Rosetta 2 or source compilation.

2. **`@surrealdb/node` 3.0.3** — the **only graph engine**
   (`DEFAULT_GRAPH_ENGINE = 'surreal'`,
   `packages/lore/src/engines/graphEngineSelector.ts`). A `napi-rs` native
   addon; ships prebuilt binaries for `darwin-arm64`, `darwin-x64`,
   `linux-arm64-gnu`, `linux-arm64-musl`, `linux-x64-gnu`, `linux-x64-musl`,
   `win32-arm64-msvc`, and `win32-x64-msvc` — broader platform coverage
   than the other two native deps below.

3. **`better-sqlite3` 12.10.0** — Ships prebuilts via `prebuild-install` for
   Node 20.x and 22.x on Linux x64/arm64 and macOS x64/arm64. Source
   compilation with `node-gyp` is the fallback (requires Python + compiler).

4. **`sharp` 0.34.5** (image processing for OCR pipeline) — Ships prebuilts
   for Linux x64/arm64 (glibc ≥2.31) and macOS arm64/x64. Requires
   `libvips` on platforms without prebuilts.

---

## Install Requirements

### `--legacy-peer-deps` is required

```
npm install --legacy-peer-deps
```

**Why:** `apache-arrow` is pinned to exactly `18.1.0` in `package.json`.
`@lancedb/lancedb` declares a peer dependency of `apache-arrow: ">=15.0.0
<=18.1.0"`. npm's strict peer dependency resolution treats the exact pin `18.1.0`
as satisfying `>=15.0.0 <=18.1.0`, but some npm versions (7+) emit a conflict
when the version satisfying the peer dep is pinned exactly (not a range).
Using `--legacy-peer-deps` bypasses this check. The actual installed version
(`18.1.0`) is fully compatible.

This is a known limitation and will be resolved when LanceDB lifts the
`apache-arrow` upper bound or when we move to LanceDB 0.28+.

### Native compilation prerequisites (fallback only)

If prebuilt binaries are unavailable for your platform, the following are
required for source compilation:

- Python ≥3.x
- C++ compiler (`gcc`/`clang` on Linux/macOS, `MSVC` on Windows)
- `node-gyp` installed globally or via `npm install -g node-gyp`
- `libvips-dev` (Linux) for `sharp`

---

## Native Dependency Versions (Pinned Exact)

The following native dependencies are pinned to exact versions (no caret) in
`package.json` to ensure both clones resolve to the same prebuilt binary.
These versions match what is resolved in `package-lock.json`.

| Package | Pinned Version | Reason |
|---------|---------------|--------|
| `@surrealdb/node` | `3.0.3` | Native SurrealDB embedded graph engine; the only graph engine; binary must match |
| `@lancedb/lancedb` | `0.27.2` | Native LanceDB vector store; binary must match |
| `better-sqlite3` | `12.10.0` | Native SQLite binding; binary must match |

Do not add a caret (`^`) to these versions. A caret would allow `npm install`
on a fresh clone to resolve a different patch version, potentially downloading
a different prebuilt binary that has not been validated.

---

## CI Matrix Recommendations

The following matrix should be validated in CI:

| OS | Arch | Node | Status |
|----|------|------|--------|
| ubuntu-latest | x64 | 20.x | Recommended (primary CI) |
| ubuntu-latest | x64 | 22.x | Recommended |
| ubuntu-arm64 / self-hosted | arm64 | 20.x | Recommended |
| macos-latest (M-series) | arm64 | 20.x | Recommended |
| windows-latest | x64 | 20.x | Experimental |

Install command for all CI jobs:

```
npm ci --legacy-peer-deps
```

---

## Version History

| Date | Change |
|------|--------|
| 2026-06-13 | Initial matrix documented (SW-28). Native deps pinned exact. |
