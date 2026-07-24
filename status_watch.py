#!/usr/bin/env python3
"""Watch Codex rollout records for failures that lifecycle hooks do not emit."""

from __future__ import annotations

import argparse
import datetime as dt
import glob
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


def configured_ttl() -> int:
    try:
        value = json.loads(CONFIG_PATH.read_text(encoding="utf-8")).get("statusDurationSeconds", 60)
        seconds = int(value)
    except (OSError, ValueError, TypeError, json.JSONDecodeError, AttributeError):
        seconds = 60
    return 315_360_000 if seconds == 0 else max(10, min(300, seconds))


def routing_ports() -> list[int]:
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        providers = data.get("providers", []) if isinstance(data, dict) else []
        if isinstance(providers, list):
            codex = next((item for item in providers if isinstance(item, dict) and str(item.get("id", "")).lower() in {"codex", "openai", "codex-cli"}), None)
            if codex is not None and codex.get("enabled") is False:
                return []
        devices = data.get("devices", []) if isinstance(data, dict) else []
        if not devices:
            return [PORT]
        ports: list[int] = []
        for index, device in enumerate(devices):
            if not isinstance(device, dict) or device.get("enabled") is False:
                continue
            sources = device.get("sources") if isinstance(device.get("sources"), list) else ["*"]
            if "*" not in sources and "codex" not in [str(item).lower() for item in sources]:
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


def send(command: str) -> bool:
    results = [send_one(command, port) for port in routing_ports()]
    return any(results)


def log_action(action: str, detail: str = "") -> None:
    try:
        EVENT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        record = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "source": "codex",
            "event": "RuntimeWatch",
            "session": ERROR_KEY if action == "red" else COMPLETE_KEY,
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
                detail = str(error.get("codex_error_info") or error.get("message") or "task error")
            else:
                detail = str(error)
            return "red", detail
        return "green", "task_complete"

    if event_type == "turn_aborted":
        reason = str(payload.get("reason", "")).lower()
        if reason not in {"", "interrupted", "user_cancelled", "cancelled"}:
            return "red", reason
        return "reset", reason or "interrupted"

    if event_type in {"error", "stream_error", "fatal_error"}:
        return "red", str(payload.get("message") or event_type)
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
    ok = False
    if action == "red":
        send(f"clear {COMPLETE_KEY}")
        ok = send(f"set {ERROR_KEY} red {configured_ttl()} force")
    elif action == "green":
        send(f"clear {ERROR_KEY}")
        if recent_codex_stop():
            ok = True
            action = "green-hook-confirmed"
        else:
            ok = send(f"set {COMPLETE_KEY} green {configured_ttl()} force")
    else:
        # Starting the next task resolves a prior error, but a successful
        # completion is an acknowledgement with a one-minute TTL. Do not
        # cut that acknowledgement short just because the user typed quickly.
        ok = send(f"clear {ERROR_KEY}")
    if ok:
        log_action(action, detail)


def watched_paths() -> list[Path]:
    today = dt.date.today()
    days = (today, today - dt.timedelta(days=1))
    paths: list[Path] = []
    for day in days:
        pattern = HOME / ".codex" / "sessions" / f"{day:%Y}" / f"{day:%m}" / f"{day:%d}" / "*.jsonl"
        paths.extend(Path(item) for item in glob.glob(str(pattern)))
    return paths


class RolloutWatcher:
    def __init__(self) -> None:
        self.offsets: dict[Path, int] = {}
        for path in watched_paths():
            try:
                self.offsets[path] = path.stat().st_size
            except OSError:
                pass

    def poll(self) -> None:
        current = set(watched_paths())
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
                    for line in handle:
                        try:
                            record = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        decision = classify_record(record)
                        if decision:
                            apply_action(*decision)
                    self.offsets[path] = handle.tell()
            except OSError:
                continue
        for stale in set(self.offsets) - current:
            self.offsets.pop(stale, None)


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
