/**
 * fileWatcherEngine.ts — v1.1 file-watcher dispatch.
 *
 * Watches paths each plugin contributes via `contributeWatchedPaths`,
 * dispatches change events to that plugin's `onFileChange` hook.
 * Provides incremental indexing without the user manually running
 * `lore reconnect` after every code edit.
 *
 * Architecture:
 *   - One chokidar watcher per (plugin, repo). Splitting per-repo (rather
 *     than one super-watcher) keeps the dispatch simple and lets us
 *     attach the right `repo` label to every event.
 *   - Per-path debouncing: events on the same absPath inside a 500ms
 *     window collapse to one. Handles git-checkout / build-tool storms.
 *   - Errors in plugin handlers are logged but don't stop the watcher;
 *     file events are noisy and one bad file shouldn't kill anything.
 *
 * Lifecycle:
 *   1. Daemon boot calls `engine.start(activePlugins, ctx)` after
 *      registerSchemas.
 *   2. Each plugin's contributeWatchedPaths is called; the returned
 *      paths are watched.
 *   3. Daemon shutdown / restart calls `engine.stop()` to close
 *      handles cleanly.
 *
 * Limitations of this v1:
 *   - No `.gitignore` filtering — plugins must filter inside
 *     onFileChange (developer plugin already calls `getLanguageFor`
 *     which returns null for unknown extensions; that's the natural
 *     filter).
 *   - No batching across multiple paths in one event window. Each
 *     path's debounce is independent. A `git checkout` that touches
 *     1000 files will fire 1000 plugin handler calls. v1.1.1 follow-up
 *     to add a per-plugin batch delivery option.
 *   - No watcher restart on registry changes. If a new repo is
 *     `addRepo`'d while the daemon runs, the watcher doesn't pick
 *     it up until the next daemon restart. v1.1.1 follow-up.
 *
 * License: original work for groundfloor-lore.
 */

import * as path from 'node:path';
import type { ILorePlugin, PluginContext, PluginGraphContext } from '../plugins/types.js';

interface WatchedPath {
    pluginName: string;
    absPath: string;
    repo: string;
}

interface ChokidarWatcher {
    on(event: string, handler: (path: string) => void): this;
    close(): Promise<void>;
}

/** Per-event payload dispatched to plugins. Mirrors the type in plugins/types.ts. */
interface FileChangeEvent {
    kind: 'add' | 'change' | 'unlink';
    absPath: string;
    relPath: string;
    repo: string;
}

const DEBOUNCE_MS = 500;

export class FileWatcherEngine {
    private watchers: ChokidarWatcher[] = [];
    private timers: Map<string, NodeJS.Timeout> = new Map();
    private started: boolean = false;

    async start(
        activePlugins: ILorePlugin[],
        pluginCtx: PluginContext,
        graphCtx: PluginGraphContext,
    ): Promise<void> {
        if (this.started) return;
        this.started = true;

        // Collect all contributeWatchedPaths from active plugins.
        const allPaths: WatchedPath[] = [];
        for (const plugin of activePlugins) {
            if (typeof plugin.contributeWatchedPaths !== 'function') continue;
            try {
                const contributed = await plugin.contributeWatchedPaths(pluginCtx);
                for (const entry of contributed ?? []) {
                    if (entry.absPath) {
                        allPaths.push({
                            pluginName: plugin.name,
                            absPath: entry.absPath,
                            repo: entry.repo,
                        });
                    }
                }
            } catch (err) {
                console.error(`[file-watcher] plugin ${plugin.name} contributeWatchedPaths failed: ${(err as Error).message}`);
            }
        }

        if (allPaths.length === 0) {
            console.error('[file-watcher] no plugins contributed watched paths; engine idle');
            return;
        }

        // Lazy-import chokidar to avoid pulling it in if no plugin watches.
        let chokidar: { watch: (paths: string[], opts?: Record<string, unknown>) => ChokidarWatcher };
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            chokidar = await import('chokidar');
        } catch (err) {
            console.error(`[file-watcher] chokidar not available (${(err as Error).message}); skipping`);
            return;
        }

        // Group paths by plugin so the dispatch path can find the right plugin.
        const pluginsByName = new Map<string, ILorePlugin>();
        for (const p of activePlugins) pluginsByName.set(p.name, p);

        for (const watched of allPaths) {
            const plugin = pluginsByName.get(watched.pluginName);
            if (!plugin || typeof plugin.onFileChange !== 'function') continue;

            const watcher = chokidar.watch([watched.absPath], {
                ignoreInitial: true,             // don't fire for existing files
                ignored: [
                    /(^|[/\\])\../,              // dotfiles + .git
                    /node_modules/,
                    /[/\\]dist[/\\]/,
                    /[/\\]build[/\\]/,
                    /[/\\]\.lore[/\\]/,           // Lore's own data dir
                ],
                awaitWriteFinish: {
                    stabilityThreshold: 200,
                    pollInterval: 100,
                },
                persistent: true,
            }) as ChokidarWatcher;

            const dispatch = (kind: 'add' | 'change' | 'unlink') => (filePath: string) => {
                this.scheduleDispatch(plugin, graphCtx, {
                    kind,
                    absPath: filePath,
                    relPath: path.relative(watched.absPath, filePath),
                    repo: watched.repo,
                });
            };

            watcher.on('add', dispatch('add'));
            watcher.on('change', dispatch('change'));
            watcher.on('unlink', dispatch('unlink'));
            watcher.on('error', (errLike: unknown) => {
                console.error(`[file-watcher] error on ${watched.absPath}: ${(errLike as Error)?.message ?? errLike}`);
            });

            this.watchers.push(watcher);
            console.error(`[file-watcher] watching ${watched.absPath} (plugin=${plugin.name}, repo=${watched.repo})`);
        }

        console.error(`[file-watcher] started: ${this.watchers.length} watcher(s) across ${activePlugins.length} plugin(s)`);
    }

    /**
     * Per-path debouncer. Multiple events on the same absPath inside
     * DEBOUNCE_MS collapse to one — important for `git checkout` storms
     * (chokidar fires add/unlink/change in rapid succession on the
     * same path during a checkout).
     */
    private scheduleDispatch(
        plugin: ILorePlugin,
        graphCtx: PluginGraphContext,
        event: FileChangeEvent,
    ): void {
        const key = `${event.absPath}::${event.kind}`;
        const existing = this.timers.get(key);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(async () => {
            this.timers.delete(key);
            try {
                await plugin.onFileChange?.(event, graphCtx);
            } catch (err) {
                console.error(`[file-watcher] ${plugin.name}.onFileChange failed for ${event.relPath}: ${(err as Error).message}`);
            }
        }, DEBOUNCE_MS);
        this.timers.set(key, timer);
    }

    async stop(): Promise<void> {
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
        await Promise.allSettled(this.watchers.map((w) => w.close()));
        this.watchers = [];
        this.started = false;
    }
}
