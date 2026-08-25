/**
 * loreClient.ts — bootstraps an embedded Lore instance for the benchmark.
 *
 * Design notes (see ../README.md for the full writeup):
 *
 * - `deploymentMode: 'embedded'` per README.md "Embedding Lore in your
 *   application" — no daemon, no port, in-process.
 * - Uses the default graph engine (SurrealDB, per README). An earlier
 *   version of this harness pinned `graphEngine: 'kuzu'`, believing
 *   `createLore()`'s static import of the SurrealDB connection module threw
 *   `ERR_PACKAGE_PATH_NOT_EXPORTED` from a standalone entry file. That
 *   diagnosis did not hold up: re-tested 2026-08-13 from this exact file
 *   location and invocation (`npx tsx benchmarks/longmemeval/src/...ts`)
 *   with no engine override — `createLore()` + `nodeUpsert()` succeed
 *   cleanly and write real SurrealDB files (`wal`/`manifest`/`sstables`
 *   under `.lore/surreal/`). No Kùzu workspace is to exist anywhere in this
 *   project (settled decision) — do not reintroduce this pin.
 * - We seed `workspaces.json` ourselves (createLore does not auto-create a
 *   workspace for a fresh `dataDir` — confirmed against
 *   `test/embeddable-capstone-e2e.ts`, which does the same).
 * - Two embeddable-API footguns confirmed still current (2026-08-12):
 *     1. `id` and `ecosystem` must be duplicated inside `nodeData` — the
 *        graph write reads only `nodeData`; the top-level `id`/`ecosystem`
 *        on the write call are bookkeeping only.
 *     2. There is no separate "conversation" or "session" concept in the
 *        write API — everything is a flat node distinguished by tags/type.
 * - THIRD footgun found while building this harness (2026-08-12), NOT
 *   previously documented: `createLore({ dataDir })` does NOT fully isolate
 *   an instance on disk as README.md's "Embedded-mode contracts" promises.
 *   `opts.dataDir` is threaded through graph/workspace resolution
 *   (`resolveLoreHome({ dataDir })`), but several subsystems constructed
 *   underneath — confirmed for `security/audit.ts`'s `AuditLog`, which
 *   defaults its file path via the separate legacy `loreHomePath()` shim
 *   (`config/loreHome.ts`, reads `process.env.LORE_HOME`, else
 *   `~/.groundfloor`) — never receive `dataDir` at all. Result: running
 *   `createLore({ dataDir: <isolated path> })` with no `LORE_HOME` set
 *   still appends real, tamper-evident hash-chained entries to the
 *   OPERATOR'S ACTUAL `~/.groundfloor/audit.jsonl`, even though the graph/
 *   vector data itself correctly lands under `dataDir`. Caught during this
 *   benchmark's own smoke testing (one `lib:nodeUpsert` line leaked into
 *   the real audit log before this was diagnosed and fixed here — see
 *   README.md "A note on side effects"). Workaround: also set
 *   `process.env.LORE_HOME` to the same `dataDir` before calling
 *   `createLore()`, which this function does. A real fix belongs in
 *   `packages/lore/src` (thread `dataDir` into `AuditLog`/`loreHomePath`
 *   call sites, or audit every other `loreHome()`/`loreHomePath()` call
 *   site for the same gap) — out of scope for this benchmark harness.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLore, type LoreInstance } from '../../../packages/lore/src/index.js';

export const WORKSPACE = 'longmemeval';

export interface BenchmarkLoreHandle {
    lore: LoreInstance;
    dataDir: string;
}

/** Seeds a fresh (or reuses an existing) embedded Lore data directory and
 *  returns a live instance. Idempotent: safe to call against an existing
 *  `dataDir` from a prior run (workspaces.json is rewritten but the
 *  underlying graph/vector data is untouched). */
export async function createBenchmarkLore(dataDir: string): Promise<BenchmarkLoreHandle> {
    const absDataDir = path.resolve(dataDir);
    fs.mkdirSync(path.join(absDataDir, '.lore'), { recursive: true });
    fs.writeFileSync(
        path.join(absDataDir, 'workspaces.json'),
        JSON.stringify(
            {
                active: WORKSPACE,
                workspaces: [
                    {
                        name: WORKSPACE,
                        path: absDataDir,
                        createdAt: new Date().toISOString(),
                        // Explicit, not omitted — found 2026-08-13 that a
                        // workspace this harness PRE-CREATES in workspaces.json
                        // (as opposed to letting createLore() provision a
                        // brand-new one from nothing) falls back to Kùzu when
                        // graphEngine is left unset here, even though
                        // resolveWorkspaceGraphEngine's own documented default
                        // is 'surreal'. Matches the explicit-not-implicit
                        // convention already used project-wide when migrating
                        // real workspaces off Kùzu (MIRA, pm-scope-app).
                        graphEngine: 'surreal',
                    },
                ],
            },
            null,
            2,
        ),
    );

    // Pin the legacy loreHome() shim to the SAME dir as opts.dataDir below —
    // see the file header's "THIRD footgun" note. Without this, subsystems
    // that bypass opts.dataDir (confirmed: AuditLog) fall through to
    // process.env.LORE_HOME, and — critically — to the operator's real
    // ~/.groundfloor when that's unset too. Never leave this unset.
    process.env['LORE_HOME'] = absDataDir;

    const lore = await createLore({ deploymentMode: 'embedded', dataDir: absDataDir });
    return { lore, dataDir: absDataDir };
}
