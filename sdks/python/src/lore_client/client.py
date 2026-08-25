"""client.py — typed Python wrapper over Lore Core's REST API.

Lore Core's storage engines (SurrealDB/Kùzu, LanceDB, SQLite) are native
Node.js bindings — there is no in-process Python port, and this client does
not attempt one (see sdks/python/README.md). `LoreClient` talks to a running
`lore serve` daemon (default `http://127.0.0.1:3847`) over plain HTTP/JSON,
exactly like the `lore` CLI, the MCP HTTP transport, or a curl script would.
Pair it with `lore_client.sidecar.LoreSidecar` to spawn/manage that daemon
from Python so callers don't have to run a separate service by hand.

Endpoint coverage (see docs/API_REFERENCE.md for the full surface — this is a
deliberately-scoped first pass, not full parity):
  - GET  /health              -> health()
  - GET  /api/health          -> health_full()
  - POST /api/node            -> upsert_node()
  - POST /api/nodes/bulk      -> upsert_nodes_bulk()
  - GET  /api/node-full       -> get_node_full()
  - DELETE /api/node/:id      -> delete_node()
  - GET  /api/search          -> search()
  - GET  /api/recall          -> recall()
  - GET  /api/workspaces      -> list_workspaces()
  - POST /api/workspaces      -> create_workspace()
  - POST /api/workspaces/switch -> switch_workspace()
  - GET  /api/auth/bootstrap  -> LoreClient.fetch_bootstrap_token() (staticmethod)
"""

from __future__ import annotations

from typing import Any, Iterable, Optional, Union
from urllib.parse import quote

import httpx

from .models import (
    BulkWriteResponse,
    DeleteNodeResult,
    HealthStatus,
    LoreApiError,
    NodeFull,
    NodeUpsertResult,
    RecallResult,
    SearchResponse,
    WorkspacesFile,
)

DEFAULT_ECOSYSTEM = "*"
DEFAULT_TIMEOUT = 30.0
DEFAULT_BASE_URL = "http://127.0.0.1:3847"


class LoreClient:
    """REST client for one Lore daemon.

    Not a context-manager-only API: construct it, use it, and either call
    `.close()` when done or use it as a context manager (`with LoreClient(...)
    as c:`). Instances are NOT thread-safe beyond what the underlying
    `httpx.Client` guarantees (httpx.Client itself is thread-safe for
    concurrent requests).
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        token: Optional[str] = None,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        http_client: Optional[httpx.Client] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self._client = http_client or httpx.Client(timeout=timeout)
        self._owns_client = http_client is None

    # ── lifecycle ──────────────────────────────────────────────────────

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> "LoreClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # ── internals ──────────────────────────────────────────────────────

    def _headers(self, *, json_body: bool = False) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if json_body:
            headers["Content-Type"] = "application/json"
        return headers

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        resp = self._client.request(method, f"{self.base_url}{path}", **kwargs)
        if resp.status_code >= 400:
            self._raise_for_error(resp)
        return resp

    @staticmethod
    def _raise_for_error(resp: httpx.Response) -> None:
        """Parse the canonical `{code, message, ...extras}` error envelope
        (docs/API_REFERENCE.md) and raise LoreApiError. Falls back gracefully
        if a route ever returns a non-JSON or non-canonical error body."""
        body: Any = {}
        try:
            body = resp.json()
        except ValueError:
            pass
        if isinstance(body, dict):
            code = str(body.get("code", "unknown_error"))
            message = str(body.get("message", resp.text))
            extra = {k: v for k, v in body.items() if k not in ("code", "message")}
        else:
            code, message, extra = "unknown_error", resp.text, {}
        raise LoreApiError(resp.status_code, code, message, extra)

    # ── health ─────────────────────────────────────────────────────────

    def health(self) -> HealthStatus:
        """GET /health — minimal liveness probe. No auth required."""
        resp = self._request("GET", "/health")
        return HealthStatus.model_validate(resp.json())

    def health_full(self) -> dict[str, Any]:
        """GET /api/health — full daemon health snapshot (embedding backend,
        outbox depth/lag, background-reconnect state, ...). No auth required.
        Returned as a plain dict: the snapshot is large and evolves often, so
        it isn't modeled field-by-field yet — see the "gaps" note in the SDK
        README. `outbox.depth == 0` (when `outbox` is present) means the
        write pipeline has drained, useful for polling after a write before
        expecting semantic recall to see it.
        """
        resp = self._request("GET", "/api/health", headers=self._headers())
        return resp.json()

    # ── nodes ──────────────────────────────────────────────────────────

    def upsert_node(
        self,
        id: str,
        type: str,
        label: str,
        workspace: str,
        *,
        content: Optional[str] = None,
        tags: Optional[Union[list[str], str]] = None,
        ecosystem: str = DEFAULT_ECOSYSTEM,
        project: Optional[str] = None,
        embed: Optional[bool] = None,
    ) -> NodeUpsertResult:
        """POST /api/node — upsert a single knowledge node.

        A note on a real footgun this method exists to avoid: Lore's
        IN-PROCESS embedded API (`createLore().nodeUpsert()`, TypeScript-only,
        not exposed over REST) requires `id`/`ecosystem` to be repeated
        BOTH at the top level AND inside a nested `nodeData` object — the
        README calls this out explicitly, because omitting the nested copy
        throws (missing id) or silently defaults ecosystem to `'*'`. The
        REST route this method calls (`POST /api/node`) has no such nesting
        — the request body IS the node, flat, with no wrapper object — so
        that specific footgun does not exist at the REST layer. This method
        still takes `id`/`ecosystem`/etc. as plain keyword arguments (rather
        than a raw dict you'd have to shape by hand) so callers never have to
        read the wire format to get this right, and so behavior stays
        consistent if a future Lore release changes the REST body shape.
        """
        body: dict[str, Any] = {
            "id": id,
            "type": type,
            "label": label,
            "workspace": workspace,
            "ecosystem": ecosystem,
        }
        if content is not None:
            body["content"] = content
        if tags is not None:
            body["tags"] = tags
        if project is not None:
            body["project"] = project
        if embed is not None:
            body["embed"] = embed
        resp = self._request(
            "POST", "/api/node", headers=self._headers(json_body=True), json=body
        )
        return NodeUpsertResult.model_validate(resp.json())

    def upsert_nodes_bulk(
        self,
        workspace: str,
        nodes: Iterable[dict[str, Any]],
        *,
        embed: Optional[Union[str, bool]] = None,
    ) -> BulkWriteResponse:
        """POST /api/nodes/bulk — upsert up to 1000 nodes in one call.

        Each item of `nodes` is a plain dict shaped like the body of
        `upsert_node` (at minimum `id`/`type`/`label`; `workspace` is set
        once for the whole call, not per item). `embed` sets the call-level
        embed mode ('queued' | 'sync' | 'skip', or a bool shorthand) applied
        to items that don't set their own `embed`. The response is always
        HTTP 200 — check `result.results[i].ok` for each item's own outcome;
        a partial failure does not raise.
        """
        body: dict[str, Any] = {"workspace": workspace, "nodes": list(nodes)}
        if embed is not None:
            body["embed"] = embed
        resp = self._request(
            "POST",
            "/api/nodes/bulk",
            headers=self._headers(json_body=True),
            json=body,
        )
        return BulkWriteResponse.model_validate(resp.json())

    def get_node_full(self, id: str, workspace: str) -> NodeFull:
        """GET /api/node-full — the full body of a single node.

        Returns `NodeFull(found=False, ...)` rather than raising when the
        node doesn't exist (the route's 404 body is `{found: false, id}`,
        not the canonical error envelope) — check `.found` instead of
        wrapping every lookup in a try/except.
        """
        resp = self._client.get(
            f"{self.base_url}/api/node-full",
            headers=self._headers(),
            params={"id": id, "workspace": workspace},
        )
        if resp.status_code != 404 and resp.status_code >= 400:
            self._raise_for_error(resp)
        return NodeFull.model_validate(resp.json())

    def delete_node(self, id: str, workspace: str) -> DeleteNodeResult:
        """DELETE /api/node/:id — hard-delete a node + its edges (writes a
        verbatim tombstone so prior content stays recallable for history).
        Mirrors the MCP `delete_node` tool. Raises LoreApiError (code
        'node_not_found', HTTP 404) if the node doesn't exist.
        """
        resp = self._request(
            "DELETE",
            f"/api/node/{quote(id, safe='')}",
            headers=self._headers(),
            params={"workspace": workspace},
        )
        return DeleteNodeResult.model_validate(resp.json())

    # ── search / recall ───────────────────────────────────────────────

    def search(
        self,
        query: str,
        workspace: str,
        *,
        search_mode: Optional[str] = None,
        tags: Optional[list[str]] = None,
    ) -> SearchResponse:
        """GET /api/search — full-text / hybrid (semantic+keyword) content search.

        `search_mode`: 'semantic' | 'keyword' | 'hybrid' (server default:
        'hybrid'). `tags`: keep only nodes carrying ALL listed tags.
        """
        params: dict[str, Any] = {"q": query, "workspace": workspace}
        if search_mode is not None:
            params["search_mode"] = search_mode
        if tags:
            params["tags"] = ",".join(tags)
        resp = self._request(
            "GET", "/api/search", headers=self._headers(), params=params
        )
        return SearchResponse.model_validate(resp.json())

    def recall(
        self,
        topic: str,
        workspace: str,
        *,
        max: Optional[int] = None,
        cross_project: bool = False,
        search_mode: Optional[str] = None,
        tags: Optional[list[str]] = None,
        include_superseded: bool = False,
    ) -> RecallResult:
        """GET /api/recall — semantic recall: hybrid search + depth-1 graph
        traversal, summarized with a confidence envelope (`.meta.confidence`).
        This is Lore's primary retrieval call — prefer it over `search()` for
        "what do I already know about X" queries; use `search()` for a flat
        ranked list instead of the traversal + confidence shaping.

        `cross_project=True` widens the recall to every workspace/ecosystem
        the caller's token is allowed to read (requires a `cross-workspace-read`
        scoped token; a workspace-confined token gets 403 workspace_forbidden).
        """
        params: dict[str, Any] = {"topic": topic, "workspace": workspace}
        if max is not None:
            params["max"] = max
        if cross_project:
            params["crossProject"] = "true"
        if search_mode is not None:
            params["search_mode"] = search_mode
        if tags:
            params["tags"] = ",".join(tags)
        if include_superseded:
            params["include_superseded"] = "true"
        resp = self._request(
            "GET", "/api/recall", headers=self._headers(), params=params
        )
        return RecallResult.model_validate(resp.json())

    # ── workspaces ─────────────────────────────────────────────────────

    def list_workspaces(self) -> WorkspacesFile:
        """GET /api/workspaces — list every workspace known to this daemon."""
        resp = self._request("GET", "/api/workspaces", headers=self._headers())
        return WorkspacesFile.model_validate(resp.json())

    def create_workspace(
        self,
        name: str,
        *,
        label: Optional[str] = None,
        mode: Optional[str] = None,
        template: Optional[str] = None,
    ) -> dict[str, Any]:
        """POST /api/workspaces — create/register a new workspace (its own
        Kùzu/Surreal graph + LanceDB — full data isolation from every other
        workspace). `mode`: 'local-only' | 'local-sync' | 'cloud-only'."""
        body: dict[str, Any] = {"name": name}
        if label is not None:
            body["label"] = label
        if mode is not None:
            body["mode"] = mode
        if template is not None:
            body["template"] = template
        resp = self._request(
            "POST",
            "/api/workspaces",
            headers=self._headers(json_body=True),
            json=body,
        )
        return resp.json()

    def switch_workspace(self, name: str) -> dict[str, Any]:
        """POST /api/workspaces/switch — switch the daemon's active workspace.

        NOTE: this restarts the daemon process (the response is HTTP 202
        `{active, restarting: true}` and the connection then drops as the
        daemon drains and exits — a supervising process, e.g. launchd or
        `LoreSidecar`, is expected to relaunch it). A workspace-scoped app
        token normally has no reason to call this; it's here for parity with
        the REST surface and daemon-operator/admin use.
        """
        resp = self._request(
            "POST",
            "/api/workspaces/switch",
            headers=self._headers(json_body=True),
            json={"name": name},
        )
        return resp.json()

    # ── auth ───────────────────────────────────────────────────────────

    @staticmethod
    def fetch_bootstrap_token(
        base_url: str, *, http_client: Optional[httpx.Client] = None
    ) -> str:
        """GET /api/auth/bootstrap — fetch the daemon's bootstrap ("god")
        token. Mirrors test/helpers/live-daemon.ts's fetchAuthToken(): sends
        `Origin: <base_url>` so the daemon's Host+Origin localhost gate
        accepts it (see docs/GETTING_STARTED.md "Embedded mode" +
        "Connecting your app" for why this token is daemon-operator-scoped,
        not per-app — issue a `lore auth issue --workspace <name>` token
        instead for anything beyond local dev/test use).
        """
        owns_client = http_client is None
        client = http_client or httpx.Client(timeout=DEFAULT_TIMEOUT)
        try:
            resp = client.get(
                f"{base_url.rstrip('/')}/api/auth/bootstrap",
                headers={"Origin": base_url},
            )
            if resp.status_code != 200:
                raise LoreApiError(
                    resp.status_code, "bootstrap_failed", resp.text
                )
            return resp.json()["token"]
        finally:
            if owns_client:
                client.close()
