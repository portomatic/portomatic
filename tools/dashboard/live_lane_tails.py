#!/usr/bin/env python3
"""Build the local Implementation v0 dashboard from authoritative inputs."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from render_dashboard_snapshots import encoded_snapshot, write_snapshot
from xnu_native_progress import read_progress as read_xnu_native_progress


SESSION_ROOT = Path.home() / ".codex" / "sessions"
CLAUDE_PROJECTS_ROOT = Path.home() / ".claude" / "projects"
CURSOR_PROJECTS_ROOT = Path.home() / ".cursor" / "projects"
LANE_WORKER_ROOT = Path.home() / ".local/state/portomatic/lane-workers"
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
WORKDIR = re.compile(r"(?:^|\s)-C\s+(?:\"([^\"]+)\"|'([^']+)'|(\S+))")
CURSOR_WORKDIR = re.compile(
    r"(?:^|\s)--workspace\s+(?:\"([^\"]+)\"|'([^']+)'|(\S+))"
)
REVIEW_WORKTREE = re.compile(r"^portomatic-review-pr(\d+)(?:-|$)", re.IGNORECASE)
REVIEW_COMMAND = re.compile(
    r"\b(?:independently\s+)?review(?:ing)?(?:\s+\w+){0,5}\s+"
    r"(?:PR|pull\s+request)\s*#?\s*(\d+)\b",
    re.IGNORECASE,
)
IMPLEMENTATION_COMMAND = re.compile(
    r"\bresume\s+(?:failure-class\s+)?lane\s+"
    r"[A-Za-z0-9][A-Za-z0-9._/-]*\s+on\s+PR\s*#\s*(\d+)\b",
    re.IGNORECASE,
)
CODEX_EXEC = re.compile(
    r"^(?:(?:\S*/)?node\s+)?(?:\S*/)?codex\s+exec(?:\s|$)",
)
CLAUDE_CLI = re.compile(r"^(?:\S*/)?claude(?:\s|$)")
CURSOR_AGENT = re.compile(r"^(?:\S*/)?cursor-agent(?:\s|$)")
CURSOR_PERSIST_CLIENT = re.compile(
    r"^(?:\S*/)?cursor-agent\s+persist\s+(?:list|attach|stop|help)\b"
)
CURSOR_PERSIST_RESTORE = re.compile(
    r"(?:^|\s)(?:\S*/)?node(?:\s+\S+)*\s+\S*index\.js\s+"
    r"--cursor-persist-restore\s+\S+\s+(\S+)"
)
PERSIST_CHROME = re.compile(
    r"(?i)(?:ctrl\+[cor]\b|tip:|goal active|add a follow-up|\bthinking\b|"
    r"lines hidden|use /mcp|to review|⎇|\broot\s*$|\b\d+(?:\.\d+)?k tokens\b|"
    r"^\d+ tasks?$)"
)
PERSIST_GOAL_ACTIVE = re.compile(
    r"(?m)(?:^\s*Goal active \(|ctrl\+c to stop\s*$|"
    r"^\s*[^\n]*\b(?:Working|Thinking|Grepping|Waiting|Running subagent)\b[^\n]*\btokens\s*$|"
    r"^\s*[^\n]*\bWaiting\b[^\n]*\bfor shell\s*$)"
)
PERSIST_AWAITING_INPUT = re.compile(
    r"(?im)(?:Enter next/submit|Esc to skip|Other: \(type to answer\)|"
    r"question \u00b7 Space select)"
)
SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{12,}"),
    re.compile(r"(?i)\bBearer\s+\S+"),
    re.compile(r"(?i)\b(?:OPENAI|ANTHROPIC)_API_KEY\s*[=:]\s*\S+"),
    re.compile(r"(?i)\btoken\s*[=:]\s*['\"]?[^\s'\"]{12,}"),
)
PULL_REQUEST_URL = re.compile(r"https://github\.com/[^/]+/[^/]+/pull/(\d+)")
SKIP_LINES = {
    "WARNING:",
    "To increase the performance of the tunnel, consider installing NumPy.",
    "For instructions,",
    "please see https://cloud.google.com/iap/docs/using-tcp-forwarding#increasing_the_tcp_upload_bandwidth",
}
WORKER_ACTIVITY_NOISE = re.compile(
    r"(?i)(?:"
    r"reading additional input from stdin|"
    r"rmcp::transport::worker: worker quit with fatal: .*AuthRequired|"
    r"rmcp::transport::common::client_side_sse: sse stream error|"
    r"failed to initialize MCP client during shutdown"
    r")"
)
SETUP_BRANCH_SUCCESSORS = {
    "codex/setup-c-cli-portable": ("codex/setup-c-cli-native-captures",),
}
CANONICAL_REF = "origin/codex/portomatic-runtime-v0"
CANONICAL_BRANCH = "codex/portomatic-runtime-v0"
SHARED_CACHE_CXX_BRANCHES = (
    "codex/dyld-real-startup-v2",
)
XNU_LANE_SPECS = (
    {
        "id": "xnu-inventory",
        "display_name": "XNU inventory",
        "evidence": "https://github.com/portomatic/portomatic/pull/123",
        "branch": "codex/xnu-darwintest-harness",
        "worker_branches": (),
        "worker_worktrees": (),
        "evidence_state": "implementing",
        "priority": 10,
    },
    {
        "id": "xnu-suite-selection",
        "display_name": "XNU suite selection",
        "evidence": "https://github.com/portomatic/portomatic/pull/125",
        "branch": "codex/xnu-suite-selection",
        "worker_branches": (),
        "worker_worktrees": ("portomatic-xnu-suite-selection-rebase-review",),
        "evidence_state": "implementing",
        "priority": 11,
    },
    {
        "id": "xnu-differential-verifier",
        "display_name": "XNU differential verifier",
        "evidence": "https://github.com/portomatic/portomatic/pull/124",
        "branch": "codex/xnu-build-private-headers",
        "worker_branches": (
            "codex/xnu-build-ipc-generated",
            "codex/xnu-build-framework-longtail",
            "codex/xnu-build-compile-defs",
            "codex/xnu-build-coverage",
            "codex/xnu-pr124-final-repair",
        ),
        "worker_worktrees": (
            "portomatic-xnu-build-compile-defs-review",
            "portomatic-xnu-build-coverage-repair-review",
            "portomatic-xnu-pr124-final-repair",
        ),
        "evidence_state": "implementing",
        "priority": 12,
    },
)
RUNTIME_GATE_CHECKS = {
    "Coordination provenance",
    "Runtime host and ARM64 checks",
    "Required corpus gate aggregate (GCP ARM64)",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sanitize(value: str) -> str:
    text = ANSI.sub("", value).replace("\x00", "").strip()
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("[redacted]", text)
    text = text.replace(str(Path.home()), "~")
    text = re.sub(r"\s+", " ", text)
    return text if len(text) <= 260 else text[:257] + "..."


def process_workdir(pid: int) -> Path | None:
    result = subprocess.run(
        ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    for line in result.stdout.splitlines():
        if line.startswith("n/"):
            return Path(line[1:]).resolve()
    return None


def persist_restore_command(command: str) -> bool:
    return bool(CURSOR_PERSIST_RESTORE.search(command))


def persist_session_name(command: str) -> str | None:
    match = CURSOR_PERSIST_RESTORE.search(command)
    return match.group(1) if match else None


def tmux_session_paths(session_table: str | None = None) -> dict[str, Path]:
    live_query = session_table is None
    if session_table is None:
        result = subprocess.run(
            [
                "tmux",
                "-L",
                "cursor-agent",
                "list-sessions",
                "-F",
                "#{session_name}\t#{session_path}",
            ],
            capture_output=True,
            text=True,
        )
        session_table = result.stdout if result.returncode == 0 else ""
    paths: dict[str, Path] = {}
    for line in session_table.splitlines():
        name, separator, path = line.partition("\t")
        if separator and path:
            paths[name] = Path(path).resolve()
    if live_query:
        paths = {
            name: path
            for name, path in paths.items()
            if persist_session_is_active(capture_tmux_pane(name, lines=16))
        }
    return paths


def persist_session_is_active(pane: str) -> bool:
    """A persist process survives completion; only its active goal is a worker."""
    return not PERSIST_AWAITING_INPUT.search(pane) and bool(
        PERSIST_GOAL_ACTIVE.search(pane)
    )


def persist_workdir(
    command: str,
    pid: int,
    cwd_for_pid: Callable[[int], Path | None],
    session_paths: dict[str, Path],
) -> Path | None:
    return (
        command_workdir(command)
        or cwd_for_pid(pid)
        or session_paths.get(persist_session_name(command) or "")
    )


def worker_command(command: str) -> bool:
    if CURSOR_PERSIST_CLIENT.match(command):
        return False
    return bool(
        CODEX_EXEC.match(command)
        or CLAUDE_CLI.match(command)
        or persist_restore_command(command)
        or CURSOR_AGENT.match(command)
    )


def command_workdir(command: str) -> Path | None:
    match = (
        WORKDIR.search(command)
        if CODEX_EXEC.match(command)
        else CURSOR_WORKDIR.search(command)
        if CURSOR_AGENT.match(command)
        else None
    )
    if not match:
        return None
    return Path(next(value for value in match.groups() if value)).resolve()


def review_pr_for_worker(command: str, workdir: Path) -> int | None:
    if not CODEX_EXEC.match(command):
        return None
    worktree_match = REVIEW_WORKTREE.match(workdir.name)
    if worktree_match:
        return int(worktree_match.group(1))
    command_match = REVIEW_COMMAND.search(command) or IMPLEMENTATION_COMMAND.search(
        command
    )
    return int(command_match.group(1)) if command_match else None


def running_workers(
    process_table: str | None = None,
    cwd_for_pid: Callable[[int], Path | None] = process_workdir,
    session_paths: dict[str, Path] | None = None,
) -> dict[Path, int | None]:
    """Return one entry per live worker worktree and its attached PR, if any."""
    session_paths_are_authoritative = session_paths is not None
    if process_table is None:
        process_table = subprocess.run(
            ["ps", "-axo", "pid=,state=,command="],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        if session_paths is None:
            session_paths = tmux_session_paths()
        session_paths_are_authoritative = True
    if session_paths is None:
        session_paths = {}
    workers: dict[Path, int | None] = {}
    for process in process_table.splitlines():
        fields = process.strip().split(maxsplit=2)
        if len(fields) != 3:
            continue
        pid_text, state, command = fields
        if state.startswith(("T", "Z")) or not worker_command(command):
            continue
        if persist_restore_command(command) and session_paths_are_authoritative:
            if persist_session_name(command) not in session_paths:
                continue
        # A launcher commonly retains its own cwd even when the worker was
        # explicitly aimed at another worktree. The CLI target is authoritative.
        # Persist restore processes have no --workspace flag; fall back to the
        # process cwd, then the managed tmux session path.
        workdir = persist_workdir(
            command, int(pid_text), cwd_for_pid, session_paths
        )
        if not workdir:
            continue
        workdir = workdir.resolve()
        review_pr = review_pr_for_worker(command, workdir)
        previous = workers.get(workdir)
        if workdir not in workers or (previous is None and review_pr is not None):
            workers[workdir] = review_pr
    return workers


def running_workdirs(
    process_table: str | None = None,
    cwd_for_pid: Callable[[int], Path | None] = process_workdir,
    session_paths: dict[str, Path] | None = None,
) -> set[Path]:
    return set(running_workers(process_table, cwd_for_pid, session_paths))


def running_persist_sessions(
    process_table: str | None = None,
    cwd_for_pid: Callable[[int], Path | None] = process_workdir,
    session_paths: dict[str, Path] | None = None,
) -> dict[Path, str]:
    """Map each live persist-restore worktree to its tmux session name."""
    session_paths_are_authoritative = session_paths is not None
    if process_table is None:
        process_table = subprocess.run(
            ["ps", "-axo", "pid=,state=,command="],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        if session_paths is None:
            session_paths = tmux_session_paths()
        session_paths_are_authoritative = True
    if session_paths is None:
        session_paths = {}
    sessions: dict[Path, str] = {}
    for process in process_table.splitlines():
        fields = process.strip().split(maxsplit=2)
        if len(fields) != 3:
            continue
        pid_text, state, command = fields
        if state.startswith(("T", "Z")) or not persist_restore_command(command):
            continue
        session = persist_session_name(command)
        if session_paths_are_authoritative and session not in session_paths:
            continue
        workdir = persist_workdir(
            command, int(pid_text), cwd_for_pid, session_paths
        )
        if not session or not workdir:
            continue
        sessions[workdir.resolve()] = session
    return sessions


def tmux_capture_command(session: str, lines: int = 80) -> list[str]:
    # Read-only pane dump. Never attach, restart, respawn, or send keys.
    return [
        "tmux",
        "-L",
        "cursor-agent",
        "capture-pane",
        "-p",
        "-J",
        "-t",
        f"{session}:0",
        "-S",
        f"-{lines}",
    ]


def capture_tmux_pane(session: str, lines: int = 80) -> str:
    result = subprocess.run(
        tmux_capture_command(session, lines),
        capture_output=True,
        text=True,
    )
    return result.stdout if result.returncode == 0 else ""


def persist_output_lines(raw: str, timestamp: str | None = None) -> list[dict[str, str]]:
    stamped = timestamp or utc_now()
    selected: list[str] = []
    for raw_line in raw.splitlines():
        text = sanitize(raw_line)
        if (
            not text
            or text in SKIP_LINES
            or len(text) < 4
            or not re.search(r"[A-Za-z0-9]", text)
            or PERSIST_CHROME.search(text)
            or re.fullmatch(r"[0-9a-f]{7,40}", text)
        ):
            continue
        selected.append(text)
    return [{"timestamp": stamped, "text": line} for line in selected[-4:]]


def running_claude_agents() -> dict[Path, str]:
    result = subprocess.run(
        ["claude", "agents", "--json"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {}
    try:
        agents = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}
    if not isinstance(agents, list):
        return {}
    running: dict[Path, str] = {}
    for agent in agents:
        if not isinstance(agent, dict) or not isinstance(agent.get("cwd"), str):
            continue
        workdir = Path(agent["cwd"]).resolve()
        if agent.get("state") == "working" and isinstance(agent.get("id"), str):
            # Managed background agents expose both a short control id and the
            # persisted transcript session id.  The terminal-oriented
            # `claude logs` view contains cursor redraws and spinner text;
            # prefer the structured JSONL transcript for dashboard activity.
            session_id = agent.get("sessionId")
            running[workdir] = (
                f"managed:{agent['id']}:{session_id}"
                if isinstance(session_id, str)
                else agent["id"]
            )
        elif (
            agent.get("kind") == "interactive"
            and isinstance(agent.get("sessionId"), str)
        ):
            # Direct `claude -p` sessions are visible in the process table but
            # do not have a managed-agent id. Keep their transcript identity;
            # build_dashboard only attaches it when that worktree is active.
            running[workdir] = f"session:{agent['sessionId']}"
    return running


def latest_claude_transcript(workdir: Path) -> Path | None:
    project_name = "-" + str(workdir.resolve()).lstrip("/").replace("/", "-")
    project = CLAUDE_PROJECTS_ROOT / project_name
    if not project.is_dir():
        return None
    candidates = sorted(
        project.glob("*.jsonl"),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )
    return candidates[0] if candidates else None


def latest_cursor_transcript(workdir: Path) -> Path | None:
    project_name = str(workdir.resolve()).lstrip("/").replace("/", "-")
    project = CURSOR_PROJECTS_ROOT / project_name / "agent-transcripts"
    if not project.is_dir():
        return None
    candidates = sorted(
        project.glob("*/*.jsonl"),
        key=lambda path: path.stat().st_mtime_ns,
        reverse=True,
    )
    return candidates[0] if candidates else None


def latest_worker_transcript(workdir: Path) -> Path | None:
    candidates = [
        path
        for path in (
            latest_claude_transcript(workdir),
            latest_cursor_transcript(workdir),
        )
        if path is not None
    ]
    return max(candidates, key=lambda path: path.stat().st_mtime_ns) if candidates else None


def branch_for(workdir: Path) -> str | None:
    dot_git = workdir / ".git"
    try:
        if dot_git.is_file():
            marker = dot_git.read_text(encoding="utf-8").strip()
            if not marker.startswith("gitdir: "):
                return None
            git_dir = Path(marker.removeprefix("gitdir: "))
            if not git_dir.is_absolute():
                git_dir = (workdir / git_dir).resolve()
        else:
            git_dir = dot_git
        head = (git_dir / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    prefix = "ref: refs/heads/"
    return head.removeprefix(prefix) if head.startswith(prefix) else None


def known_workdirs(repository: Path) -> set[Path]:
    result = subprocess.run(
        ["git", "-C", str(repository), "worktree", "list", "--porcelain"],
        check=True,
        capture_output=True,
        text=True,
    )
    return {
        Path(line.removeprefix("worktree ")).resolve()
        for line in result.stdout.splitlines()
        if line.startswith("worktree ")
    }


def worktree_branch(workdir: Path) -> str | None:
    result = subprocess.run(
        ["git", "-C", str(workdir), "branch", "--show-current"],
        capture_output=True,
        text=True,
    )
    branch = result.stdout.strip()
    return branch if result.returncode == 0 and branch else None


def worktree_head(workdir: Path) -> str | None:
    result = subprocess.run(
        ["git", "-C", str(workdir), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
    )
    head = result.stdout.strip()
    return head if result.returncode == 0 and re.fullmatch(r"[0-9a-f]{40}", head) else None


def git_toplevel(path: Path) -> Path | None:
    result = subprocess.run(
        ["git", "-C", str(path), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
    )
    return Path(result.stdout.strip()).resolve() if result.returncode == 0 else None


def lane_workdir(
    branch: str,
    branch_workdirs: dict[str, Path],
    active_workdirs: set[Path],
) -> Path | None:
    exact = branch_workdirs.get(branch)
    if exact in active_workdirs:
        return exact
    versioned = [
        workdir
        for actual_branch, workdir in branch_workdirs.items()
        if actual_branch.startswith(branch + "-") and workdir in active_workdirs
    ]
    if len(versioned) == 1:
        return versioned[0]
    return exact


def setup_workdir(
    branch: str,
    branch_workdirs: dict[str, Path],
    active_workdirs: set[Path],
) -> Path | None:
    for candidate in (branch, *SETUP_BRANCH_SUCCESSORS.get(branch, ())):
        workdir = lane_workdir(candidate, branch_workdirs, active_workdirs)
        if workdir in active_workdirs:
            return workdir
    return lane_workdir(branch, branch_workdirs, active_workdirs)


def recent_sessions(max_age_seconds: int = 86400) -> list[Path]:
    cutoff = time.time() - max_age_seconds
    if not SESSION_ROOT.is_dir():
        return []
    return sorted(
        (
            path
            for path in SESSION_ROOT.glob("*/*/*/*.jsonl")
            if path.stat().st_mtime >= cutoff
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )


def session_cwd(path: Path) -> Path | None:
    try:
        with path.open(encoding="utf-8") as stream:
            record = json.loads(stream.readline())
        cwd = record.get("payload", {}).get("cwd")
        return Path(cwd).resolve() if cwd else None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def session_by_workdir(workdirs: set[Path]) -> dict[Path, Path]:
    remaining = set(workdirs)
    selected: dict[Path, Path] = {}
    for path in recent_sessions():
        cwd = session_cwd(path)
        if cwd in remaining:
            selected[cwd] = path
            remaining.remove(cwd)
            if not remaining:
                break
    return selected


def tail_records(
    path: Path,
    byte_limit: int = 16 * 1024 * 1024,
    max_records: int = 400,
) -> list[dict[str, Any]]:
    try:
        with path.open("rb") as stream:
            size = stream.seek(0, os.SEEK_END)
            offset = max(0, size - byte_limit)
            stream.seek(offset)
            if offset:
                stream.readline()
            raw_lines = stream.read().splitlines()[-max_records:]
    except OSError:
        return []
    records = []
    for raw in raw_lines:
        try:
            records.append(json.loads(raw))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    return records


def agent_message(item: dict[str, Any]) -> str | None:
    parts = [
        str(part.get("text", ""))
        for part in item.get("content", [])
        if isinstance(part, dict) and part.get("type") == "Text"
    ]
    text = sanitize(" ".join(parts))
    return text or None


def command_text(item: dict[str, Any]) -> str:
    command = item.get("command", "")
    if isinstance(command, list):
        command = " ".join(str(part) for part in command)
    return str(command)


def command_label(item: dict[str, Any]) -> str:
    command = command_text(item)
    gate = re.search(r"(?:^|/)(run_[A-Za-z0-9_-]+_gate\.sh)\b", command)
    if gate:
        label = f"Ran {gate.group(1).removeprefix('run_').removesuffix('_gate.sh')} gate"
    elif "cargo test" in command:
        label = "Ran Rust tests"
    elif "cargo clippy" in command:
        label = "Ran Rust lint"
    elif "gcloud storage cp" in command:
        label = "Uploaded verification evidence"
    elif re.search(r"\bgit\s+rebase\b", command):
        label = "Rebased the lane"
    elif re.search(r"\bgit\s+push\b", command):
        label = "Pushed the lane branch"
    elif re.search(r"\bgh\s+pr\s+", command):
        label = "Checked the pull request"
    elif "runtime/coordination/render" in command:
        label = "Refreshed the coordination tracker"
    elif re.search(r"\b(?:qualify|qualification)[A-Za-z0-9_.-]*\b", command):
        label = "Ran corpus qualification"
    elif re.search(r"\bgit\s+status\b", command):
        label = "Checked the lane worktree"
    else:
        shell = command
        if len(item.get("command", [])) >= 3 and isinstance(item.get("command"), list):
            shell = str(item["command"][-1])
        label = f"Ran {sanitize(shell)}"
    if item.get("status") == "failed":
        return f"Failed: {label.removeprefix('Ran ')}"
    return label


def command_output(item: dict[str, Any]) -> str | None:
    output = item.get("formatted_output") or item.get("aggregated_output") or ""
    candidates = []
    for raw_line in reversed(str(output).splitlines()):
        text = sanitize(raw_line)
        if (
            not text
            or text in SKIP_LINES
            or len(text) < 4
            or not re.search(r"[A-Za-z0-9]", text)
            or text.startswith(("diff --git ", "index ", "@@ ", "+++ ", "--- "))
        ):
            continue
        candidates.append(text)
    if not candidates:
        return None
    priority = re.compile(
        r"(?i)(?:\bpass(?:ed|ing)?\b|\bfail(?:ed|ure|ing)?\b|\bsuccess\b|"
        r"\berror\b|\bexit\b|\bresult\b|\bgate\b|\btest\b|\bmergeable\b|"
        r"\b[0-9]+/[0-9]+\b)"
    )
    return next((line for line in candidates if priority.search(line)), candidates[0])


def file_change_message(item: dict[str, Any]) -> str | None:
    paths = [Path(path).name for path in item.get("changes", {})]
    if not paths:
        return None
    visible = ", ".join(paths[:3])
    suffix = f" and {len(paths) - 3} more" if len(paths) > 3 else ""
    return sanitize(f"Updated {visible}{suffix}")


def output_lines(path: Path) -> tuple[list[dict[str, str]], str | None]:
    events: list[dict[str, str]] = []
    last_event = None
    for record in tail_records(path):
        payload = record.get("payload", {})
        if record.get("type") != "event_msg" or payload.get("type") != "item_completed":
            continue
        item = payload.get("item", {})
        timestamp = record.get("timestamp")
        if not timestamp:
            continue
        item_type = item.get("type")
        text = None
        kind = "work"
        if item_type == "AgentMessage":
            text = agent_message(item)
            kind = "update"
        elif item_type == "CommandExecution":
            label = command_label(item)
            output = command_output(item)
            text = f"{label}: {output}" if output else label
            kind = "command"
        elif item_type == "FileChange":
            text = file_change_message(item)
        if not text:
            continue
        last_event = timestamp
        events.append({"timestamp": timestamp, "text": sanitize(text), "kind": kind})

    # Keep the stream compact but useful: always retain recent agent updates,
    # then fill the four-line view with the newest concrete work events.
    messages = [event for event in events if event["kind"] == "update"][-2:]
    selected_ids = {id(event) for event in messages}
    selected = list(messages)
    for event in reversed(events):
        if id(event) in selected_ids:
            continue
        selected.append(event)
        if len(selected) == 4:
            break
    selected.sort(key=lambda event: event["timestamp"])
    return [
        {"timestamp": event["timestamp"], "text": event["text"]}
        for event in selected[-4:]
    ], last_event


class TailCache:
    def __init__(self) -> None:
        self._cache: dict[Path, tuple[int, int, list[dict[str, str]], str | None]] = {}

    def read(self, path: Path) -> tuple[list[dict[str, str]], str | None]:
        stat = path.stat()
        key = (stat.st_mtime_ns, stat.st_size)
        cached = self._cache.get(path)
        if cached and cached[:2] == key:
            return cached[2], cached[3]
        lines, last_event = output_lines(path)
        self._cache[path] = (key[0], key[1], lines, last_event)
        return lines, last_event


class ClaudeLogCache:
    def __init__(self) -> None:
        self._cache: dict[str, tuple[str, list[dict[str, str]], str | None]] = {}
        self._transcript_paths: dict[str, Path | None] = {}

    def transcript_path(self, session_id: str) -> Path | None:
        if session_id in self._transcript_paths:
            return self._transcript_paths[session_id]
        matches = list(CLAUDE_PROJECTS_ROOT.glob(f"*/{session_id}.jsonl"))
        path = matches[0] if len(matches) == 1 else None
        self._transcript_paths[session_id] = path
        return path

    def read_file(self, path: Path) -> tuple[list[dict[str, str]], str | None]:
        if not path.is_file():
            return [], None
        stat = path.stat()
        fingerprint = f"{stat.st_mtime_ns}:{stat.st_size}"
        cache_key = f"file:{path}"
        cached = self._cache.get(cache_key)
        if cached and cached[0] == fingerprint:
            return cached[1], cached[2]
        events = []
        fallback_timestamp = datetime.fromtimestamp(
            stat.st_mtime, timezone.utc
        ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        for record in tail_records(path, max_records=4000):
            role = record.get("role") or record.get("type")
            if role != "assistant":
                continue
            timestamp = record.get("timestamp") or fallback_timestamp
            content = record.get("message", {}).get("content", [])
            for item in content if isinstance(content, list) else []:
                if not isinstance(item, dict):
                    continue
                kind = item.get("type")
                if kind == "text":
                    message = sanitize(str(item.get("text", "")))
                elif kind == "tool_use":
                    inputs = item.get("input", {})
                    description = inputs.get("description") if isinstance(inputs, dict) else None
                    command = inputs.get("command") if isinstance(inputs, dict) else None
                    detail = description or command or item.get("name", "work")
                    message = sanitize(f"Running {detail}")
                else:
                    continue
                if message:
                    events.append(
                        {"timestamp": timestamp, "text": message}
                    )
        lines = events[-4:]
        last_event = lines[-1]["timestamp"] if lines else (cached[2] if cached else None)
        if not lines and cached:
            lines = cached[1]
        self._cache[cache_key] = (fingerprint, lines, last_event)
        return lines, last_event

    def read_transcript(
        self, session_id: str
    ) -> tuple[list[dict[str, str]], str | None]:
        path = self.transcript_path(session_id)
        return self.read_file(path) if path is not None else ([], None)

    def read(self, agent_id: str) -> tuple[list[dict[str, str]], str | None]:
        if agent_id.startswith("file:"):
            path = Path(agent_id.removeprefix("file:"))
            return self.read_file(path)
        if agent_id.startswith("session:"):
            return self.read_transcript(agent_id.removeprefix("session:"))
        if agent_id.startswith("managed:"):
            _, control_id, session_id = agent_id.split(":", 2)
            lines, last_event = self.read_transcript(session_id)
            if lines:
                return lines, last_event
            agent_id = control_id
        result = subprocess.run(
            ["claude", "logs", agent_id],
            capture_output=True,
            text=True,
        )
        raw = result.stdout if result.returncode == 0 else ""
        cached = self._cache.get(agent_id)
        if cached and cached[0] == raw:
            return cached[1], cached[2]
        candidates = []
        for raw_line in raw.splitlines():
            line = sanitize(raw_line)
            if (
                line
                and len(line) >= 4
                and re.search(r"[A-Za-z0-9]", line)
                and not line.startswith(("─", "╭", "╰", "│"))
            ):
                candidates.append(line)
        timestamp = utc_now()
        lines = [
            {"timestamp": timestamp, "text": line}
            for line in candidates[-4:]
        ]
        last_event = timestamp if lines else (cached[2] if cached else None)
        if not lines and cached:
            lines = cached[1]
        self._cache[agent_id] = (raw, lines, last_event)
        return lines, last_event


class PersistPaneCache:
    def __init__(
        self,
        capture: Callable[[str], str] = capture_tmux_pane,
    ) -> None:
        self._capture = capture
        self._cache: dict[str, tuple[str, list[dict[str, str]], str | None]] = {}

    def read(self, session: str) -> tuple[list[dict[str, str]], str | None]:
        raw = self._capture(session)
        cached = self._cache.get(session)
        if cached and cached[0] == raw:
            return cached[1], cached[2]
        timestamp = utc_now()
        lines = persist_output_lines(raw, timestamp)
        last_event = lines[-1]["timestamp"] if lines else (cached[2] if cached else None)
        if not lines and cached:
            lines = cached[1]
        self._cache[session] = (raw, lines, last_event)
        return lines, last_event


class PullRequestCache:
    def __init__(self, ttl_seconds: float = 30.0) -> None:
        self.ttl_seconds = ttl_seconds
        self._loaded_at: float | None = None
        self._pull_requests: list[dict[str, Any]] = []

    def read(self, repository: Path) -> list[dict[str, Any]]:
        now = time.monotonic()
        if self._loaded_at is not None and now - self._loaded_at < self.ttl_seconds:
            return self._pull_requests
        result = subprocess.run(
            [
                "gh",
                "pr",
                "list",
                "--state",
                "all",
                "--limit",
                "200",
                "--json",
                "number,url,headRefName,headRefOid,baseRefName,baseRefOid,state,mergeable,updatedAt,statusCheckRollup",
            ],
            cwd=repository,
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            try:
                pull_requests = json.loads(result.stdout)
            except json.JSONDecodeError:
                pull_requests = None
            if isinstance(pull_requests, list):
                self._pull_requests = pull_requests
        self._loaded_at = now
        return self._pull_requests


def pull_request_for_lane(
    lane: dict[str, Any],
    workdir: Path | None,
    pull_requests: list[dict[str, Any]],
) -> dict[str, Any] | None:
    evidence_match = PULL_REQUEST_URL.search(str(lane.get("evidence", "")))
    evidence_number = int(evidence_match.group(1)) if evidence_match else None

    actual_branch = (branch_for(workdir) or worktree_branch(workdir)) if workdir else None
    branches = list(dict.fromkeys(branch for branch in (actual_branch, lane.get("branch")) if branch))
    evidence_pr = next(
        (pull_request for pull_request in pull_requests if pull_request.get("number") == evidence_number),
        None,
    )
    if evidence_pr and evidence_pr.get("headRefName"):
        branches.append(evidence_pr["headRefName"])
    for branch in branches:
        matches = [
            pull_request
            for pull_request in pull_requests
            if pull_request.get("headRefName") == branch
            or str(pull_request.get("headRefName", "")).startswith(branch + "-")
        ]
        if not matches:
            continue
        return max(
            matches,
            key=lambda pull_request: (
                pull_request.get("state") == "OPEN",
                pull_request.get("updatedAt", ""),
                pull_request.get("number", 0),
            ),
        )

    candidate = lane.get("candidate")
    if candidate:
        return next(
            (
                pull_request
                for pull_request in pull_requests
                if pull_request.get("headRefOid") == candidate
            ),
            None,
        )

    return None


def pull_request_activity(pull_request: dict[str, Any] | None) -> dict[str, str] | None:
    if not pull_request or not pull_request.get("updatedAt"):
        return None
    number = pull_request.get("number")
    state = str(pull_request.get("state", "updated")).lower()
    return {
        "timestamp": pull_request["updatedAt"],
        "text": f"PR #{number} is {state}; this lane has no attached CLI activity stream.",
    }


def canonical_tracker(repository: Path, reference: str) -> tuple[dict[str, Any], str]:
    commit = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", reference],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    result = subprocess.run(
        [
            "git",
            "-C",
            str(repository),
            "show",
            f"{reference}:runtime/coordination/tracker.json",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout), commit


def refresh_reference(repository: Path) -> None:
    subprocess.run(
        ["git", "-C", str(repository), "fetch", "--quiet", "origin", CANONICAL_BRANCH],
        capture_output=True,
        text=True,
    )


def compact_pull_request(pull_request: dict[str, Any] | None) -> dict[str, Any] | None:
    if not pull_request:
        return None
    checks_by_name = {
        check.get("name"): check
        for check in pull_request.get("statusCheckRollup") or []
        if check.get("name") in RUNTIME_GATE_CHECKS
    }
    checks_green = set(checks_by_name) == RUNTIME_GATE_CHECKS and all(
        check.get("status") == "COMPLETED"
        and check.get("conclusion") in {"SUCCESS", "NEUTRAL", "SKIPPED"}
        for check in checks_by_name.values()
    )
    return {
        "number": pull_request.get("number"),
        "url": pull_request.get("url"),
        "state": pull_request.get("state"),
        "mergeable": pull_request.get("mergeable"),
        "head": pull_request.get("headRefOid"),
        "base": pull_request.get("baseRefOid"),
        "checks_green": checks_green,
    }


def delivery_state(pull_request: dict[str, Any] | None) -> str:
    if not pull_request:
        return "no_pr"
    if pull_request.get("state") == "MERGED":
        return "merged"
    if pull_request.get("state") == "OPEN" and pull_request.get("mergeable") == "CONFLICTING":
        return "conflicting"
    return "open" if pull_request.get("state") == "OPEN" else "closed"


def evidence_state(
    stored_status: str,
    pull_request: dict[str, Any] | None,
    source_commit: str,
) -> str:
    if (
        pull_request
        and pull_request.get("state") == "OPEN"
        and pull_request.get("baseRefOid") == source_commit
        and compact_pull_request(pull_request)["checks_green"]
    ):
        return "regression_green"
    return stored_status if stored_status != "merged" else "regression_green"


def select_workdir(
    branches: list[str],
    branch_workdirs: dict[str, Path],
    active_workdirs: set[Path],
) -> Path | None:
    candidates = [
        lane_workdir(branch, branch_workdirs, active_workdirs)
        for branch in branches
        if branch
    ]
    return next((path for path in candidates if path in active_workdirs), None) or next(
        (path for path in candidates if path),
        None,
    )


def named_workdir(
    names: list[str],
    active_workdirs: set[Path],
) -> Path | None:
    slugs = []
    for name in names:
        if not name:
            continue
        slug = name.rsplit("/", 1)[-1]
        slugs.append(slug)
        if slug.startswith("fc-"):
            slugs.append(slug.removeprefix("fc-"))
        if slug.startswith("codex-fc-"):
            slugs.append(slug.removeprefix("codex-fc-"))
    matches: list[Path] = []
    for workdir in active_workdirs:
        worktree = workdir.name
        bare = worktree.removesuffix("-resume")
        if any(worktree == slug or bare == slug for slug in slugs):
            matches.append(workdir)
    unique = list(dict.fromkeys(matches))
    return unique[0] if len(unique) == 1 else None


def activity_for_lane(
    lane: dict[str, Any],
    pull_request: dict[str, Any] | None,
    branch_workdirs: dict[str, Path],
    active_workdirs: set[Path],
    sessions: dict[Path, Path],
    claude_by_toplevel: dict[Path, str],
    cache: TailCache,
    claude_cache: ClaudeLogCache,
    review_workdir: Path | None = None,
    persist_by_toplevel: dict[Path, str] | None = None,
    persist_cache: PersistPaneCache | None = None,
) -> tuple[bool, list[dict[str, str]], str | None]:
    branches = [
        str(pull_request.get("headRefName", "")) if pull_request else "",
        str(lane.get("branch", "")),
        *(str(branch) for branch in lane.get("worker_branches", [])),
    ]
    workdir = select_workdir(branches, branch_workdirs, active_workdirs)
    if workdir not in active_workdirs:
        named = named_workdir(
            [
                str(lane.get("id", "")),
                *branches,
                *(str(name) for name in lane.get("worker_worktrees", [])),
            ],
            active_workdirs,
        )
        if named is not None:
            workdir = named
    activity_workdir = review_workdir if review_workdir in active_workdirs else workdir
    session = sessions.get(activity_workdir) if activity_workdir else None
    persist_sessions = persist_by_toplevel or {}
    persist_session = persist_sessions.get(activity_workdir) if activity_workdir else None
    lines: list[dict[str, str]] = []
    last_event = None
    if persist_session and persist_cache:
        lines, last_event = persist_cache.read(persist_session)
    if not lines and session:
        lines, last_event = cache.read(session)
    if not lines and activity_workdir in claude_by_toplevel:
        lines, last_event = claude_cache.read(claude_by_toplevel[activity_workdir])
    if not lines and (fallback := pull_request_activity(pull_request)):
        lines = [fallback]
        last_event = fallback["timestamp"]
    return bool(
        workdir in active_workdirs or review_workdir in active_workdirs
    ), lines, last_event


def xnu_progress(
    workdirs: set[Path],
    selection_worktree: Path | None = None,
    build_worktree: Path | None = None,
    native_worktree: Path | None = None,
    repository: Path | None = None,
    build_ref: str | None = None,
    candidate_build_worktree: Path | None = None,
) -> dict[str, Any]:
    progress = {
        "source_sites": 1847,
        "suite_selected": 0,
        "selected": 0,
        "built": 0,
        "native_green": 0,
        "linux_exact": 0,
    }
    preferred_suite_selected: int | None = None
    preferred_build: tuple[int, int] | None = None
    preferred_native_green: int | None = None
    for workdir in workdirs:
        if not workdir.name.startswith("portomatic-xnu-"):
            continue
        corpus = workdir / "runtime/corpus/xnu-darwintest-boundary"
        inventory = corpus / "inventory-summary.json"
        try:
            counts = json.loads(inventory.read_text(encoding="utf-8"))["counts"]
            progress["source_sites"] = max(
                progress["source_sites"], int(counts.get("source_sites", 0))
            )
        except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
            pass
        try:
            suite = json.loads(
                (corpus / "suite-summary.json").read_text(encoding="utf-8")
            )
            progress["suite_selected"] = max(
                progress["suite_selected"],
                int(suite.get("profiles", {}).get("baseline", {}).get("selected", 0)),
            )
            if workdir == selection_worktree:
                preferred_suite_selected = int(
                    suite.get("profiles", {}).get("baseline", {}).get("selected", 0)
                )
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass
        for readiness_name in (
            "build-frontier-readiness.json",
            "native-green/build-readiness.json",
        ):
            try:
                summary = json.loads(
                    (corpus / readiness_name).read_text(encoding="utf-8")
                )["summary"]
                selected = int(summary.get("selected_cases", 0))
                built = int(summary.get("case_build_status", {}).get("built", 0))
                if selected >= progress["selected"]:
                    progress["selected"] = selected
                    progress["built"] = max(progress["built"], built)
                if workdir == build_worktree and readiness_name == "build-frontier-readiness.json":
                    preferred_build = (selected, built)
            except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
                pass
        try:
            eligibility = json.loads(
                (corpus / "native-green/eligibility.json").read_text(encoding="utf-8")
            )["summary"]
            progress["selected"] = max(
                progress["selected"],
                int(eligibility.get("baseline_selected_identities", 0)),
            )
            progress["native_green"] = max(
                progress["native_green"],
                int(eligibility.get("states", {}).get("eligible", 0)),
            )
            if workdir == native_worktree:
                preferred_native_green = int(
                    eligibility.get("states", {}).get("eligible", 0)
                )
        except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
            pass
    if preferred_suite_selected is not None:
        progress["suite_selected"] = preferred_suite_selected
    if preferred_build is not None:
        progress["selected"], progress["built"] = preferred_build
    build_sources = []
    if candidate_build_worktree is not None:
        candidate_head = worktree_head(candidate_build_worktree)
        if candidate_head:
            build_sources.append((candidate_build_worktree, candidate_head))
    if repository is not None and build_ref:
        build_sources.append((repository, build_ref))
    for build_repository, source_ref in build_sources:
        result = subprocess.run(
            [
                "git",
                "-C",
                str(build_repository),
                "show",
                f"{source_ref}:runtime/corpus/xnu-darwintest-boundary/build-frontier-readiness.json",
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            report = json.loads(result.stdout)
            summary = report["summary"]
            cases = report["cases"]
            selected = int(summary["selected_cases"])
            built = int(summary["case_build_status"]["built"])
            if (len(cases) != selected
                    or len({case["case_id"] for case in cases}) != selected
                    or sum(case["build_status"] == "built" for case in cases) != built):
                raise ValueError(f"XNU build summary disagrees with cases at {source_ref}")
            progress["selected"], progress["built"] = selected, built
            progress["build_source_ref"] = source_ref
            break
    if preferred_native_green is not None:
        progress["native_green"] = preferred_native_green
    return progress


from lane_agent import effective_lane_id, record_recency, registered_worker_is_running, visible_text


def lane_worker_records(
    root: Path = LANE_WORKER_ROOT,
) -> dict[str, list[dict[str, Any]]]:
    records: dict[str, list[dict[str, Any]]] = {}
    if not root.is_dir():
        return records
    for path in root.glob("*.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            lane_id = effective_lane_id(record)
            record["lane_id"] = lane_id
            record["record_path"] = str(path)
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            continue
        records.setdefault(lane_id, []).append(record)
    for lane_records in records.values():
        lane_records.sort(key=record_recency)
    return records


def lane_worker_activity(
    lane_id: str,
    records: dict[str, list[dict[str, Any]]],
) -> tuple[bool, bool, int, list[dict[str, str]], str | None, set[Path]]:
    lane_records = records.get(lane_id, [])
    if not lane_records:
        return False, False, 0, [], None, set()
    active = [
        record
        for record in lane_records
        if record.get("state") == "running"
        and registered_worker_is_running(record)
    ]
    selected_records = active or lane_records[-1:]
    selected = selected_records[-1]
    events = []
    for record in selected_records:
        log_path = record.get("log_path")
        if not isinstance(log_path, str):
            continue
        for event in tail_records(Path(log_path), max_records=80):
            timestamp = event.get("timestamp")
            text = event.get("text")
            if not (
                isinstance(timestamp, str)
                and isinstance(text, str)
                and text.strip()
            ):
                continue
            if text in {"error", "turn.failed"} and isinstance(event.get("raw"), str):
                text = visible_text(event["raw"])
            visible = sanitize(text)
            if WORKER_ACTIVITY_NOISE.search(visible):
                continue
            events.append({"timestamp": timestamp, "text": visible})
    events.sort(key=lambda event: event["timestamp"])
    workdirs = {
        Path(record["worktree"]).resolve()
        for record in active
        if isinstance(record.get("worktree"), str)
    }
    lines = events[-4:]
    last_event = lines[-1]["timestamp"] if lines else selected.get("updated_at")
    return True, bool(active), len(active), lines, last_event, workdirs


def prefer_registered_activity(
    lane_id: str,
    records: dict[str, list[dict[str, Any]]],
    detected_running: bool,
    detected_lines: list[dict[str, str]],
    detected_last_event: str | None,
) -> tuple[bool, list[dict[str, str]], str | None, int]:
    found, running, worker_count, lines, last_event, _workdirs = lane_worker_activity(
        lane_id, records
    )
    if not found:
        return detected_running, detected_lines, detected_last_event, int(detected_running)
    return (
        running,
        lines or detected_lines,
        last_event or detected_last_event,
        worker_count,
    )


def registered_worker_only_lanes(
    existing_lane_ids: set[str],
    records: dict[str, list[dict[str, Any]]],
    pull_requests: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Keep explicit tracked work visible after exit, until coordination adopts it."""
    lanes = []
    for lane_id in sorted(set(records) - existing_lane_ids):
        found, running, worker_count, lines, last_event, _workdirs = (
            lane_worker_activity(lane_id, records)
        )
        if not found:
            continue
        active_records = [
            record
            for record in records[lane_id]
            if record.get("state") == "running"
            and registered_worker_is_running(record)
        ]
        selected = (active_records or records[lane_id])[-1]
        if not running and not selected.get("goal"):
            # Ignore historical probes with no explicitly tracked objective.
            continue
        worktree_value = selected.get("worktree")
        worktree = Path(worktree_value) if isinstance(worktree_value, str) else None
        branch = branch_for(worktree) if worktree is not None else None
        lane_spec = {"branch": branch} if branch else {}
        pull_request = pull_request_for_lane(lane_spec, None, pull_requests)
        delivery = delivery_state(pull_request)
        goal = selected.get("goal")
        subsystem = (
            sanitize(goal)
            if isinstance(goal, str) and goal.strip()
            else "Tracked CLI agent"
        )
        if lane_id.startswith("metal-"):
            affected_repositories = ["Metal GPU"]
        elif lane_id.startswith("xnu-"):
            affected_repositories = ["XNU DarwinTests"]
        else:
            affected_repositories = ["Tracked work"]
        lanes.append(
            {
                "id": lane_id,
                "display_name": lane_id.replace("-", " ").capitalize(),
                "subsystem": subsystem,
                "affected_repositories": affected_repositories,
                "evidence_state": "implementing",
                "delivery_state": delivery,
                "worker_state": "running" if running else "stopped",
                "worker_count": worker_count,
                "worker_exit_code": selected.get("exit_code") if not running else None,
                "display_state": "merged" if delivery == "merged" else "implementing",
                "pr": compact_pull_request(pull_request),
                "activity": lines,
                "last_activity_at": last_event,
                "priority": 50,
            }
        )
    return lanes


def repository_row(corpus: dict[str, Any]) -> dict[str, Any]:
    selected_raw = corpus.get("expected_cases")
    selected = int(selected_raw) if selected_raw is not None else 0
    upstream = None
    native_green = selected if corpus.get("oracle_status") == "frozen" else None
    linux_exact = selected if corpus.get("qualification_status") == "passed" else None
    blocker = corpus.get("first_failure_class") or ""
    missing = []
    if corpus.get("artifact_status") != "verified":
        missing.append("artifact")
    if corpus.get("oracle_status") != "frozen":
        missing.append("native oracle")
    if corpus.get("gate_status") != "frozen":
        missing.append("Linux gate")
    if not blocker and missing:
        blocker = ", ".join(missing)
    elif not blocker and corpus.get("qualification_status") == "not_run":
        blocker = "qualification not run"
    if corpus["id"] == "xnu-darwintest-boundary":
        selected = int(corpus.get("enrolled_cases", 0))
        upstream = int(corpus.get("source_sites", 0))
        native_green = int(corpus.get("native_pass_cases", 0))
        linux_exact = int(corpus.get("portomatic_pass_cases", 0))
        blocker = "Executable total unknown; enrolled cases not run"
    return {
        "id": corpus["id"],
        "display_name": (
            "XNU DarwinTests"
            if corpus["id"] == "xnu-darwintest-boundary"
            else corpus["id"]
        ),
        "detail_url": None,
        "selected_cases": selected,
        "upstream_cases": upstream,
        "native_green_cases": native_green,
        "linux_exact_cases": linux_exact,
        "qualification_status": corpus.get("qualification_status", "not_run"),
        "blocker": blocker,
    }


def validate_payload(payload: dict[str, Any]) -> None:
    lanes = payload["lanes"]
    repositories = payload["repositories"]
    workers = payload.get("workers", [])
    lane_ids = [lane["id"] for lane in lanes]
    repository_ids = [repository["id"] for repository in repositories]
    if len(lane_ids) != len(set(lane_ids)):
        raise ValueError("dashboard contains duplicate lane ids")
    if len(repository_ids) != len(set(repository_ids)):
        raise ValueError("dashboard contains duplicate repository ids")
    if any(lane_id.startswith("xnu-stream-") for lane_id in lane_ids):
        raise ValueError("planned XNU streams must not appear as active lanes")
    summary = payload["summary"]
    expected = {
        "repositories_total": len(repositories),
        "repositories_qualified": sum(
            repository["qualification_status"] == "passed" for repository in repositories
        ),
        "lanes_total": len(lanes),
        "lanes_merged": sum(lane["display_state"] == "merged" for lane in lanes),
        "workers_running": len(workers),
    }
    if summary != expected:
        raise ValueError(f"dashboard summary disagrees with rows: {summary!r} != {expected!r}")


def check_output(output_path: Path, repository: Path, reference: str) -> bool:
    try:
        payload = json.loads(output_path.read_text(encoding="utf-8"))
        validate_payload(payload)
    except (OSError, json.JSONDecodeError, KeyError, ValueError) as error:
        print(f"invalid: {error}")
        return False
    current_commit = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", reference],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if payload.get("source", {}).get("commit") != current_commit:
        print("stale: canonical integration commit changed")
        return False
    generated = datetime.fromisoformat(payload["generated_at"].replace("Z", "+00:00"))
    if (datetime.now(timezone.utc) - generated).total_seconds() > 60:
        print("stale: dashboard is older than 60 seconds")
        return False
    snapshot = output_path.with_name("dashboard.snapshot.js")
    if not snapshot.exists() or snapshot.read_bytes() != encoded_snapshot(
        output_path,
        "__PORTOMATIC_DASHBOARD__",
    ):
        print("stale: dashboard snapshot disagrees with dashboard.json")
        return False
    print(f"up-to-date: {output_path}")
    return True


def build_dashboard(
    tracker: dict[str, Any],
    source_commit: str,
    output_path: Path,
    repository: Path,
    cache: TailCache,
    claude_cache: ClaudeLogCache,
    pull_request_cache: PullRequestCache,
    persist_cache: PersistPaneCache,
) -> None:
    claude_agents = running_claude_agents()
    process_table = subprocess.run(
        ["ps", "-axo", "pid=,state=,command="],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    session_paths = tmux_session_paths()
    workers_by_workdir = running_workers(process_table, session_paths=session_paths)
    registered_workers = lane_worker_records()
    registered_workdirs = set()
    for lane_id in registered_workers:
        _found, _running, _count, _lines, _last_event, workdirs = lane_worker_activity(
            lane_id, registered_workers
        )
        registered_workdirs.update(workdirs)
    persist_by_workdir = running_persist_sessions(
        process_table, session_paths=session_paths
    )
    process_workdirs = set(workers_by_workdir) | registered_workdirs
    repository_workdirs = known_workdirs(repository)
    active_workdirs = {
        top
        for process_workdir in process_workdirs
        | {
            workdir
            for workdir, identity in claude_agents.items()
            if not identity.startswith("session:")
        }
        if (top := git_toplevel(process_workdir)) is not None
        and top in repository_workdirs
    }
    claude_by_toplevel = {
        top: agent_id
        for workdir, agent_id in claude_agents.items()
        if (top := git_toplevel(workdir)) is not None
        and top in active_workdirs
    }
    for workdir in active_workdirs:
        if workdir in claude_by_toplevel:
            continue
        if transcript := latest_worker_transcript(workdir):
            claude_by_toplevel[workdir] = f"file:{transcript}"
    workdirs = repository_workdirs
    branch_workdirs = {}
    for workdir in workdirs:
        branch = branch_for(workdir) or worktree_branch(workdir)
        if branch:
            branch_workdirs[branch] = workdir
    sessions = session_by_workdir(set(branch_workdirs.values()) | active_workdirs)
    pull_requests = pull_request_cache.read(repository)
    review_workdirs: dict[int, Path] = {}
    for process_workdir, review_pr in workers_by_workdir.items():
        if review_pr is None:
            continue
        top = git_toplevel(process_workdir)
        if top in active_workdirs:
            review_workdirs.setdefault(review_pr, top)
    persist_by_toplevel = {
        top: session
        for workdir, session in persist_by_workdir.items()
        if (top := git_toplevel(workdir)) in active_workdirs
    }
    lanes = []
    for lane in tracker.get("lanes", []):
        pull_request = pull_request_for_lane(lane, None, pull_requests)
        running, lines, last_event = activity_for_lane(
            lane,
            pull_request,
            branch_workdirs,
            active_workdirs,
            sessions,
            claude_by_toplevel,
            cache,
            claude_cache,
            review_workdirs.get(pull_request.get("number")) if pull_request else None,
            persist_by_toplevel,
            persist_cache,
        )
        running, lines, last_event, worker_count = prefer_registered_activity(
            lane["id"], registered_workers, running, lines, last_event
        )
        evidence = evidence_state(lane["status"], pull_request, source_commit)
        delivery = delivery_state(pull_request)
        lanes.append(
            {
                "id": lane["id"],
                "display_name": lane.get("display_name", lane["id"]),
                "subsystem": lane["subsystem"],
                "affected_repositories": lane["affected_corpora"],
                "evidence_state": evidence,
                "delivery_state": delivery,
                "worker_state": "running" if running else "stopped",
                "worker_count": worker_count,
                "display_state": "merged" if delivery == "merged" else evidence,
                "pr": compact_pull_request(pull_request),
                "activity": lines,
                "last_activity_at": last_event,
                "priority": 100,
            }
        )
    acceptance_pr = next(
        (pull_request for pull_request in pull_requests if pull_request.get("number") == 108),
        None,
    )
    shared_cache_lane = {
        "branch": SHARED_CACHE_CXX_BRANCHES[0],
        "worker_branches": SHARED_CACHE_CXX_BRANCHES[1:],
    }
    shared_cache_pr = pull_request_for_lane(
        shared_cache_lane,
        None,
        pull_requests,
    )
    shared_cache_running, shared_cache_lines, shared_cache_last_event = activity_for_lane(
        shared_cache_lane,
        shared_cache_pr,
        branch_workdirs,
        active_workdirs,
        sessions,
        claude_by_toplevel,
        cache,
        claude_cache,
        persist_by_toplevel=persist_by_toplevel,
        persist_cache=persist_cache,
    )
    shared_cache_running, shared_cache_lines, shared_cache_last_event, shared_cache_worker_count = (
        prefer_registered_activity(
            "shared-cache-cxx",
            registered_workers,
            shared_cache_running,
            shared_cache_lines,
            shared_cache_last_event,
        )
    )
    lanes.insert(
        0,
        {
            "id": "shared-cache-cxx",
            "display_name": "Shared-cache C++",
            "subsystem": "dyld shared cache",
            "affected_repositories": ["C++ acceptance"],
            "evidence_state": "implementing",
            "delivery_state": delivery_state(shared_cache_pr),
            "worker_state": "running" if shared_cache_running else "stopped",
            "worker_count": shared_cache_worker_count,
            "display_state": (
                "merged"
                if delivery_state(shared_cache_pr) == "merged"
                else "implementing"
            ),
            "pr": compact_pull_request(shared_cache_pr),
            "reference_pr": compact_pull_request(acceptance_pr),
            "activity": shared_cache_lines,
            "last_activity_at": shared_cache_last_event,
            "priority": 0,
        },
    )
    native_records = registered_workers.get("xnu-differential-verifier", [])
    if not native_records:
        native_records = registered_workers.get("xnu-native-qualification", [])
    native_worktree = None
    for record in reversed(native_records):
        candidate = record.get("worktree")
        if isinstance(candidate, str):
            candidate_top = git_toplevel(Path(candidate))
            if candidate_top in workdirs:
                native_worktree = candidate_top
                break
    xnu = xnu_progress(
        workdirs,
        selection_worktree=branch_workdirs.get("codex/xnu-suite-selection"),
        build_worktree=branch_workdirs.get("codex/xnu-build-coverage-reproducible"),
        native_worktree=native_worktree,
        repository=repository,
        build_ref="codex/xnu-build-coverage-reproducible",
        candidate_build_worktree=native_worktree,
    )
    native_evidence = read_xnu_native_progress(repository)
    if native_evidence is not None:
        if native_evidence["selected_identities"] != xnu["selected"]:
            raise ValueError("XNU native evidence disagrees with tracked selection")
        xnu["built"] = native_evidence["build_states"]["built"]
        if native_evidence["frozen_gate_admitted"] != xnu["native_green"]:
            raise ValueError("XNU native evidence disagrees with frozen admission")
    xnu_subtitles = {
        "xnu-inventory": f'{xnu["source_sites"]:,} source sites accounted for',
        "xnu-suite-selection": (
            f'{xnu["suite_selected"]:,}/{xnu["source_sites"]:,} baseline selected'
        ),
        "xnu-differential-verifier": (
            f'{xnu["built"]:,}/{xnu["selected"]:,} compiled, '
            f'{xnu["native_green"]:,} admitted to gate, '
            f'{xnu["linux_exact"]:,}/{xnu["native_green"]:,} exact on ARM64 Linux'
        ),
    }
    for spec in reversed(XNU_LANE_SPECS):
        pull_request = pull_request_for_lane(spec, None, pull_requests)
        running, lines, last_event = activity_for_lane(
            spec,
            pull_request,
            branch_workdirs,
            active_workdirs,
            sessions,
            claude_by_toplevel,
            cache,
            claude_cache,
            review_workdir=(
                review_workdirs.get(pull_request.get("number"))
                if pull_request
                else None
            ),
            persist_by_toplevel=persist_by_toplevel,
            persist_cache=persist_cache,
        )
        running, lines, last_event, worker_count = prefer_registered_activity(
            spec["id"], registered_workers, running, lines, last_event
        )
        delivery = delivery_state(pull_request)
        evidence = str(spec["evidence_state"])
        lanes.insert(
            1,
            {
                "id": spec["id"],
                "display_name": spec["display_name"],
                "subsystem": xnu_subtitles[spec["id"]],
                "build_source_ref": xnu.get("build_source_ref"),
                "affected_repositories": ["XNU DarwinTests"],
                "evidence_state": evidence,
                "delivery_state": delivery,
                "worker_state": "running" if running else "stopped",
                "worker_count": worker_count,
                "display_state": "merged" if delivery == "merged" else evidence,
                "pr": compact_pull_request(pull_request),
                "activity": lines,
                "last_activity_at": last_event,
                "priority": spec["priority"],
            },
        )
    lanes.extend(
        registered_worker_only_lanes(
            {lane["id"] for lane in lanes}, registered_workers, pull_requests
        )
    )
    repositories = [repository_row(corpus) for corpus in tracker.get("corpora", [])]
    for row in repositories:
        if row["id"] != "xnu-darwintest-boundary":
            continue
        row.update(
            selected_cases=xnu["selected"],
            upstream_cases=xnu["source_sites"],
            native_green_cases=xnu["native_green"],
            linux_exact_cases=xnu["linux_exact"],
            blocker=(
                f'{xnu["selected"] - xnu["built"]:,} selected tests not compiled'
                if xnu["selected"] > xnu["built"]
                else "Linux exact comparison not run"
            ),
        )
        if native_evidence is not None:
            row["native_evidence"] = native_evidence
            row["compiled_cases"] = native_evidence["build_states"]["built"]
            row["blocker"] = (
                f'{native_evidence["build_states"]["prerequisite_unavailable"]} build prerequisites unavailable; '
                'Linux qualification incomplete'
            )
    workers = [
        {
            "worktree": workdir.name,
            "branch": branch_for(workdir) or worktree_branch(workdir),
        }
        for workdir in sorted(active_workdirs, key=str)
    ]
    payload = {
        "schema_version": 2,
        "generated_at": utc_now(),
        "source": {
            "ref": CANONICAL_REF,
            "commit": source_commit,
            "coordination_updated_through": tracker["updated_through"],
        },
        "summary": {
            "repositories_total": len(repositories),
            "repositories_qualified": sum(
                repository["qualification_status"] == "passed"
                for repository in repositories
            ),
            "lanes_total": len(lanes),
            "lanes_merged": sum(lane["display_state"] == "merged" for lane in lanes),
            "workers_running": len(workers),
        },
        "workers": workers,
        "lanes": lanes,
        "repositories": repositories,
    }
    validate_payload(payload)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_name(f".{output_path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        temporary.replace(output_path)
    finally:
        temporary.unlink(missing_ok=True)
    write_snapshot(
        output_path,
        output_path.with_name("dashboard.snapshot.js"),
        "__PORTOMATIC_DASHBOARD__",
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    repository = Path(__file__).resolve().parents[2]
    parser.add_argument(
        "--output",
        type=Path,
        default=repository / "docs" / "implementation-v0" / "dashboard.json",
    )
    parser.add_argument("--repository", type=Path, default=repository)
    parser.add_argument("--ref", default=CANONICAL_REF)
    parser.add_argument("--interval", type=float, default=3.0)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--no-fetch", action="store_true")
    args = parser.parse_args()
    repository = args.repository.resolve()
    if args.check:
        if not args.no_fetch:
            refresh_reference(repository)
        return 0 if check_output(args.output, repository, args.ref) else 1
    cache = TailCache()
    claude_cache = ClaudeLogCache()
    pull_request_cache = PullRequestCache()
    persist_cache = PersistPaneCache()
    last_refresh = 0.0
    while True:
        if not args.no_fetch and time.monotonic() - last_refresh >= 30:
            refresh_reference(repository)
            last_refresh = time.monotonic()
        tracker, source_commit = canonical_tracker(repository, args.ref)
        build_dashboard(
            tracker,
            source_commit,
            args.output,
            repository,
            cache,
            claude_cache,
            pull_request_cache,
            persist_cache,
        )
        if args.once:
            return 0
        time.sleep(max(1.0, args.interval))


if __name__ == "__main__":
    raise SystemExit(main())
