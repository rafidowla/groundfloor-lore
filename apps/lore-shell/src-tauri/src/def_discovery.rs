//! DEF runtime discovery (Phase 6 — DEF as shell primitive #2).
//!
//! Mirrors `discovery.rs` for the Lore daemon, but for the DEF runtime.
//! The two-primitives-one-shell architecture (see `docs/DEF_LOCAL_FIRST.md`
//! and the `two-primitives-one-shell-architecture` Lore decision) makes
//! the shell host both Lore and DEF as siblings — both launchd-managed,
//! neither shell-spawned. This module is the read-only DEF half.
//!
//! Why a separate module from `discovery.rs`:
//!   - Different launchd label and plist filename
//!     (`com.groundfloor.def` / `com.groundfloor.def.plist`).
//!   - **No HTTP probe.** Per Phase 5a (`docs/DEF_LOCAL_FIRST.md`) DEF
//!     is an MCP *client*, not a server — it talks to Lore via Lore's
//!     MCP HTTP interface and uses embedded SQLite for transient
//!     runtime state. There's no port for the shell to ping. Visibility
//!     is launchd state only (loaded / running / PID).
//!   - DEF has its own `def.*` plugin-manifest contributions (agents,
//!     scheduled tasks); the shell renders those independently of the
//!     Lore-specific inspectors. Discovery and rendering surface are
//!     intentionally decoupled.
//!
//! Read-only contract — same as `discovery.rs`:
//!   - Shell never starts/stops DEF, never sends signals, never edits
//!     the plist. All those are explicit operator actions.
//!   - `launchctl list <label>` is read-only and is what Activity
//!     Monitor / `ps` would do anyway.
//!
//! Future scope (out of this slice):
//!   - DEF status RPC: if DEF eventually exposes a localhost control
//!     port (e.g. for "currently-running agent" telemetry), add an
//!     equivalent of `daemon::health` here. For now, launchd state +
//!     "is the process alive" via PID is enough for the shell to
//!     render an informative pill.
//!   - Linux/Windows: same fall-through as Lore (`NotApplicable`).

use serde::Serialize;

use crate::discovery::{lookup_launchd_state, LaunchdState};

/// DEF launchd job label. Matches the `Label` key in
/// `com.groundfloor.def.plist`. Hard-coded here for the same reason
/// `discovery.rs` hard-codes the Lore daemon label: changing it
/// requires shipping a new plist anyway.
const DEF_LAUNCHD_LABEL: &str = "com.groundfloor.def";
const DEF_PLIST_FILENAME: &str = "com.groundfloor.def.plist";

#[derive(Debug, Serialize)]
pub struct DiscoverDefReport {
    /// "macos" / "linux" / "windows" / "other". Same convention as
    /// `DiscoverReport.platform`.
    pub platform: String,
    /// Read-only launchd state for the DEF runtime. Reuses the
    /// existing `LaunchdState` enum so the frontend's existing
    /// state-mapping helpers (`describeLaunchdState`) work unchanged.
    pub launchd: LaunchdState,
    /// The daemon-side health probe fetches `/api/health`; DEF has no
    /// equivalent today, so we don't expose an `http_health` field at
    /// all. When DEF eventually exposes a control port we'll add it
    /// here as `Option<DefHealthReport>`.
    pub label: String,
    pub plist_filename: String,
}

pub async fn discover_def() -> DiscoverDefReport {
    let platform = detect_platform();
    let launchd = lookup_launchd_state(DEF_LAUNCHD_LABEL, DEF_PLIST_FILENAME);
    DiscoverDefReport {
        platform,
        launchd,
        label: DEF_LAUNCHD_LABEL.to_string(),
        plist_filename: DEF_PLIST_FILENAME.to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn discover_def_returns_a_report_on_any_platform() {
        let report = discover_def().await;
        // We can't assume anything about whether DEF is installed on
        // the test runner — but we CAN assume the report is
        // well-formed and the label/filename round-trip.
        assert_eq!(report.label, DEF_LAUNCHD_LABEL);
        assert_eq!(report.plist_filename, DEF_PLIST_FILENAME);
        assert!(["macos", "linux", "windows", "other"].contains(&report.platform.as_str()));
        // Variants are platform-dependent; just verify we got SOME
        // serialisable variant rather than panicking.
        let _serialized = serde_json::to_string(&report.launchd)
            .expect("LaunchdState should always serialise");
    }
}
