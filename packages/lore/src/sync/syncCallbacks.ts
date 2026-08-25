/**
 * syncCallbacks.ts — Disk-IO callbacks for SyncPoller.
 *
 * SyncPoller is purely an orchestrator: it asks cloud for the
 * authoritative workspace list, reconciles it against local state,
 * and calls these three callbacks to apply each side effect.
 *
 *   readLocalWorkspaceStates(workspacesDir)
 *     Scans `workspacesDir/*` for `.lore/sync-state.json` files. Each
 *     workspace dir without a sync-state file is treated as
 *     never-synced (`syncedVersion: ''`). The reconciler decides what
 *     to pull or drop based on that.
 *
 *   applySnapshotToDisk(workspacesDir, workspaceId, version, bytes)
 *     Writes the snapshot bytes to `workspacesDir/<id>/.lore/snapshot.bin`
 *     atomically (write to .tmp then rename) and updates the sync-state
 *     file's version stamp.
 *
 *   removeWorkspaceFromDisk(workspacesDir, workspaceId, activeWorkspaceId)
 *     Delegates to the six-layered `revokeWorkspaces` helper from
 *     revocationHandler.ts. The active workspace is always protected.
 *
 * fs is injectable so unit tests run without touching real disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { LocalWorkspaceState } from './reconciler.js';
import { revokeWorkspaces, withinRoot } from './revocationHandler.js';

const LORE_SUBDIR = '.lore';
const SYNC_STATE_FILE = 'sync-state.json';
const SNAPSHOT_FILE = 'snapshot.bin';

interface SyncStateFile {
    syncedVersion: string;
}

/**
 * Subset of `fs` the callbacks call. Tests inject a minimal shim;
 * production code passes the real `fs` module via the default arg.
 */
export interface SyncCallbacksFs {
    readdirSync: (dir: string, opts: { withFileTypes: true }) => Array<{ name: string; isDirectory(): boolean }>;
    existsSync: (p: string) => boolean;
    readFileSync: (p: string, encoding: 'utf8') => string;
    writeFileSync: (p: string, data: string | Uint8Array) => void;
    mkdirSync: (p: string, opts: { recursive: boolean }) => void;
    renameSync: (oldP: string, newP: string) => void;
    /**
     * F-LOW-S11: durability primitives, mirroring the WAL's fsync pattern.
     * Optional so existing test shims that don't model durability keep
     * working; when absent, the durability step is skipped (best-effort).
     * `openSync`/`fsyncSync`/`fdatasyncSync`/`closeSync` operate on a file
     * descriptor; `fdatasyncSync` flushes file contents, `fsyncSync` on a
     * directory fd flushes the rename/metadata so the file's existence is
     * itself durable.
     */
    openSync?: (p: string, flags: string) => number;
    fsyncSync?: (fd: number) => void;
    fdatasyncSync?: (fd: number) => void;
    closeSync?: (fd: number) => void;
}

const defaultFs: SyncCallbacksFs = fs as unknown as SyncCallbacksFs;

/**
 * Read the local workspace state by walking `workspacesDir`. Each
 * subdirectory becomes a `LocalWorkspaceState`. Missing/invalid
 * sync-state.json → `syncedVersion: ''` (never-synced).
 */
export function readLocalWorkspaceStates(
    workspacesDir: string,
    fsImpl: SyncCallbacksFs = defaultFs,
): LocalWorkspaceState[] {
    if (!fsImpl.existsSync(workspacesDir)) return [];
    const entries = fsImpl.readdirSync(workspacesDir, { withFileTypes: true });
    const out: LocalWorkspaceState[] = [];
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const workspaceId = e.name;
        const stateFile = path.join(workspacesDir, workspaceId, LORE_SUBDIR, SYNC_STATE_FILE);
        let syncedVersion = '';
        if (fsImpl.existsSync(stateFile)) {
            try {
                const parsed = JSON.parse(fsImpl.readFileSync(stateFile, 'utf8')) as Partial<SyncStateFile>;
                if (typeof parsed.syncedVersion === 'string') syncedVersion = parsed.syncedVersion;
            } catch {
                // Corrupt state file - treat as never-synced. Caller's
                // tick will see syncedVersion: '' and pull fresh.
            }
        }
        out.push({ workspaceId, syncedVersion });
    }
    return out;
}

/**
 * Write the pulled snapshot to disk + bump the sync-state.json version.
 * Atomic: writes to <file>.tmp then renames. Failure leaves the prior
 * snapshot intact.
 */
export function applySnapshotToDisk(
    workspacesDir: string,
    workspaceId: string,
    version: string,
    bytes: Uint8Array,
    fsImpl: SyncCallbacksFs = defaultFs,
    expectedSha256?: string,
): void {
    // F-LOW-S02: snapshot integrity here is HASH-ONLY (transport integrity),
    // NOT authenticity. `expectedSha256` / x-content-sha256 proves the bytes
    // arrived uncorrupted; it does NOT prove the bytes came from a trusted
    // signer — a compromised cloud peer or MITM that controls both the bytes
    // AND the header can present a self-consistent (hash-matching) snapshot.
    // Closing that gap requires a SIGNED manifest (e.g. an Ed25519 signature
    // over {workspaceId, version, sha256}) plus key management, which is
    // deliberately out of scope here (no key mgmt introduced). Until then the
    // cheap additional checks we CAN do are below: reject empty bytes and a
    // missing/blank version stamp, so a degenerate or truncated response can't
    // silently overwrite a good snapshot with an unversioned/empty one.
    if (!version || version.trim() === '') {
        throw new Error(`applySnapshot ${workspaceId} refused: empty version stamp`);
    }
    if (bytes.length === 0) {
        throw new Error(`applySnapshot ${workspaceId} refused: empty snapshot bytes`);
    }
    // F-L072: defense-in-depth integrity gate at the disk boundary. The
    // primary verification happens in HttpSyncClient.pullWorkspaceSnapshot,
    // but if a caller wires the x-content-sha256 value through, re-verify
    // here so corrupt bytes are NEVER written to snapshot.bin. Throwing
    // surfaces in syncPoller's per-pull catch as a pullsFailed entry.
    if (expectedSha256) {
        const actual = createHash('sha256').update(bytes).digest('hex');
        const expected = expectedSha256.trim().toLowerCase().replace(/^sha256:/, '');
        if (actual !== expected) {
            throw new Error(
                `applySnapshot ${workspaceId} refused: sha256 mismatch ` +
                `(expected ${expected}, got ${actual})`,
            );
        }
    }
    // L-034: path containment. `workspaceId` is fully cloud-controlled
    // (echoed straight from the cloud's snapshot response). Reject any id
    // that resolves outside the workspaces root — path traversal
    // ('../../escape') or absolute paths ('/tmp/evil') — BEFORE any fs
    // call, so a malicious/compromised cloud peer cannot write
    // snapshot.bin / sync-state.json to an arbitrary directory. Reuses the
    // same withinRoot guard removeWorkspaceFromDisk gets for free via
    // revokeWorkspaces. Throwing (not silent-skip) surfaces it in the
    // poller's per-pull catch as a `pullsFailed` entry (syncPoller.ts:188).
    const root = path.resolve(workspacesDir);
    const wsAbs = path.resolve(root, workspaceId);
    if (!withinRoot(wsAbs, root)) {
        throw new Error(`applySnapshot ${workspaceId} refused: path-escape`);
    }
    const loreDir = path.join(wsAbs, LORE_SUBDIR);
    fsImpl.mkdirSync(loreDir, { recursive: true });
    const snapshotPath = path.join(loreDir, SNAPSHOT_FILE);
    const tmpPath = `${snapshotPath}.tmp`;
    fsImpl.writeFileSync(tmpPath, bytes);
    // F-LOW-S11: fdatasync the snapshot tmp file BEFORE the rename, mirroring
    // the WAL's durability pattern, so the snapshot bytes are on stable
    // storage before they become the live snapshot.
    fdatasyncFile(fsImpl, tmpPath);
    fsImpl.renameSync(tmpPath, snapshotPath);
    // F-LOW-S11: fsync the parent dir so the rename (the file's new name /
    // existence) is itself durable before we write the version stamp. Without
    // this, a crash between the snapshot rename and the version-stamp commit
    // could leave the version stamp pointing at a snapshot the filesystem
    // never durably recorded — an inconsistent state on recovery.
    fsyncDir(fsImpl, loreDir);
    const stateFile = path.join(loreDir, SYNC_STATE_FILE);
    const stateTmp = `${stateFile}.tmp`;
    fsImpl.writeFileSync(stateTmp, JSON.stringify({ syncedVersion: version } satisfies SyncStateFile));
    // F-LOW-S11: fdatasync the version-stamp tmp, then rename, then fsync the
    // dir so the committed version stamp is durable too. Now the on-disk
    // ordering guarantees: snapshot durable → snapshot named → version stamp
    // durable → version stamp committed. A crash at any point leaves either
    // the prior consistent state or the new consistent state, never a stamp
    // ahead of its snapshot.
    fdatasyncFile(fsImpl, stateTmp);
    fsImpl.renameSync(stateTmp, stateFile);
    fsyncDir(fsImpl, loreDir);
}

/**
 * F-LOW-S11: fdatasync a regular file by path, if the injected fs models
 * durability. Best-effort: a missing primitive (e.g. a minimal test shim)
 * skips the flush rather than failing the write. The fd is always closed.
 */
function fdatasyncFile(fsImpl: SyncCallbacksFs, filePath: string): void {
    if (!fsImpl.openSync || !fsImpl.closeSync) return;
    const sync = fsImpl.fdatasyncSync ?? fsImpl.fsyncSync;
    if (!sync) return;
    const fd = fsImpl.openSync(filePath, 'r+');
    try {
        sync(fd);
    } finally {
        fsImpl.closeSync(fd);
    }
}

/**
 * F-LOW-S11: fsync a directory by path so a contained rename is durable.
 * Directories must be opened read-only ('r') for fsync. Best-effort: skipped
 * when the injected fs lacks the primitives. The fd is always closed.
 */
function fsyncDir(fsImpl: SyncCallbacksFs, dirPath: string): void {
    if (!fsImpl.openSync || !fsImpl.closeSync || !fsImpl.fsyncSync) return;
    const fd = fsImpl.openSync(dirPath, 'r');
    try {
        fsImpl.fsyncSync(fd);
    } finally {
        fsImpl.closeSync(fd);
    }
}

/**
 * Remove a workspace by delegating to the existing six-layered
 * revokeWorkspaces helper, which provides path containment, active-
 * workspace guard, allowlist, pre-flight existence check, audit
 * trail, and recursive+force rmSync. The poller's caller passes the
 * active workspace id so the guard kicks in.
 */
export function removeWorkspaceFromDisk(
    workspacesDir: string,
    workspaceId: string,
    activeWorkspaceId: string | null,
    neverDrop?: ReadonlyArray<string>,
    fsImpls?: {
        rmSyncImpl?: (target: string, opts: { recursive?: boolean; force?: boolean }) => void;
        existsSyncImpl?: (target: string) => boolean;
    },
): void {
    const report = revokeWorkspaces({
        workspaceIds: [workspaceId],
        workspacesRoot: workspacesDir,
        activeWorkspaceId,
        neverDrop,
        rmSyncImpl: fsImpls?.rmSyncImpl,
        existsSyncImpl: fsImpls?.existsSyncImpl,
    });
    // revokeWorkspaces accumulates outcomes; if it returns 'failed' or
    // 'skipped: is-active' we surface that to the caller as a throw so
    // SyncPoller's `dropsFailed` slot captures it. 'not-on-disk' is
    // silent (already gone is the desired end state).
    const outcome = report.all[0];
    if (outcome.kind === 'failed') {
        throw new Error(`removeWorkspace ${workspaceId} failed: ${outcome.reason}`);
    }
    if (outcome.kind === 'skipped' && outcome.reason !== 'not-on-disk') {
        throw new Error(`removeWorkspace ${workspaceId} refused: ${outcome.reason}`);
    }
}
