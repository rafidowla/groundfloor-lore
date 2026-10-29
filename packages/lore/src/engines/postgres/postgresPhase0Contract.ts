/**
 * postgresPhase0Contract.ts - the CONTRACT half of the Phase 0 (shard-ready) expand/migrate/contract changes.
 *
 * Phase 0 only ADDS: workspace-led unique keys on the ingestion tables, workspace-led keyword (trigram / tag) indexes on
 * `nodes`, and it stops creating the unused `verbatim_changes_log`. The old single-column keys, the old indexes and an
 * existing empty changes-log table stay in place so a host can be rolled back. This module removes them. It is NEVER run at
 * startup: an operator invokes it (`lore postgres contract-phase0 --yes`) once every host runs a build that uses the new
 * structures. Each step refuses (drops nothing) when its replacement is not in place, so running it early is safe.
 *
 * Needs an autocommit client (DROP INDEX CONCURRENTLY cannot run in a transaction block).
 */
import type { PoolClient } from 'pg';
import { dropLegacyIngestionKeys } from './postgresIngestionSchema.js';
import { dropLegacyKeywordIndexes } from './postgresKeywordIndex.js';
import { dropVerbatimChangesLog } from './postgresVerbatimSchema.js';

export interface Phase0ContractReport {
    ingestionKeys: { dropped: string[]; promoted: string[]; refused: string[] };
    keywordIndexes: { dropped: string[]; refused: string[] };
    changesLog: { dropped: boolean; refused?: string };
}

export async function contractPhase0(client: Pick<PoolClient, 'query'>): Promise<Phase0ContractReport> {
    await client.query('SET statement_timeout = 0');
    await client.query(`SET lock_timeout = '15s'`);
    try {
        return {
            ingestionKeys: await dropLegacyIngestionKeys(client),
            keywordIndexes: await dropLegacyKeywordIndexes(client),
            changesLog: await dropVerbatimChangesLog(client),
        };
    } finally {
        await client.query('RESET lock_timeout');
        await client.query('RESET statement_timeout');
    }
}
