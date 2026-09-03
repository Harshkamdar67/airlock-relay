"""Generate narration segments for the demo video with edge-tts.

Writes video/seg_XX.mp3 and video/timeline.json (segment ids, text, durations).
Usage: python scripts/narration.py [voice]
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import edge_tts

VOICE = sys.argv[1] if len(sys.argv) > 1 else "en-US-AndrewMultilingualNeural"
OUT = Path(__file__).resolve().parent.parent / "video"

SEGMENTS: list[tuple[str, str]] = [
    ("intro", "It's 2 AM. My coding agent has been refactoring an auth layer for three hours, and the Anthropic plan just rate limited. The session is blocked. Normally I'd be reading router logs to work out what's free and how to resume."),
    ("tools", "This is Airlock Relay. The page exposes the runtime through seven WebMCP tools, so a browser agent can do that reading with me, instead of guessing from the screen."),
    ("prompt", "I ask the agent to inspect what happened and get the session running again on a route that's ready and doesn't spend metered usage, without changing anything until I approve."),
    ("propose", "It reads the session, the event log, and every route. It proposes GPT 5.6 Sol: ready, frontier tier, not metered. Nothing has switched. It's a proposal."),
    ("refuse", "When it tries to execute early, the page refuses. There is no approve tool. Approval is a button, and only I have it."),
    ("edit", "I'd rather stay on Claude. I change the target to Fable, which is metered, and approve. That issues a token bound to this exact revision. If I edit again, it's revoked."),
    ("execute", "The agent re-reads the proposal, sees my change and that I accepted metered usage, and executes. The session resumes from its checkpoint."),
    ("replay", "The replay shows who did what: the runtime, the agent, and me, on one shared object."),
    ("overflow_intro", "Rate limits aren't the only way a session dies. Second scenario: a GPT 5.6 Sol conversation that outgrew its 400 thousand token window."),
    ("overflow_refuse", "The agent proposes Terra. The page refuses: 412 thousand tokens don't fit a 400 thousand window, and it lists the routes that do. The tools understand the domain, not just the buttons."),
    ("overflow_resume", "It proposes Grok 4.6 instead, with two million tokens of room. I approve, and the session resumes."),
    ("live", "The demo is seeded from a real Airlock router report. The same page runs live against a real session through a small loopback bridge."),
    ("outro", "WebMCP turns a runtime a person had to babysit into a workspace a person and an agent can operate together. Airlock Relay."),
]


def duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


async def main() -> None:
    OUT.mkdir(exist_ok=True)
    timeline = []
    for index, (key, text) in enumerate(SEGMENTS):
        path = OUT / f"seg_{index:02d}_{key}.mp3"
        await edge_tts.Communicate(text, VOICE, rate="+4%").save(str(path))
        timeline.append({"index": index, "key": key, "text": text, "file": path.name, "seconds": round(duration(path), 3)})
        print(f"{key:8s} {timeline[-1]['seconds']:6.2f}s")
    (OUT / "timeline.json").write_text(json.dumps(timeline, indent=1), encoding="utf-8")
    print("total", round(sum(t["seconds"] for t in timeline), 1), "s")


asyncio.run(main())
