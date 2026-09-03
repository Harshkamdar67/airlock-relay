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

    def test_resume_command_per_source(self) -> None:
        self.assertEqual(relay.resume_command("airlock", "claude-fable-5-1[1m]", "abc"), "airlock hybrid fable --resume abc")
        self.assertEqual(relay.resume_command("airlock", "gpt-5.6-sol", None), "airlock hybrid sol --continue")
        self.assertIsNone(relay.resume_command("airlock", "not-a-model", "abc"))
        self.assertEqual(relay.resume_command("claude-code", "claude-sonnet-5[1m]", "abc"), "claude --resume abc --model sonnet")
        self.assertEqual(relay.resume_command("claude-code", "claude-haiku-4-5", None), "claude --continue --model haiku")
        self.assertIsNone(relay.resume_command("generic", "gpt-5.6-sol", "abc"))


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


class IngestTests(unittest.TestCase):
    def test_claude_code_hooks_compose_a_blocked_report(self) -> None:
        rt = relay.IngestedRuntime("claude-code", "claude-opus-5[1m]", "anthropic", list(relay.CLAUDE_CODE_MODELS))
        rt.ingest({"event": {"kind": "SessionStart", "session_id": "s-1", "cwd": "/w", "source": "startup"}})
        rt.ingest({"event": {"kind": "PostToolUse", "tool_name": "Bash"}})
        report, models = rt.diagnostics()
        self.assertFalse(relay.is_blocked(report))
        self.assertEqual(rt.session_id, "s-1")
        rt.ingest({"event": {"kind": "StopFailure", "failure": "rate_limit"}})
        report, models = rt.diagnostics()
        self.assertTrue(relay.is_blocked(report))
        self.assertEqual(report["rate_limit_provider_cooldowns"], ["anthropic"])
        self.assertEqual(report["events"][-1]["source"], "claude-code")
        self.assertIn("rate limit", report["events"][-1]["summary"])
        self.assertEqual(models, list(relay.CLAUDE_CODE_MODELS))

    def test_model_level_failures_only_cool_the_active_model(self) -> None:
        rt = relay.IngestedRuntime("generic", "gpt-5.6-sol", "openai", ["gpt-5.6-sol", "gpt-5.6-terra"])
        rt.ingest({"event": {"kind": "failure", "failure": "overloaded"}})
        report, _ = rt.diagnostics()
        self.assertEqual(report["rate_limit_cooldowns"], ["gpt-5.6-sol"])
        self.assertEqual(report["rate_limit_provider_cooldowns"], [])
        self.assertTrue(relay.is_blocked(report))
        rt.ingest({"event": {"kind": "SessionStart"}})
        report, _ = rt.diagnostics()
        self.assertFalse(relay.is_blocked(report))

    def test_state_documents_update_the_runtime(self) -> None:
        rt = relay.IngestedRuntime("generic", "x", "openai", [])
        rt.ingest({"state": {"session_id": "abc", "cwd": "/w", "model": "gpt-5.6-terra", "provider": "openai", "models": ["gpt-5.6-terra", "gpt-5.6-luna"]}})
        report, models = rt.diagnostics()
        self.assertEqual(report["root_model"], "gpt-5.6-terra")
        self.assertEqual(models, ["gpt-5.6-terra", "gpt-5.6-luna"])
        self.assertEqual(rt.session_id, "abc")

    def test_events_are_bounded_and_summaries_truncated(self) -> None:
        rt = relay.IngestedRuntime("generic", "m", "openai", [])
        for _ in range(600):
            rt.ingest({"event": {"kind": "turn_completed", "summary": "x" * 1000}})
        report, _ = rt.diagnostics()
        self.assertEqual(len(report["events"]), 500)
        self.assertEqual(len(report["events"][0]["summary"]), 200)

    def test_build_state_from_ingested_report(self) -> None:
        rt = relay.IngestedRuntime("claude-code", "claude-opus-5[1m]", "anthropic", list(relay.CLAUDE_CODE_MODELS))
        rt.ingest({"event": {"kind": "StopFailure", "failure": "rate_limit"}})
        report, models = rt.diagnostics()
        state = relay.build_state(report, models, router_url="ingest:claude-code", task="t", workdir="w", session_id="s", source="claude-code")
        self.assertEqual(state["bridge"]["source"], "claude-code")
        self.assertTrue(state["cooldown_until"])
        self.assertEqual(state["diagnostics"]["profile"], "claude-code")


class WebhookTests(unittest.TestCase):
    def test_payload_shape_follows_destination(self) -> None:
        body, headers = relay.webhook_payload("https://hooks.slack.com/services/x", "T", "B", "L")
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertIn("*T*", json.loads(body)["text"])
        body, headers = relay.webhook_payload("https://ntfy.sh/topic", "T", "B", "L")
        self.assertEqual(headers["Title"], "T")
        self.assertEqual(headers["Click"], "L")
        body, headers = relay.webhook_payload("https://example.com/hook", "T", "B", "L")
        self.assertEqual(json.loads(body)["kind"], "relay.session_blocked")


class ActionTests(unittest.TestCase):
    def test_non_airlock_sources_record_without_a_command(self) -> None:
        result = relay.apply_handoff("claude-code", "claude-opus-5[1m]", "claude-sonnet-5[1m]")
        self.assertTrue(result["applied"])
        self.assertIsNone(result["command"])

    def test_unknown_routes_are_refused(self) -> None:
        result = relay.apply_handoff("airlock", "claude-opus-5[1m]", "not-a-model")
        self.assertFalse(result["applied"])
        self.assertEqual(result["reason"], "unknown_route_name")

    def test_known_routes_build_the_airlock_command(self) -> None:
        original = relay.shutil.which
        relay.shutil.which = lambda _name: None
        try:
            result = relay.apply_handoff("airlock", "claude-opus-5[1m]", "claude-fable-5-1[1m]")
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
