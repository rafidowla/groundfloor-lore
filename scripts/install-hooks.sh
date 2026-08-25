#!/usr/bin/env bash
# install-hooks.sh — Install Lore git hooks into .git/hooks/.
#
# Currently installs:
#   post-commit → scripts/mark-pack-stale.sh
#
# Usage:  bash scripts/install-hooks.sh
#         (Run from the repo root.)
#
# When run outside a git checkout (e.g. during `npm install -g`) this
# script exits cleanly (exit 0) rather than failing the install.

set -euo pipefail

# Guard: exit cleanly if not inside a git checkout.
# This happens when users run `npm install -g @groundfloor/lore` from a
# directory with no .git — the postinstall hook must not block the install.
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "Not a git checkout — skipping hook installation."
    exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
HOOKS_DIR="$REPO_ROOT/.git/hooks"

if [ ! -d "$HOOKS_DIR" ]; then
    echo "Note: .git/hooks/ not found — skipping hook installation."
    exit 0
fi

cp "$REPO_ROOT/scripts/mark-pack-stale.sh" "$HOOKS_DIR/post-commit"
chmod +x "$HOOKS_DIR/post-commit"

echo "Installed: .git/hooks/post-commit → scripts/mark-pack-stale.sh"
echo "The hook will mark orientation-pack nodes stale when a commit touches more than \${LORE_STALE_THRESHOLD:-10} files."
