# Plugin Manifest Specification

Status: **Draft v1** (2026-04-25)

This document defines the bundle-level descriptor that a Lore plugin
ships with. The manifest is the **load-bearing contract** for the
local-app architecture decided in the Q2.2 platform discussion:

> Two primitives, one shell. Lore and DEF stay decoupled at the
> runtime layer. The local app is a Tauri shell that hosts both as
> primitive contributions. Plugins declare contributions to either or
> both via this manifest.

The manifest sits **above** the existing `ILorePlugin` TypeScript
contract (`packages/lore/src/plugins/types.ts`). `ILorePlugin` is the
runtime contract Lore's plugin registry already uses. The manifest is
the bundle-level surface the **shell** reads to understand a plugin
without booting any TypeScript — what tabs to render, whether DEF is
needed, what the user is being asked to install.

---

## Why a manifest layer

`ILorePlugin` is TypeScript code with side-effecting hooks
(`registerTools`, `registerSchema`, `contributeReconnectNodes`, etc.).
It assumes the Lore daemon is running. That's the wrong shape for:

1. **The shell's install flow.** Shell needs to know "does this plugin
   need DEF?" *before* booting either daemon. Reading TypeScript code
   isn't an option — the shell is a Tauri (Rust) process.

2. **Static enumeration for marketplaces / catalogs.** Listing what a
   plugin contributes shouldn't require executing it.

3. **Two-primitive contributions.** A plugin contributes to Lore *and*
   DEF. `ILorePlugin` was designed pre-DEF — it has no slot for agent
   definitions, scheduled tasks, or DEF-side configuration.

4. **UI surfaces declared declaratively.** "Show an Emails tab with
   columns sender / subject / date" should be data, not code. Plugins
   don't get to inject arbitrary JS into the shell.

The manifest solves all four. `ILorePlugin` stays as the runtime contract
the Lore daemon already uses; the manifest *references* the
ILorePlugin module rather than replacing it.

---

## File location and format

Each plugin bundle has a `plugin.json` (or `plugin.yaml`) at its root.
The two formats are equivalent — JSON for tooling-friendliness, YAML
for human authoring. Lore's loader accepts either; future tooling
should canonicalize on JSON.

```
my-plugin/
├── plugin.json          ← the manifest
├── package.json         ← npm package (peer-deps lore types, etc.)
├── src/
│   ├── index.ts         ← exports `default: ILorePlugin`
│   └── …
├── def/                 ← optional, only if DEF parts declared
│   └── agents/
│       └── assistant.yaml
└── README.md
```

---

## Top-level shape

```jsonc
{
  // Identity (required) ---------------------------------------------------
  "manifestVersion": 1,                    // bumps on breaking spec changes
  "name": "personal",                      // kebab-case, globally unique
  "version": "1.2.0",                      // semver
  "description": "Personal knowledge: emails, files, notes.",
  "author": "Groundfloor",
  "license": "MIT",
  "homepage": "https://example.com/personal-plugin",

  // Lore contribution (optional) -----------------------------------------
  "lore": {
    "module": "./dist/index.js",           // ILorePlugin entry point
    "inspectors": [ … ],                   // declarative UI panels
    "permissions": [ … ]                   // host capabilities required
  },

  // DEF contribution (optional) ------------------------------------------
  "def": {
    "required": false,                     // graceful degradation flag
    "agents": [ … ],
    "scheduledTasks": [ … ],
    "permissions": [ … ]
  },

  // Compatibility (optional) ---------------------------------------------
  "engines": {
    "lore": ">=2.2.0",
    "def":  ">=0.1.0"
  }
}
```

**Both `lore` and `def` are optional.** A plugin may contribute to one
or both:

| Lore part | DEF part | Plugin shape | Example |
|---|---|---|---|
| ✓ | ✓ | full personal/banking-style bundle | `personal` |
| ✓ | ✗ | classic Lore plugin (no agent surface) | `developer` (today) |
| ✗ | ✓ | DEF-only agent that uses *other* plugins' Lore data via MCP | `meeting-summariser` |
| ✗ | ✗ | invalid — manifest must declare at least one |  |

---

## `lore.*` — Lore primitive contributions

### `lore.module`

Path (relative to manifest) to the JavaScript module whose default
export is an `ILorePlugin` instance. The Lore daemon dynamically
imports this when the plugin is activated. Required if `lore` is
present.

The daemon honors all existing `ILorePlugin` hooks unchanged — schema
registration, reconnect contributions, retention policies, analytical
projections, etc. **No migration needed for existing plugins**: they
add `plugin.json` referencing their existing `dist/index.js` and they
work as-is.

### `lore.inspectors[]`

Declarative panel definitions the shell renders. Each inspector
becomes a tab under the plugin's section in the workspace UI. Pure
data — no code injection.

```jsonc
{
  "lore": {
    "inspectors": [
      {
        "id": "emails",                    // stable id per plugin
        "label": "Emails",                 // tab label
        "icon": "mail",                    // optional, from icon set
        "kind": "table",                   // table | graph | timeline | document

        // For kind=table — entity type to query + columns to show
        "entity": "Email",                 // node label in the graph
        "columns": [
          { "field": "sender",   "label": "From",    "width": 200 },
          { "field": "subject",  "label": "Subject", "flex":  1   },
          { "field": "received", "label": "Date",    "width": 140, "type": "date" }
        ],
        "sort":   { "field": "received", "order": "desc" },
        "filters": [
          { "field": "sender", "kind": "text" },
          { "field": "tags",   "kind": "multi-select" }
        ],

        // Optional drill-in: clicking a row shows this view
        "drilldown": {
          "kind": "document",              // shows full text + neighbors
          "labelField": "subject",
          "contentField": "body"
        }
      }
    ]
  }
}
```

**Renderer kinds (shell-supported):**

| `kind` | Purpose |
|---|---|
| `table` | Entity list with sortable columns, filters, drill-in |
| `graph` | Subgraph visualisation centred on an entity type |
| `timeline` | Time-ordered events (uses an entity's date field) |
| `document` | Single-record view with content + one-hop neighbours |

The shell has built-in renderers for each. Plugins describe data; they
don't describe pixels. This is the discipline that prevents
plugin-injected UI from blurring Lore and DEF.

### `lore.permissions[]`

Host capabilities the Lore-side parts require. The shell asks the
user to grant these at install time.

```jsonc
"permissions": [
  "fs:read:~/Documents",          // read a directory
  "fs:write:~/.lore/personal",    // write under loreDir
  "net:imap.gmail.com:993",       // outbound network (host:port allowlist)
  "credentials:store:gmail-oauth" // keytar entry
]
```

Permission strings are namespaced: `fs:`, `net:`, `credentials:`,
`os:notifications:`, `os:clipboard:`, etc. Unknown namespaces fail at
install. (The full namespace list is part of the shell spec, not this
doc.)

---

## `def.*` — DEF primitive contributions

### `def.required`

Boolean. The flag that drives the activation prompt described below.

- `true` — plugin doesn't function without DEF. Install fails if DEF
  isn't installed/enabled, prompting the user to activate it first.
- `false` (default) — DEF parts are optional. Install proceeds with
  Lore-only parts active; DEF parts are stored as **pending**.
  When DEF is later installed/enabled, the shell scans pending DEF
  contributions and activates them automatically — no reinstall.

**Use `required: true` only when the plugin's value is fundamentally
agentic** (e.g., a "personal assistant" plugin whose entire point is
the agent). For plugins that *augment* with agents but work without
them, prefer `false`.

### `def.agents[]`

Agent definitions the DEF runtime instantiates. Shape is owned by DEF
— Lore treats this field as opaque pass-through. The Lore daemon does
not load, validate, or execute these. The shell forwards them to the
DEF runtime's plugin loader.

```jsonc
"def": {
  "required": false,
  "agents": [
    {
      "name": "personal-assistant",
      "displayName": "Personal Assistant",
      "system": "You are a personal assistant with access to my emails, files, and notes…",
      "model": "claude-sonnet-4.7",
      "tools": [
        // MCP tool references — resolved by DEF at runtime
        "lore:personal:search_emails",
        "lore:personal:get_thread",
        "lore:builtin:search",
        "lore:builtin:recall"
      ],
      "memory": {
        "kind": "lore",
        "workspace": "personal"
      }
    }
  ]
}
```

The exact agent schema is defined by the DEF project. This document
does not specify it — the manifest just provides the slot. The
contract between DEF and the shell is: "shell hands you these
descriptors, you instantiate them." Versioning lives in
`engines.def`.

### `def.scheduledTasks[]`

Cron-style or event-driven tasks. Same opaque-pass-through rule.

```jsonc
"scheduledTasks": [
  {
    "id": "morning-briefing",
    "agent": "personal-assistant",
    "trigger": { "kind": "cron", "expression": "0 9 * * 1-5" },
    "prompt": "Summarise overnight emails and today's calendar."
  }
]
```

### `def.permissions[]`

Same shape as `lore.permissions`. DEF parts may need permissions Lore
parts don't (e.g., outbound network for an agent that calls external
APIs). Granted independently — a user can decline DEF permissions
while accepting Lore ones.

---

## Install flow (shell)

When the user installs a plugin:

```
1. shell reads plugin.json
2. validate: manifestVersion supported, schema lints clean
3. compute required permissions (lore.permissions ∪ def.permissions)
4. show user:
   - what the plugin contributes (inspectors, agents)
   - what permissions it needs
   - any sub-prompts (DEF activation, see step 6)
5. user confirms
6. branch on def.required + DEF state:
     def.required=true,  DEF absent  → block until DEF activated
     def.required=true,  DEF present → install both
     def.required=false, DEF absent  → install Lore parts;
                                       mark DEF parts pending
     def.required=false, DEF present → install both
7. dispatch:
   - Lore parts → Lore daemon's plugin loader (uses lore.module)
   - DEF parts  → DEF daemon's plugin loader (uses def.agents etc.)
   - shell registers inspectors from lore.inspectors[]
8. when DEF later activates: shell scans pending DEF parts and
   dispatches them to DEF; tabs/agents become visible.
```

The activation prompt at step 6 (DEF absent) is the answer to user's
Q1: yes, the shell asks. The graceful-degradation path
(`def.required: false`) is what makes the question answerable as a
soft request rather than a hard gate.

---

## Migration path for existing Lore plugins

Existing TypeScript plugins (`packages/lore-plugin-developer/`) keep
working unchanged. Adoption is opt-in and incremental:

1. **Phase 1 (this spec):** plugins continue to load via the existing
   `pluginRegistry.boot()` path that reads `.lore/config.json`. The
   manifest is *additive* — when present, the shell uses it; when
   absent, the daemon falls back to the current behaviour. No-op
   for existing deployments.
2. **Phase 2:** add `plugin.json` to each plugin in the repo
   referencing its existing `index.ts` via `lore.module`. No code
   changes; just declare what's already there.
3. **Phase 3:** introduce inspectors declaratively (replace any
   currently-bespoke UI with `lore.inspectors[]`).
4. **Phase 4:** when DEF lands, plugins with agentic value
   (personal, banking) add `def.agents[]`.

No flag day. No breaking change. The manifest layer sits on top of
the existing system; existing plugins are valid Phase-1 plugins by
default.

---

## What's intentionally *not* in the manifest

A few things that look manifest-shaped but aren't:

- **Tool registration.** Plugins still register MCP tools via
  `ILorePlugin.registerTools()`. The shell doesn't need a list of
  tools — it doesn't call them; agents and external hosts do.
  Listing tools statically would create a "manifest says X, code does
  Y" drift hazard for no benefit.

- **Cypher / Kùzu schema.** Schema goes through
  `ILorePlugin.registerSchema()` and `contributeCollectionDecls()`
  (Q2.2 slice 5c). The manifest doesn't duplicate this; it would just
  be a second source of truth.

- **Cloud schema.** Cloud (Dataplane) parity goes through
  `registerCloudSchema()` (Q2.2 slice 4) the same way. Manifest stays
  out.

- **Workspace mode UI hints.** `PluginUiHints` (`uiHints` on the
  ILorePlugin instance) was a Phase-3 Mode-pill concept; it's
  workspace UX, not a manifest concern. Inspectors supersede the
  pill model in the new shell.

These belong in code because they're load-time wiring against the
actively-running daemon, not bundle-level declarations the shell
needs to inspect.

---

## TypeScript types

See `packages/lore/src/plugins/manifest.ts` for the canonical type
definitions. Any divergence between the spec and the types is a bug
in this document.

---

## Open questions

These are deferred to follow-up specs and noted here so they're
visible:

1. **DEF's exact agent schema.** This manifest reserves the slot;
   DEF's spec defines the shape. Coordination point.
2. **Inspector renderer kinds.** Initial set is `table | graph |
   timeline | document`. New kinds need a shell capability bump
   (handle via `manifestVersion`). Want to keep the set small.
3. **Permission namespace registry.** Listed inline above; should
   live in a shell-spec doc, not here. Pending.
4. **Marketplace / signing.** Not in scope for v1. Plugins are local
   bundles for now.

---

## Decision log this spec captures

- **Two primitives, one shell** — Lore and DEF stay decoupled
  runtimes; manifest is the integration contract.
- **DEF activation is a soft prompt with graceful degradation** —
  default `def.required: false`; pending parts auto-activate when
  DEF is enabled.
- **Plugins describe data, not pixels** — inspector renderers are
  shell-built-in; plugins declare entity + columns + filters.
- **Manifest sits *above* `ILorePlugin`, not replacing it** — no
  flag day, no breaking change, additive adoption.
- **Lore is a skill *for* DEF, not *in* DEF** — runtime composition
  preserved (DEF agents call Lore via MCP); deployment topology
  decoupled.
