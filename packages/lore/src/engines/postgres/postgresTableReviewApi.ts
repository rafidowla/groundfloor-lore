/**
 * postgresTableReviewApi.ts - the review queue and the alias table bound to one workspace's pool. This is what
 * `PostgresTableStorage.reviewApi()` hands out (and what query/tableReview.ts wraps), so callers never see a pool.
 */

import type { Pool } from 'pg';
import * as review from './postgresTableReview.js';
import * as alias from './postgresTableAlias.js';

export interface TableReviewApi {
    // review queue
    getSettings(): Promise<review.ReviewSettings>;
    setReviewConfidenceThreshold(threshold: number, updatedBy?: string): Promise<review.ReviewSettings>;
    listQueue(q?: review.ReviewQueueQuery): Promise<review.ReviewQueuePage>;
    countQueue(q?: review.ReviewQueueQuery): Promise<number>;
    confirm(input: review.ConfirmInput): Promise<review.ReviewOutcome>;
    correct(input: review.CorrectInput): Promise<review.ReviewOutcome>;
    // alias table
    addAlias(input: alias.AddAliasInput): Promise<{ record: alias.AliasRecord; created: boolean }>;
    listAliases(q?: alias.AliasListQuery): Promise<alias.AliasPage>;
    removeAlias(aliasId: string, removedBy?: string): Promise<{ record: alias.AliasRecord; removed: boolean }>;
    listUnresolved(q: alias.UnresolvedQuery): Promise<alias.UnresolvedPage>;
}

export function bindTableReviewApi(pool: Pool, workspace: string): TableReviewApi {
    const ctx = { pool, workspace };
    return {
        getSettings: () => review.getReviewSettings(ctx),
        setReviewConfidenceThreshold: (t, by) => review.setReviewConfidenceThreshold(ctx, t, by),
        listQueue: (q) => review.listReviewQueue(ctx, q),
        countQueue: (q) => review.countReviewQueue(ctx, q),
        confirm: (i) => review.confirmValue(ctx, i),
        correct: (i) => review.correctValue(ctx, i),
        addAlias: (i) => alias.addAlias(ctx, i),
        listAliases: (q) => alias.listAliases(ctx, q),
        removeAlias: (id, by) => alias.removeAlias(ctx, id, by),
        listUnresolved: (q) => alias.listUnresolved(ctx, q),
    };
}
