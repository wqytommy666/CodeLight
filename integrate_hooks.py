#!/usr/bin/env python3
"""Attach the light hook to already-installed Ping Island/Coffee hook relays.

Keeping the existing hook command paths means Codex does not need a second,
duplicate lifecycle-hook stack. Backups are made before either relay changes.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path


HOME = Path.home()
LIGHT_HOOK = HOME / ".agent-status-light" / "bin" / "agent-light-hook"
PING_WRAPPER = HOME / ".ping-island" / "bin" / "ping-island-bridge"
COFFEE_HOOK = HOME / ".coffee-cli" / "hooks" / "coffee-cli-hook.py"
CLAUDE_SETTINGS = HOME / ".claude" / "settings.json"
CODEX_CONFIG = HOME / ".codex" / "config.toml"
PING_MARKER = "# >>> agent-status-light integration >>>"
COFFEE_MARKER = "# >>> agent-status-light integration >>>"


def backup(path: Path) -> Path:
    destination = path.with_name(path.name + ".before-agent-light")
    if path.exists() and not destination.exists():
        shutil.copy2(path, destination)
    return destination


def patch_ping() -> str:
    if not PING_WRAPPER.exists():
        return "Ping Island relay not found (skipped)"
    text = PING_WRAPPER.read_text(encoding="utf-8")
    if PING_MARKER in text:
        return "Ping Island relay already integrated"
    needle = "\nfor candidate in \"${candidates[@]}\"; do\n"
    if needle not in text or '    exec "$candidate" "$@"' not in text:
        return "Ping Island relay layout unknown (skipped)"
    backup(PING_WRAPPER)
    block = f'''\n{PING_MARKER}\nAGENT_LIGHT_HOOK='{LIGHT_HOOK}'\nAGENT_LIGHT_PAYLOAD="$(/bin/cat)"\nif [[ -x "$AGENT_LIGHT_HOOK" ]]; then\n  print -rn -- "$AGENT_LIGHT_PAYLOAD" | "$AGENT_LIGHT_HOOK" "$@" >/dev/null 2>&1 || true\nfi\n# <<< agent-status-light integration <<<\n'''
    text = text.replace(needle, block + needle, 1)
    text = text.replace(
        '    exec "$candidate" "$@"',
        '    print -rn -- "$AGENT_LIGHT_PAYLOAD" | "$candidate" "$@"\n    exit $?',
        1,
    )
    PING_WRAPPER.write_text(text, encoding="utf-8")
    PING_WRAPPER.chmod(0o755)
    return "Ping Island relay integrated"


def patch_coffee() -> str:
    if not COFFEE_HOOK.exists():
        return "Coffee relay not found (skipped)"
    text = COFFEE_HOOK.read_text(encoding="utf-8")
    if COFFEE_MARKER in text:
        return "Coffee relay already integrated"
    needle = "    try:\n        data = json.load(sys.stdin)\n    except Exception:\n        sys.exit(0)\n"
    if needle not in text:
        return "Coffee relay layout unknown (skipped)"
    backup(COFFEE_HOOK)
    block = f'''    try:\n        data = json.load(sys.stdin)\n    except Exception:\n        sys.exit(0)\n\n    {COFFEE_MARKER}\n    try:\n        transcript = str(data.get("transcript_path", ""))\n        model = str(data.get("model", "")).lower()\n        source = "codex" if "/.codex/" in transcript or model.startswith("gpt-") else "claude"\n        import subprocess\n        subprocess.run(\n            ["{LIGHT_HOOK}", "--source", source],\n            input=json.dumps(data).encode("utf-8"),\n            stdout=subprocess.DEVNULL,\n            stderr=subprocess.DEVNULL,\n            timeout=0.45,\n            check=False,\n        )\n    except Exception:\n        pass\n    # <<< agent-status-light integration <<<\n'''
    text = text.replace(needle, block, 1)
    COFFEE_HOOK.write_text(text, encoding="utf-8")
    COFFEE_HOOK.chmod(0o755)
    return "Coffee relay integrated"


def patch_claude_direct_hooks() -> str:
    if not CLAUDE_SETTINGS.exists():
        return "Claude settings not found (skipped)"
    backup(CLAUDE_SETTINGS)
    data = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    hooks = data.setdefault("hooks", {})
    command = f'"{LIGHT_HOOK}" --source claude'
    events = (
        "SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest",
        "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "SessionEnd",
    )
    added = 0
    for event in events:
        groups = hooks.setdefault(event, [])
        installed = any(
            hook.get("command") == command
            for group in groups
            for hook in group.get("hooks", [])
        )
        if installed:
            continue
        groups.append({
            "matcher": "*",
            "hooks": [{"type": "command", "command": command, "timeout": 1}],
        })
        added += 1
    CLAUDE_SETTINGS.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return f"Claude direct lifecycle hooks integrated ({added} added)"


def enable_codex_post_tool_relay() -> str:
    """Keep the already-trusted Coffee relay enabled for Codex PostToolUse.

    The Coffee relay forwards the same payload to agent-light. Some previous
    Coffee setups explicitly disabled only PostToolUse, which would otherwise
    hide tool-result failures from the red status mapping.
    """
    if not CODEX_CONFIG.exists():
        return "Codex config not found (skipped)"
    text = CODEX_CONFIG.read_text(encoding="utf-8")
    header = f'[hooks.state."{HOME}/.codex/hooks.json:post_tool_use:0:0"]'
    start = text.find(header)
    if start < 0:
        return "Codex trusted PostToolUse relay not found (skipped)"
    end = text.find("\n[", start + len(header))
    if end < 0:
        end = len(text)
    block = text[start:end]
    updated = block.replace("\nenabled = false", "")
    if updated == block:
        return "Codex PostToolUse relay already enabled"
    backup(CODEX_CONFIG)
    CODEX_CONFIG.write_text(text[:start] + updated + text[end:], encoding="utf-8")
    return "Codex PostToolUse relay enabled"


def main() -> int:
    for result in (
        patch_ping(),
        patch_coffee(),
        patch_claude_direct_hooks(),
        enable_codex_post_tool_relay(),
    ):
        print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
