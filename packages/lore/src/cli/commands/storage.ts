import { loreHome } from '../../config/loreHome.js';
import { inspectAllWorkspaces, inspectDataHome, formatBytes } from '../../engines/storageInspector.js';

export async function storageCommand(args: string[]): Promise<void> {
    const json = args.includes('--json');
    const dataHome = loreHome();

    const homeBreakdown = inspectDataHome(dataHome);
    const workspaces = inspectAllWorkspaces(dataHome);

    if (json) {
        console.log(JSON.stringify({
            dataHome: { path: dataHome, breakdown: homeBreakdown },
            workspaces: workspaces.map((w) => ({ name: w.name, path: w.path, breakdown: w.breakdown })),
        }, null, 2));
        return;
    }

    const line = (label: string, bytes: number, pad = 18): string =>
        `  ${label.padEnd(pad)} ${formatBytes(bytes).padStart(10)}`;

    console.log('');
    console.log('Storage — groundfloor-lore');
    console.log('');

    for (const ws of workspaces) {
        console.log(`Workspace: ${ws.name}  (${ws.path})`);
        const b = ws.breakdown;
        console.log(line('Graph', b.graphBytes));
        console.log(line('Tabular (SQLite)', b.tabularBytes));
        console.log(line('Embeddings (Lance)', b.embeddingsBytes));
        console.log(line('Models', b.modelsBytes));
        console.log(line('Logs', b.logsBytes));
        console.log(line('Config', b.configBytes));
        console.log(line('Other', b.otherBytes));
        console.log(line('  TOTAL', b.totalBytes));
        console.log('');
    }

    const homeCovered = workspaces.some((w) => w.path === dataHome);
    if (!homeCovered) {
        console.log(`Data home residual  (${dataHome})`);
        console.log(line('Logs', homeBreakdown.logsBytes));
        console.log(line('Models', homeBreakdown.modelsBytes));
        console.log(line('Config', homeBreakdown.configBytes));
        console.log('');
    }

    if (homeBreakdown.diskTotalBytes > 0) {
        const pctUsed = ((1 - homeBreakdown.diskFreeBytes / homeBreakdown.diskTotalBytes) * 100).toFixed(0);
        console.log(`SSD: ${formatBytes(homeBreakdown.diskFreeBytes)} free of ${formatBytes(homeBreakdown.diskTotalBytes)} (${pctUsed}% used)`);
    }
}
