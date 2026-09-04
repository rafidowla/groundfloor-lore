/**
 * cli/commands/embed.ts — Sprint E3 (2026-05-24).
 *
 * `lore embed <subcommand>` — embedding-pipeline operator surface.
 *
 * Today's only subcommand is `reembed`, which walks an existing
 * workspace and enqueues `embed.batch` outbox rows that the daemon's
 * replicator drains asynchronously. Replaces the per-item
 * `migrateEmbeddingModel` flow for the common "rebuild vectors
 * without touching node payloads" case (Sprint E principle clause 6).
 *
 * Usage:
 *   lore embed reembed --workspace <ws> [--type <node-type>]
 *                      [--tag <tag>] [--batch-size <N>] [--dry-run]
 *
 * The job runs in-process against a freshly-booted LocalGraph +
 * OutboxStore — it does NOT require the daemon to be running. If the
 * daemon IS running, the replicator picks the enqueued rows up on its
 * next tick. If the daemon is NOT running, the rows sit in SQLite
 * until next boot (Sprint O5 crash-resumable replication covers this).
 */

import path from 'node:path';

import { loreHome } from '../../config/loreHome.js';

interface ReEmbedFlags {
    workspace?: string;
    type?: string;
    tag?: string;
    filter?: string;
    batchSize?: number;
    dryRun: boolean;
    help: boolean;
}

function parseReEmbedFlags(args: string[]): ReEmbedFlags {
    const out: ReEmbedFlags = { dryRun: false, help: false };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') {
            out.help = true;
            continue;
        }
        if (a === '--dry-run') {
            out.dryRun = true;
            continue;
        }
        if (a === '--workspace' && i + 1 < args.length) {
            out.workspace = args[++i];
            continue;
        }
        if (a === '--type' && i + 1 < args.length) {
            out.type = args[++i];
            continue;
        }
        if (a === '--tag' && i + 1 < args.length) {
            out.tag = args[++i];
            continue;
        }
        if (a === '--filter' && i + 1 < args.length) {
            // Reserved for a future cypher-where pass-through. For
            // now we accept + ignore so callers can wire it without
            // breakage; --type + --tag cover today's use cases.
            out.filter = args[++i];
            continue;
        }
        if (a === '--batch-size' && i + 1 < args.length) {
            const n = parseInt(args[++i], 10);
            if (Number.isFinite(n) && n > 0) out.batchSize = n;
            continue;
        }
    }
    return out;
}

const REEMBED_HELP = `
lore embed reembed — enqueue an outbox-driven re-embed pass.

Usage:
  lore embed reembed --workspace <ws> [options]

Options:
  --workspace <ws>     Workspace to re-embed (required, Sprint L invariant)
  --type <node-type>   Restrict to one LoreNode type
  --tag <tag>          Substring-match nodes whose tags include this string
  --filter <expr>      Reserved — accepted + ignored in v3.4.0
  --batch-size <N>     Texts per enqueued outbox row (default 256)
  --dry-run            Count + plan without enqueueing
  -h, --help           Show this help

Examples:
  lore embed reembed --workspace default --dry-run
  lore embed reembed --workspace myproject --type decision --batch-size 512
`;

export async function embedCommand(args: string[]): Promise<void> {
    const sub = args[0];
    const rest = args.slice(1);

    if (!sub || sub === '--help' || sub === '-h') {
        console.log(`
lore embed — embedding-pipeline operator commands.

Subcommands:
  reembed     Enqueue an outbox-driven re-embed of an existing workspace.

Run 'lore embed reembed --help' for details.
`.trim());
        return;
    }

    switch (sub) {
        case 'reembed':
            await reembedSubcommand(rest);
            break;
        default:
            console.error(`Unknown 'lore embed' subcommand: '${sub}'`);
            console.error(`Run 'lore embed --help' for the list.`);
            process.exit(1);
    }
}

async function reembedSubcommand(args: string[]): Promise<void> {
    const flags = parseReEmbedFlags(args);
    if (flags.help) {
        console.log(REEMBED_HELP.trim());
        return;
    }
    if (!flags.workspace) {
        console.error('lore embed reembed: --workspace is required (Sprint L invariant)');
        console.error('Run with --help for usage.');
        process.exit(1);
    }

    // Lazy imports — avoids booting the graph stack on `--help` and
    // matches the pattern in commands/reconnect.ts.
    const { wireOutbox } = await import('../../outbox/wiring.js');
    const { runReEmbedJob, DEFAULT_REEMBED_CHUNK_SIZE } = await import('../../embed/reEmbedJob.js');
    const { openGraphForCli } = await import('./shared.js');

    const basePath = loreHome();
    const loreDir = path.join(basePath, '.lore');
    const chunkSize = flags.batchSize ?? DEFAULT_REEMBED_CHUNK_SIZE;

    // Finding 11 (round E) — refuse fast with a clear message when a
    // running daemon holds this store's lock, instead of the old ~15s
    // openSurreal retry storm ending in a raw driver error.
    const graph = await openGraphForCli(basePath);

    // wireOutbox returns the store + replicator; we want the store
    // alone (the daemon — if running — owns the replicator). We do
    // not start the replicator from the CLI: enqueue is the whole
    // contract.
    const wiring = wireOutbox({
        loreDir,
        getSyncEngine: () => {
            throw new Error('reembed: syncEngine not needed for enqueue-only path');
        },
        getGraph: () => graph,
    });

    console.log('');
    console.log(`  lore embed reembed — workspace=${flags.workspace}`
        + `  type=${flags.type ?? '*'}  tag=${flags.tag ?? '*'}`
        + `  batchSize=${chunkSize}  dryRun=${flags.dryRun}`);

    const result = await runReEmbedJob({
        workspace: flags.workspace,
        graph,
        outboxStore: wiring.store,
        type: flags.type,
        tag: flags.tag,
        chunkSize,
        dryRun: flags.dryRun,
        initiator: 'cli:lore embed reembed',
        onProgress: (enq, total) => {
            // Tiny inline progress. ANSI carriage-return so we don't
            // spam the terminal — terminates with one newline below.
            const pct = total === 0 ? 100 : Math.floor((enq / total) * 100);
            process.stdout.write(`\r    enqueued ${enq}/${total} rows (${pct}%)`);
        },
    });

    if (result.rowsEnqueued > 0) {
        process.stdout.write('\n');
    }

    console.log('');
    console.log(`  candidates:     ${result.candidates}`);
    console.log(`  rows planned:   ${result.rowsPlanned}  (one outbox row per ${chunkSize} texts)`);
    console.log(`  rows enqueued:  ${result.rowsEnqueued}`);
    console.log(`  duration:       ${result.durationMs} ms (enqueue only — drain runs in the daemon)`);

    if (flags.dryRun) {
        console.log('');
        console.log('  (dry run — nothing was enqueued. Re-run without --dry-run to commit.)');
    } else if (result.rowsEnqueued > 0) {
        console.log('');
        console.log('  Rows are durable in the outbox. The daemon\'s replicator will drain');
        console.log('  them on its next tick. Monitor progress with:');
        // FINDING 4 (2026-09-03) — /api/health's `outbox` block is now only
        // in the Bearer-authenticated body; an anonymous curl here would
        // silently jq to `null`. Show the token-bearing form.
        console.log('    curl -s -H "Authorization: Bearer $(cat ~/.groundfloor/auth.token)" \\');
        console.log('      http://localhost:3847/api/health | jq .outbox');
    }

    await graph.close();
}
