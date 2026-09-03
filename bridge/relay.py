#!/usr/bin/env python3
"""Airlock Relay local bridge.

Serves the built Relay page on 127.0.0.1 and feeds it live facts from a
running Airlock router: the same GET /diagnostics and GET /v1/models the
router already exposes on loopback. Nothing in the router changes and the
router stays bound to loopback. The page keeps owning the handoff proposal;
this bridge only reports runtime state and, on an approved handoff, tries
the real `airlock handoff set` command so the declared failover chain
reflects what the human approved.

Usage:
    python bridge/relay.py                      # discovers AIRLOCK_SESSION_ROUTER_URL
    python bridge/relay.py --router-url http://127.0.0.1:63071 --port 4783
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

VERSION = "0.1.0"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIST = ROOT / "dist"

# Short route names Airlock's `handoff set` command accepts, keyed by exact model id.
ROUTE_NAMES = {
    "claude-opus-5[1m]": "opus",
    "claude-sonnet-5[1m]": "sonnet",
    "claude-fable-5-1[1m]": "fable",
    "gpt-5.6-sol": "sol",
    "gpt-5.6-terra": "terra",
    "gpt-5.6-luna": "luna",
    "grok-4.6": "grok",
    "grok-composer-2.5-fast": "composer",
}


def short_model(model: str) -> str:
    return model[:-4] if model.endswith("[1m]") else model


def parse_ts(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def build_state(
    diagnostics: dict[str, Any],
    models: list[str],
    *,
    router_url: str,
    task: str,
    workdir: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Pure transform from router facts to the page's BridgeState shape."""
    now = now or datetime.now(timezone.utc)
    events = list(diagnostics.get("events") or [])
    root_model = str(diagnostics.get("root_model") or "")
    requests = [e for e in events if "kind" not in e]
    root_requests = [e for e in requests if short_model(str(e.get("model", ""))) == short_model(root_model)]
    context_tokens = 0
    if root_requests:
        usage = root_requests[-1].get("usage") or {}
        context_tokens = int(usage.get("input_tokens") or 0) + int(usage.get("cache_read_input_tokens") or 0) + int(usage.get("cache_creation_input_tokens") or 0)
    started_at = str(events[0].get("timestamp")) if events else now.isoformat().replace("+00:00", "Z")
    cooldown_until = None
    for e in reversed(events):
        if e.get("kind") == "rate_limit_chain_exhausted" and e.get("retry_after"):
            ts = parse_ts(str(e.get("timestamp")))
            if ts:
                cooldown_until = (ts + timedelta(seconds=float(e["retry_after"]))).isoformat().replace("+00:00", "Z")
            break
    instance = str(diagnostics.get("instance_id") or "local")
    state: dict[str, Any] = {
        "bridge": {"version": VERSION, "router_url": router_url, "ready": True},
        "session": {
            "id": f"live_{instance[:8]}",
            "task": task,
            "workdir": workdir,
            "checkpoint": f"req_{len(requests)}",
            "context_tokens": context_tokens,
            "started_at": started_at,
        },
        "enabled_models": models,
        "diagnostics": {
            "instance_id": "local",
            "profile": diagnostics.get("profile"),
            "root_model": root_model,
            "root_provider": diagnostics.get("root_provider"),
            "rate_limit_cooldowns": list(diagnostics.get("rate_limit_cooldowns") or []),
            "rate_limit_provider_cooldowns": list(diagnostics.get("rate_limit_provider_cooldowns") or []),
            "events": events[-200:],
            "summary": list(diagnostics.get("summary") or []),
        },
    }
    if cooldown_until:
        state["cooldown_until"] = cooldown_until
    return state


class RouterClient:
    def __init__(self, router_url: str, cache_seconds: float = 1.0) -> None:
        self.router_url = router_url.rstrip("/")
        self.cache_seconds = cache_seconds
        self._lock = threading.Lock()
        self._cached: tuple[float, dict[str, Any], list[str]] | None = None

    def _get(self, path: str) -> Any:
        with urllib.request.urlopen(self.router_url + path, timeout=3) as response:  # noqa: S310 loopback only
            return json.load(response)

    def snapshot(self) -> tuple[dict[str, Any], list[str]]:
        with self._lock:
            if self._cached and time.monotonic() - self._cached[0] < self.cache_seconds:
                return self._cached[1], self._cached[2]
            diagnostics = self._get("/diagnostics")
            models_payload = self._get("/v1/models")
            models = [str(m.get("id")) for m in models_payload.get("data", []) if m.get("id")]
            self._cached = (time.monotonic(), diagnostics, models)
            return diagnostics, models


class Approvals:
    """Approvals the human made in the page, recorded here so the bridge can
    refuse a handoff that no recorded approval covers. Nonces are one-shot."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._records: dict[str, dict[str, Any]] = {}

    def record(self, handoff_id: str, revision: int, from_model: str, target: str) -> str:
        nonce = os.urandom(12).hex()
        with self._lock:
            self._records[handoff_id] = {"nonce": nonce, "revision": revision, "from": from_model, "target": target}
        return nonce

    def consume(self, handoff_id: str, revision: int, from_model: str, target: str, nonce: str) -> str | None:
        """Return None when the approval matches, else the reason it does not."""
        with self._lock:
            record = self._records.get(handoff_id)
            if not record:
                return "no_recorded_approval"
            if not nonce or record["nonce"] != nonce:
                return "nonce_mismatch"
            if record["revision"] != revision or record["target"] != target or record["from"] != from_model:
                return "approval_is_for_a_different_revision_or_target"
            del self._records[handoff_id]
            return None


def apply_handoff(from_model: str, to_model: str) -> dict[str, Any]:
    """Best effort: persist the approved order with Airlock's own command."""
    src = ROUTE_NAMES.get(from_model) or ROUTE_NAMES.get(short_model(from_model))
    dst = ROUTE_NAMES.get(to_model) or ROUTE_NAMES.get(short_model(to_model))
    if not src or not dst:
        return {"applied": False, "reason": "unknown_route_name", "command": None}
    command = ["airlock", "handoff", "set", src, dst]
    if not shutil.which("airlock"):
        return {"applied": False, "reason": "airlock_not_on_path", "command": " ".join(command)}
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"applied": False, "reason": str(error), "command": " ".join(command)}
    output = (completed.stdout + completed.stderr).strip().splitlines()
    return {"applied": completed.returncode == 0, "exit_code": completed.returncode, "command": " ".join(command), "output": output[-6:]}


def make_handler(client: RouterClient, dist: Path, task: str, workdir: str, approvals: Approvals | None = None):
    approvals = approvals or Approvals()
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, directory=str(dist), **kwargs)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            sys.stderr.write("relay: " + (format % args) + "\n")

        def _json(self, status: int, payload: Any) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            if self.path.split("?", 1)[0] == "/relay/api/state":
                try:
                    diagnostics, models = client.snapshot()
                except (urllib.error.URLError, OSError, ValueError) as error:
                    self._json(503, {"bridge": {"version": VERSION, "router_url": client.router_url, "ready": False, "error": str(error)}})
                    return
                self._json(200, build_state(diagnostics, models, router_url=client.router_url, task=task, workdir=workdir))
                return
            super().do_GET()

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path not in ("/relay/api/approve", "/relay/api/handoff"):
                self._json(404, {"error": "not_found"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(min(length, 65536)) or b"{}")
            except ValueError:
                self._json(400, {"error": "bad_json"})
                return
            handoff_id = str(payload.get("handoff_id", ""))
            revision = int(payload.get("revision") or 0)
            from_model = str(payload.get("from", ""))
            target = str(payload.get("target", ""))
            if path == "/relay/api/approve":
                if not handoff_id or not target:
                    self._json(400, {"error": "handoff_id_and_target_required"})
                    return
                nonce = approvals.record(handoff_id, revision, from_model, target)
                self._json(200, {"recorded": True, "handoff_id": handoff_id, "revision": revision, "nonce": nonce})
                return
            problem = approvals.consume(handoff_id, revision, from_model, target, str(payload.get("nonce", "")))
            if problem:
                self._json(403, {"applied": False, "reason": problem, "command": None})
                return
            self._json(200, apply_handoff(from_model, target))

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve Airlock Relay against a live Airlock router.")
    parser.add_argument("--router-url", default=os.environ.get("AIRLOCK_SESSION_ROUTER_URL"), help="Airlock router URL (defaults to AIRLOCK_SESSION_ROUTER_URL).")
    parser.add_argument("--port", type=int, default=4783)
    parser.add_argument("--dist", default=str(DEFAULT_DIST), help="Built site directory (npm run build).")
    parser.add_argument("--task", default="Live Airlock session", help="Task label shown in the session card.")
    parser.add_argument("--workdir", default=os.getcwd())
    args = parser.parse_args(argv)
    if not args.router_url:
        print("relay: no router URL. Run inside an Airlock session or pass --router-url.", file=sys.stderr)
        return 2
    dist = Path(args.dist)
    if not (dist / "index.html").exists():
        print(f"relay: {dist} has no index.html. Run `npm run build` first.", file=sys.stderr)
        return 2
    client = RouterClient(args.router_url)
    try:
        client.snapshot()
    except (urllib.error.URLError, OSError, ValueError) as error:
        print(f"relay: cannot reach the router at {args.router_url}: {error}", file=sys.stderr)
        return 1
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(client, dist, args.task, args.workdir))
    print(f"relay: live control room at http://127.0.0.1:{args.port}/  (router {args.router_url})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
