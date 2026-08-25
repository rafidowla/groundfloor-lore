/**
 * callTally.ts — a per-instance count of which graph operations a host asks
 * for, and at what argument shapes.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Phase 7 tried to answer "what does Atlas actually ask Lore for?" and could
 * not. Lore's `audit.jsonl` records one operation kind (`lib:nodeUpsert`) —
 * writes only. The per-workspace `tool-dispatch.jsonl` sees only the handful of
 * calls that arrive through Lore's own MCP server. Atlas embeds Lore
 * in-process and reaches the graph directly, so **none** of its reads pass the
 * layer where instrumentation currently sits. The operation mix had to be
 * inferred by reading Atlas's source instead of measured, and an engine
 * decision was very nearly made on that inference.
 *
 * ── WHY IT COUNTS AT THE ENGINE, NOT THE MCP LAYER ──────────────────────────
 *
 * Because that is where the calls land. An embedded host bypasses MCP, HTTP and
 * the storage facade — `EmbeddedLore` in Atlas reaches `rawGraph()` directly.
 * Counting anywhere above the engine reproduces exactly the blind spot this
 * closes.
 *
 * ── OWNERSHIP (CLAUDE.md): NO GATE IS NEEDED, AND HERE IS WHY ───────────────
 *
 * The rule is that process-global side effects gate on process OWNERSHIP, not
 * on mode. This deliberately has no process-global state: **one tally per graph
 * instance**, reachable only from that instance, holding integers in memory. It
 * writes no file, installs no handler, touches no shared registry, and two
 * instances in one process cannot see each other's counts. So there is nothing
 * for an ownership gate to protect. Had this been a module-level singleton — the
 * obvious shortcut — it WOULD be process-global state created by a library that
 * does not own the process, and it would need the gate. That is the reason it
 * is not one.
 *
 * ── COST ────────────────────────────────────────────────────────────────────
 *
 * A Map get + integer increment per operation, against operations whose floor
 * is a database round trip in the hundreds of microseconds. Measured in
 * `test/call-tally-unit.ts` rather than asserted. `LORE_CALL_TALLY=0` disables
 * it, after which each call site is a single null check.
 */

/** One operation's counts, plus a breakdown by argument shape. */
export interface CallTallyEntry {
    op: string;
    count: number;
    /** e.g. `{ 'depth=3': 12, 'depth=1': 40 }`. Empty when the op has no shape. */
    shapes: Record<string, number>;
}

export interface CallTallySnapshot {
    /** When counting started (or was last reset). */
    since: string;
    total: number;
    entries: CallTallyEntry[];
}

/**
 * Is tallying on? Default ON — a counter that is off by default is not there
 * on the day someone needs the answer, which is precisely how Phase 7 ended up
 * inferring the mix from source. `LORE_CALL_TALLY=0` turns it off.
 */
export function callTallyEnabled(raw: string | undefined = process.env['LORE_CALL_TALLY']): boolean {
    return raw !== '0' && raw !== 'false';
}

export class CallTally {
    private readonly counts = new Map<string, number>();
    private readonly shapes = new Map<string, Map<string, number>>();
    private startedAt = new Date().toISOString();
    private total = 0;
    private on: boolean;

    constructor(enabled: boolean = callTallyEnabled()) { this.on = enabled; }

    get enabled(): boolean { return this.on; }

    /**
     * Turn counting on or off at runtime.
     *
     * The env var decides the default at construction; this lets a host that
     * only wants a measurement window pay nothing outside it, without having to
     * replace the instance the engine already holds.
     */
    setEnabled(enabled: boolean): void { this.on = enabled; }

    /**
     * Count one operation.
     *
     * `shape` is a short caller-supplied label — `depth=3`, `limit=unbounded`.
     * The tally deliberately does not interpret arguments itself: it would then
     * need to know every operation's signature, and would rot the moment one
     * changed. Callers use `shapeLimit`/`shapeDepth` below so the vocabulary
     * stays consistent across engines.
     */
    record(op: string, shape?: string): void {
        if (!this.on) return;
        this.counts.set(op, (this.counts.get(op) ?? 0) + 1);
        this.total += 1;
        if (shape === undefined) return;
        let byShape = this.shapes.get(op);
        if (!byShape) { byShape = new Map(); this.shapes.set(op, byShape); }
        byShape.set(shape, (byShape.get(shape) ?? 0) + 1);
    }

    /** Counts so far, busiest operation first. */
    snapshot(): CallTallySnapshot {
        const entries: CallTallyEntry[] = [];
        for (const [op, count] of this.counts) {
            entries.push({ op, count, shapes: Object.fromEntries(this.shapes.get(op) ?? []) });
        }
        entries.sort((a, b) => b.count - a.count || a.op.localeCompare(b.op));
        return { since: this.startedAt, total: this.total, entries };
    }

    /** Start a fresh window — for measuring one workload rather than a lifetime. */
    reset(): void {
        this.counts.clear();
        this.shapes.clear();
        this.total = 0;
        this.startedAt = new Date().toISOString();
    }
}

/**
 * Bucket a result limit.
 *
 * Bucketed, not exact, because the useful question is "does this caller ask for
 * ten rows or all of them?" — Phase 7 measured a 27× spread between those on
 * SurrealDB. Exact limits would scatter the histogram across hundreds of keys
 * and answer nothing.
 */
export function shapeLimit(limit: number | undefined, unbounded?: boolean): string {
    if (unbounded) return 'limit=unbounded';
    if (limit === undefined) return 'limit=default';
    if (limit <= 1) return 'limit=1';
    if (limit <= 10) return 'limit<=10';
    if (limit <= 100) return 'limit<=100';
    if (limit <= 1000) return 'limit<=1000';
    return 'limit>1000';
}

/** Traversal depth, exact — the range is 1..5, so bucketing would lose the point. */
export function shapeDepth(depth: number | undefined): string {
    return `depth=${depth ?? 'default'}`;
}
