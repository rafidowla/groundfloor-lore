/**
 * pg-bench-common.mts - shared helpers for the Postgres scale bench scripts (BENCH ONLY, not shipped).
 *
 * Opens a real Lore instance (createLore, embedded mode) over a Postgres workspace with a deterministic
 * fake embedder injected, so the query-embedding cost is excluded from every measurement.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DIM_DEFAULT = 384;
export const WS_DEFAULT = 'pgbench';

/** mulberry32: small deterministic PRNG. */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Standard normal via Box-Muller from a uniform source. */
export function gauss(r: () => number): number {
    const u = Math.max(r(), 1e-12), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function unit(v: number[]): number[] {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return v.map((x) => x / n);
}

/** Fixed-vector / deterministic embedder; `queryVec` is returned for every query (query embedding excluded). */
export function makeFakeEmbedder(dim: number, opts: { batchLatencyMs?: number; perItemMs?: number } = {}) {
    const hashVec = (text: string): number[] => {
        const h = createHash('sha256').update(text).digest();
        const r = rng(h.readUInt32LE(0));
        return unit(Array.from({ length: dim }, () => gauss(r)));
    };
    const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
    const stats = { batches: 0, items: 0 };
    return {
        stats,
        dimension: dim,
        modelId: 'bench/fake-fixed',
        dtype: 'fp32',
        async initialize(): Promise<void> { /* no-op */ },
        async embed(t: string): Promise<number[]> { return hashVec(t); },
        async embedQuery(t: string): Promise<number[]> { return hashVec(t); },
        async embedDocument(t: string): Promise<number[]> { return hashVec(t); },
        async embedDocumentBatch(ts: string[]): Promise<number[][]> {
            stats.batches++; stats.items += ts.length;
            if (opts.batchLatencyMs || opts.perItemMs) await sleep((opts.batchLatencyMs ?? 0) + (opts.perItemMs ?? 0) * ts.length);
            return ts.map(hashVec);
        },
    };
}

/** Creates home + workspaces.json declaring one Postgres workspace. Returns paths. */
export function makeHome(root: string, ws = WS_DEFAULT): { home: string; wsPath: string } {
    fs.mkdirSync(root, { recursive: true });
    const home = fs.mkdtempSync(path.join(root, 'home.'));
    const wsPath = path.join(home, 'workspaces', ws);
    fs.mkdirSync(path.join(wsPath, '.lore'), { recursive: true });
    writeWorkspacesJson(home, wsPath, ws);
    return { home, wsPath };
}

export function writeWorkspacesJson(home: string, wsPath: string, ws = WS_DEFAULT): void {
    fs.writeFileSync(path.join(home, 'workspaces.json'), JSON.stringify({
        version: 1, active: ws,
        workspaces: [{ name: ws, path: wsPath, graphEngine: 'postgres', vectorEngine: 'postgres', createdAt: new Date().toISOString() }],
    }));
}

export async function openLore(home: string, dim: number, extra: Record<string, unknown> = {}, embedder?: ReturnType<typeof makeFakeEmbedder>) {
    const { createLore } = await import('../../packages/lore/src/index.js');
    const lore = await createLore({
        dataDir: home, deploymentMode: 'embedded', embeddingProvider: (embedder ?? makeFakeEmbedder(dim)) as never,
        modelServer: false, ...extra,
    } as never);
    return lore as any;
}

export function pct(xs: number[], p: number): number {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}
export const fmt = (n: number): string => (Number.isFinite(n) ? (n >= 100 ? n.toFixed(0) : n.toFixed(1)) : 'n/a');
export function summarize(xs: number[]) {
    return { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / (xs.length || 1) };
}
export function argv(name: string, def?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0) return process.argv[i + 1];
    return def;
}
export function hasFlag(name: string): boolean { return process.argv.includes(`--${name}`); }
export const now = () => performance.now();
