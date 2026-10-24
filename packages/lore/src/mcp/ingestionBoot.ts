/**
 * mcp/ingestionBoot.ts - boot step: starts the ingestion host when (and only when) `LORE_INGEST_ENABLED` is on.
 *
 * Kept out of server.ts (size-baselined). With the flag off this returns a no-op handle without importing any
 * ingestion code. A failure here is logged by error class and degrades to the no-op handle: ingestion must
 * never stop the daemon from starting, and `stop()` never throws.
 */
import { log } from '../logger.js';
import { getWorkspacePath, listWorkspaceNames } from '../config/workspaces.js';
import { isIngestionEnabled, loadIngestHostConfig, type IngestHostConfig } from '../ingestion/hostConfig.js';
import type { IngestionHost } from '../ingestion/ingestionHost.js';

export interface IngestionBoot {
    host: IngestionHost | null;
    stop(): Promise<void>;
}

export interface IngestionBootOptions {
    lore: { nodeUpsert(a: any): Promise<any> };
    graphRegistry?: { tableStorageFor(workspace: string, o?: { touch?: boolean }): Promise<any> } | undefined;
    deploymentMode: string;
    mainPort: number;
    env?: NodeJS.ProcessEnv;
}

const NOOP: IngestionBoot = { host: null, stop: async () => undefined };

/**
 * The running host, for request handlers that cannot be handed it at construction (server.ts is size-baselined, so
 * the dispatcher reads it through this getter instead of a new deps field wired there). Null when ingestion is off,
 * failed to start, or has been stopped.
 */
let activeHost: IngestionHost | null = null;
export function getActiveIngestionHost(): IngestionHost | null { return activeHost; }

/** Everything the single host-construction path needs; the daemon and the embedded `createLore({ ingestion })` both fill it. */
export interface IngestionHostWiring extends Omit<IngestionBootOptions, 'env' | 'mainPort'> {
    /** The daemon's main port (the callback listener refuses to share it). Embedded hosts have none. */
    mainPort?: number;
    listWorkspaces: () => string[];
    workspacePath: (workspace: string) => string;
    /** Data root override (embedded: the instance's own `dataDir`). Unset = the process LORE_HOME (the daemon). */
    home?: string;
    /** Embedded only: false = never start the TickLoop (the host drives `runDue`). */
    autoRun?: boolean;
    /** Embedded only: a workspace registered after boot is eligible too. */
    dynamicEligibility?: boolean;
}

/** The ONE place an IngestionHost is built from a lore instance; startIngestionHost (daemon) and embeddedIngestion.ts call it. */
export async function startIngestionHostWith(config: IngestHostConfig, w: IngestionHostWiring): Promise<IngestionHost> {
    const { IngestionHost: Host } = await import('../ingestion/ingestionHost.js');
    return Host.start({
        config,
        lore: w.lore,
        ...(w.graphRegistry ? { tableStorageFor: (ws: string) => w.graphRegistry!.tableStorageFor(ws, { touch: false }) } : {}),
        deploymentMode: w.deploymentMode,
        ...(w.mainPort !== undefined ? { mainPort: w.mainPort } : {}),
        ...(w.home !== undefined ? { home: w.home } : {}),
        listWorkspaces: w.listWorkspaces,
        workspacePath: w.workspacePath,
        ...(w.autoRun !== undefined ? { autoRun: w.autoRun } : {}),
        ...(w.dynamicEligibility !== undefined ? { dynamicEligibility: w.dynamicEligibility } : {}),
    });
}

export async function startIngestionHost(o: IngestionBootOptions): Promise<IngestionBoot> {
    const env = o.env ?? process.env;
    if (!isIngestionEnabled(env)) return NOOP;
    try {
        const host = await startIngestionHostWith(loadIngestHostConfig(env), {
            ...o,
            listWorkspaces: () => listWorkspaceNames(),
            workspacePath: (ws) => getWorkspacePath(ws),
        });
        activeHost = host;
        return { host, stop: async () => { if (activeHost === host) activeHost = null; await host.stop(); } };
    } catch (e) {
        log.error(`[Ingest] failed to start (${e instanceof Error ? e.constructor.name : typeof e}); the daemon continues without ingestion`);
        return NOOP;
    }
}
