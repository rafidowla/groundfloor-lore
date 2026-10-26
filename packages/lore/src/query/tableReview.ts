/**
 * tableReview.ts - the review queue and alias table for structured tables, over whichever table storage a workspace
 * has. Postgres workspaces get the real thing; SQLite table storage has neither, and says so with a typed error
 * (`TableReviewError` code `not_supported`) rather than silently returning nothing.
 */

import type { ITableStorage } from '../contracts/tables.js';
import type { TableReviewApi } from '../engines/postgres/postgresTableReviewApi.js';
import { TableReviewError } from '../engines/postgres/postgresTableErrors.js';

export type { TableReviewApi } from '../engines/postgres/postgresTableReviewApi.js';
export { TableReviewError } from '../engines/postgres/postgresTableErrors.js';
export type {
    ReviewSettings, ReviewQueueQuery, ReviewQueueItem, ReviewQueuePage, ConfirmInput, CorrectInput, ReviewOutcome,
} from '../engines/postgres/postgresTableReview.js';
export type { AddAliasInput, AliasRecord, AliasListQuery, AliasPage, UnresolvedQuery, UnresolvedValue, UnresolvedPage } from '../engines/postgres/postgresTableAlias.js';
export { DEFAULT_REVIEW_THRESHOLD } from '../engines/postgres/postgresTableReview.js';
export { normaliseAliasValue, ALIAS_NORMALISATION_VERSION } from './aliasNormalise.js';

export const REVIEW_NOT_SUPPORTED = 'review queue and alias tables are not supported on SQLite yet (Postgres table storage only)';

/** The review/alias API for `storage`, or a TableReviewError('not_supported') when it is not Postgres table storage. */
export async function tableReviewFor(storage: ITableStorage): Promise<TableReviewApi> {
    const { PostgresTableStorage } = await import('../engines/postgres/postgresTableStorage.js');
    if (storage instanceof PostgresTableStorage) return storage.reviewApi();
    throw new TableReviewError('not_supported', REVIEW_NOT_SUPPORTED);
}
