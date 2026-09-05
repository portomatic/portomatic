import unittest
import sys
import json
import tempfile
import subprocess
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lane_agent import (
    command_for,
    goal_prompt,
    latest_worker_records,
    persistent_launcher,
    record_recency,
    status_command,
    worker_records,
    visible_text,
)
from live_lane_tails import (
    CLAUDE_PROJECTS_ROOT,
    CURSOR_PROJECTS_ROOT,
    RUNTIME_GATE_CHECKS,
    ClaudeLogCache,
    PersistPaneCache,
    activity_for_lane,
    compact_pull_request,
    named_workdir,
    latest_claude_transcript,
    latest_cursor_transcript,
    lane_worker_activity,
    lane_worker_records,
    evidence_state,
    persist_output_lines,
    persist_session_is_active,
    persist_session_name,
    pull_request_for_lane,
    registered_worker_only_lanes,
    registered_worker_is_running,
    repository_row,
    review_pr_for_worker,
    running_persist_sessions,
    running_workers,
    running_workdirs,
    select_workdir,
    tmux_capture_command,
    validate_payload,
    worker_command,
    xnu_progress,
)


class DashboardTests(unittest.TestCase):
    def test_worker_errors_include_the_actual_reason(self) -> None:
        self.assertEqual(visible_text('{"type":"error","message":"service unavailable"}'),
                         "service unavailable")
        self.assertEqual(visible_text('{"type":"turn.failed","error":{"message":"service unavailable"}}'),
                         "service unavailable")

    def test_exited_explicit_worker_remains_visible_without_claiming_completion(self) -> None:
        for exit_code in (0, 1):
            with self.subTest(exit_code=exit_code):
                records = {"metal-review": [{
                    "lane_id": "metal-review", "state": "exited",
                    "goal": "Review the native Metal evidence", "exit_code": exit_code,
                }]}
                lanes = registered_worker_only_lanes(set(), records, [])
                self.assertEqual(len(lanes), 1)
                self.assertEqual(lanes[0]["worker_state"], "stopped")
                self.assertEqual(lanes[0]["worker_count"], 0)
                self.assertEqual(lanes[0]["worker_exit_code"], exit_code)
                self.assertEqual(lanes[0]["display_state"], "implementing")
                self.assertEqual(registered_worker_only_lanes({"metal-review"}, records, []), [])

    def test_exited_probe_without_goal_is_not_a_lane(self) -> None:
        self.assertEqual(registered_worker_only_lanes(set(), {
            "dummy": [{"lane_id": "dummy", "state": "exited", "exit_code": 0}]
        }, []), [])

    def test_lane_agent_prepends_goal_for_every_backend(self) -> None:
        worktree = Path("/tmp/portomatic-lane")
        for backend in ("x", "c", "agent"):
            with self.subTest(backend=backend):
                command = command_for(backend, worktree, "finish the verifier", [])
                self.assertEqual(
                    command[-1], goal_prompt(worktree, "finish the verifier")
                )
                self.assertIn("/goal finish the verifier", command[-1])
                self.assertIn("modify files only inside", command[-1])
                self.assertIn(str(worktree), command[-1])
                self.assertIn("prefer simple separate commands", command[-1])
                self.assertIn("execution safety layer", command[-1])
                self.assertIn("Never let a later successful command hide", command[-1])
                self.assertIn("do not recursively scan a parent", command[-1])
                self.assertIn("A quiet process is not a failed process", command[-1])
                self.assertIn("Do not launch a nested Codex", command[-1])
                self.assertIn("its own visible lane record", command[-1])

    def test_lane_agent_detached_launcher_preserves_backend_arguments(self) -> None:
        command = persistent_launcher(
            Path("/tmp/lane_agent.py"),
            "x",
            Path("/tmp/portomatic-lane"),
            "xnu-build-frontier",
            "finish the verifier",
            ["-o", "/tmp/final.md"],
        )
        self.assertEqual(
            command,
            [
                sys.executable,
                "/tmp/lane_agent.py",
                "--lane",
                "xnu-build-frontier",
                "--worktree",
                "/tmp/portomatic-lane",
                "--goal",
                "finish the verifier",
                "x",
                "--",
                "-o",
                "/tmp/final.md",
            ],
        )

    def test_lane_agent_status_prefers_live_record_per_lane(self) -> None:
        records = [
            {"lane_id": "xnu", "started_at": "1", "running": True},
            {"lane_id": "xnu", "started_at": "2", "running": False},
            {"lane_id": "cache", "started_at": "3", "running": False},
        ]
        selected = latest_worker_records(records)
        self.assertEqual(
            [(record["lane_id"], record["started_at"]) for record in selected],
            [("cache", "3"), ("xnu", "1")],
        )

    def test_lane_agent_status_uses_last_event_for_stopped_lane(self) -> None:
        records = [
            {
                "lane_id": "xnu",
                "started_at": "2026-09-04T07:10:00Z",
                "updated_at": "2026-09-04T07:11:00Z",
                "running": False,
            },
            {
                "lane_id": "xnu",
                "started_at": "2026-09-04T07:00:00Z",
                "updated_at": "2026-09-04T07:20:00Z",
                "running": False,
            },
        ]
        self.assertEqual(latest_worker_records(records)[0]["updated_at"], "2026-09-04T07:20:00Z")

    def test_running_workdirs_discovers_codex_claude_and_cursor(self) -> None:
        codex_worktree = Path("/tmp/portomatic-fs-readdir").resolve()
        claude_worktree = Path("/tmp/portomatic-shared-cache-cxx").resolve()
        claude_opus_worktree = Path("/tmp/portomatic-xnu-ledger").resolve()
        claude_bg_worktree = Path("/tmp/portomatic-unwind").resolve()
        cursor_worktree = Path("/tmp/portomatic-basename").resolve()
        persist_worktree = Path("/tmp/portomatic-getopt-long").resolve()
        process_table = "\n".join(
            (
                "101 Ss node /opt/bin/codex exec -m gpt-5 -C /tmp/portomatic-fs-readdir task",
                "102 S /Users/test/.local/bin/claude --model fable --effort max -p task",
                "103 S /opt/bin/codex app-server --listen stdio://",
                "104 S claude --model claude-opus-5 -p task",
                "105 S /opt/bin/cursor-agent -p --model cursor-grok-4.6-high-fast --workspace /tmp/portomatic-basename --output-format stream-json task",
                "106 S /Users/test/.local/bin/claude --model fable --effort max --bg -p task",
                "107 Ss+ /opt/cursor-agent/node --use-system-ca /opt/cursor-agent/index.js --cursor-persist-restore deadbeef cursor-getopt-long-32a6859e78-1-acbe77",
                "108 S /opt/bin/cursor-agent persist list",
                "109 S /opt/bin/cursor-agent persist attach cursor-getopt-long-32a6859e78-1-acbe77",
            )
        )
        cwd_by_pid = {
            101: Path("/tmp/codex-launcher"),
            102: claude_worktree,
            104: claude_opus_worktree,
            105: Path("/tmp/cursor-launcher"),
            106: claude_bg_worktree,
            107: persist_worktree,
            108: Path("/tmp/persist-client"),
            109: Path("/tmp/persist-attach"),
        }

        self.assertEqual(
            running_workdirs(process_table, cwd_by_pid.get),
            {
                codex_worktree,
                claude_worktree,
                claude_bg_worktree,
                claude_opus_worktree,
                cursor_worktree,
                persist_worktree,
            },
        )
        self.assertEqual(
            running_persist_sessions(process_table, cwd_by_pid.get),
            {persist_worktree: "cursor-getopt-long-32a6859e78-1-acbe77"},
        )

    def test_running_workers_deduplicates_codex_launcher_and_child(self) -> None:
        review = Path("/tmp/portomatic-review-pr101-f2cfde65").resolve()
        command = f"codex exec -C {review} Independently review exact PR #101"
        process_table = "\n".join(
            (
                f"111 Ss node /opt/bin/{command}",
                f"112 S /opt/vendor/bin/{command}",
            )
        )

        self.assertEqual(
            running_workers(process_table, lambda _pid: Path("/tmp/launcher")),
            {review: 101},
        )

    def test_review_pr_detection_is_conservative(self) -> None:
        cases = {
            "portomatic-review-pr101-f2cfde65": 101,
            "portomatic-review-pr45-21685d75": 45,
            "portomatic-review-pr112-ae897e07": 112,
        }
        for name, number in cases.items():
            workdir = Path("/tmp") / name
            with self.subTest(name=name):
                self.assertEqual(
                    review_pr_for_worker("codex exec -C /tmp/work task", workdir),
                    number,
                )
        self.assertEqual(
            review_pr_for_worker(
                "codex exec -C /tmp/review Independently review exact PR #110",
                Path("/tmp/review"),
            ),
            110,
        )
        self.assertIsNone(
            review_pr_for_worker(
                "codex exec -C /tmp/lane Resume lane on PR #103; review found a gap",
                Path("/tmp/lane"),
            )
        )

    def test_explicit_resume_prompt_maps_detached_implementation_worker(self) -> None:
        cases = {
            "Resume failure-class lane freopen on PR #84": 84,
            "Resume lane fs-readdir-order on PR #86": 86,
        }
        workdir = Path("/tmp/portomatic-failure-classes/freopen")

        for prompt, number in cases.items():
            with self.subTest(prompt=prompt):
                self.assertEqual(
                    review_pr_for_worker(f"codex exec -C {workdir} {prompt}", workdir),
                    number,
                )

    def test_arbitrary_pr_mentions_do_not_map_implementation_worker(self) -> None:
        prompts = (
            "Resume failure-class lane freopen after checking PR #84",
            "Continue failure-class lane freopen on PR #84",
            "Resume lane on PR #84",
            "Resume lane freopen on PR 84",
            "Investigate PR #84 for the freopen lane",
        )
        workdir = Path("/tmp/portomatic-failure-classes/freopen")

        for prompt in prompts:
            with self.subTest(prompt=prompt):
                self.assertIsNone(
                    review_pr_for_worker(f"codex exec -C {workdir} {prompt}", workdir)
                )

    def test_running_workdirs_ignores_stopped_workers(self) -> None:
        process_table = "\n".join(
            (
                "201 T node /opt/bin/codex exec -C /tmp/portomatic-stopped task",
                "202 Ts claude --model=fable -p task",
                "203 T /opt/cursor-agent/node --use-system-ca /opt/cursor-agent/index.js --cursor-persist-restore dead cursor-stopped-1-aaaaaa",
            )
        )

        self.assertEqual(
            running_workdirs(process_table, lambda pid: Path(f"/tmp/worker-{pid}")),
            set(),
        )
        self.assertEqual(
            running_persist_sessions(
                process_table, lambda pid: Path(f"/tmp/worker-{pid}")
            ),
            {},
        )

    def test_persist_restore_maps_workspace_from_tmux_session_path(self) -> None:
        worktree = Path("/tmp/portomatic-select").resolve()
        process_table = (
            "401 Ss+ /opt/cursor-agent/node --use-system-ca "
            "/opt/cursor-agent/index.js --cursor-persist-restore abc "
            "cursor-select-529e3d342e-1-9b68df"
        )
        self.assertEqual(
            running_workers(
                process_table,
                lambda _pid: None,
                {"cursor-select-529e3d342e-1-9b68df": worktree},
            ),
            {worktree: None},
        )
        self.assertEqual(
            running_persist_sessions(
                process_table,
                lambda _pid: None,
                {"cursor-select-529e3d342e-1-9b68df": worktree},
            ),
            {worktree: "cursor-select-529e3d342e-1-9b68df"},
        )

    def test_wrapper_commands_mentioning_persist_are_not_workers(self) -> None:
        process_table = "\n".join(
            (
                '501 Ss /bin/zsh -c rg --cursor-persist-restore cursor-getopt-long-1-abc',
                "502 S rg --cursor-persist-restore cursor-getopt-long-1-abc",
            )
        )
        self.assertEqual(
            running_workdirs(process_table, lambda pid: Path(f"/tmp/wrapper-{pid}")),
            set(),
        )

    def test_persist_restore_uses_process_cwd_not_missing_workspace_flag(self) -> None:
        worktree = Path("/tmp/portomatic-dns-service").resolve()
        command = (
            "/Users/me/.local/share/cursor-agent/versions/2026.09.02-c22c1a3/node "
            "--use-system-ca /Users/me/.local/share/cursor-agent/versions/"
            "2026.09.02-c22c1a3/index.js --cursor-persist-restore abc123 "
            "cursor-dns-service-85f8ef5562-1-50abef"
        )
        process_table = f"301 Ss+ {command}"

        self.assertTrue(worker_command(command))
        self.assertEqual(
            persist_session_name(command),
            "cursor-dns-service-85f8ef5562-1-50abef",
        )
        self.assertEqual(
            running_workers(process_table, {301: worktree}.get),
            {worktree: None},
        )

    def test_persist_client_commands_are_not_workers(self) -> None:
        commands = (
            "cursor-agent persist list",
            "cursor-agent persist attach cursor-getopt-long-1-abc",
            "cursor-agent persist stop cursor-getopt-long-1-abc",
        )
        for command in commands:
            with self.subTest(command=command):
                self.assertFalse(worker_command(command))

    def test_persist_pane_capture_is_read_only(self) -> None:
        argv = tmux_capture_command("cursor-getopt-long-32a6859e78-1-acbe77")
        joined = " ".join(argv)
        self.assertEqual(
            argv[:5], ["tmux", "-L", "cursor-agent", "capture-pane", "-p"]
        )
        self.assertNotIn("attach", joined)
        self.assertNotIn("send-keys", joined)
        self.assertNotIn("respawn", joined)
        self.assertNotIn("persist attach", joined)

    def test_completed_persist_session_is_not_active(self) -> None:
        self.assertTrue(persist_session_is_active("  Goal active (3m 33s)\n"))
        self.assertTrue(persist_session_is_active("  → Add a follow-up  ctrl+c to stop\n"))
        self.assertTrue(
            persist_session_is_active(" ⠘⠣ Running subagent  64.23k tokens\n")
        )
        self.assertTrue(persist_session_is_active(" ⠰⠳ Thinking  37 tokens\n"))
        self.assertTrue(persist_session_is_active(" ⠘⠣ Waiting  82.1k tokens\n"))
        self.assertTrue(
            persist_session_is_active("    Waiting 7m 3s for shell\n")
        )
        self.assertFalse(
            persist_session_is_active("Updated goal complete\n→ Add a follow-up\n")
        )
        self.assertFalse(
            persist_session_is_active(
                "Goal active (3m)\nOther: (type to answer)\n"
                "↑/↓ option · Enter next/submit · Esc to skip\n"
            )
        )

    def test_persist_pane_tail_keeps_recent_work_and_drops_chrome(self) -> None:
        raw = """
    … 6 input + 7 output lines hidden · ctrl+o to expand
    75fd4283e110d2a11385a324a641bf8b62d84f61
  $ git push -u origin HEAD 1.7s
       3eaa5cde..75fd4283  HEAD -> codex/fc-getopt-long
    Tip: Use /mcp to connect Cursor to your tools and data sources.
                                                           Goal active (3m 33s)
  → Add a follow-up                                             ctrl+c to stop
  ⎇ root
  ⠀⠞ Thinking  77.67k tokens
  2 tasks
"""
        lines = persist_output_lines(raw, "2026-09-03T21:20:00.000Z")
        self.assertEqual(
            [line["text"] for line in lines],
            [
                "$ git push -u origin HEAD 1.7s",
                "3eaa5cde..75fd4283 HEAD -> codex/fc-getopt-long",
            ],
        )

    def test_persist_worker_supplies_lane_activity_from_pane(self) -> None:
        lane_worktree = Path("/tmp/portomatic-getopt-long")
        persist_events = [
            {"timestamp": "2026-09-03T21:20:00.000Z", "text": "Pushed 75fd4283"}
        ]

        class Cache:
            def read(self, path: Path):
                raise AssertionError(f"codex session should not be used: {path}")

        persist_cache = PersistPaneCache(
            lambda session: "Pushed 75fd4283\nGoal active (3m)\n"
        )
        running, activity, timestamp = activity_for_lane(
            {"branch": "codex/fc-getopt-long"},
            {"number": 45, "headRefName": "codex/fc-getopt-long"},
            {"codex/fc-getopt-long": lane_worktree},
            {lane_worktree},
            {lane_worktree: Path("/tmp/stale-codex-session.jsonl")},
            {},
            Cache(),
            ClaudeLogCache(),
            persist_by_toplevel={
                lane_worktree: "cursor-getopt-long-32a6859e78-1-acbe77"
            },
            persist_cache=persist_cache,
        )

        self.assertTrue(running)
        self.assertEqual([line["text"] for line in activity], [persist_events[0]["text"]])
        self.assertEqual(timestamp, activity[-1]["timestamp"])

    def test_detached_persist_worktree_maps_to_lane_by_name(self) -> None:
        persist_worktree = Path("/tmp/signal-sigpipe-default-action")
        self.assertEqual(
            named_workdir(
                ["signal-sigpipe-default-action", "codex/fc-signal-sigpipe-default-action"],
                {persist_worktree},
            ),
            persist_worktree,
        )
        persist_cache = PersistPaneCache(lambda _session: "Rebased onto integration\n")
        running, activity, _timestamp = activity_for_lane(
            {
                "id": "signal-sigpipe-default-action",
                "branch": "codex/fc-signal-sigpipe-default-action",
            },
            {"number": 100, "headRefName": "codex/fc-signal-sigpipe-default-action"},
            {},
            {persist_worktree},
            {},
            {},
            ClaudeLogCache(),
            ClaudeLogCache(),
            persist_by_toplevel={
                persist_worktree: "cursor-signal-sigpipe-default-a-0018b9f3e4-1-856a68"
            },
            persist_cache=persist_cache,
        )
        self.assertTrue(running)
        self.assertEqual([line["text"] for line in activity], ["Rebased onto integration"])

    def test_select_workdir_ignores_unmapped_active_worktree(self) -> None:
        mapped = Path("/tmp/portomatic-mapped")
        unmapped = Path("/tmp/portomatic-unmapped")
        branch_workdirs = {
            "codex/fc-mapped": mapped,
            "codex/unrelated": unmapped,
        }

        self.assertEqual(
            select_workdir(["codex/fc-mapped"], branch_workdirs, {mapped, unmapped}),
            mapped,
        )
        self.assertIsNone(
            select_workdir(["codex/not-present"], branch_workdirs, {unmapped})
        )

    def test_live_reviewer_supplies_lane_activity(self) -> None:
        lane_worktree = Path("/tmp/portomatic-pselect")
        review_worktree = Path("/tmp/portomatic-review-pr110-621bd07b")
        transcript = Path("/tmp/review-session.jsonl")
        review_events = [
            {"timestamp": f"2026-09-03T20:00:0{index}.000Z", "text": f"review {index}"}
            for index in range(1, 5)
        ]

        class Cache:
            def read(self, path: Path):
                self.path = path
                return review_events, review_events[-1]["timestamp"]

        cache = Cache()
        running, activity, timestamp = activity_for_lane(
            {"branch": "codex/fc-pselect"},
            {"number": 110, "headRefName": "codex/fc-pselect"},
            {"codex/fc-pselect": lane_worktree},
            {review_worktree},
            {review_worktree: transcript},
            {},
            cache,
            ClaudeLogCache(),
            review_worktree,
        )

        self.assertTrue(running)
        self.assertEqual(cache.path, transcript)
        self.assertEqual(activity, review_events)
        self.assertEqual(timestamp, review_events[-1]["timestamp"])

    def test_pr_mapping_follows_evidence_branch_to_latest_pr(self) -> None:
        pull_requests = [
            {
                "number": 71,
                "headRefName": "codex/fc-printf-output-buffer",
                "state": "CLOSED",
                "updatedAt": "2026-09-03T01:00:00Z",
            },
            {
                "number": 73,
                "headRefName": "codex/fc-printf-output-buffer",
                "state": "OPEN",
                "updatedAt": "2026-09-03T02:00:00Z",
            },
        ]
        lane = {
            "branch": "codex/printf-streaming-runtime",
            "candidate": "",
            "evidence": "https://github.com/portomatic/portomatic/pull/71",
        }
        self.assertEqual(
            pull_request_for_lane(lane, None, pull_requests)["number"],
            73,
        )

    def test_open_correction_pr_outranks_merged_original(self) -> None:
        pull_requests = [
            {
                "number": 89,
                "headRefName": "codex/fc-pselect",
                "state": "MERGED",
                "updatedAt": "2026-09-03T04:52:51Z",
            },
            {
                "number": 110,
                "headRefName": "codex/fc-pselect-kernel-boundary-v2",
                "state": "OPEN",
                "updatedAt": "2026-09-03T19:31:35Z",
            },
        ]
        lane = {
            "branch": "codex/fc-pselect",
            "candidate": "",
            "evidence": "https://github.com/portomatic/portomatic/pull/89",
        }
        self.assertEqual(
            pull_request_for_lane(lane, None, pull_requests)["number"],
            110,
        )

    def test_lane_branch_outranks_unrelated_candidate_sha(self) -> None:
        pull_requests = [
            {
                "number": 51,
                "headRefName": "codex/fc-memset-s",
                "headRefOid": "shared-base",
                "state": "OPEN",
                "updatedAt": "2026-09-03T19:00:00Z",
            },
            {
                "number": 103,
                "headRefName": "codex/fc-basename",
                "headRefOid": "basename-head",
                "state": "OPEN",
                "updatedAt": "2026-09-03T20:00:00Z",
            },
        ]
        lane = {
            "branch": "codex/fc-basename",
            "candidate": "shared-base",
            "evidence": "",
        }
        self.assertEqual(
            pull_request_for_lane(lane, None, pull_requests)["number"],
            103,
        )

    def test_all_gates_green_requires_current_integration_base(self) -> None:
        pull_request = {
            "state": "OPEN",
            "baseRefOid": "current",
            "statusCheckRollup": [
                {
                    "name": name,
                    "status": "COMPLETED",
                    "conclusion": "SUCCESS",
                }
                for name in RUNTIME_GATE_CHECKS
            ],
        }
        self.assertEqual(
            evidence_state("focused_green", pull_request, "current"),
            "regression_green",
        )
        self.assertEqual(
            evidence_state("focused_green", pull_request, "newer"),
            "focused_green",
        )

    def test_unrelated_checks_do_not_change_runtime_gate_state(self) -> None:
        pull_request = {
            "state": "OPEN",
            "baseRefOid": "current",
            "statusCheckRollup": [
                *[
                    {
                        "name": name,
                        "status": "COMPLETED",
                        "conclusion": "SUCCESS",
                    }
                    for name in RUNTIME_GATE_CHECKS
                ],
                {
                    "name": "Cloudflare Pages",
                    "status": "COMPLETED",
                    "conclusion": "FAILURE",
                },
            ],
        }
        self.assertTrue(compact_pull_request(pull_request)["checks_green"])
        self.assertEqual(
            evidence_state("focused_green", pull_request, "current"),
            "regression_green",
        )

    def test_missing_runtime_check_is_not_all_gates_green(self) -> None:
        pull_request = {
            "state": "OPEN",
            "baseRefOid": "current",
            "statusCheckRollup": [
                {
                    "name": "Runtime host and ARM64 checks",
                    "status": "COMPLETED",
                    "conclusion": "SUCCESS",
                },
                {
                    "name": "Required corpus gate aggregate (GCP ARM64)",
                    "status": "COMPLETED",
                    "conclusion": "SUCCESS",
                },
            ],
        }
        self.assertFalse(compact_pull_request(pull_request)["checks_green"])
        self.assertEqual(
            evidence_state("focused_green", pull_request, "current"),
            "focused_green",
        )

    def test_xnu_exposes_the_full_target(self) -> None:
        row = repository_row(
            {
                "id": "xnu-darwintest-boundary",
                "expected_cases": 29,
                "artifact_status": "acquiring",
                "oracle_status": "collecting",
                "gate_status": "designing",
                "qualification_status": "not_run",
                "first_failure_class": "",
                "source_sites": 1847,
                "enrolled_cases": 29,
                "native_pass_cases": 0,
                "portomatic_pass_cases": 0,
            }
        )
        self.assertEqual(row["upstream_cases"], 1847)
        self.assertEqual(row["selected_cases"], 29)
        self.assertEqual(row["native_green_cases"], 0)
        self.assertEqual(row["linux_exact_cases"], 0)
        self.assertEqual(
            row["blocker"],
            "Executable total unknown; enrolled cases not run",
        )

    def test_xnu_progress_uses_generated_local_evidence(self) -> None:
        with tempfile.TemporaryDirectory(prefix="portomatic-xnu-test-") as temporary:
            worktree = Path(temporary) / "portomatic-xnu-build-frontier"
            corpus = worktree / "runtime/corpus/xnu-darwintest-boundary"
            (corpus / "native-green").mkdir(parents=True)
            (corpus / "inventory-summary.json").write_text(
                json.dumps({"counts": {"source_sites": 1847}}), encoding="utf-8"
            )
            (corpus / "build-frontier-readiness.json").write_text(
                json.dumps(
                    {
                        "summary": {
                            "selected_cases": 941,
                            "case_build_status": {"built": 693},
                        }
                    }
                ),
                encoding="utf-8",
            )
            (corpus / "native-green/eligibility.json").write_text(
                json.dumps(
                    {
                        "summary": {
                            "baseline_selected_identities": 941,
                            "states": {"eligible": 119},
                        }
                    }
                ),
                encoding="utf-8",
            )

            progress = xnu_progress({worktree})

        self.assertEqual(progress["source_sites"], 1847)
        self.assertEqual(progress["selected"], 941)
        self.assertEqual(progress["built"], 693)
        self.assertEqual(progress["native_green"], 119)
        self.assertEqual(progress["linux_exact"], 0)

    def test_lane_worker_registry_keeps_channel_activity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log = root / "xnu-build.run.jsonl"
            log.write_text(
                "\n".join(
                    json.dumps(event)
                    for event in (
                        {
                            "timestamp": "2026-09-04T07:00:00.000Z",
                            "stream": "stdin",
                            "text": "Goal: compile the selected tests",
                        },
                        {
                            "timestamp": "2026-09-04T07:00:01.000Z",
                            "stream": "stderr",
                            "text": "building 693/941",
                        },
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            (root / "xnu-build.run.json").write_text(
                json.dumps(
                    {
                        "lane_id": "xnu-build-frontier",
                        "state": "running",
                        "pid": 99999999,
                        "worktree": temporary,
                        "started_at": "2026-09-04T07:00:00.000Z",
                        "updated_at": "2026-09-04T07:00:01.000Z",
                        "log_path": str(log),
                    }
                ),
                encoding="utf-8",
            )

            records = lane_worker_records(root)
            found, running, count, lines, timestamp, workdirs = lane_worker_activity(
                "xnu-build-frontier", records
            )

        self.assertTrue(found)
        self.assertFalse(running)
        self.assertEqual(count, 0)
        self.assertEqual([line["text"] for line in lines], [
            "Goal: compile the selected tests",
            "building 693/941",
        ])
        self.assertEqual(timestamp, "2026-09-04T07:00:01.000Z")
        self.assertEqual(workdirs, set())

    def test_lane_worker_registry_hides_nonfatal_transport_noise(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log = root / "xnu-build.run.jsonl"
            log.write_text(
                "\n".join(
                    json.dumps(event)
                    for event in (
                        {
                            "timestamp": "2026-09-04T07:00:00.000Z",
                            "stream": "stdout",
                            "text": "Rebuilding 912/941 selected identities",
                        },
                        {
                            "timestamp": "2026-09-04T07:00:01.000Z",
                            "stream": "stderr",
                            "text": (
                                "ERROR rmcp::transport::worker: worker quit with fatal: "
                                "Transport channel closed, when AuthRequired"
                            ),
                        },
                        {
                            "timestamp": "2026-09-04T07:00:02.000Z",
                            "stream": "stderr",
                            "text": "Reading additional input from stdin...",
                        },
                    )
                )
                + "\n",
                encoding="utf-8",
            )
            (root / "xnu-build.run.json").write_text(
                json.dumps(
                    {
                        "lane_id": "xnu-build-frontier",
                        "state": "exited",
                        "exit_code": 0,
                        "pid": 99999999,
                        "worktree": temporary,
                        "started_at": "2026-09-04T07:00:00.000Z",
                        "updated_at": "2026-09-04T07:00:03.000Z",
                        "log_path": str(log),
                    }
                ),
                encoding="utf-8",
            )

            records = lane_worker_records(root)
            _found, _running, _count, lines, timestamp, _workdirs = (
                lane_worker_activity("xnu-build-frontier", records)
            )

        self.assertEqual(
            [line["text"] for line in lines],
            ["Rebuilding 912/941 selected identities"],
        )
        self.assertEqual(timestamp, "2026-09-04T07:00:00.000Z")

    def test_registered_worker_requires_its_wrapper_to_still_own_it(self) -> None:
        import lane_agent

        original = lane_agent.process_is_running
        lane_agent.process_is_running = lambda pid: pid == 123
        try:
            self.assertFalse(
                registered_worker_is_running({"pid": 123, "wrapper_pid": 456})
            )
            self.assertTrue(registered_worker_is_running({"pid": 123}))
        finally:
            lane_agent.process_is_running = original

    def test_live_wrapped_worker_without_canonical_lane_is_visible(self) -> None:
        import lane_agent

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log = root / "metal.jsonl"
            log.write_text(
                json.dumps(
                    {
                        "timestamp": "2026-09-04T19:03:57.846Z",
                        "stream": "stdout",
                        "text": "metal smoke: VERIFIED 5 passed",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            records = {
                "metal-verification-ladder": [
                    {
                        "lane_id": "metal-verification-ladder",
                        "goal": "Build the Metal verification ladder",
                        "worktree": temporary,
                        "pid": 123,
                        "wrapper_pid": 456,
                        "state": "running",
                        "started_at": "2026-09-04T19:00:00.000Z",
                        "updated_at": "2026-09-04T19:03:57.846Z",
                        "log_path": str(log),
                    }
                ]
            }
            original = lane_agent.process_is_running
            lane_agent.process_is_running = lambda pid: pid in {123, 456}
            try:
                lanes = registered_worker_only_lanes(set(), records, [])
            finally:
                lane_agent.process_is_running = original

        self.assertEqual(len(lanes), 1)
        self.assertEqual(lanes[0]["id"], "metal-verification-ladder")
        self.assertEqual(lanes[0]["worker_state"], "running")
        self.assertEqual(lanes[0]["affected_repositories"], ["Metal GPU"])
        self.assertEqual(lanes[0]["activity"][-1]["text"], "metal smoke: VERIFIED 5 passed")

    def test_suite_selection_worker_is_not_attached_to_merged_inventory_lane(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "worker.json").write_text(
                json.dumps(
                    {
                        "lane_id": "xnu-inventory",
                        "worktree": "/tmp/portomatic-xnu-suite-selection-rebase-review",
                        "state": "exited",
                        "started_at": "2026-09-04T07:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            records = lane_worker_records(root)

        self.assertNotIn("xnu-inventory", records)
        self.assertEqual(records["xnu-suite-selection"][0]["lane_id"], "xnu-suite-selection")

    def test_xnu_repair_worker_attaches_to_one_differential_verifier_lane(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "worker.json").write_text(
                json.dumps(
                    {
                        "lane_id": "xnu-verifier-repair",
                        "worktree": "/tmp/portomatic-xnu-pr124-final-repair",
                        "state": "running",
                        "started_at": "2026-09-04T19:00:00Z",
                    }
                ),
                encoding="utf-8",
            )
            records = lane_worker_records(root)

        self.assertNotIn("xnu-verifier-repair", records)
        self.assertEqual(
            records["xnu-differential-verifier"][0]["lane_id"],
            "xnu-differential-verifier",
        )

    def test_xnu_progress_prefers_the_tracked_native_lane_over_stale_maximum(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = root / "portomatic-xnu-old"
            reviewed = root / "portomatic-xnu-reviewed"
            for worktree, eligible in ((old, 119), (reviewed, 118)):
                native = (
                    worktree
                    / "runtime/corpus/xnu-darwintest-boundary/native-green"
                )
                native.mkdir(parents=True)
                (native / "eligibility.json").write_text(
                    json.dumps(
                        {
                            "summary": {
                                "baseline_selected_identities": 941,
                                "states": {"eligible": eligible},
                            }
                        }
                    ),
                    encoding="utf-8",
                )

            progress = xnu_progress({old, reviewed}, native_worktree=reviewed)

        self.assertEqual(progress["selected"], 941)
        self.assertEqual(progress["native_green"], 118)

    def test_xnu_progress_prefers_reviewed_build_over_rejected_maximum(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            reviewed = root / "portomatic-xnu-reviewed"
            rejected = root / "portomatic-xnu-rejected"
            for worktree, built in ((reviewed, 602), (rejected, 936)):
                corpus = worktree / "runtime/corpus/xnu-darwintest-boundary"
                corpus.mkdir(parents=True)
                (corpus / "build-frontier-readiness.json").write_text(
                    json.dumps(
                        {
                            "summary": {
                                "selected_cases": 941,
                                "case_build_status": {
                                    "built": built,
                                    "not_built": 941 - built,
                                },
                            }
                        }
                    ),
                    encoding="utf-8",
                )

            progress = xnu_progress(
                {reviewed, rejected}, build_worktree=reviewed
            )

        self.assertEqual(progress["selected"], 941)
        self.assertEqual(progress["built"], 602)

    def test_xnu_build_uses_committed_tracked_candidate_not_old_branch(self) -> None:
        candidate = Path("/tmp/portomatic-xnu-candidate")
        revision = "a" * 40
        report = {
            "summary": {"selected_cases": 3, "case_build_status": {"built": 2}},
            "cases": [
                {"case_id": "a", "build_status": "built"},
                {"case_id": "b", "build_status": "built"},
                {"case_id": "c", "build_status": "not_built"},
            ],
        }
        with patch("live_lane_tails.worktree_head", return_value=revision), patch(
            "live_lane_tails.subprocess.run",
            return_value=subprocess.CompletedProcess([], 0, json.dumps(report), ""),
        ) as run:
            progress = xnu_progress(
                set(), repository=Path("/tmp/repo"), build_ref="stale-branch",
                candidate_build_worktree=candidate,
            )
        self.assertEqual(progress["built"], 2)
        self.assertEqual(progress["selected"], 3)
        self.assertEqual(progress["build_source_ref"], revision)
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0][2], str(candidate))
        self.assertTrue(run.call_args.args[0][4].startswith(revision + ":"))

    def test_xnu_committed_build_rejects_inconsistent_count(self) -> None:
        report = {
            "summary": {"selected_cases": 1, "case_build_status": {"built": 1}},
            "cases": [{"case_id": "a", "build_status": "not_built"}],
        }
        with patch("live_lane_tails.subprocess.run", return_value=
                   subprocess.CompletedProcess([], 0, json.dumps(report), "")):
            with self.assertRaisesRegex(ValueError, "summary disagrees"):
                xnu_progress(set(), repository=Path("/tmp/repo"), build_ref="candidate")

    def test_summary_mismatch_fails_validation(self) -> None:
        payload = {
            "lanes": [],
            "repositories": [],
            "workers": [],
            "summary": {
                "repositories_total": 1,
                "repositories_qualified": 0,
                "lanes_total": 0,
                "lanes_merged": 0,
                "workers_running": 0,
            },
        }
        with self.assertRaisesRegex(ValueError, "summary disagrees"):
            validate_payload(payload)

    def test_summary_counts_all_workers_not_only_mapped_lanes(self) -> None:
        payload = {
            "lanes": [
                {
                    "id": "shared-cache-cxx",
                    "display_state": "implementing",
                    "worker_state": "running",
                }
            ],
            "repositories": [],
            "workers": [
                {"worktree": "shared-cache", "branch": "codex/shared-cache"},
                {"worktree": "xnu-gate", "branch": "codex/xnu-gate"},
            ],
            "summary": {
                "repositories_total": 0,
                "repositories_qualified": 0,
                "lanes_total": 1,
                "lanes_merged": 0,
                "workers_running": 2,
            },
        }
        validate_payload(payload)

    def test_direct_claude_transcript_produces_recent_activity(self) -> None:
        import live_lane_tails

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "-tmp-portomatic-shared-cache"
            project.mkdir()
            transcript = project / "session-123.jsonl"
            records = [
                {
                    "type": "assistant",
                    "timestamp": "2026-09-03T19:00:00.000Z",
                    "message": {
                        "content": [
                            {
                                "type": "tool_use",
                                "name": "Bash",
                                "input": {"description": "Run the ARM64 acceptance"},
                            }
                        ]
                    },
                },
                {
                    "type": "assistant",
                    "timestamp": "2026-09-03T19:00:01.000Z",
                    "message": {
                        "content": [
                            {"type": "text", "text": "The next dyld blocker is isolated."}
                        ]
                    },
                },
            ]
            transcript.write_text(
                "".join(json.dumps(record) + "\n" for record in records),
                encoding="utf-8",
            )
            original = live_lane_tails.CLAUDE_PROJECTS_ROOT
            live_lane_tails.CLAUDE_PROJECTS_ROOT = root
            try:
                lines, timestamp = ClaudeLogCache().read("session:session-123")
            finally:
                live_lane_tails.CLAUDE_PROJECTS_ROOT = original

        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["text"], "Running Run the ARM64 acceptance")
        self.assertEqual(lines[1]["text"], "The next dyld blocker is isolated.")
        self.assertEqual(timestamp, "2026-09-03T19:00:01.000Z")

    def test_managed_claude_agent_prefers_structured_transcript(self) -> None:
        import live_lane_tails

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "-tmp-portomatic-shared-cache"
            project.mkdir()
            transcript = project / "session-123.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "type": "assistant",
                        "timestamp": "2026-09-03T19:00:02.000Z",
                        "message": {
                            "content": [
                                {
                                    "type": "tool_use",
                                    "name": "Bash",
                                    "input": {"description": "Inspect real dyld startup"},
                                }
                            ]
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            original = live_lane_tails.CLAUDE_PROJECTS_ROOT
            live_lane_tails.CLAUDE_PROJECTS_ROOT = root
            try:
                lines, timestamp = ClaudeLogCache().read(
                    "managed:7b0e5b0f:session-123"
                )
            finally:
                live_lane_tails.CLAUDE_PROJECTS_ROOT = original

        self.assertEqual(lines[0]["text"], "Running Inspect real dyld startup")
        self.assertEqual(timestamp, "2026-09-03T19:00:02.000Z")

    def test_latest_claude_transcript_follows_the_worktree(self) -> None:
        import live_lane_tails

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            worktree = Path("/tmp/portomatic-shared-cache")
            project_name = "-" + str(worktree.resolve()).lstrip("/").replace("/", "-")
            project = root / project_name
            project.mkdir()
            old = project / "old.jsonl"
            new = project / "new.jsonl"
            old.write_text("{}\n", encoding="utf-8")
            new.write_text("{}\n", encoding="utf-8")
            old.touch()
            new.touch()
            original = live_lane_tails.CLAUDE_PROJECTS_ROOT
            live_lane_tails.CLAUDE_PROJECTS_ROOT = root
            try:
                self.assertEqual(latest_claude_transcript(worktree), new)
            finally:
                live_lane_tails.CLAUDE_PROJECTS_ROOT = original

    def test_cursor_transcript_produces_recent_activity(self) -> None:
        import live_lane_tails

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            worktree = Path("/tmp/portomatic-basename")
            project_name = str(worktree.resolve()).lstrip("/").replace("/", "-")
            transcript = root / project_name / "agent-transcripts" / "session-123" / "session-123.jsonl"
            transcript.parent.mkdir(parents=True)
            transcript.write_text(
                json.dumps(
                    {
                        "role": "assistant",
                        "message": {
                            "content": [
                                {"type": "text", "text": "Rebased the basename lane."},
                                {
                                    "type": "tool_use",
                                    "name": "Shell",
                                    "input": {"description": "Run focused tests"},
                                },
                            ]
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            original = live_lane_tails.CURSOR_PROJECTS_ROOT
            live_lane_tails.CURSOR_PROJECTS_ROOT = root
            try:
                self.assertEqual(latest_cursor_transcript(worktree), transcript)
                lines, timestamp = ClaudeLogCache().read(f"file:{transcript}")
            finally:
                live_lane_tails.CURSOR_PROJECTS_ROOT = original

        self.assertEqual([line["text"] for line in lines], [
            "Rebased the basename lane.",
            "Running Run focused tests",
        ])
        self.assertIsNotNone(timestamp)


if __name__ == "__main__":
    unittest.main()
