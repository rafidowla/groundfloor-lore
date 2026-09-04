import fs from 'fs';
import path from 'path';
import http from 'http';
import { loreHome, loreHomePath } from '../../config/loreHome.js';
import { getActiveWorkspaceName } from '../../config/workspaces.js';
import { exportGraphAsHtml } from '../../engines/htmlExport.js';
import { openGraphForCli } from './shared.js';
import { DEFAULT_PORT } from './migrateWorkspaceToWorkspaceShared.js';

export async function exportCommand(args: string[]): Promise<void> {
    if (args[0] !== 'html') {
        console.error('usage: lore export html --output <path> [--workspace <name>] [--project <name>] [--max-nodes N] [--title "..."]');
        process.exit(1);
    }
    const outIdx = args.indexOf('--output');
    if (outIdx < 0 || !args[outIdx + 1]) {
        console.error('--output <path> is required');
        process.exit(1);
    }
    const outputPath = path.resolve(args[outIdx + 1]);
    const projectIdx = args.indexOf('--project');
    const project = projectIdx >= 0 ? args[projectIdx + 1] : undefined;
    const maxIdx = args.indexOf('--max-nodes');
    const maxNodes = maxIdx >= 0 ? parseInt(args[maxIdx + 1], 10) : undefined;
    const titleIdx = args.indexOf('--title');
    const title = titleIdx >= 0 ? args[titleIdx + 1] : undefined;
    // L-007 — the daemon's GET /api/export/html now REQUIRES an explicit
    // ?workspace= (read-scope gate, no silent active-workspace fallback).
    // Default to the active workspace so `lore export html` keeps working;
    // an explicit --workspace overrides it.
    const wsIdx = args.indexOf('--workspace');
    let workspace: string | undefined = wsIdx >= 0 ? args[wsIdx + 1] : undefined;
    if (!workspace) {
        try { workspace = getActiveWorkspaceName(); } catch { /* no workspaces file — direct-DB path below */ }
    }

    let html: string | null = null;
    try {
        html = await fetchHtmlExportViaDaemon({ project, maxNodes, title, workspace });
    } catch {
        // Daemon down — open DB directly.
    }
    if (html == null) {
        const basePath = loreHome();
        // Finding 11 (round E) — the HTTP attempt above already tried the
        // daemon; this direct-open fallback is what used to sit in the
        // ~15s openSurreal retry storm. fetchHtmlExportViaDaemon() above
        // now resolves DEFAULT_PORT (LORE_PORT-aware) instead of a
        // hardcoded 3847, so this fallback fires only when the HTTP
        // attempt genuinely misses the daemon (no auth token, daemon
        // down, timeout). Refuse fast with a clear message instead of the
        // raw driver error.
        const graph = await openGraphForCli(basePath);
        html = await exportGraphAsHtml(graph, { project, maxNodes, title });
        await graph.close();
    }
    fs.writeFileSync(outputPath, html, { mode: 0o600 });
    console.log(`Wrote ${html.length} bytes to ${outputPath}`);
    console.log(`Open in a browser: open "${outputPath}"`);
}

async function fetchHtmlExportViaDaemon(opts: { project?: string; maxNodes?: number; title?: string; workspace?: string }): Promise<string> {
    const tokenPath = loreHomePath('auth.token');
    if (!fs.existsSync(tokenPath)) throw new Error('no daemon');
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();
    const qs = new URLSearchParams();
    // L-007 — the route requires ?workspace= (read-scope gate). Send it so
    // the daemon export resolves the correct workspace's graph.
    if (opts.workspace) qs.set('workspace', opts.workspace);
    if (opts.project) qs.set('project', opts.project);
    if (opts.maxNodes != null) qs.set('maxNodes', String(opts.maxNodes));
    if (opts.title) qs.set('title', opts.title);
    const pathQs = qs.toString() ? `/api/export/html?${qs.toString()}` : '/api/export/html';
    return await new Promise<string>((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: DEFAULT_PORT, method: 'GET', path: pathQs,
            headers: { Authorization: `Bearer ${token}` }, timeout: 15_000,
        }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                if (res.statusCode === 200) resolve(body);
                else reject(new Error(`HTTP ${res.statusCode}`));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}
