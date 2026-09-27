/**
 * cli/commands/modelsServer.ts — `lore models server status` / `lore models
 * server stop` (D9 §5.5 item 5, Lore 3.24 slice C2b).
 *
 * Talks to the shared local model server (`modelServer/`) directly over its
 * own Unix-domain-socket protocol (`modelServer/protocol.ts`) — a one-shot
 * connect/hello/request/close, not the persistent restart/fallback client
 * slice C2a builds for hosts. There is nothing here to reuse from that
 * client: a CLI status/stop check needs exactly one request-response and
 * then exits, so a minimal raw connection is simpler than depending on a
 * long-lived client's state machine.
 *
 * `status` never fails just because nothing is running — that's the normal
 * "not running" case, reported and exited 0. `stop` never sends a signal:
 * per D9 §5.5, a failed graceful shutdown is reported non-zero and left for
 * a human, not force-killed by pattern.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import { loreHome } from '../../config/loreHome.js';
import { serverKey, socketPath, tokenPath, pidPath } from '../../modelServer/paths.js';
import { FrameDecoder, encodeFrame, PROTOCOL_VERSION, type DecodeEvent } from '../../modelServer/protocol.js';

const CONNECT_TIMEOUT_MS = 2000;
const HELLO_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10000;

export async function modelsServerCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub === 'status') {
        await serverStatusCommand(args.slice(1));
        return;
    }
    if (sub === 'stop') {
        await serverStopCommand(args.slice(1));
        return;
    }
    console.error('usage: lore models server status [--json]');
    console.error('       lore models server stop');
    console.error('');
    console.error('       Status/control for the shared local model server (D9, Lore 3.24) —');
    console.error('       the background process that serves ONNX embedding/rerank inference');
    console.error('       to every local Lore host over a Unix domain socket. See');
    console.error('       docs/MIGRATION-3.24.md and docs/design/D9-shared-model-server.md.');
    process.exit(1);
}

// ─── Wire helper — one-shot raw connection, no restart/fallback ──────────

interface WireClient {
    readonly socket: net.Socket;
    send(header: Record<string, unknown>, body?: Buffer): void;
    nextFrame(timeoutMs?: number): Promise<DecodeEvent>;
    close(): void;
}

function connectRaw(sockPath: string): Promise<WireClient> {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(sockPath);
        const decoder = new FrameDecoder();
        const pending: DecodeEvent[] = [];
        const waiters: Array<(ev: DecodeEvent) => void> = [];

        const client: WireClient = {
            socket,
            send(header, body) {
                socket.write(encodeFrame(header, body));
            },
            nextFrame(timeoutMs = REQUEST_TIMEOUT_MS) {
                return new Promise((res, rej) => {
                    const queued = pending.shift();
                    if (queued) {
                        res(queued);
                        return;
                    }
                    const timer = setTimeout(
                        () => rej(new Error('timed out waiting for a reply from the model server')),
                        timeoutMs,
                    );
                    waiters.push((ev) => {
                        clearTimeout(timer);
                        res(ev);
                    });
                });
            },
            close() {
                socket.destroy();
            },
        };

        socket.on('data', (chunk: Buffer) => {
            for (const ev of decoder.push(chunk)) {
                const w = waiters.shift();
                if (w) w(ev);
                else pending.push(ev);
            }
        });

        const connectTimer = setTimeout(() => {
            socket.destroy();
            reject(new Error('timed out connecting to the model server socket'));
        }, CONNECT_TIMEOUT_MS);
        socket.once('connect', () => {
            clearTimeout(connectTimer);
            resolve(client);
        });
        socket.once('error', (err) => {
            clearTimeout(connectTimer);
            reject(err as Error);
        });
    });
}

interface ServerLocation {
    loreHomeDir: string;
    key: string;
    sockPath: string;
    tokPath: string;
}

function resolveServerLocation(): ServerLocation {
    const loreHomeDir = loreHome();
    const key = serverKey(loreHomeDir);
    return {
        loreHomeDir,
        key,
        sockPath: socketPath(loreHomeDir, key),
        tokPath: tokenPath(loreHomeDir, key),
    };
}

function readPidBestEffort(loc: ServerLocation): number | undefined {
    try {
        const raw = fs.readFileSync(pidPath(loc.loreHomeDir, loc.key), 'utf8').trim();
        const n = parseInt(raw, 10);
        return Number.isFinite(n) ? n : undefined;
    } catch {
        return undefined;
    }
}

/** Extract a human-readable reason from whatever frame came back where a
 *  `helloOk`/`statusResult`/`shutdownOk` was expected but something else
 *  (a `helloErr`, an `error` frame, an oversize `tooLarge` event) arrived. */
function describeUnexpected(ev: DecodeEvent): string {
    if (ev.kind === 'tooLarge') return 'server sent an oversized/malformed frame';
    const h = ev.header as Record<string, unknown>;
    if (typeof h.reason === 'string') return h.reason;
    if (typeof h.message === 'string') return h.message;
    if (typeof h.name === 'string') return h.name;
    if (typeof h.type === 'string') return `unexpected reply type '${h.type}'`;
    return 'unrecognized reply';
}

function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return `${ms}ms`;
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts: string[] = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || parts.length === 0) parts.push(`${seconds}s`);
    return parts.join(' ');
}

// ─── status ────────────────────────────────────────────────────────────

async function serverStatusCommand(args: string[]): Promise<void> {
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: lore models server status [--json]');
        console.log('');
        console.log('  Reports whether the shared local model server (D9, Lore 3.24) is');
        console.log('  running for this LORE_HOME, and if so its pid, key, socket, protocol');
        console.log('  version, uptime, connected client count and embed queue depth.');
        console.log('  Prints "not running" and exits 0 when no server is up — that is the');
        console.log('  normal state for a host that has never embedded/reranked yet.');
        process.exit(0);
        return;
    }
    const json = args.includes('--json');
    const loc = resolveServerLocation();

    let client: WireClient;
    try {
        client = await connectRaw(loc.sockPath);
    } catch {
        // ENOENT (no socket file) or ECONNREFUSED (stale/dead socket) both
        // mean the same thing to an operator: nothing is running.
        console.log(json ? JSON.stringify({ running: false }) : 'Model server: not running.');
        process.exit(0);
        return;
    }

    try {
        let token: string;
        try {
            token = fs.readFileSync(loc.tokPath, 'utf8').trim();
        } catch (err) {
            throw new Error(`token file ${loc.tokPath} could not be read: ${(err as Error).message}`);
        }
        client.send({ type: 'hello', v: PROTOCOL_VERSION, token, clientId: 'lore-models-server-status' });
        const helloEv = await client.nextFrame(HELLO_TIMEOUT_MS);
        const helloHeader = helloEv.kind === 'frame' ? (helloEv.header as Record<string, unknown>) : undefined;
        if (!helloHeader || helloHeader.type !== 'helloOk') {
            throw new Error(`hello failed: ${describeUnexpected(helloEv)}`);
        }

        client.send({ type: 'status', id: 'cli-status' });
        const statusEv = await client.nextFrame(REQUEST_TIMEOUT_MS);
        const s = statusEv.kind === 'frame' ? (statusEv.header as Record<string, unknown>) : undefined;
        if (!s || s.type !== 'statusResult') {
            throw new Error(`status request failed: ${describeUnexpected(statusEv)}`);
        }
        client.close();

        const pid = s.pid as number;
        const uptimeMs = s.uptimeMs as number;
        const clients = s.clients as number;
        const queueDepth = s.queueDepth as number;
        const protocolVersion = s.protocolVersion as number;
        const idleExitMs = s.idleMs as number;
        const rssBytes = typeof s.rssBytes === 'number' ? s.rssBytes : undefined;
        const models = Array.isArray(s.models)
            ? (s.models as Array<{ kind: string; id: string; dtype: string; lastUsedAt: number }>)
            : undefined;

        if (json) {
            console.log(
                JSON.stringify({
                    running: true,
                    pid,
                    key: loc.key,
                    socket: loc.sockPath,
                    protocolVersion,
                    uptimeMs,
                    clients,
                    queueDepth,
                    idleExitMs,
                    ...(rssBytes !== undefined ? { rssBytes } : {}),
                    ...(models ? { models } : {}),
                }),
            );
        } else {
            console.log('Model server: running');
            console.log(`  PID:               ${pid}`);
            console.log(`  Key:               ${loc.key}`);
            console.log(`  Socket:            ${loc.sockPath}`);
            console.log(`  Protocol version:  ${protocolVersion}`);
            console.log(`  Uptime:            ${formatDuration(uptimeMs)}`);
            console.log(`  Connected clients: ${clients}`);
            console.log(`  Embed queue depth: ${queueDepth}`);
            console.log(`  Idle-exit after:   ${formatDuration(idleExitMs)} with no clients/in-flight work`);
            if (rssBytes !== undefined) console.log(`  Memory (RSS):      ${Math.round(rssBytes / 1048576)} MB`);
            if (models && models.length) {
                console.log('  Models served:');
                for (const m of models) {
                    const ago = formatDuration(Date.now() - m.lastUsedAt);
                    console.log(`    ${m.kind.padEnd(6)} ${m.id} (${m.dtype}) — last used ${ago} ago`);
                }
            } else if (models) {
                console.log('  Models served:     none yet');
            }
        }
        process.exit(0);
    } catch (err) {
        client.close();
        const msg = err instanceof Error ? err.message : String(err);
        if (json) console.log(JSON.stringify({ running: true, error: msg }));
        else console.error(`Model server: running but status check failed — ${msg}`);
        process.exit(1);
    }
}

// ─── stop ──────────────────────────────────────────────────────────────

async function serverStopCommand(args: string[]): Promise<void> {
    if (args.includes('--help') || args.includes('-h')) {
        console.log('Usage: lore models server stop');
        console.log('');
        console.log('  Asks the shared local model server to shut down gracefully over its');
        console.log('  own protocol (a token-signed `shutdown` message) — never by SIGKILL or');
        console.log('  any other pattern-based signal. Exits 0 if nothing was running, or once');
        console.log('  the server acknowledges the request; exits non-zero, without killing');
        console.log('  anything, if it cannot be reached or refuses.');
        process.exit(0);
        return;
    }
    const loc = resolveServerLocation();
    const pidBeforeStop = readPidBestEffort(loc);

    let client: WireClient;
    try {
        client = await connectRaw(loc.sockPath);
    } catch {
        // Same ENOENT/ECONNREFUSED-means-not-running reasoning as `status`.
        console.log('Model server: not running — nothing to stop.');
        process.exit(0);
        return;
    }

    try {
        let token: string;
        try {
            token = fs.readFileSync(loc.tokPath, 'utf8').trim();
        } catch (err) {
            throw new Error(`token file ${loc.tokPath} could not be read: ${errMsg(err)}`);
        }
        client.send({ type: 'hello', v: PROTOCOL_VERSION, token, clientId: 'lore-models-server-stop' });
        const helloEv = await client.nextFrame(HELLO_TIMEOUT_MS);
        const helloHeader = helloEv.kind === 'frame' ? (helloEv.header as Record<string, unknown>) : undefined;
        if (!helloHeader || helloHeader.type !== 'helloOk') {
            throw new Error(`could not authenticate to request shutdown: ${describeUnexpected(helloEv)}`);
        }

        client.send({ type: 'shutdown', id: 'cli-stop', token });
        const shutdownEv = await client.nextFrame(REQUEST_TIMEOUT_MS);
        const h = shutdownEv.kind === 'frame' ? (shutdownEv.header as Record<string, unknown>) : undefined;
        if (!h || h.type !== 'shutdownOk') {
            throw new Error(`graceful shutdown request failed: ${describeUnexpected(shutdownEv)}`);
        }
        client.close();
        console.log(
            pidBeforeStop !== undefined
                ? `Model server (pid ${pidBeforeStop}) acknowledged shutdown and is exiting.`
                : 'Model server acknowledged shutdown and is exiting.',
        );
        process.exit(0);
    } catch (err) {
        client.close();
        console.error(`Model server: stop request failed — ${errMsg(err)}. Not killing it by signal.`);
        process.exit(1);
    }
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
