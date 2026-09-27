#!/usr/bin/env tsx
/**
 * test/helpers/wedged-model-server.ts — a FAKE model server for the O5
 * restart-first test (Lore 3.24 D1). It takes the real server's place for
 * `LORE_HOME` (lock, token, socket, pidfile — same order and modes as
 * server.ts), answers `hello` correctly, then never answers anything else,
 * ignores `shutdown`, and ignores SIGTERM: a server that is wedged, not dead.
 * Only SIGKILL stops it. Logs `model server starting {"pid":N}` like the real
 * one so test/helpers/model-server-home.ts can clean it up.
 *
 * Run by the test only: tsx test/helpers/wedged-model-server.ts
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { serverKey, runDir, socketPath, tokenPath, pidPath, lockPath, logPath } from '../../packages/lore/src/modelServer/paths.js';
import { FrameDecoder, encodeFrame, PROTOCOL_VERSION } from '../../packages/lore/src/modelServer/protocol.js';

const home = process.env.LORE_HOME!;
const key = serverKey(home);
const sock = socketPath(home, key);
fs.mkdirSync(runDir(home, key), { recursive: true, mode: 0o700 });
fs.mkdirSync(path.dirname(logPath(home)), { recursive: true, mode: 0o700 });
fs.appendFileSync(logPath(home), `${new Date().toISOString()} INFO [model-server] model server starting ${JSON.stringify({ key, pid: process.pid, fake: 'wedged' })}\n`);
fs.writeFileSync(lockPath(home, key), String(process.pid), { mode: 0o600 });
fs.rmSync(sock, { force: true });
const token = crypto.randomBytes(32).toString('hex');
fs.writeFileSync(tokenPath(home, key), token, { mode: 0o600 });

process.on('SIGTERM', () => { /* wedged: ignore */ });

const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
        for (const ev of decoder.push(chunk)) {
            if (ev.kind !== 'frame') continue;
            const h = ev.header as { type?: string; token?: string };
            if (h.type === 'hello' && h.token === token) socket.write(encodeFrame({ type: 'helloOk', v: PROTOCOL_VERSION }));
            // everything else: swallowed — the wedge
        }
    });
});
server.listen(sock, () => {
    fs.writeFileSync(pidPath(home, key), String(process.pid), { mode: 0o600 });
    process.stdout.write(`listening ${process.pid}\n`);
});
