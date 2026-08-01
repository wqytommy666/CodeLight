#!/usr/bin/env python3
"""Fast local hook/client for the persistent JTX-RGB BLE daemon."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


PORT = int(os.environ.get("AGENT_LIGHT_PORT", "48733"))
COMPLETION_TTL = 60
LABEL = "com.local.agent-status-light"
HOME = Path.home()
CONFIG_PATH = HOME / ".agent-status-light" / "config.json"
LOG_PATH = HOME / ".agent-status-light" / "hook-errors.log"
EVENT_LOG_PATH = HOME / ".agent-status-light" / "events.jsonl"
HOOK_STATE_DIR = HOME / ".agent-status-light" / "hook-state"
CURRENT_PROJECT = ""


def load_config() -> dict[str, Any]:
    try:
        value = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def configured_ttl() -> int:
    value = load_config().get("statusDurationSeconds", COMPLETION_TTL)
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        seconds = COMPLETION_TTL
    return 315_360_000 if seconds == 0 else max(10, min(300, seconds))


def set_command(key: str, state: str) -> str:
    return f"set {key} {state} {configured_ttl()} force"


def log_error(message: str) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 256_000:
            LOG_PATH.unlink()
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {message}\n")
    except Exception:
        pass


def log_event(
    source: str,
    event: str,
    key: str,
    tool: str,
    action: str,
    detail: str = "",
) -> None:
    """Write a compact audit record without persisting prompts or tool output."""
    try:
        EVENT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        if EVENT_LOG_PATH.exists() and EVENT_LOG_PATH.stat().st_size > 1_000_000:
            EVENT_LOG_PATH.replace(EVENT_LOG_PATH.with_suffix(".jsonl.1"))
        record = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "source": source,
            "event": event or "unknown",
            "session": key,
            "tool": tool,
            "action": action,
        }
        if detail:
            record["detail"] = detail[:160]
        if CURRENT_PROJECT:
            record["project"] = CURRENT_PROJECT[:96]
        with EVENT_LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    except Exception:
        pass


def completion_marker_path(key: str) -> Path:
    safe = "".join(character for character in key if character.isalnum() or character in "-_")[:96]
    return HOOK_STATE_DIR / f"{safe}.completed"


def delegated_marker_path(key: str) -> Path:
    safe = "".join(character for character in key if character.isalnum() or character in "-_")[:96]
    return HOOK_STATE_DIR / f"{safe}.delegated"


def delegated_parent(source: str, payload: dict[str, Any], environment: dict[str, str] | None = None) -> str:
    """Return the top-level agent that owns this nested agent session.

    Claude Desktop's Codex companion deliberately exports both generic Claude
    child-session variables and a companion session id into the Codex process.
    A direct Codex CLI/Desktop session has none of them. Explicit payload
    metadata keeps the same rule usable by the Windows hook relay and future
    provider adapters.
    """
    if source_id(source) != "codex":
        return ""
    explicit = first_string(
        payload,
        "_codelight_parent_provider",
        "parent_provider",
        "parent_source",
        "invoked_by",
    )
    if source_id(explicit) == "claude":
        return "claude"
    env = os.environ if environment is None else environment
    if env.get("CODEX_COMPANION_SESSION_ID") or env.get("CLAUDE_PLUGIN_DATA"):
        return "claude"
    child = str(env.get("CLAUDE_CODE_CHILD_SESSION", "")).strip().lower()
    if child in {"1", "true", "yes", "on"}:
        return "claude"
    claude = str(env.get("CLAUDECODE", "")).strip().lower()
    if claude in {"1", "true", "yes", "on"} and env.get("CLAUDE_CODE_ENTRYPOINT"):
        return "claude"
    return ""


def mark_delegated(key: str, parent: str) -> None:
    try:
        HOOK_STATE_DIR.mkdir(parents=True, exist_ok=True)
        delegated_marker_path(key).write_text(parent, encoding="utf-8")
    except OSError:
        pass


def reset_completion_marker(key: str) -> None:
    try:
        completion_marker_path(key).unlink(missing_ok=True)
    except OSError:
        pass


def mark_completed(key: str) -> None:
    try:
        HOOK_STATE_DIR.mkdir(parents=True, exist_ok=True)
        completion_marker_path(key).write_text(str(time.time()), encoding="ascii")
    except OSError:
        pass


def recently_completed(key: str, max_age: float | None = None) -> bool:
    try:
        if max_age is None:
            max_age = float(configured_ttl()) + 5.0
        timestamp = float(completion_marker_path(key).read_text(encoding="ascii"))
        return 0 <= time.time() - timestamp <= max_age
    except (OSError, ValueError):
        return False


def source_id(value: str) -> str:
    raw = re.sub(r"\s+", "-", (value or "custom").strip().lower())
    aliases = {
        "claude-code": "claude", "openai": "codex", "codex-cli": "codex",
        "mimocode": "mimo", "mimo-code": "mimo", "qwen-code": "qwen",
        "qwen_code": "qwen", "kcode": "kilo", "kilocode": "kilo",
        "kilo-code": "kilo", "kimi-code": "kimi", "gemini-cli": "gemini",
        "roo-code": "roo", "roocode": "roo", "github-copilot": "copilot",
    }
    return aliases.get(raw, raw)


def routing_targets(source: str) -> list[tuple[int, str]]:
    """Return daemon ports assigned to a tool, preserving single-light defaults."""
    try:
        data = load_config()
        devices = data.get("devices", []) if isinstance(data, dict) else []
        if not isinstance(devices, list) or not devices:
            return [(PORT, LABEL)]
        wanted = source_id(source)
        providers = data.get("providers", [])
        if isinstance(providers, list):
            provider = next((item for item in providers if isinstance(item, dict) and source_id(str(item.get("id", ""))) == wanted), None)
            if provider is not None and provider.get("enabled") is False:
                return []
        result: list[tuple[int, str]] = []
        for index, device in enumerate(devices):
            if not isinstance(device, dict) or device.get("enabled") is False:
                continue
            sources = device.get("sources")
            if not isinstance(sources, list) or not sources:
                sources = ["*"]
            normalized = {"*" if item == "*" else source_id(str(item)) for item in sources}
            if "*" not in normalized and wanted not in normalized:
                continue
            port = max(48733, min(48832, int(device.get("port", 48733 + index))))
            identifier = re.sub(r"[^a-z0-9]", "", str(device.get("id", "")))[:12].lower()
            label = LABEL if port == PORT else f"{LABEL}.device-{identifier or port}"
            result.append((port, label))
        return result
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return [(PORT, LABEL)]


def send(command: str, retry: bool = True, port: int = PORT, label: str = LABEL) -> str:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.18) as sock:
            sock.settimeout(0.25)
            sock.sendall((command.rstrip() + "\n").encode("utf-8"))
            return sock.recv(16_384).decode("utf-8", "replace").strip()
    except OSError as exc:
        if retry:
            try:
                # The macOS app owns the BLE child processes so the system's
                # Bluetooth consent is attributed to the visible CodeLight app.
                subprocess.run(
                    ["/usr/bin/open", "-gj", "-a", "CodeLight"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=1.0,
                    check=False,
                )
                time.sleep(0.75)
                return send(command, retry=False, port=port, label=label)
            except Exception:
                pass
        log_error(f"send failed: {exc}; command={command!r}")
        return ""


def send_event(source: str, command: str) -> str:
    responses = [send(command, port=port, label=label) for port, label in routing_targets(source)]
    return " | ".join(response for response in responses if response)


def first_string(payload: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def session_key(source: str, payload: dict[str, Any]) -> str:
    identity = first_string(payload, "session_id", "thread_id", "conversation_id")
    if not identity:
        identity = first_string(payload, "transcript_path", "cwd") or f"pid-{os.getppid()}"
    digest = hashlib.sha256(f"{source}:{identity}".encode("utf-8")).hexdigest()[:24]
    return f"{source}-{digest}"


def normalized_tool(payload: dict[str, Any]) -> str:
    name = first_string(payload, "tool_name", "tool", "name")
    if not name:
        tool = payload.get("tool")
        if isinstance(tool, dict):
            name = first_string(tool, "name", "tool_name")
    return "".join(character for character in name.lower() if character.isalnum())


def is_question_tool(tool: str) -> bool:
    return tool in {
        "askuserquestion",
        "askfollowupquestion",
        "requestuserinput",
        "functionsrequestuserinput",
        "mcprequestuserinput",
    } or tool.endswith("requestuserinput")


def definite_failure(value: Any, depth: int = 0) -> bool:
    if depth > 5:
        return False
    if isinstance(value, dict):
        for key, item in value.items():
            normalized = str(key).lower().replace("-", "_")
            if normalized in {"is_error", "iserror", "failed", "failure"} and item is True:
                return True
            if normalized in {"success", "ok"} and item is False:
                return True
            if normalized in {"exit_code", "exitcode"} and isinstance(item, int) and not isinstance(item, bool) and item != 0:
                return True
            if normalized == "status_code" and isinstance(item, int) and not isinstance(item, bool) and item >= 400:
                return True
            if normalized in {"status", "outcome"} and isinstance(item, str) and item.lower() in {
                "error", "failed", "failure", "timed_out", "timeout"
            }:
                return True
            if definite_failure(item, depth + 1):
                return True
    elif isinstance(value, list):
        return any(definite_failure(item, depth + 1) for item in value)
    return False


def diagnostic_text(payload: dict[str, Any]) -> str:
    """Return error metadata without scanning prompts or ordinary tool input."""
    keys = {
        "error", "message", "formatted", "reason", "detail", "title",
        "notification_type", "type", "outcome", "status", "code", "stderr",
        "exception", "cause",
    }
    values: list[str] = []

    def collect(value: Any, include_all: bool = False, depth: int = 0) -> None:
        if depth > 6:
            return
        if isinstance(value, str):
            if include_all:
                values.append(value)
            return
        if isinstance(value, dict):
            for key, item in value.items():
                selected = include_all or str(key).lower().replace("-", "_") in keys
                if selected:
                    collect(item, True, depth + 1)
        elif isinstance(value, list) and include_all:
            for item in value:
                collect(item, True, depth + 1)

    collect(payload)
    return " ".join(values).lower()


def network_issue(payload: dict[str, Any]) -> bool:
    text = diagnostic_text(payload)
    markers = (
        "network", "connection", "disconnected", "stream disconnected",
        "error sending request", "connect to api", "socket", "econn", "dns",
        "tls", "ssl", "timed out", "timeout", "offline", "unreachable",
        "网络", "连接", "重连", "超时", "断网",
    )
    return any(marker in text for marker in markers)


def error_notification(payload: dict[str, Any]) -> bool:
    ntype = first_string(payload, "notification_type", "type").lower()
    if ntype in {"error", "failure", "auth_error", "network_error", "rate_limit"}:
        return True
    message = diagnostic_text(payload)
    markers = (
        "rate limit", "authentication failed", "invalid api key", "unauthorized",
        "network error", "connection failed", "connection lost",
        "额度不足", "认证失败", "鉴权失败", "网络错误", "网络连接失败", "连接中断",
    )
    return any(marker in message for marker in markers)


def stop_failure(payload: dict[str, Any]) -> bool:
    """Detect a turn that stopped because of a real failure, not user interruption."""
    if definite_failure(payload):
        return True
    reason = first_string(payload, "reason", "stop_reason", "outcome").lower()
    failure_markers = (
        "error", "failed", "failure", "timeout", "timed_out", "network",
        "connection", "rate_limit", "rate limit", "auth", "overloaded",
    )
    return any(marker in reason for marker in failure_markers)


def codex_transcript_tool_failure(payload: dict[str, Any]) -> bool:
    """Recover Codex command status omitted from its PostToolUse payload.

    Codex currently supplies an empty ``tool_response`` for shell calls. The
    referenced rollout JSONL already contains the matching function-call
    output, including the process exit code, by the time the hook runs.
    """
    path_text = first_string(payload, "transcript_path")
    call_id = first_string(payload, "tool_use_id", "call_id")
    if not path_text or not call_id:
        return False
    try:
        path = Path(path_text).expanduser().resolve()
        sessions_root = (HOME / ".codex" / "sessions").resolve()
        if sessions_root not in path.parents or not path.is_file():
            return False
        with path.open("rb") as handle:
            size = path.stat().st_size
            handle.seek(max(0, size - 512_000))
            lines = handle.read().decode("utf-8", "replace").splitlines()
        for line in reversed(lines):
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            item = record.get("payload", {})
            if item.get("type") != "function_call_output" or item.get("call_id") != call_id:
                continue
            output = item.get("output", "")
            if isinstance(output, (dict, list)):
                return definite_failure(output)
            if not isinstance(output, str):
                return False
            if re.search(r"\bProcess exited with code\s+(-?[1-9]\d*)\b", output):
                return True
            if re.search(r'"(?:exit_code|exitCode)"\s*:\s*(-?[1-9]\d*)', output):
                return True
            lowered = output.lower()
            return any(marker in lowered for marker in (
                "tool call failed", "request failed", "timed out", "network error",
                "authentication failed", '"iserror":true', '"is_error":true',
            ))
    except (OSError, ValueError):
        return False
    return False


def schedule_codex_transcript_check(payload: dict[str, Any], key: str) -> None:
    """Check a Codex result just after its hook returns.

    Some Codex builds append ``function_call_output`` only after the
    synchronous PostToolUse hook exits. A detached, short-lived checker avoids
    blocking Codex while still reporting the failure in well under a second.
    """
    path_text = first_string(payload, "transcript_path")
    call_id = first_string(payload, "tool_use_id", "call_id")
    if not path_text or not call_id:
        return
    try:
        subprocess.Popen(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--deferred-codex-check",
                path_text,
                call_id,
                key,
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )
        log_event("codex", "PostToolUse", key, normalized_tool(payload), "deferred-scheduled")
    except OSError as exc:
        log_error(f"unable to schedule Codex result check: {exc}")


def deferred_codex_check(path_text: str, call_id: str, key: str) -> int:
    payload = {"transcript_path": path_text, "tool_use_id": call_id}
    for delay in (0.06, 0.10, 0.18, 0.30, 0.50):
        time.sleep(delay)
        if codex_transcript_tool_failure(payload):
            # A command failure is recoverable working context. The runtime
            # watcher reports red only if the complete Codex turn ultimately
            # fails, avoiding a sticky false alarm while Codex is still active.
            log_event("codex", "PostToolUse", key, "", "activity", "recoverable-tool-failure-deferred")
            return 0
    log_event("codex", "PostToolUse", key, "", "deferred-no-failure")
    return 0


def process_hook(source: str, payload: dict[str, Any]) -> None:
    global CURRENT_PROJECT
    project_path = first_string(payload, "project", "project_dir", "workspace", "workspace_path", "cwd")
    if project_path:
        CURRENT_PROJECT = Path(project_path).expanduser().name
    else:
        try:
            CURRENT_PROJECT = Path.cwd().name if Path.cwd() != HOME else ""
        except OSError:
            CURRENT_PROJECT = ""
    event = first_string(payload, "hook_event_name", "event")
    semantic = event.lower().replace("_", ".")
    event = {
        "complete": "Stop", "completed": "Stop", "task.complete": "Stop", "session.idle": "Stop",
        "error": "PostToolUseFailure", "failed": "PostToolUseFailure", "task.failed": "PostToolUseFailure", "session.error": "PostToolUseFailure",
        "permission": "PermissionRequest", "permission.asked": "PermissionRequest", "approval": "PermissionRequest",
        "question": "QuestionRequired", "input.required": "QuestionRequired",
        "start": "UserPromptSubmit", "started": "UserPromptSubmit", "task.started": "UserPromptSubmit", "chat.message": "UserPromptSubmit",
        "tool.before": "PreToolUse", "tool.execute.before": "PreToolUse",
        "tool.after": "PostToolUse", "tool.execute.after": "PostToolUse",
        "beforetool": "PreToolUse", "aftertool": "PostToolUse",
        "beforeagent": "UserPromptSubmit", "afteragent": "Stop",
        "pre.tool.call": "PreToolUse", "post.tool.call": "PostToolUse",
        "pre.llm.call": "UserPromptSubmit", "post.llm.call": "Stop",
        "on.session.start": "SessionStart", "on.session.end": "SessionEnd",
        "on.session.finalize": "SessionEnd",
        "clear": "UserPromptSubmit",
    }.get(semantic, event)
    key = session_key(source, payload)
    tool = normalized_tool(payload)

    # Codex is frequently used as an implementation worker inside Claude
    # Desktop. Its Stop then means only "the delegated subtask returned", not
    # that the user's top-level task is finished. Let Claude own every visible
    # state for that workflow and leave a marker so the transcript watcher also
    # ignores the nested Codex task_complete record.
    parent = delegated_parent(source, payload)
    if parent:
        mark_delegated(key, parent)
        if event in {"SessionStart", "Stop", "StopFailure", "SessionEnd"}:
            log_event(source, event, key, tool, "delegated", f"parent={parent}")
        return

    if event in {"SessionStart", "UserPromptSubmit"}:
        # A new turn resolves stale attention/failure states, but it must not
        # erase the preceding turn's short completion acknowledgement. This
        # guarantees that green remains visible for its full TTL even when the
        # user submits the next prompt immediately.
        send_event(source, f"activity {key}")
        reset_completion_marker(key)
        log_event(source, event, key, tool, "activity")
        return

    if event == "SessionEnd":
        reason = first_string(payload, "reason", "stop_reason", "outcome").lower()
        if recently_completed(key):
            # Stop already installed a self-expiring green entry. Activity
            # intentionally preserves green while clearing attention states.
            send_event(source, f"activity {key}")
            log_event(source, event, key, tool, "green-preserved")
        elif network_issue(payload):
            send_event(source, set_command(key, "yellow"))
            log_event(source, event, key, tool, "yellow", "网络连接异常，请检查或切换网络")
        elif stop_failure(payload):
            # Absence of Stop alone is not an error: clients frequently close
            # short-lived helper sessions without emitting a Stop hook.
            send_event(source, set_command(key, "red"))
            log_event(source, event, key, tool, "red", reason or "explicit-session-failure")
        else:
            send_event(source, f"clear {key}")
            log_event(source, event, key, tool, "clear", reason)
        return

    if event == "PermissionRequest":
        # Questions, choices, approvals and permissions are all normal cases
        # that require a human decision, so they share the blue state.
        send_event(source, set_command(key, "blue"))
        log_event(source, event, key, tool, "blue")
        return

    if event == "PreToolUse":
        if is_question_tool(tool):
            send_event(source, set_command(key, "blue"))
            log_event(source, event, key, tool, "blue")
        else:
            # A new tool beginning means a previous approval/error was handled.
            send_event(source, f"activity {key}")
            log_event(source, event, key, tool, "activity")
        return

    if event == "PostToolUseFailure":
        # A failed shell/tool call is recoverable and does not mean the agent's
        # task failed. Claude frequently continues with another tool call.
        # Network failures are actionable, however, so surface those in yellow.
        if network_issue(payload):
            detail = first_string(payload, "reason", "message", "outcome") or "网络重试，请检查或切换网络"
            send_event(source, set_command(key, "yellow"))
            log_event(source, event, key, tool, "yellow", detail)
        else:
            send_event(source, f"activity {key}")
            log_event(source, event, key, tool, "activity", "recoverable-tool-failure")
        return

    if event == "StopFailure":
        send_event(source, set_command(key, "red"))
        log_event(source, event, key, tool, "red", first_string(payload, "reason", "message", "outcome"))
        return

    if event == "PostToolUse":
        direct_failure = (
            definite_failure(payload.get("tool_response"))
            or definite_failure(payload.get("tool_result"))
        )
        transcript_failure = source == "codex" and codex_transcript_tool_failure(payload)
        if (direct_failure or transcript_failure) and network_issue(payload):
            send_event(source, set_command(key, "yellow"))
            log_event(source, event, key, tool, "yellow", "网络重试，请检查或切换网络")
        elif direct_failure or transcript_failure:
            # Tool-level failures are working context, not a final task result.
            send_event(source, f"activity {key}")
            log_event(source, event, key, tool, "activity", "recoverable-tool-failure")
        elif is_question_tool(tool):
            # AskUserQuestion/request_user_input has just returned, so the
            # outstanding blue attention state is resolved immediately.
            send_event(source, f"clear {key}")
            log_event(source, event, key, tool, "clear")
        else:
            send_event(source, f"activity {key}")
            log_event(source, event, key, tool, "activity")
            if source == "codex" and not first_string(payload, "tool_response"):
                schedule_codex_transcript_check(payload, key)
        return

    if event == "Notification":
        ntype = first_string(payload, "notification_type", "type").lower()
        if network_issue(payload):
            send_event(source, set_command(key, "yellow"))
            log_event(source, event, key, tool, "yellow", "网络重试，请检查或切换网络")
        elif error_notification(payload):
            send_event(source, set_command(key, "red"))
            log_event(source, event, key, tool, "red")
        elif ntype in {"permission_prompt", "permission"}:
            send_event(source, set_command(key, "blue"))
            log_event(source, event, key, tool, "blue")
        elif ntype in {"idle_prompt", "question", "input_required"}:
            send_event(source, set_command(key, "blue"))
            log_event(source, event, key, tool, "blue")
        else:
            log_event(source, event, key, tool, "ignored")
        return

    if event == "QuestionRequired":
        send_event(source, set_command(key, "blue"))
        log_event(source, event, key, tool, "blue")
        return

    if event == "Stop":
        if network_issue(payload):
            send_event(source, set_command(key, "yellow"))
            log_event(source, event, key, tool, "yellow", "网络连接异常，请检查或切换网络")
        elif stop_failure(payload):
            send_event(source, set_command(key, "red"))
            log_event(source, event, key, tool, "red")
        else:
            # A completed turn replaces any lower-level transient tool failure.
            # Keep completion visible for one minute. ``force`` restarts the
            # burst and timer even when the same session completes another turn.
            send_event(source, set_command(key, "green"))
            mark_completed(key)
            log_event(source, event, key, tool, "green")
        return

    log_event(source, event, key, tool, "ignored")


def hook_mode(source: str) -> int:
    try:
        raw = sys.stdin.buffer.read(2_000_000)
        payload = json.loads(raw) if raw.strip() else {}
        if isinstance(payload, dict):
            # Opt-in diagnostics for protocol compatibility tests. This is
            # disabled in normal operation because hook payloads may contain
            # tool output.
            debug_path = os.environ.get("AGENT_LIGHT_DEBUG_PAYLOAD")
            if debug_path:
                with Path(debug_path).open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(payload, ensure_ascii=False) + "\n")
            process_hook(source, payload)
    except Exception as exc:
        log_error(f"hook parse/process failed: {exc}")
    return 0


def main() -> int:
    if len(sys.argv) == 5 and sys.argv[1] == "--deferred-codex-check":
        return deferred_codex_check(sys.argv[2], sys.argv[3], sys.argv[4])

    parser = argparse.ArgumentParser(description="CodeLight multi-agent JTX-RGB status client")
    parser.add_argument("--source", help="read a lifecycle hook JSON object from stdin for this tool")
    parser.add_argument("--emit", nargs=2, metavar=("TOOL", "EVENT"), help="emit a generic CodeLight event")
    parser.add_argument("--session", default="manual", help="session key used with --emit")
    parser.add_argument("command", nargs="?", choices=["status", "set", "clear", "off", "demo", "ping", "charger-silence", "charge"])
    parser.add_argument("value", nargs="?")
    parser.add_argument("key", nargs="?", default="manual")
    args = parser.parse_args()

    if args.source:
        return hook_mode(args.source)

    if args.emit:
        source, event = args.emit
        process_hook(source_id(source), {"session_id": args.session, "project": args.session, "hook_event_name": event})
        return 0

    if not args.command or args.command == "status":
        command = "status"
    elif args.command in {"off"}:
        command = "clear-all"
    elif args.command in {"ping"}:
        command = "ping"
    elif args.command == "charger-silence":
        if args.value not in {"on", "off"}:
            parser.error("charger-silence requires on|off")
        command = f"charger-silence {args.value}"
    elif args.command == "charge":
        if args.value == "hide":
            command = "charger-silence on"
        elif args.value == "show":
            seconds = args.key if args.key != "manual" else "10"
            try:
                seconds = str(max(1, min(300, int(seconds))))
            except ValueError:
                parser.error("charge show [seconds] requires an integer")
            command = f"charger-status {seconds}"
        else:
            parser.error("charge requires hide|show [seconds]")
    elif args.command == "clear":
        command = f"clear {args.key if args.value is None else args.value}"
    elif args.command in {"set", "demo"}:
        if args.value not in {"green", "blue", "yellow", "red"}:
            parser.error(f"{args.command} requires green|blue|yellow|red")
        command = f"set {args.key} {args.value} 3600" if args.command == "set" else f"demo {args.value}"
    else:
        parser.error("unknown command")

    response = send(command)
    if response:
        print(response)
        return 0 if response.startswith("OK") else 1
    print("ERR agent-light-daemon unavailable", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
