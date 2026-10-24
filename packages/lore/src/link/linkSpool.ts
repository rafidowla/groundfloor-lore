/**
 * linkSpool.ts - hands node ids from a short-lived CLI process (migrate) to the daemon's link queue.
 *
 * Why a spool and not a direct enqueue: the durable queue (`link-queue.sqlite`) belongs to the daemon.
 * Opening it from a second process runs its open-time side effects (restart recovery would flip a live
 * daemon's claimed rows back to `ready`). The spool is just files: the CLI writes ids, the daemon replays
 * them through signal() when its link service starts. The durable `autolink:false` opt-out lives in the
 * workspace store and is checked by the Linker at link time, and so is the placeholder-vector guard, so both
 * apply to spooled ids exactly as for any live write, however late the batch runs.
 *
 *   <loreDir>/link-spool/<stamp>-<pid>-<rand>.json   {"v":1,"workspace":"..","ids":["..",..]}
 *
 * Writes are atomic (temp file + rename). Draining deletes a file before its ids are signalled (at-most-once);
 * the cost of a crash in that window is a missed link (recoverable with a link rebuild), never a spurious one.
 *
 * Both halves are best-effort and never throw: a spool problem must not fail a migration or a daemon boot.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkspacesIfPresent } from '../config/workspaces.js';
import type { LinkSignaler } from './linkTypes.js';

export const LINK_SPOOL_DIR = 'link-spool';
const SPOOL_VERSION = 1;
/** Ids per spool file / per signal() call. */
const CHUNK = 5000;
const STALE_TMP_MS = 24 * 3600 * 1000;

/**
 * The `.lore` directory the daemon for `home` keeps its link queue in: the ACTIVE workspace's path
 * (mirrors resolveGraphPath() in mcp/bootSteps.ts), falling back to the home itself. Never creates a registry.
 */
export function daemonLoreDir(home: string): string {
    try {
        const f = loadWorkspacesIfPresent(home);
        const entry = f?.workspaces.find((w) => w.name === f.active);
        if (entry) return path.join(entry.path, '.lore');
    } catch { /* fall through */ }
    return path.join(home, '.lore');
}

/**
 * Workspace name the daemon knows the graph at `graphPath` by, or null when no registered workspace has that exact
 * path (then the daemon is not serving that graph under any name, so there is nothing to link and we guess nothing).
 */
export function workspaceNameForPath(home: string, graphPath: string): string | null {
    try {
        const f = loadWorkspacesIfPresent(home);
        if (!f) return null;
        const want = path.resolve(graphPath);
        return f.workspaces.find((w) => path.resolve(w.path) === want)?.name ?? null;
    } catch { return null; }
}

/** Write `ids` for `workspace` into the daemon's spool. Returns how many ids were spooled (0 on any failure). */
export function appendLinkSpool(loreDir: string, workspace: string, ids: ReadonlyArray<string>): number {
    if (!workspace || ids.length === 0) return 0;
    let written = 0;
    try {
        const dir = path.join(loreDir, LINK_SPOOL_DIR);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (let i = 0; i < ids.length; i += CHUNK) {
            const chunk = ids.slice(i, i + CHUNK);
            const base = `${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
            const tmp = path.join(dir, `${base}.tmp`);
            fs.writeFileSync(tmp, JSON.stringify({ v: SPOOL_VERSION, workspace, ids: chunk }), { mode: 0o600 });
            fs.renameSync(tmp, path.join(dir, `${base}.json`));
            written += chunk.length;
        }
    } catch { /* best-effort */ }
    return written;
}

/** Replay every spooled file through `signaler.signal`, deleting each file first. Returns ids signalled. */
export function drainLinkSpool(loreDir: string, signaler: LinkSignaler, onError?: (message: string) => void): number {
    const dir = path.join(loreDir, LINK_SPOOL_DIR);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    let signalled = 0;
    for (const name of names.sort()) {
        const file = path.join(dir, name);
        try {
            if (name.endsWith('.tmp')) {
                // A writer that died mid-write; only reap clearly dead ones (a live CLI may still be writing).
                if (Date.now() - fs.statSync(file).mtimeMs > STALE_TMP_MS) fs.unlinkSync(file);
                continue;
            }
            if (!name.endsWith('.json')) continue;
            const raw = fs.readFileSync(file, 'utf8');
            fs.unlinkSync(file); // at-most-once: delete BEFORE signalling (see header)
            const doc = JSON.parse(raw) as { v?: number; workspace?: unknown; ids?: unknown };
            if (doc.v !== SPOOL_VERSION || typeof doc.workspace !== 'string' || !Array.isArray(doc.ids)) {
                onError?.(`[link-spool] ignoring malformed spool file ${name}`);
                continue;
            }
            const ids = doc.ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
            for (let i = 0; i < ids.length; i += CHUNK) {
                signaler.signal(doc.workspace, ids.slice(i, i + CHUNK).map((id) => ({ id })));
            }
            signalled += ids.length;
        } catch (e) {
            onError?.(`[link-spool] could not replay ${name}: ${(e as Error).message}`);
        }
    }
    return signalled;
}
