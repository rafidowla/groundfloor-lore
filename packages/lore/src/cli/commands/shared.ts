import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { loreHome } from '../../config/loreHome.js';

export function findRepoRoot(): string {
    let currentDirectory = process.cwd();
    while (currentDirectory !== path.dirname(currentDirectory)) {
        if (fs.existsSync(path.join(currentDirectory, '.git'))) {
            return currentDirectory;
        }
        currentDirectory = path.dirname(currentDirectory);
    }
    return process.cwd();
}

export function resolveGraphBasePath(): string {
    return loreHome();
}

export function isDaemonRunning(): boolean {
    try {
        execSync('curl -s --max-time 2 http://127.0.0.1:3847/health', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export function writeMcpConfig(
    configPath: string,
    serverName: string,
    entry: Record<string, string>,
): void {
    let config: Record<string, unknown> = { mcpServers: {} };

    if (fs.existsSync(configPath)) {
        try {
            config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch {
            // Corrupted config — start fresh
        }
    }

    if (!config['mcpServers'] || typeof config['mcpServers'] !== 'object') {
        config['mcpServers'] = {};
    }

    (config['mcpServers'] as Record<string, unknown>)[serverName] = entry;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4) + '\n', 'utf-8');
}
