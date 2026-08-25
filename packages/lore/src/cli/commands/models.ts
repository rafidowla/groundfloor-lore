import fs from 'fs';
import path from 'path';
import { loreHome } from '../../config/loreHome.js';
import { ConfigManager } from '../../config/configManager.js';

export async function modelsCommand(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub !== 'prune') {
        console.error('usage: lore models prune [--apply] [--keep <pattern>]...');
        console.error('       Removes cached ONNX model weights that are not the currently active');
        console.error('       embedded model. Dry-run by default — use --apply to actually delete.');
        console.error('');
        console.error('       --keep <pattern>  Pin additional models to preserve. Can be repeated.');
        console.error('                         Example: --keep "Xenova/*" --keep "onnx-community/Llama*"');
        process.exit(1);
    }

    const apply = args.includes('--apply');
    const keepGlobs: string[] = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--keep' && i + 1 < args.length) {
            keepGlobs.push(args[i + 1]);
            i++;
        }
    }

    const basePath = loreHome();
    const configManager = new ConfigManager(path.join(basePath, '.lore'));
    let activeModel = 'onnx-community/gemma-3-1b-it-ONNX';
    try {
        const cfg = configManager.read();
        if (cfg.llmProvider === 'embedded') {
            activeModel = 'onnx-community/gemma-3-1b-it-ONNX';
        }
    } catch {
        /* use fallback */
    }

    const alwaysKeep = new Set([
        activeModel,
        'Xenova/all-MiniLM-L6-v2',
        'onnx-community/gemma-3-1b-it-ONNX',
    ]);

    const modelsRoot = path.join(basePath, 'models');
    if (!fs.existsSync(modelsRoot)) {
        console.log(`No model cache found at ${modelsRoot}. Nothing to prune.`);
        return;
    }

    console.log('');
    console.log(`Model cache prune`);
    console.log(`  Cache:    ${modelsRoot}`);
    console.log(`  Active:   ${activeModel}`);
    if (keepGlobs.length > 0) console.log(`  Keep:     ${keepGlobs.join(', ')}`);
    console.log(`  Mode:     ${apply ? 'APPLY' : 'DRY-RUN (use --apply to delete)'}`);
    console.log('');

    const candidates: Array<{ relPath: string; fullPath: string; sizeBytes: number }> = [];
    for (const org of fs.readdirSync(modelsRoot)) {
        const orgPath = path.join(modelsRoot, org);
        if (!fs.statSync(orgPath).isDirectory()) continue;
        for (const model of fs.readdirSync(orgPath)) {
            const modelPath = path.join(orgPath, model);
            if (!fs.statSync(modelPath).isDirectory()) continue;
            const relPath = `${org}/${model}`;
            candidates.push({ relPath, fullPath: modelPath, sizeBytes: dirSizeBytes(modelPath) });
        }
    }

    if (candidates.length === 0) {
        console.log('No cached models found.');
        return;
    }

    const matchesKeepGlob = (relPath: string): boolean => {
        for (const pat of keepGlobs) {
            const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
            if (re.test(relPath)) return true;
        }
        return false;
    };

    const keep: typeof candidates = [];
    const drop: typeof candidates = [];
    for (const c of candidates) {
        if (alwaysKeep.has(c.relPath) || matchesKeepGlob(c.relPath)) {
            keep.push(c);
        } else {
            drop.push(c);
        }
    }

    const fmtBytes = (n: number): string => {
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
        return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    };

    console.log(`Found ${candidates.length} cached model${candidates.length === 1 ? '' : 's'}:`);
    for (const c of keep) {
        console.log(`  KEEP    ${c.relPath.padEnd(50)} ${fmtBytes(c.sizeBytes)}`);
    }
    for (const c of drop) {
        console.log(`  PRUNE   ${c.relPath.padEnd(50)} ${fmtBytes(c.sizeBytes)}`);
    }
    const dropTotalBytes = drop.reduce((a, b) => a + b.sizeBytes, 0);
    console.log('');
    console.log(`  ${keep.length} keep, ${drop.length} to prune, ${fmtBytes(dropTotalBytes)} to reclaim`);
    console.log('');

    if (drop.length === 0) {
        console.log('No models to prune.');
        return;
    }

    if (!apply) {
        console.log('Dry-run complete. Re-run with --apply to actually delete.');
        return;
    }

    let pruned = 0;
    let reclaimedBytes = 0;
    for (const c of drop) {
        try {
            fs.rmSync(c.fullPath, { recursive: true, force: true });
            pruned++;
            reclaimedBytes += c.sizeBytes;
            console.log(`  ✓ Removed ${c.relPath}`);
        } catch (err) {
            console.error(`  ✗ Failed to remove ${c.relPath}: ${(err as Error).message}`);
        }
    }

    for (const org of fs.readdirSync(modelsRoot)) {
        const orgPath = path.join(modelsRoot, org);
        try {
            if (fs.statSync(orgPath).isDirectory() && fs.readdirSync(orgPath).length === 0) {
                fs.rmdirSync(orgPath);
            }
        } catch { /* ignore */ }
    }

    console.log('');
    console.log(`Done. ${pruned} model${pruned === 1 ? '' : 's'} pruned, ${fmtBytes(reclaimedBytes)} reclaimed.`);
}

function dirSizeBytes(dir: string): number {
    let total = 0;
    const walk = (p: string): void => {
        try {
            const st = fs.statSync(p);
            if (st.isFile()) { total += st.size; return; }
            if (st.isDirectory()) {
                for (const name of fs.readdirSync(p)) walk(path.join(p, name));
            }
        } catch { /* ignore */ }
    };
    walk(dir);
    return total;
}
