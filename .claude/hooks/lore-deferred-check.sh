#!/usr/bin/env bash
#
# lore-deferred-check.sh — Q1.7 PostToolUse hook for Claude Code.
#
# On every Edit/Write tool event, pull the file path out of the hook
# payload and ask the local Lore daemon whether any deferred-* node
# references that path. If one matches, emit a short summary so Claude
# sees the deferred work on the NEXT turn without the user prompting.
#
# Hook contract (Claude Code PostToolUse):
#   - stdin is a JSON document containing `tool_input.file_path`
#     (Edit/Write) or `tool_input.path` (some tools)
#   - stderr echoed back to Claude as a system message
#   - stdout ignored (we only care about context injection)
#   - exit code 0 always — never fail a tool call on Lore being down
#
# Install: add to .claude/settings.json (team-shared) or
# .claude/settings.local.json (per-user):
#
#   {
#     "hooks": {
#       "PostToolUse": [{
#         "matcher": "Edit|Write",
#         "hooks": [{ "type": "command",
#                     "command": ".claude/hooks/lore-deferred-check.sh" }]
#       }]
#     }
#   }
#
# The script is defensively quiet: if the daemon is offline, the
# curl times out, jq isn't installed, or the payload is malformed,
# we exit 0 and print nothing. Claude Code hooks are a performance-
# and reliability-critical path.

set -u

# Configurable — the LaunchAgent binds to a random port on startup,
# so the hook resolves the active port from the LaunchAgent's log
# output. Fallback chain: env var → LaunchAgent stderr log → give up.
LORE_URL="${LORE_URL:-}"
if [ -z "$LORE_URL" ]; then
    # LaunchAgent writes "[Lore MCP] HTTP server listening on port NNNN"
    # to the stderr log. Grep the most recent one.
    port=$(grep -hoE 'listening on port [0-9]+' \
        ~/Library/Logs/groundfloor-lore.stderr.log 2>/dev/null \
        | tail -n1 | awk '{print $4}')
    [ -n "$port" ] && LORE_URL="http://127.0.0.1:${port}"
fi
[ -z "$LORE_URL" ] && exit 0

# Parse the hook payload from stdin. We tolerate missing jq: if it's
# not installed, we fall back to a quick grep that handles the common
# Edit/Write shape. No jq dependency keeps this portable.
payload=$(cat)
if command -v jq >/dev/null 2>&1; then
    file_path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.path // empty' 2>/dev/null)
else
    file_path=$(printf '%s' "$payload" | grep -oE '"(file_path|path)":"[^"]+"' | head -n1 | sed 's/.*":"//; s/"$//')
fi

[ -z "$file_path" ] && exit 0

# Trim the repo root so the match against `file:src/…` tags works
# regardless of absolute vs. relative path.
repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
rel_path="${file_path#"$repo_root/"}"

# Initialize an MCP session just to call recall(). The Lore HTTP MCP
# transport requires an initialized session before tools/call; we
# grab the session id from the response headers.
init_resp=$(curl -sSN -D - -X POST "${LORE_URL}/mcp" \
    --max-time 2 \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"lore-deferred-hook","version":"1"}}}' \
    2>/dev/null) || exit 0

sid=$(printf '%s' "$init_resp" | grep -i '^mcp-session-id:' | awk '{print $2}' | tr -d '\r')
[ -z "$sid" ] && exit 0

# Notifications/initialized is fire-and-forget; some servers refuse
# tools/call without it.
curl -sS -X POST "${LORE_URL}/mcp" --max-time 1 \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: $sid" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    -o /dev/null 2>/dev/null || exit 0

# Call recall({topic:"", filePaths:[rel_path]}). Topic is empty so the
# server skips the search and only runs the deferred-match scan — the
# output is naturally small when there are no deferred hits.
recall_body=$(printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"recall","arguments":{"topic":"","filePaths":["%s"]}}}' "$rel_path")
recall_resp=$(curl -sSN -X POST "${LORE_URL}/mcp" --max-time 3 \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "mcp-session-id: $sid" \
    -d "$recall_body" 2>/dev/null) || exit 0

# SSE frames are "data: <json>" — pull the first data line.
json=$(printf '%s' "$recall_resp" | sed -n 's/^data: //p' | head -n1)
[ -z "$json" ] && exit 0

# The inner result.content[0].text is itself a JSON string we need to
# parse — that's where the `deferred` array lives. Extract and print
# only when non-empty. jq path: .result.content[0].text | fromjson | .deferred
if command -v jq >/dev/null 2>&1; then
    deferred=$(printf '%s' "$json" \
        | jq -r '(.result.content[0].text // "") | try fromjson catch {} | .deferred // [] | .[] | "  • \(.id) (\(.reason), \(.ageDays)d old): \(.label)"' \
        2>/dev/null)
    if [ -n "$deferred" ]; then
        printf '[Lore Q1.7] Deferred work matching %s:\n%s\n' "$rel_path" "$deferred" >&2
    fi
fi

exit 0
