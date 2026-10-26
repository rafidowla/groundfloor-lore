/**
 * test/helpers/linkRebuildWorld.ts - a seeded workspace on REAL engines (SqliteGraph + SqliteVerbatimStore, or
 * PostgresGraph + PostgresVerbatimStore against LORE_PG_URL) for the link-rebuild parity / flow suites (lane e3).
 *
 * The corpus is deterministic and exercises everything the rebuild decides on: links from an old policy that a new
 * policy keeps, drops and adds; opted-out nodes; scope and ecosystem confinement; tombstoned nodes (edges to a
 * vanished endpoint); an unembedded node (link set UNKNOWN); and foreign-origin edges that must never be touched.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteGraph } from '../../packages/lore/src/engines/sqliteGraph.js';
import { SqliteVerbatimStore } from '../../packages/lore/src/engines/sqliteVerbatimStore.js';
import { PostgresGraph } from '../../packages/lore/src/engines/postgres/postgresGraph.js';
import { PostgresVerbatimStore } from '../../packages/lore/src/engines/postgres/postgresVerbatimStore.js';
import { StoredVectorLinker } from '../../packages/lore/src/link/storedVectorLinker.js';
import { LinkRebuilder, type RebuilderOptions } from '../../packages/lore/src/link/linkRebuilder.js';
import { SqliteRebuildStore, type RebuildState } from '../../packages/lore/src/link/linkRebuildStore.js';
import { LEGACY_TUNING, type RebuildTuning } from '../../packages/lore/src/link/linkTuning.js';
import type { LinkPolicy } from '../../packages/lore/src/link/linkConfig.js';
import type { EmbeddingProvider } from '../../packages/lore/src/providers/types.js';
import { stampGateManifest } from './testPostgres.js';
import type { Pool } from 'pg';

export const WS = 'lrw';
export const REL = 'semantic_neighbor';
export const FP = 'fp-parity';
const DIM = 4;
export const P = (policyVersion: string, minSim: number, k: number): LinkPolicy => ({ minSim, k, dupSim: 0.999, policyVersion });
export const P_OLD = P('p-old', 0.5, 4);
export const P_NEW = P('p-new', 0.8, 2);

class NoEmbed implements EmbeddingProvider {
    readonly dimension = DIM; readonly modelId = 'lrw-none'; readonly dtype = 'fp32';
    async initialize(): Promise<void> {}
    // Only the tombstone marker row is embedded (a placeholder); the rebuild path itself never embeds a query.
    async embed(): Promise<number[]> { return [0, 0, 0, 0]; }
    async embedQuery(): Promise<number[]> { throw new Error('the rebuild must never embed a query'); }
    async embedDocument(): Promise<number[]> { return [0, 0, 0, 0]; }
}

const at = (deg: number): number[] => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180), 0, 0];
export const N = 44;
const LATE = 3;
export const ids = Array.from({ length: N }, (_, i) => `n${String(i).padStart(2, '0')}`);
const degOf = (i: number): number => (i * 29 + (i % 5) * 7) % 360;
const ecoOf = (i: number): string => (i >= 28 && i < 36 ? 'eco-x' : i >= 36 && i < 40 ? 'eco-y' : '*');
// The two unembedded (all-zero vector) rows sit in their own scope group so they do not crowd every plain neighbour list.
const scopesOf = (i: number): string[] => (i >= 20 && i < 28 ? ['s1'] : i === 9 || i === 30 ? ['s9'] : []);
const row = (i: number, zero = false) => ({
    id: `lore:${ids[i]}`, label: ids[i]!, text: `text ${ids[i]} ${'x'.repeat(200)}`, type: 'note', project: 'p', ecosystem: ecoOf(i),
    security_scopes: scopesOf(i), vector: zero ? [0, 0, 0, 0] : at(degOf(i)), contentHash: `h-${ids[i]}`, updatedAt: '2026-10-25T00:00:00.000Z',
});
const node = (id: string, i: number) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: ecoOf(i), metadata: '{}' }) as never;

export interface World {
    engine: string;
    g: SqliteGraph | PostgresGraph;
    vb: SqliteVerbatimStore | PostgresVerbatimStore;
    mk(policy: LinkPolicy, tuning?: Partial<RebuildTuning>): StoredVectorLinker;
    close(): Promise<void>;
}
export interface Engine { name: string; open: () => Promise<World> }

const tmps: string[] = [];
export const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmps.push(d); return d; };
export const cleanupTmps = (): void => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); };

let pgSeq = 0;
export function engines(pool: Pool | null): Engine[] {
    const out: Engine[] = [{
        name: 'sqlite',
        open: async () => {
            const g = new SqliteGraph(mkTmp('lrw-g-'), { workspaceId: WS }); await g.initialize();
            const vb = new SqliteVerbatimStore(mkTmp('lrw-v-'), new NoEmbed()); await vb.initialize();
            return mkWorld('sqlite', g, vb);
        },
    }];
    if (pool) {
        out.push({
            name: 'postgres',
            open: async () => {
                const ws = `pg-gate-lrw-${process.pid}-${pgSeq++}`;
                const g = new PostgresGraph(ws, pool); await g.initialize();
                const base = mkTmp('lrw-pgv-'); stampGateManifest(base, 'lrw-none', DIM);
                const vb = new PostgresVerbatimStore(base, pool, ws, new NoEmbed()); await vb.initialize();
                return mkWorld('postgres', g, vb);
            },
        });
    }
    return out;
}

function mkWorld(engine: string, g: World['g'], vb: World['vb']): World {
    const resolve = async () => ({ graph: g as never, verbatim: vb as never });
    return {
        engine, g, vb,
        mk: (policy, tuning) => new StoredVectorLinker(resolve, policy, FP, tuning),
        close: async () => { await (vb as { close?: () => Promise<void> }).close?.(); },
    };
}

/** Seed the corpus and the OLD link state (built with the legacy linker, so every world starts identical). */
export async function seedWorld(w: World): Promise<void> {
    for (const [i, id] of ids.entries()) await w.g.upsertNode(node(id, i));
    // The last LATE nodes arrive after the old-policy pass, so the new policy has links to INSERT for them.
    const early = N - LATE;
    await w.vb.bulkAddPrebuiltRows(ids.slice(0, early).map((_, i) => row(i)));
    await w.mk(P_OLD, LEGACY_TUNING).linkBatch(WS, ids.slice(0, early).map((id) => ({ id })));
    await w.vb.bulkAddPrebuiltRows(ids.slice(early).map((_, j) => row(early + j)));
    const add = (s: string, t: string, origin: string) => w.g.addEdge({ sourceId: s, targetId: t, relation: REL, confidence: 'extracted', confidenceScore: 1, provenance: { origin } as never } as never);
    await add('n01', 'n40', 'caller'); await add('n02', 'n41', 'import'); await add('n03', 'n42', 'discovery');
    // A pair the new policy wants for a late node, already held by a caller edge: left alone, counted keptForeign.
    const last = ids[N - 1]!;
    const wantedNew = (await w.mk(P_NEW, LEGACY_TUNING).computeLinks(WS, [last]))?.bySource.get(last)?.[0];
    if (!wantedNew) throw new Error('corpus: the new policy wants nothing for the last node');
    await add(wantedNew.sourceId, wantedNew.targetId, 'caller');
    // After the old links exist: opt-outs, tombstones (edges to a vanished endpoint), and an unembedded node (UNKNOWN set).
    await w.g.setLinkOptOuts(['n05', 'n17'], true);
    await w.vb.tombstone('lore:n12', 'parity'); await w.vb.tombstone('lore:n33', 'parity');
    await w.vb.bulkUpsertPrebuiltRows([row(9, true), row(30, true)]);
}

export interface EdgeRow { key: string; score: number; origin: string; policy: string; fp: string; invalidated: boolean }
export async function edgeSnapshot(w: World): Promise<EdgeRow[]> {
    const edges = await w.g.queryEdges({ relation: REL, limit: 100_000, offset: 0, includeProvenance: true, includeInvalidated: true } as never);
    return edges.map((e) => ({
        key: `${e.sourceId}|${e.targetId}`, score: e.confidenceScore ?? 0, origin: e.provenance?.origin ?? '', policy: e.provenance?.policyVersion ?? '',
        fp: e.provenance?.modelFingerprint ?? '', invalidated: !!e.provenance?.validTo,
    })).sort((a, b) => a.key.localeCompare(b.key) || Number(a.invalidated) - Number(b.invalidated));
}

export const COUNTER_KEYS = ['total', 'done', 'inserted', 'refreshed', 'invalidated', 'unchanged', 'keptForeign', 'skippedNoVector', 'skippedOptOut'] as const;
export const counters = (s: RebuildState): Record<string, number> => Object.fromEntries(COUNTER_KEYS.map((k) => [k, s[k] ?? 0]));

export function makeRebuilder(w: World, policy: LinkPolicy, o: {
    tuning?: Partial<RebuildTuning>; batchSize?: number; file?: string; wrap?: (s: RebuilderOptions['substrate']) => RebuilderOptions['substrate'];
    isBusy?: (workspace: string) => boolean | Promise<boolean>; yieldMs?: number; idleYieldMs?: number | ((workspace: string) => number); maxWaitMs?: number; sleep?: (ms: number) => Promise<void>;
}): LinkRebuilder {
    const linker = w.mk(policy, o.tuning);
    const sub = o.wrap ? o.wrap(linker) : linker;
    return new LinkRebuilder({
        store: new SqliteRebuildStore(o.file ?? path.join(mkTmp('lrw-st-'), 'q.sqlite')), substrate: sub as never,
        batchSize: o.batchSize ?? 5, yieldMs: o.yieldMs ?? 0, idleYieldMs: o.idleYieldMs, maxWaitMs: o.maxWaitMs ?? 1000,
        isBusy: o.isBusy ?? (() => false), tuning: o.tuning, ...(o.sleep ? { sleep: o.sleep } : {}),
    });
}

export async function runToEnd(rb: LinkRebuilder): Promise<RebuildState> { await rb.start(WS); await rb.whenIdle(WS); return rb.status(WS)!; }
