import io
from pathlib import Path
import tarfile
import tempfile
import unittest

from sync_evidence import restore


class RestoreTests(unittest.TestCase):
    def archive(self, directory, entries):
        path = directory / "capture.tar.gz"
        with tarfile.open(path, "w:gz") as capture:
            for name, data in entries:
                info = tarfile.TarInfo(name)
                info.size = len(data)
                capture.addfile(info, io.BytesIO(data))
        return path

    def test_restore_and_repeat(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            archive = self.archive(base, [("raw/page.html", b"research")])
            root = base / "evidence"
            self.assertEqual(restore(archive, root), 1)
            self.assertEqual((root / "raw/page.html").read_bytes(), b"research")
            self.assertEqual(restore(archive, root), 0)

    def test_conflict_preserves_everything(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            archive = self.archive(base, [("raw/new.html", b"new"), ("raw/page.html", b"remote")])
            root = base / "evidence"
            (root / "raw").mkdir(parents=True)
            (root / "raw/page.html").write_bytes(b"local")
            with self.assertRaises(ValueError):
                restore(archive, root)
            self.assertFalse((root / "raw/new.html").exists())
            self.assertEqual((root / "raw/page.html").read_bytes(), b"local")

    def test_unsafe_paths_and_symlinks(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            for name in ["../escape", "/absolute", "raw/../../escape", "unexpected/file"]:
                with self.subTest(name=name):
                    archive = self.archive(base, [(name, b"data")])
                    with self.assertRaises(ValueError):
                        restore(archive, base / "evidence")
            root = base / "evidence"
            root.mkdir()
            (root / "raw").symlink_to(base, target_is_directory=True)
            archive = self.archive(base, [("raw/escape", b"data")])
            with self.assertRaises(ValueError):
                restore(archive, root)
