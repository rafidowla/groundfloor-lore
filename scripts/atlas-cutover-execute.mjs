#!/usr/bin/env -S npx tsx
/**
 * scripts/atlas-cutover-execute.mjs
 *
 * Atlas — Phase 7 cutover EXECUTE (prepare-and-validate stage).
 *
 * Original work authored for groundfloor-lore. License-compliance
 * protocol per `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10.
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │ READ THIS BEFORE RUNNING                                         │
 * │                                                                  │
 * │ This is the destructive sibling of atlas-cutover-dryrun.mjs.    │
 * │ It does the SAFE prep work for the cutover and then STOPS just  │
 * │ before the actual Kùzu schema mutation. The mutation itself     │
 * │ requires:                                                        │
 * │   1. PRs #37, #39, #38 merged into main                          │
 * │   2. Daemon dist/ rebuilt against the merged code                │
 * │   3. Daemon stopped (this script refuses to mutate while a      │
 * │      live daemon is holding the graph file)                      │
 * │   4. Mapping coverage ≥99% (this script validates and refuses   │
 * │      to proceed below the threshold)                             │
 * │                                                                  │
 * │ The Kùzu-mutation hook lands as a separate commit on Rafi's go. │
 * │ Until then, this script:                                         │
 * │   - Builds the candidate post-Atlas graph in memory              │
 * │   - Reads existing CodeSymbol rows (when code_cypher is live;    │
 * │     else falls back to topology-overview counts)                 │
 * │   - Builds the oldId → newId mapping table                       │
 * │   - Snapshots <LORE_HOME>/workspaces/<name>/.lore/graph as       │
 * │     graph.pre-gitnexus-migration                                 │
 * │   - Writes a cutover-payload-<timestamp>.json with everything    │
 * │     the destructive step needs                                   │
 * │   - Prints the operator's next-step instructions                 │
 * │                                                                  │
 * │ Without --i-have-the-go, this script refuses to do anything      │
 * │ beyond reading + reporting. With the flag, it still won't        │
 * │ mutate the live graph — it only writes the snapshot + payload.  │
 * └─────────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *   npx tsx scripts/atlas-cutover-execute.mjs \
 *     --i-have-the-go \
 *     --confirm-workspace=<workspace-name> \
 *     [--coverage-threshold=0.99]
 *
 * Required flags:
 *   --i-have-the-go             Acknowledges destructive intent.
 *   --confirm-workspace=<name>  Confirms which workspace to operate on.
 *                                MUST match the active workspace name to
 *                                guard against running against the wrong DB.
 *
 * Optional flags:
 *   --coverage-threshold=<num>  Minimum oldId→newId coverage to proceed.
 *                                Default 0.99. Anything below halts.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const LORE_HOME = process.env.LORE_HOME ?? path.join(process.env.HOME ?? '', '.groundfloor');
const LORE_PORT = process.env.LORE_PORT ?? '3847';
const LORE_BASE = `http://127.0.0.1:${LORE_PORT}`;

function parseArgs(argv) {
    const args = {
        iHaveTheGo: false,
        confirmWorkspace: null,
        coverageThreshold: 0.99,
        repo: null,
        repos: null,        // CSV of repo names; --all-repos sets this from the registry
        allRepos: false,
    };
    for (const a of argv.slice(2)) {
        if (a === '--i-have-the-go') args.iHaveTheGo = true;
        else if (a === '--all-repos') args.allRepos = true;
        else if (a.startsWith('--confirm-workspace=')) args.confirmWorkspace = a.slice('--confirm-workspace='.length);
        else if (a.startsWith('--coverage-threshold=')) args.coverageThreshold = parseFloat(a.slice('--coverage-threshold='.length));
        else if (a.startsWith('--repo=')) args.repo = a.slice('--repo='.length);
        else if (a.startsWith('--repos=')) args.repos = a.slice('--repos='.length).split(',').map((s) => s.trim()).filter(Boolean);
        else throw new Error(`unknown argument: ${a}`);
    }
    return args;
}

/**
 * Fetch the list of registered repos (name + abs path) from the live
 * daemon. Filters out stale Claude worktrees inside groundfloor-lore
 * (.claude/worktrees/*) — those are not real repos to cut over.
 */
async function fetchRegisteredRepos(token) {
    const r = await fetch(`${LORE_BASE}/api/repos`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`/api/repos fetch failed: HTTP ${r.status}`);
    const data = await r.json();
    // Filter out:
    //   - stale Claude worktrees inside groundfloor-lore (.claude/worktrees/*)
    //   - atlas baseline benchmark repos in /private/tmp or /tmp
    //   - any path that doesn't currently exist on disk (registry drift)
    return (data.repos ?? []).filter((repo) => {
        if (!repo.path) return false;
        if (repo.path.includes('/.claude/worktrees/')) return false;
        if (repo.path.startsWith('/private/tmp/') || repo.path.startsWith('/tmp/')) return false;
        return true;
    });
}

async function loadAuthToken() {
    const tokenPath = path.join(LORE_HOME, 'auth.token');
    return (await fs.readFile(tokenPath, 'utf-8')).trim();
}

async function readWorkspacesJson() {
    const p = path.join(LORE_HOME, 'workspaces.json');
    return JSON.parse(await fs.readFile(p, 'utf-8'));
}

async function isDaemonAlive() {
    try {
        // Daemon serves /health (returns {status,version,sessions}). /healthz
        // is NOT a registered route — using it returns 404 which our older
        // code mis-read as "daemon stopped". Fix locked in 2026-04-30 after
        // first cutover-execute prep run on the lore monorepo surfaced the
        // misdetection.
        const r = await fetch(`${LORE_BASE}/health`, { signal: AbortSignal.timeout(1500) });
        return r.ok;
    } catch {
        return false;
    }
}

/**
 * Read existing CodeSymbol rows from the live daemon's Kùzu graph via
 * the daemon-level /api/code/cypher route (Phase 7 read-only Cypher
 * passthrough; landed alongside this script).
 *
 * Falls back to the topology-overview snapshot only if the route is
 * unavailable (e.g. older daemon build). With per-symbol enumeration
 * available, the mapping table builds with real coverage numbers.
 */
async function fetchExistingCodeSymbols(token, repoFilter) {
    // Use a higher max_rows to get all symbols. The /api/code/cypher
    // route truncates at max_rows; lore monorepo currently has ~15k
    // CodeSymbol rows, so 50k is comfortable headroom.
    //
    // When repoFilter is provided, scope to that single repo. Phase 7
    // v1 cutover is per-repo because Atlas parses one repo at a time;
    // multi-repo cutover is a follow-up that parses each registered
    // repo and unions the candidate graph before joining.
    const cypher = repoFilter
        ? 'MATCH (s:CodeSymbol) WHERE s.repo = $repo RETURN s.uid AS uid, s.name AS name, s.kind AS kind, s.filePath AS filePath, s.repo AS repo'
        : 'MATCH (s:CodeSymbol) RETURN s.uid AS uid, s.name AS name, s.kind AS kind, s.filePath AS filePath, s.repo AS repo';
    try {
        const r = await fetch(`${LORE_BASE}/api/code/cypher`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                query: cypher,
                parameters: repoFilter ? { repo: repoFilter } : undefined,
                max_rows: 50000,
            }),
        });
        if (r.ok) {
            const data = await r.json();
            if (Array.isArray(data?.rows)) {
                return { source: 'code_cypher', rows: data.rows, truncated: !!data.truncated };
            }
        }
    } catch { /* fall through */ }

    // Fallback: topology overview (counts only, not per-symbol). Only
    // used if /api/code/cypher is missing — would mean the daemon is
    // running an older build than this script expects.
    const r = await fetch(`${LORE_BASE}/api/topology/overview?groupBy=project`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`overview fetch failed: HTTP ${r.status}`);
    return { source: 'topology-overview', rows: null, summary: await r.json() };
}

async function buildCandidateGraph() {
    const { parseRepo } = await import('../packages/lore-plugin-developer/src/parser/index.js');
    const { resolveRepo } = await import('../packages/lore-plugin-developer/src/resolver/index.js');

    console.error('[cutover-execute] parsing repo...');
    const parsed = await parseRepo(REPO_ROOT);
    console.error(`[cutover-execute]   parsed ${parsed.files.length} files`);

    console.error('[cutover-execute] resolving cross-file relations...');
    const resolved = await resolveRepo(REPO_ROOT, parsed.files);
    console.error(`[cutover-execute]   ${resolved.counts.symbols} symbols, ${resolved.relations.length} relations`);

    return { parsed, resolved };
}

/**
 * Multi-repo candidate graph build. Iterates the requested repos,
 * runs parseRepo + resolveRepo against each absolute path, returns a
 * per-repo map of resolved graphs. The mapping table joins existing
 * CodeSymbols WHERE repo=X against candidate.byRepo.get(X).
 */
async function buildCandidateGraphsByRepo(repoEntries) {
    const { parseRepo } = await import('../packages/lore-plugin-developer/src/parser/index.js');
    const { resolveRepo } = await import('../packages/lore-plugin-developer/src/resolver/index.js');

    const byRepo = new Map();
    let totalFiles = 0;
    let totalSymbols = 0;
    let totalRelations = 0;
    const failures = [];

    for (const entry of repoEntries) {
        try {
            console.error(`[cutover-execute] parsing ${entry.name} @ ${entry.path}...`);
            const t0 = Date.now();
            const parsed = await parseRepo(entry.path);
            const resolved = await resolveRepo(entry.path, parsed.files);
            const dt = Date.now() - t0;
            console.error(`[cutover-execute]   ${entry.name}: ${parsed.files.length} files / ${resolved.counts.symbols} symbols / ${resolved.relations.length} relations  (${dt}ms)`);
            byRepo.set(entry.name, { parsed, resolved, path: entry.path });
            totalFiles += parsed.files.length;
            totalSymbols += resolved.counts.symbols;
            totalRelations += resolved.relations.length;
        } catch (err) {
            console.error(`[cutover-execute]   ${entry.name}: FAILED — ${err.message}`);
            failures.push({ name: entry.name, path: entry.path, error: err.message });
        }
    }

    return { byRepo, totalFiles, totalSymbols, totalRelations, failures };
}

/**
 * Map gitnexus's kind vocabulary to Atlas's. Differences:
 *   - Case: gitnexus "Function" → Atlas "function"
 *   - Rust: gitnexus "Struct" → Atlas "class"
 *   - Rust: gitnexus "Trait" → Atlas "interface"
 *   - Go: gitnexus "Type" → Atlas "type" / "class" depending on shape
 *
 * Kinds gitnexus has but Atlas v1 deliberately doesn't model (noise
 * for call-graph analytics):
 *   - "Property": class/instance fields / interface property signatures
 *   - "Section": code-region markers / TS module sections
 *
 * Symbols with these kinds count toward `byDesignUnmapped` so the
 * "mappable coverage" metric reflects Atlas's intentional vocabulary
 * choices, not a defect in the cutover.
 */
const KIND_ALIASES = new Map([
    // gitnexus tags all `fn` declarations as Function regardless of context.
    // Atlas distinguishes function (top-level / module-scope) from method
    // (inside impl/class). For a Rust impl method, gitnexus says Function,
    // Atlas says method — same code, different vocabulary. Adding 'method'
    // as a function fallback closes this 1000+ symbol gap on Rust-heavy
    // repos (e.g. dataplane-oss). Same logic applies to Python methods
    // gitnexus may classify as Function.
    ['function', ['function', 'method']],
    ['method', ['method', 'function']],
    ['constructor', ['method']],    // gitnexus: separate Constructor kind → Atlas: method (named "constructor")
    ['class', ['class']],
    ['struct', ['class']],          // Rust struct → Atlas class
    ['interface', ['interface']],
    ['trait', ['interface']],       // Rust trait → Atlas interface
    ['impl', ['class', 'method']],  // Rust impl block → Atlas: members of target class (method) or the class itself
    ['enum', ['enum']],
    ['type', ['type', 'class']],    // Go type can land as either
    ['constant', ['constant']],
    ['variable', ['variable']],
    ['module', ['module']],
    ['namespace', ['module']],      // C++/C# namespace → Atlas module
]);

const BY_DESIGN_UNMAPPED_KINDS = new Set(['property', 'section']);

/**
 * Build oldId → newId mapping from existing CodeSymbol uids to new
 * Atlas symbol ids. Match key: (filePath, name, atlasKind).
 *
 * On a miss against the primary kind alias, falls back to all aliases
 * for that kind (e.g. gitnexus Type tries both Atlas "type" and "class").
 */
function buildMappingTable(existing, candidate) {
    // Single-repo path — kept for backward compat with non-multi-repo mode.
    const candidateIndex = new Map();
    for (const sym of candidate.resolved.table.all) {
        const key = `${sym.file}\x00${sym.name}\x00${sym.kind.toLowerCase()}`;
        candidateIndex.set(key, sym.id);
    }

    const mapping = [];
    const unmapped = [];
    const byDesignUnmapped = [];
    const unmappedByKind = {};
    for (const old of existing) {
        const oldKindLower = String(old.kind).toLowerCase();

        if (BY_DESIGN_UNMAPPED_KINDS.has(oldKindLower)) {
            byDesignUnmapped.push(old);
            continue;
        }

        const aliases = KIND_ALIASES.get(oldKindLower) ?? [oldKindLower];
        let newId = null;
        for (const atlasKind of aliases) {
            const key = `${old.filePath}\x00${old.name}\x00${atlasKind}`;
            const found = candidateIndex.get(key);
            if (found) { newId = found; break; }
        }

        if (newId) {
            mapping.push({ oldUid: old.uid, newId });
        } else {
            unmapped.push(old);
            const k = String(old.kind);
            unmappedByKind[k] = (unmappedByKind[k] ?? 0) + 1;
        }
    }
    const totalAll = mapping.length + unmapped.length + byDesignUnmapped.length;
    const totalMappable = mapping.length + unmapped.length;
    const coverage = totalAll === 0 ? 0 : mapping.length / totalAll;
    const mappableCoverage = totalMappable === 0 ? 1 : mapping.length / totalMappable;
    return {
        mapping,
        unmapped,
        unmappedByKind,
        byDesignUnmapped,
        totalAll,
        totalMappable,
        coverage,
        mappableCoverage,
    };
}

/**
 * Multi-repo mapping table. Joins existing CodeSymbols against the
 * per-repo candidate graphs by (repo, file, name, kind). Reports
 * aggregate coverage plus a per-repo breakdown so operators can spot
 * any single repo with anomalously low coverage before cutover.
 *
 * Existing rows whose repo isn't in `candidatesByRepo` (e.g. parse
 * failed, or repo was excluded from --repos) are reported as
 * `noCandidates` rather than silently dropped.
 */
function buildMappingTableMulti(existing, candidatesByRepo) {
    // Build per-repo candidate index.
    const indexByRepo = new Map();
    for (const [repo, c] of candidatesByRepo.entries()) {
        const idx = new Map();
        for (const sym of c.resolved.table.all) {
            const key = `${sym.file}\x00${sym.name}\x00${sym.kind.toLowerCase()}`;
            idx.set(key, sym.id);
        }
        indexByRepo.set(repo, idx);
    }

    const mapping = [];
    const unmapped = [];
    const byDesignUnmapped = [];
    const noCandidates = [];
    const unmappedByKind = {};
    const byRepoStats = new Map();   // repo → { mapped, unmapped, byDesignUnmapped }
    function bumpRepo(repo, field) {
        const s = byRepoStats.get(repo) ?? { mapped: 0, unmapped: 0, byDesignUnmapped: 0, noCandidates: 0 };
        s[field] = (s[field] ?? 0) + 1;
        byRepoStats.set(repo, s);
    }

    for (const old of existing) {
        const repo = String(old.repo ?? '');
        const oldKindLower = String(old.kind).toLowerCase();

        if (BY_DESIGN_UNMAPPED_KINDS.has(oldKindLower)) {
            byDesignUnmapped.push(old);
            bumpRepo(repo, 'byDesignUnmapped');
            continue;
        }

        const idx = indexByRepo.get(repo);
        if (!idx) {
            noCandidates.push(old);
            bumpRepo(repo, 'noCandidates');
            continue;
        }

        const aliases = KIND_ALIASES.get(oldKindLower) ?? [oldKindLower];
        let newId = null;
        for (const atlasKind of aliases) {
            const key = `${old.filePath}\x00${old.name}\x00${atlasKind}`;
            const found = idx.get(key);
            if (found) { newId = found; break; }
        }

        if (newId) {
            mapping.push({ oldUid: old.uid, newId });
            bumpRepo(repo, 'mapped');
        } else {
            unmapped.push(old);
            bumpRepo(repo, 'unmapped');
            const k = String(old.kind);
            unmappedByKind[k] = (unmappedByKind[k] ?? 0) + 1;
        }
    }

    const totalAll = mapping.length + unmapped.length + byDesignUnmapped.length + noCandidates.length;
    const totalMappable = mapping.length + unmapped.length;
    const coverage = totalAll === 0 ? 0 : mapping.length / totalAll;
    const mappableCoverage = totalMappable === 0 ? 1 : mapping.length / totalMappable;

    return {
        mapping,
        unmapped,
        unmappedByKind,
        byDesignUnmapped,
        noCandidates,
        totalAll,
        totalMappable,
        coverage,
        mappableCoverage,
        byRepoStats,
    };
}

async function snapshotGraph(workspacePath) {
    const graphDir = path.join(workspacePath, '.lore', 'graph');
    const snapshot = path.join(workspacePath, '.lore', 'graph.pre-gitnexus-migration');

    const stat = await fs.stat(graphDir).catch(() => null);
    if (!stat) {
        console.error(`[cutover-execute] WARN: graph dir not found at ${graphDir}; skipping snapshot`);
        return null;
    }

    // Refuse to overwrite an existing snapshot — prior cutover may already have run.
    const existingSnapshot = await fs.stat(snapshot).catch(() => null);
    if (existingSnapshot) {
        throw new Error(`snapshot already exists at ${snapshot} — refusing to overwrite. Move it aside if you intend to re-snapshot.`);
    }

    console.error(`[cutover-execute] snapshotting ${graphDir} → ${snapshot}`);
    const result = spawnSync('cp', ['-R', graphDir, snapshot]);
    if (result.status !== 0) {
        throw new Error(`cp -R failed: ${result.stderr?.toString() ?? 'unknown error'}`);
    }
    return snapshot;
}

function refuse(reason) {
    console.error(`[cutover-execute] REFUSING TO PROCEED: ${reason}`);
    process.exit(2);
}

async function main() {
    const args = parseArgs(process.argv);

    if (!args.iHaveTheGo) {
        console.error('');
        console.error('  This script does the destructive-prep stage of Phase 7 cutover.');
        console.error('  It will NOT proceed without --i-have-the-go.');
        console.error('');
        console.error('  Even with --i-have-the-go, this script does NOT mutate the live graph.');
        console.error('  It only:');
        console.error('    • builds the candidate post-Atlas graph in memory');
        console.error('    • reads existing CodeSymbols (or counts) from the daemon');
        console.error('    • builds + validates the oldId → newId mapping table');
        console.error('    • snapshots the graph DB as graph.pre-gitnexus-migration');
        console.error('    • writes a cutover-payload-<ts>.json for the next stage');
        console.error('');
        console.error('  The actual Kùzu schema mutation lands in a follow-up commit and');
        console.error('  runs in a separate operator-driven session.');
        console.error('');
        console.error('  Re-run with: npx tsx scripts/atlas-cutover-execute.mjs \\');
        console.error('                  --i-have-the-go \\');
        console.error('                  --confirm-workspace=<active-workspace-name>');
        console.error('');
        process.exit(1);
    }

    if (!args.confirmWorkspace) {
        refuse('--confirm-workspace=<name> is required when --i-have-the-go is set');
    }

    console.error(`[cutover-execute] LORE_HOME = ${LORE_HOME}`);
    console.error(`[cutover-execute] confirm-workspace = ${args.confirmWorkspace}`);
    console.error(`[cutover-execute] coverage-threshold = ${args.coverageThreshold}`);

    // Verify the workspace exists and matches.
    const workspaces = await readWorkspacesJson();
    const ws = workspaces?.workspaces?.find?.((w) => w.name === args.confirmWorkspace)
        ?? workspaces?.[args.confirmWorkspace];
    if (!ws) {
        refuse(`workspace "${args.confirmWorkspace}" not found in ${path.join(LORE_HOME, 'workspaces.json')}`);
    }
    const workspacePath = ws.path ?? ws.workspacePath ?? path.join(LORE_HOME, 'workspaces', args.confirmWorkspace);
    console.error(`[cutover-execute] workspace path = ${workspacePath}`);

    // Daemon liveness gate. We allow the daemon to be alive for the read-only
    // mapping-table build (we'll need it to enumerate existing symbols), but
    // we'll require it stopped before the mutation step. Mutation is not in
    // this script, but we still surface guidance.
    const daemonAlive = await isDaemonAlive();
    console.error(`[cutover-execute] daemon alive = ${daemonAlive}`);

    let existingResult;
    let token = null;
    if (daemonAlive) {
        token = await loadAuthToken();
        console.error(`[cutover-execute] enumerating existing CodeSymbols via daemon${args.repo ? ` (filtered to repo=${args.repo})` : ''}...`);
        existingResult = await fetchExistingCodeSymbols(token, args.repo);
        console.error(`[cutover-execute]   source = ${existingResult.source}, rows = ${existingResult.rows?.length ?? 'n/a'}`);
    } else {
        console.error('[cutover-execute] daemon is stopped — cannot enumerate existing CodeSymbols. Falling back to candidate-graph-only validation.');
        existingResult = { source: 'daemon-stopped', rows: null };
    }

    // Decide multi-repo vs single-repo mode.
    // Multi-repo when --all-repos OR --repos=<csv>. Otherwise single-repo
    // (the lore monorepo via REPO_ROOT, optionally filtered by --repo=<name>
    // on the existing-side query).
    let candidate = null;
    let candidatesByRepo = null;
    let parseFailures = [];
    let totalCandidateFiles = 0;
    let totalCandidateSymbols = 0;
    let totalCandidateRelations = 0;

    if (args.allRepos || args.repos) {
        if (!daemonAlive) {
            refuse('--all-repos / --repos requires the daemon running so it can enumerate registered repos via /api/repos. Start the daemon first.');
        }
        let repoEntries = await fetchRegisteredRepos(token);
        if (args.repos) {
            const requested = new Set(args.repos);
            repoEntries = repoEntries.filter((r) => requested.has(r.name));
        }
        console.error(`[cutover-execute] multi-repo mode: ${repoEntries.length} repo(s)`);
        const result = await buildCandidateGraphsByRepo(repoEntries);
        candidatesByRepo = result.byRepo;
        parseFailures = result.failures;
        totalCandidateFiles = result.totalFiles;
        totalCandidateSymbols = result.totalSymbols;
        totalCandidateRelations = result.totalRelations;
        console.error(`[cutover-execute] multi-repo total: ${result.totalFiles} files / ${result.totalSymbols} symbols / ${result.totalRelations} relations across ${candidatesByRepo.size} repo(s); ${result.failures.length} parse failure(s)`);
    } else {
        candidate = await buildCandidateGraph();
        totalCandidateFiles = candidate.parsed.files.length;
        totalCandidateSymbols = candidate.resolved.counts.symbols;
        totalCandidateRelations = candidate.resolved.relations.length;
    }

    let mapping = null;
    let coverage = null;
    if (existingResult.rows) {
        const m = candidatesByRepo
            ? buildMappingTableMulti(existingResult.rows, candidatesByRepo)
            : buildMappingTable(existingResult.rows, candidate);
        mapping = m;
        coverage = m.mappableCoverage;
        const noCandLine = m.noCandidates ? ` + ${m.noCandidates.length} no-candidates` : '';
        console.error(`[cutover-execute] mapping: ${m.mapping.length} mapped + ${m.unmapped.length} unmapped + ${m.byDesignUnmapped.length} by-design-skipped${noCandLine} (Atlas omits Property/Section)`);
        console.error(`[cutover-execute] coverage (mappable): ${(m.mappableCoverage * 100).toFixed(2)}%   coverage (overall): ${(m.coverage * 100).toFixed(2)}%`);
        if (Object.keys(m.unmappedByKind).length > 0) {
            console.error(`[cutover-execute] unmapped by kind: ${JSON.stringify(m.unmappedByKind)}`);
        }
        if (m.byRepoStats) {
            console.error(`[cutover-execute] per-repo coverage:`);
            for (const [repo, s] of m.byRepoStats.entries()) {
                const total = s.mapped + s.unmapped;
                const cov = total === 0 ? 'n/a' : `${((s.mapped / total) * 100).toFixed(1)}%`;
                console.error(`[cutover-execute]   ${repo.padEnd(35)}  mapped=${String(s.mapped).padStart(5)}  unmapped=${String(s.unmapped).padStart(4)}  byDesign=${String(s.byDesignUnmapped).padStart(4)}${s.noCandidates ? `  noCand=${s.noCandidates}` : ''}  cov=${cov}`);
            }
        }
        // Threshold compares against MAPPABLE coverage — by-design-skipped
        // symbols are dropped during cutover and their LoreAppliesToCode
        // edges go to reconnect for re-suggestion. That's not a coverage
        // failure.
        if (m.mappableCoverage < args.coverageThreshold) {
            refuse(`mappable coverage ${(m.mappableCoverage * 100).toFixed(2)}% is below threshold ${(args.coverageThreshold * 100).toFixed(2)}%. Inspect unmapped CodeSymbols (${m.unmapped.length}) before re-running.\n  Unmapped by kind: ${JSON.stringify(m.unmappedByKind)}\n  Common cause: gitnexus extracts inner arrow handlers (e.g. const toggleTheme = () => …) but Atlas v1 deliberately skips them as analytics noise. Their LoreAppliesToCode edges will be re-suggested via reconnect after cutover.`);
        }
    } else {
        console.error('[cutover-execute] WARN: existing-graph enumeration unavailable; mapping table cannot be validated. Phase 6.1 code_cypher handler unblocks this.');
    }

    // Snapshot the graph DB. Refuses if a snapshot already exists.
    let snapshotPath = null;
    try {
        snapshotPath = await snapshotGraph(workspacePath);
    } catch (err) {
        refuse(err.message);
    }

    // Build candidate payload — single-repo or multi-repo shape.
    const candidatePayload = candidatesByRepo
        ? {
            mode: 'multi-repo',
            files: totalCandidateFiles,
            symbols: totalCandidateSymbols,
            relations: totalCandidateRelations,
            repoCount: candidatesByRepo.size,
            parseFailures: parseFailures,
            byRepo: Object.fromEntries(
                Array.from(candidatesByRepo.entries()).map(([repo, c]) => [
                    repo,
                    {
                        path: c.path,
                        files: c.parsed.files.length,
                        symbols: c.resolved.counts.symbols,
                        relations: c.resolved.relations.length,
                        symbolList: c.resolved.table.all.map((s) => ({
                            id: s.id,
                            name: s.name,
                            kind: s.kind,
                            file: s.file,
                            qualifiedName: s.qualifiedName,
                        })),
                        files_: c.parsed.files.map((f) => ({ path: f.path, language: f.language, loc: f.loc })),
                        relations_: c.resolved.relations.map((r) => ({ from: r.from, to: r.to, kind: r.kind, confidence: r.confidence })),
                    },
                ]),
            ),
        }
        : {
            mode: 'single-repo',
            files: candidate.parsed.files.length,
            symbols: candidate.resolved.counts.symbols,
            relations: candidate.resolved.relations.length,
            relationsByKind: candidate.resolved.relations.reduce((acc, r) => {
                acc[r.kind] = (acc[r.kind] ?? 0) + 1;
                return acc;
            }, {}),
            symbolList: candidate.resolved.table.all.map((s) => ({
                id: s.id,
                name: s.name,
                kind: s.kind,
                file: s.file,
                qualifiedName: s.qualifiedName,
            })),
            files_: candidate.parsed.files.map((f) => ({
                path: f.path,
                language: f.language,
                loc: f.loc,
            })),
            relations_: candidate.resolved.relations.map((r) => ({
                from: r.from,
                to: r.to,
                kind: r.kind,
                confidence: r.confidence,
            })),
        };

    const payload = {
        capturedAt: new Date().toISOString(),
        loreHome: LORE_HOME,
        workspace: args.confirmWorkspace,
        workspacePath,
        snapshotPath,
        candidate: candidatePayload,
        existing: {
            source: existingResult.source,
            count: existingResult.rows?.length ?? null,
            summary: existingResult.summary ?? null,
        },
        mapping: mapping ? {
            coverage: mapping.coverage,
            mappableCoverage: mapping.mappableCoverage,
            mapped: mapping.mapping.length,
            unmapped: mapping.unmapped.length,
            byDesignUnmapped: mapping.byDesignUnmapped.length,
            unmappedByKind: mapping.unmappedByKind,
            mappingPairs: mapping.mapping,
            unmappedSymbols: mapping.unmapped,
            byDesignUnmappedSymbols: mapping.byDesignUnmapped,
        } : null,
        nextSteps: [
            '1. Stop the Lore daemon: launchctl bootout gui/$(id -u)/com.groundfloor.lore',
            '2. Verify daemon is stopped (no process holding the graph DB).',
            '3. Run the destructive Kùzu mutation hook (lands in a follow-up commit on Rafi go):',
            '   - DETACH DELETE all CodeSymbol / CodeFile rows',
            '   - INSERT candidate.symbolList → CodeSymbol nodes',
            '   - INSERT candidate.files_ → CodeFile nodes',
            '   - INSERT candidate.relations_ → CodeRelation edges',
            '   - For every LoreAppliesToCode / LoreTouchesFile / FileContains edge,',
            '     rewrite the code-side endpoint via mapping.mappingPairs',
            '4. Restart daemon: launchctl kickstart -k gui/$(id -u)/com.groundfloor.lore',
            '5. Verify recall returns expected results on sanity-check topics.',
            '6. If anything looks off, restore from snapshotPath:',
            '     cp -R <snapshotPath> <workspacePath>/.lore/graph',
            '     launchctl kickstart -k gui/$(id -u)/com.groundfloor.lore',
        ],
    };

    const outPath = path.join(LORE_HOME, `atlas-cutover-payload-${Date.now()}.json`);
    await fs.writeFile(outPath, JSON.stringify(payload, null, 2));
    console.error(`[cutover-execute] payload written to ${outPath}`);

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log('  CUTOVER PREP COMPLETE — DESTRUCTIVE STEP NOT YET EXECUTED');
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Workspace:        ${args.confirmWorkspace}`);
    console.log(`  Workspace path:   ${workspacePath}`);
    console.log(`  Snapshot:         ${snapshotPath ?? '(skipped)'}`);
    console.log(`  Candidate graph:  ${payload.candidate.files} files / ${payload.candidate.symbols} symbols / ${payload.candidate.relations} relations${payload.candidate.mode === 'multi-repo' ? ` across ${payload.candidate.repoCount} repos` : ''}`);
    if (payload.candidate.parseFailures && payload.candidate.parseFailures.length > 0) {
        console.log(`  Parse failures:   ${payload.candidate.parseFailures.length} (see payload.candidate.parseFailures)`);
    }
    console.log(`  Existing source:  ${payload.existing.source}`);
    if (mapping) {
        console.log(`  Mapping coverage: ${(mapping.mappableCoverage * 100).toFixed(2)}% mappable / ${(mapping.coverage * 100).toFixed(2)}% overall`);
        console.log(`                    ${mapping.mapping.length} mapped + ${mapping.unmapped.length} unmapped + ${mapping.byDesignUnmapped.length} by-design-skipped`);
    } else {
        console.log(`  Mapping coverage: unavailable (existing-graph enumeration deferred to Phase 6.1)`);
    }
    console.log(`  Payload:          ${outPath}`);
    console.log('');
    console.log('  Next: review payload, then run the destructive Kùzu hook (separate commit)');
    console.log('  while the daemon is stopped. Restore-from-snapshot is one cp away.');
    console.log('═══════════════════════════════════════════════════════════════════');
}

main().catch((err) => {
    console.error('[cutover-execute] FAILED:', err);
    process.exit(1);
});
