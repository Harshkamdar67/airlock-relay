#!/usr/bin/env python3
"""Claude Code hook that forwards session events to a running Relay bridge.

Register it for SessionStart, PostToolUse, Stop, StopFailure, PreCompact,
PostCompact, PostModelSwitch, and SessionEnd (see bridge/hooks.example.json).
It reads the hook JSON on stdin, keeps only small fields, and POSTs them to
http://127.0.0.1:4783/relay/api/ingest. It never blocks Claude Code: any
failure is swallowed and the hook exits 0 within about a second.

Environment: RELAY_URL overrides the bridge URL.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request

RELAY_URL = os.environ.get("RELAY_URL", "http://127.0.0.1:4783")
KEEP = ("session_id", "cwd", "hook_event_name", "tool_name", "reason", "source", "model", "matcher", "error_type", "failure", "stop_hook_active")


def main() -> int:
    try:
        raw = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return 0
    if not isinstance(raw, dict):
        return 0
    event: dict[str, object] = {k: raw[k] for k in KEEP if k in raw}
    kind = str(raw.get("hook_event_name") or "event")
    event["kind"] = kind
    if kind == "StopFailure":
        # Claude Code passes the matcher value that fired; fall back to any error field it includes.
        error = raw.get("error") if isinstance(raw.get("error"), dict) else {}
        event["failure"] = raw.get("matcher") or raw.get("error_type") or (error.get("type") if isinstance(error, dict) else None) or os.environ.get("CLAUDE_HOOK_MATCHER") or "unknown"
    model = raw.get("model")
    if isinstance(model, dict):
        event["model"] = model.get("id") or model.get("display_name")
    payload = json.dumps({"source": "claude-code", "event": event}).encode("utf-8")
    try:
        request = urllib.request.Request(f"{RELAY_URL}/relay/api/ingest", data=payload, headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(request, timeout=1).read()  # noqa: S310 loopback bridge
    except Exception:  # noqa: BLE001 hooks must never fail the session
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
