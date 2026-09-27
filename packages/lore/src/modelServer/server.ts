/**
 * modelServer/server.ts — process lifecycle for the shared model server
 * (D9 §5.4 "Server lifecycle (O4)"): startup liveness check, atomic token
 * write before listen, pidfile, idle exit, bootstrap timeout, graceful
 * SIGTERM/`shutdown` handling.
 *
 * `runModelServer()` is the whole process's job — it never returns while
 * the server is healthy; it resolves (after calling `process.exit(0)`)
 * only once the server has decided to shut down. Call it from `main.ts`.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { resolveLoreHome } from '../config/loreHome.js';
import { serverKey, runDir, socketPath, tokenPath, pidPath, logPath, privateDirProblem } from './paths.js';
import { serverClaimLock, releaseLockIfOwned, readPidFile, isPidAlive } from './spawnLock.js';
import { PROTOCOL_VERSION, constantTimeEqStr } from './protocol.js';
import {
    MODEL_SERVER_IDLE_EXIT_MS,
    MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS,
    MODEL_SERVER_MAX_CLIENTS,
    MODEL_SERVER_TEXT_CHAR_LIMIT,
    MODEL_SERVER_QUEUE_MAX_PER_CLIENT,
    MODEL_SERVER_RERANK_MAX_CONCURRENT,
} from './config.js';
import { setRerankMaxConcurrentScoreRuns } from '../providers/localRerankProvider.js';
import { ModelServerLogger } from './log.js';
import { EmbedQueue } from './queue.js';
import { attachConnection, type StatusSnapshot } from './connection.js';
import { servedModels } from './handlers.js';

const TOKEN_BYTES = 32;

/** What is at `sockPath`? `absent`/`refused` (ENOENT/ECONNREFUSED) are the
 *  only answers that let a new server unlink it; `live` (something accepted
 *  the connect) and `unknown` (timeout, EACCES, ...) both mean "not ours to
 *  touch" (review blocker A). */
function probeExistingServer(sockPath: string, timeoutMs = 1000): Promise<'absent' | 'refused' | 'live' | 'unknown'> {
    return new Promise((resolve) => {
        if (!fs.existsSync(sockPath)) {
            resolve('absent');
            return;
        }
        const sock = net.createConnection(sockPath);
        let settled = false;
        const done = (result: 'absent' | 'refused' | 'live' | 'unknown'): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.destroy();
            resolve(result);
        };
        const timer = setTimeout(() => done('unknown'), timeoutMs);
        sock.once('connect', () => done('live'));
        sock.once('error', (err: NodeJS.ErrnoException) => {
            done(err.code === 'ENOENT' ? 'absent' : err.code === 'ECONNREFUSED' ? 'refused' : 'unknown');
        });
    });
}

function writeTokenAtomic(path_: string, token: string): void {
    const tmp = `${path_}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, token, { mode: 0o600 });
    try {
        fs.chmodSync(tmp, 0o600);
    } catch {
        /* best-effort — perms are best-effort on non-POSIX */
    }
    fs.renameSync(tmp, path_);
}

export async function runModelServer(): Promise<void> {
    const loreHome = resolveLoreHome();
    const key = serverKey(loreHome);
    const dir = runDir(loreHome, key);
    const sockPath = socketPath(loreHome, key);
    const tokPath = tokenPath(loreHome, key);
    const pidFilePath = pidPath(loreHome, key);
    const log = new ModelServerLogger(logPath(loreHome));
    setRerankMaxConcurrentScoreRuns(MODEL_SERVER_RERANK_MAX_CONCURRENT);

    // Both directories are created 0700 and then verified (review SF5):
    // `sockPath` may be the tmpdir-rooted SUN_PATH fallback (paths.ts
    // `fallbackSocketPath`) — a world-writable parent where another user
    // could pre-create `lore-<uid>` or plant a symlink. It must exist before
    // `listen()` binds into it (a missing parent fails with EACCES on macOS).
    const sockDir = path.dirname(sockPath);
    for (const d of sockDir === dir ? [dir] : [dir, sockDir]) {
        const problem = privateDirProblem(d, true);
        if (problem) {
            log.error('refusing to start: unsafe model-server directory', { problem });
            process.exit(1);
        }
    }
    log.info('model server starting', { key, pid: process.pid });

    // Blocker A: exactly one server per key. Win the lock first (it names
    // our spawner, or nobody live); a loser exits 0 having touched nothing.
    const lockLoss = await serverClaimLock(loreHome, key);
    if (lockLoss) {
        log.info('another process owns this key — exiting', { key, reason: lockLoss });
        process.exit(0);
    }
    const yieldTo = async (why: string): Promise<never> => {
        await releaseLockIfOwned(loreHome, key);
        log.info(`${why} — exiting`, { key, socketPath: sockPath });
        process.exit(0);
    };
    const existing = await probeExistingServer(sockPath);
    if (existing === 'live' || existing === 'unknown') await yieldTo(`socket is ${existing === 'live' ? 'answered by another server' : 'in an unknown state'}`);
    const priorPid = readPidFile(pidFilePath);
    if (priorPid !== null && priorPid !== process.pid && isPidAlive(priorPid)) await yieldTo(`pidfile names live pid ${priorPid}`);
    // Stale socket from a dead prior instance (connect refused AND its
    // recorded owner is gone) — the only case where we may clear it.
    if (existing === 'refused') {
        try {
            fs.rmSync(sockPath, { force: true });
        } catch {
            /* best-effort */
        }
    }

    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    writeTokenAtomic(tokPath, token);

    const embedQueue = new EmbedQueue();
    const startedAt = Date.now();
    const clients = new Set<string>();
    const activeSockets = new Set<net.Socket>();
    let inFlight = 0;
    let idleTimer: NodeJS.Timeout | undefined;
    let bootstrapTimer: NodeJS.Timeout | undefined;
    let everConnected = false;
    let shuttingDown = false;
    let closePromise: Promise<void> | undefined;

    const server = net.createServer({ allowHalfOpen: false });

    const isIdle = (): boolean => clients.size === 0 && inFlight === 0 && embedQueue.depth() === 0;

    const clearIdleTimer = (): void => {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
        }
    };
    const armIdleTimer = (): void => {
        if (shuttingDown || MODEL_SERVER_IDLE_EXIT_MS <= 0) return;
        clearIdleTimer();
        idleTimer = setTimeout(() => {
            if (isIdle()) {
                log.info('idle timeout — exiting', { idleMs: MODEL_SERVER_IDLE_EXIT_MS });
                void gracefulClose();
            }
        }, MODEL_SERVER_IDLE_EXIT_MS);
        idleTimer.unref?.();
    };
    const reconsiderIdle = (): void => {
        if (isIdle()) armIdleTimer();
        else clearIdleTimer();
    };

    const getStatus = (): StatusSnapshot => ({
        pid: process.pid,
        uptimeMs: Date.now() - startedAt,
        clients: clients.size,
        queueDepth: embedQueue.depth(),
        protocolVersion: PROTOCOL_VERSION,
        idleMs: MODEL_SERVER_IDLE_EXIT_MS,
        rssBytes: process.memoryUsage.rss(),
        models: servedModels(),
    });

    const requestShutdown = (presented: string): boolean => {
        if (!constantTimeEqStr(presented, token)) return false;
        log.info('shutdown requested via protocol message');
        // Deferred so the caller's `shutdownOk` response frame is flushed
        // to the socket before the server starts tearing itself down.
        setTimeout(() => void gracefulClose(), 0);
        return true;
    };

    function gracefulClose(): Promise<void> {
        if (closePromise) return closePromise;
        shuttingDown = true;
        clearIdleTimer();
        if (bootstrapTimer) clearTimeout(bootstrapTimer);
        closePromise = new Promise<void>((resolve) => {
            server.close(() => {
                void (async () => {
                    // Blocker A: delete only files that are provably ours. The
                    // pidfile is checked before sock/token (a successor can
                    // only have replaced them after our pid was dead), and the
                    // lock is released last so no successor can claim the key
                    // while our files are still on disk.
                    if (readPidFile(pidFilePath) === process.pid) {
                        for (const p of [sockPath, tokPath, pidFilePath]) {
                            try {
                                fs.rmSync(p, { force: true });
                            } catch {
                                /* best-effort */
                            }
                        }
                    }
                    try {
                        await releaseLockIfOwned(loreHome, key);
                    } catch {
                        /* best-effort */
                    }
                    log.info('server closed');
                    resolve();
                    process.exit(0);
                })();
            });
            // Stop accepting new connections immediately (server.close does
            // that); give in-flight connections a short grace period to
            // finish on their own, then force them closed so shutdown is
            // never blocked indefinitely by one straggling socket.
            const forceTimer = setTimeout(() => {
                for (const s of activeSockets) {
                    try {
                        s.destroy();
                    } catch {
                        /* best-effort */
                    }
                }
            }, 5000);
            forceTimer.unref?.();
        });
        return closePromise;
    }

    server.on('connection', (socket: net.Socket) => {
        if (shuttingDown) {
            socket.destroy();
            return;
        }
        if (clients.size >= MODEL_SERVER_MAX_CLIENTS) {
            log.warn('max clients reached — refusing connection', { max: MODEL_SERVER_MAX_CLIENTS });
            socket.destroy();
            return;
        }
        activeSockets.add(socket);
        socket.on('close', () => activeSockets.delete(socket));
        attachConnection(socket, {
            token,
            embedQueue,
            log,
            queueMaxPerClient: MODEL_SERVER_QUEUE_MAX_PER_CLIENT,
            textCharLimit: MODEL_SERVER_TEXT_CHAR_LIMIT,
            onClientConnect: (clientId) => {
                everConnected = true;
                if (bootstrapTimer) {
                    clearTimeout(bootstrapTimer);
                    bootstrapTimer = undefined;
                }
                clients.add(clientId);
                clearIdleTimer();
                log.info('client connected', { clientId, clients: clients.size });
            },
            onClientDisconnect: (clientId) => {
                clients.delete(clientId);
                log.info('client disconnected', { clientId, clients: clients.size });
                reconsiderIdle();
            },
            onActivityStart: () => {
                inFlight++;
                clearIdleTimer();
            },
            onActivityEnd: () => {
                inFlight = Math.max(0, inFlight - 1);
                reconsiderIdle();
            },
            getStatus,
            requestShutdown,
        });
    });

    server.on('error', (err) => {
        log.error('server error', { error: err instanceof Error ? err.message : String(err) });
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(sockPath, () => {
            server.removeListener('error', reject);
            resolve();
        });
    });

    try {
        fs.chmodSync(sockPath, 0o600);
    } catch {
        /* best-effort — the 0700 run dir already restricts access */
    }
    // The lock already names us (serverClaimLock); the pidfile follows the
    // listen so a pidfile always names a server that has bound the socket.
    fs.writeFileSync(pidFilePath, String(process.pid), { mode: 0o600 });

    log.info('model server listening', { socketPath: sockPath, key, pid: process.pid, protocolVersion: PROTOCOL_VERSION });

    if (MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS > 0) {
        bootstrapTimer = setTimeout(() => {
            if (!everConnected) {
                log.info('no client connected within bootstrap timeout — exiting', {
                    bootstrapTimeoutMs: MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS,
                });
                void gracefulClose();
            }
        }, MODEL_SERVER_BOOTSTRAP_TIMEOUT_MS);
        bootstrapTimer.unref?.();
    }

    const onSignal = (sig: string): void => {
        log.info(`${sig} received — shutting down gracefully`);
        void gracefulClose();
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
}
