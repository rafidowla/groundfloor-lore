/**
 * workspaces.ts — `lore workspaces <subcmd>` CLI surface.
 *
 * Closes the gap where `config/workspaces.ts` exports
 * loadWorkspaces / switchWorkspace / createWorkspace but nothing in
 * the CLI exposes them. Until now the only ways to switch workspaces
 * were the admin-app HTTP route and editing workspaces.json by hand.
 *
 * Subcommands:
 *
 *   list        — print every workspace; mark the active one with *
 *                 --json: machine-readable shape
 *
 *   active      — print the active workspace name (one line, scriptable)
 *
 *   switch <n>  — set the active workspace to <n>. Caller is responsible
 *                 for restarting the daemon so the graph re-initializes
 *                 against the new path; the function prints a reminder.
 *                 --quiet: suppress the reminder
 *
 *   show <n>    — print full record (path, createdAt, retention) for
 *                 a single workspace. Errors if the name is unknown.
 *
 * Does NOT expose `delete` or `rename` — those have higher blast radius
 * and warrant a separate, more deliberate add.
 */

import {
    loadWorkspaces,
    switchWorkspace,
    getActiveWorkspaceName,
    getWorkspaceVocabPolicy,
    setWorkspaceVocabPolicy,
    type WorkspaceVocabMode,
    type WorkspaceVocabOnMismatch,
} from '../../config/workspaces.js';
import {
    getWorkspaceRecallRerank,
    setWorkspaceRecallRerank,
    RERANK_K_MIN,
    RERANK_K_MAX,
} from '../../recall/rerankConfig.js';
import { parseOrExit, type ArgSpec } from '../args.js';

function usage(): string {
    return [
        'Usage: lore workspaces <subcommand>',
        '',
        'Subcommands:',
        '  list [--json]                                List all workspaces (active marked with *).',
        '  active                                       Print the active workspace name.',
        '  switch <name> [--quiet]                      Set the active workspace.',
        '  show <name> [--json]                         Print full record for one workspace.',
        '  set-rerank <name> <on|off|default>',
        '              [--model <id>] [--k <n>] [--margin <n>]',
        '                                               Set / clear the per-workspace local-rerank policy.',
        '                                               on/off set recallRerank.enabled; default clears the',
        `                                               whole policy (back to env/default precedence). --k`,
        `                                               must be ${RERANK_K_MIN}-${RERANK_K_MAX}.`,
        '  get-rerank <name> [--json]                   Print the resolved rerank policy.',
        '  set-vocab-policy <name> --mode <allowlist|denylist|open>',
        '                   [--types <csv>]',
        '                   [--on-mismatch <reject|hitl|warn>]',
        '                                               Set / clear the per-workspace vocab policy.',
        '                                               --mode open clears any prior types/onMismatch.',
        '  get-vocab-policy <name> [--json]             Print the resolved policy.',
    ].join('\n');
}

/** Strict per-subcommand argument specs (unknown flags / extra positionals are usage errors). */
const SUB_SPECS: Readonly<Record<string, ArgSpec>> = {
    list: { bool: ['--json'] },
    active: {},
    switch: { bool: ['--quiet'], positionals: { min: 1, max: 1 } },
    show: { bool: ['--json'], positionals: { min: 1, max: 1 } },
    'set-rerank': { value: ['--model', '--k', '--margin'], positionals: { min: 2, max: 2 } },
    'get-rerank': { bool: ['--json'], positionals: { min: 1, max: 1 } },
    'set-vocab-policy': { value: ['--mode', '--types', '--on-mismatch'], positionals: { min: 1, max: 1 } },
    'get-vocab-policy': { bool: ['--json'], positionals: { min: 1, max: 1 } },
};

export async function workspacesCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (!sub || sub === '--help' || sub === '-h') {
        console.log(usage());
        return;
    }
    const rest = args.slice(1);
    const subSpec = SUB_SPECS[sub];
    // Unknown subcommands fall through to the "Unknown workspaces subcommand" message below.
    const parsed = subSpec
        ? parseOrExit(`workspaces ${sub}`, rest, subSpec, { usage: () => console.error(usage()) })
        : undefined;
    const readFlag = (_rest: string[], name: string): string | undefined => parsed?.get(name);
    const json = parsed?.has('--json') ?? false;

    if (sub === 'list') {
        const file = loadWorkspaces();
        if (json) {
            console.log(JSON.stringify({ active: file.active, workspaces: file.workspaces }, null, 2));
            return;
        }
        for (const w of file.workspaces) {
            const marker = w.name === file.active ? '*' : ' ';
            console.log(`${marker} ${w.name.padEnd(20)} ${w.path}`);
        }
        return;
    }

    if (sub === 'active') {
        console.log(getActiveWorkspaceName());
        return;
    }

    if (sub === 'switch') {
        const name = parsed?.positionals[0];
        if (!name) {
            console.error('switch: missing workspace name. Usage: lore workspaces switch <name>');
            process.exit(1);
        }
        const updated = switchWorkspace(name);
        if (!parsed?.has('--quiet')) {
            console.log(`Active workspace: ${updated.active}`);
            console.log('Restart the Lore service to reinitialize against the new workspace.');
        }
        return;
    }

    if (sub === 'show') {
        const name = parsed?.positionals[0];
        if (!name) {
            console.error('show: missing workspace name.');
            process.exit(1);
        }
        const file = loadWorkspaces();
        const entry = file.workspaces.find(w => w.name === name);
        if (!entry) {
            console.error(`Unknown workspace: ${name}`);
            process.exit(1);
        }
        if (json) {
            console.log(JSON.stringify(entry, null, 2));
        } else {
            console.log(`name:       ${entry.name}`);
            console.log(`path:       ${entry.path}`);
            console.log(`createdAt:  ${entry.createdAt}`);
            console.log(`active:     ${entry.name === file.active}`);
            if (entry.retention) console.log(`retention:  ${JSON.stringify(entry.retention)}`);
        }
        return;
    }

    if (sub === 'set-rerank') {
        // Positional args are `<name> <state>`, in that order.
        const positionals = parsed?.positionals ?? [];
        const name = positionals[0];
        const state = positionals[1];
        if (!name || !state) {
            console.error('set-rerank: missing workspace name or state.');
            console.error('Usage: lore workspaces set-rerank <name> <on|off|default> [--model <id>] [--k <n>] [--margin <n>]');
            process.exit(1);
        }
        if (state !== 'on' && state !== 'off' && state !== 'default') {
            console.error('set-rerank: state must be on|off|default.');
            process.exit(1);
        }

        if (state === 'default') {
            setWorkspaceRecallRerank(name, null);
            console.log(`Cleared recallRerank policy on "${name}" (back to env/default precedence).`);
            return;
        }

        const modelFlag = readFlag(rest, '--model');
        const kRaw = readFlag(rest, '--k');
        const marginRaw = readFlag(rest, '--margin');
        let k: number | undefined;
        if (kRaw !== undefined) {
            k = Number(kRaw);
            if (!Number.isFinite(k) || k < RERANK_K_MIN || k > RERANK_K_MAX) {
                console.error(`set-rerank: --k must be a number between ${RERANK_K_MIN} and ${RERANK_K_MAX}.`);
                process.exit(1);
            }
        }
        let margin: number | undefined;
        if (marginRaw !== undefined) {
            margin = Number(marginRaw);
            if (!Number.isFinite(margin)) {
                console.error('set-rerank: --margin must be a finite number.');
                process.exit(1);
            }
        }

        const next = setWorkspaceRecallRerank(name, {
            enabled: state === 'on',
            ...(modelFlag ? { model: modelFlag } : {}),
            ...(k !== undefined ? { k } : {}),
            ...(margin !== undefined ? { margin } : {}),
        });
        console.log(`Updated recallRerank on "${name}": ${JSON.stringify(next)}`);
        return;
    }

    if (sub === 'get-rerank') {
        const name = parsed?.positionals[0];
        if (!name) {
            console.error('get-rerank: missing workspace name.');
            process.exit(1);
        }
        const policy = getWorkspaceRecallRerank(name);
        if (json) {
            console.log(JSON.stringify(policy, null, 2));
        } else {
            console.log(`workspace:  ${name}`);
            console.log(`enabled:    ${policy.enabled}`);
            if (policy.model !== undefined) console.log(`model:      ${policy.model}`);
            if (policy.k !== undefined) console.log(`k:          ${policy.k}`);
            if (policy.margin !== undefined) console.log(`margin:     ${policy.margin}`);
        }
        return;
    }

    if (sub === 'set-vocab-policy') {
        const name = parsed?.positionals[0];
        if (!name) {
            console.error('set-vocab-policy: missing workspace name.');
            console.error('Usage: lore workspaces set-vocab-policy <name> --mode <allowlist|denylist|open> [--types <csv>] [--on-mismatch <reject|hitl|warn>]');
            process.exit(1);
        }
        const modeRaw = readFlag(rest, '--mode');
        if (!modeRaw || (modeRaw !== 'allowlist' && modeRaw !== 'denylist' && modeRaw !== 'open')) {
            console.error('set-vocab-policy: --mode is required (allowlist|denylist|open).');
            process.exit(1);
        }
        const mode = modeRaw as WorkspaceVocabMode;
        const typesRaw = readFlag(rest, '--types');
        const types = typesRaw ? typesRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const onMismatchRaw = readFlag(rest, '--on-mismatch') ?? 'reject';
        if (onMismatchRaw !== 'reject' && onMismatchRaw !== 'hitl' && onMismatchRaw !== 'warn') {
            console.error('set-vocab-policy: --on-mismatch must be reject|hitl|warn.');
            process.exit(1);
        }
        const onMismatch = onMismatchRaw as WorkspaceVocabOnMismatch;
        const next = setWorkspaceVocabPolicy(name, {
            mode,
            ...(types && types.length > 0 ? { types } : {}),
            onMismatch,
        });
        if (next === null) {
            console.log(`Cleared vocabPolicy on "${name}".`);
        } else {
            console.log(`Updated vocabPolicy on "${name}": ${JSON.stringify(next)}`);
        }
        return;
    }

    if (sub === 'get-vocab-policy') {
        const name = parsed?.positionals[0];
        if (!name) {
            console.error('get-vocab-policy: missing workspace name.');
            process.exit(1);
        }
        const policy = getWorkspaceVocabPolicy(name);
        if (json) {
            console.log(JSON.stringify(policy, null, 2));
        } else {
            console.log(`workspace:    ${name}`);
            console.log(`mode:         ${policy.mode}`);
            if (policy.types && policy.types.length > 0) {
                console.log(`types:        ${policy.types.join(', ')}`);
            }
            console.log(`onMismatch:   ${policy.onMismatch}`);
        }
        return;
    }

    console.error(`Unknown workspaces subcommand: ${sub}`);
    console.error(usage());
    process.exit(1);
}
