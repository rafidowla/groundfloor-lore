/**
 * logThrottle.ts - 3.35.0 (b): rate-limit the replicator's repeating log lines.
 *
 * Against an unreachable engine every pending row logs the same "transient failure" line on every
 * retry (and every deferred row and every tick error), so one outage wrote thousands of identical
 * lines. This keeps the FIRST occurrence of each message class (class = the line with row ids,
 * counters and timestamps normalised away, so same engine error + same label = same class) and
 * counts the rest; at most once per interval it emits one summary line with the suppressed count.
 * A class not seen before is always emitted, and lines that are not recurring noise (dead-lettered
 * rows, start/stop, prune, self-heal...) never go through the throttle at all.
 *
 * No existing rate-limited logger helper exists in the codebase (the only "rate limiter" is the
 * HTTP request RateLimiter in security/, which is unrelated), hence this module.
 */

export const DEFAULT_LOG_THROTTLE_INTERVAL_MS = 60_000;
const MAX_KEYS = 256;

/** The throttle class of a recurring replicator line, or null when the line must always be emitted. */
export function recurringLogClass(msg: string): string | null {
    let kind: string | null = null;
    if (/\btransient failure #\d+/.test(msg)) kind = 'transient';
    else if (/\bdeferred, back to pending:/.test(msg)) kind = 'deferred';
    else if (/\btick error:/.test(msg)) kind = 'tick';
    else if (/\bpending_commit settle(?: failed|: graph unreachable)/.test(msg)) kind = 'settle';
    if (!kind) return null;
    const normalised = msg
        .replace(/\bentry [0-9a-f-]{8,}/gi, 'entry *')
        .replace(/\bretrying at \S+/g, 'retrying at *')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '*')
        .replace(/\d+/g, 'N');
    return `${kind}|${normalised}`;
}

interface Bucket { sample: string; windowStart: number; suppressed: number }

export class LogThrottle {
    private readonly buckets = new Map<string, Bucket>();

    constructor(
        private readonly emit: (msg: string) => void,
        private readonly intervalMs: number = DEFAULT_LOG_THROTTLE_INTERVAL_MS,
        private readonly now: () => number = Date.now,
    ) {}

    /** Emit `msg` unless its class was already emitted within the interval (then count it). */
    log(msg: string): void {
        const key = recurringLogClass(msg);
        if (key === null) { this.emit(msg); return; }
        const t = this.now();
        const b = this.buckets.get(key);
        if (b && t - b.windowStart < this.intervalMs) { b.suppressed++; return; }
        if (b) this.summarise(b, t);
        if (!b && this.buckets.size >= MAX_KEYS) this.flush(true);
        this.buckets.set(key, { sample: msg, windowStart: t, suppressed: 0 });
        this.emit(msg);
    }

    /** Emit the suppressed-count summary of every class whose interval has elapsed (all of them with `force`). Call once per tick. */
    flush(force = false): void {
        const t = this.now();
        for (const [key, b] of this.buckets) {
            if (!force && t - b.windowStart < this.intervalMs) continue;
            this.summarise(b, t);
            this.buckets.delete(key);
        }
    }

    private summarise(b: Bucket, t: number): void {
        if (b.suppressed === 0) return;
        this.emit(`[outbox replicator] ${b.suppressed} similar message(s) suppressed in the last ${Math.round((t - b.windowStart) / 1000)}s: ${b.sample}`);
        b.suppressed = 0;
    }
}
