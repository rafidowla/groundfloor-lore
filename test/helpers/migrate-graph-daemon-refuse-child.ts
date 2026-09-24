#!/usr/bin/env node
/**
 * test/helpers/migrate-graph-daemon-refuse-child.ts — starts a fake daemon
 * that answers `/api/health` as if it were genuinely serving `home` (writes
 * `auth.token` itself, then requires that exact Bearer and replies with a
 * matching `loreHome`) on `LORE_PORT`, THEN calls `migrateGraphToSqlite`
 * without `force` and asserts it throws the daemon-refuse error.
 *
 * Runs in a CHILD PROCESS, and sets `process.env['LORE_PORT']` BEFORE
 * dynamically importing `migrateGraphToSqlite.js`, because
 * `migrateWorkspaceToWorkspaceShared.ts`'s `DEFAULT_PORT` is read from the
 * env once at module load — a static top-level import would evaluate it
 * before this script gets a chance to set the variable.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';

const [workspaceName, home, backupOutDir] = process.argv.slice(2);
if (!workspaceName || !home || !backupOutDir) {
    console.error('usage: migrate-graph-daemon-refuse-child.ts <workspaceName> <home> <backupOutDir>');
    process.exit(2);
}

/** Find a free TCP port synchronously-enough via a throwaway listen/close. */
async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const address = srv.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            srv.close((err) => (err ? reject(err) : resolve(port)));
        });
        srv.on('error', reject);
    });
}

const port = await freePort();
process.env['LORE_PORT'] = String(port);

// Dynamic import AFTER LORE_PORT is set — module-load-time env read.
const { migrateGraphToSqlite } = await import('../../packages/lore/src/engines/migrateGraphToSqlite.js');

const token = 'fake-daemon-token-for-migrate-graph-refusal-test';
fs.writeFileSync(path.join(home, 'auth.token'), token, 'utf8');

const server = http.createServer((req, res) => {
    if (req.url === '/api/health') {
        const auth = req.headers.authorization;
        if (auth === `Bearer ${token}`) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ loreHome: home }));
            return;
        }
        res.writeHead(401);
        res.end();
        return;
    }
    res.writeHead(404);
    res.end();
});

await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

try {
    let threw = false;
    let message = '';
    try {
        await migrateGraphToSqlite({ workspaceName, home, backupOutDir });
    } catch (err) {
        threw = true;
        message = (err as Error).message;
    }
    if (!threw) {
        console.log('FAIL: migrateGraphToSqlite did not refuse with a daemon serving the home');
        process.exit(1);
    }
    if (!/daemon is running/i.test(message)) {
        console.log(`FAIL: wrong refusal message: ${message}`);
        process.exit(1);
    }
    console.log('PASS');
} finally {
    server.close();
}
