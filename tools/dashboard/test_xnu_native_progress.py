import copy
import hashlib
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from xnu_native_progress import read_progress, CORPUS, REPORT


class NativeProgressTests(unittest.TestCase):
    def blobs(self):
        # One admitted case overlaps the expanded evidence; do not add counts.
        cases = [{"case_id": "a", "build_state": "built", "expanded_native_state": "stable_pass", "frozen_gate_admitted": True},
                 {"case_id": "b", "build_state": "built", "expanded_native_state": "failed", "frozen_gate_admitted": False}]
        summary = {"selected_identities": 2, "build_states": {"built": 2},
                   "expanded_native_states": {"stable_pass": 1, "failed": 1},
                   "frozen_gate_admitted": 1, "expanded_stable": 1,
                   "expanded_stable_already_admitted": 1, "expanded_stable_not_admitted": 0,
                   "identities_with_any_stable_native_evidence": 1}
        sources = [f"{CORPUS}/{name}" for name in (
            "build-frontier-readiness.json", "frontier-qualification/results.json",
            "prerequisite-resolution/results.json", "native-green/eligibility.json")]
        sources.append("runtime/evidence/20260904T194218Z-xnu-frontier-prerequisites/before-after.json")
        blobs = {name: b'{}' for name in sources}
        manifest = json.dumps({"cases": [{"case_id": "a"}]}).encode()
        blobs[f"{CORPUS}/native-comparison-inputs.json"] = manifest
        report = {"schema_version": 1, "summary": summary, "cases": cases,
                  "inputs": {name: hashlib.sha256(data).hexdigest() for name, data in blobs.items()},
                  "comparison_manifest_sha256": hashlib.sha256(manifest).hexdigest()}
        blobs[REPORT] = json.dumps(report).encode()
        return blobs

    def read(self, blobs):
        def run(args, **kwargs):
            value = b'abc123\n' if 'rev-parse' in args else blobs[args[-1].split(':', 1)[1]]
            return subprocess.CompletedProcess(args, 0, value, b'')
        with patch('xnu_native_progress.subprocess.run', side_effect=run):
            return read_progress(Path('/tmp/repo'))

    def test_overlap_is_not_double_counted(self):
        result = self.read(self.blobs())
        self.assertEqual(result['identities_with_any_stable_native_evidence'], 1)
        self.assertEqual(result['expanded_stable_not_admitted'], 0)

    def test_stale_source_is_rejected(self):
        blobs = self.blobs()
        blobs[f'{CORPUS}/frontier-qualification/results.json'] = b'{"changed":true}'
        with self.assertRaisesRegex(ValueError, 'stale XNU native evidence source'):
            self.read(blobs)

    def test_inflated_pass_count_is_rejected(self):
        blobs = self.blobs()
        report = json.loads(blobs[REPORT])
        report['summary']['expanded_stable'] = 2
        blobs[REPORT] = json.dumps(report).encode()
        with self.assertRaisesRegex(ValueError, 'overlap counts disagree'):
            self.read(blobs)

    def test_missing_manifest_candidate_is_rejected(self):
        blobs = self.blobs()
        manifest = b'{"cases":[]}'
        report = json.loads(blobs[REPORT])
        report['comparison_manifest_sha256'] = hashlib.sha256(manifest).hexdigest()
        blobs[f'{CORPUS}/native-comparison-inputs.json'] = manifest
        blobs[REPORT] = json.dumps(report).encode()
        with self.assertRaisesRegex(ValueError, 'membership disagrees'):
            self.read(blobs)


if __name__ == '__main__':
    unittest.main()
