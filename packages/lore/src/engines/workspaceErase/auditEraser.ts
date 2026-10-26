/**
 * workspaceErase/auditEraser.ts — blanks a deleted workspace's audit entries (store label `audit-log`).
 *
 * Owner decision (Rafi 2026-10-25): a deleted workspace's audit entries may hold sensitive client data, so their
 * CONTENT is blanked in `<home>/audit.jsonl` and in every rotated `audit.jsonl.<ts>.gz`. Each blanked entry keeps its
 * time, action (toolName), outcome (result) and duration; everything else is replaced by a fixed stub, and one chained
 * `audit.redacted` marker entry is appended so the hash chain stays verifiable (see security/auditRedact.ts for the
 * stub form and the verifier rules).
 *
 * Matching: audit entries never carry the permanent workspace id, only the workspace NAME (args.workspace, args.name on
 * `workspaces.*`, args.oldName/newName on rename). An entry is blanked when the permanent id appears in its args, or its
 * name matches inside this workspace's lifetime (creation, when known, to deletion) and no other workspace (a live one, or
 * another deleted one) could have held that name at that moment. Name matches that fail that test are AMBIGUOUS: they are
 * left alone and the step reports `unverifiable` (never `complete`). Entries with no workspace attribution at all (for
 * example a delete by node id) cannot be matched and are not touched.
 *
 * Writing: each file is rebuilt in a temp file in the same directory (mode 0600, fsynced) and renamed over the original;
 * archives keep their modification time because the chain verifier orders archives by it. In this process the writers are
 * quiesced for the whole scan + rewrite + marker (`AuditLog.runExclusive`), so no queued append is lost. A DIFFERENT process
 * appending to the same file at the same moment (for example the CLI `erase-now` while a daemon runs) cannot be fenced: a
 * size/time check right before each rename catches most such races (that file is skipped and retried), but a line appended
 * in the instant between the check and the rename could be lost - run erase-now with the daemon stopped to rule it out.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { readDeletionLog } from '../../config/deletedWorkspaces.js';
import { type AuditEntry, type AuditExclusiveHandle } from '../../security/audit.js';
import { listArchives, readTailHash } from '../../security/auditChain.js';
import { liveAuditLogsAt } from '../../security/auditFlush.js';
import {
    REDACT_MARKER_TOOL, classifyEntry, isRedactedEntry, markerArgs, redactionPair, stubLine,
    type MatchTarget, type NameInterval, type RedactedEntry,
} from '../../security/auditRedact.js';
import { currentUser } from '../../security/identity.js';
import { readLiveEntriesStrict } from './liveRegistry.js';
import type { EraseOptions, EraseStepResult, EraseTarget, WorkspaceEraser } from './types.js';

const STORE = 'audit-log';
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const UNATTRIBUTED_NOTE = 'entries that carry no workspace name or id cannot be attributed and were not changed';

export interface AuditEraserDeps {
    /** Lore home; the audit log is `<home>/audit.jsonl`. */
    home: string;
    /** Override the audit file path (tests / hosts that keep it elsewhere). */
    auditPath?: string;
    now?: () => Date;
    /** Fault-injection seam: called with the temp file path after it is written, before the change check and rename (tests). */
    beforeRename?: (file: string) => void;
}

const res = (status: EraseStepResult['status'], detail?: string, removed: Record<string, number> = {}, remaining: Record<string, number> = {}): EraseStepResult =>
    ({ store: STORE, status, removed, remaining, ...(detail ? { detail } : {}) });

interface FilePlan {
    file: string;
    gz: boolean;
    size: number;
    mtimeMs: number;
    atimeMs: number;
    lines: string[];
    newText: string | null;
    /** Pairs for the lines blanked in THIS run, in this file. */
    pairs: string[];
    matched: number;
    ambiguous: number;
}

interface Scan {
    plans: FilePlan[];
    /** runId -> { workspaceId, pairs } for blanked lines whose run has no marker yet (a crash between rewrite and marker). */
    orphans: Map<string, { workspaceId: string; pairs: string[] }>;
    liveHasTail: boolean;
    problems: string[];
}

function readLines(file: string, gz: boolean): { lines: string[]; st: fs.Stats } {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE_BYTES) throw new Error(`file is larger than ${MAX_FILE_BYTES / 1048576} MB`);
    const raw = fs.readFileSync(file);
    const text = (gz ? zlib.gunzipSync(raw) : raw).toString('utf-8');
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return { lines, st };
}

/** Scan every audit file once and prepare (in memory) the rewritten text of the ones that change. Pure reads. */
function scan(files: Array<{ file: string; gz: boolean }>, match: MatchTarget, runId: string, at: string): Scan {
    const plans: FilePlan[] = [];
    const runs = new Map<string, { workspaceId: string; pairs: string[] }>();
    const markers = new Set<string>();
    const problems: string[] = [];
    let liveHasTail = false;
    for (const { file, gz } of files) {
        let data: { lines: string[]; st: fs.Stats };
        try { data = readLines(file, gz); }
        catch (e) { problems.push(`${path.basename(file)}: ${(e as Error).message}`.slice(0, 200)); continue; }
        const plan: FilePlan = { file, gz, size: data.st.size, mtimeMs: data.st.mtimeMs, atimeMs: data.st.atimeMs, lines: data.lines, newText: null, pairs: [], matched: 0, ambiguous: 0 };
        if (!gz && data.lines.length > 0) liveHasTail = true;
        const out: string[] = [];
        for (const line of data.lines) {
            let entry: AuditEntry | null = null;
            try { entry = JSON.parse(line) as AuditEntry; } catch { /* keep an unreadable line byte-for-byte; the verifier reports it */ }
            if (!entry || typeof entry !== 'object') { out.push(line); continue; }
            if (isRedactedEntry(entry)) {
                const r = runs.get(entry.redacted.runId) ?? { workspaceId: entry.redacted.workspaceId, pairs: [] };
                r.pairs.push(redactionPair(entry as RedactedEntry));
                runs.set(entry.redacted.runId, r);
                out.push(line); continue;
            }
            if (entry.toolName === REDACT_MARKER_TOOL) {
                const id = (entry.args as { runId?: unknown } | undefined)?.runId;
                if (typeof id === 'string') markers.add(id);
            }
            const c = classifyEntry(entry, match);
            if (c === 'ambiguous') plan.ambiguous++;
            if (c !== 'match') { out.push(line); continue; }
            plan.matched++;
            const stub = stubLine(entry, line, { at, workspaceId: match.id, runId });
            plan.pairs.push(redactionPair(JSON.parse(stub) as RedactedEntry));
            out.push(stub.slice(0, -1));
        }
        if (plan.matched > 0) plan.newText = out.join('\n') + '\n';
        plans.push(plan);
    }
    const orphans = new Map<string, { workspaceId: string; pairs: string[] }>();
    for (const [id, r] of runs) if (!markers.has(id)) orphans.set(id, r);
    return { plans, orphans, liveHasTail, problems };
}

/** Replace `plan.file` with `plan.newText` (temp + fsync + rename, same dir). Returns an error string, or null when done. */
function rewrite(plan: FilePlan, runId: string, hook?: (file: string) => void): string | null {
    const tmp = `${plan.file}.erase-${runId}.tmp`;
    try {
        const body = plan.gz ? zlib.gzipSync(Buffer.from(plan.newText!, 'utf-8')) : Buffer.from(plan.newText!, 'utf-8');
        const fd = fs.openSync(tmp, 'w', 0o600);
        try { fs.writeSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        hook?.(tmp);
        // A different process appended or replaced the file since we read it: do not clobber its change.
        const now = fs.statSync(plan.file);
        if (now.size !== plan.size || now.mtimeMs !== plan.mtimeMs) {
            fs.rmSync(tmp, { force: true });
            return `${path.basename(plan.file)} changed while it was being cleaned (another process wrote to it); it will be retried`;
        }
        if (plan.gz) fs.utimesSync(tmp, plan.atimeMs / 1000, plan.mtimeMs / 1000); // the verifier orders archives by this time
        fs.renameSync(tmp, plan.file);
        return null;
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* leave it; the next run uses a different name */ }
        return `${path.basename(plan.file)}: ${(e as Error).message}`.slice(0, 200);
    }
}

/** Quiesce every in-process writer for the file, then run the (synchronous) section with the first writer's handle. */
async function withQuiesced<T>(file: string, section: (h: AuditExclusiveHandle | null) => T): Promise<T> {
    const logs = liveAuditLogsAt<{ filePath?: string; flush(): Promise<void>; runExclusive?: <R>(fn: (h: AuditExclusiveHandle) => R | Promise<R>) => Promise<R> }>(file)
        .filter((l) => typeof l.runExclusive === 'function');
    if (logs.length === 0) return section(null);
    let first: AuditExclusiveHandle | null = null;
    const nest = (i: number): Promise<T> => logs[i]!.runExclusive!((h) => {
        if (i === 0) first = h;
        return i + 1 < logs.length ? nest(i + 1) : section(first);
    });
    return nest(0);
}

/** Append one chained marker entry: through the writer's handle when one is quiesced here, else straight to the file. */
function appendMarker(file: string, h: AuditExclusiveHandle | null, args: Record<string, unknown>): void {
    const entry = { toolName: REDACT_MARKER_TOOL, args, result: 'success' as const, durationMs: 0 };
    if (h) { h.append(entry); return; }
    const u = currentUser();
    const full: AuditEntry = { timestamp: new Date().toISOString(), actor: { id: u.id, roles: u.roles }, ...entry, prevHash: readTailHash(file) };
    fs.appendFileSync(file, JSON.stringify(full) + '\n', { mode: 0o600 });
}

/** Periods in which a DIFFERENT workspace held `name`: live holders (open-ended) and other deleted workspaces. */
function otherHolders(home: string, target: EraseTarget): NameInterval[] {
    const out: NameInterval[] = [];
    for (const w of readLiveEntriesStrict(home)) {
        if (w.name === target.name) out.push({ from: typeof w.createdAt === 'string' ? w.createdAt : null, to: null });
    }
    for (const [id, st] of readDeletionLog(home).byId) {
        const d = st.deletion;
        if (id !== target.id && d && d.name === target.name) out.push({ from: d.createdAt, to: d.deletedAt });
    }
    return out;
}

export function createAuditEraser(deps: AuditEraserDeps): WorkspaceEraser {
    const nowOf = deps.now ?? (() => new Date());
    return {
        store: STORE,
        async erase(target: EraseTarget, _opts?: EraseOptions): Promise<EraseStepResult> {
            const live = path.join(deps.home, 'audit.jsonl');
            const file = deps.auditPath ?? live;
            const files: Array<{ file: string; gz: boolean }> = [...listArchives(file).map((f) => ({ file: f, gz: true })), ...(fs.existsSync(file) ? [{ file, gz: false }] : [])];
            if (files.length === 0) return res('not-applicable', 'no audit log exists in this deployment');

            let others: NameInterval[];
            try { others = otherHolders(deps.home, target); }
            catch (e) { return res('partial', `could not read the workspace registry or deletion log, so no audit entries were changed (${(e as Error).message})`.slice(0, 300)); }
            const match: MatchTarget = { id: target.id, name: target.name, createdAt: target.createdAt ?? null, deletedAt: target.deletedAt ?? nowOf().toISOString(), others };
            const runId = crypto.randomUUID();
            const at = nowOf().toISOString();

            try {
                return await withQuiesced(file, (h): EraseStepResult => {
                    const sc = scan(files, match, runId, at);
                    const matched = sc.plans.reduce((n, p) => n + p.matched, 0);
                    const ambiguous = sc.plans.reduce((n, p) => n + p.ambiguous, 0);
                    const problems = [...sc.problems];
                    if ((matched > 0 || sc.orphans.size > 0) && !sc.liveHasTail) {
                        return res('partial', 'the live audit log is empty, so there is nowhere to record the blank-out marker; nothing was changed', {}, { entries: matched });
                    }
                    let blanked = 0;
                    const pairs: string[] = [];
                    for (const p of sc.plans) {
                        if (!p.newText) continue;
                        const err = rewrite(p, runId, deps.beforeRename);
                        if (err) { problems.push(err); continue; }
                        blanked += p.pairs.length;
                        pairs.push(...p.pairs);
                    }
                    try {
                        // Recovery markers first (blanked lines whose marker never got written), then this run's.
                        for (const [id, r] of sc.orphans) appendMarker(file, h, markerArgs({ runId: id, workspaceId: r.workspaceId, pairs: r.pairs, recovered: true }));
                        if (pairs.length > 0) appendMarker(file, h, markerArgs({ runId, workspaceId: target.id, pairs }));
                    } catch (e) {
                        // Lines are blanked but unvouched-for: the next run finds them as an orphan run and writes the marker.
                        return res('partial', `entries were blanked but the marker could not be written (${(e as Error).message}); it will be retried`.slice(0, 300), { entries: blanked }, { entries: matched - blanked });
                    }
                    const stillMatching = matched - blanked;
                    if (problems.length > 0 || stillMatching > 0) {
                        return res('partial', `some audit files could not be cleaned and will be retried (${problems.join('; ') || 'rewrite failed'})`.slice(0, 400), { entries: blanked }, { entries: stillMatching });
                    }
                    if (ambiguous > 0) {
                        return res('unverifiable', `${ambiguous} audit entr${ambiguous === 1 ? 'y names' : 'ies name'} this workspace only by name at a time another workspace could have used that name, so ${ambiguous === 1 ? 'it was' : 'they were'} left in place; ${UNATTRIBUTED_NOTE}`, { entries: blanked }, { entries: 0, ambiguous });
                    }
                    return res('complete', `${UNATTRIBUTED_NOTE}`, { entries: blanked }, { entries: 0 });
                });
            } catch (e) {
                return res('partial', `the audit log could not be cleaned and will be retried (${(e as Error).message})`.slice(0, 300));
            }
        },
    };
}
