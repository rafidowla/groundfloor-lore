/**
 * filesystem.ts — Filesystem connector (Phase 2 / C5).
 *
 * The first concrete connector. Walks a set of user-configured roots,
 * yields every file whose extension the ExtractorRegistry recognizes.
 * Incremental sync is by mtime — files modified since the last cursor
 * re-yield, the rest are skipped.
 *
 * Security:
 *   - Goes through the S4 pathAllowlist so files outside user-intentional
 *     directories (~/.ssh, ~/.aws, ~/.groundfloor) can't be yielded by
 *     accident. The allowlist is already a shipped product concern;
 *     reusing it here keeps the threat model consistent.
 *   - Follows symlinks only after the allowlist clears the resolved
 *     path. (Allowlist already realpaths internally.)
 *
 * Deferred:
 *   - fs.watch() for live change notification. C5 scope is pull-only
 *     (yields on demand). C5.5 or later can add push.
 *   - A user-facing "edit roots" UI. For now, roots live in
 *     ~/.groundfloor/ingestion.json (the same file S4 already reads for
 *     extra ingestion paths).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import type {
    IConnector,
    ConnectorItem,
    ConnectorNativeSchema,
    ConnectorStatus,
    HealthResult,
    SyncOptions,
} from './types.js';
import { ExtractorRegistry } from '../extractors/registry.js';
import {
    assertPathAllowed,
    loadExtraIngestionRoots,
    isIngestionConfigured,
    PathAllowlistError,
} from '../../security/pathAllowlist.js';
import { loreHome, loreHomePath } from '../../config/loreHome.js';

export interface FilesystemConnectorOptions {
    /** Additional roots beyond ~/Documents/Downloads/Desktop defaults. */
    roots?: string[];
    /** Extractor registry for MIME inference (from path). */
    extractorRegistry: ExtractorRegistry;
    /** Workspace root (passed into allowlist check — usually graphBasePath). */
    workspaceRoot?: string;
}

/**
 * resolveEffectiveRoots — single source of truth for "which folders does
 * the filesystem connector read." Used by both health() and sync() so they
 * can't drift. Audit 2026-05-14: explicit opts.roots always wins; otherwise
 * if the user has saved a config file (even empty), that IS the list;
 * otherwise fall back to the suggested defaults.
 */
function resolveEffectiveRoots(explicit: string[] | undefined, dataHome: string): string[] {
    if (explicit && explicit.length > 0) return [...explicit];
    if (isIngestionConfigured(dataHome)) {
        return loadExtraIngestionRoots(dataHome);
    }
    return [
        path.join(os.homedir(), 'Documents'),
        path.join(os.homedir(), 'Downloads'),
        path.join(os.homedir(), 'Desktop'),
    ];
}

export class FilesystemConnector implements IConnector {
    readonly name = 'filesystem';
    readonly version = '1.0.0';
    readonly displayName = 'Local Filesystem';
    readonly description = 'Scans user-configured local directories for text-bearing files.';

    private lastSync: { at: string; items: number; error?: string } | null = null;

    constructor(private readonly opts: FilesystemConnectorOptions) {}

    isAuthenticated(): boolean {
        // Filesystem needs no auth; being able to read the files IS the auth.
        return true;
    }

    /**
     * Filesystem yields only one native record type: File. The proposed
     * mapping is intentionally absent — workspaces decide whether files
     * are know.Document, know.Memo, or something more domain-specific.
     */
    getNativeSchema(): ConnectorNativeSchema {
        return {
            types: [
                {
                    name: 'File',
                    description: 'A file on the local filesystem.',
                    fields: [
                        { name: 'absolutePath', type: 'string', required: true, description: 'Canonical path on disk.' },
                        { name: 'basename', type: 'string', required: true, description: 'Filename without directory.' },
                        { name: 'directory', type: 'string', required: true, description: 'Containing directory.' },
                        { name: 'mimeType', type: 'string', required: true, description: 'MIME inferred from extension.' },
                        { name: 'sizeBytes', type: 'number', required: true, description: 'File size in bytes.' },
                        { name: 'mtime', type: 'datetime', required: true, description: 'Last modification time.' },
                    ],
                },
            ],
        };
    }

    /**
     * Liveness: confirm at least one configured root resolves to an
     * existing directory we can stat. Cheap; no I/O beyond fs.existsSync.
     */
    async health(): Promise<HealthResult> {
        const start = Date.now();
        const dataHome = loreHome();
        const roots = resolveEffectiveRoots(this.opts.roots, dataHome);
        const reachable = roots.filter(r => {
            try { return fs.existsSync(r); } catch { return false; }
        });
        return {
            ok: reachable.length > 0,
            message: reachable.length > 0
                ? `${reachable.length} of ${roots.length} roots reachable`
                : `none of ${roots.length} configured roots reachable`,
            lastChecked: new Date().toISOString(),
            latencyMs: Date.now() - start,
        };
    }

    async *sync(opts: SyncOptions = {}): AsyncIterable<ConnectorItem> {
        const registry = this.opts.extractorRegistry;
        const workspaceRoot = this.opts.workspaceRoot;
        const dataHome = loreHome();

        // Resolve the effective root set. Audit 2026-05-14: defaults
        // (~/Documents etc.) only apply when the user has NOT explicitly
        // configured anything — once the config file exists, what's in it
        // IS the list, even if empty. This matches the new "your choices
        // are the source of truth" model in the end-user app's
        // Connectors UI.
        const configuredRoots = resolveEffectiveRoots(this.opts.roots, dataHome);

        const sinceMs = opts.since ? Date.parse(opts.since) : NaN;
        const maxItems = opts.maxItems ?? Infinity;

        let yielded = 0;
        let lastError: string | undefined;
        try {
            for (const root of configuredRoots) {
                if (!fs.existsSync(root)) continue;

                for (const entry of walkFiles(root)) {
                    if (yielded >= maxItems) break;

                    // Incremental: skip unchanged files.
                    if (!opts.fullSync && Number.isFinite(sinceMs)) {
                        if (entry.mtimeMs <= sinceMs) continue;
                    }

                    // Only yield files the extractor registry can handle.
                    const mime = registry.mimeFromPath(entry.path);
                    if (!mime) continue;

                    // Apply the S4 allowlist — same check the ingestion
                    // tool uses. Defense in depth: the user-configured
                    // roots might themselves be unsafe (e.g. someone
                    // configured ~/.aws). Allowlist refuses those.
                    try {
                        // re-audit 2026-06-25 — pass the roots actually being
                        // scanned as extraRoots, else every file under a
                        // user-configured ingestion.json/explicit root that
                        // isn't also under the default roots was silently
                        // dropped. assertPathAllowed still applies the blocklist
                        // (~/.ssh, ~/.aws, ~/.groundfloor) + credential-basename
                        // checks per-file, so an unsafe configured root is still refused.
                        assertPathAllowed(entry.path, { workspaceRoot, extraRoots: configuredRoots });
                    } catch (err) {
                        if (err instanceof PathAllowlistError) continue;
                        throw err;
                    }

                    let content: Buffer;
                    try {
                        content = fs.readFileSync(entry.path);
                    } catch {
                        continue; // file vanished between walk and read — skip
                    }

                    yield {
                        sourceId: `filesystem:${entry.path}`,
                        sourceUrl: `file://${entry.path}`,
                        mimeType: mime,
                        content,
                        metadata: {
                            absolutePath: entry.path,
                            basename: path.basename(entry.path),
                            directory: path.dirname(entry.path),
                            mtime: new Date(entry.mtimeMs).toISOString(),
                            sizeBytes: entry.size,
                        },
                        modifiedAt: new Date(entry.mtimeMs).toISOString(),
                    };
                    yielded++;
                }
                if (yielded >= maxItems) break;
            }
        } catch (err) {
            lastError = (err as Error).message;
            throw err;
        } finally {
            this.lastSync = {
                at: new Date().toISOString(),
                items: yielded,
                error: lastError,
            };
        }
    }

    getStatus(): ConnectorStatus {
        return {
            connected: true,
            lastSyncAt: this.lastSync?.at,
            itemsThisSync: this.lastSync?.items,
            error: this.lastSync?.error,
        };
    }
}

interface WalkEntry {
    path: string;
    mtimeMs: number;
    size: number;
}

/**
 * walkFiles — generator over regular files under `root`. Skips symlinks
 * (they'll re-appear through their canonical path if reachable) and
 * hidden `.` directories at any depth (to avoid ~/.cache, ~/.npm etc.
 * even if someone adds ~/Library as a root).
 */
function* walkFiles(root: string): Generator<WalkEntry> {
    const stack: string[] = [root];
    while (stack.length) {
        const current = stack.pop()!;
        let stat: fs.Stats;
        try { stat = fs.lstatSync(current); } catch { continue; }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
            // Skip hidden dirs — avoids spelunking into ~/.cache etc.
            const base = path.basename(current);
            if (base.startsWith('.') && current !== root) continue;
            let entries: string[];
            try { entries = fs.readdirSync(current); } catch { continue; }
            for (const e of entries) stack.push(path.join(current, e));
            continue;
        }
        if (!stat.isFile()) continue;
        yield { path: current, mtimeMs: stat.mtimeMs, size: stat.size };
    }
}
