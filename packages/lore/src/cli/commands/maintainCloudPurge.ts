/**
 * maintainCloudPurge.ts — `lore maintain cloud-purge`: hard-delete the Dataplane rows of a workspace that was
 * deleted from this Lore instance (cloud mode only). CLI only: no MCP tool, no REST route.
 *
 *   lore maintain cloud-purge --list
 *   lore maintain cloud-purge --id <workspace-id> [--min-age 7d] [--collection <name>]... [--connection <name>] [--json]
 *   lore maintain cloud-purge --id <workspace-id> --apply [--max-rows <n>]
 *   lore maintain cloud-purge --id <workspace-id> --unrecorded --confirm-org <orgId> [--apply]
 *
 * Dry run is the default; nothing is deleted without `--apply`. The scan/delete engines live in
 * `engines/dataplaneWorkspacePurge.ts` / `dataplaneWorkspacePurgeApply.ts`; this module owns the policy around
 * them: every refusal, the strict registry check, the recent-write probe verdict, output, exit codes and the
 * purge journal (`workspace-deletions.jsonl`, via `config/deletedWorkspaces.ts`).
 *
 * Exit codes: 0 done / dry run fine; 1 refused or usage error (nothing deleted); 2 runtime failure or abort
 * (partial deletion possible); 3 safe but not provably complete (unverifiable collection, --max-rows).
 *
 * Testability: `runCloudPurge(argv, deps)` takes the client factory, env, lore home, clock and output sinks, so a
 * test never touches the network, the real home or process state (the one exception is the deployment-mode
 * override `LORE_DEPLOYMENT_MODE` in the real `process.env`, which `resolveDeploymentMode` always consults first).
 * No credential value is ever printed; error text is scrubbed of the API key.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG, resolveDeploymentMode } from '../../config/configManager.js';
import { appendPurgeEvent, liveWorkspaceIds, readDeletionLog, type DeletionRecord, type PurgeEvent } from '../../config/deletedWorkspaces.js';
import { isValidWorkspaceId } from '../../config/workspaceIds.js';
import { loreHome } from '../../config/loreHome.js';
import type { WorkspaceEntry } from '../../config/workspaces.js';
import { parseDuration } from '../../engines/maintain/index.js';
import {
    probeDecision, purgeCollectionOrder, scanWorkspaceForPurge,
    type CollectionScan, type PurgeScanReport, type PurgeTarget,
} from '../../engines/dataplaneWorkspacePurge.js';
import { applyWorkspacePurge, type PurgeApplyClient, type PurgeApplyResult } from '../../engines/dataplaneWorkspacePurgeApply.js';

export const CLOUD_PURGE_HELP = `Usage: lore maintain cloud-purge --list
       lore maintain cloud-purge --id <workspace-id> [options]          (dry run)
       lore maintain cloud-purge --id <workspace-id> --apply [options]  (deletes)

Hard-deletes the Dataplane rows of a workspace that was deleted from this Lore
instance. Cloud mode only. Dry run is the default; nothing is deleted without --apply.

  --list                   Show recorded workspace deletions (no network).
  --id <workspace-id>      The permanent id of ONE deleted workspace (names are never accepted).
  --apply                  Actually delete (needs DATAPLANE_URL set explicitly).
  --unrecorded --confirm-org <orgId>
                           Allow an id with no deletion record; <orgId> must equal DATAPLANE_ORG_ID.
  --min-age <duration>     Minimum time since deletion before --apply (default 7d; e.g. 0, 12h, 7d).
  --collection <name>      Extra app-declared collection to purge (repeatable).
  --connection <name>      Dataplane connector (default: DATAPLANE_CONNECTION).
  --max-rows <n>           Stop after n delete attempts and exit 3 (re-run to continue).
  --json                   One JSON object on stdout, nothing else.

Env: DATAPLANE_ORG_ID (not 'default'), DATAPLANE_API_KEY, DATAPLANE_URL, DATAPLANE_CONNECTION.
Exit: 0 done, 1 refused / usage error, 2 failure or abort (partial deletion possible),
      3 not provably complete (re-run).`;

/* ─── Dependencies + strict registry read ─────────────────────── */

export interface CloudPurgeDeps {
    /** Builds the Dataplane client. Default: the live SDK (loaded lazily). */
    clientFactory?: (baseUrl: string, apiKey: string) => PurgeApplyClient | Promise<PurgeApplyClient>;
    env: Record<string, string | undefined>;
    home: string;
    now: () => Date;
    out: (line: string) => void;
    err: (line: string) => void;
}

async function liveClient(baseUrl: string, apiKey: string): Promise<PurgeApplyClient> {
    const { loadGroundfloorClient } = await import('../../mcp/cloudStores.js');
    const { createLoreDataplaneSdk } = await import('../../engines/dataplaneSdkCompat.js');
    return createLoreDataplaneSdk(await loadGroundfloorClient(), baseUrl, apiKey);
}

/**
 * STRICT registry read: throws when `workspaces.json` is absent, unreadable, not JSON, or lacks a usable
 * `workspaces[]`. The lenient loaders return an empty list on error, which would make an unreadable registry
 * look like "nothing is live"; a purge must read that as "cannot prove it is unregistered".
 */
export function readRegistryStrict(home: string): WorkspaceEntry[] {
    const file = path.join(home, 'workspaces.json');
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); }
    catch (e) { throw new Error(`cannot read ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`${file} is not valid JSON`); }
    const list = (parsed as { workspaces?: unknown } | null)?.workspaces;
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${file} has no workspaces[]`);
    for (const w of list) {
        const e = w as { name?: unknown; path?: unknown } | null;
        if (!e || typeof e !== 'object' || typeof e.name !== 'string' || typeof e.path !== 'string') throw new Error(`${file} has a malformed workspace entry`);
    }
    return list as WorkspaceEntry[];
}

/* ─── Argument parsing ────────────────────────────────────────── */

interface Opts {
    help: boolean; list: boolean; apply: boolean; unrecorded: boolean; json: boolean;
    ids: string[]; confirmOrg?: string; minAgeMs: number; collections: string[]; connection?: string; maxRows?: number;
}
class UsageError extends Error {}

const VALUE_FLAGS = new Set(['--id', '--confirm-org', '--min-age', '--collection', '--connection', '--max-rows']);
const BOOL_FLAGS = new Set(['--help', '-h', '--list', '--apply', '--unrecorded', '--json']);

function parseArgs(argv: readonly string[]): Opts {
    const o: Opts = { help: false, list: false, apply: false, unrecorded: false, json: false, ids: [], minAgeMs: 7 * 86_400_000, collections: [] };
    const seen = new Set<string>();
    for (let i = 0; i < argv.length; i++) {
        let tok = argv[i]!;
        let val: string | undefined;
        const eq = tok.startsWith('--') ? tok.indexOf('=') : -1;
        if (eq > 0) { val = tok.slice(eq + 1); tok = tok.slice(0, eq); }
        if (BOOL_FLAGS.has(tok)) {
            if (val !== undefined) throw new UsageError(`${tok} takes no value`);
            if (tok === '--help' || tok === '-h') o.help = true;
            else if (tok === '--list') o.list = true;
            else if (tok === '--apply') o.apply = true;
            else if (tok === '--unrecorded') o.unrecorded = true;
            else o.json = true;
            continue;
        }
        if (!VALUE_FLAGS.has(tok)) throw new UsageError(tok.startsWith('-') ? `unknown flag ${tok}` : `unexpected argument '${tok}'`);
        if (val === undefined) {
            val = argv[++i];
            if (val === undefined || (val.startsWith('--') && val.length > 2)) throw new UsageError(`${tok} needs a value`);
        }
        if (tok !== '--id' && tok !== '--collection' && seen.has(tok)) throw new UsageError(`${tok} given more than once`);
        seen.add(tok);
        if (tok === '--id') o.ids.push(val);
        else if (tok === '--collection') o.collections.push(val);
        else if (tok === '--confirm-org') o.confirmOrg = val;
        else if (tok === '--connection') o.connection = val;
        else if (tok === '--min-age') {
            try { o.minAgeMs = parseDuration(val); } catch (e) { throw new UsageError(`--min-age: ${(e as Error).message}`); }
        } else if (!/^[1-9]\d*$/.test(val)) throw new UsageError('--max-rows must be a positive integer');
        else o.maxRows = Number(val);
    }
    if (o.list && o.apply) throw new UsageError('--list cannot be combined with --apply');
    return o;
}

/* ─── Formatting helpers ──────────────────────────────────────── */

function fmtAge(ms: number): string {
    if (ms < 0) return 'in the future';
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

/** URL without any userinfo (never print a credential embedded in the URL). */
function safeUrl(u: string): string {
    try { const p = new URL(u); p.username = ''; p.password = ''; return p.toString(); } catch { return '[unparsable url]'; }
}

const msg = (e: unknown): string => `${(e as Error)?.constructor?.name ?? 'Error'}: ${(e as Error)?.message ?? String(e)}`;

/* ─── Report ──────────────────────────────────────────────────── */

interface RowOut {
    collection: string; keyed: number; unkeyed: number; foreignSeen: number; unkeyedSamples: string[]; endState: string;
    lowerBound?: boolean; deleted?: number; survivorsRetried?: number;
}
interface Report {
    mode: 'dry-run' | 'apply';
    exitCode: number;
    dataplaneUrl: string; orgId: string; connection: string; target: string;
    record: { name: string; deletedAt: string; ageMs: number; orgId: string | null; idSource: string } | null;
    unrecorded: boolean;
    registry: { entries: number; live: boolean };
    minAgeMs: number;
    probe: { verdict: string; reason: string };
    collections: RowOut[];
    /** Dry run: the reason `--apply` would refuse, or null. */
    applyWouldRefuse?: string | null;
    /** Apply: refused after the scan (rule 11); nothing was deleted. */
    refused?: string;
    result?: { outcome: string; message: string | null; stoppedIn: string | null; totals: PurgeApplyResult['totals']; deleteRequests: number };
    journal?: { written: boolean; error?: string };
    warnings: string[];
}

const scanRow = (c: CollectionScan): RowOut => ({
    collection: c.collection, keyed: c.keyed, unkeyed: c.unkeyed, foreignSeen: c.foreign, unkeyedSamples: c.unkeyedSamples,
    endState: c.endState, lowerBound: c.lowerBound,
});
const applyRow = (c: PurgeApplyResult['collections'][number]): RowOut => ({
    collection: c.collection, keyed: c.keyedSeen, unkeyed: c.unkeyed, foreignSeen: c.foreignSeen, unkeyedSamples: c.unkeyedSamples,
    endState: c.endState, deleted: c.deleted, survivorsRetried: c.survivorsRetried,
});

function renderText(r: Report): string[] {
    const L: string[] = [];
    L.push(`lore maintain cloud-purge - ${r.mode === 'apply' ? 'APPLY' : 'DRY RUN'}`);
    L.push(`  dataplane url   : ${r.dataplaneUrl}`);
    L.push(`  org id          : ${r.orgId}`);
    L.push(`  connection      : ${r.connection}`);
    L.push(`  target id       : ${r.target}`);
    L.push(`  deletion record : ${r.record
        ? `"${r.record.name}" deleted ${r.record.deletedAt} (${fmtAge(r.record.ageMs)} ago), org ${r.record.orgId ?? 'not recorded'}, id ${r.record.idSource}`
        : 'UNRECORDED (explicit override: --unrecorded --confirm-org)'}`);
    L.push(`  registry check  : not live in workspaces.json (${r.registry.entries} entries read)`);
    L.push(`  write probe     : ${r.probe.verdict} - ${r.probe.reason}`);
    L.push('');
    for (const c of r.collections) {
        let line = `  ${c.collection.padEnd(14)} keyed ${c.lowerBound ? 'at least ' : ''}${c.keyed}  unkeyed ${c.unkeyed}  foreign-seen ${c.foreignSeen}`;
        if (c.deleted !== undefined) line += `  deleted ${c.deleted}  survivors-retried ${c.survivorsRetried ?? 0}`;
        L.push(`${line}  end: ${c.endState}`);
        if (c.unkeyed > 0) L.push(`    ${c.unkeyed} unkeyed row(s) matched the scope but failed the per-row proof: LEFT in place, never deleted. Sample ids: ${c.unkeyedSamples.join(', ')}`);
    }
    L.push('');
    for (const w of r.warnings) L.push(`WARNING: ${w}`);
    if (r.mode === 'dry-run') {
        if (r.applyWouldRefuse) L.push(`--apply would REFUSE: ${r.applyWouldRefuse}`);
        L.push('DRY RUN - nothing was deleted; re-run with --apply');
    } else if (r.refused) {
        L.push(`APPLY REFUSED - ${r.refused}; nothing was deleted`);
    } else if (r.result) {
        const t = r.result.totals;
        L.push(`APPLY ${r.result.outcome}: ${t.deleted} row(s) deleted in ${r.result.deleteRequests} request(s), ${t.survivorsRetried} survivor retr${t.survivorsRetried === 1 ? 'y' : 'ies'}, ${t.unkeyed} unkeyed row(s) left in place`);
        if (r.result.message) L.push(`  ${r.result.message}`);
        if (r.exitCode === 3) L.push('  Not provably complete: re-run the same command to continue.');
        if (r.exitCode === 2) L.push('  Partial deletion is possible: re-run the same command once the cause is fixed.');
        L.push(`  journal: ${r.journal?.written ? 'purge event recorded' : `NOT recorded (${r.journal?.error ?? 'n/a'})`}`);
    }
    return L;
}

/* ─── --list ──────────────────────────────────────────────────── */

function runList(o: Opts, d: CloudPurgeDeps): number {
    let log: ReturnType<typeof readDeletionLog>;
    try { log = readDeletionLog(d.home); } catch (e) { return fail(o, d, 2, `cannot read the deletion log: ${msg(e)}`); }
    let live: Set<string> | null = null;
    let regNote: string | null = null;
    try { live = liveWorkspaceIds(readRegistryStrict(d.home)); } catch (e) { regNote = `registry unreadable, live check unavailable: ${(e as Error).message}`; }
    const nowMs = d.now().getTime();
    const rows = [...log.byId.entries()].filter(([, s]) => s.deletion).map(([id, s]) => {
        const rec = s.deletion as DeletionRecord;
        const p: PurgeEvent | undefined = s.lastPurge;
        return {
            id, name: rec.name, deletedAt: rec.deletedAt, orgId: rec.orgId, ageMs: nowMs - Date.parse(rec.deletedAt),
            liveAgain: live ? live.has(id) : null, lastPurge: p ? { status: p.status, at: p.at } : null,
        };
    }).sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
    if (o.json) { d.out(JSON.stringify({ deletions: rows, skippedLines: log.skippedLines, registryNote: regNote }, null, 2)); return 0; }
    if (rows.length === 0) d.out('no recorded workspace deletions');
    for (const r of rows) {
        d.out(`${r.id}  "${r.name}"  deleted ${r.deletedAt} (${Number.isNaN(r.ageMs) ? 'age unknown' : `${fmtAge(r.ageMs)} ago`})  org ${r.orgId ?? '-'}  `
            + `last purge: ${r.lastPurge ? `${r.lastPurge.status} at ${r.lastPurge.at}` : 'never'}${r.liveAgain ? '  [LIVE AGAIN in registry: will be refused]' : ''}`);
    }
    if (regNote) d.out(`note: ${regNote}`);
    if (log.skippedLines > 0) d.out(`note: ${log.skippedLines} unreadable line(s) skipped in the deletion log`);
    return 0;
}

/** Usage error / refusal / failure: reason on stderr; in --json mode also one JSON object on stdout. */
function fail(o: Pick<Opts, 'json'>, d: CloudPurgeDeps, exitCode: number, reason: string): number {
    d.err(`cloud-purge: ${exitCode === 1 ? 'refused: ' : ''}${reason}`);
    if (o.json) d.out(JSON.stringify({ ok: false, exitCode, ...(exitCode === 1 ? { refused: reason } : { error: reason }) }));
    return exitCode;
}

/* ─── Main ────────────────────────────────────────────────────── */

export async function runCloudPurge(argv: readonly string[], deps: CloudPurgeDeps): Promise<{ exitCode: number }> {
    return { exitCode: await run(argv, deps) };
}

async function run(argv: readonly string[], d: CloudPurgeDeps): Promise<number> {
    const jsonFlag = argv.includes('--json');
    let o: Opts;
    let collections: string[];
    try {
        o = parseArgs(argv);
        if (o.help) { d.out(CLOUD_PURGE_HELP); return 0; }
        collections = purgeCollectionOrder(o.collections);
    } catch (e) {
        return fail({ json: jsonFlag }, d, 1, (e as Error).message);
    }
    if (o.list) return runList(o, d);
    const refuse = (reason: string): number => fail(o, d, 1, reason);

    // 1-4: environment.
    if (resolveDeploymentMode({ ...DEFAULT_CONFIG, deploymentMode: (d.env['LORE_DEPLOYMENT_MODE'] ?? '').trim().toLowerCase() as never }) !== 'cloud') {
        return refuse("deployment mode is not 'cloud' (set LORE_DEPLOYMENT_MODE=cloud); cloud-purge only works on cloud-mode data");
    }
    const orgId = d.env['DATAPLANE_ORG_ID'] ?? '';
    if (orgId === '' || orgId === 'default') return refuse(`DATAPLANE_ORG_ID is ${orgId === '' ? 'unset' : "'default' (shared by unrelated hosts)"}; set the Lore instance's own org id`);
    const apiKey = d.env['DATAPLANE_API_KEY'] ?? '';
    if (apiKey === '') return refuse('DATAPLANE_API_KEY is unset');
    const explicitUrl = d.env['DATAPLANE_URL'] ?? '';
    if (o.apply && explicitUrl === '') return refuse('--apply needs DATAPLANE_URL set explicitly (the localhost default is never used for a delete)');
    const url = explicitUrl || 'http://localhost:8080';
    const connection = (o.connection ?? d.env['DATAPLANE_CONNECTION'] ?? '').trim();
    if (connection === '') return refuse('no connection: pass --connection or set DATAPLANE_CONNECTION');
    const scrub = (s: string): string => s.split(apiKey).join('[redacted]');

    // 5: the target id.
    if (o.ids.length !== 1) return refuse(o.ids.length === 0 ? '--id <workspace-id> is required' : 'exactly one --id per run');
    const id = o.ids[0]!;
    if (!isValidWorkspaceId(id)) return refuse(`'${id}' is not a valid workspace id (workspace names are never accepted; use the permanent id from --list)`);

    // 6-7: strict registry check.
    let entries: WorkspaceEntry[];
    try { entries = readRegistryStrict(d.home); } catch (e) { return refuse(`cannot prove the workspace is unregistered: ${(e as Error).message}`); }
    if (liveWorkspaceIds(entries).has(id)) return refuse('the workspace id is live in workspaces.json (an entry or alias still uses it)');

    // 8-10: deletion record.
    let rec: DeletionRecord | undefined;
    try { rec = readDeletionLog(d.home).byId.get(id)?.deletion; } catch (e) { return refuse(`cannot read the deletion log: ${(e as Error).message}`); }
    if (!rec) {
        if (!o.unrecorded || o.confirmOrg === undefined) return refuse('no deletion record for this id; to purge an unrecorded id pass --unrecorded --confirm-org <DATAPLANE_ORG_ID>');
        if (o.confirmOrg !== orgId) return refuse('--confirm-org does not equal DATAPLANE_ORG_ID');
    } else if (rec.orgId !== null && rec.orgId !== orgId) {
        return refuse(`the deletion record belongs to a different org ('${rec.orgId}'); this instance's DATAPLANE_ORG_ID differs`);
    }
    const nowMs = d.now().getTime();
    const deletedAtMs = rec ? Date.parse(rec.deletedAt) : null;
    if (rec && deletedAtMs !== null && Number.isNaN(deletedAtMs)) return refuse('the deletion record has an unreadable deletedAt');
    const ageMs = rec ? nowMs - (deletedAtMs as number) : null;
    const tooYoung = ageMs !== null && ageMs < o.minAgeMs;
    const youngMsg = tooYoung ? `the deletion record is younger than --min-age (${fmtAge(ageMs as number)} old, minimum ${fmtAge(o.minAgeMs)})` : null;
    if (o.apply && youngMsg) return refuse(youngMsg);

    // Scan (read-only), then the recent-write probe verdict.
    const target: PurgeTarget = {
        orgId, loreWorkspace: id,
        dataplaneWorkspaceId: d.env['DATAPLANE_WORKSPACE_ID'] || d.env['DATAPLANE_TENANT_ID'] || 'groundfloor_lore',
    };
    const decide = (p: Parameters<typeof probeDecision>[0]) => probeDecision(p, { deletedAtMs, nowMs: d.now().getTime(), minAgeMs: o.minAgeMs });
    let client: PurgeApplyClient;
    let scan: PurgeScanReport;
    try {
        client = await (d.clientFactory ?? liveClient)(url, apiKey);
        scan = await scanWorkspaceForPurge({ client, target, connection, collections });
    } catch (e) { return fail(o, d, 2, `scan failed: ${scrub(msg(e))}`); }
    const probeRaw = scan.collections.find((c) => c.collection === 'lore_node')?.probe ?? null;
    const decision = probeRaw ? decide(probeRaw) : { refuse: false, verdict: 'no-rows' as const, reason: 'no keyed rows seen' };
    const wouldRefuse = decision.refuse ? `recent-write probe: ${decision.reason}`
        : decision.verdict === 'unknown' ? `recent-write probe cannot tell: ${decision.reason}` : null;

    const report: Report = {
        mode: o.apply ? 'apply' : 'dry-run', exitCode: 0, dataplaneUrl: safeUrl(url), orgId, connection, target: id,
        record: rec ? { name: rec.name, deletedAt: rec.deletedAt, ageMs: ageMs as number, orgId: rec.orgId, idSource: rec.idSource } : null,
        unrecorded: !rec, registry: { entries: entries.length, live: false }, minAgeMs: o.minAgeMs,
        probe: { verdict: decision.verdict, reason: decision.reason }, collections: scan.collections.map(scanRow), warnings: [],
    };
    const emit = (): number => {
        if (o.json) d.out(JSON.stringify(report, null, 2)); else for (const l of renderText(report)) d.out(l);
        return report.exitCode;
    };

    if (!o.apply) {
        report.applyWouldRefuse = youngMsg ?? wouldRefuse;
        if (youngMsg) report.warnings.push(youngMsg);
        return emit();
    }
    if (wouldRefuse) { report.refused = wouldRefuse; report.exitCode = 1; return emit(); }

    // Apply: guard re-reads the registry strictly before EVERY delete pass; probeCheck repeats rule 11 on the walk's own probe.
    const res = await applyWorkspacePurge({
        client, target, connection, collections,
        guard: () => {
            if (liveWorkspaceIds(readRegistryStrict(d.home)).has(id)) throw new Error('the workspace id is live in workspaces.json again');
        },
        probeCheck: (p) => {
            const v = decide(p);
            if (v.refuse || v.verdict === 'unknown') throw new Error(v.reason);
        },
        ...(o.maxRows !== undefined ? { maxRows: o.maxRows } : {}),
    });
    report.collections = res.collections.map(applyRow);
    report.exitCode = res.exitCode;
    report.result = { outcome: res.outcome, message: res.message ? scrub(res.message) : null, stoppedIn: res.stoppedIn, totals: res.totals, deleteRequests: res.deleteRequests };
    if (res.deleteRequests > 0 || res.outcome === 'complete') {
        try {
            appendPurgeEvent({
                id, connection, at: d.now().toISOString(),
                status: res.exitCode === 0 ? 'complete' : res.outcome === 'unverifiable' ? 'unverifiable' : 'partial',
                collections: Object.fromEntries(res.collections.map((c) => [c.collection, { deleted: c.deleted, unkeyed: c.unkeyed, endState: c.endState }])),
            }, d.home);
            report.journal = { written: true };
        } catch (e) {
            report.journal = { written: false, error: (e as Error).message };
            report.warnings.push(`the purge event could not be recorded in workspace-deletions.jsonl (${(e as Error).message}); the deletion itself is unaffected`);
        }
    } else report.journal = { written: false, error: 'no delete request was sent' };
    return emit();
}

/** `lore maintain cloud-purge ...` entry point: real env, home and console. */
export async function cloudPurgeCommand(args: string[]): Promise<void> {
    const { exitCode } = await runCloudPurge(args, {
        env: process.env, home: loreHome(), now: () => new Date(),
        out: (l) => console.log(l), err: (l) => console.error(l),
    });
    if (exitCode !== 0) process.exit(exitCode);
}
