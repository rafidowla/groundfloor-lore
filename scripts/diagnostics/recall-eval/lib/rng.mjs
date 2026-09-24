/**
 * rng.mjs — deterministic seeded PRNG (mulberry32) for the recall-eval fixture.
 *
 * Everything the fixture builder generates (content wording, code rows,
 * chat notes) must be reproducible byte-for-byte across runs so that
 * questions.json (which references specific node ids) stays valid no
 * matter how many times the fixture is rebuilt. Never use Math.random()
 * anywhere in this harness's generators.
 */

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function rand() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function makeRng(seedString) {
    // Simple string -> 32-bit seed hash (FNV-1a), then mulberry32.
    let h = 0x811c9dc5;
    for (let i = 0; i < seedString.length; i++) {
        h ^= seedString.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return mulberry32(h >>> 0);
}

export function pick(rng, arr) {
    return arr[Math.floor(rng() * arr.length)];
}

export function pickN(rng, arr, n) {
    const pool = arr.slice();
    const out = [];
    for (let i = 0; i < n && pool.length > 0; i++) {
        const idx = Math.floor(rng() * pool.length);
        out.push(pool[idx]);
        pool.splice(idx, 1);
    }
    return out;
}

export function intBetween(rng, lo, hi) {
    return lo + Math.floor(rng() * (hi - lo + 1));
}
