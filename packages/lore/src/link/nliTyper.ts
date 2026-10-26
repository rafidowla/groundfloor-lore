/**
 * nliTyper.ts - tier 2 of the typing cascade: a LOCAL natural-language-inference classifier.
 *
 * OFF by default (`LORE_LINK_NLI=1` + `LORE_LINK_NLI_MODEL=<hf model id>`). It uses @huggingface/transformers the way
 * providers/localEmbeddingProvider.ts does, but loads it lazily (a dynamic import on first use, so the library is
 * never even imported unless NLI is on) and with `local_files_only` unless `LORE_LINK_NLI_DOWNLOAD=1`: a background
 * loop never fetches model weights on its own. Tests inject a fake {@link NliClassifier}; no weights are needed.
 *
 * Mapping: entailment => `supports`, contradiction => `contradicts`, neutral or below `minConfidence` => null (the pair
 * falls through to the judge). Direction a->b first, then b->a only when the first read was not decisive.
 */
import { capText, type IRelationTyper, type RelationCandidate, type RelationVerdict } from './relationTyper.js';

export type NliLabel = 'entailment' | 'contradiction' | 'neutral';

export interface NliClassifier {
    classify(premise: string, hypothesis: string): Promise<{ label: NliLabel; score: number }>;
}

export interface NliTyperOptions {
    model: string;
    minConfidence: number;
    /** Injected in tests. Absent => the lazy transformers pipeline. */
    classifier?: NliClassifier;
    allowDownload?: boolean;
    /** Where cached models live (default: the host's model cache, resolved by the caller). */
    cacheDir?: string;
}

/** Map a model's raw label (`ENTAILMENT`, `LABEL_2`, `contradiction`, ...) onto the three NLI classes. */
export function normalizeNliLabel(raw: string): NliLabel | null {
    const l = raw.toLowerCase();
    if (l.includes('entail')) return 'entailment';
    if (l.includes('contra')) return 'contradiction';
    if (l.includes('neutral')) return 'neutral';
    return null;
}

type Pipe = (input: unknown, opts?: unknown) => Promise<unknown>;

/** The real classifier. Loaded on the first call; the import and the model are both lazy. */
export function transformersNliClassifier(o: { model: string; allowDownload: boolean; cacheDir?: string }): NliClassifier {
    let pipe: Promise<Pipe> | null = null;
    const load = (): Promise<Pipe> => {
        pipe ??= import('@huggingface/transformers').then(async (hf) => {
            const opts: Record<string, unknown> = { local_files_only: !o.allowDownload };
            if (o.cacheDir) opts.cache_dir = o.cacheDir;
            return (await hf.pipeline('text-classification', o.model, opts as never)) as unknown as Pipe;
        });
        pipe.catch(() => { pipe = null; }); // a failed load may be retried on a later call
        return pipe;
    };
    return {
        async classify(premise, hypothesis) {
            const p = await load();
            const out = await p({ text: premise, text_pair: hypothesis }, { top_k: 1 });
            const first = (Array.isArray(out) ? out[0] : out) as { label?: string; score?: number } | undefined;
            const label = first?.label ? normalizeNliLabel(first.label) : null;
            if (!label || typeof first?.score !== 'number') return { label: 'neutral', score: 0 };
            return { label, score: first.score };
        },
    };
}

export class NliTyper implements IRelationTyper {
    readonly id: string;
    readonly sovereign = true;
    private readonly classifier: NliClassifier;
    private readonly min: number;

    constructor(o: NliTyperOptions) {
        this.id = `nli:${o.model}`;
        this.min = o.minConfidence;
        this.classifier = o.classifier ?? transformersNliClassifier({ model: o.model, allowDownload: o.allowDownload === true, ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}) });
    }

    async type(c: RelationCandidate): Promise<RelationVerdict | null> {
        const ta = capText(`${c.a.label}\n${c.a.content}`.trim());
        const tb = capText(`${c.b.label}\n${c.b.content}`.trim());
        for (const [premise, hypothesis] of [[ta, tb], [tb, ta]] as const) {
            const r = await this.classifier.classify(premise, hypothesis);
            if (r.label === 'neutral' || !(r.score >= this.min)) continue;
            return {
                relation: r.label === 'entailment' ? 'supports' : 'contradicts',
                confidence: r.score, typer: this.id, sovereign: true, reason: `nli ${r.label} (${r.score.toFixed(3)})`,
            };
        }
        return null;
    }
}
