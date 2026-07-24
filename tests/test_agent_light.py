from __future__ import annotations

import importlib.util
import pathlib
import json
import tempfile
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("agent_light", ROOT / "agent_light.py")
assert SPEC and SPEC.loader
agent_light = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent_light)

WATCH_SPEC = importlib.util.spec_from_file_location("status_watch", ROOT / "status_watch.py")
assert WATCH_SPEC and WATCH_SPEC.loader
status_watch = importlib.util.module_from_spec(WATCH_SPEC)
WATCH_SPEC.loader.exec_module(status_watch)


class AgentLightHookTests(unittest.TestCase):
    def command_for(self, payload: dict) -> str:
        commands: list[str] = []
        with patch.object(agent_light, "send_event", side_effect=lambda _source, command: commands.append(command)), \
             patch.object(agent_light, "configured_ttl", return_value=60), \
             patch.object(agent_light, "log_event"), \
             patch.object(agent_light, "mark_completed"), \
             patch.object(agent_light, "reset_completion_marker"):
            agent_light.process_hook("codex", {"session_id": "test", **payload})
        self.assertEqual(len(commands), 1)
        return commands[0]

    def test_stop_is_one_minute_green_and_forces_a_new_burst(self) -> None:
        self.assertRegex(self.command_for({"hook_event_name": "Stop"}), r"^set codex-.+ green 60 force$")

    def test_new_prompt_preserves_completion_green_via_activity(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "UserPromptSubmit"}),
            r"^activity codex-",
        )

    def test_failed_stop_is_red(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "Stop", "reason": "network_error"}),
            r" red 60 force$",
        )

    def test_user_interruption_is_not_a_failure(self) -> None:
        self.assertFalse(agent_light.stop_failure({"reason": "interrupted"}))

    def test_session_end_without_successful_stop_clears(self) -> None:
        with patch.object(agent_light, "recently_completed", return_value=False):
            self.assertRegex(
                self.command_for({"hook_event_name": "SessionEnd", "reason": "other"}),
                r"^clear codex-",
            )

    def test_session_end_with_explicit_failure_is_red(self) -> None:
        with patch.object(agent_light, "recently_completed", return_value=False):
            self.assertRegex(
                self.command_for({"hook_event_name": "SessionEnd", "reason": "network_error"}),
                r" red 60 force$",
            )

    def test_session_end_after_successful_stop_preserves_green(self) -> None:
        with patch.object(agent_light, "recently_completed", return_value=True):
            self.assertRegex(
                self.command_for({"hook_event_name": "SessionEnd", "reason": "other"}),
                r"^activity codex-",
            )

    def test_session_end_after_user_cancel_clears(self) -> None:
        with patch.object(agent_light, "recently_completed", return_value=False):
            self.assertRegex(
                self.command_for({"hook_event_name": "SessionEnd", "reason": "user_cancelled"}),
                r"^clear codex-",
            )

    def test_permission_and_question_are_distinct(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "PermissionRequest", "tool_name": "Bash"}),
            r" yellow 60 force$",
        )
        self.assertRegex(
            self.command_for({"hook_event_name": "PreToolUse", "tool_name": "request_user_input"}),
            r" blue 60 force$",
        )

    def test_question_completion_clears_blue_immediately(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "PostToolUse", "tool_name": "request_user_input", "tool_response": {"ok": True}}),
            r"^clear codex-",
        )

    def test_http_success_is_not_a_tool_failure(self) -> None:
        self.assertFalse(agent_light.definite_failure({"status_code": 200}))
        self.assertTrue(agent_light.definite_failure({"status_code": 503}))
        self.assertTrue(agent_light.definite_failure({"exit_code": 2}))

    def test_codex_transcript_recovers_omitted_exit_code(self) -> None:
        sessions = pathlib.Path.home() / ".codex" / "sessions"
        sessions.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", dir=sessions, suffix=".jsonl", delete=False) as handle:
            path = pathlib.Path(handle.name)
            handle.write(json.dumps({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-test",
                    "output": "Process exited with code 7\nOutput:\n",
                },
            }) + "\n")
        try:
            self.assertTrue(agent_light.codex_transcript_tool_failure({
                "transcript_path": str(path),
                "tool_use_id": "call-test",
            }))
        finally:
            path.unlink(missing_ok=True)

    def test_runtime_watch_detects_codex_api_failure(self) -> None:
        decision = status_watch.classify_record({
            "type": "event_msg",
            "payload": {
                "type": "task_complete",
                "error": {"message": "network failed", "codex_error_info": "network"},
            },
        })
        self.assertEqual(decision, ("red", "network"))

    def test_runtime_watch_clears_on_recovery(self) -> None:
        self.assertEqual(
            status_watch.classify_record({"type": "event_msg", "payload": {"type": "task_started"}}),
            ("reset", "task_started"),
        )

    def test_runtime_watch_reset_does_not_erase_completion_green(self) -> None:
        commands: list[str] = []
        with patch.object(status_watch, "send", side_effect=lambda command: commands.append(command) or True), \
             patch.object(status_watch, "log_action"):
            status_watch.apply_action("reset", "task_started")
        self.assertEqual(commands, [f"clear {status_watch.ERROR_KEY}"])

    def test_runtime_watch_reports_successful_completion(self) -> None:
        self.assertEqual(
            status_watch.classify_record({"type": "event_msg", "payload": {"type": "task_complete", "error": None}}),
            ("green", "task_complete"),
        )

    def test_network_notification_is_red(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "Notification", "notification_type": "network_error"}),
            r" red 60 force$",
        )

    def test_disabled_provider_has_no_physical_routes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / "config.json"
            config.write_text(json.dumps({
                "providers": [{"id": "codex", "enabled": False}],
                "devices": [{"id": "lamp-a", "port": 48733, "sources": ["codex"]}],
            }))
            with patch.object(agent_light, "CONFIG_PATH", config):
                self.assertEqual(agent_light.routing_targets("codex"), [])

    def test_completion_marker_uses_configured_duration(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            marker = root / "codex-test.completed"
            marker.write_text(str(1_000.0))
            with patch.object(agent_light, "HOOK_STATE_DIR", root), \
                 patch.object(agent_light, "configured_ttl", return_value=300), \
                 patch.object(agent_light.time, "time", return_value=1_120.0):
                self.assertTrue(agent_light.recently_completed("codex-test"))


if __name__ == "__main__":
    unittest.main()
