//! Lore Shell — Tauri 2 host process.
//!
//! Phase 3a is the scaffold: boots a window, exposes one IPC command
//! (`shell_info`) so the frontend can verify the bridge works. Manifest
//! loading, daemon lifecycle, and inspector wiring land in 3b/3c/3d.

use serde::Serialize;

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
    /// We haven't checked for the daemon yet (current state in Phase 3a).
    Unknown,
    /// Daemon process is reachable on the expected port.
    #[allow(dead_code)]
    Running,
    /// We checked and there is no daemon running.
    #[allow(dead_code)]
    Absent,
}

#[tauri::command]
fn shell_info() -> ShellInfo {
    ShellInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        // Phase 3d wires the actual probe; for now we return Unknown so
        // the UI surface is honest about the state.
        lore_daemon_status: DaemonStatus::Unknown,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![shell_info])
        .run(tauri::generate_context!())
        .expect("error while running lore-shell tauri application");
}
