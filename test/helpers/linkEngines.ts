/**
 * test/helpers/linkEngines.ts - shared rig for the link-freshness suites (Loop B refresh, Loop C crash-resume,
 * cap prune, link health): the same cases on SQLite and, when LORE_PG_URL names a throwaway server, Postgres.
 * Vectors are 2-D unit vectors addressed by angle, so every similarity is exact and easy to reason about.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SqliteGraph } from '../../packages/lore/src/engines/sqliteGraph.js';
import { PostgresGraph } from '../../packages/lore/src/engines/postgres/postgresGraph.js';
import type { LinkPolicy } from '../../packages/lore/src/link/linkConfig.js';
import { cleanupGateWorkspaces, closeGatePool, createGatePool } from './testPostgres.js';

export const REL = 'semantic_neighbor';
export type G = SqliteGraph | PostgresGraph;
export interface Eng { name: string; open: () => Promise<G> }

const dirs: string[] = [];
export const mkTmp = (p: string): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
export const rmTmp = (): void => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };

export async function linkEngines(label: string): Promise<{ engines: Eng[]; close: () => Promise<void> }> {
    const engines: Eng[] = [{
        name: 'sqlite',
        open: async () => { const g = new SqliteGraph(mkTmp(`lf-${label}-`), { workspaceId: 'lf' }); await g.initialize(); return g; },
    }];
    const pool = await createGatePool(`link-${label}`);
    if (pool) {
        await cleanupGateWorkspaces(pool);
        let seq = 0;
        engines.push({
            name: 'postgres',
            open: async () => { const g = new PostgresGraph(`pg-gate-lf-${label}-${process.pid}-${seq++}`, pool); await g.initialize(); return g; },
        });
    }
    return { engines, close: async () => { if (pool) { await cleanupGateWorkspaces(pool); await closeGatePool(pool); } rmTmp(); } };
}

export const at = (deg: number): number[] => [Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)];
export const cos = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]!;

export class FakeVerbatim {
    rows = new Map<string, { vec: number[] | null }>();
    set(id: string, deg: number | null): void { this.rows.set(`lore:${id}`, { vec: deg === null ? null : at(deg) }); }
    async getVectors(ids: string[]): Promise<Map<string, number[]>> {
        const m = new Map<string, number[]>();
        for (const id of ids) { const r = this.rows.get(id); if (r?.vec) m.set(id, r.vec); }
        return m;
    }
    async getById(id: string): Promise<{ ecosystem: string } | null> { return this.rows.has(id) ? { ecosystem: '*' } : null; }
    async searchByVector(v: number[], o?: { topK?: number }): Promise<Array<{ id: string; score: number }>> {
        return [...this.rows].filter(([, r]) => r.vec).map(([id, r]) => ({ id, score: cos(v, r.vec!) })).sort((x, y) => y.score - x.score).slice(0, o?.topK ?? 10);
    }
    async listIds(prefix?: string): Promise<string[]> { return [...this.rows.keys()].filter((k) => !prefix || k.startsWith(prefix)); }
}

export const P = (policyVersion: string, minSim: number, k: number): LinkPolicy => ({ minSim, k, dupSim: 0.999, policyVersion });
export const FP = 'fp-test';
export const node = (id: string) => ({ id, type: 'note', label: id, content: `content ${id}`, tags: [], project: 'p', ecosystem: '*', metadata: '{}' }) as never;
export const sorted = (s: Iterable<string>): string[] => [...s].sort();
export const pair = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Seed `spec` (id -> angle) into the graph and a fresh FakeVerbatim. */
export async function seed(g: G, spec: Array<[string, number]>): Promise<FakeVerbatim> {
    const vb = new FakeVerbatim();
    for (const [id, deg] of spec) { await g.upsertNode(node(id)); vb.set(id, deg); }
    return vb;
}

/** Link edges keyed `lo|hi`; `valid_to` visible when `invalid` is true. */
export async function linkEdges(g: G, opts: { invalid?: boolean; origin?: string } = {}): Promise<Map<string, { origin?: string; validTo?: string | null; score: number }>> {
    const out = new Map<string, { origin?: string; validTo?: string | null; score: number }>();
    const rows = await g.queryEdges({ relation: REL, limit: 5000, offset: 0, includeProvenance: true, includeInvalidated: true });
    for (const e of rows) {
        const validTo = e.provenance?.validTo ?? null;
        const live = validTo === null || validTo === undefined;
        if (opts.invalid ? live : !live) continue;
        if (opts.origin && e.provenance?.origin !== opts.origin) continue;
        out.set(pair(e.sourceId, e.targetId), { origin: e.provenance?.origin, validTo, score: e.confidenceScore ?? 0 });
    }
    return out;
}
