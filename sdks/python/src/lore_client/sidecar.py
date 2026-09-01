"""sidecar.py — spawn/manage a local `lore serve` daemon from Python.

Lore Core's storage engines are native Node.js bindings (SurrealDB/Kùzu,
LanceDB, better-sqlite3) — there is no way to run Lore in-process inside a
Python interpreter. `LoreSidecar` is the next best thing: it spawns the real
daemon as a subprocess (an isolated data dir + a free port, exactly like the
`lore serve --http` a human would run), waits for it to report healthy,
fetches its auth token, and hands back a ready-to-use `LoreClient`. Callers
get "no separate service to start by hand" ergonomics without Lore needing a
Python port.

This mirrors test/helpers/live-daemon.ts's spawnDaemon() / waitForReady() /
fetchAuthToken() / killDaemon() pattern as closely as Python allows:
  - spawn `node --import tsx packages/lore/src/mcp/server.ts --http`
  - env: HOME=<isolated dir>, LORE_PORT=<free port>, PATH, TMPDIR (nothing
    else — the daemon's own env-scrub logic drops the rest)
  - poll GET /health until 200 (150ms interval, matches the TS helper)
  - fetch the bootstrap token via GET /api/auth/bootstrap
  - on teardown, kill the whole process GROUP (not just the child), so a
    detached grandchild can't hold the on-disk graph lock across a restart
    — Python's twin of the TS helper's `process.kill(-pid, signal)` is
    `os.killpg` over a session started with `start_new_session=True`.

Requires Node 22 — Lore's native bindings (Kùzu, LanceDB, better-sqlite3) are
built against Node 22 and fail NODE_MODULE_VERSION checks under Node 20. See
`_default_node_bin()` for how the Node 22 binary is located.
"""

from __future__ import annotations

import os
import pathlib
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
from typing import Optional

import httpx

from .client import LoreClient

DEFAULT_READY_TIMEOUT = 30.0
_POLL_INTERVAL = 0.15
_LOG_TAIL_LINES = 2000
_SERVER_ENTRY_REL = ("packages", "lore", "src", "mcp", "server.ts")


class LoreSidecarError(RuntimeError):
    """Raised when the sidecar can't locate a Node 22 binary / repo checkout,
    or the daemon fails to become ready."""


def _find_free_port() -> int:
    """Twin of live-daemon.ts's findFreePort(): bind port 0, read it back,
    close it. Same TOCTOU window the TS helper accepts (negligible in
    practice for a locally-spawned daemon started immediately after)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _node_major_version(node_bin: str) -> Optional[int]:
    try:
        out = subprocess.run(
            [node_bin, "-v"], capture_output=True, text=True, timeout=10, check=True
        ).stdout.strip()
        # e.g. "v22.18.0"
        return int(out.lstrip("v").split(".")[0])
    except Exception:
        return None


def _default_node_bin() -> str:
    """Resolve a Node 22 binary. Order:
    1. `LORE_NODE_BIN` env var (explicit override).
    2. `node` on PATH, if it's already >= 22.
    3. An nvm-managed v22.x install (`$NVM_DIR/versions/node/v22*/bin/node`,
       default `~/.nvm`) — the common case on a dev machine that also has
       Node 20 as its default, which is exactly the situation Lore's own
       repo docs call out (native modules require Node 22).
    4. `node` on PATH anyway, as a last resort (the daemon will fail fast
       with a clear NODE_MODULE_VERSION error if it's the wrong major).
    """
    override = os.environ.get("LORE_NODE_BIN")
    if override:
        return override

    on_path = shutil.which("node")
    if on_path is not None:
        major = _node_major_version(on_path)
        if major is not None and major >= 22:
            return on_path

    nvm_dir = os.environ.get("NVM_DIR", os.path.expanduser("~/.nvm"))
    versions_dir = os.path.join(nvm_dir, "versions", "node")
    if os.path.isdir(versions_dir):
        candidates = sorted(
            (v for v in os.listdir(versions_dir) if v.startswith("v22")),
            reverse=True,
        )
        for v in candidates:
            candidate = os.path.join(versions_dir, v, "bin", "node")
            if os.path.isfile(candidate):
                return candidate

    if on_path is not None:
        return on_path

    raise LoreSidecarError(
        "no `node` executable found on PATH, and no Node 22 install found "
        "under ~/.nvm/versions/node/. Lore's native bindings (Kùzu/LanceDB/"
        "better-sqlite3) require Node 22 — set LORE_NODE_BIN to an explicit "
        "Node 22 binary path."
    )


def _discover_repo_root(start: Optional[str] = None) -> str:
    """Walk upward from `start` (default: cwd) looking for
    packages/lore/src/mcp/server.ts — the daemon entrypoint live-daemon.ts
    spawns. `LORE_REPO_ROOT` overrides. Only meaningful when running against
    a source checkout (dev/test use); a pip-installed deployment that talks
    to an already-running daemon should skip LoreSidecar entirely and
    construct LoreClient directly.
    """
    override = os.environ.get("LORE_REPO_ROOT")
    if override:
        return override

    here = pathlib.Path(start or os.getcwd()).resolve()
    for candidate in (here, *here.parents):
        if (candidate.joinpath(*_SERVER_ENTRY_REL)).is_file():
            return str(candidate)

    raise LoreSidecarError(
        "could not locate the groundfloor-lore repo root (no "
        f"{'/'.join(_SERVER_ENTRY_REL)} found walking up from "
        f"{here}). Pass repo_root=... explicitly, or set LORE_REPO_ROOT."
    )


class LoreSidecar:
    """Context manager that spawns a local `lore serve` daemon and hands
    back a ready-to-use `LoreClient`.

    Usage:

        with LoreSidecar(repo_root="/path/to/groundfloor-lore") as sidecar:
            client = sidecar.client
            client.upsert_node(...)
        # daemon is torn down (whole process group killed) on exit.

    Or without the context manager:

        sidecar = LoreSidecar(repo_root=...).start()
        try:
            ...
        finally:
            sidecar.stop()
    """

    def __init__(
        self,
        *,
        repo_root: Optional[str] = None,
        home: Optional[str] = None,
        port: Optional[int] = None,
        node_bin: Optional[str] = None,
        command: Optional[list[str]] = None,
        ready_timeout: float = DEFAULT_READY_TIMEOUT,
        keep_home: bool = False,
    ) -> None:
        """
        repo_root: path to a groundfloor-lore checkout. Auto-discovered from
            cwd (or `LORE_REPO_ROOT`) if omitted — see `_discover_repo_root`.
            Not required if `command` is given.
        home: data directory for this daemon instance (its `<LORE_HOME>`).
            A fresh `tempfile.mkdtemp()` is used if omitted, and removed on
            `stop()` unless `keep_home=True`.
        port: TCP port to bind. A free port is chosen if omitted.
        node_bin: explicit Node 22 binary. Auto-detected if omitted — see
            `_default_node_bin`.
        command: full argv to spawn instead of the tsx-direct pattern (e.g.
            `["lore", "serve", "--http"]` against an installed/linked CLI).
            When given, `repo_root`/`node_bin` are not required or used for
            spawning, but the working directory is still `repo_root` if set,
            else the caller's cwd.
        ready_timeout: seconds to wait for GET /health to return 200.
        keep_home: if True, `stop()` leaves the data directory on disk
            (useful for inspecting a failed run). Default False.
        """
        self._repo_root_arg = repo_root
        self._node_bin_arg = node_bin
        self.command = command
        self.home = home
        self.port = port
        self.ready_timeout = ready_timeout
        self.keep_home = keep_home
        self._owns_home = home is None

        self.token: Optional[str] = None
        self._proc: Optional[subprocess.Popen] = None
        self._client: Optional[LoreClient] = None
        self._log_lines: list[str] = []
        self._log_lock = threading.Lock()
        self._log_thread: Optional[threading.Thread] = None

    # ── properties ─────────────────────────────────────────────────────

    @property
    def base_url(self) -> str:
        if self.port is None:
            raise LoreSidecarError("sidecar not started — call .start() first")
        return f"http://127.0.0.1:{self.port}"

    @property
    def client(self) -> LoreClient:
        """A `LoreClient` bound to this daemon, created lazily on first
        access and reused thereafter."""
        if self._proc is None or self.token is None:
            raise LoreSidecarError(
                "sidecar not started — call .start() or use it as a context manager"
            )
        if self._client is None:
            self._client = LoreClient(self.base_url, self.token)
        return self._client

    @property
    def log_text(self) -> str:
        """Captured stdout+stderr of the daemon process (bounded tail),
        useful for diagnosing a failed start()."""
        with self._log_lock:
            return "".join(self._log_lines)

    # ── lifecycle ──────────────────────────────────────────────────────

    def start(self) -> "LoreSidecar":
        if self._proc is not None:
            return self  # already started; idempotent

        self.home = self.home or tempfile.mkdtemp(prefix="lore-py-sdk-")
        self.port = self.port or _find_free_port()

        if self.command is not None:
            argv = self.command
            cwd = self._repo_root_arg or os.getcwd()
        else:
            repo_root = self._repo_root_arg or _discover_repo_root()
            node_bin = self._node_bin_arg or _default_node_bin()
            server_entry = str(pathlib.Path(repo_root, *_SERVER_ENTRY_REL))
            if not os.path.isfile(server_entry):
                raise LoreSidecarError(
                    f"daemon entrypoint not found at {server_entry} — is "
                    f"repo_root ({repo_root}) a groundfloor-lore checkout?"
                )
            argv = [node_bin, "--import", "tsx", server_entry, "--http"]
            cwd = repo_root

        # Minimal env, mirroring live-daemon.ts's spawnDaemon(): PATH (so
        # node/npm-resolved tooling works), HOME (isolates the data dir —
        # this IS <LORE_HOME>), TMPDIR, LORE_PORT. The daemon's own env-scrub
        # (mcp/processOwnership.ts) drops everything else at boot anyway.
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": self.home,
            "TMPDIR": tempfile.gettempdir(),
            "LORE_PORT": str(self.port),
        }

        # start_new_session=True (setsid) is the Python twin of the TS
        # helper's detached:true — puts the daemon in its own process
        # GROUP so stop() can signal the whole group (node + any child it
        # spawns), not just the direct child, and can't be left holding the
        # on-disk graph lock across a restart.
        self._proc = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        self._log_thread = threading.Thread(target=self._drain_log, daemon=True)
        self._log_thread.start()

        if not self._wait_for_ready(self.ready_timeout):
            tail = self.log_text[-4000:]
            self.stop()
            raise LoreSidecarError(
                f"lore daemon never became ready on port {self.port} within "
                f"{self.ready_timeout}s\n--- daemon log tail ---\n{tail}"
            )

        # The bootstrap route requires the one-time nonce minted at boot
        # to <home>/.groundfloor/bootstrap.nonce (0600, same trust tier
        # as auth.token) — see packages/lore/src/security/authToken.ts.
        # HOME is set to self.home above with no LORE_HOME override, so
        # that's the daemon's default data home.
        nonce_path = pathlib.Path(self.home) / ".groundfloor" / "bootstrap.nonce"
        nonce = nonce_path.read_text().strip()
        self.token = LoreClient.fetch_bootstrap_token(self.base_url, nonce=nonce)
        return self

    def stop(self) -> None:
        """Kill the daemon's whole process group and (unless `keep_home`)
        remove its data directory. Safe to call multiple times."""
        if self._client is not None:
            self._client.close()
            self._client = None

        if self._proc is not None:
            pid = self._proc.pid
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
            try:
                self._proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                pass
            self._proc = None

        if self._log_thread is not None:
            self._log_thread.join(timeout=2)
            self._log_thread = None

        if self._owns_home and not self.keep_home and self.home:
            shutil.rmtree(self.home, ignore_errors=True)

    def __enter__(self) -> "LoreSidecar":
        return self.start()

    def __exit__(self, *exc_info: object) -> None:
        self.stop()

    # ── internals ──────────────────────────────────────────────────────

    def _drain_log(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        for line in self._proc.stdout:
            with self._log_lock:
                self._log_lines.append(line)
                if len(self._log_lines) > _LOG_TAIL_LINES:
                    del self._log_lines[: len(self._log_lines) - _LOG_TAIL_LINES]

    def _wait_for_ready(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        with httpx.Client(timeout=2.0) as probe:
            while time.monotonic() < deadline:
                if self._proc is not None and self._proc.poll() is not None:
                    return False  # process already exited — no point polling further
                try:
                    if probe.get(f"{self.base_url}/health").status_code == 200:
                        return True
                except httpx.HTTPError:
                    pass
                time.sleep(_POLL_INTERVAL)
        return False
