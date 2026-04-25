//! Lore daemon HTTP client (Phase 3c).
//!
//! The shell talks to the running Lore daemon over its local HTTP API on
//! port 3847 (override via `LORE_PORT` env var to match the daemon's own
//! convention). Calls happen Rust-side rather than from the renderer for
//! three reasons:
//!
//!   1. **CORS-free**: the daemon's `validateRequest` accepts requests with
//!      no Origin header (Rust reqwest's default), so we skip the browser
//!      origin dance entirely.
//!   2. **Auth-token confinement**: the bootstrap token never reaches JS.
//!      Renderer code only sees parsed payloads.
//!   3. **Single transport**: when 3d adds discovery against launchd, the
//!      probe and the data fetch share one client.
//!
//! Phase 3c surface — minimal:
//!   - `daemon_health()`         → `Result<HealthReport, DaemonError>`
//!   - `daemon_topology(limit)`  → `Result<TopologyResponse, DaemonError>`
//!
//! Auth flow: GET `/api/auth/bootstrap` is the only public path that
//! returns the token (Host + Origin gated; Origin-less Rust calls pass).
//! All subsequent calls send `Authorization: Bearer <token>`. The token is
//! cached in-process for the life of the shell.

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Default port — matches `LORE_HTTP_PORT` in
/// `packages/lore/src/mcp/server.ts`. Env override mirrors the daemon's
/// own override (`LORE_PORT`).
const DEFAULT_PORT: u16 = 3847;
const HEALTH_TIMEOUT_MS: u64 = 1500;
const TOPOLOGY_TIMEOUT_MS: u64 = 8000;

/// Discriminated error shape returned to the frontend. Mirrors
/// `manifest::ManifestError`'s serde representation so the same parse
/// helpers on the JS side work.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum DaemonError {
    /// Daemon HTTP port did not respond within the timeout. Most likely
    /// the launchd service is not running.
    Unreachable { port: u16, message: String },
    /// Daemon answered but with a non-2xx status — surface the code so
    /// the frontend can distinguish 4xx (auth/cors/orphan-gate) from 5xx.
    HttpStatus { port: u16, status: u16, body: String },
    /// Auth bootstrap returned a body we couldn't parse as `{ token }`.
    BadBootstrapBody { message: String },
    /// JSON shape from the daemon didn't match what we expected. Happens
    /// when the daemon is a future version with breaking response shape;
    /// detail captures the raw body so the user can report it.
    InvalidResponse { message: String },
    /// Anything else — network plumbing, tls, etc.
    Internal { message: String },
}

#[derive(Debug, Serialize)]
pub struct HealthReport {
    pub port: u16,
    /// Daemon-reported status (currently "ok" when the `/health` endpoint
    /// responds). We surface it raw so the frontend can show the field
    /// without us deciding what counts as healthy.
    pub status: String,
    pub version: Option<String>,
    pub sessions: Option<u64>,
    /// Phase 8 — Dataplane bind state, surfaced from the daemon's
    /// /api/health payload. One of: "unknown" / "offline" / "opted-out"
    /// / "bound" / "error". The shell renders this as a separate pill
    /// alongside the daemon-status pill so the user can see at a glance
    /// whether their workspace is currently syncing to the team
    /// dataplane.
    pub dataplane: Option<String>,
    /// Effective deployment mode reported by the daemon: "local"
    /// (single-process Kùzu+LanceDB) or "cloud" (Dataplane-backed).
    /// Optional because older daemons (<2.1) won't include it.
    #[serde(rename = "deploymentMode")]
    pub deployment_mode: Option<String>,
    /// Whether telemetry is opted out — when true, the daemon never
    /// fires the dataplane health ping. Surface it so the pill can
    /// distinguish "no key" (offline) from "key exists but user
    /// disabled it" (opted-out).
    #[serde(rename = "telemetryOptOut")]
    pub telemetry_opt_out: Option<bool>,
}

/// Wire shape of `/api/topology`. Deliberately permissive — node/edge
/// shapes vary by plugin contribution, so we keep them as opaque
/// `serde_json::Value`. The frontend narrows when rendering.
#[derive(Debug, Serialize, Deserialize)]
pub struct TopologyResponse {
    pub nodes: Vec<serde_json::Value>,
    pub edges: Vec<serde_json::Value>,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub limit: u32,
    #[serde(rename = "totalCoreNodes", default)]
    pub total_core_nodes: u64,
}

#[derive(Debug, Deserialize)]
struct BootstrapBody {
    token: String,
}

#[derive(Debug, Deserialize)]
struct HealthBody {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    sessions: Option<u64>,
    /// Phase 8 — daemon's Dataplane bind state. See server.ts
    /// `getDataplaneState()`. May be absent on older daemons.
    #[serde(default)]
    dataplane: Option<String>,
    #[serde(default, rename = "deploymentMode")]
    deployment_mode: Option<String>,
    #[serde(default, rename = "telemetryOptOut")]
    telemetry_opt_out: Option<bool>,
}

/// Token cache. Bootstrap is idempotent on the daemon side, but the
/// daemon issues a fresh token on each restart, so the cache is per-shell-
/// process and doesn't survive a daemon restart. We don't try to detect
/// staleness here — if a token goes stale we'll get a 401 on the next
/// data call and re-bootstrap on demand.
static TOKEN: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn token_cell() -> &'static Mutex<Option<String>> {
    TOKEN.get_or_init(|| Mutex::new(None))
}

fn daemon_port() -> u16 {
    std::env::var("LORE_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn build_client(timeout_ms: u64) -> Result<reqwest::Client, DaemonError> {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        // Don't send Origin; the daemon's allowed-origin list explicitly
        // accepts an absent Origin (Rust reqwest's default).
        .build()
        .map_err(|e| DaemonError::Internal {
            message: format!("reqwest client build failed: {e}"),
        })
}

async fn fetch_token(port: u16) -> Result<String, DaemonError> {
    let client = build_client(HEALTH_TIMEOUT_MS)?;
    let url = format!("http://127.0.0.1:{port}/api/auth/bootstrap");
    let resp = client.get(&url).send().await.map_err(|e| {
        if e.is_timeout() || e.is_connect() {
            DaemonError::Unreachable {
                port,
                message: e.to_string(),
            }
        } else {
            DaemonError::Internal {
                message: format!("bootstrap GET failed: {e}"),
            }
        }
    })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(DaemonError::HttpStatus {
            port,
            status: status.as_u16(),
            body,
        });
    }

    let body: BootstrapBody = resp.json().await.map_err(|e| DaemonError::BadBootstrapBody {
        message: e.to_string(),
    })?;

    Ok(body.token)
}

async fn token(port: u16, force_refresh: bool) -> Result<String, DaemonError> {
    let mut guard = token_cell().lock().await;
    if !force_refresh {
        if let Some(t) = guard.as_ref() {
            return Ok(t.clone());
        }
    }
    let fresh = fetch_token(port).await?;
    *guard = Some(fresh.clone());
    Ok(fresh)
}

/// Probe `/api/health`. Public path on the daemon — no token required.
pub async fn health() -> Result<HealthReport, DaemonError> {
    let port = daemon_port();
    let client = build_client(HEALTH_TIMEOUT_MS)?;
    let url = format!("http://127.0.0.1:{port}/api/health");
    let resp = client.get(&url).send().await.map_err(|e| {
        if e.is_timeout() || e.is_connect() {
            DaemonError::Unreachable {
                port,
                message: e.to_string(),
            }
        } else {
            DaemonError::Internal {
                message: format!("health GET failed: {e}"),
            }
        }
    })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(DaemonError::HttpStatus {
            port,
            status: status.as_u16(),
            body,
        });
    }

    let body: HealthBody = resp.json().await.map_err(|e| DaemonError::InvalidResponse {
        message: format!("health parse failed: {e}"),
    })?;

    Ok(HealthReport {
        port,
        status: body.status.unwrap_or_else(|| "ok".to_string()),
        version: body.version,
        sessions: body.sessions,
        dataplane: body.dataplane,
        deployment_mode: body.deployment_mode,
        telemetry_opt_out: body.telemetry_opt_out,
    })
}

/// Fetch `/api/topology?limit=<limit>`. Bootstraps a token if we don't
/// have one cached. On 401 we transparently re-bootstrap once and retry
/// — covers daemon-restart-while-shell-runs.
pub async fn topology(limit: u32) -> Result<TopologyResponse, DaemonError> {
    let port = daemon_port();
    let resp = topology_attempt(port, limit, false).await;
    match resp {
        Err(DaemonError::HttpStatus { status: 401, .. }) => {
            // Stale token — refresh + retry once.
            topology_attempt(port, limit, true).await
        }
        other => other,
    }
}

async fn topology_attempt(
    port: u16,
    limit: u32,
    force_refresh_token: bool,
) -> Result<TopologyResponse, DaemonError> {
    let tok = token(port, force_refresh_token).await?;
    let client = build_client(TOPOLOGY_TIMEOUT_MS)?;
    let url = format!("http://127.0.0.1:{port}/api/topology?limit={limit}");
    let resp = client
        .get(&url)
        .bearer_auth(tok)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() || e.is_connect() {
                DaemonError::Unreachable {
                    port,
                    message: e.to_string(),
                }
            } else {
                DaemonError::Internal {
                    message: format!("topology GET failed: {e}"),
                }
            }
        })?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(DaemonError::HttpStatus {
            port,
            status: status.as_u16(),
            body,
        });
    }

    resp.json::<TopologyResponse>()
        .await
        .map_err(|e| DaemonError::InvalidResponse {
            message: format!("topology parse failed: {e}"),
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topology_response_parses_minimal_shape() {
        // Daemon may omit truncated/limit/totalCoreNodes on older versions
        // — defaulting them keeps us forward+backward compatible.
        let raw = r#"{ "nodes": [], "edges": [] }"#;
        let parsed: TopologyResponse = serde_json::from_str(raw).expect("should parse");
        assert!(parsed.nodes.is_empty());
        assert!(parsed.edges.is_empty());
        assert!(!parsed.truncated);
        assert_eq!(parsed.limit, 0);
        assert_eq!(parsed.total_core_nodes, 0);
    }

    #[test]
    fn topology_response_parses_full_shape() {
        let raw = r#"{
            "nodes": [{ "id": "n1", "label": "Hello", "type": "Email" }],
            "edges": [],
            "truncated": true,
            "limit": 5000,
            "totalCoreNodes": 12345
        }"#;
        let parsed: TopologyResponse = serde_json::from_str(raw).expect("should parse");
        assert_eq!(parsed.nodes.len(), 1);
        assert!(parsed.truncated);
        assert_eq!(parsed.limit, 5000);
        assert_eq!(parsed.total_core_nodes, 12345);
    }

    #[test]
    fn daemon_port_falls_back_to_default() {
        // Don't assume the test runner doesn't have LORE_PORT set.
        // We only care that the function returns *some* sensible u16.
        let p = daemon_port();
        assert!(p > 0);
    }

    #[test]
    fn health_body_parses_with_dataplane_fields() {
        // Phase 8 — the daemon's /api/health includes dataplane,
        // deploymentMode, and telemetryOptOut. We must surface them.
        let raw = r#"{
            "status": "ok",
            "version": "2.1.0",
            "sessions": 3,
            "dataplane": "bound",
            "deploymentMode": "cloud",
            "telemetryOptOut": false
        }"#;
        let body: HealthBody = serde_json::from_str(raw).expect("parses");
        assert_eq!(body.dataplane.as_deref(), Some("bound"));
        assert_eq!(body.deployment_mode.as_deref(), Some("cloud"));
        assert_eq!(body.telemetry_opt_out, Some(false));
    }

    #[test]
    fn health_body_tolerates_missing_dataplane_fields() {
        // Older daemons (<2.1) omit these. We must NOT fail to parse —
        // the shell still needs to render a daemon-status pill even
        // against a stale daemon that doesn't yet expose dataplane.
        let raw = r#"{ "status": "ok", "version": "2.0.0" }"#;
        let body: HealthBody = serde_json::from_str(raw).expect("parses");
        assert!(body.dataplane.is_none());
        assert!(body.deployment_mode.is_none());
        assert!(body.telemetry_opt_out.is_none());
    }
}
