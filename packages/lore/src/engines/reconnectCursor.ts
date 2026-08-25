/**
 * reconnectCursor.ts — Persistent last-reconnect cursor (Phase 4 / C6.5).
 *
 * After a full or incremental reconnect with `apply: true`, record the
 * wall-clock time so the next `--incremental` run can filter to nodes
 * changed since. Stored in workspace-local state, not a global file,
 * so each workspace reconnects on its own schedule.
 */

import * as fs from 'fs';
import * as path from 'path';

interface CursorFile {
    version: 1;
    lastReconnectAt: string;  // ISO-8601
    lastReconnectMode: 'full' | 'incremental';
    lastReconnectResult: {
        candidatesScanned: number;
        embeddingsAdded: number;
        embeddingsSkipped: number;
        coreEdgesInserted: number;
    };
}

function cursorPath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.lore', 'reconnect.state.json');
}

export function readCursor(workspaceRoot: string): CursorFile | null {
    const p = cursorPath(workspaceRoot);
    if (!fs.existsSync(p)) return null;
    try {
        return JSON.parse(fs.readFileSync(p, 'utf-8')) as CursorFile;
    } catch {
        return null;
    }
}

export function writeCursor(
    workspaceRoot: string,
    mode: 'full' | 'incremental',
    result: { candidatesScanned: number; embeddingsAdded: number; embeddingsSkipped: number; coreEdgesInserted: number },
    stampedAt?: string,
): void {
    const p = cursorPath(workspaceRoot);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const payload: CursorFile = {
        version: 1,
        // `stampedAt` must be the SWEEP START time, captured before the sweep
        // began reading — not completion 'now'. The sweep only covers nodes as
        // of when it started; stamping it with finish time makes every future
        // incremental run filter to `updatedAt > <finish>`, permanently
        // skipping anything written DURING the sweep.
        lastReconnectAt: stampedAt ?? new Date().toISOString(),
        lastReconnectMode: mode,
        lastReconnectResult: result,
    };
    fs.writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
}
