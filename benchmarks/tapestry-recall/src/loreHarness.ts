/**
 * loreHarness.ts — bootstraps a fresh, isolated embedded Lore instance for
 * one benchmark config run.
 *
 * Mirrors benchmarks/longmemeval/src/loreClient.ts's pattern (same
 * workspaces.json seeding, same LORE_HOME pin) — see that file's header for
 * the full writeup of why LORE_HOME must be pinned to dataDir (an
 * `AuditLog` footgun: without it, `createLore({ dataDir })` still appends
 * real hash-chained lines to the OPERATOR'S ACTUAL `~/.groundfloor/audit.jsonl`
 * even though graph/vector data correctly lands under `dataDir`).
 *
 * Lore stays a database here: this benchmark calls only createLore /
 * bulkIngest / recall (plus, for the two configs that need query-time
 * `queries[]` rephrasings, the same `recall` MCP tool in-process via
 * `lore.createMcpServer()` — index.ts documents this as the other sanctioned
 * way to invoke recall; `lore.recall()`'s thinner JS wrapper does not yet
 * expose `queries` even though the shared retrieve() core and the MCP tool
 * both support it). No LLM call anywhere.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLore, type LoreInstance } from '../../../packages/lore/src/index.js';

export interface BenchLoreHandle {
    lore: LoreInstance;
    dataDir: string;
    workspace: string;
    ecosystem: string;
}

/**
 * Which engines back a bench workspace's graph/vector substrates. Written
 * EXPLICITLY into the workspaces.json entry this harness hand-writes below
 * — never omitted. An absent field would NOT fall through to 3.21's
 * "new workspace" defaults (`resolveNewWorkspaceGraphEngine`/
 * `resolveNewWorkspaceVectorEngine`, both 'sqlite'): those are only called
 * by `createWorkspace()`, which this harness never invokes. The actual
 * graph/vector-open path (`openWorkspaceGraph.ts`, `vectorEngineSelector.ts`)
 * reads `resolveWorkspaceGraphEngine`/`resolveWorkspaceVectorEngine`, whose
 * absent-field fallback is the pre-3.21 backward-compat default
 * (`DEFAULT_GRAPH_ENGINE='surreal'`, `DEFAULT_VECTOR_ENGINE='lance'`) — so
 * omitting the fields here would silently reproduce the old SurrealDB/LanceDB
 * run while looking like a SQLite-only one.
 */
export interface EngineProfile {
    graphEngine: 'surreal' | 'sqlite';
    vectorEngine: 'lance' | 'sqlite';
}

/** The profile every prior round (BEFORE/AFTER-R9/AFTER-SYNC-ALIAS) ran on. */
export const SURREAL_LANCE_PROFILE: EngineProfile = { graphEngine: 'surreal', vectorEngine: 'lance' };

/** What a brand-new local workspace gets by default since 3.21 (step 5a). */
export const SQLITE_ONLY_PROFILE: EngineProfile = { graphEngine: 'sqlite', vectorEngine: 'sqlite' };

/** Creates a brand-new isolated embedded Lore instance under `dataDir`
 *  (caller-supplied, must be a fresh temp dir — never the repo, never a
 *  shared path). `engineProfile` defaults to the profile every existing
 *  RESULTS.md round used, so callers that don't pass it are unaffected. */
export async function createBenchLore(
    dataDir: string,
    workspace: string,
    ecosystem: string,
    engineProfile: EngineProfile = SURREAL_LANCE_PROFILE,
): Promise<BenchLoreHandle> {
    const absDataDir = path.resolve(dataDir);
    fs.mkdirSync(path.join(absDataDir, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(absDataDir, 'workspaces.json'),
        JSON.stringify(
            {
                active: workspace,
                workspaces: [
                    {
                        name: workspace,
                        path: absDataDir,
                        createdAt: new Date().toISOString(),
                        graphEngine: engineProfile.graphEngine,
                        vectorEngine: engineProfile.vectorEngine,
                    },
                ],
            },
            null,
            2,
        ),
    );

    // See file header — never leave this unset (real ~/.groundfloor audit
    // log leakage otherwise).
    process.env['LORE_HOME'] = absDataDir;

    const lore = await createLore({ deploymentMode: 'embedded', dataDir: absDataDir });
    return { lore, dataDir: absDataDir, workspace, ecosystem };
}
