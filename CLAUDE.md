# Plugin Boundary (MANDATORY — read before editing anything under `src/`)

Lore's core engine is plugin-agnostic. `src/plugins/<name>/` is plugin-local
code — only meaningful when that plugin is active in a workspace's
`.lore/config.json`. Code outside `src/plugins/` is the shared core and
must work when zero plugins are loaded.

## The rule

**Core code must never import from `src/plugins/**` except:**
- `src/plugins/types.ts` (the `ILorePlugin` contract itself)
- `src/plugins/registry.ts` (the dispatcher)

**Core code must never reference plugin-owned vocabulary:**
`CodeSymbol`, `CodeFile`, `LoreAppliesToCode`, `LoreTouchesFile`,
`FileContains`, `CodeRelation`, `DevActivity`, `gitnexus`, `GitNexus`.
These are Developer-plugin concerns. Future plugins bring their own
vocabulary — add it to the lint list when they land.

Plugins contribute via hooks on `ILorePlugin`:
`registerTools` · `registerSchema` · `contributeReconnectNodes` ·
`routeReconnectEdge` · `pruneInferredEdges` · `getTelemetryPayload` · `api`.
Core iterates plugins via `PluginRegistry.active()` and calls each hook.

## When adding or changing a feature, ask

> **"Would this also make sense for a `family` or `finance` workspace?"**

- **Yes** → it belongs in `src/engines/`, `src/mcp/` (except tool
  registration), `src/cli/` (except plugin-specific commands), or
  `src/providers/`.
- **No** → it belongs in `src/plugins/<plugin>/`.

## Red flags that you're about to leak

- You're writing `graph.upsertCodeSymbol(...)` or `graph.listCodeFiles(...)`
  from outside `src/plugins/developer/` → stop. Go through
  `pluginRegistry.active().find(p => p.name === 'developer')?.api`.
- You're about to add `if (pluginRegistry.isActive('developer')) { … big
  block of code … }` → move the block *into* `src/plugins/developer/`
  and register it through a hook. The `if` check is a sign the block
  doesn't belong where it sits.
- You're importing from `../plugins/developer/…` in `src/engines/` or
  `src/cli/` → stop. Use an `ILorePlugin` hook or the opaque `plugin.api`.

## Enforcement — three layers

1. **`npm run test:arch`** — fails CI on any new plugin-boundary
   violation. Known legacy is tracked in `.arch-baseline.json`; net-new
   violations require fixing or an entry + justification in that file.
2. **ESLint `no-restricted-imports`** — warns in-editor on imports
   that cross the boundary.
3. **This `CLAUDE.md` section** — read by every AI session before it
   touches code.

Past failure mode: V2.1's initial pass put disk-read file content,
gitnexus CLI parsing, `CodeFile` schema, and `ingest-files` HTTP/CLI
surfaces into `src/engines/` and `src/mcp/` because it shipped fast.
The Option C refactor moved them into `src/plugins/developer/`. The
guardrails above prevent this from happening again.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **groundfloor-lore** (1306 symbols, 3129 relationships, 107 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/groundfloor-lore/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/groundfloor-lore/context` | Codebase overview, check index freshness |
| `gitnexus://repo/groundfloor-lore/clusters` | All functional areas |
| `gitnexus://repo/groundfloor-lore/processes` | All execution flows |
| `gitnexus://repo/groundfloor-lore/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
