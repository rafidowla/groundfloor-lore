"""models.py — typed request/response shapes for Lore Core's REST API.

Mirrors the wire shapes documented in docs/API_REFERENCE.md and read directly
from the route handlers under packages/lore/src/mcp/http/routes/ (that's the
ground truth this file was written against — see:
  - postNode.ts            -> NodeUpsertResult
  - nodeFull.ts             -> NodeFull
  - bulkWrite.ts            -> BulkWriteResponse / BulkItemResult
  - search.ts               -> SearchResponse / SearchHit (via
                               recall/retrievalProjection.ts's UnifiedResultItem)
  - recall/recallPreset.ts  -> RecallResult / RecallHit / RecallMeta
  - config/workspaces.ts    -> WorkspaceEntry / WorkspacesFile

All response models use `extra="allow"` so additive fields the daemon ships
later don't break parsing — this is a REST client against a fast-moving
daemon, not a schema-locked contract. Well-known fields are still typed so
editors/IDEs get real autocomplete + type checking for the common path.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class LoreApiError(Exception):
    """Raised for any non-2xx response from the Lore REST API.

    Carries the canonical error envelope every Lore REST route returns on
    failure (docs/API_REFERENCE.md, "Error envelope (canonical)"):

        { "code": "workspace_forbidden", "message": "human-readable text" }

    Client code should branch on `.code` (a stable, machine-matchable
    snake_case identifier), never on `.message` (wording is not a stable
    contract across releases). `.status_code` is the HTTP status, which IS
    part of the contract (403 stays 403, 400 stays 400, ...). `.extra` holds
    any additional machine-relevant fields an error carries alongside
    code/message (e.g. `outbox_lag` adds `currentLagSeconds`, `retryAfterSeconds`).
    """

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        extra: Optional[dict[str, Any]] = None,
    ) -> None:
        super().__init__(f"HTTP {status_code} [{code}]: {message}")
        self.status_code = status_code
        self.code = code
        self.message = message
        self.extra = extra or {}


class _Loose(BaseModel):
    """Base for response models: tolerate additive server-side fields."""

    model_config = ConfigDict(extra="allow")


# ─── Nodes ──────────────────────────────────────────────────────────────


class NodeUpsertResult(_Loose):
    """Response body of POST /api/node."""

    ok: bool
    id: str
    isNew: bool = False
    warning: Optional[str] = None


class NodeFull(_Loose):
    """Response body of GET /api/node-full.

    `found=False` on a 404 (the route returns `{found: false, id}` rather
    than the canonical error envelope for a missing node — LoreClient
    surfaces that as a normal return value, not an exception, so callers can
    do `if not node.found:` without a try/except).

    NOTE: `metadata` is a **JSON-encoded string** on the wire, not a nested
    object (confirmed against a live daemon — `LoreNode.metadata` is stored
    as a serialized string internally; the route passes it through as-is via
    `node.metadata ?? null`). Parse it yourself with `json.loads(...)` when
    non-None if you need the structured value.
    """

    found: bool
    id: Optional[str] = None
    type: Optional[str] = None
    label: Optional[str] = None
    project: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    content: Optional[str] = None
    language: Optional[str] = None
    metadata: Optional[str] = None


class BulkItemResult(_Loose):
    """One entry of BulkWriteResponse.results — mirrors the request array's order."""

    ok: bool
    id: Optional[str] = None
    error: Optional[str] = None


class BulkWriteResponse(_Loose):
    """Response body of POST /api/nodes/bulk (also shared shape for
    /api/edges/bulk and /api/nodes/bulk-delete — always HTTP 200 with a
    per-item results array; check `.results[i].ok` for per-item outcome)."""

    ok: bool
    count: int = 0
    succeeded: int = 0
    results: list[BulkItemResult] = Field(default_factory=list)


class DeleteNodeResult(_Loose):
    """Response body of DELETE /api/node/:id."""

    ok: bool
    id: str
    tombstoned: bool = False


# ─── Search ─────────────────────────────────────────────────────────────


class SearchHit(_Loose):
    """One result item of GET /api/search — the UnifiedResultItem shape
    shared with the MCP `search` tool (recall/retrievalProjection.ts)."""

    id: str
    type: str
    label: str
    content: str
    tags: list[str] = Field(default_factory=list)
    project: str
    language: Optional[str] = None
    matchedBy: list[str] = Field(default_factory=list)
    score: float = 0.0
    stale_warning: Optional[bool] = None


class SearchResponse(_Loose):
    """Response body of GET /api/search."""

    query: str
    workspace: str
    resultCount: int = 0
    vector_index_consulted: bool = False
    scan_cap_hit: Optional[bool] = None
    tag_filter: Optional[list[str]] = None
    results: list[SearchHit] = Field(default_factory=list)


# ─── Recall ─────────────────────────────────────────────────────────────


class RecallHit(_Loose):
    """One `hits[]` entry of a 'summary'-mode RecallResult."""

    id: str
    type: str
    label: str
    project: str
    tags: list[str] = Field(default_factory=list)
    snippet: Optional[str] = None
    source: str
    stale_warning: Optional[bool] = None


class RecallNode(_Loose):
    """One `knowledge[]` entry of a 'full'-mode RecallResult."""

    id: str
    type: str
    label: str
    content: str
    tags: list[str] = Field(default_factory=list)
    project: str
    source: str
    language: Optional[str] = None
    stale_warning: Optional[bool] = None


class RecallMeta(_Loose):
    """The `_meta` confidence envelope on a 'summary'-mode RecallResult."""

    confidence: float = 0.0
    negative_evidence: Optional[str] = None
    top_score: Optional[float] = None
    sources_consulted: int = 0
    vector_index_consulted: bool = False
    truncated: Optional[bool] = None
    dropped_count: Optional[int] = None
    total_matched: Optional[int] = None
    scan_cap_hit: Optional[bool] = None


class RecallResult(_Loose):
    """Response body of GET /api/recall.

    Covers BOTH response shapes the daemon can return (docs/API_REFERENCE.md
    + recall/recallPreset.ts RecallResultSummary | RecallResultFull):

      - mode='summary' (the REST default): `hits` + `shown` + `_meta`
        (exposed here as `.meta`, since a leading underscore is not a legal
        plain Python field name — the wire key is still `_meta`).
      - mode='full': `knowledge` + `directMatches` + `connectedMatches`.

    Both variants populate `topic`/`scope`/`totalRecalled`; the mode-specific
    fields are None when absent for the shape you got back. `extra="allow"`
    means unmodeled fields survive a round trip even if this model is behind
    the wire format.
    """

    topic: str
    mode: str
    searchMode: Optional[str] = None
    scope: dict[str, str] = Field(default_factory=dict)
    crossProject: bool = False
    totalRecalled: int = 0

    # summary-mode fields
    shown: Optional[int] = None
    projectsSeen: list[str] = Field(default_factory=list)
    hits: list[RecallHit] = Field(default_factory=list)
    meta: Optional[RecallMeta] = Field(default=None, alias="_meta")

    # full-mode fields
    directMatches: Optional[int] = None
    connectedMatches: Optional[int] = None
    knowledge: list[RecallNode] = Field(default_factory=list)

    model_config = ConfigDict(extra="allow", populate_by_name=True)


# ─── Workspaces ─────────────────────────────────────────────────────────


class WorkspaceEntry(_Loose):
    """One entry of GET /api/workspaces' `workspaces[]` array
    (config/workspaces.ts WorkspaceEntry — only the common fields are
    modeled; the rest pass through via extra="allow")."""

    name: str
    label: Optional[str] = None
    mode: Optional[str] = None
    path: Optional[str] = None
    createdAt: Optional[str] = None
    graphEngine: Optional[str] = None


class WorkspacesFile(_Loose):
    """Response body of GET /api/workspaces."""

    active: str
    workspaces: list[WorkspaceEntry] = Field(default_factory=list)


# ─── Health ─────────────────────────────────────────────────────────────


class HealthStatus(_Loose):
    """Response body of GET /health (liveness only — no auth required)."""

    status: str
    version: Optional[str] = None
    sessions: Optional[int] = None
