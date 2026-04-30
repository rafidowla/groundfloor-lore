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
    };
    for (const a of argv.slice(2)) {
        if (a === '--i-have-the-go') args.iHaveTheGo = true;
        else if (a.startsWith('--confirm-workspace=')) args.confirmWorkspace = a.slice('--confirm-workspace='.length);
        else if (a.startsWith('--coverage-threshold=')) args.coverageThreshold = parseFloat(a.slice('--coverage-threshold='.length));
        else throw new Error(`unknown argument: ${a}`);
    }
    return args;
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
        const r = await fetch(`${LORE_BASE}/healthz`, { signal: AbortSignal.timeout(1500) });
        return r.ok;
    } catch {
        return false;
    }
}

/**
 * Direct Kùzu-via-stdin enumeration is intentionally NOT in this script.
 * v1: we ask the daemon (read-only) for the existing CodeSymbol set
 * via Phase 6.1's code_cypher handler when it lands. Until then, this
 * function falls back to the topology-overview snapshot and the script
 * runs in "validate the candidate graph + plan the snapshot" mode.
 */
async function fetchExistingCodeSymbols(token) {
    // Try code_cypher first (when Phase 6.1 lands).
    try {
        const r = await fetch(`${LORE_BASE}/api/code/cypher`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                query: 'MATCH (s:CodeSymbol) RETURN s.uid AS uid, s.name AS name, s.kind AS kind, s.filePath AS filePath',
            }),
        });
        if (r.ok) {
            const data = await r.json();
            if (Array.isArray(data?.rows)) {
                return { source: 'code_cypher', rows: data.rows };
            }
        }
    } catch { /* fall through */ }

    // Fallback: topology overview (counts only, not per-symbol).
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

function buildMappingTable(existing, candidate) {
    const candidateIndex = new Map();
    for (const sym of candidate.resolved.table.all) {
        const key = `${sym.file}\x00${sym.name}\x00${sym.kind}`;
        candidateIndex.set(key, sym.id);
    }

    const mapping = [];
    const unmapped = [];
    for (const old of existing) {
        const key = `${old.filePath}\x00${old.name}\x00${old.kind}`;
        const newId = candidateIndex.get(key);
        if (newId) {
            mapping.push({ oldUid: old.uid, newId });
        } else {
            unmapped.push(old);
        }
    }
    const total = mapping.length + unmapped.length;
    const coverage = total === 0 ? 0 : mapping.length / total;
    return { mapping, unmapped, total, coverage };
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
        console.error('[cutover-execute] enumerating existing CodeSymbols via daemon...');
        existingResult = await fetchExistingCodeSymbols(token);
        console.error(`[cutover-execute]   source = ${existingResult.source}`);
    } else {
        console.error('[cutover-execute] daemon is stopped — cannot enumerate existing CodeSymbols. Falling back to candidate-graph-only validation.');
        existingResult = { source: 'daemon-stopped', rows: null };
    }

    const candidate = await buildCandidateGraph();

    let mapping = null;
    let coverage = null;
    if (existingResult.rows) {
        const m = buildMappingTable(existingResult.rows, candidate);
        mapping = m;
        coverage = m.coverage;
        console.error(`[cutover-execute] mapping coverage = ${(coverage * 100).toFixed(2)}% (${m.mapping.length} / ${m.total})`);
        if (coverage < args.coverageThreshold) {
            refuse(`mapping coverage ${(coverage * 100).toFixed(2)}% is below threshold ${(args.coverageThreshold * 100).toFixed(2)}%. Inspect unmapped CodeSymbols (${m.unmapped.length}) before re-running.`);
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

    const payload = {
        capturedAt: new Date().toISOString(),
        loreHome: LORE_HOME,
        workspace: args.confirmWorkspace,
        workspacePath,
        snapshotPath,
        candidate: {
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
        },
        existing: {
            source: existingResult.source,
            count: existingResult.rows?.length ?? null,
            summary: existingResult.summary ?? null,
        },
        mapping: mapping ? {
            coverage,
            mapped: mapping.mapping.length,
            unmapped: mapping.unmapped.length,
            mappingPairs: mapping.mapping,
            unmappedSymbols: mapping.unmapped,
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
    console.log(`  Candidate graph:  ${payload.candidate.files} files / ${payload.candidate.symbols} symbols / ${payload.candidate.relations} relations`);
    console.log(`  Existing source:  ${payload.existing.source}`);
    if (mapping) {
        console.log(`  Mapping coverage: ${(coverage * 100).toFixed(2)}% (${mapping.mapping.length} mapped / ${mapping.unmapped.length} unmapped)`);
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
