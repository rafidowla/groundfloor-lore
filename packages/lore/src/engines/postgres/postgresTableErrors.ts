/**
 * postgresTableErrors.ts - typed errors for the structured-table (EAV) store.
 */

/** A money aggregate was asked to combine more than one currency. There is no rate table, so it refuses. */
export class MixedCurrencyError extends Error {
    readonly code = 'mixed_currency' as const;
    constructor(readonly column: string, readonly currencies: string[]) {
        super(`PostgresTableStorage: refusing to aggregate money column '${column}' across currencies (${currencies.join(', ')}) - ` +
            'there is no exchange-rate table; filter to one currency first');
        this.name = 'MixedCurrencyError';
    }
}

export type TableLinkErrorCode =
    | 'unknown_link_type' | 'unknown_entity' | 'link_type_conflict' | 'duplicate_link'
    | 'cardinality' | 'invalid_interval' | 'invalid_argument';

/** Typed failure from the record-link API; `code` is stable, the message is for humans. */
export class TableLinkError extends Error {
    constructor(readonly code: TableLinkErrorCode, message: string) {
        super(`PostgresTableStorage: ${message}`);
        this.name = 'TableLinkError';
    }
}

export type TableReviewErrorCode = 'not_found' | 'conflict' | 'invalid_argument' | 'not_supported' | 'too_large';

/**
 * Typed failure from the review-queue and alias API; `code` is stable, the message is for humans.
 * `conflict` = the value moved on since the caller looked (another reviewer, or a newer write): reload and retry.
 */
export class TableReviewError extends Error {
    constructor(readonly code: TableReviewErrorCode, message: string, readonly detail?: Record<string, unknown>) {
        super(`PostgresTableStorage: ${message}`);
        this.name = 'TableReviewError';
    }
}
