"""Shared input selection must not silently revive a stale private copy."""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from source_paths import default_source_directory, source_config, portable_source_config


class SourcePathTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.parent = Path(temporary.name)
        self.root = self.parent / "数据速查"
        self.root.mkdir()
        env = patch.dict(os.environ, {"SHARED_DATA_ROOT": ""})
        env.start()
        self.addCleanup(env.stop)

    def test_standalone_project_keeps_local_input(self):
        self.assertEqual(source_config(self.root), {
            "folder": str(self.root / "input_file"), "auto": True,
        })

    def test_shared_root_selects_only_order_summary(self):
        shared = self.parent / "共享数据"
        for category in ("原始销量", "订单汇总", "车型信息"):
            (shared / category).mkdir(parents=True)
        self.assertEqual(default_source_directory(self.root), shared / "订单汇总")

    def test_missing_category_does_not_fall_back_to_private_input(self):
        (self.root / "input_file").mkdir()
        shared = self.parent / "共享数据"
        shared.mkdir()
        self.assertEqual(default_source_directory(self.root), shared / "订单汇总")
        self.assertFalse((shared / "订单汇总").exists())

    def test_explicit_root_wins_even_if_it_does_not_exist(self):
        (self.parent / "共享数据").mkdir()
        explicit = self.parent / "外部共享数据"
        with patch.dict(os.environ, {"SHARED_DATA_ROOT": str(explicit)}):
            self.assertEqual(default_source_directory(self.root), explicit / "订单汇总")
        self.assertFalse(explicit.exists())

    def test_saved_source_wins_over_shared_default_and_environment(self):
        shared = self.parent / "共享数据"
        shared.mkdir()
        workspace = self.root / "output_file" / "workspace.json"
        workspace.parent.mkdir()
        saved = {"folder": str(self.parent / "用户选择的来源"), "auto": False}
        workspace.write_text(json.dumps(saved, ensure_ascii=False), encoding="utf-8")
        with patch.dict(os.environ, {"SHARED_DATA_ROOT": str(shared)}):
            self.assertEqual(source_config(self.root), saved)
        self.assertEqual(json.loads(workspace.read_text(encoding="utf-8")), saved)

    def test_explicit_config_file_is_respected(self):
        workspace = self.parent / "custom-workspace.json"
        saved = {"folder": str(self.parent / "custom-source"), "auto": False}
        workspace.write_text(json.dumps(saved), encoding="utf-8")
        self.assertEqual(source_config(self.root, workspace), saved)

    def test_relative_shared_root_and_saved_source_ignore_current_directory(self):
        workspace = self.root / 'output_file' / 'workspace.json'
        workspace.parent.mkdir()
        workspace.write_text(json.dumps({'folder': '../共享数据/订单汇总', 'auto': False}), encoding='utf-8')
        previous = Path.cwd()
        try:
            os.chdir(self.parent)
            with patch.dict(os.environ, {'SHARED_DATA_ROOT': '../alternate-shared'}):
                self.assertEqual(default_source_directory(self.root), self.parent.resolve() / 'alternate-shared' / '订单汇总')
                self.assertEqual(source_config(self.root)['folder'], str(self.parent.resolve() / '共享数据' / '订单汇总'))
        finally:
            os.chdir(previous)

    def test_workspace_sources_are_portable_and_external_sources_stay_absolute(self):
        shared = self.parent / '共享数据' / '订单汇总'
        saved = portable_source_config(self.root, shared, False)
        self.assertEqual(saved, {'folder': '../共享数据/订单汇总', 'auto': False})
        self.assertEqual(portable_source_config(self.root, self.root / 'input_file')['folder'], 'input_file')
        moved_root = self.parent / 'relocated-workspace' / '数据速查'
        workspace = moved_root / 'output_file' / 'workspace.json'
        workspace.parent.mkdir(parents=True)
        workspace.write_text(json.dumps(saved), encoding='utf-8')
        self.assertEqual(source_config(moved_root)['folder'], str(moved_root.parent.resolve() / '共享数据' / '订单汇总'))
        with tempfile.TemporaryDirectory() as outside:
            external = Path(outside).resolve() / 'outside-source'
            self.assertEqual(portable_source_config(self.root, external)['folder'], str(external))


if __name__ == "__main__":
    unittest.main()
