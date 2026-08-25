import fs from 'fs';
import path from 'path';

export async function snapshotCommand(args: string[]): Promise<void> {
    const folder = args[0];
    if (!folder || folder.startsWith('--')) {
        console.error('usage: lore snapshot <folder> --output <graph.html> [--title "..."]');
        process.exit(1);
    }
    const outIdx = args.indexOf('--output');
    if (outIdx < 0 || !args[outIdx + 1]) {
        console.error('--output <path> is required');
        process.exit(1);
    }
    const outputPath = path.resolve(args[outIdx + 1]);
    const titleIdx = args.indexOf('--title');
    const title = titleIdx >= 0 ? args[titleIdx + 1] : `Lore snapshot of ${path.basename(folder)}`;

    const absFolder = path.resolve(folder);
    if (!fs.existsSync(absFolder)) {
        console.error(`folder not found: ${absFolder}`);
        process.exit(1);
    }

    const { buildDefaultRegistry } = await import('../../engines/extractors/index.js');
    const { FilesystemConnector } = await import('../../engines/connectors/index.js');
    const extractors = buildDefaultRegistry();
    const connector = new FilesystemConnector({
        extractorRegistry: extractors,
        roots: [absFolder],
        workspaceRoot: absFolder,
    });

    console.log(`Scanning ${absFolder}...`);
    const nodes: Array<{ id: string; label: string; type: string; group: string }> = [];
    const edges: Array<{ from: string; to: string; label?: string }> = [];
    const parentChildren = new Map<string, string[]>();

    let count = 0;
    for await (const item of connector.sync({ fullSync: true })) {
        count++;
        const rel = path.relative(absFolder, item.metadata.absolutePath as string);
        const parent = path.dirname(rel);
        const kind = inferSnapshotKind(item.mimeType);
        const id = `file:${rel}`;
        nodes.push({ id, label: path.basename(rel), type: kind, group: kind });
        if (parent && parent !== '.') {
            if (!parentChildren.has(parent)) {
                parentChildren.set(parent, []);
                nodes.push({ id: `dir:${parent}`, label: parent, type: 'directory', group: 'directory' });
            }
            parentChildren.get(parent)!.push(id);
            edges.push({ from: `dir:${parent}`, to: id, label: 'contains' });
        }
    }

    const topology = { nodes, edges };
    const html = renderSnapshotHtml(topology, {
        title,
        description: `Snapshot of ${absFolder} (${count} files, ${nodes.length} nodes). This is a one-shot file-tree view. Semantic edges require running a full ingest+reconnect against your active workspace.`,
    });

    fs.writeFileSync(outputPath, html, { mode: 0o600 });
    console.log(`Wrote ${html.length} bytes to ${outputPath}`);
    console.log(`Open: open "${outputPath}"`);
}

function inferSnapshotKind(mime: string): string {
    if (mime.startsWith('text/')) return 'text';
    if (mime === 'application/pdf') return 'pdf';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('image/')) return 'image';
    if (mime === 'message/rfc822') return 'email';
    if (mime.includes('wordprocessingml')) return 'docx';
    return 'file';
}

function renderSnapshotHtml(
    topology: { nodes: Array<{ id: string; label: string; type: string; group: string }>, edges: Array<{ from: string; to: string; label?: string }> },
    opts: { title: string; description: string },
): string {
    const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c] ?? c));
    return [
        '<!DOCTYPE html><html><head><meta charset="utf-8">',
        `<title>${escape(opts.title)}</title>`,
        // re-audit 2026-06-25 (supply-chain) — pin version + SRI (see htmlExport.ts).
        '<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js" integrity="sha384-yxKDWWf0wwdUj/gPeuL11czrnKFQROnLgY8ll7En9NYoXibgg3C6NK/UDHNtUgWJ" crossorigin="anonymous"></script>',
        '<style>body{font-family:-apple-system,system-ui,sans-serif;margin:0;background:#0f172a;color:#e2e8f0}header{padding:1rem 1.5rem;background:#1e293b;border-bottom:1px solid #334155}header h1{margin:0 0 .25rem;font-size:1.1rem}header p{margin:0;font-size:.85rem;color:#94a3b8}#g{width:100vw;height:calc(100vh - 80px)}</style>',
        `</head><body><header><h1>${escape(opts.title)}</h1><p>${escape(opts.description)}</p></header><div id="g"></div>`,
        `<script>const DATA=${JSON.stringify(topology)};const options={nodes:{shape:"dot",size:14,font:{color:"#e2e8f0",size:12}},edges:{arrows:{to:{enabled:true,scaleFactor:.4}},color:{color:"#475569"}},physics:{stabilization:{iterations:150}},groups:{directory:{color:{background:"#475569",border:"#334155"}},text:{color:{background:"#38A169",border:"#2F855A"}},pdf:{color:{background:"#E53E3E",border:"#C53030"}},docx:{color:{background:"#3182CE",border:"#2B6CB0"}},email:{color:{background:"#805AD5",border:"#553C9A"}},audio:{color:{background:"#DD6B20",border:"#C05621"}},image:{color:{background:"#D69E2E",border:"#B7791F"}},file:{color:{background:"#718096",border:"#4A5568"}}}};new vis.Network(document.getElementById("g"),DATA,options);</script></body></html>`,
    ].join('');
}
