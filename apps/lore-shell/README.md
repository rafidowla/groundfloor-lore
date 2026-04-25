# Lore Shell

Tauri 2 host process for the Lore local app. Reads plugin manifests
(`plugin.json`), renders inspectors, and manages the Lore daemon as a
child process.

> **Status: Phase 3a — scaffold.** Boots an empty window with a single
> IPC bridge for parity verification. Manifest loading, inspectors, and
> daemon lifecycle land in subsequent slices. See
> [`docs/plugin-manifest-spec.md`](../../docs/plugin-manifest-spec.md)
> for the contract this shell consumes.

## Architecture

The shell is **primitive #1's host**. The plan (see project root
`README.md` and the manifest spec) is "two primitives, one shell":

```
                  ┌───────────────────────────────┐
                  │       Tauri shell process     │
                  │  ┌─────────────────────────┐  │
                  │  │  React UI (this dir)    │  │
                  │  └─────────┬───────────────┘  │
                  │            │ IPC               │
                  │  ┌─────────┴───────────────┐  │
                  │  │  Rust backend (lib.rs)  │  │
                  │  │   - manifest loader     │  │
                  │  │   - daemon supervisor   │  │
                  │  │   - plugin install flow │  │
                  │  └─────────┬───────────────┘  │
                  └────────────┼──────────────────┘
                               │ child process
                  ┌────────────┴──────────────────┐
                  │   Lore daemon (Node)          │  ← primitive #1
                  │   packages/lore (this repo)   │
                  └───────────────────────────────┘
```

DEF (primitive #2) plugs in via the same shell once it's local-first
(see Phase 5 in the project plan).

## Phase plan

| Slice | Deliverable |
|---|---|
| 3a (this) | scaffold: window boots, IPC bridge wired, `shell_info` command stub |
| 3b | `load_manifest(path)` Rust command + plugin.json validator |
| 3c | `TableInspector` React component renders entities from the running Lore daemon |
| 3d | daemon child-process spawner + lifecycle (start/stop/probe) |

## Running locally

Prerequisites:
- Rust 1.77+ (`rustup`)
- Node 20+
- Platform deps for Tauri 2 — see <https://tauri.app/start/prerequisites/>

```bash
cd apps/lore-shell
npm install
npm run tauri dev
```

The first `npm run tauri dev` compiles the entire Rust dependency tree;
expect 5–10 min. Subsequent runs are fast.

## Manifest types

The frontend imports the canonical `PluginManifest` type from the Lore
package source (`packages/lore/src/plugins/manifest.ts`) via a Vite +
TypeScript path alias. This is intentional: the shell and Lore must
agree on the manifest shape exactly. Spec drift becomes a build error
in this app.

## What this shell is *not*

- Not a chat-UI clone of Claude/ChatGPT. The user-facing UI for plugin
  contributions is descriptor-driven (see `lore.inspectors[]`).
- Not a DEF runtime. DEF is a separate primitive; the shell forwards
  `def.*` manifest slots to the DEF runtime once it lands.
- Not the existing `ui/` directory at the repo root. That is the
  legacy Lore web UI; deprecation path is a separate decision.
