#!/usr/bin/env python3
"""Render JavaScript fallbacks so the dashboard also works over file://."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


SNAPSHOTS = {
    "dashboard.json": ("dashboard.snapshot.js", "__PORTOMATIC_DASHBOARD__"),
}


def encoded_snapshot(source: Path, variable: str) -> bytes:
    data = json.loads(source.read_text(encoding="utf-8"))
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return f"window.{variable}={payload};\n".encode()


def write_snapshot(source: Path, target: Path, variable: str) -> None:
    temporary = target.with_suffix(".js.tmp")
    temporary.write_bytes(encoded_snapshot(source, variable))
    temporary.replace(target)


def render(
    directory: Path,
    *,
    check: bool = False,
) -> bool:
    current = True
    for source_name, (target_name, variable) in SNAPSHOTS.items():
        source = directory / source_name
        if not source.exists():
            continue
        target = directory / target_name
        expected = encoded_snapshot(source, variable)
        if check:
            if not target.exists() or target.read_bytes() != expected:
                print(f"stale: {target}")
                current = False
        else:
            write_snapshot(source, target, variable)
            print(f"rendered: {target}")
    return current


def main() -> int:
    parser = argparse.ArgumentParser()
    project = Path(__file__).resolve().parents[2]
    parser.add_argument(
        "--directory",
        type=Path,
        default=project / "docs" / "implementation-v0",
    )
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    return 0 if render(args.directory, check=args.check) else 1


if __name__ == "__main__":
    raise SystemExit(main())
