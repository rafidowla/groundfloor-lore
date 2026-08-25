#!/usr/bin/env bash
# mark-pack-stale.sh — Post-commit hook for Lore stale detection (Gap #3).
#
# Counts files changed in the last commit. If the count exceeds
# LORE_STALE_THRESHOLD (default: 10), marks all orientation-pack nodes
# stale so AI coding assistants know to verify their content before trusting it.
#
# Install via:  bash scripts/install-hooks.sh
# Or manually:  cp scripts/mark-pack-stale.sh .git/hooks/post-commit && chmod +x .git/hooks/post-commit

set -euo pipefail

THRESHOLD="${LORE_STALE_THRESHOLD:-10}"

# Count files changed in the last commit (gracefully handle initial commits).
CHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null | wc -l | tr -d ' ')

# If we can't compute a diff (e.g. initial commit), exit silently.
if [ -z "$CHANGED" ] || ! [[ "$CHANGED" =~ ^[0-9]+$ ]]; then
    exit 0
fi

if [ "$CHANGED" -le "$THRESHOLD" ]; then
    # Small commit — no action needed.
    exit 0
fi

echo "[Lore] $CHANGED files changed — marking orientation-pack nodes stale"

# Resolve the CLI path relative to the repo root.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
LORE_CLI="$REPO_ROOT/dist/lore/src/cli/index.js"

if [ ! -f "$LORE_CLI" ]; then
    echo "[Lore] CLI not found at $LORE_CLI (run 'npm run build' first). Skipping stale mark."
    echo "[Lore] You can mark nodes stale manually: node $LORE_CLI mark-stale --tags orientation-pack"
    exit 0
fi

# Try to mark nodes stale. If the command fails (e.g. Kùzu lock held by
# daemon), print a non-fatal warning and exit 0 so the commit is not blocked.
if node "$LORE_CLI" mark-stale --tags orientation-pack 2>&1; then
    echo "[Lore] orientation-pack nodes marked stale. Run 'lore recall' to check which nodes need refreshing."
else
    echo "[Lore] Warning: could not mark nodes stale (non-fatal). Try: node $LORE_CLI mark-stale --tags orientation-pack"
fi

exit 0
