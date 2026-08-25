# Shell ↔ Daemon Lifecycle

> **The shell is a client of the daemon, not its parent.**
> Closing the shell window MUST NOT kill the Lore daemon.

## Why this matters

The Lore daemon is the local source of truth for memory, knowledge, and
plugin runtime. It serves multiple clients simultaneously over MCP and
HTTP:

- **Claude Code** (via stdio MCP)
- **Cursor** (via stdio MCP)
- **Google Antigravity** (via stdio MCP)
- **Claude Desktop** (via stdio MCP)
- **ChatGPT local** (via stdio MCP)
- **The Lore shell** (this app — via HTTP on `LORE_PORT`, default 3847)
- **Any future MCP client** with no code changes required

If the shell were the daemon's parent process, closing the shell would
sever every other client's connection to local memory at the same time.
That is unacceptable for a "build your second brain locally" product —
the user expects Claude Code to keep recalling notes regardless of
whether the shell window is open.

## The contract — what the shell must NOT do

1. **Never spawn the daemon as a child process.** No `Command::new`
   pointing at the daemon binary, no `tauri-plugin-shell` Sidecar
   configuration that wraps it, no node-pty or fork().
2. **Never send signals to the daemon PID.** Even `SIGHUP` for reload
   is off-limits — that's a job for `launchctl kickstart` if needed.
3. **Never `launchctl unload` the daemon.** That includes "cleanup on
   exit" handlers; there is nothing to clean up because the daemon
   isn't ours to begin with.
4. **Never modify `com.groundfloor.lore.plist`.** The plist is owned
   by the daemon's installer.

## The contract — what the shell MAY do

1. **Read launchd state via `launchctl list`** (read-only; same
   privilege as Activity Monitor).
2. **HTTP-talk to the daemon's `127.0.0.1:<port>` API** — health,
   topology, search, etc.
3. **Tell the user the exact `launchctl load <plist>` command** when
   the plist is present but not loaded. The user runs it; the shell
   does not.
4. **Open a Terminal** with that command pre-typed for convenience
   (Phase-3d-follow-up — currently we just print the command).

## What happens on shell exit

Nothing. The daemon was running before the shell opened (because
launchd manages its lifecycle), and it continues running after. The
shell's process tree contains only its own renderer + any Tauri
subprocesses; the daemon is reparented to PID 1 from the moment
launchd starts it.

## What happens if the daemon is missing

The shell renders an `unreachable` pill with the launchd state and a
hint:

| Launchd state          | Hint shown to user                                      |
|------------------------|---------------------------------------------------------|
| `PlistMissing`         | Install the daemon to register its launchd job.         |
| `NotLoaded`            | Run `launchctl load ~/Library/LaunchAgents/…` in shell. |
| `LoadedNotRunning`     | Job loaded but not running — between respawns.          |
| `Running` (no HTTP)    | Daemon process up but HTTP port not yet ready.          |
| `NotApplicable` (Linux/Win) | Use systemd / sc.exe / manual start.               |

In all cases, no inspectors load until the HTTP probe succeeds. The
shell stays usable for offline work (manifest viewing, etc.).

## Cross-platform plan (post-3d)

| Platform | Service manager | Read-only state command       | Plist/unit path                          |
|----------|-----------------|-------------------------------|------------------------------------------|
| macOS    | launchd         | `launchctl list <label>`      | `~/Library/LaunchAgents/com.groundfloor.lore.plist` |
| Linux    | systemd (user)  | `systemctl --user status …`   | `~/.config/systemd/user/lore.service`    |
| Windows  | Service Control Manager | `sc query …`           | (registered service)                     |

The same `discover_daemon` IPC command will return platform-appropriate
state. Today (Phase 3d) only the macOS path is wired; Linux/Windows
fall through to `LaunchdState::NotApplicable` and the shell relies on
the bare HTTP probe.

## Decision provenance

This contract was set after the Phase 3d framing was caught: an earlier
design draft had the shell spawn the daemon as a child process. The
question "what happens to Claude Code's connection when the shell
closes?" surfaced the breakage. The Lore knowledge node
`shell-daemon-lifecycle-sibling-not-child` records the decision; this
file is its human-readable form.
