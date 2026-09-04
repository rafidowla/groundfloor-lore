import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync, spawnSync } from 'child_process';
import { loreHome, loreHomePath } from '../../config/loreHome.js';
import { resolveGraphBasePath, isDaemonRunning, writeMcpConfig, openGraphForCli } from './shared.js';
import { readOperatorIdentity, operatorIdentityPath } from '../../security/operatorIdentity.js';

export async function setupCommand(args: string[]): Promise<void> {
    console.log('');
    console.log('  @groundfloor/lore — Setup');
    console.log('  ═══════════════════════════════════════');
    console.log('');
    console.log('  Note: Lore is local-first. One daemon per person.');
    console.log('  For teams / families, each person runs their own daemon');
    console.log('  and shares via Dataplane. See docs/DEPLOYMENT_MODEL.md.');
    console.log('');

    const basePath = resolveGraphBasePath();
    const loreDir = path.join(basePath, '.lore');
    const logsDir = path.join(basePath, 'logs');
    let steps = 0;
    let issues = 0;

    if (fs.existsSync(path.join(loreDir, 'graph'))) {
        console.log('  ✓ Graph already exists at ~/.groundfloor/.lore/graph/');
    } else {
        try {
            fs.mkdirSync(loreDir, { recursive: true });
            // Finding 11 (round E) — refuse fast with a clear message when
            // a running daemon holds this store's lock, instead of the old
            // ~15s openSurreal retry storm ending in a raw driver error
            // (caught below the same as any other init failure).
            const graph = await openGraphForCli(basePath);
            await graph.close();
            console.log('  ✓ Graph initialized at ~/.groundfloor/.lore/graph/');
        } catch (graphError) {
            console.error(`  ✗ Failed to initialize graph: ${(graphError as Error).message}`);
            issues++;
        }
    }
    steps++;

    fs.mkdirSync(logsDir, { recursive: true });
    steps++;

    if (process.platform === 'darwin') {
        const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.groundfloor.lore.plist');
        const nodePath = process.execPath;
        const serverPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'mcp', 'server.js');

        const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.groundfloor.lore</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${serverPath}</string>
        <string>--http</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>${logsDir}/lore-mcp.log</string>
    <key>StandardOutPath</key>
    <string>${logsDir}/lore-mcp.out</string>
    <key>WorkingDirectory</key>
    <string>${basePath}</string>
</dict>
</plist>
`;

        if (fs.existsSync(plistPath)) {
            console.log('  ✓ LaunchAgent already installed');
        } else {
            try {
                fs.writeFileSync(plistPath, plistContent, 'utf-8');
                console.log('  ✓ LaunchAgent installed at ~/Library/LaunchAgents/');
            } catch (plistError) {
                console.error(`  ✗ Failed to install LaunchAgent: ${(plistError as Error).message}`);
                issues++;
            }
        }
        steps++;

        try {
            const isRunning = isDaemonRunning();
            if (isRunning) {
                console.log('  ✓ Daemon already running on port 3847');
            } else {
                spawnSync('launchctl', ['load', plistPath], { stdio: 'ignore' }); // RA2-reaudit2 — array-form (no shell interpolation)
                await new Promise(resolve => setTimeout(resolve, 3000));
                if (isDaemonRunning()) {
                    console.log('  ✓ Daemon started on port 3847');
                } else {
                    console.log('  ⚠ Daemon loaded but may need a moment — check: curl http://127.0.0.1:3847/health');
                }
            }
        } catch (daemonError) {
            console.error(`  ✗ Failed to start daemon: ${(daemonError as Error).message}`);
            issues++;
        }
        steps++;
    } else {
        console.log('  ⚠ LaunchAgent is macOS-only. Start the daemon manually:');
        console.log('    node dist/mcp/server.js --http');
        steps += 2;
    }

    const LORE_MCP_URL = 'http://127.0.0.1:3847/mcp';

    const cursorDir = path.join(os.homedir(), '.cursor');
    if (fs.existsSync(cursorDir)) {
        try {
            const cursorConfig = path.join(cursorDir, 'mcp.json');
            const cursorMcpEntry = { type: 'http', url: LORE_MCP_URL };
            writeMcpConfig(cursorConfig, 'groundfloor-lore', cursorMcpEntry);
            console.log('  ✓ Cursor configured — ~/.cursor/mcp.json');
        } catch (cursorError) {
            console.error(`  ✗ Cursor config failed: ${(cursorError as Error).message}`);
            issues++;
        }
    } else {
        console.log('  · Cursor not detected — skipping');
    }

    const antigravityDir = path.join(os.homedir(), '.gemini', 'antigravity');
    if (fs.existsSync(antigravityDir)) {
        try {
            const agConfig = path.join(antigravityDir, 'mcp_config.json');
            const antigravityMcpEntry = { serverUrl: LORE_MCP_URL };
            writeMcpConfig(agConfig, 'groundfloor-lore', antigravityMcpEntry);
            console.log('  ✓ Antigravity configured — ~/.gemini/antigravity/mcp_config.json');
        } catch (agError) {
            console.error(`  ✗ Antigravity config failed: ${(agError as Error).message}`);
            issues++;
        }
    } else {
        console.log('  · Antigravity not detected — skipping');
    }
    steps++;

    // Claude Code reads mcpServers from ~/.claude/settings.json (confirmed schema:
    // { mcpServers: { "<name>": { type: "http", url: "..." } } }).
    const claudeSettingsDir = path.join(os.homedir(), '.claude');
    if (fs.existsSync(claudeSettingsDir)) {
        try {
            const claudeSettingsPath = path.join(claudeSettingsDir, 'settings.json');
            const claudeMcpEntry = { type: 'http', url: LORE_MCP_URL };
            writeMcpConfig(claudeSettingsPath, 'groundfloor-lore', claudeMcpEntry);
            console.log('  ✓ Claude Code MCP configured — ~/.claude/settings.json');
        } catch (claudeMcpError) {
            console.error(`  ✗ Claude Code MCP config failed: ${(claudeMcpError as Error).message}`);
            issues++;
        }
    } else {
        console.log('  · Claude Code not detected — skipping');
    }
    steps++;

    const cliDir = path.dirname(new URL(import.meta.url).pathname);
    const protocolCandidates = [
        path.resolve(cliDir, '..', '..', 'docs', 'LORE_PROTOCOL.md'),
        path.resolve(cliDir, '..', '..', '..', 'docs', 'LORE_PROTOCOL.md'),
        path.resolve(cliDir, '..', '..', '..', '..', 'docs', 'LORE_PROTOCOL.md'),
        path.resolve(process.cwd(), 'docs', 'LORE_PROTOCOL.md'),
    ];
    let protocolSource = protocolCandidates[0];
    let protocolContent = '';
    for (const candidate of protocolCandidates) {
        try {
            protocolContent = fs.readFileSync(candidate, 'utf-8');
            protocolSource = candidate;
            break;
        } catch { /* try next */ }
    }
    if (!protocolContent) {
        console.log('  ⚠ LORE_PROTOCOL.md not found — skipping rules installation');
    }

    const SHIM_PROTOCOL_HEADER = 'LORE SHIM PROTOCOL';
    const shimProtocolContent = `## Shim Protocol — active when LORE_TOOL_SHIM=on (MANDATORY if active)

When Lore is in shim mode, \`tools/list\` returns exactly three tools:
\`lore_tool_list\`, \`lore_tool_schema\`, \`lore_tool_invoke\`. Every other
Lore tool (recall, search, store_node, recall_decisions, etc.) is hidden
and must be called through \`lore_tool_invoke\`.

**You are in shim mode if your tool list shows only these three Lore tools.**

### Calling any Lore tool in shim mode

Replace every direct tool call with \`lore_tool_invoke("name", input)\`:

- \`recall({topic: "auth", mode: "summary"})\`
  → \`lore_tool_invoke("recall", {topic: "auth", mode: "summary"})\`
- \`search({query: "auth", limit: 5})\`
  → \`lore_tool_invoke("search", {query: "auth", limit: 5})\`
- \`store_node({id: "x", type: "decision", label: "..."})\`
  → \`lore_tool_invoke("store_node", {id: "x", type: "decision", label: "..."})\`
- \`recall_decisions({topic: "auth"})\`
  → \`lore_tool_invoke("recall_decisions", {topic: "auth"})\`

All other rules in this protocol apply unchanged — same triggers, same
node types, same tags. Only the call syntax changes.

### Discovery (if you don't know which tool to use)

1. \`lore_tool_list()\` — all tool names + one-line descriptions
2. \`lore_tool_schema("tool_name")\` — full JSON Schema for one tool's input
3. \`lore_tool_invoke("tool_name", { ...input })\` — run it

Skip \`lore_tool_list\` if you already know which tool to call. Skip
\`lore_tool_schema\` if you already know the input shape. Go straight to
\`lore_tool_invoke\` whenever possible — each schema fetch costs tokens.`;

    if (protocolContent) {
        let rulesInstalled = 0;

        const cursorRulesDir = path.join(os.homedir(), '.cursor', 'rules');
        if (fs.existsSync(path.join(os.homedir(), '.cursor'))) {
            try {
                fs.mkdirSync(cursorRulesDir, { recursive: true });
                const cursorRule = `---
description: Lore Intelligence Protocol — auto-consult knowledge graph and auto-store learnings
globs:
alwaysApply: true
---

${protocolContent}

# ${SHIM_PROTOCOL_HEADER}

${shimProtocolContent}`;
                const cursorRulePath = path.join(cursorRulesDir, 'lore-protocol.mdc');
                fs.writeFileSync(cursorRulePath, cursorRule, 'utf-8');
                console.log('  ✓ Cursor rules installed — ~/.cursor/rules/lore-protocol.mdc');
                rulesInstalled++;
            } catch (cursorRuleError) {
                console.error(`  ✗ Cursor rules failed: ${(cursorRuleError as Error).message}`);
                issues++;
            }
        }

        const geminiMdPath = path.join(os.homedir(), '.gemini', 'GEMINI.md');
        if (fs.existsSync(path.join(os.homedir(), '.gemini'))) {
            try {
                const sectionHeader = '14. LORE INTELLIGENCE PROTOCOL (MANDATORY)';
                let existingGemini = '';
                try { existingGemini = fs.readFileSync(geminiMdPath, 'utf-8'); } catch { /* new file */ }

                if (existingGemini.includes(sectionHeader)) {
                    console.log('  ✓ Antigravity rules already in GEMINI.md');
                } else {
                    const geminiSection = `
────────────────────────────────────────
${sectionHeader}
────────────────────────────────────────
Applies when the \`groundfloor-lore\` MCP server is available.

${protocolContent}
────────────────────────────────────────
`;
                    if (existingGemini.includes('END OF GLOBAL RULE')) {
                        const updated = existingGemini.replace('END OF GLOBAL RULE', geminiSection + '\nEND OF GLOBAL RULE');
                        fs.writeFileSync(geminiMdPath, updated, 'utf-8');
                    } else {
                        fs.appendFileSync(geminiMdPath, geminiSection, 'utf-8');
                    }
                    console.log('  ✓ Antigravity rules appended to ~/.gemini/GEMINI.md');
                }
                let currentGemini = '';
                try { currentGemini = fs.readFileSync(geminiMdPath, 'utf-8'); } catch { /* ok */ }
                if (!currentGemini.includes(SHIM_PROTOCOL_HEADER)) {
                    fs.appendFileSync(geminiMdPath, `\n\n────────────────────────────────────────\n# ${SHIM_PROTOCOL_HEADER}\n────────────────────────────────────────\n\n${shimProtocolContent}\n────────────────────────────────────────\n`, 'utf-8');
                    console.log('  ✓ Lore shim protocol appended to ~/.gemini/GEMINI.md');
                }
                rulesInstalled++;
            } catch (agRuleError) {
                console.error(`  ✗ Antigravity rules failed: ${(agRuleError as Error).message}`);
                issues++;
            }
        }

        const claudeMdPath = path.join(os.homedir(), '.claude', 'CLAUDE.md');
        if (fs.existsSync(path.join(os.homedir(), '.claude'))) {
            try {
                const claudeHeader = 'LORE INTELLIGENCE PROTOCOL';
                let existingClaude = '';
                try { existingClaude = fs.readFileSync(claudeMdPath, 'utf-8'); } catch { /* new file */ }

                if (existingClaude.includes(claudeHeader)) {
                    console.log('  ✓ Claude Code rules already in CLAUDE.md');
                } else {
                    fs.appendFileSync(claudeMdPath, `\n\n# ${claudeHeader}\n\n${protocolContent}`, 'utf-8');
                    console.log('  ✓ Claude Code rules appended to ~/.claude/CLAUDE.md');
                }
                let currentClaude = '';
                try { currentClaude = fs.readFileSync(claudeMdPath, 'utf-8'); } catch { /* ok */ }
                if (!currentClaude.includes(SHIM_PROTOCOL_HEADER)) {
                    fs.appendFileSync(claudeMdPath, `\n\n# ${SHIM_PROTOCOL_HEADER}\n\n${shimProtocolContent}`, 'utf-8');
                    console.log('  ✓ Lore shim protocol appended to ~/.claude/CLAUDE.md');
                }
                rulesInstalled++;
            } catch (claudeError) {
                console.error(`  ✗ Claude Code rules failed: ${(claudeError as Error).message}`);
                issues++;
            }
        }

        const opencodeMdPath = path.join(os.homedir(), '.opencode', 'AGENTS.md');
        if (fs.existsSync(path.join(os.homedir(), '.opencode'))) {
            try {
                const opencodeHeader = 'LORE INTELLIGENCE PROTOCOL';
                let existingOpencode = '';
                try { existingOpencode = fs.readFileSync(opencodeMdPath, 'utf-8'); } catch { /* new file */ }

                if (existingOpencode.includes(opencodeHeader)) {
                    console.log('  ✓ OpenCode rules already in AGENTS.md');
                } else {
                    fs.appendFileSync(opencodeMdPath, `\n\n# ${opencodeHeader}\n\n${protocolContent}`, 'utf-8');
                    console.log('  ✓ OpenCode rules appended to ~/.opencode/AGENTS.md');
                }
                let currentOpencode = '';
                try { currentOpencode = fs.readFileSync(opencodeMdPath, 'utf-8'); } catch { /* ok */ }
                if (!currentOpencode.includes(SHIM_PROTOCOL_HEADER)) {
                    fs.appendFileSync(opencodeMdPath, `\n\n# ${SHIM_PROTOCOL_HEADER}\n\n${shimProtocolContent}`, 'utf-8');
                    console.log('  ✓ Lore shim protocol appended to ~/.opencode/AGENTS.md');
                }
                rulesInstalled++;
            } catch (opencodeError) {
                console.error(`  ✗ OpenCode rules failed: ${(opencodeError as Error).message}`);
                issues++;
            }
        }

        if (rulesInstalled === 0) {
            console.log('  · No supported IDEs detected for rules — add manually:');
            console.log(`    See: ${protocolSource}`);
        }
    }
    steps++;

    const globalHooksDir = path.join(basePath, 'hooks');
    const hookSource = path.resolve(
        path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'scripts', 'hooks', 'post-commit'
    );

    try {
        fs.mkdirSync(globalHooksDir, { recursive: true });

        if (fs.existsSync(hookSource)) {
            fs.copyFileSync(hookSource, path.join(globalHooksDir, 'post-commit'));
            fs.chmodSync(path.join(globalHooksDir, 'post-commit'), 0o755);

            const currentHooksPath = (() => {
                try { return execSync('git config --global core.hooksPath', { encoding: 'utf-8' }).trim(); } catch { return ''; }
            })();

            if (currentHooksPath === globalHooksDir || currentHooksPath === `~/.groundfloor/hooks` || currentHooksPath.endsWith('.groundfloor/hooks')) {
                console.log('  ✓ Global git hooks already configured');
            } else {
                // RA2-reaudit2 — array-form spawn (no shell): globalHooksDir is
                // LORE_HOME-derived; the string-interpolated execSync let a
                // LORE_HOME with shell metacharacters inject a command.
                spawnSync('git', ['config', '--global', 'core.hooksPath', globalHooksDir], { stdio: 'ignore' });
                console.log('  ✓ Global git hooks installed — auto-reindex on commit');
            }
        } else {
            console.log('  ⚠ Hook script not found — skipping git hooks');
        }
    } catch (hookError) {
        console.error(`  ✗ Git hooks failed: ${(hookError as Error).message}`);
        issues++;
    }
    steps++;

    // ── Operator identity (local-mode auth, 2026-05-10 decision) ──
    // Lore in --mode=local still runs ReBAC. The operator's portal_user
    // is bound once here so per-request Clerk popups aren't needed and
    // offline-first behavior is preserved. We don't run an interactive
    // Clerk flow yet (lands when CLERK_ISSUER + the canonical tenant
    // are wired); for now we surface a clear next-step that the user
    // can complete with `lore operator init --manual --user-id=<id>`.
    try {
        const ident = readOperatorIdentity();
        if (ident) {
            console.log(`  ✓ Operator bound — ${ident.portalUserId} (${ident.source})`);
        } else {
            console.log('  · Operator not yet bound');
            console.log(`    Run: lore operator init --manual --user-id=<your portal_user id>`);
            console.log(`    File: ${operatorIdentityPath()}`);
        }
    } catch (e) {
        console.error(`  ⚠ Operator binding check failed: ${(e as Error).message}`);
    }
    steps++;

    console.log('');
    console.log('  ═══════════════════════════════════════');
    if (issues === 0) {
        console.log('  ✅ Setup complete!');
        console.log('');
        console.log('  Next steps:');
        console.log('    lore --help                               # See all commands');
        console.log('    lore doctor                               # Check daemon + storage health');
        console.log('    lore join gf://host:port/ns?token=...     # Join a team (optional)');
        if (!fs.existsSync(path.join(os.homedir(), '.claude'))) {
            console.log('');
            console.log('  Claude Code not detected. To connect it manually:');
            console.log('    Add to ~/.claude/settings.json under "mcpServers":');
            console.log('      "groundfloor-lore": { "type": "http", "url": "http://127.0.0.1:3847/mcp" }');
        }
    } else {
        console.log(`  ⚠ Setup completed with ${issues} issue(s). Run 'lore doctor' for details.`);
    }
    console.log('');

    void steps; // used for tracking only
}
