# Plugin manifest examples

Reference `plugin.json` files demonstrating the v1 plugin manifest spec
(`docs/plugin-manifest-spec.md`) across diverse domains. These are
**scaffolds for plugin authors** — the manifests are real and validated
in CI, but the runtime modules they reference (`./dist/index.js`) are
not implemented in this monorepo.

## What's here

| Plugin    | Domain                     | Demonstrates                                 |
|-----------|----------------------------|----------------------------------------------|
| `banking` | Accounts, transactions     | timeline grouped by category; graph over money flow; `credentials:` and `net:host` permissions |
| `rag`     | Documents, chunks, sources | the `document` inspector kind; broad-net permissions |

The two in-tree counterparts that ship with runtime code:

| Plugin                                            | Domain                          |
|---------------------------------------------------|---------------------------------|
| `packages/lore-plugin-developer/plugin.json`      | Code intelligence (Phase 4)     |
| `packages/lore-plugin-personal/plugin.json`       | People, places, events, memories |
| `packages/lore-plugin-legal/plugin.json`          | Contracts, clauses, parties     |

## How they're validated

`test/manifest-reference-plugins.test.ts` runs the same 3-layer check
across all five manifests:

1. **Layer 1** — JSON parses + assigns to `PluginManifest` (compile-time
   via `tsc --noEmit`).
2. **Layer 2a** — structural rules mirroring the Tauri shell's Rust
   loader (`manifestVersion === 1`, required fields, ≥1 primitive
   contribution).
3. **Layer 2b** — schema rules the Rust loader defers to TypeScript
   (inspector kinds, kind-specific required fields, `width` vs `flex`
   mutex, permission namespaces).
4. **Layer 2c** — per-plugin entity coverage assertions (the banking
   manifest's inspectors must reference `Account` / `Transaction` /
   `Counterparty`, etc.).

In-tree manifests additionally require their `lore.module` path to
resolve to an existing dist file. External examples don't — their
`./dist/index.js` is a placeholder for plugin authors to overwrite
when they implement the runtime.

## Authoring a new plugin manifest

1. Copy one of these scaffolds into your plugin's repo root.
2. Fill in `name`, `version`, `description`, `homepage`.
3. Define your inspectors. Pick `kind`s appropriate to your data:
   - **`table`** — list-of-rows with sortable columns (most entities).
   - **`timeline`** — anything with a date field (events, memories,
     transactions, agent runs).
   - **`graph`** — entities with rich relationships you want to traverse.
   - **`document`** — long-form text with a title and body.
4. Declare permissions you'll request from the host:
   - `fs:read:<path>` — filesystem reads scoped to a path
   - `net:<host>` — outbound HTTP to a specific host (or `net:*` for
     anywhere; the user sees this and decides whether to install)
   - `credentials:read:<key>` — read a named credential from the host's
     vault
5. Run the validator against your manifest while iterating.

## Run the validator

```bash
npm run test:manifest:reference
```

Exit 0 = all manifests valid. Exit 1 = at least one check failed (the
output points to the offending plugin and assertion).
