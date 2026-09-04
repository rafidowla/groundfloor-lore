#!/usr/bin/env node
/**
 * test-no-legacy-engine-refs.mjs — drift guard for the Kùzu removal.
 *
 * Kùzu (the embedded graph engine) was removed from Lore in Phase 3d
 * (2026-08-21): LocalGraph and every Kùzu-only module were deleted, and a
 * repo-wide sweep scrubbed the name from docs/, packages/lore/src/, test/,
 * scripts/, sdks/, README, and package.json. Nothing enforced that the name
 * couldn't quietly creep back in — a copy-pasted comment, a stale doc
 * restored from an old branch, a new script that reaches for the removed
 * dependency in prose. This guard is that enforcement: it greps the whole
 * repo, case-insensitively, for "kuzu"/"kùzu" and fails the build on any hit
 * that isn't one of the two things allowed to still say it:
 *
 *   1. Dated historical/audit/decision records — files that document what
 *      USED to be true and are explicitly exempt (see ALLOWED_FILES /
 *      ALLOWED_GLOBS below). Rewriting these to avoid the word would make
 *      the historical record harder to read, not more accurate.
 *
 *   2. Specific, EXACT literals in specific files — never a whole-file pass —
 *      registered in LITERAL_ALLOWANCES below. Two kinds:
 *
 *        a. Compatibility sentinels: the `'kuzu'` GraphEngineKind /
 *           SubstrateName value that a handful of production modules must
 *           keep verbatim because it matches historical on-disk config /
 *           manifest data (a workspaces.json still declaring
 *           `graphEngine: 'kuzu'`, an archived backup manifest, a migrations
 *           row) — renaming it would break recognition of that real data.
 *           Also the `--kuzu` back-compat CLI flag (accepted, ignored),
 *           the banned-package literal `@kineviz/kuzu-lite` (D-024's import
 *           ratchet needs the exact string to ban), the decision id
 *           `DEC-KUZU-REMOVAL-STEP1`, and the filename token `KUZU_REMOVAL`
 *           where prose links to `docs/KUZU_REMOVAL*.md`.
 *        b. Tests that assert ABOUT one of the above sentinels — a test
 *           proving a legacy `graphEngine: 'kuzu'` declaration is honoured/
 *           refused, or that a doc no longer names the engine — legitimately
 *           needs the literal in its own source to make that assertion.
 *
 *      Every allowance is line-precise: only the registered literal(s) for
 *      THAT file are stripped before re-testing the line, so unrelated Kùzu
 *      prose elsewhere in the same file (there is plenty — removal history is
 *      often documented right next to a sentinel) still fails. A file not
 *      listed gets no allowance at all, no matter how similar its content.
 *
 * Everything else — a stray "Kùzu" in a comment, a docstring, a README, a
 * package.json description, a variable name — is a violation.
 *
 * Exit non-zero on any violation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

/** Directories excluded from the walk entirely, matched by basename. */
const IGNORE_DIR_NAMES = new Set(['node_modules', 'dist', '.git', 'runs', '.atlas']);

/** Binary/generated extensions that are never worth text-scanning. */
const SKIP_EXTENSIONS = new Set(['.gif', '.png', '.jpg', '.jpeg', '.ico', '.woff', '.woff2', '.ttf', '.eot']);

/** kuzu / kùzu, case-insensitive, Unicode-aware (so Ù/ù fold together). */
const KUZU_RE = /k[uù]zu/iu;

/**
 * Files exempt IN FULL — every mention inside them is allowed. These are the
 * guard's own source (which necessarily says "kuzu" all over its comments
 * and regexes) and the test-type quarantine baseline, which is allowed to
 * NAME a historical file whose path happens to contain "kuzu" (e.g. a
 * pre-rename `test/kuzu-*-unit.ts` entry) without that counting as drift.
 */
const ALLOWED_FILES = new Set([
    'scripts/test-no-legacy-engine-refs.mjs',
    '.test-type-baseline.json',
]);

/**
 * Dated historical/audit/decision records — exempt in full. Each of these is
 * either a running changelog/decision log, or a frozen snapshot of a past
 * audit/removal/migration effort. Scrubbing "kuzu" out of them would falsify
 * the historical record rather than clean it up.
 */
const ALLOWED_GLOBS = [
    'CHANGELOG.md',
    'DECISIONS.md',
    'docs/KUZU_REMOVAL*.md',
    'docs/audit/**',
    'docs/audits/**',
    'docs/archive/**',
    'docs/decisions/**',
    'SWARM_QUEUE*.md',
    'AUDIT_*.md',
    'docs/SURREALDB_PHASE*.md',
    'docs/spike-*.md',
    'docs/HANDOVER-*.md',
];

/**
 * Per-file, line-precise literal allowances. See the module docstring above
 * (point 2) for what qualifies and why. Each file lists the EXACT literal(s)
 * it may still carry; every occurrence of every listed literal is stripped
 * from a line before that line is re-tested, so a file gets no allowance for
 * anything not explicitly listed here.
 */
const LITERAL_ALLOWANCES = new Map([
    // The 'kuzu' GraphEngineKind sentinel — implementation + direct
    // `=== 'kuzu'` consumers (resolveWorkspaceGraphEngine's config read and
    // its two callers that route the removed-engine refusal).
    ['packages/lore/src/engines/graphEngineSelector.ts', ["'kuzu'"]],
    ['packages/lore/src/engines/localGraphRegistry.ts', ["'kuzu'"]],
    ['packages/lore/src/engines/openWorkspaceGraph.ts', ["'kuzu'"]],
    // The same sentinel surfacing in the config type, the schema-safety
    // engine-agnostic port, the local-substrate migration vocabulary, and
    // backup/restore's archived-engine detection — all read/write the exact
    // historical value, never rename it.
    ['packages/lore/src/config/workspaces.ts', ["'kuzu'", 'DEC-KUZU-REMOVAL-STEP1']],
    ['packages/lore/src/schemas/substrate/schemaGraphOps.ts', ["'kuzu'"]],
    ['packages/lore/src/migration/types.ts', ["'kuzu'"]],
    ['packages/lore/src/migration/coordinator.ts', ["'kuzu'"]],
    ['packages/lore/src/migration/daemonWiring.ts', ['DEC-KUZU-REMOVAL-STEP1']],
    ['packages/lore/src/engines/backup.ts', ["'kuzu'"]],
    ['packages/lore/src/engines/restore.ts', ["'kuzu'"]],
    // Back-compat CLI flag: accepted and ignored, never re-added as a real
    // option — the name itself is the only thing worth keeping.
    ['packages/lore/src/cli/commands/compact.ts', ['--kuzu']],
    // D-024's import ratchet (scripts/test-arch.mjs) bans this exact package
    // specifier by string match; the filename token links prose to the
    // dated removal record docs/KUZU_REMOVAL*.md (itself fully exempt).
    ['scripts/test-arch.mjs', ['@kineviz/kuzu-lite', '@kineviz\\/kuzu-lite', 'KUZU_REMOVAL']],
    ['scripts/diagnostics/surreal-scale-parity.mjs', ['KUZU_REMOVAL']],
    ['scripts/diagnostics/wal-memory.ts', ['KUZU_REMOVAL']],
    ['scripts/publish-public.sh', ['KUZU_REMOVAL']],
    // Tests that assert ABOUT the 'kuzu' sentinel directly: a legacy
    // graphEngine declaration is honoured as data / refused loudly, or a doc
    // no longer names the removed engine. Each needs the literal in its own
    // source to make that assertion; see the module docstring point 2b.
    ['test/daemon-engine-routing-unit.ts', ["'kuzu'"]],
    // Round-E fix (2026-09-04) — asserts /api/admin/stats surfaces (rather
    // than zeroing) a workspace whose workspaces.json declares the removed
    // 'kuzu' graphEngine sentinel; needs the literal to stand that up.
    ['test/admin-stats-legacy-engine-error-unit.ts', ["'kuzu'"]],
    ['test/open-workspace-graph-unit.ts', ["'kuzu'"]],
    // Round-S fix (2026-09-04, finding 3) — asserts the CLI's own refusal
    // text names the removed engine, and stands up a legacy-declared
    // workspace to exercise it.
    ['test/legacy-engine-cli-refusal-unit.ts', ["'kuzu'", 'kuzu/i']],
    ['test/surreal-backup-roundtrip-unit.ts', ["'kuzu'"]],
    ['test/schema-routes-unit.ts', ["'kuzu'"]],
    ['test/blast-radius-unit.ts', ["'kuzu'"]],
    ['test/sync-status-engine-unit.ts', ["'kuzu'"]],
    ['test/internal/sprint-H-online-migration-property.ts', ['kuzu/i']],
]);

function globToRegExp(glob) {
    // Escape regex metacharacters, then reintroduce * / ** as wildcards.
    // ** matches across path separators; a single * does not.
    let re = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    re = re.replace(/\*\*/g, ' DOUBLESTAR ');
    re = re.replace(/\*/g, '[^/]*');
    re = re.replace(/ DOUBLESTAR /g, '.*');
    return new RegExp(`^${re}$`);
}

const ALLOWED_GLOB_RES = ALLOWED_GLOBS.map(globToRegExp);

/**
 * HISTORICAL_RECORDS — exact-path whole-file exemptions, distinct from the
 * open-ended ALLOWED_GLOBS patterns above. Each of these is a closed, dated
 * audit/plan/log snapshot that must read verbatim as it did when written;
 * rewriting it to drop "kuzu" would falsify the record, not correct it. This
 * is the ONLY other way a file gets a whole-file pass — the guard's existing
 * rule stands that no other blanket exemption is allowed, only these plus
 * ALLOWED_FILES/ALLOWED_GLOBS above. Every entry names why it's frozen.
 */
const HISTORICAL_RECORDS = new Set([
    'BUILD_ORDER.md', // dated build-order snapshot naming the era's storage plan
    'SPRINT_QUEUE.md', // dated sprint log entries naming Kùzu-era fixes verbatim
    '.swarm/manifest.json', // frozen swarm task manifest recording that era's storage contract
    '.swarm/VERIFICATION.md', // frozen swarm verification log from that era
    'docs/architecture/rc2-audit-brief.md', // dated RC2 audit brief naming the substrate mix of its time
    'docs/architecture/rc2-readiness-audit-2026-05-17.md', // dated RC2 readiness audit, frozen findings
    'docs/architecture/rc4-workspace-audit-2026-05-18.md', // dated RC4 workspace audit, frozen findings
    'docs/architecture/agent-layer-extraction-2026-05-17.md', // dated agent-layer extraction plan, frozen
    'docs/CLOUD_GAP_AUDIT.md', // dated 2026-05-09 cloud-parity audit snapshot
    'docs/post_v2_plan.md', // dated post-v2 roadmap naming the era's storage split
    'docs/v3_roadmap_questions.md', // dated v3 roadmap questions naming the era's storage
    'docs/proposals/memory-backbone-brief.md', // dated proposal brief naming the era's compaction constraints
    'docs/SURREALDB_BUILD_PLAN.md', // dated build plan written while the legacy engine was still live
    'benchmarks/longmemeval/results/subset-n25-run.log', // raw captured benchmark run log, verbatim output
    'docs/KUZU_REMOVAL.md', // the removal record itself — the one place allowed to spell the name
]);

function isFullyAllowed(relPath) {
    if (ALLOWED_FILES.has(relPath)) return true;
    if (HISTORICAL_RECORDS.has(relPath)) return true;
    return ALLOWED_GLOB_RES.some((re) => re.test(relPath));
}

/**
 * Filename tokens allowed in ANY file, stripped globally before the kuzu
 * test runs — not a whole-file exemption, the rest of the line must still be
 * clean. Living docs correctly cite the removal record by name in the
 * mandated pointer form ("see docs/KUZU_REMOVAL.md"), and DEC-KUZU-REMOVAL-STEP1
 * is a decision id, not engine prose.
 */
const GLOBAL_LITERAL_ALLOWANCES = ['docs/KUZU_REMOVAL.md', 'KUZU_REMOVAL.md', 'DEC-KUZU-REMOVAL-STEP1'];

function* walk(dir) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (IGNORE_DIR_NAMES.has(entry.name)) continue;
            yield* walk(path.join(dir, entry.name));
            continue;
        }
        if (!entry.isFile()) continue;
        yield path.join(dir, entry.name);
    }
}

function relRepo(p) {
    return path.relative(repoRoot, p).replaceAll('\\', '/');
}

/**
 * Strip every exact occurrence of each of `literals` from a line, then report
 * whether any case-insensitive "kuzu"/"kùzu" remains. Only lines where
 * NOTHING remains are allowed — a line that also carries other Kùzu prose
 * (identifiers, comments) alongside a registered literal still fails.
 */
function lineAllowedByLiterals(line, literals) {
    let stripped = line;
    for (const literal of literals) stripped = stripped.split(literal).join('');
    return !KUZU_RE.test(stripped);
}

const violations = [];

for (const abs of walk(repoRoot)) {
    const ext = path.extname(abs).toLowerCase();
    if (SKIP_EXTENSIONS.has(ext)) continue;

    const relPath = relRepo(abs);
    if (isFullyAllowed(relPath)) continue;

    let content;
    try {
        content = fs.readFileSync(abs, 'utf8');
    } catch {
        continue; // unreadable / not text — nothing to scan.
    }
    if (content.includes('\0')) continue; // binary heuristic.
    if (!KUZU_RE.test(content)) continue; // fast path.

    const allowedLiterals = GLOBAL_LITERAL_ALLOWANCES.concat(LITERAL_ALLOWANCES.get(relPath) ?? []);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!KUZU_RE.test(line)) continue;
        if (lineAllowedByLiterals(line, allowedLiterals)) continue;
        violations.push({ file: relPath, line: i + 1, text: line.trim().slice(0, 160) });
    }
}

if (violations.length === 0) {
    console.log(
        '✓ No-legacy-engine-refs guard passed (no "kuzu"/"kùzu" mentions outside the dated '
        + 'historical records and the registered per-file compatibility literals).',
    );
    process.exit(0);
}

console.error(`✗ No-legacy-engine-refs guard FAILED with ${violations.length} hit(s):\n`);
for (const v of violations) {
    console.error(`  ${v.file}:${v.line}: ${v.text}`);
}
console.error(
    '\nHow to fix:\n'
    + '  Kùzu was removed from Lore (Phase 3d, 2026-08-21; see docs/KUZU_REMOVAL.md).\n'
    + '  A "kuzu"/"kùzu" mention outside a dated historical record is drift — either\n'
    + '  rewrite the prose to describe current (SurrealDB) behaviour, delete the\n'
    + '  stale reference, or rename the file/identifier.\n'
    + '  If the file IS a dated audit/decision/removal-history record that should\n'
    + '  read verbatim, add it to ALLOWED_GLOBS/ALLOWED_FILES in this script.\n'
    + '  If the line NEEDS one specific literal verbatim (a compatibility sentinel,\n'
    + '  a banned-package string, a decision id, a filename token, or a test\n'
    + '  asserting about one of those), add that EXACT literal for that ONE file to\n'
    + '  LITERAL_ALLOWANCES — never a whole-file exemption, and never a broader\n'
    + '  literal than the line actually needs.\n',
);
process.exit(1);
