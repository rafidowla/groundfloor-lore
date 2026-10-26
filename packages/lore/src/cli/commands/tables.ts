/**
 * `lore tables <subcommand>` - operator tools for workspace tables. Currently: `copy`.
 */
import { tablesCopyCommand, tablesCopyUsage } from './tablesCopy.js';

function usage(): void {
    console.error('usage: lore tables <subcommand>');
    console.error('');
    console.error('  copy   Copy a workspace\'s tables from its old tables.sqlite into its Postgres table storage');
    console.error('');
    console.error("Run 'lore tables copy --help' for its flags.");
}

export async function tablesCommand(args: string[]): Promise<void> {
    const [sub, ...rest] = args;
    switch (sub) {
        case 'copy':
            await tablesCopyCommand(rest);
            return;
        case undefined:
        case '-h':
        case '--help':
        case 'help':
            usage();
            if (sub === undefined) process.exitCode = 1;
            return;
        default:
            console.error(`lore tables: unknown subcommand '${sub}'`);
            usage();
            process.exitCode = 1;
    }
}

export { tablesCopyUsage };
