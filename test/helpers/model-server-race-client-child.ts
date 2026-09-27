#!/usr/bin/env tsx
/**
 * test/helpers/model-server-race-client-child.ts — one host process for the
 * spawn-race test (Lore 3.24 D1, blocker A). Waits until the shared start
 * instant in argv[3] (epoch ms) so every child enters spawnOrConnect at the
 * same moment, connects via a pre-aborted rerank (connects, loads no model),
 * prints `{mode,pid,reason}` as one JSON line, and exits.
 *
 * Usage: tsx test/helpers/model-server-race-client-child.ts <loreHome> <goAtEpochMs>
 */

import { ModelServerClient } from '../../packages/lore/src/modelServer/client.js';

const home = process.argv[2];
const goAt = Number(process.argv[3]);
const client = new ModelServerClient({
    loreHome: home,
    clientId: `race-${process.pid}`,
    readyMs: 25_000,
    restartBudgetMs: 20_000,
    maxRestarts: 5,
    callMs: 30_000,
    probeMs: 1000,
});
const wait = goAt - Date.now();
if (wait > 0) await new Promise((r) => setTimeout(r, wait));
const ac = new AbortController();
ac.abort();
let error: string | null = null;
try {
    await client.rerank({ modelId: 'unused', cacheDir: '', query: 'q', passages: ['p'] }, ac.signal);
} catch (err) {
    error = (err as Error).name;
}
const st = client.status();
process.stdout.write(JSON.stringify({ mode: st.mode, pid: st.server?.pid ?? null, reason: st.reason ?? null, error, late: Date.now() - goAt }) + '\n');
await client.dispose();
