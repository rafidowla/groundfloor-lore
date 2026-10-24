/**
 * linkOptOutGate.ts - the write side of the durable link opt-out, plus the one-time move of the old
 * queue-file opt-outs into the workspace store.
 *
 * WHERE THE FLAG LIVES: in the workspace's own graph store (`LinkOptOutCapable`: SQLite `graph.sqlite`,
 * Postgres `link_optout`), so it travels with backup and restore and survives a wiped queue file. The
 * StoredVectorLinker reads it straight from the same graph at link time; this class only WRITES it.
 *
 * LIFETIME (the contract): `autolink:false` sets it; an explicit `autolink:true` clears it; an omitted
 * `autolink` leaves it; deleting the node removes it (the engines' `deleteNode`). Nothing here ever consumes,
 * expires or re-enables it.
 *
 * MIGRATION: before this existed, opt-outs lived in the queue file's `link_optout` table (consumed on the next
 * vector commit, expired after 7 days unless sticky). On first touch of a workspace in a process (a write
 * intent, a link batch, a rebuild, or the background sweep from `start()`), its live legacy rows are copied into
 * the workspace store and then deleted from the queue file. Idempotent (re-running only re-inserts the same ids,
 * and the delete happens strictly after the store write succeeded), so a crash in between is harmless. After
 * that the workspace store is the only source of truth; the queue file keeps no opt-out state.
 *
 * ENGINES WITHOUT THE CAPABILITY (Surreal, Arcade, Dataplane): there is nowhere durable to put the flag, so
 * `autolink:false` is NOT honoured by the background linker there. That is logged once per workspace instead of
 * silently pretending; their legacy rows (if any) stay in the queue file untouched.
 */
import { hasLinkOptOutSupport, type LinkOptOutCapable } from './linkTypes.js';
import type { LinkQueueStore } from './sqliteLinkQueue.js';

/** Resolves the workspace's graph; null when the workspace cannot be opened. */
export type LinkGraphResolver = (workspace: string) => Promise<object | null>;

export interface LinkOptOutGateOptions {
    queue: LinkQueueStore;
    resolveGraph: LinkGraphResolver;
    now: () => number;
    onError: (message: string) => void;
}

function describe(err: unknown): string {
    const e = err as Error;
    return `${e?.constructor?.name ?? typeof err}: ${e?.message ?? String(err)}`;
}

export class LinkOptOutGate {
    private readonly done = new Set<string>();
    private readonly inflight = new Map<string, Promise<void>>();
    private readonly warned = new Set<string>();

    constructor(private readonly o: LinkOptOutGateOptions) {}

    /** Record / clear the durable flag. Awaited by the write paths BEFORE the write. Never rejects. */
    async setIntent(workspace: string, ids: ReadonlyArray<string>, autolink: boolean | undefined): Promise<void> {
        if (autolink === undefined || ids.length === 0) return;
        try {
            const graph = await this.o.resolveGraph(workspace);
            if (!graph) { this.o.onError(`link opt-out not recorded for '${workspace}': workspace unavailable`); return; }
            if (!hasLinkOptOutSupport(graph)) { this.warnUnsupported(workspace, autolink === false); return; }
            // Migrate first: a legacy row for one of these ids must not be copied in AFTER an explicit `true` cleared it.
            await this.migrate(workspace, graph);
            await graph.setLinkOptOuts(ids, autolink === false);
        } catch (err) {
            this.o.onError(`link intent failed: ${describe(err)}`);
        }
    }

    /** Make sure the workspace's legacy queue-file opt-outs are in the store. Never rejects; retried on the next call if it could not run. */
    async ensureMigrated(workspace: string): Promise<void> {
        if (this.done.has(workspace)) return;
        try {
            const graph = await this.o.resolveGraph(workspace);
            if (!graph || !hasLinkOptOutSupport(graph)) return;
            await this.migrate(workspace, graph);
        } catch (err) {
            this.o.onError(`link opt-out migration failed for '${workspace}': ${describe(err)}`);
        }
    }

    /** Background sweep from `start()`: migrate every workspace that still has legacy rows. */
    async sweep(isClosed: () => boolean): Promise<void> {
        let workspaces: string[];
        try { workspaces = this.o.queue.legacyOptOutWorkspaces(); } catch (err) { this.o.onError(`link opt-out sweep failed: ${describe(err)}`); return; }
        for (const ws of workspaces) {
            if (isClosed()) return;
            await this.ensureMigrated(ws);
        }
    }

    private migrate(workspace: string, graph: LinkOptOutCapable): Promise<void> {
        if (this.done.has(workspace)) return Promise.resolve();
        const running = this.inflight.get(workspace);
        if (running) return running;
        const p = (async (): Promise<void> => {
            const live = this.o.queue.legacyOptOuts(workspace, this.o.now());
            if (live.length > 0) await graph.setLinkOptOuts(live, true);
            this.o.queue.dropLegacyOptOuts(workspace); // after the store write; also retires expired rows
            this.done.add(workspace);
        })().finally(() => { this.inflight.delete(workspace); });
        this.inflight.set(workspace, p);
        return p;
    }

    private warnUnsupported(workspace: string, optOut: boolean): void {
        if (!optOut || this.warned.has(workspace)) return;
        this.warned.add(workspace);
        this.o.onError(`autolink:false for '${workspace}' is not durable on this graph engine (no link opt-out store); background linking will not honour it`);
    }
}
