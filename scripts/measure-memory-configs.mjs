#!/usr/bin/env node
/**
 * scripts/measure-memory-configs.mjs — attribution configs for the
 * memory-leak sprint's "who owns the ~100 MB/cycle `embedded` leaks"
 * question (docs/PERFORMANCE-MEMORY.md, "Attribution (3.19.1)" section).
 *
 * Sibling module to measure-memory.mjs, kept separate so that file stays
 * under its 800-line budget (CLAUDE.md's file-size rule is scoped to
 * packages/**\/src/ and does not technically cover scripts/, but the same
 * discipline is worth keeping here). Holds the cycle bodies + substrate
 * file-descriptor sampling for the configs added on top of the original
 * three (inproc / worker / embedded):
 *
 *   embedded-empty        — createLore()+dispose(), zero writes. Isolates
 *                           instance construction itself.
 *   embedded-precomputed  — same embedded object graph, but the write goes
 *                           straight to VerbatimStore.bulkUpsertPrebuiltRows
 *                           with a locally-generated vector, so the ONNX
 *                           pipeline's embed() is never called. Isolates the
 *                           embedding model's contribution.
 *   embed-only            — no Lore at all: a fresh LocalEmbeddingProvider
 *                           per cycle, .initialize() + embedDocumentBatch().
 *   surreal-only           — no Lore facade: a bare SurrealGraph on a fresh
 *                           dir, bulkUpsertNodes(), close().
 *   workspace-cycle       — the host shape Atlas actually runs: ONE
 *                           long-lived embedded Lore instance; each cycle
 *                           registers + opens + writes + evicts a FRESH
 *                           workspace through the per-workspace graph
 *                           registry AND the per-workspace verbatim
 *                           resolver.
 *
 * `inproc-nogc` needs no new cycle body at all — it is plain `inproc` with
 * `--force-gc 0` baked into the config name so it's a single reproducible
 * command; measure-memory.mjs handles that alias inline (RUN_CONFIG).
 *
 * MEASUREMENT ONLY. Nothing here is imported by packages/lore/src/**, and
 * nothing here edits a package source file — it only calls the PUBLIC
 * LoreInstance surface (plus the documented `_daemon` escape hatch the
 * sprint brief itself names) and two engine classes directly, the same way
 * measure-memory.mjs's existing `inproc`/`worker` configs already do.
 */

import { execFileSync } from 'node:child_process';

/* ─── fd / substrate-file sampling ──────────────────────────────────────
 * Best-effort via `lsof -p <pid>`; both return null (never throw) when
 * lsof is unavailable, needs elevated privilege, or the call fails —
 * callers must treat null as "not measured", same contract as
 * measure-memory.mjs's own vmmapFootprintMb(). */

/** Total open file descriptors for `pid` (lsof's own header row excluded). */
export function sampleFdCount(pid) {
    try {
        const out = execFileSync('lsof', ['-p', String(pid)], {
            encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        const lines = out.split('\n').filter((l) => l.trim().length > 0);
        return Math.max(0, lines.length - 1); // minus the header row
    } catch {
        return null; // lsof missing, needs sudo, timed out, or process already gone
    }
}

/**
 * Within the SAME `lsof -p <pid>` snapshot, counts open-file lines whose
 * path mentions LanceDB / SQLite / SurrealDB (case-insensitive substring —
 * cheap and sufficient to see a count rise or fail-to-fall across cycles;
 * NOT an exact per-handle accounting, since one logical store can hold
 * several fds — manifest, data files, WAL, lock file).
 */
export function sampleSubstrateFileCounts(pid) {
    try {
        const out = execFileSync('lsof', ['-p', String(pid)], {
            encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
        });
        let lance = 0, sqlite = 0, surreal = 0;
        for (const line of out.split('\n')) {
            const l = line.toLowerCase();
            if (l.includes('lancedb')) lance++;
            if (l.includes('.sqlite')) sqlite++;
            if (l.includes('surreal')) surreal++;
        }
        return { lanceFiles: lance, sqliteFiles: sqlite, surrealFiles: surreal };
    } catch {
        return { lanceFiles: null, sqliteFiles: null, surrealFiles: null };
    }
}

/* ─── config: embedded-empty ─────────────────────────────────────────────
 * createLore()+dispose(), ZERO writes. Answers: is the leak in instance
 * construction itself, before a single byte is ever written? */
export async function runEmbeddedEmptyCycle(createLore, dataDir, cycle) {
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    await lore.dispose(`measure-memory-empty-cycle-${cycle}`);
}

/** Deterministic fake vector generator (same PRNG shape as
 *  measure-memory.mjs's FakeEmbeddingProvider) — cheap, no ONNX, valid
 *  float range for a LanceDB vector column. */
export function precomputedVec(dim, seed) {
    let s = seed >>> 0;
    const out = new Array(dim);
    for (let i = 0; i < dim; i++) {
        s = (s * 1664525 + 1013904223) >>> 0;
        out[i] = (s / 4294967296) * 2 - 1;
    }
    return out;
}

/* ─── config: embedded-precomputed ───────────────────────────────────────
 * Same embedded object graph (createLore()/dispose()) as the baseline
 * `embedded` config, but the write bypasses the ONNX pipeline entirely.
 *
 * Why this path and not something else reachable from LoreInstance:
 *   - `LoreStorageClient.verbatimStore()` — what the baseline `embedded`
 *     config calls — always re-embeds internally; it has no
 *     precomputed-vector parameter (see storage/loreStorageClient.ts:537).
 *   - `lore.bulkIngest(nodes, { embed: 'precomputed' })` IS reachable and
 *     does skip the ONNX model, but it also routes every node through the
 *     full graph-write + per-workspace-verbatim-resolver machinery — extra
 *     weight unrelated to this config's one question. That heavier, more
 *     realistic path is exactly what `workspace-cycle` below exercises.
 *   - `lore.store.loreVerbatim` is the SAME `VerbatimStore` instance the
 *     baseline `embedded` config's `storageClient.verbatimStore()` calls
 *     into (`storageBundle.ts` binds one instance to both). Calling its
 *     `bulkUpsertPrebuiltRows(rows)` directly — the same sink
 *     `bulkIngest`'s `embed:'precomputed'` path uses internally
 *     (mcp/bulkIngest.ts's `writePrebuiltRowsPerWorkspace`) — isolates
 *     exactly the ONNX embed step and nothing else in the object graph.
 *     Verified reachable and working against 3.19.1 before being wired into
 *     this harness (see docs/PERFORMANCE-MEMORY.md, "Attribution (3.19.1)").
 */
export async function runEmbeddedPrecomputedCycle(deps, dataDir, cycle, entries) {
    const { createLore, computeContentHash, dim, makeDoc } = deps;
    const lore = await createLore({ deploymentMode: 'embedded', dataDir });
    const rows = [];
    for (let i = 0; i < entries; i++) {
        const doc = makeDoc(cycle, i);
        rows.push({
            vector: precomputedVec(dim, cycle * 1_000_000 + i),
            id: `lore:${doc.id}`,
            text: doc.text,
            type: doc.metadata.type,
            label: doc.metadata.label,
            tags: doc.metadata.tags,
            project: doc.metadata.project,
            ecosystem: doc.metadata.ecosystem,
            updatedAt: new Date().toISOString(),
            security_scopes: [],
            contentHash: computeContentHash(doc.text),
        });
    }
    await lore.store.loreVerbatim.bulkUpsertPrebuiltRows(rows);
    await lore.dispose(`measure-memory-precomputed-cycle-${cycle}`);
}

/* ─── config: embed-only ─────────────────────────────────────────────────
 * No Lore at all — a FRESH LocalEmbeddingProvider instance per cycle,
 * .initialize() + embedDocumentBatch(entries texts).
 *
 * LocalEmbeddingProvider's pipeline cache is MODULE-scoped, keyed by
 * `${modelId}:${device}:${dtype}` (providers/localEmbeddingProvider.ts) —
 * not per-instance — so a fresh provider each cycle is expected to hit that
 * cache rather than reload the ONNX session. The cache's internal Map is
 * not exported, so its size / hit-count cannot be read directly without
 * editing package source, which this measurement-only sprint does not do.
 * `initMs` (this cycle's `.initialize()` wall time) is the closest reachable
 * observable instead: a cold load is hundreds of ms to seconds; a cache hit
 * is near-instant. Reported every cycle so the reader can judge the claim
 * directly rather than trust one derived summary. */
export async function runEmbedOnlyCycle(LocalEmbeddingProvider, modelId, dim, cycle, entries) {
    const t0 = performance.now();
    const provider = new LocalEmbeddingProvider({ modelId, dimension: dim });
    await provider.initialize();
    const initMs = performance.now() - t0;
    const texts = Array.from({ length: entries }, (_, i) =>
        `Memory harness embed-only text cycle ${cycle} #${i}. lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt.`);
    await provider.embedDocumentBatch(texts);
    return { initMs };
}

/* ─── config: surreal-only ───────────────────────────────────────────────
 * No Lore facade — a bare SurrealGraph on a fresh dir, ~entries nodes via
 * bulkUpsertNodes(), close(). Caller wipes the dir between cycles (the same
 * confound fix every other config in measure-memory.mjs uses). */
export async function runSurrealOnlyCycle(SurrealGraph, basePath, cycle, entries) {
    const graph = new SurrealGraph(basePath, { workspaceId: 'surreal-only-harness' });
    await graph.initialize();
    const filler = 'lorem ipsum dolor sit amet consectetur adipiscing '.repeat(6);
    const nodes = Array.from({ length: entries }, (_, i) => ({
        id: `surreal-cycle${cycle}-${i}`,
        type: 'note',
        label: `surreal-only entry c${cycle}#${i}`,
        content: `Surreal-only harness node cycle ${cycle} #${i}. ${filler}`,
        tags: ['memory-harness'],
        project: 'memory-harness',
        ecosystem: 'memory-harness',
        metadata: '{}',
    }));
    await graph.bulkUpsertNodes(nodes);
    await graph.close();
}

/* ─── config: workspace-cycle ────────────────────────────────────────────
 * The host scenario Atlas actually measured: ONE embedded Lore instance
 * lives for the entire run (constructed once by the caller, NOT per cycle).
 * Each cycle:
 *
 *   1. `createWorkspace(name, {}, dataDir)` — registers a FRESH
 *      name/on-disk-dir under the instance's `dataHome`. That is the home
 *      `LocalGraphRegistry` resolves workspace names against here (verified
 *      empirically against 3.19.1 — see docs/PERFORMANCE-MEMORY.md).
 *   2. `registerWorkspaceAlias(name, entry.path, {}, home)` — registers the
 *      SAME name + path again under `process.env.LORE_HOME` (`home`), which
 *      is the DEFAULT home `WorkspaceVerbatimResolver.getOrOpen()` resolves
 *      against (`getWorkspacePath(workspace)`, no explicit home arg). These
 *      two homes differ whenever `createLore({ dataDir })` is called with a
 *      `dataDir` distinct from `LORE_HOME` — exactly this harness's shape —
 *      so reaching BOTH consumers through the public API needs BOTH
 *      registrations. This is reported as a finding, not silently worked
 *      around: see the doc section for the exact evidence.
 *   3. Opens the GRAPH side explicitly via
 *      `lore._daemon.getGraphRegistry().getGraphHandle(name)`.
 *   4. Writes `entries` nodes via `lore.bulkIngest(nodes, { embed: 'sync' })`
 *      — the public API path that reaches `WorkspaceVerbatimResolver` for
 *      the VERBATIM side (`mcp/bulkIngest.ts`'s `writePrebuiltRowsPerWorkspace`
 *      calls `workspaceVerbatimResolver.getOrOpen(node.workspace)` once per
 *      workspace group, for `embed:'sync'` exactly as for `'precomputed'`).
 *   5. Closes what 3.19.1 offers: `registry.evictIdle(Date.now(), 0)` closes
 *      the GRAPH side (idle threshold 0 = evict immediately). There is NO
 *      equivalent per-workspace eviction on `WorkspaceVerbatimResolver` in
 *      3.19.1 — only `closeAll()` (closes EVERY non-pinned store at once),
 *      which this harness deliberately does NOT call per cycle: doing so
 *      would hide exactly the gap this config exists to measure. The
 *      resolver's `openCount()` is sampled every cycle instead, and is
 *      expected to grow monotonically — that growth (not RSS alone) is the
 *      direct, load-bearing evidence of the missing eviction path.
 *   6. Unregisters the workspace from BOTH homes (`deleteWorkspace`) — this
 *      only removes the registry entry; the on-disk dir and the resolver's
 *      still-open LanceDB handle are untouched, matching real behavior.
 *
 * The per-cycle directory is deliberately NOT wiped, unlike every other
 * config's confound fix: the resolver still holds a live, unclosed native
 * handle on it, and deleting files out from under an open LanceDB handle is
 * exactly the kind of native hazard this sprint measures, not something to
 * paper over. Cleanup happens once, after the whole run, when the caller's
 * single `lore.dispose()` runs the ordered drain — which DOES call
 * `workspaceVerbatimResolver.closeAll()` (shutdownDrain.ts step 9.7) — and
 * only then does the caller remove the temp LORE_HOME.
 */
export async function runWorkspaceCycle(deps, lore, home, dataDir, cycle, entries) {
    const { createWorkspace, registerWorkspaceAlias, deleteWorkspace, makeDoc } = deps;
    const name = `wc-cycle-${cycle}`;

    const entry = createWorkspace(name, {}, dataDir);
    registerWorkspaceAlias(name, entry.path, {}, home);

    const registry = lore._daemon.getGraphRegistry();
    await registry.getGraphHandle(name);

    const nodes = Array.from({ length: entries }, (_, i) => {
        const doc = makeDoc(cycle, i);
        return {
            id: doc.id,
            workspace: name,
            ecosystem: 'memory-harness',
            nodeData: {
                type: doc.metadata.type,
                label: doc.metadata.label,
                content: doc.text,
                tags: doc.metadata.tags,
                project: doc.metadata.project,
            },
        };
    });
    const result = await lore.bulkIngest(nodes, { embed: 'sync' });

    // bulkIngest's graph write ALSO records a durable outbox hot-write for
    // the node.upsert op (mcp/bulkIngest.ts Step 1b -> nodeService.ts ->
    // recordHotWrite), replayed asynchronously by the outbox replicator on
    // its own timer (idle nap 250ms / busy nap 10ms — outbox/replicator.ts
    // DEFAULT_REPLICATOR_CONFIG) independent of this function's own await
    // chain. If this workspace is UNREGISTERED (below) before that replay
    // runs, the replicator's graph resolve fails permanently
    // (workspace_not_found) and — found empirically while building this
    // harness — retries it FOREVER at the 10ms busy cadence with no backoff
    // or retry cap, one such retry storm per affected cycle, compounding
    // across the run and flooding this process's stderr. Waiting here for
    // one full idle-nap window lets the replicator consume the row while
    // the workspace still exists, so it never enters that stuck state. This
    // is a harness-only accommodation (nothing in packages/ changed); it
    // does NOT fix the underlying missing-backoff behavior, which is
    // reported as its own finding in docs/PERFORMANCE-MEMORY.md.
    await new Promise((r) => setTimeout(r, 350));

    const evictedByRegistry = await registry.evictIdle(Date.now(), 0);
    // STEP2-CLOSE-PATH-DESIGN.md (c) VERIFICATION — post-fix, the resolver
    // now offers the SAME per-workspace evictIdle() the registry always has
    // (getVerbatimResolver() is new; workspaceVerbatimResolver's raw field
    // still works too). Call it here, immediately after the registry's own
    // evict, so this harness measures whether the gap this config was BUILT
    // to expose (docs/PERFORMANCE-MEMORY.md §8.5 — resolverOpenCount growing
    // ~1/cycle with no eviction path in 3.19.1) is now closed. Pre-fix code
    // has no getVerbatimResolver() and no evictIdle() on the resolver, so
    // this call is intentionally gated on capability rather than assumed.
    const resolver = lore._daemon.getVerbatimResolver
        ? lore._daemon.getVerbatimResolver()
        : lore._daemon.workspaceVerbatimResolver;
    const evictedByResolver = (resolver && typeof resolver.evictIdle === 'function')
        ? await resolver.evictIdle(Date.now(), 0)
        : null;
    const resolverOpenCount = resolver ? resolver.openCount() : null;
    const registryOpenCount = registry.openCount();

    deleteWorkspace(name, dataDir);
    try {
        deleteWorkspace(name, home);
    } catch (e) {
        console.error(`[workspace-cycle] deleteWorkspace(home) cycle ${cycle}: ${e.message}`);
    }

    return {
        succeeded: result.succeeded,
        failed: result.count - result.succeeded,
        evictedByRegistry,
        evictedByResolver,
        resolverOpenCount,
        registryOpenCount,
    };
}
