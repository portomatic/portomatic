#!/usr/bin/env python3
"""Restore the pinned research capture from private GCS storage."""

import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE_DIRS = {"documents", "github", "media", "mirror", "raw", "logs"}


def digest(stream):
    result = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        result.update(chunk)
    return result.hexdigest()


def destination(root, member):
    path = PurePosixPath(member.name)
    if (path.is_absolute() or ".." in path.parts or not path.parts
            or path.parts[0] not in ARCHIVE_DIRS
            or not (member.isfile() or member.isdir())):
        raise ValueError(f"Unsupported archive entry: {member.name}")
    target = root.joinpath(*path.parts)
    for part in (target, *target.parents):
        if part == root:
            break
        if part.is_symlink():
            raise ValueError(f"Refusing to restore through symlink: {part}")
    return target


def restore(archive, root):
    """Check all existing files before writing; never replace local edits."""
    root = root.resolve()
    seen = set()
    missing = set()
    with tarfile.open(archive, "r:gz") as capture:
        for member in capture:
            target = destination(root, member)
            if member.name in seen:
                raise ValueError(f"Duplicate archive entry: {member.name}")
            seen.add(member.name)
            if member.isdir():
                if target.exists() and not target.is_dir():
                    raise ValueError(f"Local path conflicts with directory: {target}")
                continue
            if not target.exists():
                missing.add(member.name)
                continue
            if not target.is_file():
                raise ValueError(f"Local path conflicts with file: {target}")
            with target.open("rb") as local, capture.extractfile(member) as remote:
                if digest(local) != digest(remote):
                    raise ValueError(f"Local file differs from capture; preserve or move it before syncing: {target}")
    with tarfile.open(archive, "r:gz") as capture:
        for member in capture:
            target = destination(root, member)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.name in missing:
                target.parent.mkdir(parents=True, exist_ok=True)
                # Publish complete files atomically; an interrupted sync can be retried.
                with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                    temporary = Path(output.name)
                    try:
                        with capture.extractfile(member) as source:
                            shutil.copyfileobj(source, output)
                        output.close()
                        if target.exists() or target.is_symlink():
                            raise ValueError(f"Destination appeared during sync: {target}")
                        temporary.rename(target)
                    finally:
                        temporary.unlink(missing_ok=True)
    return len(missing)


def main():
    config = json.loads((ROOT / "docs/evidence/archive.json").read_text())
    if not config.get("sha256") or not config.get("uri"):
        raise SystemExit("The research archive has not been published yet.")
    if shutil.which("gcloud") is None:
        raise SystemExit("Install the Google Cloud CLI and run gcloud auth login first.")
    with tempfile.TemporaryDirectory(prefix="portomatic-evidence-") as scratch:
        archive = Path(scratch) / "capture.tar.gz"
        subprocess.run(["gcloud", "storage", "cp", config["uri"], str(archive),
                        "--project=" + config["project"]], check=True)
        with archive.open("rb") as stream:
            if digest(stream) != config["sha256"]:
                raise SystemExit("Archive checksum mismatch; no evidence files were changed.")
        print("Archive checksum verified. Checking existing evidence before restoring missing files...", flush=True)
        count = restore(archive, ROOT / "docs/evidence/corellium")
        print(f"Research archive verified. Restored {count} missing files; existing files preserved.")


if __name__ == "__main__":
    main()
