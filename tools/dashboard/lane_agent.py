#!/usr/bin/env python3
"""Launch a CLI agent with an explicit dashboard lane and durable live log."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STATE_ROOT = Path.home() / ".local/state/portomatic/lane-workers"
SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{12,}"),
    re.compile(r"(?i)\bBearer\s+\S+"),
    re.compile(r"(?i)\b(?:OPENAI|ANTHROPIC)_API_KEY\s*[=:]\s*\S+"),
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def sanitize(value: str) -> str:
    text = value.replace("\x00", "").strip()
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("[redacted]", text)
    text = text.replace(str(Path.home()), "~")
    return text if len(text) <= 1000 else text[:997] + "..."


def visible_text(raw: str) -> str:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return sanitize(raw)
    item = payload.get("item") if isinstance(payload, dict) else None
    if isinstance(item, dict):
        for key in ("text", "aggregated_output", "formatted_output"):
            if item.get(key):
                return sanitize(str(item[key]))
        if item.get("type"):
            return sanitize(str(item["type"]).replace("_", " "))
    message = payload.get("message") if isinstance(payload, dict) else None
    if isinstance(message, str) and message.strip():
        return sanitize(message)
    error = payload.get("error") if isinstance(payload, dict) else None
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return sanitize(error["message"])
    if isinstance(message, dict):
        content = message.get("content")
        if isinstance(content, list):
            texts = [
                str(block.get("text"))
                for block in content
                if isinstance(block, dict) and block.get("text")
            ]
            if texts:
                return sanitize(" ".join(texts))
    for key in ("result", "text", "content", "type"):
        if isinstance(payload, dict) and payload.get(key):
            return sanitize(str(payload[key]))
    return sanitize(raw)


def goal_prompt(worktree: Path, goal: str) -> str:
    return (
        f"/goal {goal.strip()}\n\n"
        "Worker isolation contract: you may inspect other branches and worktrees, "
        f"but modify files only inside your assigned worktree {worktree}. "
        "Never copy generated evidence into another Git worktree. Use /tmp for "
        "cross-host transfers and scratch data, then add final artifacts only to "
        "your assigned worktree. For multi-step inspection, prefer simple separate "
        "commands or a temporary script over deeply nested shell quoting, command "
        "substitution, or inline cleanup; those patterns are error-prone and may be "
        "rejected by the execution safety layer. Make every critical verification "
        "fail fast: run it as its own command, or enable the shell's strict/error "
        "and pipeline-failure modes before a short command group. Never let a later "
        "successful command hide an earlier failure. Use task-specific shell "
        "variables such as lane_exit_code; never assign zsh's read-only status "
        "variable or shell environment variables such as HOME, home, PATH, or "
        "CODEX_HOME for scratch state. Search the assigned worktree "
        "and explicitly named inputs first; do not recursively scan a parent "
        "workspace, the user's home directory, or unrelated repositories unless the "
        "goal genuinely requires it. A quiet process is not a failed process; judge "
        "health from the live process and durable worker record. Do not launch a "
        "nested Codex, Claude, Cursor, x, c, or agent process yourself; report the "
        "need for another implementation or review worker so the orchestrator can "
        "launch it through this wrapper with its own visible lane record."
    )


def command_for(backend: str, worktree: Path, goal: str, extra: list[str]) -> list[str]:
    prompt = goal_prompt(worktree, goal)
    if backend == "x":
        executable = shutil.which("x") or shutil.which("codex")
        if not executable:
            raise SystemExit("x/codex is not installed")
        return [executable, "exec", "--json", "-C", str(worktree), *extra, prompt]
    if backend == "c":
        executable = shutil.which("claude")
        if not executable:
            raise SystemExit("claude is not installed")
        return [
            executable,
            "--dangerously-skip-permissions",
            "-p",
            "--verbose",
            "--output-format",
            "stream-json",
            *extra,
            prompt,
        ]
    executable = shutil.which("agent") or shutil.which("cursor-agent")
    if not executable:
        raise SystemExit("Cursor agent is not installed")
    return [
        executable,
        "-p",
        "--force",
        "--sandbox",
        "disabled",
        "--trust",
        "--output-format",
        "stream-json",
        "--workspace",
        str(worktree),
        *extra,
        prompt,
    ]


def persistent_launcher(
    script: Path,
    backend: str,
    worktree: Path,
    lane: str,
    goal: str,
    extra: list[str],
) -> list[str]:
    """Re-enter the wrapper without --detach inside a durable tmux pane."""
    command = [
        sys.executable,
        str(script),
        "--lane",
        lane,
        "--worktree",
        str(worktree),
        "--goal",
        goal,
        backend,
    ]
    if extra:
        command.extend(("--", *extra))
    return command


def atomic_write(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def process_is_running(pid: int) -> bool:
    """Return true only for a live, non-stopped, non-zombie process."""
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "state="], capture_output=True, text=True
    )
    state = result.stdout.strip()
    return result.returncode == 0 and bool(state) and not state.startswith(("T", "Z"))


def registered_worker_is_running(record: dict[str, Any]) -> bool:
    """Require both the agent child and the wrapper that owns its log stream."""
    pid = record.get("pid")
    if not isinstance(pid, int) or not process_is_running(pid):
        return False
    wrapper_pid = record.get("wrapper_pid")
    return not isinstance(wrapper_pid, int) or process_is_running(wrapper_pid)


def effective_lane_id(record: dict[str, Any]) -> str:
    """Correct legacy/misassigned lane IDs from an unambiguous worktree."""
    lane_id = str(record.get("lane_id", ""))
    worktree = str(record.get("worktree", ""))
    if lane_id == "xnu-inventory" and "xnu-suite-selection" in worktree:
        return "xnu-suite-selection"
    if lane_id == "xnu-verifier-repair":
        return "xnu-differential-verifier"
    return lane_id


def worker_records(root: Path = STATE_ROOT) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    if not root.is_dir():
        return records
    for path in root.glob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(record.get("lane_id"), str):
                continue
            record["lane_id"] = effective_lane_id(record)
            record["record_path"] = str(path)
            record["running"] = (
                record.get("state") == "running"
                and registered_worker_is_running(record)
            )
            records.append(record)
        except (OSError, json.JSONDecodeError, TypeError):
            continue
    return sorted(records, key=record_recency)


def record_recency(record: dict[str, Any]) -> str:
    """Order runs by their last observed event, not merely their launch time."""
    return max(
        str(record.get("started_at", "")),
        str(record.get("updated_at", "")),
        str(record.get("finished_at", "")),
    )


def latest_worker_records(
    records: list[dict[str, Any]], lane: str | None = None
) -> list[dict[str, Any]]:
    """Select one truthful current record per lane, preferring a live run."""
    by_lane: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        lane_id = str(record["lane_id"])
        if lane is None or lane_id == lane:
            by_lane.setdefault(lane_id, []).append(record)
    selected = []
    for lane_id, lane_records in by_lane.items():
        lane_records.sort(key=record_recency)
        live = [record for record in lane_records if record["running"]]
        selected.append((live or lane_records)[-1])
    return sorted(selected, key=lambda record: str(record["lane_id"]))


def status_command(argv: list[str]) -> int | None:
    """Handle registry inspection without disturbing the launch CLI."""
    if not argv or argv[0] not in {"list", "status"}:
        return None
    parser = argparse.ArgumentParser(
        prog=f"{Path(sys.argv[0]).name} {argv[0]}",
        description="Show dashboard-tracked CLI workers.",
    )
    parser.add_argument("lane", nargs="?" if argv[0] == "status" else "?", default=None)
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args(argv[1:])
    if argv[0] == "list" and args.lane is not None:
        parser.error("list does not accept a lane; use status LANE")
    selected = latest_worker_records(worker_records(), args.lane)
    if argv[0] == "status" and args.lane and not selected:
        print(f"no tracked worker for lane {args.lane}", file=sys.stderr)
        return 1
    if args.as_json:
        print(json.dumps(selected, ensure_ascii=False, indent=2))
        return 0
    if not selected:
        print("no tracked workers")
        return 0
    for record in selected:
        state = "running" if record["running"] else "stopped"
        detail = ""
        if not record["running"] and record.get("exit_code") is not None:
            detail = f" exit={record['exit_code']}"
        print(
            f"{record['lane_id']}  {state}{detail}  {record.get('backend', '?')}  "
            f"{record.get('worktree', '?')}  {record.get('updated_at', '?')}"
        )
    return 0


def main() -> int:
    status_result = status_command(sys.argv[1:])
    if status_result is not None:
        return status_result
    parser = argparse.ArgumentParser(
        description="Run x, Claude, or Cursor under a named dashboard lane."
    )
    parser.add_argument("backend", choices=("x", "c", "agent"))
    parser.add_argument("--lane", required=True)
    parser.add_argument("--worktree", type=Path, required=True)
    parser.add_argument("--goal", required=True)
    parser.add_argument(
        "--detach",
        action="store_true",
        help="run in a durable tmux session and return immediately",
    )
    parser.add_argument(
        "--session",
        help="tmux session name for --detach (generated when omitted)",
    )
    parser.add_argument("backend_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    worktree = args.worktree.expanduser().resolve()
    if not worktree.is_dir():
        raise SystemExit(f"worktree does not exist: {worktree}")
    extra = args.backend_args
    if extra[:1] == ["--"]:
        extra = extra[1:]
    if args.session and not args.detach:
        parser.error("--session requires --detach")
    if args.detach:
        tmux = shutil.which("tmux")
        if not tmux:
            raise SystemExit("tmux is required for --detach")
        safe_lane = re.sub(r"[^A-Za-z0-9_-]+", "-", args.lane).strip("-")
        session = args.session or (
            f"portomatic-{safe_lane}-{datetime.now().strftime('%Y%m%dT%H%M%S')}"
        )
        exists = subprocess.run(
            [tmux, "has-session", "-t", session],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if exists.returncode == 0:
            raise SystemExit(f"tmux session already exists: {session}")
        subprocess.run(
            [
                tmux,
                "new-session",
                "-d",
                "-s",
                session,
                *persistent_launcher(
                    Path(__file__).resolve(),
                    args.backend,
                    worktree,
                    args.lane,
                    args.goal,
                    extra,
                ),
            ],
            check=True,
        )
        print(f"started lane {args.lane} in tmux session {session}")
        return 0
    command = command_for(args.backend, worktree, args.goal, extra)
    STATE_ROOT.mkdir(parents=True, exist_ok=True)
    run_id = f"{datetime.now().strftime('%Y%m%dT%H%M%S')}-{uuid.uuid4().hex[:8]}"
    record_path = STATE_ROOT / f"{args.lane}.{run_id}.json"
    log_path = STATE_ROOT / f"{args.lane}.{run_id}.jsonl"
    started_at = utc_now()
    process = subprocess.Popen(
        command,
        cwd=worktree,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    state: dict[str, Any] = {
        "schema_version": 1,
        "lane_id": args.lane,
        "goal": sanitize(args.goal),
        "backend": args.backend,
        "worktree": str(worktree),
        "pid": process.pid,
        "wrapper_pid": os.getpid(),
        "state": "running",
        "started_at": started_at,
        "updated_at": started_at,
        "log_path": str(log_path),
    }
    lock = threading.Lock()

    def event(stream: str, raw: str, text: str | None = None) -> None:
        timestamp = utc_now()
        payload = {
            "timestamp": timestamp,
            "stream": stream,
            "text": sanitize(text if text is not None else visible_text(raw)),
            "raw": sanitize(raw),
        }
        with lock:
            with log_path.open("a", encoding="utf-8") as output:
                output.write(json.dumps(payload, ensure_ascii=False) + "\n")
            state["updated_at"] = timestamp
            atomic_write(record_path, state)

    prompt = goal_prompt(worktree, args.goal)
    event("stdin", prompt, f"Goal: {args.goal} Isolation: write only in {worktree} or /tmp.")

    def pump(stream: Any, name: str, destination: Any) -> None:
        for line in iter(stream.readline, ""):
            destination.write(line)
            destination.flush()
            event(name, line.rstrip("\n"))
        stream.close()

    threads = [
        threading.Thread(target=pump, args=(process.stdout, "stdout", sys.stdout)),
        threading.Thread(target=pump, args=(process.stderr, "stderr", sys.stderr)),
    ]
    for thread in threads:
        thread.start()

    def stop(_signum: int, _frame: Any) -> None:
        if process.poll() is None:
            process.terminate()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    exit_code = process.wait()
    for thread in threads:
        thread.join()
    finished_at = utc_now()
    state.update(
        state="exited",
        exit_code=exit_code,
        finished_at=finished_at,
        updated_at=finished_at,
    )
    atomic_write(record_path, state)
    event("system", f"worker exited {exit_code}", f"Worker exited with status {exit_code}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
