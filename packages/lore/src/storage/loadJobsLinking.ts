/**
 * loadJobsLinking.ts - the link-on-arrival intent bookkeeping of a `/api/load` job.
 *
 * Extracted from loadJobsRunner.ts (at the file-size guard). One instance per job run.
 *
 * WHAT IT DECIDES
 *   - Effective `autolink` of a row = the job-level `autolink` (load_jobs.autolink, persisted, so it survives
 *     a daemon restart mid-job) AND the row's own. PRECEDENCE: either side saying `false` wins. A per-row
 *     `autolink:true` never overrides a job-level `false`; with the job at true each row's own value decides.
 *   - The opt-out is DURABLE (stored in the workspace's graph store, see link/linkTypes.ts LinkOptOutCapable):
 *       effective false      -> record the opt-out (the row gets no automatic links, either direction)
 *       explicit true        -> clear a previous opt-out
 *       omitted (undefined)  -> leave whatever is there; a plain re-load never re-enables linking
 *     Because the flag outlives the write there is no embed-mode distinction: inline, queued (embed.batch,
 *     committed later by the outbox replicator) and skip (placeholder vector, real one from a later
 *     `lore embed reembed`) all read the same flag at link time, however late the vector lands.
 *   - Graph-node rows carry no vector here, but a later re-embed can give them one, so under a job-level `false`
 *     they are opted out too ("every row the job writes"). Edge rows have no node id and are left alone.
 *
 * WHY BATCHED: the previous code issued one SQLite transaction per row; a bulk load is millions of rows.
 * `flush()` groups ids by intent and the runner calls it right before it emits embeds / signals, so the intent
 * is still durable strictly before the vector can commit and be signalled.
 */
import type { LinkSignaler } from '../link/linkTypes.js';
import { applyLinkIntent, signalCommitted } from '../link/signalCommitted.js';
import type { ParsedRow } from '../bulkLoader/loaderDispatcher.js';

type EmbedMode = 'inline' | 'queued' | 'skip';

/** Effective autolink of one row. `false` = never link; `undefined`/`true` = the link-on-arrival flag decides. */
export function effectiveAutolink(jobAutolink: boolean, rowAutolink: boolean | undefined): boolean | undefined {
    return jobAutolink === false || rowAutolink === false ? false : rowAutolink;
}

export class LoadLinkIntents {
    private readonly off = new Set<string>();
    private readonly clear = new Set<string>();
    /** Every id this job has opted out, across flushes: a later per-row true for it must not clear the flag. */
    private readonly seenOff = new Set<string>();
    private readonly inlineIds: string[] = [];

    constructor(
        private readonly signaler: LinkSignaler | null | undefined,
        private readonly job: { workspace: string; embedMode: EmbedMode; autolink: boolean },
    ) {}

    /** Note the linking intent of one dispatched row. No-op when link-on-arrival is off (no signaler). */
    record(parsed: ParsedRow): void {
        if (!this.signaler) return;
        if (parsed.target === 'verbatim' || parsed.target === 'vector') {
            const id = parsed.row.id;
            const eff = effectiveAutolink(this.job.autolink, parsed.row.autolink);
            if (eff === false) { this.clear.delete(id); this.off.add(id); this.seenOff.add(id); }
            else if (eff === true && !this.seenOff.has(id)) this.clear.add(id); // within one write a per-row false wins
            if (this.job.embedMode === 'inline') this.inlineIds.push(id);
        } else if (parsed.target === 'graph.node' && this.job.autolink === false) {
            this.clear.delete(parsed.row.id);
            this.off.add(parsed.row.id);
            this.seenOff.add(parsed.row.id);
        }
    }

    /** Persist the buffered intents. Await BEFORE embeds are emitted / signals fire, so the flag is durable before the vector can commit. */
    async flush(): Promise<void> {
        if (!this.signaler) return;
        const { workspace } = this.job;
        if (this.off.size > 0) {
            const ids = [...this.off];
            this.off.clear();
            await applyLinkIntent(this.signaler, workspace, ids, false);
        }
        if (this.clear.size > 0) {
            const ids = [...this.clear];
            this.clear.clear();
            await applyLinkIntent(this.signaler, workspace, ids, true);
        }
    }

    /** embed=inline: the vectors are durable once the dispatcher flushed, so signal them (the worker skips opted-out nodes at link time). */
    signalInline(): void {
        if (this.inlineIds.length === 0) return;
        signalCommitted(this.signaler, this.job.workspace, this.inlineIds.splice(0).map((id) => ({ id })));
    }
}
