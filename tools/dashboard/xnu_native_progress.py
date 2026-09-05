"""Read separate, committed native evidence without changing gate status."""
from collections import Counter
import hashlib
import json
import subprocess

NATIVE_REF = "codex/xnu-native-qualification-reconcile"
CORPUS = "runtime/corpus/xnu-darwintest-boundary"
REPORT = f"{CORPUS}/native-coverage.json"


def read_progress(repository, ref=NATIVE_REF):
    def git(*args):
        return subprocess.run(["git", "-C", str(repository), *args], capture_output=True)

    revision = git("rev-parse", "--verify", ref)
    if revision.returncode:
        return None
    commit = revision.stdout.decode().strip()

    def blob(path):
        result = git("show", f"{commit}:{path}")
        if result.returncode:
            raise ValueError(f"missing XNU native evidence at {commit}: {path}")
        return result.stdout

    report = json.loads(blob(REPORT))
    if report.get("schema_version") != 1:
        raise ValueError("unsupported XNU native evidence schema")
    cases = report["cases"]
    ids = [case["case_id"] for case in cases]
    summary = report["summary"]
    if len(ids) != len(set(ids)) or len(ids) != summary["selected_identities"]:
        raise ValueError("XNU native evidence identity counts disagree")
    for field, key in (("build_state", "build_states"), ("expanded_native_state", "expanded_native_states")):
        if dict(Counter(row[field] for row in cases)) != summary[key]:
            raise ValueError(f"XNU native evidence {key} counts disagree")
    admitted = {row["case_id"] for row in cases if row["frozen_gate_admitted"]}
    stable = {row["case_id"] for row in cases if row["expanded_native_state"] == "stable_pass"}
    expected = {
        "frozen_gate_admitted": len(admitted), "expanded_stable": len(stable),
        "expanded_stable_already_admitted": len(stable & admitted),
        "expanded_stable_not_admitted": len(stable - admitted),
        "identities_with_any_stable_native_evidence": len(stable | admitted),
    }
    if any(summary[key] != count for key, count in expected.items()):
        raise ValueError("XNU native evidence overlap counts disagree")
    sources = [f"{CORPUS}/{name}" for name in (
        "build-frontier-readiness.json", "frontier-qualification/results.json",
        "prerequisite-resolution/results.json", "native-green/eligibility.json")]
    sources.append("runtime/evidence/20260904T194218Z-xnu-frontier-prerequisites/before-after.json")
    for path in sources:
        if hashlib.sha256(blob(path)).hexdigest() != report["inputs"][path]:
            raise ValueError(f"stale XNU native evidence source: {path}")
    manifest = blob(f"{CORPUS}/native-comparison-inputs.json")
    if hashlib.sha256(manifest).hexdigest() != report["comparison_manifest_sha256"]:
        raise ValueError("stale XNU comparison-input manifest")
    candidates = json.loads(manifest)["cases"]
    if len(candidates) != len(stable) or {row["case_id"] for row in candidates} != stable:
        raise ValueError("XNU comparison-input membership disagrees")
    return {"source_ref": ref, "source_commit": commit, **summary}
