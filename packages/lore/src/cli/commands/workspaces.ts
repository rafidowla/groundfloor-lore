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

function usage(): string {
    return [
        'Usage: lore workspaces <subcommand>',
        '',
        'Subcommands:',
        '  list [--json]                                List all workspaces (active marked with *).',
        '  active                                       Print the active workspace name.',
        '  switch <name> [--quiet]                      Set the active workspace.',
        '  show <name> [--json]                         Print full record for one workspace.',
        '  set-vocab-policy <name> --mode <allowlist|denylist|open>',
        '                   [--types <csv>]',
        '                   [--on-mismatch <reject|hitl|warn>]',
        '                                               Set / clear the per-workspace vocab policy.',
        '                                               --mode open clears any prior types/onMismatch.',
        '  get-vocab-policy <name> [--json]             Print the resolved policy.',
    ].join('\n');
}

function readFlag(rest: string[], name: string): string | undefined {
    const idx = rest.indexOf(name);
    if (idx === -1 || idx === rest.length - 1) return undefined;
    return rest[idx + 1];
}

export async function workspacesCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (!sub || sub === '--help' || sub === '-h') {
        console.log(usage());
        return;
    }
    const rest = args.slice(1);
    const json = rest.includes('--json');

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
        const name = rest.find(a => !a.startsWith('--'));
        if (!name) {
            console.error('switch: missing workspace name. Usage: lore workspaces switch <name>');
            process.exit(1);
        }
        const updated = switchWorkspace(name);
        if (!rest.includes('--quiet')) {
            console.log(`Active workspace: ${updated.active}`);
            console.log('Restart the Lore service to reinitialize against the new workspace.');
        }
        return;
    }

    if (sub === 'show') {
        const name = rest.find(a => !a.startsWith('--'));
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

    if (sub === 'set-vocab-policy') {
        const name = rest.find((a) => !a.startsWith('--'));
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
        const name = rest.find((a) => !a.startsWith('--'));
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
