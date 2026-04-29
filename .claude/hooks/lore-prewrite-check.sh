#!/bin/bash
# ─── Lore — Pre-Write Duplicate Check (Phase 2) ────────────────
# PreToolUse hook for Claude Code. Fires on Edit / Write tool calls.
# Asks the Lore daemon "is this content similar to existing code?"
# and injects the recommendation back into the agent's context.
#
# Behavior:
#   - decision = "allow" → exit 0 silently (no output)
#   - decision = "warn"  → print recommendation to stderr (Claude Code
#                          surfaces this in the agent transcript)
#   - daemon unreachable → exit 0 silently (fail-open, never block)
#   - exit ALWAYS 0 — this hook is advisory, never blocks the agent
#
# Per decision-phase2-cloud-policy-auth-design-2026-04-27 (v3):
#   - Local mode: reuse the existing daemon bearer at ~/.groundfloor/.lore/auth.token
#   - Cloud mode: future work, gf-authz-mcp JWT
#
# Per Phase 2 calibration (Tier B-prime):
#   - Primary signal = name collision (proposed identifier already exists)
#   - Secondary signal = body similarity above z-score + cohort guards
#   - Body similarity is conservative; most "warn" output is name collisions

set -e

LORE_PORT="${LORE_PORT:-3847}"
LORE_DAEMON="http://127.0.0.1:${LORE_PORT}"
# Token path: the daemon writes the bearer token here at startup.
# Verified empirically 2026-04-27 — NOT under .lore/ as the docs imply.
TOKEN_FILE="${HOME}/.groundfloor/auth.token"
TIMEOUT_SEC="${LORE_PREWRITE_TIMEOUT:-2}"

# Read hook input from stdin (Claude Code pipes JSON envelope).
# Schema: { tool_name, tool_input: { file_path?, content?, new_string?, old_string? } }
input=$(cat)

# Extract tool name + content. The hook fires for both Write and Edit.
tool_name=$(echo "$input" | jq -r '.tool_name // empty' 2>/dev/null || echo "")
case "$tool_name" in
    Write)
        content=$(echo "$input" | jq -r '.tool_input.content // empty' 2>/dev/null || echo "")
        file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
        ;;
    Edit)
        # For edits, check the NEW content (what's being added/changed)
        content=$(echo "$input" | jq -r '.tool_input.new_string // empty' 2>/dev/null || echo "")
        file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
        ;;
    *)
        # Other tool — not our concern
        exit 0
        ;;
esac

# Skip empty / trivial content (one-liners aren't worth checking)
if [ -z "$content" ] || [ ${#content} -lt 80 ]; then
    exit 0
fi

# Skip non-code files
case "$file_path" in
    *.md|*.txt|*.json|*.yml|*.yaml|*.lock|*.log) exit 0 ;;
    */node_modules/*|*/dist/*|*/build/*|*/.git/*) exit 0 ;;
esac

# Detect language from file extension (passed as a hint to the embedder)
case "$file_path" in
    *.ts|*.tsx) language="typescript" ;;
    *.js|*.jsx|*.mjs|*.cjs) language="javascript" ;;
    *.py) language="python" ;;
    *.go) language="go" ;;
    *.rs) language="rust" ;;
    *.java) language="java" ;;
    *.rb) language="ruby" ;;
    *.cs) language="csharp" ;;
    *) language="" ;;
esac

# Bearer token — required for /api/* in local mode
if [ ! -r "$TOKEN_FILE" ]; then
    # No token file — daemon may not be running. Fail-open silently.
    exit 0
fi
token=$(cat "$TOKEN_FILE")

# Build the request body. Use jq to safely encode the content string.
body=$(jq -n --arg content "$content" --arg lang "$language" '{content: $content, language: $lang}')

# Call the daemon. Timeout protects against hangs blocking the agent.
response=$(curl -sS \
    --max-time "$TIMEOUT_SEC" \
    -H "Authorization: Bearer ${token}" \
    -H "Content-Type: application/json" \
    -d "$body" \
    "${LORE_DAEMON}/api/code-similar" 2>/dev/null) || {
    # Daemon unreachable — fail-open per design
    exit 0
}

decision=$(echo "$response" | jq -r '.decision // "allow"' 2>/dev/null)

if [ "$decision" = "warn" ]; then
    rec=$(echo "$response" | jq -r '.recommendation // empty' 2>/dev/null)
    is_strong=$(echo "$response" | jq -r '.strong_match // false' 2>/dev/null)
    icon="💡"
    [ "$is_strong" = "true" ] && icon="⚠️"
    echo "${icon} [lore] ${rec}" >&2
fi

exit 0
