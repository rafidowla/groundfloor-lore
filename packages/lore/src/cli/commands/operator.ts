/**
 * operator.ts — `lore operator <subcmd>` CLI surface.
 *
 * Manages the local-mode operator-identity binding (auth-mode decision
 * 2026-05-10): the Mac's owner is bound to a portal_user once at setup
 * so ReBAC checks pass without an interactive Clerk popup per request,
 * while still preserving offline-first behavior.
 *
 * Subcommands:
 *
 *   init [--manual --user-id=X --display-name=Y --scopes=a,b]
 *     Bind an operator identity. With CLERK_ISSUER unset (today), only
 *     --manual is supported — the operator types their portal_user id
 *     in directly. When CLERK_ISSUER is configured, future versions
 *     will run an interactive device-code flow against Clerk.
 *
 *   show [--json]
 *     Print the currently-bound identity, or "no operator bound" if
 *     setup hasn't run.
 *
 *   clear --confirm
 *     Remove the binding. Requires --confirm because re-binding
 *     across Clerk tenants is rare and usually accidental.
 */

import {
    clearOperatorIdentity,
    operatorIdentityPath,
    readOperatorIdentity,
    writeOperatorIdentity,
    type OperatorIdentity,
} from '../../security/operatorIdentity.js';

function usage(): string {
    return [
        'Usage: lore operator <subcommand>',
        '',
        'Subcommands:',
        '  init --manual --user-id=<id> [--display-name=<n>] [--scopes=a,b]',
        '            Bind an operator identity (manual; Clerk flow lands when CLERK_ISSUER is set).',
        '  show [--json]',
        '            Print the current binding (or "no operator bound").',
        '  clear --confirm',
        '            Remove the binding. Requires --confirm.',
    ].join('\n');
}

function getFlagValue(args: string[], name: string): string | undefined {
    const eq = args.find(a => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
        return args[idx + 1];
    }
    return undefined;
}

export async function operatorCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (!sub || sub === '--help' || sub === '-h') {
        console.log(usage());
        return;
    }
    const rest = args.slice(1);

    if (sub === 'show') {
        const json = rest.includes('--json');
        const ident = readOperatorIdentity();
        if (!ident) {
            if (json) {
                console.log(JSON.stringify({ bound: false }, null, 2));
            } else {
                console.log('no operator bound');
                console.log(`(would write to: ${operatorIdentityPath()})`);
            }
            return;
        }
        if (json) {
            console.log(JSON.stringify({ bound: true, ...ident }, null, 2));
            return;
        }
        console.log(`portalUserId:  ${ident.portalUserId}`);
        if (ident.displayName) console.log(`displayName:   ${ident.displayName}`);
        console.log(`scopes:        ${ident.scopes.join(', ') || '—'}`);
        console.log(`source:        ${ident.source}`);
        console.log(`boundAt:       ${ident.boundAt}`);
        console.log(`file:          ${operatorIdentityPath()}`);
        return;
    }

    if (sub === 'clear') {
        if (!rest.includes('--confirm')) {
            console.error('clear: pass --confirm to remove the binding (re-binding is uncommon, usually accidental).');
            process.exit(1);
        }
        const removed = clearOperatorIdentity();
        if (removed) {
            console.log('operator binding cleared');
        } else {
            console.log('no operator was bound');
        }
        return;
    }

    if (sub === 'init') {
        const manual = rest.includes('--manual');
        const userId = getFlagValue(rest, '--user-id');
        const displayName = getFlagValue(rest, '--display-name');
        const scopesRaw = getFlagValue(rest, '--scopes');
        const scopes = scopesRaw
            ? scopesRaw.split(',').map(s => s.trim()).filter(Boolean)
            : [];

        if (!manual) {
            const issuer = process.env['CLERK_ISSUER'];
            if (!issuer) {
                console.error('init: --manual is required today.');
                console.error('       (Interactive Clerk binding will be wired when CLERK_ISSUER is set');
                console.error('       and the canonical Clerk tenant is configured.)');
                process.exit(1);
            }
            // Audit 2026-05-13: clearer message — this is a cloud-only path
            // that hasn't shipped yet, not a "broken locally" error.
            console.error('init: Clerk-based operator init is a cloud-mode feature that ships in a later phase.');
            console.error('      For local installs use:  lore operator init --manual --user-id=<id>');
            process.exit(1);
        }

        if (!userId) {
            console.error('init --manual: --user-id=<id> is required.');
            process.exit(1);
        }

        const identity: OperatorIdentity = {
            portalUserId: userId,
            displayName,
            scopes,
            boundAt: new Date().toISOString(),
            source: 'manual',
        };
        writeOperatorIdentity(identity);
        console.log(`✓ operator bound: ${userId}`);
        if (displayName) console.log(`  displayName: ${displayName}`);
        if (scopes.length > 0) console.log(`  scopes: ${scopes.join(', ')}`);
        console.log(`  file: ${operatorIdentityPath()}`);
        return;
    }

    console.error(`Unknown operator subcommand: ${sub}`);
    console.error(usage());
    process.exit(1);
}
