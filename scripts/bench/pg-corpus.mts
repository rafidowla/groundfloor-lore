/**
 * pg-corpus.mts - deterministic synthetic corpus for the Postgres scale bench (BENCH ONLY, not shipped).
 *
 * Everything about node i is a pure function of (seed, i): text, tags, timestamps, cluster and vector.
 * So the seeder, the bench and any re-run agree without sharing state, and batches can load in any order.
 *
 * Text: a Zipf(s~1.05) draw over a 20,000-word synthetic vocabulary (top ranks are real English function words,
 * the rest are pseudo-words built from syllables so substring/trigram behaviour resembles prose: common 'ing' /
 * 'tion' endings, a few very frequent terms, a long tail of rare ones).
 * Vectors: K cluster centers (unit gaussian) + noise; v = unit(center + sigma*g), g ~ N(0, I/dim), so two members
 * of one cluster have cosine ~ 1/(1+sigma^2) (sigma 0.4 -> ~0.86).
 */
import { createHash } from 'node:crypto';
import { gauss, rng, unit } from './pg-bench-common.mts';

const FUNCTION_WORDS = ('the of and to in a is that for it as with was on be by this are or from at an have not but they which one you ' +
    'all were their can has more if will each about how up out them then she many some so these would other into has her two like him see ' +
    'time could no make than first been its who now people my made over did down only way find use may water long little very after words ' +
    'called just where most know get through back much before go good new write our used me man too any day same right look think also ' +
    'around another came come work three word must because does part even place well such here take why things help put years different away ' +
    'again off went old number great tell men say small every found still between name should home big give air line set own under read last ' +
    'never us left end along while might next sound below saw something thought both few those always show large often together asked house ' +
    'world going want school important until form food keep children feet land side without boy once animals life enough took sometimes ' +
    'four head above kind began almost live page got earth need far hand high year mother light country father let night picture being ' +
    'study second soon story since white ever paper hard near sentence better best across during today however sure knew try told young').split(/\s+/);

const SYL = ['ba', 'ce', 'di', 'fo', 'gu', 'ha', 'je', 'ki', 'lo', 'mu', 'na', 'pe', 'qi', 'ro', 'su', 'ta', 'vu', 'wa', 'xe', 'yo', 'zi',
    'bar', 'cen', 'dis', 'for', 'gra', 'har', 'jun', 'kel', 'lin', 'mor', 'nor', 'pro', 'ren', 'sta', 'tra', 'ver', 'wor',
    'tion', 'ing', 'ment', 'able', 'ness', 'ous', 'ive', 'ent', 'al', 'er', 'est', 'ity'];

export const VOCAB_SIZE = 20_000;
export const ZIPF_S = 1.05;

function buildVocab(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const w of FUNCTION_WORDS) if (!seen.has(w)) { seen.add(w); out.push(w); }
    const r = rng(12345);
    while (out.length < VOCAB_SIZE) {
        const n = 2 + Math.floor(r() * 2.6);
        let w = '';
        for (let i = 0; i < n; i++) w += SYL[Math.floor(r() * SYL.length)]!;
        if (w.length < 4 || w.length > 14 || seen.has(w)) continue;
        seen.add(w); out.push(w);
    }
    return out;
}
export const VOCAB: string[] = buildVocab();

const CDF: Float64Array = (() => {
    const c = new Float64Array(VOCAB_SIZE);
    let s = 0;
    for (let i = 0; i < VOCAB_SIZE; i++) { s += 1 / Math.pow(i + 1, ZIPF_S); c[i] = s; }
    for (let i = 0; i < VOCAB_SIZE; i++) c[i]! /= s;
    return c;
})();

/** Zipf rank (0-based) for a uniform u in [0,1). */
export function zipfRank(u: number): number {
    let lo = 0, hi = VOCAB_SIZE - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (CDF[mid]! < u) lo = mid + 1; else hi = mid; }
    return lo;
}

const TYPES = ['note', 'note', 'note', 'decision', 'convention', 'bug_pattern', 'architecture', 'troubleshooting'];
const TAG_POOL = 300;
const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');
const YEAR_MS = 365 * 24 * 3600 * 1000;

export interface CorpusParams { seed: number; n: number; dim: number; clusters: number; sigma: number }
export function defaultParams(n: number, dim = 384, seed = 20261024): CorpusParams {
    return { seed, n, dim, clusters: Math.max(50, Math.round(n / 500)), sigma: 0.4 };
}

export interface NodeFields {
    id: string; type: string; label: string; content: string; tags: string[]; createdAt: string; updatedAt: string; cluster: number;
}
export const nodeId = (i: number): string => `b${i.toString(36).padStart(5, '0')}`;

function mix(seed: number, i: number): number { return (Math.imul(i + 1, 2654435761) ^ Math.imul(seed, 40503)) >>> 0; }

export function nodeFields(p: CorpusParams, i: number): NodeFields {
    const r = rng(mix(p.seed, i));
    const word = () => VOCAB[zipfRank(r())]!;
    const nLabel = 3 + Math.floor(r() * 5);
    const nContent = 30 + Math.floor(r() * 61);
    const label: string[] = [], content: string[] = [];
    for (let k = 0; k < nLabel; k++) label.push(word());
    for (let k = 0; k < nContent; k++) {
        content.push(word());
        if (k % 14 === 13) content[k] += '.';
    }
    const tags: string[] = [];
    const nTags = Math.floor(r() * 3.5);
    for (let k = 0; k < nTags; k++) {
        const t = `tag-${VOCAB[zipfRank(r()) % TAG_POOL]}`;
        if (!tags.includes(t)) tags.push(t);
    }
    const created = BASE_MS + Math.floor(r() * YEAR_MS);
    const updated = created + Math.floor(r() * 30 * 24 * 3600 * 1000);
    return {
        id: nodeId(i), type: TYPES[Math.floor(r() * TYPES.length)]!, label: label.join(' '), content: content.join(' '), tags,
        createdAt: new Date(created).toISOString(), updatedAt: new Date(updated).toISOString(),
        cluster: Math.floor(r() * p.clusters),
    };
}

/** Text the way Lore's verbatim store builds it for a node: label, content, tags joined by blank lines. */
export const verbatimText = (f: NodeFields): string => `${f.label}\n\n${f.content}${f.tags.length ? `\n\n${f.tags.join(',')}` : ''}`;
export const contentHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function clusterCenters(p: CorpusParams): number[][] {
    const r = rng(mix(p.seed, 0x7fffffff));
    return Array.from({ length: p.clusters }, () => unit(Array.from({ length: p.dim }, () => gauss(r))));
}

/** Vector of node i (fields.cluster picks the center). */
export function nodeVector(p: CorpusParams, centers: number[][], i: number, cluster: number): number[] {
    const r = rng(mix(p.seed ^ 0x5bd1e995, i));
    const c = centers[cluster]!;
    const inv = p.sigma / Math.sqrt(p.dim);
    const v = new Array<number>(p.dim);
    for (let d = 0; d < p.dim; d++) v[d] = c[d]! + inv * gauss(r);
    return unit(v);
}
export const vecText = (v: number[]): string => '[' + v.map((x) => x.toFixed(5)).join(',') + ']';

/** Query vector for a query string: a cluster center plus noise, so queries land in populated regions. */
export function queryVector(p: CorpusParams, centers: number[][], text: string): number[] {
    const h = createHash('sha256').update(text).digest();
    const cl = h.readUInt32LE(0) % p.clusters;
    return nodeVector(p, centers, 0x40000000 + h.readUInt32LE(4), cl);
}
