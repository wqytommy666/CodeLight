#!/usr/bin/env python3
"""Watch agent transcripts for lifecycle states that normal hooks do not emit."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import socket
import time
from pathlib import Path
from typing import Any


HOME = Path.home()
PORT = int(os.environ.get("AGENT_LIGHT_PORT", "48733"))
EVENT_LOG_PATH = HOME / ".agent-status-light" / "events.jsonl"
CONFIG_PATH = HOME / ".agent-status-light" / "config.json"
ERROR_KEY = "codex-runtime-error"
COMPLETE_KEY = "codex-runtime-complete"
CLAUDE_NETWORK_PREFIX = "claude-network-retry"
CLAUDE_PROJECTS_ROOT = HOME / ".claude" / "projects"
CODEX_SESSIONS_ROOT = HOME / ".codex" / "sessions"
DISCOVERY_INTERVAL = 2.0
RECENT_TRANSCRIPT_AGE = 7 * 86_400
CODEX_NETWORK_ACTIVE = False
CODEX_NETWORK_ALERT_AT = 0.0


def configured_ttl() -> int:
    try:
        value = json.loads(CONFIG_PATH.read_text(encoding="utf-8")).get("statusDurationSeconds", 60)
        seconds = int(value)
    except (OSError, ValueError, TypeError, json.JSONDecodeError, AttributeError):
        seconds = 60
    return 315_360_000 if seconds == 0 else max(10, min(300, seconds))


def routing_ports(source: str = "codex") -> list[int]:
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        providers = data.get("providers", []) if isinstance(data, dict) else []
        if isinstance(providers, list):
            aliases = {"codex", "openai", "codex-cli"} if source == "codex" else {source}
            provider = next((item for item in providers if isinstance(item, dict) and str(item.get("id", "")).lower() in aliases), None)
            if provider is not None and provider.get("enabled") is False:
                return []
        devices = data.get("devices", []) if isinstance(data, dict) else []
        if not devices:
            return [PORT]
        ports: list[int] = []
        for index, device in enumerate(devices):
            if not isinstance(device, dict) or device.get("enabled") is False:
                continue
            sources = device.get("sources") if isinstance(device.get("sources"), list) else ["*"]
            if "*" not in sources and source not in [str(item).lower() for item in sources]:
                continue
            ports.append(max(48733, min(48832, int(device.get("port", 48733 + index)))))
        return ports
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return [PORT]


def send_one(command: str, port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25) as sock:
            sock.settimeout(0.3)
            sock.sendall((command.rstrip() + "\n").encode("utf-8"))
            return sock.recv(4096).startswith(b"OK")
    except OSError:
        return False


def send(command: str, source: str = "codex") -> bool:
    results = [send_one(command, port) for port in routing_ports(source)]
    return any(results)


def log_action(
    action: str,
    detail: str = "",
    source: str = "codex",
    event: str = "RuntimeWatch",
    session: str = "",
) -> None:
    try:
        EVENT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "source": source,
            "event": event,
            "session": session or (ERROR_KEY if action == "red" else COMPLETE_KEY),
            "tool": "",
            "action": action,
            "detail": detail[:160],
        }
        with EVENT_LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    except OSError:
        pass


def classify_record(record: dict[str, Any]) -> tuple[str, str] | None:
    if record.get("type") != "event_msg":
        return None
    payload = record.get("payload")
    if not isinstance(payload, dict):
        return None
    event_type = str(payload.get("type", ""))

    if event_type in {"task_started", "user_message"}:
        return "reset", event_type

    if event_type == "task_complete":
        error = payload.get("error")
        if error:
            if isinstance(error, dict):
                detail = str(error.get("message") or error.get("codex_error_info") or "task error")
                diagnostic = json.dumps(error, ensure_ascii=False, separators=(",", ":"))
            else:
                detail = str(error)
                diagnostic = detail
            if is_network_text(diagnostic):
                return "yellow", detail
            return "red", detail
        return "green", "task_complete"

    if event_type == "turn_aborted":
        reason = str(payload.get("reason", "")).lower()
        if reason not in {"", "interrupted", "user_cancelled", "cancelled"}:
            return "red", reason
        return "reset", reason or "interrupted"

    if event_type in {"error", "stream_error", "fatal_error"}:
        detail = str(payload.get("message") or event_type)
        if event_type != "fatal_error" and is_network_text(detail):
            return "yellow", detail
        return "red", detail
    return None


def is_network_text(value: str) -> bool:
    text = value.lower()
    return any(marker in text for marker in (
        "stream disconnected before completion", "error sending request for url",
        "httpconnectionfailed", "response stream", "network", "connection",
        "connect", "socket", "econn", "dns", "tls", "ssl", "timeout",
        "timed out", "offline", "unreachable", "网络", "连接", "重试", "重连",
    ))


def claude_network_key(session: str) -> str:
    digest = hashlib.sha256(session.encode("utf-8", "replace")).hexdigest()[:16]
    return f"{CLAUDE_NETWORK_PREFIX}-{digest}"


def classify_claude_record(record: dict[str, Any]) -> tuple[str, str, str] | None:
    """Classify Claude's transcript-only API retry records.

    Claude Code/Claude Desktop writes request retries as ``system/api_error``
    records but does not emit a lifecycle hook for them. A later user or
    assistant record means that session recovered and clears its yellow state.
    """
    session = str(record.get("sessionId") or record.get("session_id") or "").strip()
    record_type = str(record.get("type", "")).lower()
    if record_type == "system" and str(record.get("subtype", "")).lower() == "api_error":
        error = record.get("error") if isinstance(record.get("error"), dict) else {}
        connection = error.get("connection") if isinstance(error.get("connection"), dict) else {}
        text = " ".join(str(item) for item in (
            error.get("message"), error.get("formatted"), connection.get("code"),
            connection.get("message"), record.get("source"),
        ) if item).lower()
        is_network = bool(connection) or bool(error.get("isNetworkDown")) or any(marker in text for marker in (
            "network", "connection", "connect to api", "socket", "econn", "dns",
            "tls", "ssl", "timeout", "timed out", "offline", "unreachable",
        ))
        is_retry = record.get("retryInMs") is not None or str(record.get("source", "")).lower() == "request_retry"
        if is_network and is_retry:
            attempt = record.get("retryAttempt")
            maximum = record.get("maxRetries")
            suffix = f"第 {attempt}/{maximum} 次" if attempt is not None and maximum is not None else ""
            reason = str(error.get("formatted") or error.get("message") or connection.get("code") or "网络连接失败")
            detail = f"网络重试{suffix} · {reason}，请检查或切换网络"
            return "yellow", detail[:160], session
    if record_type in {"assistant", "user"} and session:
        return "reset", "network-recovered", session
    return None


def recent_codex_stop(max_age: float = 3.0) -> bool:
    """Avoid replaying the green burst when the normal Stop hook already did it."""
    try:
        with EVENT_LOG_PATH.open("rb") as handle:
            size = handle.seek(0, os.SEEK_END)
            handle.seek(max(0, size - 32_000))
            lines = handle.read().decode("utf-8", "replace").splitlines()
        now = time.time()
        for line in reversed(lines):
            record = json.loads(line)
            if record.get("source") != "codex" or record.get("event") != "Stop" or record.get("action") != "green":
                continue
            timestamp = dt.datetime.strptime(record["timestamp"], "%Y-%m-%dT%H:%M:%S%z").timestamp()
            return 0 <= now - timestamp <= max_age
    except (OSError, ValueError, KeyError, json.JSONDecodeError):
        pass
    return False


def apply_action(action: str, detail: str) -> None:
    global CODEX_NETWORK_ACTIVE, CODEX_NETWORK_ALERT_AT
    ok = False
    if action == "red":
        CODEX_NETWORK_ACTIVE = False
        send(f"clear {COMPLETE_KEY}")
        ok = send(f"set {ERROR_KEY} red {configured_ttl()} force")
    elif action == "yellow":
        send(f"clear {COMPLETE_KEY}")
        # Do not replay the six-flash burst on every Codex HTTP reconnect.
        # Updating the same entry without `force` refreshes its TTL while the
        # lamp remains steady. A recovered/new turn clears the incident.
        ok = send(f"set {ERROR_KEY} yellow {configured_ttl()}")
    elif action == "green":
        CODEX_NETWORK_ACTIVE = False
        send(f"clear {ERROR_KEY}")
        if recent_codex_stop():
            ok = True
            action = "green-hook-confirmed"
        else:
            ok = send(f"set {COMPLETE_KEY} green {configured_ttl()} force")
    else:
        CODEX_NETWORK_ACTIVE = False
        # Starting the next task resolves a prior error, but a successful
        # completion is an acknowledgement with a one-minute TTL. Do not
        # cut that acknowledgement short just because the user typed quickly.
        ok = send(f"clear {ERROR_KEY}")
    if ok and action == "yellow":
        now = time.time()
        if not CODEX_NETWORK_ACTIVE or now - CODEX_NETWORK_ALERT_AT >= configured_ttl():
            log_action(action, detail)
            CODEX_NETWORK_ALERT_AT = now
        CODEX_NETWORK_ACTIVE = True
    elif ok:
        log_action(action, detail)


def apply_claude_action(action: str, detail: str, session: str) -> bool:
    key = claude_network_key(session or "unknown")
    if action == "yellow":
        ok = send(f"set {key} yellow {configured_ttl()} force", "claude")
        if ok:
            log_action("yellow", detail, "claude", "NetworkRetryWatch", key)
        return ok
    return send(f"clear {key}", "claude")


def watched_paths(max_age: float = RECENT_TRANSCRIPT_AGE) -> list[Path]:
    """Find recently active Codex rollouts, including long-running tasks.

    A rollout stays in the directory for the day when the task was created.
    Limiting discovery to today/yesterday therefore misses a task that remains
    open for several days. Filter the session tree by modification time
    instead; only files that are still receiving events are watched.
    """
    cutoff = time.time() - max_age
    paths: list[Path] = []
    try:
        for root, _directories, files in os.walk(CODEX_SESSIONS_ROOT):
            for name in files:
                if not name.endswith(".jsonl"):
                    continue
                path = Path(root) / name
                try:
                    if path.stat().st_mtime >= cutoff:
                        paths.append(path)
                except OSError:
                    pass
    except OSError:
        pass
    return paths


def recent_claude_paths(max_age: float = 86_400) -> list[Path]:
    """Find active Claude transcripts without repeatedly reading old 16 GB data."""
    cutoff = time.time() - max_age
    paths: list[Path] = []
    try:
        for project in os.scandir(CLAUDE_PROJECTS_ROOT):
            if not project.is_dir(follow_symlinks=False):
                continue
            try:
                for item in os.scandir(project.path):
                    if not item.is_file(follow_symlinks=False) or not item.name.endswith(".jsonl"):
                        continue
                    try:
                        if item.stat(follow_symlinks=False).st_mtime >= cutoff:
                            paths.append(Path(item.path))
                    except OSError:
                        pass
            except OSError:
                pass
    except OSError:
        pass
    return paths


def record_timestamp(record: dict[str, Any]) -> float:
    value = str(record.get("timestamp", ""))
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


class RolloutWatcher:
    def __init__(self) -> None:
        self.started_at = time.time()
        self.offsets: dict[Path, int] = {}
        for path in watched_paths():
            try:
                self.offsets[path] = path.stat().st_size
            except OSError:
                pass
        self.codex_tail_offsets: set[Path] = set()
        self.last_codex_discovery = self.started_at
        self.claude_offsets: dict[Path, int] = {}
        for path in recent_claude_paths():
            try:
                self.claude_offsets[path] = path.stat().st_size
            except OSError:
                pass
        self.active_claude_network_keys: set[str] = set()
        self.last_claude_discovery = self.started_at

    def poll(self) -> None:
        now = time.time()
        if now - self.last_codex_discovery >= DISCOVERY_INTERVAL:
            current = set(watched_paths())
            for path in current - set(self.offsets):
                try:
                    # A several-day-old rollout can become active again. Read
                    # only its bounded tail so a 100+ MB history never blocks
                    # the watcher, then reject pre-start records by timestamp.
                    offset = max(0, path.stat().st_size - 256_000)
                    self.offsets[path] = offset
                    if offset:
                        self.codex_tail_offsets.add(path)
                except OSError:
                    pass
            for stale in set(self.offsets) - current:
                self.offsets.pop(stale, None)
                self.codex_tail_offsets.discard(stale)
            self.last_codex_discovery = now
        current = set(self.offsets)
        for path in current:
            try:
                size = path.stat().st_size
                offset = self.offsets.get(path, 0)
                if size < offset:
                    offset = 0
                if size == offset:
                    self.offsets[path] = size
                    continue
                with path.open("r", encoding="utf-8", errors="replace") as handle:
                    handle.seek(offset)
                    if path in self.codex_tail_offsets:
                        handle.readline()  # discard a partial JSONL record
                        self.codex_tail_offsets.discard(path)
                    for line in handle:
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        timestamp = record_timestamp(record)
                        if timestamp and timestamp < self.started_at - 5:
                            continue
                        decision = classify_record(record)
                        if decision:
                            apply_action(*decision)
                    self.offsets[path] = handle.tell()
            except OSError:
                continue
        self.poll_claude()

    def poll_claude(self) -> None:
        now = time.time()
        if now - self.last_claude_discovery >= DISCOVERY_INTERVAL:
            current = set(recent_claude_paths())
            for path in current - set(self.claude_offsets):
                try:
                    # Read only a bounded tail when an old session is resumed.
                    # The timestamp gate below ignores historical records.
                    self.claude_offsets[path] = max(0, path.stat().st_size - 256_000)
                except OSError:
                    pass
            for stale in set(self.claude_offsets) - current:
                self.claude_offsets.pop(stale, None)
            self.last_claude_discovery = now

        for path, known_offset in list(self.claude_offsets.items()):
            try:
                size = path.stat().st_size
                offset = 0 if size < known_offset else known_offset
                if size == offset:
                    continue
                with path.open("r", encoding="utf-8", errors="replace") as handle:
                    handle.seek(offset)
                    if offset and offset < size and offset == max(0, size - 256_000):
                        handle.readline()  # discard a partial JSONL record
                    for line in handle:
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        # A resumed old transcript may be discovered after its
                        # first append. Only act on records written this run.
                        timestamp = record_timestamp(record)
                        if timestamp and timestamp < self.started_at - 5:
                            continue
                        decision = classify_claude_record(record)
                        if not decision:
                            continue
                        action, detail, session = decision
                        key = claude_network_key(session or str(path))
                        if action == "yellow":
                            if apply_claude_action(action, detail, session or str(path)):
                                self.active_claude_network_keys.add(key)
                        elif key in self.active_claude_network_keys:
                            apply_claude_action(action, detail, session or str(path))
                            self.active_claude_network_keys.discard(key)
                    self.claude_offsets[path] = handle.tell()
            except OSError:
                continue


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="poll once, for diagnostics")
    args = parser.parse_args()
    watcher = RolloutWatcher()
    if args.once:
        watcher.poll()
        return 0
    while True:
        watcher.poll()
        time.sleep(0.5)


if __name__ == "__main__":
    raise SystemExit(main())
