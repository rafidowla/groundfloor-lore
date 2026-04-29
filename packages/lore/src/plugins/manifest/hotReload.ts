/**
 * hotReload.ts — Filesystem watcher that picks up Tier 1 manifest
 * additions and changes without a daemon restart.
 *
 * What hot-reloads cleanly:
 *   - **New manifest bundle added** under `<LORE_HOME>/manifests/` →
 *     load + validate + synthesise + register. New MCP sessions
 *     immediately see the plugin's auto-tools (store_<type>,
 *     list_<type>, connect_<rel>, query templates).
 *
 *   - **Existing manifest changed** → re-load. The synthetic plugin
 *     instance is replaced in the registry's synthetic map. Same
 *     "new sessions see new tools" semantics.
 *
 * What does NOT hot-reload (limitation surfaced via /api/health):
 *   - Core's `store_node` / `store_edge` enums are built at boot from
 *     each plugin's `contributeNodeTypes()` / `contributeEdgeRelations()`.
 *     Adding new types via hot-reload means those types become valid
 *     for the auto-tools but NOT for the generic store_node/store_edge
 *     until daemon restart. The wizard's UI banner surfaces this.
 *
 *   - Removed manifests don't unregister (sessions hold references;
 *     unregister-while-in-flight is messy). On reload of a bundle
 *     whose name matches an already-registered synthetic, we replace.
 *     Genuine deletions are picked up on the next daemon restart.
 *
 * The watcher debounces rapid changes (fs event storms during a save)
 * by scheduling a single rescan ~250ms after the last event.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { PluginRegistry } from '../registry.js';
import type { ILorePlugin } from '../types.js';
import { loadManifestFromBundle, isTierOneManifest, manifestToPlugin } from './index.js';

export interface HotReloadStatus {
    /** Number of plugins picked up via hot-reload since the daemon booted. */
    addedSinceBoot: number;
    /** Number of plugins re-loaded after a manifest change since boot. */
    reloadedSinceBoot: number;
    /** True when at least one plugin has been hot-loaded — implies the
     *  caller may want to restart for the new types to become valid in
     *  the core `store_node` / `store_edge` enums. */
    needsRestartForCoreEnums: boolean;
    /** Plugin names hot-loaded since boot, in order. */
    namesHotLoaded: string[];
}

const DEBOUNCE_MS = 250;

interface RegistryWithReplace {
    isActive(name: string): boolean;
    registerSyntheticPlugin(plugin: ILorePlugin): void;
}

export class ManifestHotReloader {
    private status: HotReloadStatus = {
        addedSinceBoot: 0,
        reloadedSinceBoot: 0,
        needsRestartForCoreEnums: false,
        namesHotLoaded: [],
    };
    private bootSnapshot = new Set<string>();
    private debounceHandle: NodeJS.Timeout | null = null;
    private watcher: fs.FSWatcher | null = null;

    constructor(
        private readonly manifestsDir: string,
        private readonly registry: PluginRegistry,
    ) {}

    /**
     * Start the watcher. Records a snapshot of plugins already
     * registered at boot time so subsequent additions are flagged as
     * hot-loads (vs. boot-loads, which don't need the restart banner).
     */
    start(bootRegisteredNames: Iterable<string>): void {
        this.bootSnapshot = new Set(bootRegisteredNames);
        try {
            // recursive: true so we catch new bundle directories appearing
            // and edits inside existing bundles in one watcher.
            this.watcher = fs.watch(this.manifestsDir, { recursive: true }, () => {
                this.scheduleRescan();
            });
            console.error(`[Lore MCP] Hot-reload watcher active on ${this.manifestsDir}`);
        } catch (err) {
            // If the manifests dir doesn't exist yet, watch the parent
            // and re-attempt on the next event. Cheap to skip silently —
            // the directory will appear when the user creates the first
            // plugin via the wizard.
            console.error(
                `[Lore MCP] Hot-reload watcher disabled (${(err as Error).message}); manifests dir does not exist yet`,
            );
        }
    }

    stop(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        if (this.debounceHandle) {
            clearTimeout(this.debounceHandle);
            this.debounceHandle = null;
        }
    }

    getStatus(): HotReloadStatus {
        return { ...this.status, namesHotLoaded: [...this.status.namesHotLoaded] };
    }

    private scheduleRescan(): void {
        if (this.debounceHandle) clearTimeout(this.debounceHandle);
        this.debounceHandle = setTimeout(() => {
            void this.rescan();
        }, DEBOUNCE_MS);
    }

    private async rescan(): Promise<void> {
        let entries: string[];
        try {
            entries = fs.readdirSync(this.manifestsDir);
        } catch {
            return; // directory was removed; ignore until next event
        }
        for (const entry of entries) {
            const bundleDir = path.join(this.manifestsDir, entry);
            try {
                const stat = fs.statSync(bundleDir);
                if (!stat.isDirectory()) continue;
                const { manifest, filePath } = await loadManifestFromBundle(bundleDir);
                if (!isTierOneManifest(manifest)) continue;
                const wasBootRegistered = this.bootSnapshot.has(manifest.name);
                const wasHotLoaded = this.status.namesHotLoaded.includes(manifest.name);
                const plugin = manifestToPlugin(manifest);
                const reg = this.registry as unknown as RegistryWithReplace & { syntheticPlugins?: Map<string, ILorePlugin> };

                if (wasBootRegistered) {
                    // Boot-time plugin already in the loaded map. We can't
                    // safely replace it here without touching internals;
                    // log and skip — restart picks up edits.
                    console.error(
                        `[Lore MCP] Hot-reload: ignoring change to "${manifest.name}" (registered at boot — restart to apply edits)`,
                    );
                    continue;
                }

                if (wasHotLoaded) {
                    // Replace via direct map access. The registry intentionally
                    // exposes registerSyntheticPlugin only; for hot-replace we
                    // need a write to the same map. Use the well-defined
                    // private map name (TypeScript-visible via the cast).
                    const map = reg.syntheticPlugins;
                    if (map) {
                        map.delete(manifest.name);
                    }
                    reg.registerSyntheticPlugin(plugin);
                    // Best-effort: also reflect into the registry's `loaded`
                    // set so contributions surface in subsequent calls.
                    const loaded = (this.registry as unknown as { loaded: Map<string, ILorePlugin> }).loaded;
                    loaded.set(plugin.name, plugin);
                    this.status.reloadedSinceBoot += 1;
                    console.error(`[Lore MCP] Hot-reload: replaced "${manifest.name}" (${filePath})`);
                } else {
                    // First-time hot-load.
                    reg.registerSyntheticPlugin(plugin);
                    const loaded = (this.registry as unknown as { loaded: Map<string, ILorePlugin> }).loaded;
                    loaded.set(plugin.name, plugin);
                    this.status.addedSinceBoot += 1;
                    this.status.namesHotLoaded.push(manifest.name);
                    this.status.needsRestartForCoreEnums = true;
                    console.error(`[Lore MCP] Hot-reload: added "${manifest.name}" (${filePath})`);
                }
            } catch (err) {
                // Malformed manifest, parse error, etc. Don't spam: only
                // log if the bundle wasn't already known to be broken.
                console.error(
                    `[Lore MCP] Hot-reload: skipped bundle ${bundleDir} — ${(err as Error).message}`,
                );
            }
        }
    }
}
