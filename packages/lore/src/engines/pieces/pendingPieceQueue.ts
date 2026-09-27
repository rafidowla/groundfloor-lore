/**
 * pendingPieceQueue.ts — 3.24.1, piece vectors under the search worker.
 *
 * In parent-embeds mode (LORE_SEARCH_WORKER=1 with a parentEmbedder) the
 * child's VerbatimStore runs on a stub provider that can neither window nor
 * embed, so it cannot build pieces itself. Instead its piece hooks enqueue
 * the rows it ACTUALLY wrote here; the parent drains them
 * (`takePendingPieceRows`), builds + embeds the pieces with its real
 * provider (`buildPieceRecords`), and ships them back
 * (`upsertPrebuiltPieces`).
 *
 * Only rows the child really wrote are enqueued — a skip-identical re-store
 * never reaches a piece hook — so the parent embeds pieces only for changed
 * content, never for the constant unchanged re-stores hosts send.
 *
 * Ordering: every enqueue stamps the id with a fresh sequence number; a
 * delete forgets the id. A prebuilt batch is accepted for an id only while
 * its sequence is still the latest one, so a build that raced a newer write
 * or a delete of the same node is dropped (the newer write's own entry is
 * still queued and will be built next) instead of resurrecting stale pieces.
 */

import { isRevisionHistoryId } from '../verbatimHistory.js';
import type { PieceSourceRow } from './pieceLayout.js';

export interface PendingPieceRow {
    seq: number;
    row: PieceSourceRow;
}

export class PendingPieceQueue {
    /** Starts from the clock so sequences stay unique across a search-worker
     *  restart: a batch the parent built for a child that has since died can
     *  never match a sequence the respawned child hands out. */
    private nextSeq = Date.now() * 1024;
    /** Rows waiting to be taken, by node id (a newer write replaces an older one). */
    private readonly pending = new Map<string, PendingPieceRow>();
    /** Latest sequence per id, for every id pending OR taken-but-not-yet-written. */
    private readonly latest = new Map<string, number>();

    enqueue(rows: PieceSourceRow[]): void {
        for (const row of rows) {
            if (isRevisionHistoryId(row.id)) continue;
            const seq = this.nextSeq++;
            this.pending.set(row.id, { seq, row });
            this.latest.set(row.id, seq);
        }
    }

    /** Removes and returns up to `limit` pending rows (oldest first). */
    take(limit: number): PendingPieceRow[] {
        const out: PendingPieceRow[] = [];
        for (const [id, entry] of this.pending) {
            if (out.length >= limit) break;
            out.push(entry);
            this.pending.delete(id);
        }
        return out;
    }

    /** True (and releases the id) when `seq` is still the latest write for `id`. */
    accept(id: string, seq: number): boolean {
        if (this.latest.get(id) !== seq) return false;
        this.latest.delete(id);
        return true;
    }

    /** A delete/tombstone of `ids`: drop anything queued or in flight for them. */
    forget(ids: string[]): void {
        for (const id of ids) {
            this.pending.delete(id);
            this.latest.delete(id);
        }
    }

    clear(): void {
        this.pending.clear();
        this.latest.clear();
    }

    get size(): number {
        return this.pending.size;
    }
}
