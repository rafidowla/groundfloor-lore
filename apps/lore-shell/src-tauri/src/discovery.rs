//! Daemon discovery (Phase 3d).
//!
//! The Lore daemon is a **sibling** of the shell, not a child. Closing
//! the shell must NOT kill the daemon, because external MCP clients
//! (Claude Code, Cursor, Antigravity, Claude Desktop, ChatGPT local)
//! depend on the same daemon being continuously available. The daemon
//! is owned by launchd via `~/Library/LaunchAgents/com.groundfloor.lore.plist`.
//!
//! This module is **read-only by design**. It detects state, it does not
//! mutate it. Loading/unloading the plist, starting/stopping the daemon,
//! and editing the plist are all explicit user actions that go through
//! separate, opt-in commands (none in this slice).
//!
//! Discovery procedure:
//!   1. Identify the platform. launchd is macOS-specific — on Linux we'd
//!      read `~/.config/systemd/user/`, on Windows the Service Control
//!      Manager. Today we only ship the macOS path; other platforms get
//!      `LaunchdState::NotApplicable` and fall back to the bare HTTP
//!      probe.
//!   2. Locate the plist. Search the standard LaunchAgents paths.
//!   3. Ask launchctl whether the job is loaded + has a PID.
//!   4. Probe the HTTP health endpoint.
//!
//! Lifecycle contract this module enforces (by inaction):
//!   - Shell never spawns the daemon as a child. (No `Command::new`
//!     pointing at the daemon binary.)
//!   - Shell never sends signals to the daemon PID.
//!   - Shell may invoke `launchctl list` (read-only), which is what
//!     Activity Monitor / `ps` would do anyway.

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

use crate::daemon::{HealthReport, DaemonError};

/// The launchd job label that owns the daemon. Matches the `Label` key in
/// `com.groundfloor.lore.plist` (single source of truth lives in the
/// daemon repo's plist; we hard-code the label here because changing it
/// requires shipping a new plist anyway).
const DAEMON_LAUNCHD_LABEL: &str = "com.groundfloor.lore";
const DAEMON_PLIST_FILENAME: &str = "com.groundfloor.lore.plist";

/// Read-only view of launchd state for the daemon job. Mapped from
/// `launchctl list <label>` output — the macOS-stable contract.
///
/// Generic over which job we're inspecting. Phase 3d uses this for the
/// Lore daemon (`com.groundfloor.lore`); Phase 6 reuses it for the DEF
/// runtime (`com.groundfloor.def`) via `def_discovery.rs`. The variants
/// are job-agnostic by design — "plist missing", "loaded not running",
/// "running with PID" mean the same thing for any launchd-managed
/// service.
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
pub enum LaunchdState {
    /// Not running on macOS — launchd is irrelevant. Other platforms
    /// flow through this variant until their respective service-manager
    /// integrations land.
    NotApplicable,
    /// We searched the standard LaunchAgents paths and didn't find a
    /// `com.groundfloor.lore.plist`. The daemon may still be running
    /// (manually started), but it's not under launchd's care.
    PlistMissing,
    /// Plist exists, but `launchctl list <label>` doesn't know about it.
    /// User probably needs to `launchctl load` it.
    NotLoaded { plist_path: String },
    /// Job is loaded; launchctl reports a non-zero PID. This is the
    /// happy state.
    Running { plist_path: String, pid: u32 },
    /// Job is loaded but launchctl reports no PID — happens when the
    /// service crashed and is between respawns, or when KeepAlive is
    /// false and the daemon hasn't been triggered yet.
    LoadedNotRunning { plist_path: String },
    /// `launchctl` returned a non-zero exit or unparseable output. We
    /// surface the raw stderr/stdout so the user can report it.
    UnknownError { message: String },
}

#[derive(Debug, Serialize)]
pub struct DiscoverReport {
    /// "macos" / "linux" / "windows" / "other".
    pub platform: String,
    /// Read-only launchd state.
    pub launchd: LaunchdState,
    /// HTTP health probe result. `Some(Ok)` = daemon answered.
    /// `Some(Err)` = port unreachable / non-2xx / other. `None` is
    /// reserved for "we deliberately skipped the probe" (currently we
    /// always probe; included for forward-compat).
    pub http_health: Option<HealthReport>,
    pub http_error: Option<DaemonError>,
}

pub async fn discover() -> DiscoverReport {
    let platform = detect_platform();

    let launchd = if platform == "macos" {
        macos_launchd_state()
    } else {
        LaunchdState::NotApplicable
    };

    // Always probe HTTP. Even when launchd reports the job as Running,
    // the HTTP port may not be ready yet; even when launchd reports
    // PlistMissing the user may have started the daemon manually.
    let (http_health, http_error) = match crate::daemon::health().await {
        Ok(report) => (Some(report), None),
        Err(err) => (None, Some(err)),
    };

    DiscoverReport {
        platform,
        launchd,
        http_health,
        http_error,
    }
}

fn detect_platform() -> String {
    if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "linux") {
        "linux".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else {
        "other".to_string()
    }
}

/// Locate a `<filename>.plist` in the standard LaunchAgents paths.
/// Returns the first hit. Order (highest priority first):
///   1. `$HOME/Library/LaunchAgents/`           — per-user (most common)
///   2. `/Library/LaunchAgents/`                — system-wide, all users
///   3. `/Library/LaunchDaemons/`               — root-owned daemon
///
/// Anywhere else (custom GUIs, dev installs) is out of scope; the user
/// can launchctl-load it manually and the HTTP probe will still find it.
///
/// Phase 6 generalises this from a single hard-coded filename
/// (com.groundfloor.lore.plist) to any job — DEF reuses it through
/// `def_discovery::find_def_plist()` without copy-paste.
pub(crate) fn find_plist_by_name(filename: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(
            PathBuf::from(home)
                .join("Library/LaunchAgents")
                .join(filename),
        );
    }
    candidates.push(PathBuf::from("/Library/LaunchAgents").join(filename));
    candidates.push(PathBuf::from("/Library/LaunchDaemons").join(filename));
    candidates.into_iter().find(|p| p.exists())
}

/// Generic launchd-state lookup for any job. Used by both the Lore
/// daemon's `discover()` and DEF's `discover_def()` to avoid duplicating
/// the launchctl-output parsing.
///
/// On non-macOS platforms returns `LaunchdState::NotApplicable` (other
/// service-manager integrations will replace this in future).
pub(crate) fn lookup_launchd_state(label: &str, plist_filename: &str) -> LaunchdState {
    #[cfg(target_os = "macos")]
    {
        macos_launchd_state_for(label, plist_filename)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (label, plist_filename);
        LaunchdState::NotApplicable
    }
}

#[cfg(target_os = "macos")]
fn macos_launchd_state() -> LaunchdState {
    macos_launchd_state_for(DAEMON_LAUNCHD_LABEL, DAEMON_PLIST_FILENAME)
}

#[cfg(target_os = "macos")]
fn macos_launchd_state_for(label: &str, plist_filename: &str) -> LaunchdState {
    let plist_path_opt = find_plist_by_name(plist_filename);
    let plist_path_str = plist_path_opt
        .as_ref()
        .map(|p| p.to_string_lossy().to_string());

    // Ask launchctl whether the job is loaded.
    let output = Command::new("launchctl")
        .args(["list", label])
        .output();

    match output {
        Ok(out) if out.status.success() => {
            // Output is a plist-style block; parse "PID" line. Format:
            //   {
            //       "StandardOutPath" = "/tmp/lore.out";
            //       "PID" = 12345;
            //       ...
            //   }
            let stdout = String::from_utf8_lossy(&out.stdout);
            let pid = parse_pid_from_launchctl(&stdout);
            match (pid, plist_path_str) {
                (Some(pid), Some(path)) => LaunchdState::Running { plist_path: path, pid },
                (Some(pid), None) => {
                    // Job is loaded but plist isn't where we expected — still
                    // useful info; surface as Running with a placeholder path.
                    LaunchdState::Running {
                        plist_path: "(unknown — loaded from non-standard path)".to_string(),
                        pid,
                    }
                }
                (None, Some(path)) => LaunchdState::LoadedNotRunning { plist_path: path },
                (None, None) => LaunchdState::LoadedNotRunning {
                    plist_path: "(unknown)".to_string(),
                },
            }
        }
        Ok(out) => {
            // launchctl returned non-zero. Most common case: job not loaded
            // (exit 113 historically, exit 5 modernly). Distinguish "not
            // loaded but plist exists" from "no plist anywhere".
            let _stderr = String::from_utf8_lossy(&out.stderr);
            match plist_path_str {
                Some(path) => LaunchdState::NotLoaded { plist_path: path },
                None => LaunchdState::PlistMissing,
            }
        }
        Err(e) => LaunchdState::UnknownError {
            message: format!("launchctl invocation failed: {e}"),
        },
    }
}

#[cfg(not(target_os = "macos"))]
fn macos_launchd_state() -> LaunchdState {
    LaunchdState::NotApplicable
}

/// Parse the `PID` value out of a `launchctl list <label>` plist-style
/// dump. Returns None if the field is absent or 0.
fn parse_pid_from_launchctl(stdout: &str) -> Option<u32> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        // Lines look like: `"PID" = 12345;` — handle whitespace and quotes
        // tolerantly because launchctl output has shifted across macOS
        // versions.
        if !trimmed.starts_with("\"PID\"") && !trimmed.starts_with("PID") {
            continue;
        }
        // Find `=` then the digits before `;`.
        let after_eq = trimmed.split('=').nth(1)?.trim();
        let digits: String = after_eq
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if digits.is_empty() {
            return None;
        }
        let pid: u32 = digits.parse().ok()?;
        if pid == 0 {
            return None;
        }
        return Some(pid);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modern_launchctl_output() {
        let raw = r#"{
    "StandardOutPath" = "/tmp/lore.out";
    "StandardErrorPath" = "/tmp/lore.err";
    "Label" = "com.groundfloor.lore";
    "OnDemand" = false;
    "LastExitStatus" = 0;
    "PID" = 54321;
    "Program" = "/usr/local/bin/lore-daemon";
};"#;
        assert_eq!(parse_pid_from_launchctl(raw), Some(54321));
    }

    #[test]
    fn returns_none_when_pid_is_zero() {
        let raw = r#"{
    "Label" = "com.groundfloor.lore";
    "PID" = 0;
};"#;
        assert_eq!(parse_pid_from_launchctl(raw), None);
    }

    #[test]
    fn returns_none_when_pid_is_missing() {
        let raw = r#"{
    "Label" = "com.groundfloor.lore";
    "LastExitStatus" = 0;
};"#;
        assert_eq!(parse_pid_from_launchctl(raw), None);
    }

    #[test]
    fn detect_platform_returns_known_value() {
        let p = detect_platform();
        assert!(["macos", "linux", "windows", "other"].contains(&p.as_str()));
    }
}
