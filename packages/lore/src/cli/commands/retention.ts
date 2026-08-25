/**
 * retention.ts — `lore retention <subcmd>` CLI (Sprint W W6a).
 *
 * Operator surface for per-type retention policies. Reads/writes the
 * workspaces.json `retention.typePolicies` map directly; the actual
 * enforcement pass (warm move + delete) lives in engines/typeRetention
 * + engines/warmStore and is invoked by the daily sweeper (existing
 * RetentionSweeper) or by an operator running this CLI's `apply`
 * subcommand in a future W6b slice. This slice ships set/list/preview
 * only — no destructive subcommand.
 *
 * Subcommands:
 *
 *   list [<workspace>]
 *     Show the typePolicies map for one workspace (or active when
 *     omitted). Shows mode + days per node type.
 *
 *   set <workspace> <type> --mode <keep|warm-after|delete-after> [--days <n>]
 *     Add or update one rule. Validates with typeRetention.validateRule
 *     before writing. `--mode keep` removes the rule (since keep is the
 *     default and persisting it adds noise).
 *
 *   preview <workspace>
 *     Dry-run: enumerate every node, classify against the typePolicies
 *     map, print {toWarm, toDelete, pending, kept} counts plus a small
 *     sample of each bucket. No mutation. Uses LocalGraph.listNodes
 *     so it sees the live state including the W5 epoch-invalidated
 *     pool — operators always see "what would happen now".
 *
 * Out of scope this slice (W6b):
 *   - `lore retention apply` (would actually warm + delete) — wait
 *     until the daily sweeper integration ships.
 *   - cold-after / archive CLI.
 *   - includeTiers integration with recall.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loreHome } from '../../config/loreHome.js';
import { loadWorkspaces } from '../../config/workspaces.js';
import {
    computeRetentionPlan,
    validateRule,
    type RetentionCandidate,
    type TypePoliciesMap,
    type TypeRetentionRule,
} from '../../engines/typeRetention.js';

function usage(): string {
    return [
        'Usage: lore retention <subcommand>',
        '',
        'Subcommands:',
        '  list [<workspace>]                                  Show per-type rules.',
        '  set <workspace> <type> --mode <m> [--days <n>]      Add/update a rule.',
        '                                                      Modes: keep, warm-after, delete-after.',
        '                                                      Days required for warm-after / delete-after.',
        '  preview <workspace>                                 Dry-run: counts of what would warm/delete now.',
    ].join('\n');
}

function readFlag(rest: string[], name: string): string | undefined {
    const idx = rest.indexOf(name);
    if (idx === -1 || idx === rest.length - 1) return undefined;
    return rest[idx + 1];
}

function workspacesJsonPath(): string {
    return path.join(loreHome(), 'workspaces.json');
}

/**
 * Resolve workspace name: arg if non-flag; else active. Returns the
 * matched WorkspaceEntry or exits with a clear error.
 */
function resolveWorkspaceName(arg: string | undefined): string {
    const wsFile = loadWorkspaces();
    const name = arg ?? wsFile.active;
    if (!wsFile.workspaces.some((w) => w.name === name)) {
        console.error(`retention: workspace "${name}" not registered. Known: ${wsFile.workspaces.map((w) => w.name).join(', ')}`);
        process.exit(1);
    }
    return name;
}

function loadTypePolicies(workspace: string): TypePoliciesMap {
    const wsFile = loadWorkspaces();
    const entry = wsFile.workspaces.find((w) => w.name === workspace);
    return entry?.retention?.typePolicies ?? {};
}

function writeTypePolicies(workspace: string, policies: TypePoliciesMap): void {
    const fp = workspacesJsonPath();
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = JSON.parse(raw) as ReturnType<typeof loadWorkspaces>;
    const entry = parsed.workspaces.find((w) => w.name === workspace);
    if (!entry) {
        console.error(`retention: workspace "${workspace}" not in ${fp}`);
        process.exit(1);
    }
    const retention = (entry.retention ?? {}) as NonNullable<typeof entry.retention>;
    if (Object.keys(policies).length === 0) delete (retention as Record<string, unknown>).typePolicies;
    else (retention as Record<string, unknown>).typePolicies = policies;
    entry.retention = retention;
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
}

export async function retentionCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (!sub || sub === '--help' || sub === '-h') {
        console.log(usage());
        return;
    }
    const rest = args.slice(1);
    const json = rest.includes('--json');

    if (sub === 'list') {
        const wsName = resolveWorkspaceName(rest.find((a) => !a.startsWith('--')));
        const policies = loadTypePolicies(wsName);
        if (json) {
            console.log(JSON.stringify({ workspace: wsName, typePolicies: policies }, null, 2));
            return;
        }
        const entries = Object.entries(policies);
        if (entries.length === 0) {
            console.log(`workspace=${wsName} — no per-type retention rules set. All types are 'keep' (default).`);
            return;
        }
        console.log(`workspace=${wsName} retention.typePolicies:`);
        for (const [type, rule] of entries) {
            const days = rule.days !== undefined ? ` ${rule.days}d` : '';
            console.log(`  ${type.padEnd(24)}  ${rule.mode}${days}`);
        }
        return;
    }

    if (sub === 'set') {
        const positional = rest.filter((a) => !a.startsWith('--'));
        const wsName = positional[0];
        const type = positional[1];
        const mode = readFlag(rest, '--mode');
        const daysRaw = readFlag(rest, '--days');
        if (!wsName || !type || !mode) {
            console.error('set: <workspace> <type> --mode <keep|warm-after|delete-after> [--days <n>]');
            process.exit(1);
        }
        resolveWorkspaceName(wsName); // validates existence
        const rule: TypeRetentionRule = { mode: mode as TypeRetentionRule['mode'] };
        if (daysRaw !== undefined) {
            const parsed = Number(daysRaw);
            if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
                console.error(`set: --days must be a positive integer; got ${daysRaw}`);
                process.exit(1);
            }
            rule.days = parsed;
        }
        const err = validateRule(rule);
        if (err) {
            console.error(`set: ${err}`);
            process.exit(1);
        }
        const policies = { ...loadTypePolicies(wsName) };
        if (rule.mode === 'keep') {
            // keep is the default — represent it by removal so policies
            // file stays minimal.
            delete policies[type];
        } else {
            policies[type] = rule;
        }
        writeTypePolicies(wsName, policies);
        console.log(`set: workspace=${wsName} type=${type} → ${rule.mode}${rule.days !== undefined ? ` ${rule.days}d` : ''}`);
        return;
    }

    if (sub === 'preview') {
        const wsName = resolveWorkspaceName(rest.find((a) => !a.startsWith('--')));
        const policies = loadTypePolicies(wsName);
        // Resolve workspace path via loadWorkspaces (each entry carries
        // its own `path`). Lazy-import the graph factory so a `--help`
        // invocation does not boot an engine.
        const wsFile = loadWorkspaces();
        const entry = wsFile.workspaces.find((w) => w.name === wsName);
        if (!entry) {
            console.error(`retention preview: workspace "${wsName}" not in workspaces.json`);
            process.exit(1);
            return;
        }
        const { openWorkspaceGraph } = await import('../../engines/openWorkspaceGraph.js');
        // RA2-reaudit2 — both engines take the WORKSPACE BASE path (each
        // appends its own store subdirectory); passing the store subdir
        // pointed at the wrong location (empty/never-initialized → preview
        // always 0 nodes). Also initialize() before reading.
        const graph = openWorkspaceGraph(entry.path, { workspaceId: wsName });
        try {
            await graph.initialize();
            const allNodes = await graph.listNodes(undefined, undefined, '*', '*', 10000);
            const candidates: RetentionCandidate[] = allNodes.map((n) => ({
                id: n.id,
                type: n.type,
                updatedAt: n.updatedAt,
            }));
            const plan = computeRetentionPlan(candidates, policies);
            if (json) {
                console.log(JSON.stringify({
                    workspace: wsName,
                    typePolicies: policies,
                    counts: {
                        toWarm: plan.toWarm.length,
                        toDelete: plan.toDelete.length,
                        pending: plan.pending.length,
                        kept: plan.kept,
                    },
                    sample: {
                        toWarm: plan.toWarm.slice(0, 5),
                        toDelete: plan.toDelete.slice(0, 5),
                        pending: plan.pending.slice(0, 5),
                    },
                }, null, 2));
                return;
            }
            console.log(`workspace=${wsName} preview (no mutation):`);
            console.log(`  toWarm   = ${plan.toWarm.length}  (would move bytes to <ws>/.lore/warm/<id>.jsonl.gz)`);
            console.log(`  toDelete = ${plan.toDelete.length}  (would HARD delete from all stores)`);
            console.log(`  pending  = ${plan.pending.length}  (matched a policy, still inside age window)`);
            console.log(`  kept     = ${plan.kept}  (no policy or mode=keep)`);
            if (plan.toWarm.length > 0) {
                console.log(`  toWarm sample: ${plan.toWarm.slice(0, 3).map((n) => n.id).join(', ')}`);
            }
            if (plan.toDelete.length > 0) {
                console.log(`  toDelete sample: ${plan.toDelete.slice(0, 3).map((n) => n.id).join(', ')}`);
            }
        } finally {
            await graph.close();
        }
        return;
    }

    console.error(`Unknown retention subcommand: ${sub}`);
    console.error(usage());
    process.exit(1);
}
