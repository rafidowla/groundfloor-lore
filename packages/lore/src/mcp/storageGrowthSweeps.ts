/**
 * storageGrowthSweeps.ts — storage-growth fix 2/3: single wiring entry point
 * for R3 (embedded-host version-history pruning) + R4 (outbox prune-on-open).
 *
 * Extracted (and the two calls combined behind one function) purely to keep
 * server.ts inside its file-size guardrail — the actual logic and full
 * rationale for each fix live in their own modules:
 *   - R3: `resolveVersionPruneSweeper` in versionPruneScheduler.ts.
 *   - R4: `scheduleOutboxOpenPruneSweep` in outboxOpenPruneSweep.ts.
 *
 * Must be called EAGERLY, exactly once per `createLore()` call, at the same
 * point the two sweepers were previously constructed as top-level consts —
 * NOT from inside `buildOrderedDrain`'s lazy closure (that closure's result
 * is only actually invoked once, but doing the construction there would
 * shift both sweepers' start time to wherever/whenever drain-building first
 * runs — the init-throw catch path, or the very end of a successful boot —
 * instead of immediately after outbox/version-store wiring, which is where
 * every caller of this function invokes it).
 */

import { resolveVersionPruneSweeper } from './versionPruneScheduler.js';
import { scheduleOutboxOpenPruneSweep } from './outboxOpenPruneSweep.js';
import type { OutboxWiring } from '../outbox/wiring.js';
import type { EmbeddedPrunableVersionStore } from './versionPruneScheduler.js';

export interface StorageGrowthSweepsHandles {
    versionPruneSweeper: { stop(): Promise<void> };
    outboxOpenPruneSweep: { stop(): Promise<void> };
}

export function wireStorageGrowthSweeps(deps: {
    startsDaemonTimers: boolean;
    versionPruneSweeper: { stop(): Promise<void> };
    versionStore: EmbeddedPrunableVersionStore | null;
    /** Effective history policy; embedded pruning is scheduled only when enabled. */
    versionPolicy?: import('../outbox/versionPruningPolicy.js').EffectiveVersionHistoryPolicy;
    outboxWiring: Pick<OutboxWiring, 'replicator' | 'store'>;
}): StorageGrowthSweepsHandles {
    return {
        versionPruneSweeper: resolveVersionPruneSweeper(deps.startsDaemonTimers, deps.versionPruneSweeper, deps.versionStore, deps.versionPolicy),
        outboxOpenPruneSweep: scheduleOutboxOpenPruneSweep(deps.outboxWiring.replicator, deps.outboxWiring.store),
    };
}
