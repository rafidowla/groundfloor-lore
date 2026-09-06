/**
 * deadLetterWatch.ts — make permanent discard of a write LOUD.
 *
 * A dead-letter means the replicator gave up: that write is not on the
 * substrate, and nothing will retry it. Until this existed, the only trace was
 * one `marked dead:` line per row in the daemon log.
 *
 * That was not enough, and we know exactly how much it was not enough by. The
 * 3.17.0 parent-embeds regression discarded ~3,000 rows across 11 workspaces
 * over SEVEN DAYS, writing a log line every single time, and was found only
 * because somebody happened to read the log by hand while doing unrelated work.
 * Thousands of identical lines are not a signal — they are wallpaper.
 *
 * So this watches the DELTA rather than the event, which lets it say the one
 * thing the per-row line never could: whether the rate is sustained. A one-off
 * dead-letter is a bad row. A count that climbs tick after tick is a DEFECT
 * eating a whole class of write, and it escalates accordingly.
 *
 * Its own module (not inlined in replicator.ts) per the file-size budget in
 * CLAUDE.md, and because "when is discarded data worth shouting about" is a
 * separate concern from "drive the replication loop" — with its own unit test
 * that does not need a replicator.
 */

/** Consecutive observations that must EACH add dead-letters before escalating
 *  from "some rows died" to "a defect is eating a class of write". Three rules
 *  out a one-off burst without waiting out an incident. */
export const DEAD_LETTER_ESCALATE_TICKS = 3;

/**
 * Fold one observation of the total dead-letter count into the watch state.
 *
 * Pure and synchronous so the policy can be tested directly, without a
 * replicator, a store, or a clock. The caller does the logging.
 *
 * Quiet ticks return no lines at all: the count only moves when something is
 * actually discarded, so every line this emits corresponds to real, new,
 * permanent data loss. That is what keeps it from becoming wallpaper in turn.
 */
export interface DeadLetterWatchState {
    /** null until the first observation — see `observeDeadLetters`. */
    lastDeadCount: number | null;
    /** Consecutive observations that each added dead rows. */
    consecutiveIncreases: number;
}

export function newDeadLetterWatchState(): DeadLetterWatchState {
    return { lastDeadCount: null, consecutiveIncreases: 0 };
}

export function observeDeadLetters(
    state: DeadLetterWatchState,
    dead: number,
): { state: DeadLetterWatchState; lines: string[] } {
    // The first observation only establishes a baseline. Reporting a
    // pre-existing backlog as "new loss" on every daemon start would be the
    // same wallpaper problem in a different shape — but staying silent about a
    // non-empty queue would hide a real backlog, so it gets one NOTE.
    if (state.lastDeadCount === null) {
        const lines = dead > 0
            ? [`[outbox replicator] NOTE: ${dead} dead-lettered row(s) already in the outbox at startup. `
                + `Those writes are NOT on the substrate. Inspect: lore outbox drain-failed --dry-run`]
            : [];
        return { state: { lastDeadCount: dead, consecutiveIncreases: 0 }, lines };
    }

    // A drop means an operator drained or requeued them — re-baseline, and
    // reset the escalation streak so a later incident starts from zero.
    if (dead <= state.lastDeadCount) {
        return { state: { lastDeadCount: dead, consecutiveIncreases: 0 }, lines: [] };
    }

    const added = dead - state.lastDeadCount;
    const consecutiveIncreases = state.consecutiveIncreases + 1;
    const lines = [
        `[outbox replicator] DATA LOSS: ${added} write(s) permanently discarded since the last check `
        + `(${dead} dead-lettered in total). These are NOT on the substrate and will NOT be retried.`,
    ];

    if (consecutiveIncreases >= DEAD_LETTER_ESCALATE_TICKS) {
        lines.push(
            `[outbox replicator] DEAD-LETTERS ARE STILL CLIMBING after ${DEAD_LETTER_ESCALATE_TICKS} consecutive checks `
            + `(${dead} total). A SUSTAINED rate is a defect rejecting a class of write, not unlucky rows. `
            + `Triage: lore outbox drain-failed --dry-run. `
            + `Once the defect is fixed and deployed: lore outbox requeue-dead --dry-run — the payloads are retained, `
            + `so the discarded writes can be replayed.`,
        );
        // Reset the streak so escalation repeats every N ticks while the
        // incident continues, instead of firing once and going quiet again.
        return { state: { lastDeadCount: dead, consecutiveIncreases: 0 }, lines };
    }

    return { state: { lastDeadCount: dead, consecutiveIncreases }, lines };
}

/**
 * Stateful wrapper over `observeDeadLetters` — owns the running state so the
 * replicator holds one field and makes one call, and so this policy can grow
 * without pushing an already-oversized replicator.ts further over its budget.
 */
export class DeadLetterWatch {
    private state = newDeadLetterWatchState();
    /** Fold in the current total and emit whatever the policy decided. */
    observe(dead: number, log: (message: string) => void): void {
        const result = observeDeadLetters(this.state, dead);
        this.state = result.state;
        for (const line of result.lines) log(line);
    }
}
