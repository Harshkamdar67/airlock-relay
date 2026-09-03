#!/usr/bin/env python3
"""Airlock Relay local bridge.

Serves the built Relay page on 127.0.0.1 and feeds it live facts from a
running Airlock router: the same GET /diagnostics and GET /v1/models the
router already exposes on loopback. Nothing in the router changes and the
router stays bound to loopback.

What it does for a real session:

* discovers the router from AIRLOCK_SESSION_ROUTER_URL (or --router-url) and
  the Claude Code session id from the transcript directory for --workdir;
* reports session state, routes, and events to the page every few seconds;
* optionally pushes a notification (ntfy topic URL) the moment the session
  becomes blocked, with the Relay link;
* records the human's Approve click and hands back a one-shot nonce, then
  refuses the real Airlock command unless the page presents that nonce;
* on an executed handoff runs Airlock's own `airlock handoff set FROM TO`
  and prepares `airlock hybrid ROUTE --resume SESSION_ID`;
* on the human-only Resume button, opens a new terminal running that command
  so the same conversation continues on the approved orchestrator.

Usage:
    python bridge/relay.py                      # inside an Airlock session
    python bridge/relay.py --router-url http://127.0.0.1:63071 --workdir ~/work/app --open
    python bridge/relay.py --notify https://ntfy.sh/my-topic
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

VERSION = "0.2.0"
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DIST = ROOT / "dist"

# Short route names Airlock's commands accept, keyed by exact model id.
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

BLOCKING_KINDS = {"rate_limit_chain_exhausted", "overflow_chain_exhausted"}


def short_model(model: str) -> str:
    return model[:-4] if model.endswith("[1m]") else model


def route_name(model: str) -> str | None:
    return ROUTE_NAMES.get(model) or ROUTE_NAMES.get(short_model(model)) or ROUTE_NAMES.get(f"{model}[1m]")


def parse_ts(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


# ---- Session discovery -----------------------------------------------------

def claude_project_slug(workdir: str) -> str:
    """Claude Code names its per-project transcript directory after the cwd."""
    return re.sub(r"[^A-Za-z0-9]", "-", str(Path(workdir).expanduser().resolve()))


def discover_session_id(workdir: str, claude_home: Path | None = None) -> str | None:
    """Most recently modified transcript in the project directory is the live session."""
    home = claude_home or Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")
    project_dir = home / "projects" / claude_project_slug(workdir)
    if not project_dir.is_dir():
        return None
    candidates = [p for p in project_dir.glob("*.jsonl") if re.fullmatch(r"[0-9a-fA-F-]{36}", p.stem)]
    if not candidates:
        return None
    newest = max(candidates, key=lambda p: p.stat().st_mtime)
    return newest.stem


def resume_command(target_model: str, session_id: str | None) -> str | None:
    name = route_name(target_model)
    if not name:
        return None
    if session_id:
        return f"airlock hybrid {name} --resume {session_id}"
    return f"airlock hybrid {name} --continue"


# ---- State -----------------------------------------------------------------

def is_blocked(diagnostics: dict[str, Any]) -> bool:
    root_model = short_model(str(diagnostics.get("root_model") or ""))
    root_provider = str(diagnostics.get("root_provider") or "")
    if root_model and root_model in [short_model(m) for m in diagnostics.get("rate_limit_cooldowns") or []]:
        return True
    return root_provider in (diagnostics.get("rate_limit_provider_cooldowns") or [])


def build_state(
    diagnostics: dict[str, Any],
    models: list[str],
    *,
    router_url: str,
    task: str,
    workdir: str,
    session_id: str | None = None,
    resume: str | None = None,
    resume_status: str | None = None,
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
        "bridge": {
            "version": VERSION,
            "router_url": router_url,
            "ready": True,
            "session_id": session_id,
            "resume_command": resume,
            "resume_status": resume_status,
        },
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


# ---- Approvals -------------------------------------------------------------

class Approvals:
    """Approvals the human made in the page, recorded here so the bridge can
    refuse a handoff that no recorded approval covers. Nonces are one-shot."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._records: dict[str, dict[str, Any]] = {}
        self._resume: dict[str, dict[str, Any]] = {}

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

    def grant_resume(self, handoff_id: str, target: str) -> str:
        nonce = os.urandom(12).hex()
        with self._lock:
            self._resume[handoff_id] = {"nonce": nonce, "target": target}
        return nonce

    def consume_resume(self, handoff_id: str, nonce: str) -> str | None:
        with self._lock:
            record = self._resume.get(handoff_id)
            if not record:
                return "no_executed_handoff"
            if not nonce or record["nonce"] != nonce:
                return "nonce_mismatch"
            del self._resume[handoff_id]
            return record["target"]


# ---- Actions ---------------------------------------------------------------

def apply_handoff(from_model: str, to_model: str) -> dict[str, Any]:
    """Persist the approved order with Airlock's own command."""
    src = route_name(from_model)
    dst = route_name(to_model)
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


def terminal_launch_argv(command: str, workdir: str) -> list[str]:
    """Argv that opens a new terminal window in workdir running command."""
    system = platform.system()
    if system == "Windows":
        bash = shutil.which("bash") or "bash"
        script = f"cd {shlex.quote(workdir)} && {command}; echo; echo '[airlock relay] session ended, press Enter to close'; read -r _"
        return ["cmd", "/c", "start", "Airlock Relay resume", bash, "-lc", script]
    if system == "Darwin":
        script = f"cd {shlex.quote(workdir)} && {command}"
        return ["osascript", "-e", f'tell application "Terminal" to do script {json.dumps(script)}', "-e", 'tell application "Terminal" to activate']
    for candidate in ("x-terminal-emulator", "gnome-terminal", "konsole", "xterm"):
        if shutil.which(candidate):
            script = f"cd {shlex.quote(workdir)} && {command}; exec bash"
            if candidate == "gnome-terminal":
                return [candidate, "--", "bash", "-lc", script]
            return [candidate, "-e", f"bash -lc {shlex.quote(script)}"]
    return ["bash", "-lc", f"cd {shlex.quote(workdir)} && {command}"]


def launch_resume(command: str, workdir: str, dry_run: bool = False) -> dict[str, Any]:
    argv = terminal_launch_argv(command, workdir)
    if dry_run:
        return {"launched": False, "dry_run": True, "command": command, "argv": argv}
    if not shutil.which("airlock"):
        return {"launched": False, "reason": "airlock_not_on_path", "command": command}
    try:
        subprocess.Popen(argv, cwd=workdir, close_fds=True)  # noqa: S603 command built from validated route names
    except OSError as error:
        return {"launched": False, "reason": str(error), "command": command}
    return {"launched": True, "command": command}


def notify(topic_url: str, title: str, body: str) -> bool:
    try:
        request = urllib.request.Request(topic_url, data=body.encode("utf-8"), headers={"Title": title, "Priority": "high"}, method="POST")
        with urllib.request.urlopen(request, timeout=5):  # noqa: S310 user-provided notification URL
            return True
    except (urllib.error.URLError, OSError):
        return False


# ---- HTTP ------------------------------------------------------------------

class BridgeContext:
    def __init__(self, client: RouterClient, task: str, workdir: str, *, notify_url: str | None, page_url: str, dry_run: bool) -> None:
        self.client = client
        self.task = task
        self.workdir = workdir
        self.notify_url = notify_url
        self.page_url = page_url
        self.dry_run = dry_run
        self.approvals = Approvals()
        self.session_id = discover_session_id(workdir)
        self.resume: str | None = None
        self.resume_status: str | None = None
        self._was_blocked = False
        self._lock = threading.Lock()

    def state(self) -> dict[str, Any]:
        diagnostics, models = self.client.snapshot()
        blocked = is_blocked(diagnostics)
        with self._lock:
            if blocked and not self._was_blocked and self.notify_url:
                notify(self.notify_url, "Airlock session blocked", f"{self.task}\nOpen Relay: {self.page_url}")
            self._was_blocked = blocked
            if self.session_id is None:
                self.session_id = discover_session_id(self.workdir)
        return build_state(
            diagnostics, models, router_url=self.client.router_url, task=self.task, workdir=self.workdir,
            session_id=self.session_id, resume=self.resume, resume_status=self.resume_status,
        )


def make_handler(context: BridgeContext, dist: Path):
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
                    self._json(200, context.state())
                except (urllib.error.URLError, OSError, ValueError) as error:
                    self._json(503, {"bridge": {"version": VERSION, "router_url": context.client.router_url, "ready": False, "error": str(error)}})
                return
            super().do_GET()

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path not in ("/relay/api/approve", "/relay/api/handoff", "/relay/api/resume"):
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
            nonce = str(payload.get("nonce", ""))
            approvals = context.approvals
            if path == "/relay/api/approve":
                if not handoff_id or not target:
                    self._json(400, {"error": "handoff_id_and_target_required"})
                    return
                issued = approvals.record(handoff_id, revision, from_model, target)
                self._json(200, {"recorded": True, "handoff_id": handoff_id, "revision": revision, "nonce": issued})
                return
            if path == "/relay/api/handoff":
                problem = approvals.consume(handoff_id, revision, from_model, target, nonce)
                if problem:
                    self._json(403, {"applied": False, "reason": problem, "command": None})
                    return
                result = apply_handoff(from_model, target)
                context.resume = resume_command(target, context.session_id)
                context.resume_status = None
                result["resume_command"] = context.resume
                result["resume_nonce"] = approvals.grant_resume(handoff_id, target)
                self._json(200, result)
                return
            resolved = approvals.consume_resume(handoff_id, nonce)
            if resolved in ("no_executed_handoff", "nonce_mismatch"):
                self._json(403, {"launched": False, "reason": resolved})
                return
            command = resume_command(str(resolved), context.session_id)
            if not command:
                self._json(400, {"launched": False, "reason": "unknown_route_name"})
                return
            result = launch_resume(command, context.workdir, dry_run=context.dry_run)
            context.resume_status = (
                f"Opened a terminal running `{command}`" if result.get("launched") else f"Not launched: {result.get('reason') or 'dry run'}"
            )
            self._json(200, result)

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve Airlock Relay against a live Airlock router.")
    parser.add_argument("--router-url", default=os.environ.get("AIRLOCK_SESSION_ROUTER_URL"), help="Airlock router URL (defaults to AIRLOCK_SESSION_ROUTER_URL).")
    parser.add_argument("--port", type=int, default=4783)
    parser.add_argument("--dist", default=str(DEFAULT_DIST), help="Built site directory (npm run build).")
    parser.add_argument("--task", default="Live Airlock session", help="Task label shown in the session card.")
    parser.add_argument("--workdir", default=os.getcwd(), help="The session's working directory; used to find the Claude Code session id and to resume there.")
    parser.add_argument("--notify", default=None, help="ntfy-style topic URL to POST to when the session becomes blocked.")
    parser.add_argument("--open", action="store_true", help="Open the page in the default browser.")
    parser.add_argument("--dry-run", action="store_true", help="Prepare but never launch the resume terminal.")
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
    page_url = f"http://127.0.0.1:{args.port}/"
    context = BridgeContext(client, args.task, str(Path(args.workdir).expanduser()), notify_url=args.notify, page_url=page_url, dry_run=args.dry_run)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(context, dist))
    print(f"relay: live control room at {page_url}  (router {args.router_url})")
    print(f"relay: session id {context.session_id or 'not found yet'}; workdir {context.workdir}")
    if args.notify:
        print(f"relay: will notify {args.notify} when the session blocks")
    if args.open:
        webbrowser.open(page_url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
