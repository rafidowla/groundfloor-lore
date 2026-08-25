import { openWorkspaceGraph } from '../../engines/openWorkspaceGraph.js';
import { resolveGraphBasePath } from './shared.js';
import { tryHttpGetFull } from './recall.js';

export async function getFullCommand(args: string[]): Promise<void> {
    const id = args[0];
    if (!id) {
        console.error('Usage: lore get-full <id>');
        process.exit(1);
    }

    const httpResult = await tryHttpGetFull(id) as {
        found: boolean;
        id?: string;
        type?: string;
        label?: string;
        project?: string;
        tags?: string;
        content?: string;
        language?: string | null;
        metadata?: unknown;
    } | null;

    if (httpResult && httpResult.found) {
        console.log(`─── ${httpResult.id} ───`);
        console.log(`type:    ${httpResult.type}`);
        console.log(`label:   ${httpResult.label}`);
        console.log(`project: ${httpResult.project ?? '(default)'}`);
        if (httpResult.tags) console.log(`tags:    ${httpResult.tags}`);
        if (httpResult.language) console.log(`language: ${httpResult.language}`);
        console.log('');
        console.log(httpResult.content ?? '(no content)');
        if (httpResult.metadata) {
            console.log('');
            console.log('─── metadata ───');
            console.log(typeof httpResult.metadata === 'string' ? httpResult.metadata : JSON.stringify(httpResult.metadata, null, 2));
        }
        return;
    }
    if (httpResult && !httpResult.found) {
        console.error(`Node '${id}' not found via daemon HTTP. If it lives in a sibling project, recall it first with --cross-project.`);
        process.exit(1);
    }

    const stripped = id.startsWith('lore:') ? id.slice(5) : id;
    const basePath = resolveGraphBasePath();
    const graph = openWorkspaceGraph(basePath);
    try {
        const node = await graph.getNode(stripped);
        if (!node) {
            console.error(`Node '${id}' not found. If it lives in a sibling project, recall it first with --cross-project.`);
            process.exit(1);
        }
        console.log(`─── ${node.id} ───`);
        console.log(`type:    ${node.type}`);
        console.log(`label:   ${node.label}`);
        console.log(`project: ${node.project ?? '(default)'}`);
        if (node.tags) console.log(`tags:    ${node.tags}`);
        if (node.language) console.log(`language: ${node.language}`);
        console.log('');
        console.log(node.content ?? '(no content)');
        if (node.metadata) {
            console.log('');
            console.log('─── metadata ───');
            console.log(typeof node.metadata === 'string' ? node.metadata : JSON.stringify(node.metadata, null, 2));
        }
    } finally {
        await graph.close();
    }
}
