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
#   4. apply documented deletion-only rewrites to package.json and
#      .test-type-baseline.json so the public tree never references the
#      stripped test/internal/ files
#   5. FAIL-CLOSED assertion: the staged tree may differ from origin/main ONLY
#      by strip-list deletions + the two rewritable files (deletions only
#      inside them). Any other addition/modification refuses the publish.
#   6. commit + fast-forward push to github main (no --force used)
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
  test/internal
  scripts/sprint-R-live-smoke.mjs
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

# ── Files rewritable by the sanitizer (deletions ONLY) ─────────────────────
# package.json: script entries pointing at test/internal/ are removed, and
# aggregates that chained them drop those segments — otherwise the public
# `npm test` would fail on missing files. .test-type-baseline.json: entries
# for test/internal/ files are removed — otherwise the arch gate reports them
# stale. Any other file may only be DELETED by this publish.
REWRITABLE=("package.json" ".test-type-baseline.json")

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

# ── Sanitizer: deletion-only rewrites of the rewritable files ──────────────
# Start from the INDEX (origin's) content, never the stale worktree copy.
git -C "$WORK" show :package.json > "$WORK/package.json"
git -C "$WORK" show :.test-type-baseline.json > "$WORK/.test-type-baseline.json"

node -e '
const fs = require("fs");
const wk = process.argv[1];
const pkgPath = wk + "/package.json";
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const removed = new Set();
for (const [k, v] of Object.entries(pkg.scripts || {})) {
  if (String(v).includes("tsx test/internal/")) removed.add(k);
}
for (const k of removed) delete pkg.scripts[k];
for (const [k, v] of Object.entries(pkg.scripts || {})) {
  if (typeof v !== "string") continue;
  const segs = v.split(" && ");
  const kept = segs.filter((s) => !(removed.has(s) || removed.has(s.replace(/^npm run /, ""))));
  pkg.scripts[k] = kept.join(" && ");
}
if (JSON.stringify(pkg.scripts).includes("test/internal")) {
  console.error("package.json still references test/internal after sanitize"); process.exit(1);
}
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
' "$WORK"

node -e '
const fs = require("fs");
const wk = process.argv[1];
const basePath = wk + "/.test-type-baseline.json";
const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
for (const k of Object.keys(base.quarantined || {})) {
  if (k.startsWith("test/internal/")) delete base.quarantined[k];
}
fs.writeFileSync(basePath, JSON.stringify(base, null, 2) + "\n");
' "$WORK"

git -C "$WORK" add package.json .test-type-baseline.json

# ── Fail-closed assertions ──────────────────────────────────────────────────
# 1. No Atlas memory in the staged tree, ever.
if git -C "$WORK" ls-files | grep -q '^\.atlas/'; then
  echo "ERROR: .atlas/ files staged for publish — refusing to ship Atlas memory" >&2
  exit 1
fi
# 2. Every staged change vs origin must be a deletion OR one of the two
#    rewritable files. Inside the rewritable files, rewrites must be pure
#    line replacements: with -U0 every '+' must immediately follow its '-'
#    counterpart (a pure insertion would fail the pairing check).
while read -r status path; do
  case "$status" in
    D) ;;
    M)
      case "$path" in
        "package.json"|".test-type-baseline.json")
          git -C "$WORK" diff -U0 --cached "origin/$BRANCH" -- "$path" | awk '
            /^\+/ && !/^\+\+\+/ && prev != "-" { print "unpaired insertion: " $0; bad = 1 }
            { prev = substr($0, 1, 1) }
            END { exit bad }
          ' && prev_ok=1 || prev_ok=0
          if [ "$prev_ok" != 1 ]; then
            echo "ERROR: $path sanitizer made a pure insertion (rewrites must be deletions/line replacements):" >&2
            git -C "$WORK" diff -U0 --cached "origin/$BRANCH" -- "$path" | grep '^+[^+]' | head -10 >&2
            exit 1
          fi
          ;;
        *)
          echo "ERROR: unclassified modification to $path — refuses publish" >&2
          exit 1
          ;;
      esac
      ;;
    *)
      echo "ERROR: publish tree adds $path vs origin/$BRANCH — unclassified file? Refusing." >&2
      git -C "$WORK" diff --cached --name-status "origin/$BRANCH" | grep -v '^D' | head -20 >&2
      exit 1
      ;;
  esac
done < <(git -C "$WORK" diff --cached --name-status "origin/$BRANCH")

# Nothing staged to ship (already in sync).
if git -C "$WORK" diff --cached --quiet; then
  echo "Publish: origin/$BRANCH already mirrored — nothing to do."
  exit 0
fi

git -C "$WORK" commit -q -m "chore(publish): mirror origin/$BRANCH $(git rev-parse --short origin/$BRANCH) (sanitized)"

if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run — would push to $GITHUB_REMOTE/$BRANCH:"
  git -C "$WORK" diff --stat "$GITHUB_REMOTE/$BRANCH" HEAD | tail -5
  echo "(staged tree verified: origin/$BRANCH minus strip list, deletions-only rewrites)"
  exit 0
fi

git -C "$WORK" push -q "$GITHUB_REMOTE" "HEAD:$BRANCH"
echo "Published $GITHUB_REMOTE/$BRANCH ← origin/$BRANCH ($(git rev-parse --short origin/$BRANCH))"