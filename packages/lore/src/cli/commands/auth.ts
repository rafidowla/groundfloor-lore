/**
 * auth.ts — `lore auth <subcmd>` CLI surface (Phase 6 P3).
 *
 * Operator-facing tool to issue, list, and revoke per-app workspace-
 * scoped tokens. The registry lives under loreHome — see
 * src/auth/tokens.ts for the on-disk format and lookup semantics.
 *
 * Subcommands:
 *
 *   issue --workspace <name> --label <text>
 *         [--scopes read,write,cross-workspace-read,cross-workspace-write]
 *
 *     Mints a new token bound to <workspace>. Default scopes are
 *     `read,write`. Cross-workspace scopes must be passed explicitly —
 *     bootstrap-equivalent tokens MUST NOT silently auto-elevate.
 *     The plaintext is printed once; the daemon never stores it
 *     again, only its SHA-256 hash.
 *
 *   list [--json]
 *
 *     Print every registered token (label, workspace, scopes, last-
 *     used, revoked timestamp). Plaintext is never recoverable —
 *     listing shows the public prefix only.
 *
 *   revoke <prefix>
 *
 *     Mark every active token whose prefix starts with the supplied
 *     string as revoked. Future auth checks fail immediately.
 */

import {
    issueToken,
    listTokens,
    revokeByPrefix,
    ALL_SCOPES,
    type TokenScope,
} from '../../auth/tokens.js';
import { loadWorkspaces } from '../../config/workspaces.js';

function usage(): string {
    return [
        'Usage: lore auth <subcommand>',
        '',
        'Subcommands:',
        '  issue --workspace <name> [--label <text>] [--scopes <csv>]',
        '        [--ephemeral] [--ttl <duration>] [--admin] [--json]',
        '                       Mint a new workspace-scoped token. Default scopes: read,write.',
        '                       --ephemeral: token expires (default TTL 1h); auto-swept.',
        '                       --ttl: override TTL (e.g. 30m, 1h, 2h, 90s). Implies --ephemeral.',
        '                       --admin: also grant cross-workspace-read+write (operator recovery).',
        '                       Token plaintext is written ONLY to stdout — never to the bootstrap',
        '                       token files (~/.groundfloor/auth.token or lore-local-data/auth.token).',
        '                       Available scopes: ' + ALL_SCOPES.join(', '),
        '  list [--json]        List every registered token (active + revoked).',
        '  revoke <prefix>      Revoke every token whose prefix matches.',
    ].join('\n');
}

/**
 * Parse a duration string of the form `<n><unit>` where unit ∈ {s,m,h,d}.
 * Returns milliseconds. Throws on malformed input or non-positive values.
 * Sprint 8 — used by `--ttl` on `lore auth issue`.
 */
export function parseDurationToMs(raw: string): number {
    const m = /^(\d+)(ms|s|m|h|d)$/.exec(raw.trim());
    if (!m) {
        throw new Error(`invalid duration "${raw}" — expected <n><unit> where unit is one of ms|s|m|h|d (e.g. 30m, 1h)`);
    }
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`invalid duration "${raw}" — must be a positive integer`);
    }
    const unit = m[2];
    const mult = unit === 'ms' ? 1
        : unit === 's' ? 1_000
        : unit === 'm' ? 60_000
        : unit === 'h' ? 3_600_000
        : 86_400_000; // 'd'
    return n * mult;
}

function readFlag(rest: string[], name: string): string | undefined {
    const idx = rest.indexOf(name);
    if (idx === -1 || idx === rest.length - 1) return undefined;
    return rest[idx + 1];
}

function parseScopes(csv: string | undefined): TokenScope[] {
    if (!csv) return ['read', 'write'];
    const parts = csv.split(',').map((s) => s.trim()).filter(Boolean);
    const out: TokenScope[] = [];
    for (const p of parts) {
        if (!ALL_SCOPES.includes(p as TokenScope)) {
            throw new Error(`Unknown scope "${p}". Available: ${ALL_SCOPES.join(', ')}`);
        }
        out.push(p as TokenScope);
    }
    return out;
}

export async function authCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (!sub || sub === '--help' || sub === '-h') {
        console.log(usage());
        return;
    }
    const rest = args.slice(1);
    const json = rest.includes('--json');

    if (sub === 'issue') {
        const workspace = readFlag(rest, '--workspace');
        let label = readFlag(rest, '--label');
        const scopesCsv = readFlag(rest, '--scopes');
        const ephemeralFlag = rest.includes('--ephemeral');
        const ttlRaw = readFlag(rest, '--ttl');
        const adminFlag = rest.includes('--admin');
        if (!workspace) {
            console.error('issue: --workspace is required.');
            console.error('Usage: lore auth issue --workspace <name> [--label <text>] [--scopes <csv>] [--ephemeral] [--ttl <duration>] [--admin]');
            process.exit(1);
            return;
        }
        // Sprint 8 — when --ephemeral or --ttl is set, label is optional;
        // a sensible default makes scripted issuance (perf runs, CI) a
        // one-liner without losing operator visibility in `lore auth list`.
        const isEphemeral = ephemeralFlag || ttlRaw !== undefined;
        if (!label) {
            if (isEphemeral) {
                label = `ephemeral:${workspace}`;
            } else {
                console.error('issue: --label is required for long-lived tokens (omit only with --ephemeral or --ttl).');
                process.exit(1);
                return;
            }
        }
        // Guard against a typo silently minting a token bound to a
        // non-existent workspace (the auth gate would accept it for
        // writes; future loads would fail at the LocalGraph layer).
        const wsFile = loadWorkspaces();
        if (!wsFile.workspaces.some((w) => w.name === workspace)) {
            console.error(`issue: workspace "${workspace}" not registered. Known: ${wsFile.workspaces.map((w) => w.name).join(', ')}`);
            process.exit(1);
        }
        let scopes: TokenScope[];
        try {
            scopes = parseScopes(scopesCsv);
        } catch (err) {
            console.error(`issue: ${(err as Error).message}`);
            process.exit(1);
            return;
        }
        // Sprint 8 — --admin auto-elevates to cross-workspace-write
        // (and -read), preserving any explicit --scopes set as well.
        // This is the operator-recovery path (an admin token issued
        // while triaging a stuck workspace).
        if (adminFlag) {
            for (const s of ['cross-workspace-read', 'cross-workspace-write'] as const) {
                if (!scopes.includes(s)) scopes.push(s);
            }
        }
        // Sprint 8 — TTL resolution. Default 1h when --ephemeral but no
        // --ttl. Long-lived tokens leave ttlMs undefined.
        let ttlMs: number | undefined;
        if (isEphemeral) {
            try {
                ttlMs = ttlRaw ? parseDurationToMs(ttlRaw) : 3_600_000;
            } catch (err) {
                console.error(`issue: ${(err as Error).message}`);
                process.exit(1);
                return;
            }
        }
        const result = issueToken({ workspace, label, scopes, ttlMs, admin: adminFlag });
        if (json) {
            console.log(JSON.stringify({
                token: result.token,
                prefix: result.record.prefix,
                workspace: result.record.workspace,
                scopes: result.record.scopes,
                label: result.record.label,
                issuedAt: result.record.issuedAt,
                expiresAt: result.record.expiresAt ?? null,
                admin: result.record.admin === true,
                ephemeral: isEphemeral,
            }, null, 2));
        } else {
            console.log('Token issued. Display this ONCE — the daemon does not store the plaintext:');
            console.log('');
            console.log(`  ${result.token}`);
            console.log('');
            console.log(`label:     ${result.record.label}`);
            console.log(`workspace: ${result.record.workspace}`);
            console.log(`scopes:    ${result.record.scopes.join(', ')}`);
            if (result.record.expiresAt) {
                console.log(`expiresAt: ${result.record.expiresAt}`);
            }
            if (result.record.admin) {
                console.log(`admin:     true (cross-workspace recovery)`);
            }
            console.log(`prefix:    ${result.record.prefix}  (for \`lore auth revoke <prefix>\`)`);
        }
        return;
    }

    if (sub === 'list') {
        const entries = listTokens();
        if (json) {
            console.log(JSON.stringify(entries, null, 2));
            return;
        }
        if (entries.length === 0) {
            console.log('No tokens issued. Mint one with `lore auth issue --workspace <name> --label <text>`.');
            return;
        }
        const w = {
            prefix: 12, label: 24, workspace: 16, scopes: 36, lastUsed: 24,
        };
        const fmt = (s: string, n: number) => s.padEnd(n).slice(0, n);
        console.log(
            `${fmt('PREFIX', w.prefix)}  ${fmt('LABEL', w.label)}  ${fmt('WORKSPACE', w.workspace)}  ${fmt('SCOPES', w.scopes)}  ${fmt('LAST USED', w.lastUsed)}  STATUS`,
        );
        const nowMs = Date.now();
        for (const e of entries) {
            let status: string;
            if (e.revokedAt) {
                status = `revoked ${e.revokedAt}`;
            } else if (e.expiresAt && Date.parse(e.expiresAt) <= nowMs) {
                status = `expired ${e.expiresAt}`;
            } else if (e.expiresAt) {
                status = `ephemeral until ${e.expiresAt}${e.admin ? ' [admin]' : ''}`;
            } else {
                status = e.admin ? 'active [admin]' : 'active';
            }
            console.log(
                `${fmt(e.prefix, w.prefix)}  ${fmt(e.label, w.label)}  ${fmt(e.workspace, w.workspace)}  ${fmt(e.scopes.join(','), w.scopes)}  ${fmt(e.lastUsedAt ?? '—', w.lastUsed)}  ${status}`,
            );
        }
        return;
    }

    if (sub === 'revoke') {
        const prefix = rest.find((a) => !a.startsWith('--'));
        if (!prefix) {
            console.error('revoke: missing prefix. Usage: lore auth revoke <prefix>');
            process.exit(1);
        }
        const n = revokeByPrefix(prefix);
        if (n === 0) {
            console.error(`revoke: no active token matches prefix "${prefix}".`);
            process.exit(1);
        }
        console.log(`Revoked ${n} token(s).`);
        return;
    }

    console.error(`Unknown auth subcommand: ${sub}`);
    console.error(usage());
    process.exit(1);
}
