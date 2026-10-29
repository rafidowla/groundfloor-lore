/**
 * `lore postgres <subcommand>` — operator tools for the Postgres engine.
 * Currently: `rollback-copies`, `drop-global-sk-indexes`, `contract-phase0`. Each subcommand lives in its own file.
 */
import { postgresRollbackCopiesCommand, rollbackCopiesUsage } from './postgresRollbackCopies.js';
import { postgresDropGlobalSkIndexesCommand } from './postgresDropGlobalSkIndexes.js';
import { postgresContractPhase0Command } from './postgresContractPhase0.js';

function usage(): void {
    console.error('usage: lore postgres <subcommand>');
    console.error('');
    console.error('  rollback-copies   List, verify and drop the rollback copies left by the verbatim partitioning');
    console.error('                    and edge layout 2 migrations (verbatim_pre_partition, edges_pre_pk)');
    console.error('  drop-global-sk-indexes   Contract step of the per-workspace node key: drop idx_nodes_sk, idx_edges_dst_sk,');
    console.error('                    the old lore_entity foreign key / index and the old per-field indexes (dry run by default)');
    console.error('  contract-phase0   Drop the legacy keys / indexes the Phase 0 workspace-led changes replaced (run once all hosts are upgraded)');
    console.error('');
    console.error("Run 'lore postgres <subcommand> --help' for its flags.");
}

export async function postgresCommand(args: string[]): Promise<void> {
    const [sub, ...rest] = args;
    switch (sub) {
        case 'rollback-copies':
            await postgresRollbackCopiesCommand(rest);
            return;
        case 'drop-global-sk-indexes':
            await postgresDropGlobalSkIndexesCommand(rest);
            return;
        case 'contract-phase0':
            await postgresContractPhase0Command(rest);
            return;
        case undefined:
        case '-h':
        case '--help':
        case 'help':
            usage();
            if (sub === undefined) process.exitCode = 1;
            return;
        default:
            console.error(`lore postgres: unknown subcommand '${sub}'`);
            usage();
            process.exitCode = 1;
    }
}

export { rollbackCopiesUsage };
