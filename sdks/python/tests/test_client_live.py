"""test_client_live.py — real integration test against a real spawned daemon.

Mirrors the spirit of test/mvp-live-e2e.ts / test/mvp-scale-e2e.ts's
live-daemon pattern (spawn a fresh, isolated daemon; drive it over the real
public REST surface; tear it down), scoped down to what a first-version
Python SDK needs to prove: `LoreSidecar` can actually spawn+manage a daemon,
and `LoreClient` can actually store/read/search/recall/bulk-write/delete
against it end to end.

No mocks — this spawns the real `lore serve --http` process (via tsx against
the repo's TypeScript source, same as live-daemon.ts) in an isolated HOME on
a free port, so it needs:
  - the repo's `node_modules` installed (native Kùzu/LanceDB/better-sqlite3
    bindings included)
  - a Node 22 binary reachable per `lore_client.sidecar._default_node_bin()`
    (PATH, `LORE_NODE_BIN`, or an nvm-managed v22.x install)

Deliberately keyword-based, not semantic-only: a fresh isolated HOME has an
empty embedding-model cache (`<LORE_HOME>/models/`), so a pure
vector-similarity assertion would either download a model over the network
on first run or be flaky/slow in a sandboxed CI environment. `search()`/
`recall()` here use a query that shares a real keyword with the stored
content, which Lore's hybrid retrieval satisfies via the BM25/keyword path
independent of whether the async embedding has landed yet — see
docs/API_REFERENCE.md's `vector_index_consulted` field, which this test
does NOT assert on for exactly that reason.
"""

from __future__ import annotations

import uuid

import pytest

from lore_client import LoreApiError, LoreSidecar

WORKSPACE = "default"


@pytest.fixture(scope="module")
def sidecar():
    with LoreSidecar(ready_timeout=45.0) as sc:
        yield sc


def test_health(sidecar: LoreSidecar) -> None:
    health = sidecar.client.health()
    assert health.status == "ok", f"daemon not healthy: {health!r}"


def test_store_read_search_recall_roundtrip(sidecar: LoreSidecar) -> None:
    client = sidecar.client
    node_id = f"py-sdk-test-{uuid.uuid4().hex[:8]}"
    label = "Python SDK smoke-test decision"
    content = (
        "The Python SDK wraps Lore's REST API and spawns a local daemon "
        "sidecar so callers get embedded-like ergonomics without a native "
        "port of the storage engines."
    )

    # ── write ────────────────────────────────────────────────────────
    result = client.upsert_node(
        id=node_id,
        type="decision",
        label=label,
        workspace=WORKSPACE,
        content=content,
        tags=["python-sdk", "smoke-test"],
    )
    assert result.ok, f"upsert_node failed: {result!r}"
    assert result.id == node_id
    assert result.isNew, "a freshly-generated uuid-suffixed id should be a create, not an update"

    # ── read back the full body ─────────────────────────────────────
    full = client.get_node_full(node_id, workspace=WORKSPACE)
    assert full.found, f"node-full didn't find {node_id!r}: {full!r}"
    assert full.id == node_id
    assert full.content == content
    assert "python-sdk" in full.tags

    # ── keyword search finds it by a real content word ─────────────
    search_result = client.search("sidecar", workspace=WORKSPACE)
    hit_ids = {h.id for h in search_result.results}
    assert node_id in hit_ids, (
        f"search() did not find {node_id!r} among {sorted(hit_ids)} "
        f"(resultCount={search_result.resultCount})"
    )

    # ── recall finds it too (hybrid: BM25/keyword path, no embedding
    #    readiness required) and reports a non-zero confidence ────────
    #
    # NOTE (real finding — see README "known gaps"): recall's keyword-only
    # fallback (no embedding index yet, since this test never waits for the
    # outbox to drain) is much stricter about multi-word phrasing than
    # search() is. A paraphrase like "Lore Python SDK sidecar ergonomics"
    # returns ZERO hits here even though search("sidecar") above found the
    # exact same node — the single keyword "sidecar" matches with score 1.0,
    # but a 5-word phrase with only partial term overlap doesn't clear
    # whatever relevance threshold applies before the vector pass exists to
    # help. Using a literal content substring, as below, is the reliable
    # query shape until the write's async embedding has landed.
    recall_result = client.recall("local daemon sidecar", workspace=WORKSPACE)
    recall_ids = {h.id for h in recall_result.hits}
    assert node_id in recall_ids, (
        f"recall() did not find {node_id!r} among {sorted(recall_ids)} "
        f"(totalRecalled={recall_result.totalRecalled})"
    )
    assert recall_result.meta is not None
    assert recall_result.meta.confidence > 0

    # ── node-full lookup of a never-written id returns found=False,
    #    not an exception ──────────────────────────────────────────
    missing = client.get_node_full(f"{node_id}-does-not-exist", workspace=WORKSPACE)
    assert missing.found is False

    # ── delete cleans it up, and a second delete 404s ───────────────
    deleted = client.delete_node(node_id, workspace=WORKSPACE)
    assert deleted.ok
    assert deleted.id == node_id
    with pytest.raises(LoreApiError) as exc_info:
        client.delete_node(node_id, workspace=WORKSPACE)
    assert exc_info.value.status_code == 404
    assert exc_info.value.code == "node_not_found"


def test_bulk_write(sidecar: LoreSidecar) -> None:
    client = sidecar.client
    prefix = f"py-sdk-bulk-{uuid.uuid4().hex[:8]}"
    nodes = [
        {"id": f"{prefix}-1", "type": "note", "label": "bulk one", "content": "alpha", "tags": "bulk"},
        {"id": f"{prefix}-2", "type": "note", "label": "bulk two", "content": "beta", "tags": "bulk"},
        {"id": f"{prefix}-3", "type": "note", "label": "bulk three", "content": "gamma", "tags": "bulk"},
    ]
    result = client.upsert_nodes_bulk(WORKSPACE, nodes)
    assert result.ok
    assert result.succeeded == 3, f"expected all 3 to succeed, got {result!r}"
    assert all(item.ok for item in result.results)


def test_workspace_listing_includes_default(sidecar: LoreSidecar) -> None:
    workspaces = sidecar.client.list_workspaces()
    names = {w.name for w in workspaces.workspaces}
    assert WORKSPACE in names, f"expected {WORKSPACE!r} in {sorted(names)}"


def test_cross_workspace_write_is_refused(sidecar: LoreSidecar) -> None:
    """Empirical finding (see sdks/python/README.md "known gaps"): the
    bootstrap ("god") token this test's daemon hands out via
    fetch_bootstrap_token() is NOT an unconfined daemon-operator bypass in
    this build, despite docs/GETTING_STARTED.md describing it as "free to
    read and write every workspace" — live, it resolves to a principal bound
    to the active workspace ("default") and gets refused with 403
    workspace_forbidden for a foreign workspace, same as a workspace-scoped
    app token would. The workspace-existence check (404 workspace_not_found)
    never runs because the confinement check rejects the request first.
    """
    client = sidecar.client
    with pytest.raises(LoreApiError) as exc_info:
        client.upsert_node(
            id="py-sdk-should-not-land",
            type="note",
            label="should not land",
            workspace="py-sdk-nonexistent-workspace",
        )
    assert exc_info.value.status_code == 403
    assert exc_info.value.code == "workspace_forbidden"
