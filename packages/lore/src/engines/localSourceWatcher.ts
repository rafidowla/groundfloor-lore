/**
 * packages/lore/src/engines/localSourceWatcher.ts
 *
 * Watches a set of local file-system directories for changes to
 * knowledge-source files (Markdown, plain-text, etc.) and fires
 * a configurable callback so the daemon can schedule re-ingestion.
 *
 * This is the Lore Core CDC equivalent for local knowledge sources —
 * the counterpart to SyncEngine.pullRemote() for remote sources.
 *
 * Design:
 *   - Uses Node.js built-in `fs.watch` (no chokidar dependency).
 *   - Per-path debounce (default 800ms) collapses rapid save events.
 *   - Only files matching WATCH_EXTENSIONS are surfaced; temp/swap
 *     files are ignored via a simple exclusion filter.
 *   - Non-recursive by default for safety; opt-in via watchOptions.
 *
 * Recursive watching behaviour by platform:
 *   - macOS / Windows: `fs.watch({ recursive: true })` is native.
 *   - Linux: the kernel ignores the recursive flag on `inotify`-backed
 *     fs.watch. We work around this with a static pre-scan: at start()
 *     time all existing subdirectories (up to MAX_SUBDIR_DEPTH levels)
 *     are individually watched. Subdirectories CREATED after start()
 *     are not automatically picked up — daemon restart is required.
 *     This is a known v1 limitation; a chokidar upgrade would close it.
 *
 * Configuration:
 *   LORE_WATCH_PATHS      — Colon-separated list of absolute paths to watch.
 *                           Example: /docs:/workspace/notes
 *                           Empty or unset → watcher starts but does nothing.
 *   LORE_WATCH_EXTENSIONS — Comma-separated extensions (no dot) to track.
 *                           Default: md,txt,rst
 *   LORE_WATCH_RECURSIVE  — Set to 'true', '1', or 'yes' to watch subdirs.
 *
 * Boot integration:
 *   bootSteps.ts wires start() inside startFileWatcher() and stashes
 *   the instance on globalThis.__loreSourceWatcher so SIGTERM handlers
 *   can call stopAllLocalWatchers() → stop() cleanly.
 */

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_EXTENSIONS = new Set(['md', 'txt', 'rst']);
const DEFAULT_DEBOUNCE_MS = 800;

/** Maximum depth for the Linux static subdirectory pre-scan. */
const MAX_SUBDIR_DEPTH = 8;

/** Exclusion patterns for temp/swap/hidden files. */
const IGNORED_SUFFIXES = ['.swp', '.tmp', '~', '.DS_Store'];
const IGNORED_PREFIXES = ['.'];

function isWatchedFile(filePath: string, extensions: Set<string>): boolean {
    const base = path.basename(filePath);
    if (IGNORED_PREFIXES.some((p) => base.startsWith(p))) return false;
    if (IGNORED_SUFFIXES.some((s) => base.endsWith(s))) return false;
    const ext = base.split('.').pop() ?? '';
    return extensions.has(ext.toLowerCase());
}

/**
 * collectSubdirs — recursively enumerate all subdirectories under `dir`
 * up to `maxDepth` levels deep.
 *
 * Used as a Linux fallback: when the kernel silently ignores the
 * `recursive` flag we watch every existing subdirectory individually.
 * Permission-denied directories are silently skipped.
 */
function collectSubdirs(dir: string, maxDepth: number = MAX_SUBDIR_DEPTH): string[] {
    const result: string[] = [];
    const walk = (current: string, depth: number): void => {
        if (depth > maxDepth) return;
        try {
            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    const sub = path.join(current, entry.name);
                    result.push(sub);
                    walk(sub, depth + 1);
                }
            }
        } catch { /* permission denied or race-removed dir — skip */ }
    };
    walk(dir, 0);
    return result;
}

/** Callback invoked when a watched file is created or modified. */
export type SourceChangedCallback = (filePath: string) => void;

export class LocalSourceWatcher {
    private watchers: fs.FSWatcher[] = [];
    private debounceMap: Map<string, ReturnType<typeof setTimeout>> = new Map();
    private running = false;

    /**
     * Read watch paths from LORE_WATCH_PATHS env var.
     * Returns an empty array if the env var is unset or empty.
     */
    static readWatchPaths(): string[] {
        const raw = process.env.LORE_WATCH_PATHS ?? '';
        return raw.split(':').map((p) => p.trim()).filter(Boolean);
    }

    /**
     * Read watched extensions from LORE_WATCH_EXTENSIONS env var.
     * Falls back to DEFAULT_EXTENSIONS.
     */
    static readExtensions(): Set<string> {
        const raw = process.env.LORE_WATCH_EXTENSIONS ?? '';
        if (!raw.trim()) return new Set(DEFAULT_EXTENSIONS);
        return new Set(raw.split(',').map((e) => e.trim().toLowerCase().replace(/^\./, '')).filter(Boolean));
    }

    /**
     * Read recursive setting from LORE_WATCH_RECURSIVE env var.
     * Returns true only when the value is 'true', '1', or 'yes' (case-insensitive).
     */
    static readRecursive(): boolean {
        const v = (process.env.LORE_WATCH_RECURSIVE ?? '').toLowerCase();
        return v === 'true' || v === '1' || v === 'yes';
    }

    /**
     * watchOne — Create a single non-recursive fs.watch handle for `watchPath`
     * and push it onto this.watchers. Extracted to avoid duplication between
     * the top-level path and the Linux subdirectory pre-scan paths.
     *
     * The `baseDir` param is the directory that filenames emitted by the OS
     * are relative to (same as `watchPath` for non-recursive handles).
     */
    private watchOne(
        watchPath: string,
        baseDir: string,
        extensions: Set<string>,
        onChanged: SourceChangedCallback,
        debounceMs: number,
    ): void {
        try {
            const watcher = fs.watch(watchPath, { recursive: false }, (_, filename) => {
                if (!filename) return;
                const absPath = path.join(baseDir, filename);
                if (!isWatchedFile(absPath, extensions)) return;

                // Debounce: collapse rapid save events on the same file.
                const existing = this.debounceMap.get(absPath);
                if (existing) clearTimeout(existing);
                this.debounceMap.set(absPath, setTimeout(() => {
                    this.debounceMap.delete(absPath);
                    onChanged(absPath);
                }, debounceMs));
            });
            watcher.on('error', (err) => {
                console.warn(`[Lore Source Watcher] Error on ${watchPath}: ${(err as Error).message}`);
            });
            this.watchers.push(watcher);
        } catch (err) {
            console.warn(`[Lore Source Watcher] Failed to watch ${watchPath}: ${(err as Error).message}`);
        }
    }

    /**
     * start — Begin watching. Safe to call multiple times (no-op if running).
     *
     * @param onChanged   - Callback fired with the absolute path of each changed file.
     * @param watchPaths  - Override the paths to watch (else reads LORE_WATCH_PATHS).
     * @param debounceMs  - Debounce window in ms (default 800).
     * @param recursive   - Watch sub-directories recursively. Defaults to the
     *                      LORE_WATCH_RECURSIVE env var (false if unset).
     *
     *                      macOS / Windows: uses native fs.watch({ recursive }).
     *                      Linux: falls back to a static pre-scan — all existing
     *                      subdirs up to MAX_SUBDIR_DEPTH are watched individually.
     *                      Subdirs added after start() require a daemon restart.
     */
    start(
        onChanged: SourceChangedCallback,
        watchPaths?: string[],
        debounceMs: number = DEFAULT_DEBOUNCE_MS,
        recursive?: boolean,
    ): void {
        if (this.running) return;
        this.running = true;

        const paths = watchPaths ?? LocalSourceWatcher.readWatchPaths();
        const extensions = LocalSourceWatcher.readExtensions();
        const useRecursive = recursive ?? LocalSourceWatcher.readRecursive();

        if (paths.length === 0) {
            console.log('[Lore Source Watcher] No paths configured (LORE_WATCH_PATHS unset). Watcher idle.');
            return;
        }

        for (const watchPath of paths) {
            if (!fs.existsSync(watchPath)) {
                console.warn(`[Lore Source Watcher] Path does not exist, skipping: ${watchPath}`);
                continue;
            }

            const isLinux = process.platform === 'linux';

            if (useRecursive && isLinux) {
                // Linux fallback: watch the top-level dir + all existing subdirs
                // individually (recursive flag is silently ignored by the kernel).
                this.watchOne(watchPath, watchPath, extensions, onChanged, debounceMs);
                const subdirs = collectSubdirs(watchPath);
                for (const sub of subdirs) {
                    this.watchOne(sub, sub, extensions, onChanged, debounceMs);
                }
                console.log(
                    `[Lore Source Watcher] Watching: ${watchPath} (${[...extensions].join(', ')})` +
                    ` [Linux: ${subdirs.length + 1} dirs pre-scanned; new subdirs require restart]`,
                );
            } else {
                // macOS / Windows: native recursive support; or non-recursive mode on any platform.
                try {
                    const watcher = fs.watch(watchPath, { recursive: useRecursive }, (_, filename) => {
                        if (!filename) return;
                        const absPath = path.join(watchPath, filename);
                        if (!isWatchedFile(absPath, extensions)) return;

                        const existing = this.debounceMap.get(absPath);
                        if (existing) clearTimeout(existing);
                        this.debounceMap.set(absPath, setTimeout(() => {
                            this.debounceMap.delete(absPath);
                            onChanged(absPath);
                        }, debounceMs));
                    });
                    watcher.on('error', (err) => {
                        console.warn(`[Lore Source Watcher] Error on ${watchPath}: ${(err as Error).message}`);
                    });
                    this.watchers.push(watcher);
                    console.log(`[Lore Source Watcher] Watching: ${watchPath} (${[...extensions].join(', ')})`);
                } catch (err) {
                    console.warn(`[Lore Source Watcher] Failed to watch ${watchPath}: ${(err as Error).message}`);
                }
            }
        }
    }

    /**
     * stop — Close all fs.watch handles and cancel pending debounce timers.
     * Safe to call if never started (no-op).
     */
    async stop(): Promise<void> {
        for (const timer of this.debounceMap.values()) clearTimeout(timer);
        this.debounceMap.clear();
        for (const w of this.watchers) {
            try { w.close(); } catch { /* ignore close errors on shutdown */ }
        }
        this.watchers = [];
        this.running = false;
    }

    /** Returns true if the watcher is currently running. */
    get isRunning(): boolean { return this.running; }

    /** Returns the number of active fs.watch handles. */
    get watcherCount(): number { return this.watchers.length; }
}
