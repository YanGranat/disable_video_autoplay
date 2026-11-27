import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("extension_package", ROOT / "scripts/package.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackageTests(unittest.TestCase):
    def setUp(self):
        scratch = ROOT / "temporary_files"
        scratch.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="package-test-", dir=scratch)
        self.addCleanup(self.directory.cleanup)
        self.work = Path(self.directory.name)

    def test_runtime_archive_is_reproducible_and_excludes_build_inputs(self):
        first, second = self.work / "first.zip", self.work / "second.zip"
        summary = package.build(ROOT, first)
        package.build(ROOT, second)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with zipfile.ZipFile(first) as archive:
            self.assertIsNone(archive.testzip())
            self.assertEqual(summary["entries"], archive.namelist())
            self.assertIn("core/site-rules.js", archive.namelist())
            for entry in ("ui/site-rules.js", "ui/site-rules-strings.js", "ui/site-rules.css"):
                self.assertIn(entry, archive.namelist())
            self.assertIn("icons/icon16_off.png", archive.namelist())
            for entry in archive.infolist():
                self.assertFalse(entry.filename.startswith(("temporary_files/", "store-preparation/", "node_modules/", "tests/", "scripts/", ".git")))
                self.assertEqual(entry.date_time, (2000, 1, 1, 0, 0, 0))
                self.assertFalse(entry.extra or entry.comment)

    def test_existing_output_is_preserved(self):
        output = self.work / "existing.zip"
        output.write_bytes(b"existing-content")
        with self.assertRaises(FileExistsError):
            package.build(ROOT, output)
        self.assertEqual(output.read_bytes(), b"existing-content")

    def fixture(self, popup):
        root = self.work / "fixture"
        root.mkdir()
        manifest = {"icons": {}, "action": {"default_icon": {}, "default_popup": popup},
                    "options_ui": {"page": "options.html"}, "background": {"service_worker": "background.js"},
                    "content_scripts": []}
        (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        for name in ("LICENSE", "PRIVACY.md", "options.html", "background.js"):
            (root / name).write_text("", encoding="utf-8")
        return root

    def test_parent_paths_are_rejected_before_creating_an_archive(self):
        root = self.fixture("../outside.html")
        output = self.work / "bad.zip"
        with self.assertRaisesRegex(ValueError, "Invalid runtime path"):
            package.build(root, output)
        self.assertFalse(output.exists())

    def test_missing_runtime_files_are_rejected(self):
        root = self.fixture("missing.html")
        with self.assertRaisesRegex(ValueError, "Missing or external runtime file"):
            package.runtime_files(root)


if __name__ == "__main__":
    unittest.main()
