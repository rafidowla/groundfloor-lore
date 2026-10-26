/**
 * workspaceErase/wiring.ts — one-call boot wiring for the scheduled erase tick (lane f6b).
 *
 * Called EAGERLY, once per host, from `mcp/server.ts` — the same boot path serves the long-running daemon and an
 * embedded `createLore()` instance, and (unlike the daemon-only timers) the tick is NOT gated on
 * `startsDaemonTimers`: an embedded host that deletes a workspace must also erase it. The handle's `stop()` is
 * spread into the shutdown drain (`workspaceEraseTick`), which the embedded `dispose()` runs as well.
 */

import { readEraseWindow } from './config.js';
import { startEraseTick, type EraseTickHandle } from './tick.js';
import type { LifecycleDeps } from './lifecycle.js';

export interface WorkspaceEraseWiring { workspaceEraseTick: EraseTickHandle }

export function wireWorkspaceEraseTick(dataHome: string, extra: Partial<LifecycleDeps> = {}): WorkspaceEraseWiring {
    const w = readEraseWindow();
    if (w.invalid) console.error(`[Lore] LORE_WORKSPACE_ERASE_AFTER_DAYS is not an integer between 0 and 3650; using the default of ${w.days} days.`);
    return { workspaceEraseTick: startEraseTick({ deps: { home: dataHome, ...extra } }) };
}
