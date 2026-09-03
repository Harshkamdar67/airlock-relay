import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

import relay

FIXTURE = Path(__file__).resolve().parent.parent / "fixtures" / "airlock-diagnostics-2026-09-03.json"


class BuildStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.diag = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.models = ["claude-opus-5[1m]", "gpt-5.6-sol", "claude-fable-5-1[1m]"]

    def test_state_shape_matches_page_contract(self) -> None:
        state = relay.build_state(self.diag, self.models, router_url="http://127.0.0.1:1", task="t", workdir="/w", now=datetime(2026, 9, 3, 7, tzinfo=timezone.utc))
        self.assertEqual(state["bridge"]["ready"], True)
        self.assertEqual(state["enabled_models"], self.models)
        self.assertEqual(state["diagnostics"]["root_model"], "claude-opus-5[1m]")
        self.assertEqual(state["diagnostics"]["instance_id"], "local")
        self.assertEqual(state["session"]["task"], "t")
        self.assertTrue(state["session"]["checkpoint"].startswith("req_"))

    def test_context_tokens_come_from_last_root_model_request(self) -> None:
        state = relay.build_state(self.diag, self.models, router_url="u", task="t", workdir="w")
        # Last opus request in the fixture is the 429 with no usage, so the count is 0.
        self.assertEqual(state["session"]["context_tokens"], 0)
        diag = dict(self.diag)
        diag["events"] = [e for e in self.diag["events"] if e.get("status") != 429]
        state = relay.build_state(diag, self.models, router_url="u", task="t", workdir="w")
        self.assertEqual(state["session"]["context_tokens"], 1210 + 9120 + 106310)

    def test_cooldown_until_derives_from_retry_after(self) -> None:
        state = relay.build_state(self.diag, self.models, router_url="u", task="t", workdir="w")
        self.assertEqual(state["cooldown_until"], "2026-09-03T06:45:05Z")

    def test_events_are_bounded(self) -> None:
        diag = dict(self.diag)
        diag["events"] = self.diag["events"] * 40
        state = relay.build_state(diag, self.models, router_url="u", task="t", workdir="w")
        self.assertEqual(len(state["diagnostics"]["events"]), 200)


class ApplyHandoffTests(unittest.TestCase):
    def test_unknown_routes_are_refused(self) -> None:
        result = relay.apply_handoff("claude-opus-5[1m]", "not-a-model")
        self.assertFalse(result["applied"])
        self.assertEqual(result["reason"], "unknown_route_name")

    def test_known_routes_build_the_airlock_command(self) -> None:
        original = relay.shutil.which
        relay.shutil.which = lambda _name: None
        try:
            result = relay.apply_handoff("claude-opus-5[1m]", "claude-fable-5-1[1m]")
        finally:
            relay.shutil.which = original
        self.assertFalse(result["applied"])
        self.assertEqual(result["command"], "airlock handoff set opus fable")


if __name__ == "__main__":
    unittest.main()
