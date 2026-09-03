"""Print the Claude Code session id (and transcript path) for a working directory.
Usage: python scripts/session_id.py WORKDIR [--transcript]"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "bridge"))
import relay  # noqa: E402

workdir = sys.argv[1]
sid = relay.discover_session_id(workdir)
if "--transcript" in sys.argv:
    if sid:
        print(Path.home() / ".claude" / "projects" / relay.claude_project_slug(workdir) / f"{sid}.jsonl")
else:
    print(sid or "")
