/**
 * normalize.ts - the explicit allowlist of volatile values replaced before a golden snapshot is written or compared.
 *
 * Nothing is stripped wholesale: every rule below names the exact kind of value it rewrites and why. Anything not
 * matched by a rule is compared verbatim, so a new field or a changed value shows up as a diff.
 */
import * as os from 'node:os';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/**
 * Float relevance scores: engines may differ in the 5th decimal, so these exact keys are rounded to 4 dp. An exact
 * list on purpose: a substring/regex rule would also catch unrelated keys (and silently hide changes in them).
 * No duration rule: no output of the workload carries a measured duration.
 */
const SCORE_KEYS = new Set(['score', 'similarity', 'top_score', 'top_similarity', 'top_relevance', 'confidence', 'confidenceScore', 'null_median', 'null_scale']);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export interface NormalizeContext {
    /** Absolute directories that must never reach a snapshot (the per-run LORE home / temp dir). Longest first. */
    homes: string[];
    /** Per-run unique tokens (e.g. the Postgres database name containing the pid) mapped to a stable placeholder. */
    tokens?: Record<string, string>;
}

export interface Normalizer {
    /** Deep-copy `value` with every volatile field replaced per the rules in this file. */
    apply(value: unknown): unknown;
}

/**
 * Build a normaliser. Generated uuids are replaced by `<uuid-N>` in FIRST-SEEN order, so the placeholder numbering is
 * stable as long as the workload visits fields in a fixed order (it does: object keys are visited in insertion order,
 * and the workload is sequential).
 */
export function createNormalizer(ctx: NormalizeContext): Normalizer {
    const uuids = new Map<string, string>();
    const homes = [...ctx.homes, os.tmpdir(), os.homedir()].filter((h) => h && h !== '/').sort((a, b) => b.length - a.length);
    const tokens = Object.entries(ctx.tokens ?? {}).sort((a, b) => b[0].length - a[0].length);

    const str = (s: string, key: string | undefined): string => {
        // Rule 1: wall-clock timestamps (matched by exact ISO-8601 UTC shape, so createdAt/updatedAt/lastAccessedAt/supersededAt/... and any future *At field are all covered).
        if (ISO_RE.test(s)) return '<ts>';
        let out = s;
        // Rule 2: absolute paths. The per-run home is a fresh mkdtemp dir, so it differs on every run.
        for (const h of homes) if (out.includes(h)) out = out.split(h).join('<home>');
        // Rule 3: per-run unique tokens (pid-named database etc.).
        for (const [tok, repl] of tokens) if (out.includes(tok)) out = out.split(tok).join(repl);
        // Rule 4: generated uuids (workspace ids minted by createWorkspace, job ids, ...) -> stable placeholder by first-seen order.
        out = out.replace(UUID_RE, (m) => {
            const k = m.toLowerCase();
            if (!uuids.has(k)) uuids.set(k, `<uuid-${uuids.size + 1}>`);
            return uuids.get(k)!;
        });
        return out;
    };

    const walk = (v: unknown, key: string | undefined): unknown => {
        if (v === null || v === undefined) return v ?? null;
        if (typeof v === 'string') return str(v, key);
        if (typeof v === 'number') {
            // Rule 5: scores rounded to 4 dp (exact keys, see SCORE_KEYS).
            if (key !== undefined && SCORE_KEYS.has(key) && !Number.isInteger(v)) return Math.round(v * 1e4) / 1e4;
            return v;
        }
        if (typeof v === 'boolean') return v;
        if (Array.isArray(v)) return v.map((x) => walk(x, key));
        if (typeof v === 'object') {
            const out: Record<string, unknown> = {};
            for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
                // Rule 6: undefined-valued keys are dropped (JSON drops them anyway; make that explicit and engine-independent).
                if (x === undefined) continue;
                out[k] = walk(x, k);
            }
            return out;
        }
        return String(v);
    };

    return { apply: (value) => walk(value, undefined) };
}

/** JSON with every object's keys sorted, 2-space indent, trailing newline: the committed snapshot format. */
export function stableStringify(v: unknown): string {
    const sort = (x: unknown): unknown => {
        if (Array.isArray(x)) return x.map(sort);
        if (x && typeof x === 'object') {
            const o: Record<string, unknown> = {};
            for (const k of Object.keys(x as object).sort()) o[k] = sort((x as Record<string, unknown>)[k]);
            return o;
        }
        return x;
    };
    return JSON.stringify(sort(v), null, 2) + '\n';
}
