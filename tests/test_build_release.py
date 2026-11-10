import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from scripts.build_release import REQUIRED_WEB_FILES, RUNTIME_FILES, build_release


class BuildReleaseTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory(prefix="quicklook-release-test-")
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.source = self.root / "source"
        self.destination = self.root / "quicklook-v1"
        for name in (*RUNTIME_FILES, *REQUIRED_WEB_FILES):
            self.put(name, name.encode("utf-8"))

    def put(self, name, content):
        path = self.source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def test_release_includes_future_public_pages_and_excludes_local_state(self):
        excluded = [
            "output_file/warehouse.db", "output_file/workspace.json", "output_file/recognition.json",
            "input_file/原始数据.xlsx", "uploads/import.xlsx", "logs/server.log", ".env", "keys/local.pem",
        ]
        for name in excluded:
            self.put(name, b"local fixture")
        self.put("web/新页面.html", b"<title>New page</title>")
        manifest = build_release(self.source, self.destination, "v1")
        self.assertEqual({path.name for path in self.destination.iterdir()}, {"app-release.json", "payload"})
        self.assertEqual(manifest["basePath"], "/quicklook/")
        self.assertEqual(manifest["entryPoint"], "server.py")
        self.assertEqual(manifest["healthPath"], "/healthz")
        self.assertEqual(manifest["dataMode"], "external")
        payload = self.destination / "payload"
        paths = {entry["path"] for entry in manifest["files"]}
        self.assertIn("web/新页面.html", paths)
        self.assertTrue(paths.isdisjoint(excluded))
        self.assertEqual(paths, {p.relative_to(payload).as_posix() for p in payload.rglob("*") if p.is_file()})
        for entry in manifest["files"]:
            data = (payload / entry["path"]).read_bytes()
            self.assertEqual(entry["bytes"], len(data))
            self.assertEqual(entry["sha256"], hashlib.sha256(data).hexdigest())
        for name in excluded:
            self.assertEqual((self.source / name).read_bytes(), b"local fixture")

    def test_version_cannot_be_overwritten_and_next_version_changes_fingerprint(self):
        first = build_release(self.source, self.destination, "v1")
        self.put("server.py", b"new service")
        with self.assertRaisesRegex(ValueError, "already exists"):
            build_release(self.source, self.destination, "v1")
        original = json.loads((self.destination / "app-release.json").read_text(encoding="utf-8"))
        self.assertEqual(first, original)
        self.assertEqual((self.destination / "payload" / "server.py").read_bytes(), b"server.py")
        second = build_release(self.source, self.root / "quicklook-v2", "v2")
        self.assertNotEqual(first["sourceRevision"], second["sourceRevision"])

    def test_unexpected_web_secrets_stop_packaging_before_writing_a_release(self):
        self.put("web/private.pem", b"local secret fixture")
        with self.assertRaisesRegex(ValueError, "Unexpected non-public file"):
            build_release(self.source, self.destination, "v1")
        self.assertFalse(self.destination.exists())


if __name__ == "__main__":
    unittest.main()
