/**
 * toolDispatchLog.ts — v1.1 deferred item #6: tool-dispatch JSONL log.
 *
 * Every Lore MCP tool call (across all 30+ tools registered by core +
 * plugins) appends one JSON line to `<loreDir>/tool-dispatch.jsonl`.
 * Lets a post-hoc analyzer cross-reference the agent's transcript
 * against the daemon's tool calls to compute:
 *
 *   - Tools used per turn
 *   - Whether the agent followed a Lore tool with a Read on the same
 *     file (the "hedging" pattern the eval flagged)
 *   - Per-tool latency p50 / p95
 *
 * The daemon can NOT see the agent's other tool calls (Read, Bash,
 * etc.) — those go to the host, not us. So this log is one half of
 * the picture; the analyzer uses the agent's transcript for the other
 * half. Pairing them gives the full multi-turn budget view.
 *
 * Why JSONL not metrics:
 *   Single-process daemon, low write volume (a few hundred lines per
 *   eval run). JSONL keeps the analyzer trivial (one `for await` over
 *   `readline`) and avoids dragging a metrics library into the daemon.
 *   Production-scale instrumentation can replace this with the same
 *   shape over OTLP later.
 *
 * License: original work for groundfloor-lore.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ToolDispatchEvent {
    /** ISO 8601 timestamp of the dispatch start. */
    ts: string;
    /** MCP session id if the SDK exposed one; empty otherwise. */
    sessionId: string;
    /** Tool name, e.g. "recall", "store_node". */
    tool: string;
    /** End-to-end handler time in milliseconds. */
    elapsedMs: number;
    /** True on success, false if the handler threw. */
    ok: boolean;
    /** Truncated error message when ok=false; empty otherwise. */
    error: string;
}

/** Default log file location, relative to the active workspace .lore dir. */
const DEFAULT_LOG_FILENAME = 'tool-dispatch.jsonl';

let writeStream: fs.WriteStream | null = null;
let resolvedPath: string | null = null;

/**
 * Lazy-initialize the append stream. We delay opening the file until
 * the first event so unit tests + cold daemons don't create empty
 * files. Once opened, the stream stays alive for the daemon's
 * lifetime — closing on process exit isn't necessary; Node flushes
 * pending writes on natural termination.
 */
function getStream(loreDir: string): fs.WriteStream {
    if (writeStream && resolvedPath) return writeStream;
    resolvedPath = path.join(loreDir, DEFAULT_LOG_FILENAME);
    try {
        // mkdir -p on the parent in case the workspace was created
        // without the .lore subdir (rare; defensive).
        fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    } catch {
        /* path already exists; fine. */
    }
    writeStream = fs.createWriteStream(resolvedPath, { flags: 'a' });
    writeStream.on('error', (err) => {
        // A logger that crashes the daemon is worse than a logger that
        // silently drops. Surface once and continue.
        console.error(`[tool-dispatch-log] write failed for ${resolvedPath}: ${err.message}`);
    });
    return writeStream;
}

/**
 * Append one event. Synchronous from the caller's perspective; the
 * actual file write is buffered by the stream. Does not block the
 * tool's response — if the disk is slow, events queue in memory and
 * drain when the stream drains.
 *
 * Errors are swallowed deliberately: instrumentation must never
 * affect tool correctness. The error is logged once via the stream's
 * 'error' event handler above.
 */
export function appendToolDispatch(loreDir: string, event: ToolDispatchEvent): void {
    try {
        const stream = getStream(loreDir);
        stream.write(`${JSON.stringify(event)}\n`);
    } catch {
        /* swallow — instrumentation must not affect tool correctness. */
    }
}

/** Test-only: drop the cached stream so a subsequent call re-opens. */
export function _resetToolDispatchLogForTests(): void {
    try { writeStream?.end(); } catch { /* noop */ }
    writeStream = null;
    resolvedPath = null;
}
