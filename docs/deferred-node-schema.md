# Deferred Node Schema (Q1.7)

`deferred-*` is a Lore-node naming convention that captures **work
deliberately pushed to a later session**. The trigger-signal schema
defined here is how the node tells `recall()` when to resurface it.

## Why a convention instead of a new node type

The `type` enum (`decision`, `convention`, `bug_pattern`, …) describes
_what a node is_; the `id` prefix describes _when it should nag you_.
A deferred decision and a deferred architecture note are both still
decisions / architecture notes — they just also need resurfacing
semantics. The `deferred-` id prefix sits next to the type taxonomy
rather than swapping it out.

This also keeps the core engine plugin-agnostic: resurfacing logic
is a pure string-prefix scan plus file-path / tag overlap. No plugin
vocabulary (no `CodeFile`, `CodeSymbol`, …) touches the match code.

## Required shape

| Field         | Form                                                                           | Used by                     |
|---------------|--------------------------------------------------------------------------------|-----------------------------|
| `id`          | `deferred-<kebab-slug>` (e.g. `deferred-plugin-recalibrate-hook`)               | `findDeferredMatches` scan  |
| `type`        | Any valid type — typically `decision` or `note`                                 | storage only                |
| `label`       | One-line summary of the deferred work                                           | surfacing output            |
| `content`     | The "Proper fix" narrative — what needs doing, why it's deferred, how to pick it up | surfacing output + topic match |
| `tags`        | Comma-separated. Include `file:<path>` entries for each file-level trigger.     | file-match + topic-match    |
| `metadata`    | JSON string (see below)                                                         | trigger-signal schema       |

## `metadata` JSON — trigger-signal fields

All fields are optional. Omit a section entirely when it doesn't
apply — parsers tolerate missing keys.

```json
{
  "trigger_paths": ["packages/lore/src/mcp/server.ts",
                    "packages/lore/src/plugins/types.ts"],
  "trigger_tags":  ["reconnect_node", "ILorePlugin"],
  "resolved_at":   "",
  "resolved_by_commit": ""
}
```

### `trigger_paths: string[]`

File paths (relative to the repo root) that should resurface this
node when edited. The PostToolUse hook (`.claude/hooks/lore-deferred-check.sh`)
passes the edited file to `recall({ filePaths: [path] })`; any
overlap with `trigger_paths` — or a `file:<path>` tag — triggers
surfacing.

Matching is suffix-tolerant in both directions: `src/foo.ts` matches
`/abs/repo/src/foo.ts` and vice versa. This handles the gap between
the absolute path the hook observes and the repo-relative path a
node author typed.

> Keeping `trigger_paths` in structured metadata (instead of only
> in `file:<path>` tags) makes the list auditable and editable from
> the UI without disturbing the free-text tag soup.

### `trigger_tags: string[]`

Conceptual keywords (not paths). These match when the current
`recall()` topic substring-matches any entry — redundant with the
existing label/content/tags topic match, but useful when you want
to surface on a term that doesn't naturally appear in the narrative
(e.g. a symbol name the node only references obliquely).

Currently the engine folds `trigger_tags` into the same substring
match as `tags`; treat it as "promoted tags you want the surfacing
layer to care about".

### `resolved_at: string`

ISO-8601 timestamp stamped when the deferred work is closed out.
Managed by the `resolve_deferred` MCP tool and the `lore
resolve-deferred` CLI. **Once set, the node no longer appears in
surfacing results** — it stays in the graph for historical context
but becomes invisible to `recall()`'s deferred sidecar.

Empty string or missing key = still open.

### `resolved_by_commit: string`

Optional commit SHA that landed the fix. Populated by the same
resolution workflow. Purely documentary — the surfacing scan only
cares whether `resolved_at` is present.

## Example node (end-to-end)

```ts
await store_node({
    id: "deferred-plugin-recalibrate-hook",
    type: "decision",
    label: "Add ILorePlugin.recalibrate hook so plugin-owned nodes can be recalibrated from the drawer",
    content: "/* full narrative here — see Q1.8 */",
    tags: "drawer,recalibrate,plugin-boundary,ILorePlugin," +
          "file:packages/lore/src/mcp/server.ts," +
          "file:packages/lore/src/plugins/types.ts",
    metadata: JSON.stringify({
        trigger_paths: [
            "packages/lore/src/mcp/server.ts",
            "packages/lore/src/plugins/types.ts",
            "packages/lore/src/engines/reconnect.ts",
            "ui/src/components/NodeDetailDrawer.tsx",
        ],
        trigger_tags: ["reconnect_node", "ILorePlugin"],
    }),
});
```

## Resolution workflow

Two entry points, same underlying `stampResolved()` helper:

```bash
# CLI (one-shot, during or after a commit)
npx lore resolve-deferred deferred-plugin-recalibrate-hook \
    --commit b321692

# MCP tool (in-session, from a Claude Code agent)
resolve_deferred({ id: "deferred-plugin-recalibrate-hook",
                   commit: "b321692" })
```

Either path writes `metadata.resolved_at` and (when provided)
`metadata.resolved_by_commit`. The next `recall()` won't surface
the node; it stays in the graph for provenance.

## Acceptance invariants

- **Surfacing is path-triggered** — edit a file in `trigger_paths`
  (or a `file:<path>` tag), next `recall()` returns the node under
  `deferred[]`, even with an empty topic.
- **Topic match is an or-condition** — a recall with a matching
  topic surfaces the node even without a file signal.
- **Resolved nodes stay silent** — once `resolved_at` is present,
  no surfacing. No special-cased unresolve command; deleting the
  key from metadata and upserting restores visibility.
- **Plugin-boundary clean** — the scan is pure-string
  (`id.startsWith('deferred-')`, substring topic match, suffix path
  overlap). It works in a family / finance workspace identically.
