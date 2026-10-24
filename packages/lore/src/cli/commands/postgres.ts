/**
 * `lore postgres <subcommand>` — operator tools for the Postgres engine.
 * Currently: `rollback-copies`. Each subcommand lives in its own file.
 */
import { postgresRollbackCopiesCommand, rollbackCopiesUsage } from './postgresRollbackCopies.js';

function usage(): void {
    console.error('usage: lore postgres <subcommand>');
    console.error('');
    console.error('  rollback-copies   List, verify and drop the rollback copies left by the verbatim partitioning');
    console.error('                    and edge layout 2 migrations (verbatim_pre_partition, edges_pre_pk)');
    console.error('');
    console.error("Run 'lore postgres rollback-copies --help' for its flags.");
}

export async function postgresCommand(args: string[]): Promise<void> {
    const [sub, ...rest] = args;
    switch (sub) {
        case 'rollback-copies':
            await postgresRollbackCopiesCommand(rest);
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
