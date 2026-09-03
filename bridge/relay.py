#!/usr/bin/env python3
"""Airlock Relay local bridge.

Serves the built Relay page on 127.0.0.1 and feeds it live facts about a
running agent session. Three sources:

* ``--source airlock`` (default when AIRLOCK_SESSION_ROUTER_URL is set):
  polls the Airlock router's existing loopback GET /diagnostics and
  GET /v1/models. The router is not modified.
* ``--source claude-code``: plain Claude Code, no Airlock. Claude Code hooks
  POST their events to this bridge through bridge/claude_code_hook.py;
  StopFailure is the block signal, and resume is ``claude --resume ID --model X``.
* ``--source generic``: any agent runtime POSTs small JSON events and state to
  /relay/api/ingest. See docs/ingest-contract.md.

In every mode the bridge notifies you when the session blocks (desktop
notification, plus an optional webhook URL), records your Approve click and
hands back a one-shot nonce, refuses the real switch command without it, and
offers a human-only Resume button that opens a terminal continuing the same
conversation on the approved model.
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

VERSION = "0.4.0"
ROOT = Path(__file__).resolve().parent.parent
# A fresh `npm run build` lands in dist/; bridge/site is the committed copy so
# the bridge runs with Python alone. Prefer the fresh build when it exists.
DEFAULT_DIST = ROOT / "dist" if (ROOT / "dist" / "index.html").exists() else Path(__file__).resolve().parent / "site"

# Short route names Airlock's commands accept, keyed by exact model id.
AIRLOCK_ROUTE_NAMES = {
    "claude-opus-5[1m]": "opus",
    "claude-sonnet-5[1m]": "sonnet",
    "claude-fable-5-1[1m]": "fable",
    "gpt-5.6-sol": "sol",
    "gpt-5.6-terra": "terra",
    "gpt-5.6-luna": "luna",
    "grok-4.6": "grok",
    "grok-composer-2.5-fast": "composer",
}

# Model aliases plain Claude Code accepts with --model.
CLAUDE_CODE_MODELS = {
    "claude-opus-5[1m]": "opus",
    "claude-sonnet-5[1m]": "sonnet",
    "claude-haiku-4-5": "haiku",
}

# StopFailure matchers that mean the whole provider is unusable for now, versus
# the one model the request hit.
PROVIDER_WIDE_FAILURES = {"rate_limit", "billing_error", "account_on_hold", "authentication_failed", "oauth_org_not_allowed"}
MODEL_FAILURES = {"overloaded", "server_error", "model_not_found", "max_output_tokens"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def short_model(model: str) -> str:
    return model[:-4] if model.endswith("[1m]") else model


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


def route_name(model: str, table: dict[str, str]) -> str | None:
    return table.get(model) or table.get(short_model(model)) or table.get(f"{model}[1m]")


def resume_command(source: str, target_model: str, session_id: str | None) -> str | None:
    if source == "airlock":
        name = route_name(target_model, AIRLOCK_ROUTE_NAMES)
        if not name:
            return None
        return f"airlock hybrid {name} --resume {session_id}" if session_id else f"airlock hybrid {name} --continue"
    if source == "claude-code":
        alias = route_name(target_model, CLAUDE_CODE_MODELS) or short_model(target_model)
        return f"claude --resume {session_id} --model {alias}" if session_id else f"claude --continue --model {alias}"
    return None


# ---- Airlock source --------------------------------------------------------

def is_blocked(diagnostics: dict[str, Any]) -> bool:
    root_model = short_model(str(diagnostics.get("root_model") or ""))
    root_provider = str(diagnostics.get("root_provider") or "")
    if root_model and root_model in [short_model(m) for m in diagnostics.get("rate_limit_cooldowns") or []]:
        return True
    return root_provider in (diagnostics.get("rate_limit_provider_cooldowns") or [])


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


# ---- Ingested sources (claude-code, generic) --------------------------------

class IngestedRuntime:
    """State composed from events other runtimes POST to /relay/api/ingest.

    Produces the same diagnostics-shaped report the Airlock source does, so
    the page has exactly one adapter."""

    def __init__(self, source: str, root_model: str, provider: str, models: list[str]) -> None:
        self.source = source
        self.root_model = root_model
        self.root_provider = provider
        self.models = models
        self._lock = threading.Lock()
        self.events: list[dict[str, Any]] = []
        self.model_cooldowns: dict[str, str] = {}
        self.provider_cooldowns: dict[str, str] = {}
        self.session_id: str | None = None
        self.cwd: str | None = None
        self.last_error: str | None = None

    def ingest(self, payload: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if "state" in payload and isinstance(payload["state"], dict):
                state = payload["state"]
                if state.get("model"):
                    self.root_model = str(state["model"])
                if state.get("provider"):
                    self.root_provider = str(state["provider"])
                if state.get("session_id"):
                    self.session_id = str(state["session_id"])
                if state.get("cwd"):
                    self.cwd = str(state["cwd"])
                if isinstance(state.get("models"), list):
                    self.models = [str(m) for m in state["models"]]
                if state.get("clear_cooldowns"):
                    self.model_cooldowns.clear()
                    self.provider_cooldowns.clear()
            event = payload.get("event")
            if isinstance(event, dict):
                self._apply_event(event)
            return {"accepted": True, "events": len(self.events)}

    def _apply_event(self, raw: dict[str, Any]) -> None:
        kind = str(raw.get("kind") or raw.get("hook_event_name") or "event")
        event: dict[str, Any] = {
            "kind": kind,
            "timestamp": str(raw.get("timestamp") or now_iso()),
            "source": self.source,
        }
        if raw.get("summary"):
            event["summary"] = str(raw["summary"])[:200]
        if raw.get("session_id"):
            self.session_id = str(raw["session_id"])
        if raw.get("cwd"):
            self.cwd = str(raw["cwd"])
        if raw.get("model"):
            event["model"] = str(raw["model"])
            if kind in ("SessionStart", "PostModelSwitch", "session_started"):
                self.root_model = str(raw["model"])
        if kind == "StopFailure" or kind == "failure":
            failure = str(raw.get("failure") or raw.get("matcher") or raw.get("error_type") or "unknown")
            event["failure"] = failure
            event["provider"] = self.root_provider
            event["model"] = self.root_model
            until = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(timespec="seconds").replace("+00:00", "Z")
            if failure in PROVIDER_WIDE_FAILURES:
                self.provider_cooldowns[self.root_provider] = until
            elif failure in MODEL_FAILURES:
                self.model_cooldowns[self.root_model] = until
            self.last_error = failure
            event.setdefault("summary", f"{short_model(self.root_model)} turn failed: {failure.replace('_', ' ')}")
        elif kind in ("Stop", "turn_completed"):
            event.setdefault("summary", f"{short_model(self.root_model)} finished a turn")
        elif kind == "SessionStart":
            self.model_cooldowns.clear()
            self.provider_cooldowns.clear()
            event.setdefault("summary", f"Session started on {short_model(self.root_model)}" + (f" ({raw.get('source')})" if raw.get("source") else ""))
        elif kind == "PostToolUse":
            event.setdefault("summary", f"Tool {raw.get('tool_name', '?')} completed")
        elif kind == "SessionEnd":
            event.setdefault("summary", f"Session ended ({raw.get('reason', 'unknown')})")
        elif kind in ("PreCompact", "PostCompact"):
            event.setdefault("summary", "Conversation compacted" if kind == "PostCompact" else "Compaction starting")
        for key in ("tool_name", "reason", "detail"):
            if raw.get(key) is not None:
                event[key] = str(raw[key])[:200]
        self.events.append(event)
        del self.events[:-500]

    def diagnostics(self) -> tuple[dict[str, Any], list[str]]:
        with self._lock:
            now = datetime.now(timezone.utc)
            self.model_cooldowns = {m: u for m, u in self.model_cooldowns.items() if (parse_ts(u) or now) > now}
            self.provider_cooldowns = {p: u for p, u in self.provider_cooldowns.items() if (parse_ts(u) or now) > now}
            report = {
                "instance_id": "local",
                "profile": self.source,
                "root_model": self.root_model,
                "root_provider": self.root_provider,
                "rate_limit_cooldowns": list(self.model_cooldowns),
                "rate_limit_provider_cooldowns": list(self.provider_cooldowns),
                "cooldown_until": max(list(self.model_cooldowns.values()) + list(self.provider_cooldowns.values()), default=None),
                "events": list(self.events),
                "summary": [],
            }
            return report, list(self.models)


# ---- State for the page ----------------------------------------------------

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
    source: str = "airlock",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Pure transform from runtime facts to the page's BridgeState shape."""
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
    cooldown_until = diagnostics.get("cooldown_until")
    if not cooldown_until:
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
            "source": source,
            "router_url": router_url,
            "ready": True,
            "session_id": session_id,
            "resume_command": resume,
            "resume_status": resume_status,
        },
        "session": {
            "id": f"live_{instance[:8]}" if instance != "local" else f"live_{source}",
            "task": task,
            "workdir": workdir,
            "checkpoint": f"req_{len(requests)}" if requests else f"ev_{len(events)}",
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


# ---- Approvals -------------------------------------------------------------

class Approvals:
    """Approvals the human made in the page, recorded here so the bridge can
    refuse a switch that no recorded approval covers. Nonces are one-shot."""

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

def command_argv(command: str, args: list[str]) -> list[str]:
    """Argv to run a CLI that may be a Bash script (Airlock on Windows runs under Git Bash)."""
    if platform.system() == "Windows" and command == "airlock":
        bash = shutil.which("bash") or "bash"
        return [bash, "-lc", " ".join([command, *(shlex.quote(a) for a in args)])]
    return [command, *args]


def command_available(command: str) -> bool:
    if shutil.which(command):
        return True
    if platform.system() == "Windows" and command == "airlock":
        bash = shutil.which("bash")
        if not bash:
            return False
        try:
            return subprocess.run([bash, "-lc", "command -v airlock"], capture_output=True, text=True, timeout=15, check=False).returncode == 0
        except (OSError, subprocess.TimeoutExpired):
            return False
    return False


def parse_handoff_tree(text: str) -> dict[str, list[str]]:
    """Parse `airlock handoff` output into {route: [peers...]}."""
    chains: dict[str, list[str]] = {}
    for line in text.splitlines():
        if "->" not in line:
            continue
        body = line.split("[", 1)[0]
        parts = [p.strip() for p in body.split("->")]
        if len(parts) < 2 or not parts[0]:
            continue
        chains[parts[0]] = [p for p in parts[1:] if p]
    return chains


def current_chain(route: str) -> list[str]:
    """Best effort read of the declared chain for a route; empty when unknown."""
    if not command_available("airlock"):
        return []
    try:
        completed = subprocess.run(command_argv("airlock", ["handoff"]), capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return parse_handoff_tree(completed.stdout + completed.stderr).get(route, [])


def planned_chain(current: list[str], target: str) -> list[str]:
    """The approved target goes first; the rest of the declared chain is kept."""
    return [target] + [p for p in current if p != target]


def apply_handoff(source: str, from_model: str, to_model: str) -> dict[str, Any]:
    """Persist the approved order. Airlock has a command for it; other sources only record."""
    if source != "airlock":
        return {"applied": True, "command": None, "note": f"{source} has no persistent chain; the resume command carries the model."}
    src = route_name(from_model, AIRLOCK_ROUTE_NAMES)
    dst = route_name(to_model, AIRLOCK_ROUTE_NAMES)
    if not src or not dst:
        return {"applied": False, "reason": "unknown_route_name", "command": None}
    before = current_chain(src)
    command = ["airlock", "handoff", "set", src, *planned_chain(before, dst)]
    if not command_available("airlock"):
        return {"applied": False, "reason": "airlock_not_on_path", "command": " ".join(command), "chain_before": before, "chain_after": planned_chain(before, dst)}
    try:
        completed = subprocess.run(command_argv("airlock", command[1:]), capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"applied": False, "reason": str(error), "command": " ".join(command)}
    output = (completed.stdout + completed.stderr).strip().splitlines()
    return {"applied": completed.returncode == 0, "exit_code": completed.returncode, "command": " ".join(command), "output": output[-6:], "chain_before": before, "chain_after": planned_chain(before, dst)}


def terminal_launch_argv(command: str, workdir: str) -> list[str]:
    """Argv that opens a new terminal window in workdir running command."""
    system = platform.system()
    if system == "Windows":
        bash = shutil.which("bash") or "bash"
        script = f"cd {shlex.quote(workdir)} && {command}; echo; echo '[relay] session ended, press Enter to close'; read -r _"
        mintty = Path(bash).resolve().parent / "mintty.exe" if bash else None
        if mintty and mintty.exists():
            # Git Bash's own terminal: a real window we can place and title.
            return [str(mintty), "-t", "Relay resume", "-p", "60,60", "-s", "150,40", "-o", "Transparency=off", "--", "/usr/bin/bash", "-lc", script]
        return ["cmd", "/c", "start", "Relay resume", bash, "-lc", script]
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
    executable = command.split(" ", 1)[0]
    if not command_available(executable):
        return {"launched": False, "reason": f"{executable}_not_on_path", "command": command}
    try:
        subprocess.Popen(argv, cwd=workdir, close_fds=True)  # noqa: S603 command built from validated route names
    except OSError as error:
        return {"launched": False, "reason": str(error), "command": command}
    return {"launched": True, "command": command}


# ---- Notifications ---------------------------------------------------------

def webhook_payload(url: str, title: str, body: str, link: str) -> tuple[bytes, dict[str, str]]:
    """Pick the body shape the destination expects. Unknown hosts get JSON."""
    if "hooks.slack.com" in url:
        return json.dumps({"text": f"*{title}*\n{body}\n{link}"}).encode(), {"Content-Type": "application/json"}
    if "discord.com/api/webhooks" in url or "discordapp.com/api/webhooks" in url:
        return json.dumps({"content": f"**{title}**\n{body}\n{link}"}).encode(), {"Content-Type": "application/json"}
    if "ntfy" in url:
        return f"{body}\n{link}".encode(), {"Title": title, "Priority": "high", "Click": link, "Content-Type": "text/plain"}
    return json.dumps({"title": title, "body": body, "link": link, "kind": "relay.session_blocked"}).encode(), {"Content-Type": "application/json"}


def notify_webhook(url: str, title: str, body: str, link: str) -> bool:
    data, headers = webhook_payload(url, title, body, link)
    try:
        request = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=5):  # noqa: S310 user-provided notification URL
            return True
    except (urllib.error.URLError, OSError):
        return False


def notify_desktop(title: str, body: str) -> bool:
    system = platform.system()
    try:
        if system == "Windows":
            script = (
                "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;"
                "$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
                "$n = $t.GetElementsByTagName('text'); $n.Item(0).AppendChild($t.CreateTextNode($env:RELAY_TITLE)) | Out-Null; $n.Item(1).AppendChild($t.CreateTextNode($env:RELAY_BODY)) | Out-Null;"
                "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Airlock Relay').Show([Windows.UI.Notifications.ToastNotification]::new($t))"
            )
            env = dict(os.environ, RELAY_TITLE=title, RELAY_BODY=body)
            subprocess.run(["powershell", "-NoProfile", "-Command", script], env=env, capture_output=True, timeout=10, check=False)
            return True
        if system == "Darwin":
            subprocess.run(["osascript", "-e", f"display notification {json.dumps(body)} with title {json.dumps(title)}"], capture_output=True, timeout=10, check=False)
            return True
        if shutil.which("notify-send"):
            subprocess.run(["notify-send", title, body], capture_output=True, timeout=10, check=False)
            return True
    except (OSError, subprocess.TimeoutExpired):
        return False
    return False


# ---- Bridge context and HTTP ----------------------------------------------

class BridgeContext:
    def __init__(
        self,
        *,
        source: str,
        task: str,
        workdir: str,
        page_url: str,
        client: RouterClient | None = None,
        ingested: IngestedRuntime | None = None,
        notify_url: str | None = None,
        desktop_notify: bool = True,
        dry_run: bool = False,
    ) -> None:
        self.source = source
        self.task = task
        self.workdir = workdir
        self.page_url = page_url
        self.client = client
        self.ingested = ingested
        self.notify_url = notify_url
        self.desktop_notify = desktop_notify
        self.dry_run = dry_run
        self.approvals = Approvals()
        self.session_id = discover_session_id(workdir)
        self.resume: str | None = None
        self.resume_status: str | None = None
        self._was_blocked = False
        self._lock = threading.Lock()

    @property
    def router_url(self) -> str:
        return self.client.router_url if self.client else f"ingest:{self.source}"

    def snapshot(self) -> tuple[dict[str, Any], list[str]]:
        if self.client:
            return self.client.snapshot()
        assert self.ingested is not None
        return self.ingested.diagnostics()

    def state(self) -> dict[str, Any]:
        diagnostics, models = self.snapshot()
        blocked = is_blocked(diagnostics)
        with self._lock:
            if blocked and not self._was_blocked:
                reason = (self.ingested.last_error if self.ingested else None) or "rate limit"
                title = "Agent session blocked"
                body = f"{self.task}: {short_model(str(diagnostics.get('root_model') or ''))} stopped ({reason.replace('_', ' ')})."
                if self.desktop_notify:
                    notify_desktop(title, f"{body} Open Relay to hand it off.")
                if self.notify_url:
                    notify_webhook(self.notify_url, title, body, self.page_url)
            self._was_blocked = blocked
            if self.ingested and self.ingested.session_id:
                self.session_id = self.ingested.session_id
            elif self.session_id is None:
                self.session_id = discover_session_id(self.workdir)
        return build_state(
            diagnostics, models, router_url=self.router_url, task=self.task, workdir=self.workdir,
            session_id=self.session_id, resume=self.resume, resume_status=self.resume_status, source=self.source,
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
                    self._json(503, {"bridge": {"version": VERSION, "router_url": context.router_url, "ready": False, "error": str(error)}})
                return
            super().do_GET()

        def do_POST(self) -> None:  # noqa: N802
            path = self.path.split("?", 1)[0]
            if path not in ("/relay/api/approve", "/relay/api/handoff", "/relay/api/resume", "/relay/api/ingest"):
                self._json(404, {"error": "not_found"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            try:
                payload = json.loads(self.rfile.read(min(length, 65536)) or b"{}")
            except ValueError:
                self._json(400, {"error": "bad_json"})
                return
            if not isinstance(payload, dict):
                self._json(400, {"error": "object_expected"})
                return
            if path == "/relay/api/ingest":
                if not context.ingested:
                    self._json(409, {"accepted": False, "reason": f"bridge source is {context.source}; start with --source claude-code or --source generic"})
                    return
                self._json(200, context.ingested.ingest(payload))
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
                result = apply_handoff(context.source, from_model, target)
                context.resume = resume_command(context.source, target, context.session_id)
                context.resume_status = None
                result["resume_command"] = context.resume
                result["resume_nonce"] = approvals.grant_resume(handoff_id, target)
                self._json(200, result)
                return
            resolved = approvals.consume_resume(handoff_id, nonce)
            if resolved in ("no_executed_handoff", "nonce_mismatch"):
                self._json(403, {"launched": False, "reason": resolved})
                return
            command = resume_command(context.source, str(resolved), context.session_id)
            if not command:
                self._json(400, {"launched": False, "reason": "no_resume_command_for_source"})
                return
            result = launch_resume(command, context.workdir, dry_run=context.dry_run)
            context.resume_status = (
                f"Opened a terminal running `{command}`" if result.get("launched") else f"Not launched: {result.get('reason') or 'dry run'}"
            )
            self._json(200, result)

    return Handler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Serve Airlock Relay against a live agent session.")
    parser.add_argument("--source", choices=["airlock", "claude-code", "generic"], default=None, help="Where session facts come from. Defaults to airlock when AIRLOCK_SESSION_ROUTER_URL is set, else claude-code.")
    parser.add_argument("--router-url", default=os.environ.get("AIRLOCK_SESSION_ROUTER_URL"), help="Airlock router URL (airlock source).")
    parser.add_argument("--model", default="claude-opus-5[1m]", help="Active model for claude-code or generic sources until an event says otherwise.")
    parser.add_argument("--provider", default="anthropic", help="Provider of --model for claude-code or generic sources.")
    parser.add_argument("--models", default=",".join(CLAUDE_CODE_MODELS), help="Comma-separated routes available to claude-code or generic sources.")
    parser.add_argument("--port", type=int, default=4783)
    parser.add_argument("--dist", default=str(DEFAULT_DIST), help="Built site directory (npm run build).")
    parser.add_argument("--task", default="Live agent session", help="Task label shown in the session card.")
    parser.add_argument("--workdir", default=os.getcwd(), help="The session's working directory; used to find the Claude Code session id and to resume there.")
    parser.add_argument("--notify", default=None, help="Webhook URL to POST when the session blocks (ntfy, Slack, Discord, or any JSON receiver).")
    parser.add_argument("--no-desktop-notify", action="store_true", help="Do not show a desktop notification when the session blocks.")
    parser.add_argument("--open", action="store_true", help="Open the page in the default browser.")
    parser.add_argument("--dry-run", action="store_true", help="Prepare but never launch the resume terminal.")
    args = parser.parse_args(argv)
    source = args.source or ("airlock" if args.router_url else "claude-code")
    dist = Path(args.dist)
    if not (dist / "index.html").exists():
        print(f"relay: {dist} has no index.html. Run `npm run build` first.", file=sys.stderr)
        return 2
    client: RouterClient | None = None
    ingested: IngestedRuntime | None = None
    if source == "airlock":
        if not args.router_url:
            print("relay: airlock source needs AIRLOCK_SESSION_ROUTER_URL or --router-url.", file=sys.stderr)
            return 2
        client = RouterClient(args.router_url)
        try:
            client.snapshot()
        except (urllib.error.URLError, OSError, ValueError) as error:
            print(f"relay: cannot reach the router at {args.router_url}: {error}", file=sys.stderr)
            return 1
    else:
        ingested = IngestedRuntime(source, args.model, args.provider, [m.strip() for m in args.models.split(",") if m.strip()])
    page_url = f"http://127.0.0.1:{args.port}/app/"
    context = BridgeContext(
        source=source, task=args.task, workdir=str(Path(args.workdir).expanduser()), page_url=page_url,
        client=client, ingested=ingested, notify_url=args.notify, desktop_notify=not args.no_desktop_notify, dry_run=args.dry_run,
    )
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(context, dist))
    print(f"relay: console at {page_url}  (source {source}, {context.router_url})")
    print(f"relay: session id {context.session_id or 'not found yet'}; workdir {context.workdir}")
    if source != "airlock":
        print(f"relay: POST events to {page_url}relay/api/ingest (see bridge/claude_code_hook.py)")
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
