/**
 * fakeEmbeddingProvider.mjs — deterministic, offline EmbeddingProvider for
 * fast CI iteration of this harness. Pattern follows test/sqlite-verbatim-
 * engine-parity-unit.ts's DetEmbedProvider but at higher dimension (64) for
 * slightly better fidelity.
 *
 * IMPORTANT: this is NOT suitable for the real D1/D3 baseline measurement.
 * Score compression (D3's evidence) and calibration behaviour (D1's ask) are
 * properties of the REAL local ONNX model's embedding space; a char-code
 * hash has no semantic structure and will produce meaningless score
 * distributions. Use this only for `--embedder fake` fast-iteration runs,
 * never for a committed baseline.
 */

const DIM = 64;

function vec(text) {
    const v = new Array(DIM).fill(0);
    const s = text.toLowerCase();
    for (let i = 0; i < s.length; i++) {
        v[i % DIM] += s.charCodeAt(i) / 128;
    }
    // light bigram mixing so word order has *some* effect (still not semantic).
    for (let i = 0; i < s.length - 1; i++) {
        const bg = (s.charCodeAt(i) * 31 + s.charCodeAt(i + 1)) % DIM;
        v[bg] += 0.5;
    }
    const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1;
    return v.map((x) => x / norm);
}

export class FakeEmbeddingProvider {
    modelId = 'recall-eval-det-fake-v1';
    dimension = DIM;
    dtype = 'fp32';
    async initialize() {}
    async embed(text) { return vec(text); }
    async embedQuery(text) { return vec(text); }
    async embedDocument(text) { return vec(text); }
    async embedDocumentBatch(texts) { return texts.map(vec); }
    async embedQueryBatch(texts) { return texts.map(vec); }
}
