# Lore — Cursor adapter for the pre-write duplicate check

The same shell script the Claude Code hook uses, wrapped in Cursor's
hook config format.

## Install (one-time, per machine)

Cursor reads hooks from `~/.cursor/hooks.json`. Two options:

### Option A — symlink (recommended for development)

```bash
mkdir -p ~/.cursor
ln -sf /Users/rdowla/Downloads/AiDev/BitBucket/groundfloor-lore/cursor-hooks/lore-prewrite-check.json ~/.cursor/hooks.json
```

Updates to the project's hook config flow automatically.

### Option B — copy

```bash
mkdir -p ~/.cursor
cp /Users/rdowla/Downloads/AiDev/BitBucket/groundfloor-lore/cursor-hooks/lore-prewrite-check.json ~/.cursor/hooks.json
```

Re-copy after any project-side change.

## What it does

When Cursor's agent is about to call `Write`, `Edit`, or `MultiEdit`,
the hook fires. The shell script:

1. Reads the proposed content from stdin (Cursor pipes a JSON envelope)
2. Skips trivial / non-code content
3. Calls the local Lore daemon at `http://127.0.0.1:3847/api/code-similar`
4. If the daemon says **warn** → prints the recommendation to stderr
5. If the daemon is unreachable → silent fail-open (never blocks the agent)

Exit code is always 0 — this hook is **advisory**, never blocks.

## Why "warn" not "deny"

Per Phase 2 design (`decision-phase2-cloud-policy-auth-design-2026-04-27`),
v1 of this hook is soft-enforcement only. Hard deny is reserved for v2
when the calibration delivers ≥98% precision; until then, false-positive
denials would teach agents to ignore Lore — the documented anti-pattern.

## Calibration today (Tier B-prime)

Strong signal: **name collision** (proposed identifier already exists
in any indexed repo). This catches the most common reinvention
scenario — agent declares `getUser` when `getUser` already exists.

Weaker signal: body-similarity standout. Currently very conservative
because Xenova all-MiniLM doesn't strongly discriminate code bodies.
Will improve when Tier C ships (code-specific embedder for `symbol:`
prefix).

## Auth

Local mode reuses the daemon's bearer token at
`~/.groundfloor/.lore/auth.token`. Cloud mode (when team scales) will
swap to gf-authz-mcp-issued JWTs per
`decision-phase2-cloud-policy-auth-design-2026-04-27`.

## Disable temporarily

Comment out the hook entry in `~/.cursor/hooks.json` and restart
Cursor. Or set `LORE_PREWRITE_DISABLED=1` in your shell env (the
script honors it — *future enhancement, not yet shipped*).
