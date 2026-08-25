/**
 * activeSessions.ts — Active-session tracker for the HTTP transport.
 *
 * Extracted from server.ts to keep that file inside the file-size cap.
 *
 * Audit 2026-05-13: hard cap + idle sweeper so a half-closed transport
 * (where `onclose` never fires for whatever reason) can't leak
 * indefinitely. The sweeper closes anything quiet for MAX_IDLE_MS and
 * the hard cap evicts the oldest entry to make room when over MAX.
 *
 * Wire format unchanged from the inline version — `dispatcher`-level
 * helpers (`touchActiveSession`, `evictActiveSession`) keep their
 * exact signatures so callers don't need updates.
 */

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const MAX = 50;
const MAX_IDLE_MS = 15 * 60 * 1000; // 15 minutes (SP-24: local daemon sees sub-minute reconnects)
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export interface ActiveSessionTracker {
    map: Map<string, StreamableHTTPServerTransport>;
    touch: (id: string) => void;
    evict: (id: string) => void;
    /** Cancellable timer — wire into onShutdown if needed. */
    sweepTimer: NodeJS.Timeout;
}

export interface ActiveSessionTrackerOpts {
    /** Override for tests; defaults to MAX (50). */
    maxSessions?: number;
    /** Override for tests; defaults to MAX_IDLE_MS (15 min). */
    maxIdleMs?: number;
    /** Override for tests; defaults to SWEEP_INTERVAL_MS (5 min). */
    sweepIntervalMs?: number;
}

export function createActiveSessionTracker(opts?: ActiveSessionTrackerOpts): ActiveSessionTracker {
    const max = opts?.maxSessions ?? MAX;
    const maxIdle = opts?.maxIdleMs ?? MAX_IDLE_MS;
    const sweepInterval = opts?.sweepIntervalMs ?? SWEEP_INTERVAL_MS;

    const map = new Map<string, StreamableHTTPServerTransport>();
    const lastSeen = new Map<string, number>();

    const touch = (id: string): void => {
        lastSeen.set(id, Date.now());
    };
    const evict = (id: string): void => {
        map.delete(id);
        lastSeen.delete(id);
    };

    const sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, ts] of lastSeen) {
            if (now - ts > maxIdle) {
                try { map.get(id)?.close(); } catch { /* ignore */ }
                evict(id);
            }
        }
        while (map.size > max) {
            const oldest = [...lastSeen.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
            if (!oldest) break;
            try { map.get(oldest)?.close(); } catch { /* ignore */ }
            evict(oldest);
        }
    }, sweepInterval);
    if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

    return { map, touch, evict, sweepTimer };
}
