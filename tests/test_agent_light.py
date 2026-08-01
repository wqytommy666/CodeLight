from __future__ import annotations

import importlib.util
import pathlib
import json
import os
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
    def command_for(self, payload: dict, source: str = "codex") -> str:
        commands: list[str] = []
        with patch.object(agent_light, "send_event", side_effect=lambda _source, command: commands.append(command)), \
             patch.object(agent_light, "configured_ttl", return_value=60), \
             patch.object(agent_light, "log_event"), \
             patch.object(agent_light, "mark_completed"), \
             patch.object(agent_light, "reset_completion_marker"):
            agent_light.process_hook(source, {"session_id": "test", **payload})
        self.assertEqual(len(commands), 1)
        return commands[0]

    def test_stop_is_one_minute_green_and_forces_a_new_burst(self) -> None:
        self.assertRegex(self.command_for({"hook_event_name": "Stop"}), r"^set codex-.+ green 60 force$")

    def test_codex_delegated_by_claude_never_controls_the_lamp(self) -> None:
        commands: list[str] = []
        with patch.dict(os.environ, {
            "CLAUDE_CODE_CHILD_SESSION": "1",
            "CLAUDE_CODE_ENTRYPOINT": "claude-desktop",
            "CLAUDECODE": "1",
            "CODEX_COMPANION_SESSION_ID": "claude-parent",
        }, clear=False), \
             patch.object(agent_light, "send_event", side_effect=lambda _source, command: commands.append(command)), \
             patch.object(agent_light, "mark_delegated") as marked, \
             patch.object(agent_light, "log_event") as logged:
            agent_light.process_hook("codex", {"session_id": "nested-codex", "hook_event_name": "Stop"})
        self.assertEqual(commands, [])
        marked.assert_called_once()
        self.assertEqual(marked.call_args.args[1], "claude")
        self.assertEqual(logged.call_args.args[4], "delegated")

    def test_direct_codex_is_not_mistaken_for_a_claude_child(self) -> None:
        self.assertEqual(agent_light.delegated_parent("codex", {}, {}), "")
        self.assertEqual(
            agent_light.delegated_parent("codex", {"_codelight_parent_provider": "claude"}, {}),
            "claude",
        )

    def test_new_prompt_preserves_completion_green_via_activity(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "UserPromptSubmit"}),
            r"^activity codex-",
        )

    def test_failed_stop_is_red(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "Stop", "reason": "authentication_failed"}),
            r" red 60 force$",
        )

    def test_network_stop_is_yellow(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "Stop", "reason": "network_error"}),
            r" yellow 60 force$",
        )

    def test_user_interruption_is_not_a_failure(self) -> None:
        self.assertFalse(agent_light.stop_failure({"reason": "interrupted"}))

    def test_session_end_without_successful_stop_clears(self) -> None:
        with patch.object(agent_light, "recently_completed", return_value=False):
            self.assertRegex(
                self.command_for({"hook_event_name": "SessionEnd", "reason": "other"}),
                r"^clear codex-",
            )

    def test_session_end_with_network_failure_is_yellow(self) -> None:
        with patch.object(agent_light, "recently_completed", return_value=False):
            self.assertRegex(
                self.command_for({"hook_event_name": "SessionEnd", "reason": "network_error"}),
                r" yellow 60 force$",
            )

    def test_session_end_with_auth_failure_is_red(self) -> None:
        with patch.object(agent_light, "recently_completed", return_value=False):
            self.assertRegex(
                self.command_for({"hook_event_name": "SessionEnd", "reason": "authentication_failed"}),
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
            r" blue 60 force$",
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

    def test_recoverable_tool_failure_does_not_turn_red(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "PostToolUseFailure", "tool_name": "Bash"}, "claude"),
            r"^activity claude-",
        )

    def test_claude_network_tool_failure_is_yellow(self) -> None:
        self.assertRegex(
            self.command_for({
                "hook_event_name": "PostToolUseFailure",
                "tool_name": "Bash",
                "reason": "Connection error ECONNRESET; retrying",
            }, "claude"),
            r" yellow 60 force$",
        )

    def test_stop_failure_is_still_red(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "StopFailure", "reason": "fatal"}, "claude"),
            r" red 60 force$",
        )

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
        self.assertEqual(decision, ("yellow", "network failed"))

    def test_runtime_watch_detects_exact_codex_stream_disconnect(self) -> None:
        message = "stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)"
        self.assertEqual(
            status_watch.classify_record({
                "type": "event_msg",
                "payload": {"type": "task_complete", "error": {"message": message, "codex_error_info": "other"}},
            }),
            ("yellow", message),
        )

    def test_runtime_watch_keeps_non_network_failure_red(self) -> None:
        self.assertEqual(
            status_watch.classify_record({
                "type": "event_msg",
                "payload": {"type": "task_complete", "error": {"message": "unauthorized", "codex_error_info": "unauthorized"}},
            }),
            ("red", "unauthorized"),
        )

    def test_runtime_watch_clears_on_recovery(self) -> None:
        self.assertEqual(
            status_watch.classify_record({"type": "event_msg", "payload": {"type": "task_started"}}),
            ("reset", "task_started"),
        )

    def test_runtime_watch_discovers_old_folder_when_rollout_is_still_active(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            old_folder = root / "2026" / "06" / "01"
            old_folder.mkdir(parents=True)
            active = old_folder / "rollout-active.jsonl"
            active.write_text("{}\n")
            os.utime(active, (995.0, 995.0))
            with patch.object(status_watch, "CODEX_SESSIONS_ROOT", root), \
                 patch.object(status_watch.time, "time", return_value=1_000.0):
                # The folder date is irrelevant; a recent mtime keeps a
                # long-running task observable.
                self.assertIn(active, status_watch.watched_paths(max_age=60))

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

    def test_runtime_watch_suppresses_rollout_owned_by_claude(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "rollout.jsonl"
            path.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"session_id": "nested", "originator": "Claude Code", "source": "vscode"},
            }) + "\n")
            delegated, key = status_watch.delegated_rollout(path)
        self.assertTrue(delegated)
        self.assertEqual(key, status_watch.codex_session_key("nested"))

    def test_runtime_watch_uses_hook_marker_for_claude_spawned_codex_exec(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / "rollout.jsonl"
            path.write_text(json.dumps({
                "type": "session_meta",
                "payload": {"session_id": "nested-exec", "originator": "codex_exec", "source": "exec"},
            }) + "\n")
            key = status_watch.codex_session_key("nested-exec")
            with patch.object(status_watch, "HOOK_STATE_DIR", root):
                status_watch.delegated_marker_path(key).write_text("claude")
                delegated, actual = status_watch.delegated_rollout(path)
        self.assertTrue(delegated)
        self.assertEqual(actual, key)

    def test_network_notification_is_yellow_for_every_provider(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "Notification", "notification_type": "network_error"}),
            r" yellow 60 force$",
        )

    def test_claude_network_notification_is_yellow(self) -> None:
        self.assertRegex(
            self.command_for({"hook_event_name": "Notification", "notification_type": "network_error"}, "claude"),
            r" yellow 60 force$",
        )

    def test_claude_transcript_network_retry_is_yellow(self) -> None:
        decision = status_watch.classify_claude_record({
            "type": "system",
            "subtype": "api_error",
            "source": "request_retry",
            "retryInMs": 4000,
            "retryAttempt": 2,
            "maxRetries": 10,
            "sessionId": "claude-session",
            "error": {
                "formatted": "Unable to connect to API (ECONNRESET)",
                "connection": {"code": "ECONNRESET"},
            },
        })
        self.assertIsNotNone(decision)
        assert decision is not None
        self.assertEqual(decision[0], "yellow")
        self.assertEqual(decision[2], "claude-session")

    def test_claude_response_clears_network_retry(self) -> None:
        self.assertEqual(
            status_watch.classify_claude_record({"type": "assistant", "sessionId": "claude-session"}),
            ("reset", "network-recovered", "claude-session"),
        )

    def test_repeated_codex_retry_refreshes_without_replaying_burst(self) -> None:
        commands: list[str] = []
        status_watch.CODEX_NETWORK_ACTIVE = False
        status_watch.CODEX_NETWORK_ALERT_AT = 0.0
        with patch.object(status_watch, "send", side_effect=lambda command: commands.append(command) or True), \
             patch.object(status_watch, "log_action") as logged:
            status_watch.apply_action("yellow", "stream disconnected")
            status_watch.apply_action("yellow", "stream disconnected")
        self.assertEqual(commands.count(f"set {status_watch.ERROR_KEY} yellow 60"), 2)
        self.assertFalse(any(command.endswith(" force") for command in commands))
        self.assertEqual(logged.call_count, 1)

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
