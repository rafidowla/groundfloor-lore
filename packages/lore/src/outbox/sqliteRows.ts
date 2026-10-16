/**
 * sqliteRows.ts - the outbox_entries row shape and its mapping to OutboxEntry, split out of
 * sqliteStore.ts (file-size cap) so sqliteDeadLetters.ts can share it without an import cycle.
 */
import type { OutboxEntry, OutboxStatus } from './types.js';

export interface Row {
    id: string;
    workspace: string;
    sequenceId: number;
    operationKind: string;
    payload: string | null;
    status: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
    replicatedAt: string | null;
    failedAt: string | null;
    /** SP-21: ISO timestamp before which a failed row should not be retried. */
    nextAttemptAt: string | null;
    steps: string | null;
    operation: string;
    initiator: string;
    completed: number;
    /** 3.35.0 (a): first transient failure time / count / dead-letter reason class. */
    firstTransientAt: string | null;
    transientRetries: number | null;
    deadReason: string | null;
}

export function rowToEntry(r: Row): OutboxEntry {
    return {
        id: r.id,
        operation: r.operation,
        initiator: r.initiator,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        steps: r.steps ? JSON.parse(r.steps) : [],
        completed: !!r.completed,
        workspace: r.workspace,
        operationKind: r.operationKind as OutboxEntry['operationKind'],
        payload: r.payload ? JSON.parse(r.payload) : undefined,
        status: r.status as OutboxStatus,
        attempts: r.attempts,
        lastError: r.lastError ?? undefined,
        replicatedAt: r.replicatedAt ?? undefined,
        failedAt: r.failedAt ?? undefined,
        nextAttemptAt: r.nextAttemptAt ?? undefined,
        sequenceId: r.sequenceId,
        firstTransientAt: r.firstTransientAt ?? undefined,
        transientRetries: r.transientRetries ?? undefined,
        deadReason: r.deadReason ?? undefined,
    };
}
