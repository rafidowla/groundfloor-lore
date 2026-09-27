#!/usr/bin/env node
/**
 * modelServer/main.ts — process entry point for the shared model server.
 * Slice C2 (the spawning host client, out of this slice's scope) spawns
 * this file (`main.js` from the built package, `main.ts` under tsx)
 * with `LORE_HOME` and any `LORE_MODEL_SERVER_*`/model-loading env vars
 * set (see paths.ts's `SERVER_ENV_ALLOWLIST`).
 *
 * SF6: `uncaughtException`/`unhandledRejection` are last-resort safety nets
 * for anything that escapes connection.ts's per-frame try/catch (a bug
 * outside request handling — e.g. in a timer callback, or genuinely
 * unforeseen). Per log.ts's hard invariant, only `message`/`stack` are
 * logged here — never any request payload, which these handlers never even
 * have access to. The client (out of scope for this slice) already
 * restarts a dead server, so exiting promptly rather than limping on in an
 * unknown state is the right call.
 */
import { runModelServer } from './server.js';
import { resolveLoreHome } from '../config/loreHome.js';
import { logPath } from './paths.js';
import { ModelServerLogger } from './log.js';

function logFatal(source: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    try {
        const loreHome = resolveLoreHome();
        const log = new ModelServerLogger(logPath(loreHome));
        log.error(`${source} — exiting`, { message, stack });
    } catch (loggingErr) {
        // The logger itself may be unavailable this early (e.g.
        // resolveLoreHome() throwing) — stderr is the only guaranteed sink
        // at that point. Still never logs any request payload, since none
        // is available in this scope either way.
        // eslint-disable-next-line no-console
        console.error(`[model-server] ${source}:`, message, stack ?? '');
        // eslint-disable-next-line no-console
        console.error('[model-server] (also failed to write to the model-server log):', loggingErr);
    }
}

process.on('uncaughtException', (err) => {
    logFatal('uncaughtException', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logFatal('unhandledRejection', reason);
    process.exit(1);
});

runModelServer().catch((err) => {
    // The logger may not have been constructed yet if resolveLoreHome()
    // itself throws — stderr is the only guaranteed sink at that point.
    // eslint-disable-next-line no-console
    console.error('[model-server] fatal:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
});
