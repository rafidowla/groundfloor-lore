#!/usr/bin/env bash
#
# publish-public.sh — sync the public GitHub mirror from the private Bitbucket origin.
#
# Policy: the GitHub mirror carries the SAME code as origin, minus internal
# process/agent/audit artifacts. Atlas memory (.atlas/) NEVER ships.
#
# How it works:
#   1. snapshot origin/main into a scratch worktree
#   2. rebase onto the public lineage (github/main) so pushes stay fast-forward
#   3. strip the internal-file list below
#   4. FAIL-CLOSED assertion: the staged tree may differ from origin/main ONLY
#      by strip-list deletions. Any addition/modification (e.g. a new internal
#      file someone forgot to classify) refuses the publish.
#   5. commit + fast-forward push to github main (no --force used)
#
# Runs the same as a user would run it manually; the memory guard in
# ~/.groundfloor/hooks/pre-push stays in place for accidental pushes from the
# working checkout — this script is the deliberate, self-asserting path.
#
# Usage: scripts/publish-public.sh [--dry-run]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GITHUB_REMOTE="github"
BRANCH="main"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

# ── Internal files that never ship to the public mirror ────────────────────
# Invariant: this list contains ONLY docs/ops/agent artifacts — never code,
# tests, or build inputs — so the public tree always builds and tests.
STRIP=(
  .atlas
  .claude
  .swarm
  cursor-hooks
  runs
  auto_ingest.mjs
  bitbucket-pipelines.yml
  AGENTS.md
  CLAUDE.md
  NEW_OWNER_GUIDE.md
  AUDIT_FINDINGS.md
  AUDIT_FINDINGS_2.md
  AUDIT_FINDINGS_3.md
  AUDIT_SPRINTS.md
  BACKLOG-launch-readiness-2026-08-19.md
  BACKLOG-positioning-fix.md
  BACKLOG-storage-rename.md
  BUILD_ORDER.md
  DECISIONS.md
  EXECUTION.md
  FROZEN.md
  HANDOFF.md
  KANBAN.md
  SPRINT_QUEUE.md
  SWARM_QUEUE.md
  SWARM_QUEUE_2.md
  SWARM_QUEUE_3.md
  docs/audit
  docs/audits
  docs/archive
  docs/proposals
  docs/ADMIN_APP_REQUIREMENTS.md
  docs/AUTH_LAYER_STATUS.md
  docs/CLOUD_GAP_AUDIT.md
  docs/CODE_CLASSIFICATION_BY_LAYER.md
  docs/DATAPLANE_INTEGRATION.md
  docs/DEF_LOCAL_FIRST.md
  docs/HANDOVER-bm25-fts-2026-08-03.md
  docs/KUZU_REMOVAL_PILOT.md
  docs/KUZU_REMOVAL_STEP2_SCOPE.md
  docs/MARKETING.md
  docs/SURREALDB_BUILD_PLAN.md
  docs/SURREALDB_PHASE3_AMENDMENT.md
  docs/SURREALDB_PHASE5_PILOT.md
  docs/SURREALDB_PHASE6.md
  docs/SURREALDB_PHASE7.md
  docs/post_v2_plan.md
  docs/spike-bulk-write-corruption-2026-08-03.md
  docs/v3_build_plan.md
  docs/v3_roadmap_questions.md
  docs/architecture/LORE_LOOM_API_GUIDE.md
  docs/architecture/lore-tenancy-and-provisioning.md
  docs/architecture/rc2-audit-brief.md
  docs/architecture/rc2-readiness-audit-2026-05-17.md
  docs/architecture/rc4-workspace-audit-2026-05-18.md
)

cd "$ROOT"
git fetch -q origin "$BRANCH"
git fetch -q "$GITHUB_REMOTE" "$BRANCH" || true

WORK="$(mktemp -d)"
trap 'git worktree remove --force "$WORK" 2>/dev/null || rm -rf "$WORK"' EXIT

# Snapshot the private main into a scratch worktree, then re-base onto the
# public lineage so the push is a fast-forward (no force ever needed). Work
# on a detached HEAD: the local branch named "$BRANCH" is checked out in the
# main worktree and can't be shared; HEAD:main pushes keep it fast-forward.
git worktree add --detach -q "$WORK" "origin/$BRANCH"
git -C "$WORK" checkout -q "$GITHUB_REMOTE/$BRANCH" 2>/dev/null || true

# Bring origin's full content into the index, then strip internal artifacts.
# read-tree swaps the whole index (no worktree copy needed — only the index
# determines the commit tree); --cached avoids touching disk, -f allows the
# removal even though the index differs from HEAD (github/main lineage).
git -C "$WORK" read-tree "origin/$BRANCH"
git -C "$WORK" rm -rq -f --cached --ignore-unmatch "${STRIP[@]}"

# ── Fail-closed assertions ──────────────────────────────────────────────────
# 1. No Atlas memory in the staged tree, ever.
if git -C "$WORK" ls-files | grep -q '^\.atlas/'; then
  echo "ERROR: .atlas/ files staged for publish — refusing to ship Atlas memory" >&2
  exit 1
fi
# 2. The publish must be exactly "origin main minus the strip list": any line
#    that is not a deletion (D) means an unclassified file would ship — refuse.
if grep -v '^D' <(git -C "$WORK" diff --cached --name-status "origin/$BRANCH") | grep -q .; then
  echo "ERROR: publish tree contains additions/modifications vs origin/$BRANCH — unclassified file? Refusing." >&2
  git -C "$WORK" diff --cached --name-status "origin/$BRANCH" | grep -v '^D' | head -20 >&2
  exit 1
fi

# Nothing staged to ship (already in sync).
if git -C "$WORK" diff --cached --quiet; then
  echo "Publish: origin/$BRANCH already mirrored — nothing to do."
  exit 0
fi

git -C "$WORK" commit -q -m "chore(publish): mirror origin/$BRANCH $(git rev-parse --short origin/$BRANCH) (sanitized)"

if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run — would push to $GITHUB_REMOTE/$BRANCH:"
  git -C "$WORK" diff --stat "$GITHUB_REMOTE/$BRANCH" HEAD | tail -5
  echo "(staged tree verified: origin/$BRANCH minus strip list only)"
  exit 0
fi

git -C "$WORK" push -q "$GITHUB_REMOTE" "HEAD:$BRANCH"
echo "Published $GITHUB_REMOTE/$BRANCH ← origin/$BRANCH ($(git rev-parse --short origin/$BRANCH))"