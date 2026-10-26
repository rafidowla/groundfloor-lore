/**
 * relationTyper.ts - the typing cascade of Links Loop D (design: cheap and always-on first, costly and optional last).
 *
 *   1. RulesTyper (always on with discovery)  - near-duplicate above `supersedeSim` + differing timestamps => a
 *      `supersedes` verdict (newer over older). A CANDIDATE only: it becomes a proposal, never a state change.
 *   2. NliTyper   (nliTyper.ts, OFF by default) - local text-pair classifier: entailment => supports,
 *      contradiction => contradicts. Anything uncertain or neutral falls through.
 *   3. LlmJudgeTyper (judgeTyper.ts, OFF by default) - an OpenAI-compatible endpoint, bounded by a per-workspace budget.
 *
 * Every tier implements {@link IRelationTyper}; the cascade returns the first verdict. A typer that throws is skipped
 * (the pair is simply left untyped) so a flaky model can never stall or fail discovery.
 */
export type TypedRelation = 'supports' | 'contradicts' | 'supersedes';

/** The slice of a node a typer may read. Texts are already capped by the caller (see {@link TYPING_TEXT_MAX}). */
export interface TypingNode {
    id: string;
    label: string;
    content: string;
    createdAt: string;
    updatedAt: string;
    /** Already superseded nodes are never typed (a proposal about them would be stale on arrival). */
    supersededBy: string | null;
}

/** A linked-or-linkable pair. `a.id < b.id` (the sorted pair the link edge uses). */
export interface RelationCandidate {
    a: TypingNode;
    b: TypingNode;
    /** Cosine similarity the link policy computed. */
    score: number;
}

export interface RelationVerdict {
    relation: TypedRelation;
    /** In [0,1]; the typer's own confidence (rules: the similarity). */
    confidence: number;
    /** Which typer decided (`rules`, `nli:<model>`, `judge:<model>`). */
    typer: string;
    /** False when the verdict was produced by a service outside this machine. */
    sovereign: boolean;
    /** `supersedes` only: the node that would supersede, and the node it would replace. */
    newerId?: string;
    olderId?: string;
    reason?: string;
}

export interface TypingContext {
    workspace: string;
    /** Costly typers call this before each paid call; false => the budget is spent and the typer must return null. */
    takeBudget(): boolean;
    /** Called by a typer that declined to run because the budget was spent (counted as a budget stop). */
    onBudgetStop(): void;
}

export interface IRelationTyper {
    readonly id: string;
    /** True when the typer runs entirely on this machine. */
    readonly sovereign: boolean;
    /** A verdict, or null when this tier has nothing confident to say (the cascade then tries the next one). */
    type(c: RelationCandidate, ctx: TypingContext): Promise<RelationVerdict | null>;
}

/** Longest text a typer is given per node (characters); NLI models and judge prompts both want short inputs. */
export const TYPING_TEXT_MAX = 1200;

export function capText(s: string, max = TYPING_TEXT_MAX): string {
    return s.length <= max ? s : s.slice(0, max);
}

const ts = (iso: string): number => { const t = Date.parse(iso); return Number.isFinite(t) ? t : NaN; };

/** Tier 1: near-duplicates ordered by time. Pure; no model, no I/O. */
export class RulesTyper implements IRelationTyper {
    readonly id = 'rules';
    readonly sovereign = true;
    constructor(private readonly supersedeSim: number) {}

    async type(c: RelationCandidate): Promise<RelationVerdict | null> {
        if (!(c.score >= this.supersedeSim)) return null;
        if (c.a.supersededBy || c.b.supersededBy) return null;
        let ta = ts(c.a.createdAt), tb = ts(c.b.createdAt);
        if (!(Number.isFinite(ta) && Number.isFinite(tb)) || ta === tb) { ta = ts(c.a.updatedAt); tb = ts(c.b.updatedAt); }
        if (!(Number.isFinite(ta) && Number.isFinite(tb)) || ta === tb) return null; // no way to tell which is newer
        const [newer, older] = ta > tb ? [c.a, c.b] : [c.b, c.a];
        return {
            relation: 'supersedes', confidence: c.score, typer: this.id, sovereign: true, newerId: newer.id, olderId: older.id,
            reason: `near-duplicate (similarity ${c.score.toFixed(3)}); ${newer.id} is the newer`,
        };
    }
}

export interface CascadeOptions { onError?: (message: string) => void }

export class TypingCascade {
    constructor(private readonly typers: readonly IRelationTyper[], private readonly o: CascadeOptions = {}) {}

    get ids(): string[] { return this.typers.map((t) => t.id); }

    async type(c: RelationCandidate, ctx: TypingContext): Promise<RelationVerdict | null> {
        for (const t of this.typers) {
            try {
                const v = await t.type(c, ctx);
                if (v) return { ...v, typer: v.typer || t.id, sovereign: v.sovereign && t.sovereign };
            } catch (err) {
                this.o.onError?.(`link typer ${t.id} failed: ${(err as Error).message}`);
            }
        }
        return null;
    }
}
