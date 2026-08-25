/**
 * workspaceRegistry.ts — Phase 1 item 13.
 *
 * Single source of truth for the workspace ↔ CWD-path mapping that
 * lives under <LORE_HOME>. Replaces the legacy `projects.json` file
 * and legacy "project" vocabulary with `workspace-paths.json` and
 * "workspace" — see docs/architecture/SCHEMA_CHANGE_SAFETY_MEMO.md and the
 * convention-workspace-not-project node in the developer workspace.
 *
 * **Filename note**: `workspaces.json` was already taken in LORE_HOME
 * by `config/workspaces.ts` (the multi-workspace listing — `active`
 * + `workspaces[]`). To avoid a collision, the path-mapping registry
 * lives at `workspace-paths.json` instead. Same per-row data the old
 * projects.json carried; on-disk key remains `projects` for back-
 * compat with downstream readers.
 *
 * **Vocabulary**: in user-facing language the unit is *workspace*
 * (what you create, switch between, share via Dataplane). "Project"
 * is leftover developer terminology that leaks the implementation
 * and is being audited out. The on-disk key (`projects`) stays the
 * same for read compat — only the file name and tool name change in
 * this slice. A future PR will rename the in-file key in lockstep
 * with every reader.
 *
 * **Migration on read**: if `workspace-paths.json` is missing AND
 * `projects.json` exists, this module performs a one-time copy
 * (atomic write-rename) on the next read. The legacy `projects.json`
 * is left in place for one release cycle so a downgrade still works;
 * subsequent writes only target `workspace-paths.json`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loreHomePath } from './loreHome.js';

/**
 * One row in the registry. Field name `paths` matches what every
 * existing reader (`bootSteps.ts`, `cli/commands/*`, the legacy
 * `register_project` MCP tool) expects.
 */
export interface WorkspaceMapping {
    ecosystem: string;
    paths: string[];
}

/**
 * On-disk shape. Keyed under `projects` for backward compatibility
 * with all existing readers — renaming the key is its own follow-up
 * (would require a migration of every reader in lockstep).
 */
export interface WorkspaceRegistryFile {
    projects: Record<string, WorkspaceMapping>;
}

const WORKSPACE_PATHS_FILENAME = 'workspace-paths.json';
const LEGACY_PROJECTS_FILENAME = 'projects.json';

/** Absolute path to the canonical registry file (`workspace-paths.json`). */
export function workspaceRegistryPath(): string {
    return loreHomePath(WORKSPACE_PATHS_FILENAME);
}

/** Absolute path to the legacy registry file (`projects.json`). */
export function legacyProjectsRegistryPath(): string {
    return loreHomePath(LEGACY_PROJECTS_FILENAME);
}

/**
 * Read the registry. Behavior:
 *   - If `workspaces.json` exists → read it.
 *   - Else if `projects.json` exists → run the one-time migration
 *     (copy projects.json → workspaces.json atomically) and return
 *     the contents.
 *   - Else → return an empty registry. Caller-side concern whether
 *     to materialise on disk.
 *
 * Returns `{ projects: {} }` on any parse error (matches the
 * pre-rename behavior in `bootSteps.loadProjectRegistry` and
 * `governance.register_project`).
 */
export function readWorkspaceRegistry(): WorkspaceRegistryFile {
    const target = workspaceRegistryPath();
    const legacy = legacyProjectsRegistryPath();

    if (!fs.existsSync(target) && fs.existsSync(legacy)) {
        try {
            migrateProjectsJsonToWorkspacesJson();
        } catch {
            // Migration is best-effort; if it fails, fall through
            // to read legacy directly so the daemon still boots.
            return safeRead(legacy);
        }
    }

    if (fs.existsSync(target)) return safeReadOrEmpty(target);
    if (fs.existsSync(legacy)) return safeReadOrEmpty(legacy);
    return { projects: {} };
}

/**
 * Write the registry to `workspaces.json` atomically (write-rename).
 * Creates LORE_HOME if missing.
 */
export function writeWorkspaceRegistry(registry: WorkspaceRegistryFile): void {
    const target = workspaceRegistryPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 4) + '\n', 'utf-8');
    fs.renameSync(tmp, target);
}

/**
 * upsert one mapping. Returns whether the entry already existed (so
 * the caller can report "registered" vs "updated").
 */
export function upsertWorkspaceMapping(
    registry: WorkspaceRegistryFile,
    name: string,
    mapping: WorkspaceMapping,
): { alreadyExisted: boolean } {
    const alreadyExisted = name in registry.projects;
    registry.projects[name] = mapping;
    return { alreadyExisted };
}

/**
 * One-time copy of `projects.json` → `workspaces.json`. Idempotent:
 * a no-op if `workspaces.json` already exists. Leaves
 * `projects.json` in place so a daemon downgrade still works for one
 * release cycle.
 *
 * Exposed for boot-time invocation (see `bootSteps.ts`) so the
 * migration runs deterministically at startup, not lazily on first
 * read. Both paths are safe.
 */
export function migrateProjectsJsonToWorkspacesJson(): { migrated: boolean; reason?: string } {
    const target = workspaceRegistryPath();
    const legacy = legacyProjectsRegistryPath();

    if (fs.existsSync(target)) {
        return { migrated: false, reason: 'workspaces.json already present' };
    }
    if (!fs.existsSync(legacy)) {
        return { migrated: false, reason: 'projects.json not present; nothing to migrate' };
    }

    const contents = fs.readFileSync(legacy, 'utf-8');
    // Validate JSON before writing so a corrupt legacy file doesn't
    // produce a corrupt new file.
    JSON.parse(contents);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, contents, 'utf-8');
    fs.renameSync(tmp, target);
    return { migrated: true };
}

/**
 * Read JSON at `p`. Returns `{ projects: {} }` on any of: parse
 * error, missing file, OR shape mismatch (file present but doesn't
 * look like a workspace-paths registry — protects against a stray
 * `workspaces.json`-shaped file slipping in).
 */
function safeReadOrEmpty(p: string): WorkspaceRegistryFile {
    try {
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<WorkspaceRegistryFile>;
        if (!parsed || typeof parsed.projects !== 'object' || parsed.projects === null) {
            return { projects: {} };
        }
        return { projects: parsed.projects };
    } catch {
        return { projects: {} };
    }
}

function safeRead(p: string): WorkspaceRegistryFile {
    return safeReadOrEmpty(p);
}
