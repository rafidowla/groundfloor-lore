/**
 * index.ts — Connector bootstrap (Phase 2 / C5).
 *
 * Mirrors the extractor bootstrap: one place that knows "these are the
 * connectors core ships by default." Plugins can register additional
 * connectors on the returned registry before the first sync.
 */

import { ConnectorRegistry } from './registry.js';
import { FilesystemConnector } from './filesystem.js';
import type { ExtractorRegistry } from '../extractors/registry.js';

export { ConnectorRegistry } from './registry.js';
export type { IConnector, ConnectorItem, ConnectorStatus, SyncOptions } from './types.js';
export { FilesystemConnector } from './filesystem.js';

/**
 * buildDefaultConnectors — register every built-in connector.
 *
 * @param extractorRegistry  used by FilesystemConnector for mime
 *   inference and by future connectors to decide which files to yield.
 * @param workspaceRoot  passed to the S4 allowlist so files under
 *   the active workspace clear the check.
 */
export function buildDefaultConnectors(
    extractorRegistry: ExtractorRegistry,
    workspaceRoot?: string,
): ConnectorRegistry {
    const registry = new ConnectorRegistry();
    registry.register(
        new FilesystemConnector({ extractorRegistry, workspaceRoot }),
    );
    return registry;
}
