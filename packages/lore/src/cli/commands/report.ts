import fs from 'fs';
import path from 'path';
import http from 'http';
import { loreHome, loreHomePath } from '../../config/loreHome.js';
import { writeGraphReport } from '../../engines/graphReport.js';
import { openGraphForCli } from './shared.js';
import { DEFAULT_PORT } from './migrateWorkspaceToWorkspaceShared.js';

export async function reportCommand(args: string[]): Promise<void> {
    const outIdx = args.indexOf('--output');
    const outputPath = outIdx >= 0 ? args[outIdx + 1] : null;
    const projIdx = args.indexOf('--project');
    const project = projIdx >= 0 ? args[projIdx + 1] : undefined;
    const topNIdx = args.indexOf('--topN');
    const topN = topNIdx >= 0 ? parseInt(args[topNIdx + 1], 10) : undefined;

    let md: string | null = null;

    try {
        md = await fetchReportViaDaemon(project, topN);
    } catch {
        // Daemon not running or unreachable — fall through to direct DB.
    }

    if (md == null) {
        const basePath = loreHome();
        // Finding 11 (round E) — the HTTP attempt above already tried the
        // daemon; this direct-open fallback is what used to sit in the
        // ~15s openSurreal retry storm. fetchReportViaDaemon() above now
        // resolves DEFAULT_PORT (LORE_PORT-aware) instead of a hardcoded
        // 3847, so this fallback fires only when the HTTP attempt
        // genuinely misses the daemon (no auth token, daemon down,
        // timeout). Refuse fast with a clear message instead of the raw
        // driver error.
        const graph = await openGraphForCli(basePath);
        md = await writeGraphReport(graph, { project, topN });
        await graph.close();
    }

    if (outputPath) {
        const resolved = path.resolve(outputPath);
        fs.writeFileSync(resolved, md, { mode: 0o600 });
        console.log(`Wrote ${md.length} bytes to ${resolved}`);
    } else {
        process.stdout.write(md);
    }
}

async function fetchReportViaDaemon(project?: string, topN?: number): Promise<string> {
    const tokenPath = loreHomePath('auth.token');
    if (!fs.existsSync(tokenPath)) {
        throw new Error('no auth token — daemon not initialized');
    }
    const token = fs.readFileSync(tokenPath, 'utf-8').trim();

    const qs = new URLSearchParams();
    if (project) qs.set('project', project);
    if (topN != null) qs.set('topN', String(topN));
    const path_ = qs.toString() ? `/api/report?${qs.toString()}` : '/api/report';

    return await new Promise<string>((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: DEFAULT_PORT,
            method: 'GET',
            path: path_,
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10_000,
        }, (res) => {
            let body = '';
            res.setEncoding('utf-8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                if (res.statusCode === 200) resolve(body);
                else reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.end();
    });
}
