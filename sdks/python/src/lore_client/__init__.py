"""lore_client — Python client for Lore Core.

Lore is a local-first tri-substrate (graph+vector+relational) database for
AI agent memory. This package is a REST client over Lore's HTTP API
(docs/API_REFERENCE.md) plus a small process launcher (`LoreSidecar`) that
spawns/manages a local `lore serve` daemon, so Python apps get "no separate
service to start by hand" ergonomics without Lore needing a native Python
port (its storage engines are Node.js bindings — see sidecar.py and the SDK
README for why this is REST-over-a-spawned-daemon, not true embedding).

    from lore_client import LoreSidecar

    with LoreSidecar(repo_root="/path/to/groundfloor-lore") as sidecar:
        client = sidecar.client
        client.upsert_node(
            id="decision-001", type="decision", label="Use httpx",
            workspace="default", content="...",
        )
        result = client.recall("decision about httpx", workspace="default")

Or against an already-running daemon (production / non-dev use):

    from lore_client import LoreClient

    client = LoreClient("http://127.0.0.1:3847", token="lore_myapp_...")
"""

from .client import DEFAULT_BASE_URL, LoreClient
from .models import (
    BulkItemResult,
    BulkWriteResponse,
    DeleteNodeResult,
    HealthStatus,
    LoreApiError,
    NodeFull,
    NodeUpsertResult,
    RecallHit,
    RecallMeta,
    RecallNode,
    RecallResult,
    SearchHit,
    SearchResponse,
    WorkspaceEntry,
    WorkspacesFile,
)
from .sidecar import LoreSidecar, LoreSidecarError

__all__ = [
    "LoreClient",
    "DEFAULT_BASE_URL",
    "LoreSidecar",
    "LoreSidecarError",
    "LoreApiError",
    "NodeUpsertResult",
    "NodeFull",
    "BulkItemResult",
    "BulkWriteResponse",
    "DeleteNodeResult",
    "SearchHit",
    "SearchResponse",
    "RecallHit",
    "RecallNode",
    "RecallMeta",
    "RecallResult",
    "WorkspaceEntry",
    "WorkspacesFile",
    "HealthStatus",
]

__version__ = "0.1.0"
