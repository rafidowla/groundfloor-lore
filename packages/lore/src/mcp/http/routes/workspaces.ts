/**
 * workspaces.ts — dispatcher for workspace management routes.
 * Handlers live under ./workspaces/.
 *
 *   workspaceMgmt — list/create/switch/rename/delete + retention GET/PATCH
 *                                                       (workspaces/workspaceMgmt.ts)
 *
 * Repo routes (/api/repos*) were removed in v3.11.0 when the plugin system
 * (which owned repo-registry state) was removed. Atlas owns that surface now.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspacesDeps } from './workspaces/shared.js';
import { tryWorkspaceMgmtRoutes } from './workspaces/workspaceMgmt.js';

export type { WorkspacesDeps } from './workspaces/shared.js';

export async function tryWorkspacesRoutes(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
    pathname: string,
    deps: WorkspacesDeps,
): Promise<boolean> {
    if (await tryWorkspaceMgmtRoutes(req, res, url, pathname, deps)) return true;
    return false;
}
