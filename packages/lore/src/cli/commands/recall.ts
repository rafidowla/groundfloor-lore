import fs from 'fs';
import http from 'http';
import { openWorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import { loreHomePath } from '../../config/loreHome.js';
import { readWorkspaceRegistry } from '../../config/workspaceRegistry.js';
import { resolveGraphBasePath } from './shared.js';

interface HttpRecallResult {
    topic: string;
    crossProject: boolean;
    hits: number;
    projects: string[];
    results: Array<{ id: string; type: string; label: string; project: string; tags: string; snippet: string | null }>;
}

export async function tryHttpGetFull(id: string): Promise<unknown | null> {
    return new Promise((resolve) => {
        const params = new URLSearchParams({ id });
        const req = http.get(
            `http://127.0.0.1:3847/api/node-full?${params.toString()}`,
            { timeout: 2000 },
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    resolve(null);
                    return;
                }
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch { resolve(null); }
                });
            },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function tryHttpRecall(topic: string, crossProject: boolean, maxHits: number): Promise<unknown | null> {
    // /api/recall requires Bearer since 2026-06-19. Read auth.token; if
    // absent (daemon not running, first boot) fall through to LocalGraph.
    let token: string;
    try {
        token = fs.readFileSync(loreHomePath('auth.token'), 'utf-8').trim();
    } catch {
        return null;
    }

    // Detect workspace from the project registry so the daemon can scope
    // the recall. Falls back to '*' (cross-workspace) when no match.
    let workspace = '*';
    if (!crossProject) {
        try {
            const registry = readWorkspaceRegistry();
            const cwd = process.cwd();
            outer: for (const [name, mapping] of Object.entries(registry.projects)) {
                for (const pathFragment of mapping.paths) {
                    if (cwd.includes(pathFragment)) { workspace = name; break outer; }
                }
            }
        } catch { /* no registry — use '*' */ }
    }

    return new Promise((resolve) => {
        const params = new URLSearchParams({
            topic,
            crossProject: String(crossProject),
            max: String(maxHits),
            workspace,
        });
        const req = http.get(
            `http://127.0.0.1:3847/api/recall?${params.toString()}`,
            { timeout: 2000, headers: { Authorization: `Bearer ${token}` } },
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    resolve(null);
                    return;
                }
                let body = '';
                res.on('data', (chunk) => { body += chunk; });
                res.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch { resolve(null); }
                });
            },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

function printRecallResult(
    topic: string,
    crossProject: boolean,
    hits: number,
    projectsSeen: string[],
    rows: Array<{ id: string; type: string; label: string; project: string; tags: string; snippet: string | null; content?: string }>,
    fullMode: boolean,
): void {
    if (hits === 0) {
        console.log(`<lore-recall topic="${topic}" cross-project=${crossProject} hits="0">`);
        console.log('  No matches.');
        console.log('</lore-recall>');
        return;
    }
    console.log(`<lore-recall topic="${topic}" cross-project=${crossProject} hits="${hits}" projects="${projectsSeen.join(',')}">`);
    const byProject = new Map<string, typeof rows>();
    for (const r of rows) {
        const p = r.project ?? '*';
        if (!byProject.has(p)) byProject.set(p, []);
        byProject.get(p)?.push(r);
    }
    for (const [proj, list] of byProject) {
        console.log(`  [${proj}]`);
        for (const r of list) {
            console.log(`    • ${r.id} (${r.type}) — ${r.label}`);
            if (fullMode && r.content) {
                console.log(`      ${r.content.replace(/\n/g, '\n      ')}`);
            } else if (r.snippet) {
                console.log(`      ${r.snippet}`);
            }
            if (r.tags) console.log(`      tags: ${r.tags}`);
        }
    }
    if (!fullMode) console.log(`  Tip: lore get-full <id> for full body.`);
    console.log('</lore-recall>');
}

export async function recallCommand(args: string[]): Promise<void> {
    const topic = args.find((a) => !a.startsWith('--'));
    if (!topic) {
        console.error('Usage: lore recall <topic> [--cross-project] [--max N] [--full]');
        process.exit(1);
    }
    const crossProject = args.includes('--cross-project');
    const fullMode = args.includes('--full');
    const maxIdx = args.indexOf('--max');
    const maxHits = maxIdx >= 0 && args[maxIdx + 1] ? parseInt(args[maxIdx + 1] ?? '8', 10) : 8;

    const httpResult = await tryHttpRecall(topic, crossProject, maxHits) as HttpRecallResult | null;
    if (httpResult) {
        printRecallResult(topic, crossProject, httpResult.hits, httpResult.projects, httpResult.results, fullMode);
        return;
    }

    const basePath = resolveGraphBasePath();
    const graph = openWorkspaceGraph(basePath);
    try {
        let projectName = '*';
        let ecosystem = '*';
        if (!crossProject) {
            try {
                const registry = readWorkspaceRegistry();
                const cwd = process.cwd();
                for (const [name, mapping] of Object.entries(registry.projects)) {
                    for (const pathFragment of mapping.paths) {
                        if (cwd.includes(pathFragment)) {
                            projectName = name;
                            ecosystem = mapping.ecosystem;
                            break;
                        }
                    }
                }
            } catch {
                /* No registry — fall through to '*' */
            }
        }

        const cliSignals = { scanCapHit: false };
        const hits = await graph.search(topic, maxHits, projectName, ecosystem, false, cliSignals);
        if (cliSignals.scanCapHit) {
            // P16 — to stderr so it doesn't pollute the <lore-recall> block on stdout.
            console.error('[lore recall] scan cap hit — results may be incomplete (matches older than the cap were dropped before ranking). Narrow the topic or raise LORE_SEARCH_SCAN_CAP.');
        }
        if (hits.length === 0) {
            console.log(`<lore-recall topic="${topic}" cross-project=${crossProject} hits="0">`);
            console.log('  No matches.');
            console.log('</lore-recall>');
            return;
        }

        const projectsSeen = new Set<string>();
        for (const node of hits) projectsSeen.add(node.project ?? '*');
        const SNIPPET_LEN = 120;

        console.log(`<lore-recall topic="${topic}" cross-project=${crossProject} hits="${hits.length}" projects="${Array.from(projectsSeen).join(',')}">`);
        const byProject = new Map<string, typeof hits>();
        for (const n of hits) {
            const p = n.project ?? '*';
            if (!byProject.has(p)) byProject.set(p, []);
            byProject.get(p)?.push(n);
        }
        for (const [proj, nodes] of byProject) {
            console.log(`  [${proj}]`);
            for (const node of nodes) {
                if (fullMode) {
                    console.log(`    • ${node.id} (${node.type}) — ${node.label}`);
                    if (node.tags) console.log(`      tags: ${node.tags}`);
                    if (node.content) console.log(`      ${node.content.replace(/\n/g, '\n      ')}`);
                } else {
                    const snippet = typeof node.content === 'string'
                        ? (node.content.length > SNIPPET_LEN
                            ? node.content.slice(0, SNIPPET_LEN).replace(/\s+/g, ' ').trim() + '…'
                            : node.content.replace(/\s+/g, ' ').trim())
                        : '';
                    console.log(`    • ${node.id} (${node.type}) — ${node.label}`);
                    if (snippet) console.log(`      ${snippet}`);
                }
            }
        }
        if (!fullMode) {
            console.log(`  Tip: lore get-full <id> for full body.`);
        }
        console.log('</lore-recall>');
    } finally {
        await graph.close();
    }
}
