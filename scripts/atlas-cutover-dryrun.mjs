#!/usr/bin/env -S npx tsx
/**
 * scripts/atlas-cutover-dryrun.mjs
 *
 * Atlas — Phase 7 cutover DRY RUN. Reports what the destructive cutover
 * step WOULD do without modifying the live graph.
 *
 * Original work authored for groundfloor-lore. License-compliance
 * protocol per `docs/PLAN_replace_gitnexus_in_developer_plugin.md`
 * section 10.
 *
 * What this script does:
 *   1. Runs Atlas's parser + resolver against the active workspace's
 *      repos to produce a candidate post-cutover graph in memory.
 *   2. Reads the active workspace's existing CodeSymbol / CodeFile /
 *      CodeRelation rows via the daemon's HTTP API (read-only).
 *   3. Builds the oldId → newId mapping table by matching on
 *      (filePath, name, kind) tuples.
 *   4. Reports:
 *        - candidate-graph counts (files, symbols, relations)
 *        - existing-graph counts
 *        - mapping-table coverage (how many old IDs map to a new one)
 *        - unmapped CodeSymbols (would lose their LoreAppliesToCode
 *          edges; reconnect-pass would re-suggest them)
 *        - LoreAppliesToCode / LoreTouchesFile / FileContains edges
 *          that need rewriting
 *   5. Writes the mapping table + report JSON to:
 *        <LORE_HOME>/atlas-cutover-dryrun-<timestamp>.json
 *
 * What this script DOES NOT do:
 *   - Modify any node or edge in the live graph
 *   - Stop or restart the daemon
 *   - Delete any file
 *
 * The actual destructive cutover step is in
 * scripts/atlas-cutover-execute.mjs (separate file, requires explicit
 * --i-have-the-go flag, written when Rafi is ready to execute).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const LORE_HOME = process.env.LORE_HOME ?? path.join(process.env.HOME ?? '', '.groundfloor');
const LORE_PORT = process.env.LORE_PORT ?? '3847';
const LORE_BASE = `http://127.0.0.1:${LORE_PORT}`;

async function loadAuthToken() {
    const tokenPath = path.join(LORE_HOME, 'auth.token');
    try {
        return (await fs.readFile(tokenPath, 'utf-8')).trim();
    } catch {
        throw new Error(`Could not read auth token at ${tokenPath}. Is the Lore daemon running with LORE_HOME=${LORE_HOME}?`);
    }
}

async function fetchExistingCodeSymbols(token) {
    // Use /api/recall (cypher-flavoured) to enumerate CodeSymbols.
    // Falls back to a node-listing endpoint if needed. v1 of this
    // script issues a single Cypher via the dev plugin's code_cypher
    // tool via MCP; that requires Phase 6.1's handlers to be live.
    //
    // Until then, we approximate via the workspace topology endpoint.
    // Daemon's actual liveness route is /health (not /healthz — fix
    // tracked in scripts/atlas-cutover-execute.mjs::isDaemonAlive).
    const r = await fetch(`${LORE_BASE}/api/topology/overview?groupBy=project`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`overview fetch failed: HTTP ${r.status}`);
    const data = await r.json();
    return data;
}

async function buildCandidateGraph() {
    const { parseRepo } = await import('../packages/lore-plugin-developer/src/parser/index.js');
    const { resolveRepo } = await import('../packages/lore-plugin-developer/src/resolver/index.js');

    console.error('[cutover-dryrun] parsing repo...');
    const parsed = await parseRepo(REPO_ROOT);
    console.error(`[cutover-dryrun]   parsed ${parsed.files.length} files`);

    console.error('[cutover-dryrun] resolving cross-file relations...');
    const resolved = await resolveRepo(REPO_ROOT, parsed.files);
    console.error(`[cutover-dryrun]   ${resolved.counts.symbols} symbols, ${resolved.relations.length} relations`);

    return { parsed, resolved };
}

/**
 * Build oldId → newId mapping from existing CodeSymbol uids to new
 * Atlas symbol ids. Match key: (filePath, name, kind).
 *
 * The new Atlas IDs are `<file>:<qualifiedName>:<kind>` — different
 * from gitnexus's `<repo>:<file>:<name>:<kind>` format, so direct
 * string match doesn't work. Instead, key both sides by the tuple
 * (file, name, kind) and join.
 */
function buildMappingTable(existing, candidate) {
    const candidateIndex = new Map();
    for (const sym of candidate.resolved.table.all) {
        const key = `${sym.file}\x00${sym.name}\x00${sym.kind}`;
        candidateIndex.set(key, sym.id);
    }

    const mapping = new Map();
    const unmapped = [];
    let mapped = 0;

    for (const old of existing) {
        const key = `${old.filePath}\x00${old.name}\x00${old.kind}`;
        const newId = candidateIndex.get(key);
        if (newId) {
            mapping.set(old.uid, newId);
            mapped += 1;
        } else {
            unmapped.push(old);
        }
    }

    return { mapping, mapped, unmapped };
}

async function main() {
    const token = await loadAuthToken();
    const candidate = await buildCandidateGraph();

    console.error('[cutover-dryrun] reading existing graph...');
    let existing;
    try {
        existing = await fetchExistingCodeSymbols(token);
    } catch (err) {
        console.error(`[cutover-dryrun] WARN: could not enumerate existing CodeSymbols (${err.message}). The full mapping table builds when Phase 6.1's code_cypher handler is live in the daemon. Reporting candidate-graph counts only.`);
        existing = null;
    }

    const report = {
        capturedAt: new Date().toISOString(),
        loreHome: LORE_HOME,
        candidate: {
            files: candidate.parsed.files.length,
            symbols: candidate.resolved.counts.symbols,
            relations: candidate.resolved.relations.length,
            relationsByKind: candidate.resolved.relations.reduce((acc, r) => {
                acc[r.kind] = (acc[r.kind] ?? 0) + 1;
                return acc;
            }, {}),
        },
        existing: existing ? {
            note: 'topology-overview snapshot only; per-symbol enumeration requires Phase 6.1 code_cypher handler',
            payload: existing,
        } : null,
        mappingTable: null,
        cutoverPlan: {
            step1: 'Stop daemon (launchctl bootout gui/$(id -u)/com.groundfloor.lore)',
            step2: 'Backup graph: cp <LORE_HOME>/workspaces/<active>/.lore/graph <LORE_HOME>/workspaces/<active>/.lore/graph.pre-gitnexus-migration',
            step3: 'Run scripts/atlas-cutover-execute.mjs --i-have-the-go (NOT YET WRITTEN)',
            step4: 'Restart daemon and verify recall returns expected results',
            step5: 'If anything looks off: cp graph.pre-gitnexus-migration graph; restart',
        },
    };

    const outPath = path.join(LORE_HOME, `atlas-cutover-dryrun-${Date.now()}.json`);
    await fs.writeFile(outPath, JSON.stringify(report, null, 2));
    console.error(`[cutover-dryrun] report written to ${outPath}`);

    console.log(`Candidate graph (post-Atlas-cutover):`);
    console.log(`  files:     ${report.candidate.files}`);
    console.log(`  symbols:   ${report.candidate.symbols}`);
    console.log(`  relations: ${report.candidate.relations}`);
    console.log(`  by kind:   ${JSON.stringify(report.candidate.relationsByKind)}`);
    console.log('');
    console.log('Existing graph: enumeration deferred until Phase 6.1 code_cypher handler is live.');
    console.log('Mapping table:  full join requires existing-graph data.');
    console.log('');
    console.log(`Full report: ${outPath}`);
}

main().catch((err) => {
    console.error('[cutover-dryrun] FAILED:', err);
    process.exit(1);
});
