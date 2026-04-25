//! Lore Shell — Tauri 2 host process.
//!
//! Phase 3a was the scaffold. Phase 3b added the manifest loader IPC
//! command. Phase 3c added the HTTP bridge to the running Lore daemon
//! (health probe + topology fetch). Phase 3d adds launchd-aware
//! discovery so the shell can tell the user *why* the daemon is
//! reachable or not — see `discovery.rs` for the sibling-not-child
//! lifecycle contract.

use std::path::PathBuf;

use serde::Serialize;

mod daemon;
mod discovery;
mod manifest;

/// Shell metadata reported to the frontend on boot.
#[derive(Serialize)]
struct ShellInfo {
    version: String,
    #[serde(rename = "loreDaemonStatus")]
    lore_daemon_status: DaemonStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum DaemonStatus {
    /// We haven't probed for the daemon yet (current state pre-3d).
    Unknown,
    /// Daemon HTTP port answered the probe.
    #[allow(dead_code)]
    Running,
    /// We probed and the daemon is not reachable.
    #[allow(dead_code)]
    Absent,
}

#[tauri::command]
fn shell_info() -> ShellInfo {
    ShellInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        // Phase 3d turns this into a real launchd-aware probe. Phase 3c
        // exposes daemon_health() as a separate IPC command so the
        // frontend can probe on demand without us wiring a sync probe
        // into shell_info (which is called once at startup).
        lore_daemon_status: DaemonStatus::Unknown,
    }
}

/// Load + validate a `plugin.json` (or future `plugin.yaml`) manifest.
///
/// Returns the parsed manifest as opaque JSON; the frontend narrows it
/// to `PluginManifest` from `packages/lore/src/plugins/manifest.ts`. Rust
/// only enforces structural minimums (see `manifest::load_from_path`);
/// schema-level validation lives in TypeScript where the canonical types
/// already live.
#[tauri::command]
fn load_manifest(path: String) -> Result<manifest::LoadedManifest, manifest::ManifestError> {
    manifest::load_from_path(&PathBuf::from(path))
}

/// Phase 3c — probe the local Lore daemon's `/api/health` endpoint.
/// Public path on the daemon, no auth needed. Used by the frontend to
/// flip the daemon-status pill on demand.
#[tauri::command]
async fn daemon_health() -> Result<daemon::HealthReport, daemon::DaemonError> {
    daemon::health().await
}

/// Phase 3c — fetch `/api/topology?limit=<limit>`. The shell uses this
/// to populate `TableInspector` rows. Token bootstrap is handled inside
/// `daemon::topology` and cached in-process. The frontend filters nodes
/// to a single entity type per inspector and renders configured columns.
#[tauri::command]
async fn daemon_topology(limit: u32) -> Result<daemon::TopologyResponse, daemon::DaemonError> {
    daemon::topology(limit).await
}

/// Phase 3d — read-only daemon discovery. Reports launchd job state
/// (macOS only today) PLUS HTTP health in a single payload so the UI
/// can render an actionable status (e.g. "plist found but not loaded —
/// run `launchctl load`"). This is read-only by design; the shell
/// never starts, stops, or kills the daemon. See `discovery.rs`.
#[tauri::command]
async fn discover_daemon() -> discovery::DiscoverReport {
    discovery::discover().await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            shell_info,
            load_manifest,
            daemon_health,
            daemon_topology,
            discover_daemon
        ])
        .run(tauri::generate_context!())
        .expect("error while running lore-shell tauri application");
}
