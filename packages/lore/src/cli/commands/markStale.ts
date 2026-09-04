import http from 'http';
import { resolveGraphBasePath, openGraphForCli } from './shared.js';
import { DEFAULT_PORT } from './migrateWorkspaceToWorkspaceShared.js';

async function tryHttpMarkStale(tags: string[]): Promise<number | null> {
    return new Promise((resolve) => {
        const body = JSON.stringify({ tags });
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port: DEFAULT_PORT,
                path: '/api/mark-stale',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 2000,
            },
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    resolve(null);
                    return;
                }
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data) as { marked?: number };
                        resolve(typeof parsed.marked === 'number' ? parsed.marked : null);
                    } catch {
                        resolve(null);
                    }
                });
            },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
    });
}

export async function markStaleCommand(args: string[]): Promise<void> {
    const tagsIdx = args.indexOf('--tags');
    const tagsRaw = tagsIdx >= 0 ? args[tagsIdx + 1] : undefined;
    if (!tagsRaw) {
        console.error('Usage: lore mark-stale --tags <tag1,tag2,...>');
        console.error('  Example: lore mark-stale --tags orientation-pack');
        process.exit(1);
    }
    const tags = tagsRaw.split(',').map((t) => t.trim()).filter(Boolean);
    if (tags.length === 0) {
        console.error('Error: --tags value is empty. Provide at least one tag.');
        process.exit(1);
    }

    const daemonResult = await tryHttpMarkStale(tags);
    if (daemonResult !== null) {
        console.log(`[Lore] Marked ${daemonResult} node(s) stale (tags: ${tags.join(', ')}) via daemon.`);
        return;
    }

    const basePath = resolveGraphBasePath();
    // Finding 11 (round E) — the HTTP attempt above already tried the
    // daemon; this direct-open fallback is what used to sit in the ~15s
    // openSurreal retry storm. tryHttpMarkStale() above now resolves
    // DEFAULT_PORT (LORE_PORT-aware) instead of a hardcoded 3847, so this
    // fallback fires only when the HTTP attempt genuinely misses the daemon
    // (daemon down, timeout). Refuse fast with a clear message instead of
    // the raw driver error.
    const graph = await openGraphForCli(basePath);
    try {
        const marked = await graph.markStaleByTags(tags);
        console.log(`[Lore] Marked ${marked} node(s) stale (tags: ${tags.join(', ')}).`);
    } finally {
        await graph.close();
    }
}
