/**
 * Manifest IPC bridge — typed wrapper around the Rust `load_manifest`
 * command. Re-exports the canonical types from the Lore daemon package
 * so the rest of the shell consumes one type definition only.
 */
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

import type { PluginManifest } from '@lore/manifest';
export type {
    PluginManifest,
    LoreContribution,
    DEFContribution,
    InspectorPanel,
    InspectorKind,
    TableInspector,
    GraphInspector,
    TimelineInspector,
    DocumentInspector,
    InspectorColumn,
    AgentDescriptor,
    ScheduledTaskDescriptor,
} from '@lore/manifest';

/** What Rust returns from `load_manifest`. */
export interface LoadedManifest {
    sourcePath: string;
    bundleRoot: string;
    /**
     * Parsed manifest — typed as PluginManifest. Rust validates the
     * structural minimums (required fields, primitive contribution
     * presence, manifestVersion = 1); finer schema-level checks (e.g.
     * inspector renderer kinds) happen client-side here.
     */
    manifest: PluginManifest;
}

/**
 * Discriminated error shape returned by Rust's `ManifestError`. Mirrors
 * the `serde(tag = "kind", content = "detail")` representation in
 * `manifest.rs`. Don't loosen this to `unknown` — surfacing the kind is
 * the whole point.
 */
export type LoadManifestError =
    | { kind: 'NotFound'; detail: { path: string } }
    | { kind: 'NotReadable'; detail: { path: string; message: string } }
    | { kind: 'InvalidUtf8'; detail: { path: string } }
    | { kind: 'InvalidJson'; detail: { path: string; message: string } }
    | { kind: 'NotAnObject'; detail: { path: string } }
    | { kind: 'MissingField'; detail: { path: string; field: string } }
    | { kind: 'NoPrimitiveContribution'; detail: { path: string } }
    | { kind: 'UnsupportedManifestVersion'; detail: { path: string; version: number } };

export async function loadManifest(path: string): Promise<LoadedManifest> {
    return await invoke<LoadedManifest>('load_manifest', { path });
}

/**
 * Show the OS file-picker filtered to plugin.json. Returns the path the
 * user chose, or `null` if they cancelled.
 */
export async function pickManifestFile(): Promise<string | null> {
    const result = await open({
        multiple: false,
        directory: false,
        filters: [
            { name: 'Plugin manifest', extensions: ['json'] },
        ],
        title: 'Select plugin.json',
    });
    if (result == null) return null;
    // open() returns string for single, string[] for multi=true.
    return Array.isArray(result) ? (result[0] ?? null) : result;
}

/** Human-readable error message for the UI. */
export function describeError(err: LoadManifestError): string {
    switch (err.kind) {
        case 'NotFound':
            return `Manifest file not found: ${err.detail.path}`;
        case 'NotReadable':
            return `Cannot read manifest: ${err.detail.message}`;
        case 'InvalidUtf8':
            return 'Manifest file is not valid UTF-8.';
        case 'InvalidJson':
            return `Manifest is not valid JSON: ${err.detail.message}`;
        case 'NotAnObject':
            return 'Manifest must be a JSON object at the top level.';
        case 'MissingField':
            return `Required field missing: ${err.detail.field}`;
        case 'NoPrimitiveContribution':
            return 'Manifest must declare a `lore` and/or `def` contribution.';
        case 'UnsupportedManifestVersion':
            return `Unsupported manifestVersion: ${err.detail.version} (this shell understands version 1)`;
    }
}

/**
 * Best-effort parse for IPC error shapes. Tauri serialises Result::Err
 * as the JSON of the error variant; if Rust returns a different shape
 * (panic, internal error) we fall back to a stringified message.
 */
export function parseLoadError(raw: unknown): LoadManifestError | { kind: 'Unknown'; detail: { message: string } } {
    if (raw && typeof raw === 'object' && 'kind' in raw) {
        return raw as LoadManifestError;
    }
    return { kind: 'Unknown', detail: { message: String(raw) } };
}
