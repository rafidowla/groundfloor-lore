/**
 * cli/commands/outboxDrainVerbatim.ts — the verbatim content witness for
 * `lore outbox drain-failed` (3.35.0).
 *
 * WHY. `dispatcher.ts` `verifyApplied` heals a dead/failed `verbatim.upsert`
 * row only when a `getVerbatim` witness is wired: it compares the stored row's
 * content hash against the hash the payload would persist. drain-failed wired
 * the graph only, so every verbatim row came back `content-witness-unwired` and
 * could never heal, however present the row was.
 *
 * READ-ONLY BY CONSTRUCTION. The stores are opened through the same
 * `WorkspaceVerbatimResolver` / `openWorkspaceVerbatim` the daemon and the
 * other offline CLI commands use (no duplicated opening logic), but the handle
 * given to the outbox wiring is a facade exposing `getById` only — the sweep
 * can look a row up and nothing else, so no write path is reachable from here
 * even though wireOutbox also builds (never-called) upsert closures over it.
 *
 * TWO LAYOUTS (same split as outboxRequeue.ts):
 *   - daemon layout: workspaces resolved by name through workspaces.json;
 *   - `--lore-dir`: ONE embedded workspace, addressed by its `.lore/` directory
 *     (its base path is the parent); every row resolves to that store, and the
 *     engine is detected from the files on disk (see openDrainVerbatim).
 */
import * as fs from 'node:fs';
import path from 'node:path';

import { WorkspaceVerbatimResolver } from '../../outbox/workspaceVerbatimResolver.js';
import { openWorkspaceVerbatim } from '../../engines/openWorkspaceVerbatim.js';
import { SqliteVerbatimStore } from '../../engines/sqliteVerbatimStore.js';
import type { VerbatimStoreApi } from '../../engines/verbatimStoreApi.js';

export interface DrainVerbatimHandle {
    /** Boot store (sync, per the wireOutbox boot-fallback contract). */
    getVerbatim: () => VerbatimStoreApi;
    /** Per-workspace resolver (SP-F3 convention). */
    getVerbatimForWorkspace: () => (workspace: string) => Promise<VerbatimStoreApi>;
    close: () => Promise<void>;
}

/** Look-up-only facade: `getById` is the whole surface the content witness uses. */
export function readOnlyVerbatimFacade(store: VerbatimStoreApi): VerbatimStoreApi {
    return {
        getById: (id: string) => store.getById(id),
    } as unknown as VerbatimStoreApi;
}

export async function openDrainVerbatim(opts: {
    home: string;
    /** Workspace the boot (workspace-less) rows resolve to — daemon layout only. */
    bootWorkspace?: string;
    /** `--lore-dir`: the `.lore/` directory of ONE embedded workspace. */
    loreDir?: string;
}): Promise<DrainVerbatimHandle> {
    if (opts.loreDir) {
        const loreDir = path.resolve(opts.loreDir);
        const basePath = path.dirname(loreDir);
        // An embedded host keeps its own engine choice in its own config, not in
        // this machine's workspaces.json, so the path-match resolver would fall
        // back to Lance and silently open an EMPTY store beside a populated
        // verbatim.sqlite (every row then reads "missing"). Trust what is on disk.
        const store = fs.existsSync(path.join(loreDir, 'verbatim.sqlite'))
            ? new SqliteVerbatimStore(basePath, undefined, { home: opts.home })
            : openWorkspaceVerbatim(basePath, undefined, { home: opts.home, role: 'read' });
        await store.initialize();
        const facade = readOnlyVerbatimFacade(store);
        return {
            getVerbatim: () => facade,
            getVerbatimForWorkspace: () => async () => facade,
            close: async () => { try { await (store as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* best effort */ } },
        };
    }
    // Offline CLI: nothing evicts under us, we close() manually.
    const resolver = new WorkspaceVerbatimResolver(undefined, false, undefined, { autoEvict: false, home: opts.home });
    const boot = readOnlyVerbatimFacade(await resolver.getOrOpen(opts.bootWorkspace!));
    return {
        getVerbatim: () => boot,
        getVerbatimForWorkspace: () => async (ws: string) => readOnlyVerbatimFacade(await resolver.getOrOpen(ws)),
        close: async () => { try { await resolver.closeAll(); } catch { /* best effort */ } },
    };
}

/** Group sweep details by reason: counts + up to `maxIds` ids each. Pure, for the CLI + tests. */
export function groupDetailsByReason(
    details: ReadonlyArray<{ id: string; reason?: string; verified: boolean }>,
    maxIds = 5,
): Array<{ reason: string; verified: boolean; count: number; ids: string[]; more: number }> {
    const m = new Map<string, { reason: string; verified: boolean; count: number; ids: string[] }>();
    for (const d of details) {
        const reason = d.reason ?? '(no reason recorded)';
        const key = `${d.verified ? 'ok' : 'no'}:${reason}`;
        let g = m.get(key);
        if (!g) { g = { reason, verified: d.verified, count: 0, ids: [] }; m.set(key, g); }
        g.count++;
        if (g.ids.length < maxIds) g.ids.push(d.id);
    }
    return [...m.values()]
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
        .map((g) => ({ ...g, more: g.count - g.ids.length }));
}

/** Operator-facing lines for the grouped reasons (the CLI prints these always, dry-run included). */
export function formatReasonGroups(
    details: ReadonlyArray<{ id: string; reason?: string; verified: boolean }>,
    maxIds = 5,
): string[] {
    if (details.length === 0) return [];
    const lines = ['  by reason (count  reason  [ids]):'];
    for (const g of groupDetailsByReason(details, maxIds)) {
        const tail = g.more > 0 ? `, +${g.more} more` : '';
        lines.push(`    ${String(g.count).padStart(6)}  ${g.verified ? 'recovered' : 'left'}: ${g.reason}  [${g.ids.join(', ')}${tail}]`);
    }
    return lines;
}
