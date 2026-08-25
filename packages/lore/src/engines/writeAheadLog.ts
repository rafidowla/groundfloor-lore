/**
 * writeAheadLog.ts — Append-only JSONL Write-Ahead Log for offline sync.
 *
 * Extracted from syncEngine.ts (SW-02) to keep that file under the 800-line
 * cap. Owns one concern: the durable on-disk WAL that buffers local writes
 * (node upserts, edge creates, deletes, admin ops) until the sync engine
 * pushes them to a remote backend.
 *
 * Side Effects: Reads/writes <loreDir>/sync.wal.
 * Determinism: Deterministic (local file I/O).
 * Thread Safety: Single-writer. Append is atomic for single lines.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { log } from '../logger.js';

/**
 * WalOperation — The type of operation recorded in the WAL.
 *
 * Core recognizes three operations. Any other op string is unrecognized:
 * there is no live producer of such ops (the plugin system was removed in
 * v3.11.0), and pushPending retains them in the WAL (SW-02 B3) rather than
 * pushing or dropping them.
 */
export type WalOperation = 'upsert_node' | 'add_edge' | 'delete_node' | (string & {});

/**
 * WalEntry — A single write operation buffered in the WAL.
 *
 * Inputs: Written by store_node/store_edge/delete_node operations.
 * Outputs: Read by push cycle for remote replication.
 */
export interface WalEntry {
    /** Operation type */
    op: WalOperation;
    /** Operation payload — node data, edge data, or node ID */
    data: Record<string, unknown>;
    /** ISO 8601 timestamp of the local write */
    timestamp: string;
    /** Unique entry ID for deduplication */
    entryId: string;
}

/**
 * WriteAheadLog — Append-only JSONL file for offline write buffering.
 *
 * Purpose:
 *   Buffers local write operations (node upserts, edge creates, deletes)
 *   as JSONL lines in .lore/sync.wal. The sync engine reads pending
 *   entries and pushes them to the remote backend.
 *
 * Format: One JSON object per line (JSONL / newline-delimited JSON).
 *
 * Side Effects: Reads/writes .lore/sync.wal file.
 * Determinism: Deterministic (local file I/O).
 * Thread Safety: Single-writer. Append is atomic for single lines.
 * Idempotency: append() is NOT idempotent — each call adds a new entry.
 */
export class WriteAheadLog {
    private walPath: string;

    /**
     * NW-7g (conc-wal-append-vs-truncate-rename-race): in-memory buffer for
     * appends that arrive while a truncate/truncatePushed is mid-flight. The
     * SW-02 truncate uses tmp-file + rename(2), which is atomic but NOT
     * mutually exclusive with concurrent O_APPEND writes — a sync append that
     * opens the file BEFORE the rename can write into the unlinked old inode
     * and that line is LOST.
     *
     * Fix: while truncate runs, route every append into this buffer. When the
     * truncate completes, drain the buffer back into the now-renamed file.
     * `append()` stays synchronous (its call-sites are sync MCP-tool handlers)
     * — the sync path just becomes "push to array" during the window.
     */
    private truncateInFlight = false;
    private bufferedDuringTruncate: WalEntry[] = [];

    /**
     * NW-7g (perf-wal-pendingcount-reparse): pendingCount() previously called
     * readPending() which re-parsed the entire WAL file. Track a counter
     * instead — incremented on every append, recomputed (via one disk read)
     * on truncate/truncatePushed, lazily initialised from disk on first
     * pendingCount() call after process start.
     *
     * `null` = not yet initialised from disk. `number` = current pending
     * count. The counter is process-local; another writer to the same WAL
     * file would invalidate it, but this WAL is single-writer (one SyncEngine
     * per workspace) so that's a non-issue.
     */
    private cachedPendingCount: number | null = null;

    /**
     * `false` when the workspace has no sync target — `append()` becomes a
     * no-op rather than logging writes nothing will ever consume.
     *
     * `truncatePushed` only removes entries once a push confirms they
     * reached a remote; `pruneVersions`-style aging doesn't apply here (this
     * is deliberately unbounded-until-synced by design, matching push's
     * NOT-idempotent-until-acked contract). A workspace with no adapter has
     * no cycle that will ever call truncatePushed, so append() logged
     * forever with nothing to drain it. Found in the wild: one local-only
     * workspace's sync.wal reached 228,000 entries / 222MB, none of which
     * were ever going anywhere.
     *
     * `SyncEngine` passes `adapter !== null` at construction — a real,
     * reliable signal (`resolveSyncAdapterFromEnv` returns null exactly when
     * no DATAPLANE_API_KEY is configured, not a non-functional stub — see
     * mcp/services.ts). If an operator later configures sync, the daemon
     * restarts and appends resume; nothing before that point had anywhere to
     * go regardless, so there is no historical gap that matters.
     *
     * Defaults to true so any other direct construction (tests, tooling)
     * keeps today's always-log behaviour unless it opts in to the gate.
     */
    private readonly enabled: boolean;

    /**
     * @param loreDir - Path to the .lore/ directory.
     * @param opts.enabled - Whether this workspace has a sync target. See
     *   the `enabled` field doc comment.
     */
    constructor(loreDir: string, opts: { enabled?: boolean } = {}) {
        this.walPath = path.join(loreDir, 'sync.wal');
        this.enabled = opts.enabled ?? true;
    }

    /**
     * append — Append a write operation to the WAL.
     *
     * @param op - Operation type.
     * @param data - Operation payload.
     *
     * Side Effects: Appends one JSONL line to sync.wal. No-op (no side
     * effect at all — not even the buffered-during-truncate path) when this
     * workspace has no sync target. See the `enabled` field doc comment.
     */
    append(op: WalOperation, data: Record<string, unknown>): void {
        if (!this.enabled) return;
        const entry: WalEntry = {
            op,
            data,
            timestamp: new Date().toISOString(),
            // SW-02 review (F6): truncatePushed keeps an entry iff its id is NOT
            // in the pushed set, so a colliding entryId would silently drop a
            // surviving (not-yet-pushed) entry. The old `Date.now()-6randchars`
            // (~31 random bits within one ms) could collide under burst writes;
            // randomUUID() is collision-free. Keep the ms prefix for readability.
            entryId: `${Date.now()}-${randomUUID()}`,
        };

        // NW-7g: if a truncate is mid-flight, buffer in memory instead of
        // writing to the on-disk file. The buffered entries are flushed to
        // disk by the truncate path right after rename(2) completes, so they
        // can never land in the about-to-be-unlinked old inode.
        if (this.truncateInFlight) {
            this.bufferedDuringTruncate.push(entry);
            if (this.cachedPendingCount !== null) this.cachedPendingCount++;
            return;
        }

        this.writeEntryToDisk(entry);
        if (this.cachedPendingCount !== null) this.cachedPendingCount++;
    }

    /**
     * NW-7g — extracted disk-write so the buffered-during-truncate drain can
     * reuse the exact same fdatasync semantics as the hot append path.
     */
    private writeEntryToDisk(entry: WalEntry): void {
        // INTEGRITY (Audit 2026-05-13): fdatasync after every append.
        // Previously the WAL relied on page-cache buffering — a hard power
        // loss in the ~30s before fsync flushed could silently lose every
        // un-pushed entry. Open with O_APPEND + dsync semantics by writing
        // then explicitly fdatasync'ing the file descriptor.
        const line = JSON.stringify(entry) + '\n';
        const fd = fs.openSync(this.walPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);
        try {
            fs.writeSync(fd, line, null, 'utf-8');
            fs.fdatasyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    }

    /**
     * readPending — Read all pending (un-flushed) WAL entries.
     *
     * @returns Array of WalEntry objects in chronological order.
     *
     * Side Effects: Reads sync.wal file.
     * Error Behavior: Returns empty array if file doesn't exist.
     */
    readPending(): WalEntry[] {
        if (!fs.existsSync(this.walPath)) return [];

        const rawContent = fs.readFileSync(this.walPath, 'utf-8').trim();
        if (!rawContent) return [];

        const entries: WalEntry[] = [];
        let skipped = 0;
        for (const line of rawContent.split('\n')) {
            try {
                entries.push(JSON.parse(line) as WalEntry);
            } catch {
                // SW-02 (B11): a malformed line is corruption, not nothing.
                // Previously these vanished silently — an operator never
                // learned sync data was skipped. Count them and surface a
                // warning so corruption is at least observable. The line is
                // still skipped (it can't be parsed/pushed), but no longer
                // disappears without a trace.
                skipped++;
            }
        }
        if (skipped > 0) {
            log.warn(`[Lore Sync] WAL readPending skipped ${skipped} malformed line(s) in ${this.walPath}`);
        }

        return entries;
    }

    /**
     * truncate — Clear the WAL after a successful push.
     *
     * Side Effects: Overwrites sync.wal with empty content.
     * Idempotency: Yes — safe to call multiple times.
     */
    truncate(): void {
        // NW-7g — set truncateInFlight so concurrent appends buffer in memory
        // rather than writing to the about-to-be-unlinked old inode.
        this.truncateInFlight = true;
        try {
            // INTEGRITY (Audit 2026-05-13): atomic truncate via tmp-file + rename.
            // Previously this used in-place `writeFileSync('')`, which on POSIX
            // is NOT atomic — a crash mid-write could leave the WAL half-truncated
            // with arbitrary trailing bytes that subsequent readPending() would
            // silently skip. Writing an empty tmp file and rename(2)-ing over the
            // WAL is atomic by POSIX guarantee.
            const tmpPath = this.tmpPath();
            const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
            try {
                fs.fdatasyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmpPath, this.walPath);
            this.fsyncDir();
            // After full-truncate: counter is buffer.length (any pending
            // appends during the window) — they will be written to disk by
            // drainBufferedAppends() right below.
            this.cachedPendingCount = this.bufferedDuringTruncate.length;
            this.drainBufferedAppends();
        } finally {
            this.truncateInFlight = false;
        }
    }

    /**
     * NW-7g — after a truncate/truncatePushed completes, flush any appends
     * that arrived during the window. The caller is responsible for setting
     * `cachedPendingCount` to the post-drain target BEFORE invoking this
     * (since `writeEntryToDisk` does not touch the counter).
     */
    private drainBufferedAppends(): void {
        if (this.bufferedDuringTruncate.length === 0) return;
        const drained = this.bufferedDuringTruncate;
        this.bufferedDuringTruncate = [];
        for (const e of drained) {
            this.writeEntryToDisk(e);
        }
    }

    /**
     * truncatePushed — Remove only the entries that were actually
     * read + pushed, preserving everything else.
     *
     * SW-02 (B1): the old flow read the WAL, awaited a network push,
     * then blanket-truncated the whole file. Any entry appended by a
     * concurrent local write DURING the awaited push was read by neither
     * cycle yet wiped by the truncate — silent, permanent data loss.
     * Instead we rewrite the WAL keeping only the lines whose entryId is
     * NOT in `pushedEntryIds`. Entries appended mid-push (new entryIds)
     * survive to the next cycle; unrecognized / unacked entries that the
     * caller deliberately excluded from `pushedEntryIds` also survive.
     *
     * Atomic via tmp-file + rename(2), matching truncate()'s guarantee.
     *
     * @param pushedEntryIds - entryIds confirmed pushed (safe to drop).
     *
     * Side Effects: Rewrites sync.wal with the un-pushed remainder.
     */
    truncatePushed(pushedEntryIds: Set<string>): void {
        // NW-7g — same buffered-during-truncate window as truncate(). Holding
        // the flag across the read+write keeps appends from racing the
        // rename(2) into the unlinked old inode.
        this.truncateInFlight = true;
        try {
            // Re-read current on-disk contents so entries appended during the
            // push are observed here (they will NOT be in pushedEntryIds).
            const remaining = this.readPending().filter(e => !pushedEntryIds.has(e.entryId));

            if (remaining.length === 0) {
                // Inline the truncate() body — calling truncate() recursively
                // would toggle truncateInFlight off mid-flow.
                const tmpPath0 = this.tmpPath();
                const fd0 = fs.openSync(tmpPath0, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
                try { fs.fdatasyncSync(fd0); } finally { fs.closeSync(fd0); }
                fs.renameSync(tmpPath0, this.walPath);
                this.fsyncDir();
                this.cachedPendingCount = this.bufferedDuringTruncate.length;
                this.drainBufferedAppends();
                return;
            }

            const body = remaining.map(e => JSON.stringify(e)).join('\n') + '\n';
            const tmpPath = this.tmpPath();
            const fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
            try {
                fs.writeSync(fd, body, null, 'utf-8');
                fs.fdatasyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmpPath, this.walPath);
            this.fsyncDir();
            this.cachedPendingCount = remaining.length + this.bufferedDuringTruncate.length;
            this.drainBufferedAppends();
        } finally {
            this.truncateInFlight = false;
        }
    }

    /**
     * tmpPath — a per-call staging filename for the atomic rewrite (F2).
     * A fixed `<wal>.tmp` would let two concurrent rewrites (or a stale
     * leftover from a crashed run) stomp each other's staging file; the
     * pid + random suffix makes each rewrite's tmp file unique.
     */
    private tmpPath(): string {
        return `${this.walPath}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
    }

    /**
     * fsyncDir — fsync the WAL's parent directory after a rename(2) (F3).
     * rename(2) is atomic, but its *durability* across power loss requires
     * an fsync on the containing directory — otherwise a crash right after
     * a push+truncate can roll the WAL back and re-push already-acked
     * entries (idempotent for upsert/edge/delete, but avoidable). Mirrors
     * the per-append fdatasync. Best-effort: dir-fsync is unsupported on
     * some platforms (e.g. Windows), so failures are swallowed.
     */
    private fsyncDir(): void {
        try {
            const dirFd = fs.openSync(path.dirname(this.walPath), fs.constants.O_RDONLY);
            try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
        } catch {
            /* best-effort durability; not all platforms allow dir fsync */
        }
    }

    /**
     * pendingCount — Number of un-flushed entries.
     *
     * NW-7g (perf-wal-pendingcount-reparse): previously this method called
     * readPending() — a full JSONL re-parse of the on-disk file on every
     * call. Observability endpoints poll pendingCount() at high frequency
     * (health, metrics scrape), so a 1k-entry WAL paid 1k JSON.parse calls
     * per poll. Track an in-memory counter instead; only the first call after
     * process start reads the file (to seed the counter from on-disk reality).
     *
     * @returns Count of pending operations.
     */
    pendingCount(): number {
        if (this.cachedPendingCount === null) {
            // Seed from disk exactly once; subsequent calls are O(1).
            this.cachedPendingCount = this.readPending().length;
        }
        // Buffered-during-truncate entries already bumped cachedPendingCount
        // at append-time, so it already reflects the right total.
        return this.cachedPendingCount;
    }

    /**
     * exists — Whether the WAL file exists on disk.
     */
    exists(): boolean {
        return fs.existsSync(this.walPath);
    }
}
