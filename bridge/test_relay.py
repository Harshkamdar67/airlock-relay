import json
import os
import tempfile
import time
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
        state = relay.build_state(self.diag, self.models, router_url="http://127.0.0.1:1", task="t", workdir="/w", session_id="abc", resume="airlock hybrid sol --resume abc", now=datetime(2026, 9, 3, 7, tzinfo=timezone.utc))
        self.assertEqual(state["bridge"]["ready"], True)
        self.assertEqual(state["bridge"]["session_id"], "abc")
        self.assertEqual(state["bridge"]["resume_command"], "airlock hybrid sol --resume abc")
        self.assertEqual(state["enabled_models"], self.models)
        self.assertEqual(state["diagnostics"]["root_model"], "claude-opus-5[1m]")
        self.assertEqual(state["diagnostics"]["instance_id"], "local")
        self.assertEqual(state["session"]["task"], "t")
        self.assertTrue(state["session"]["checkpoint"].startswith("req_"))

    def test_context_tokens_come_from_last_root_model_request(self) -> None:
        state = relay.build_state(self.diag, self.models, router_url="u", task="t", workdir="w")
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

    def test_blocked_detection_uses_root_cooldowns(self) -> None:
        self.assertTrue(relay.is_blocked(self.diag))
        self.assertFalse(relay.is_blocked({"root_model": "gpt-5.6-sol", "root_provider": "openai", "rate_limit_cooldowns": [], "rate_limit_provider_cooldowns": ["anthropic"]}))


class SessionDiscoveryTests(unittest.TestCase):
    def test_project_slug_matches_claude_code_layout(self) -> None:
        slug = relay.claude_project_slug(r"C:\Users\Harsh kamdar\Desktop\Opensource\claudex" if os.name == "nt" else "/home/h/work/claudex")
        self.assertNotIn(" ", slug)
        self.assertNotIn("/", slug)
        self.assertNotIn("\\", slug)
        self.assertTrue(slug.endswith("-claudex"))

    def test_newest_transcript_wins_and_non_uuid_files_are_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            workdir = home / "work" / "app"
            workdir.mkdir(parents=True)
            project = home / "projects" / relay.claude_project_slug(str(workdir))
            project.mkdir(parents=True)
            old = project / "11111111-1111-1111-1111-111111111111.jsonl"
            new = project / "22222222-2222-2222-2222-222222222222.jsonl"
            junk = project / "agent-notes.jsonl"
            for p in (old, junk, new):
                p.write_text("{}", encoding="utf-8")
            os.utime(old, (time.time() - 100, time.time() - 100))
            os.utime(junk, (time.time() + 100, time.time() + 100))
            self.assertEqual(relay.discover_session_id(str(workdir), claude_home=home), "22222222-2222-2222-2222-222222222222")
            self.assertIsNone(relay.discover_session_id(str(home / "nowhere"), claude_home=home))

    def test_resume_command_uses_airlock_route_names(self) -> None:
        self.assertEqual(relay.resume_command("claude-fable-5-1[1m]", "abc"), "airlock hybrid fable --resume abc")
        self.assertEqual(relay.resume_command("gpt-5.6-sol", None), "airlock hybrid sol --continue")
        self.assertIsNone(relay.resume_command("not-a-model", "abc"))


class ApprovalsTests(unittest.TestCase):
    def test_handoff_without_recorded_approval_is_refused(self) -> None:
        approvals = relay.Approvals()
        self.assertEqual(approvals.consume("H-1", 1, "a", "b", "x"), "no_recorded_approval")

    def test_nonce_revision_and_target_must_match_and_nonce_is_one_shot(self) -> None:
        approvals = relay.Approvals()
        nonce = approvals.record("H-1", 2, "claude-opus-5[1m]", "claude-fable-5-1[1m]")
        self.assertEqual(approvals.consume("H-1", 2, "claude-opus-5[1m]", "claude-fable-5-1[1m]", "wrong"), "nonce_mismatch")
        self.assertEqual(approvals.consume("H-1", 3, "claude-opus-5[1m]", "claude-fable-5-1[1m]", nonce), "approval_is_for_a_different_revision_or_target")
        self.assertEqual(approvals.consume("H-1", 2, "claude-opus-5[1m]", "gpt-5.6-sol", nonce), "approval_is_for_a_different_revision_or_target")
        self.assertIsNone(approvals.consume("H-1", 2, "claude-opus-5[1m]", "claude-fable-5-1[1m]", nonce))
        self.assertEqual(approvals.consume("H-1", 2, "claude-opus-5[1m]", "claude-fable-5-1[1m]", nonce), "no_recorded_approval")

    def test_new_approval_replaces_the_old_record(self) -> None:
        approvals = relay.Approvals()
        first = approvals.record("H-1", 1, "a", "b")
        approvals.record("H-1", 2, "a", "c")
        self.assertEqual(approvals.consume("H-1", 1, "a", "b", first), "nonce_mismatch")

    def test_resume_requires_an_executed_handoff_and_is_one_shot(self) -> None:
        approvals = relay.Approvals()
        self.assertEqual(approvals.consume_resume("H-1", "x"), "no_executed_handoff")
        nonce = approvals.grant_resume("H-1", "claude-fable-5-1[1m]")
        self.assertEqual(approvals.consume_resume("H-1", "bad"), "nonce_mismatch")
        self.assertEqual(approvals.consume_resume("H-1", nonce), "claude-fable-5-1[1m]")
        self.assertEqual(approvals.consume_resume("H-1", nonce), "no_executed_handoff")


class ActionTests(unittest.TestCase):
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

    def test_dry_run_resume_never_launches(self) -> None:
        result = relay.launch_resume("airlock hybrid fable --resume abc", os.getcwd(), dry_run=True)
        self.assertFalse(result["launched"])
        self.assertTrue(result["dry_run"])
        self.assertIn("airlock hybrid fable --resume abc", " ".join(result["argv"]))


if __name__ == "__main__":
    unittest.main()
