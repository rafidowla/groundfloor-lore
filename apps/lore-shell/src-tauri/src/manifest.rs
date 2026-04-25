//! Plugin manifest loader (Phase 3b).
//!
//! Reads a `plugin.json` (or `plugin.yaml` later) bundle descriptor from
//! disk and returns a structurally-validated value to the frontend.
//!
//! Design choice: we keep the canonical manifest **shape** in TypeScript
//! (`packages/lore/src/plugins/manifest.ts`) and treat the JSON as
//! semi-opaque on the Rust side. Rust validates:
//!   - file exists + is readable
//!   - body is valid UTF-8
//!   - body parses as JSON (top-level object)
//!   - required identity fields are present (`manifestVersion`, `name`,
//!     `version`, `description`)
//!   - at least one of `lore` / `def` is present
//!
//! Anything beyond that — inspector kinds, agent shape, permission
//! namespaces — is the frontend's job, because the frontend already has
//! the canonical TS types and a single source of truth beats two parsers
//! drifting.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
pub struct LoadedManifest {
    /// Absolute path to the manifest file we loaded.
    pub source_path: String,
    /// Absolute path to the bundle root (the file's parent dir). Frontend
    /// uses this to resolve relative `lore.module` paths and inspector
    /// asset references.
    pub bundle_root: String,
    /// Parsed JSON. Frontend narrows this to `PluginManifest` from
    /// `packages/lore/src/plugins/manifest.ts`.
    pub manifest: Value,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum ManifestError {
    NotFound { path: String },
    NotReadable { path: String, message: String },
    InvalidUtf8 { path: String },
    InvalidJson { path: String, message: String },
    NotAnObject { path: String },
    MissingField { path: String, field: &'static str },
    NoPrimitiveContribution { path: String },
    UnsupportedManifestVersion { path: String, version: i64 },
}

const REQUIRED_FIELDS: &[&str] = &["manifestVersion", "name", "version", "description"];
const SUPPORTED_MANIFEST_VERSION: i64 = 1;

/// Load + validate a manifest from an arbitrary file path.
pub fn load_from_path(path: &Path) -> Result<LoadedManifest, ManifestError> {
    let abs = canonicalize_for_error(path);

    if !path.exists() {
        return Err(ManifestError::NotFound { path: abs.clone() });
    }

    let bytes = std::fs::read(path).map_err(|e| ManifestError::NotReadable {
        path: abs.clone(),
        message: e.to_string(),
    })?;

    let text = std::str::from_utf8(&bytes).map_err(|_| ManifestError::InvalidUtf8 {
        path: abs.clone(),
    })?;

    let value: Value = serde_json::from_str(text).map_err(|e| ManifestError::InvalidJson {
        path: abs.clone(),
        message: e.to_string(),
    })?;

    let obj = value.as_object().ok_or_else(|| ManifestError::NotAnObject {
        path: abs.clone(),
    })?;

    for field in REQUIRED_FIELDS {
        if !obj.contains_key(*field) {
            return Err(ManifestError::MissingField {
                path: abs.clone(),
                field,
            });
        }
    }

    // manifestVersion sanity check — defends against future-incompatible
    // bundles being silently accepted.
    let version = obj
        .get("manifestVersion")
        .and_then(|v| v.as_i64())
        .ok_or(ManifestError::MissingField {
            path: abs.clone(),
            field: "manifestVersion",
        })?;
    if version != SUPPORTED_MANIFEST_VERSION {
        return Err(ManifestError::UnsupportedManifestVersion {
            path: abs.clone(),
            version,
        });
    }

    // At least one primitive contribution must exist.
    let has_lore = obj.get("lore").is_some_and(|v| !v.is_null());
    let has_def = obj.get("def").is_some_and(|v| !v.is_null());
    if !has_lore && !has_def {
        return Err(ManifestError::NoPrimitiveContribution { path: abs.clone() });
    }

    let bundle_root = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(LoadedManifest {
        source_path: abs,
        bundle_root,
        manifest: value,
    })
}

fn canonicalize_for_error(path: &Path) -> String {
    PathBuf::from(path)
        .canonicalize()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn write_fixture(dir: &Path, body: &str) -> PathBuf {
        let p = dir.join("plugin.json");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(body.as_bytes()).unwrap();
        p
    }

    #[test]
    fn loads_valid_manifest() {
        let dir = tempdir().unwrap();
        let p = write_fixture(
            dir.path(),
            r#"{
              "manifestVersion": 1,
              "name": "x",
              "version": "0.1.0",
              "description": "d",
              "lore": { "module": "./i.js" }
            }"#,
        );
        let m = load_from_path(&p).expect("should load");
        assert!(m.manifest.get("lore").is_some());
    }

    #[test]
    fn rejects_missing_field() {
        let dir = tempdir().unwrap();
        let p = write_fixture(
            dir.path(),
            r#"{ "manifestVersion": 1, "name": "x" }"#,
        );
        match load_from_path(&p).unwrap_err() {
            ManifestError::MissingField { field, .. } => {
                assert!(["version", "description"].contains(&field));
            }
            other => panic!("wrong error: {:?}", other),
        }
    }

    #[test]
    fn rejects_no_primitive_contribution() {
        let dir = tempdir().unwrap();
        let p = write_fixture(
            dir.path(),
            r#"{
              "manifestVersion": 1,
              "name": "x",
              "version": "0.1.0",
              "description": "d"
            }"#,
        );
        matches!(
            load_from_path(&p).unwrap_err(),
            ManifestError::NoPrimitiveContribution { .. }
        );
    }

    #[test]
    fn rejects_future_version() {
        let dir = tempdir().unwrap();
        let p = write_fixture(
            dir.path(),
            r#"{
              "manifestVersion": 99,
              "name": "x",
              "version": "0.1.0",
              "description": "d",
              "lore": {}
            }"#,
        );
        matches!(
            load_from_path(&p).unwrap_err(),
            ManifestError::UnsupportedManifestVersion { version: 99, .. }
        );
    }
}
