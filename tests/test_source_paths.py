"""Resolve private state and shared Excel roots independently."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from runtime_paths import DATA_DIR_ENV, SOURCE_BASE_ENV, data_dir, external_data_configured, source_base
from source_paths import shared_data_root


class SourcePathTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.parent = Path(temporary.name).resolve()
        self.root = self.parent / '数据速查'
        self.root.mkdir()
        self.central = self.parent / '工作台数据'
        env = patch.dict(os.environ, {
            'SHARED_DATA_ROOT': '', 'PLANHUB_DATA_ROOT': '', DATA_DIR_ENV: '', SOURCE_BASE_ENV: '',
        })
        env.start()
        self.addCleanup(env.stop)

    def test_standalone_uses_centralized_state_without_a_local_input_fallback(self):
        (self.root / 'input_file').mkdir()
        self.assertFalse(external_data_configured())
        self.assertEqual(data_dir(self.root), self.central / 'database' / 'quicklook')
        self.assertIsNone(shared_data_root(self.root))

    def test_explicit_state_survives_two_release_locations(self):
        state = self.root / 'output_file'
        state.mkdir()
        with patch.dict(os.environ, {DATA_DIR_ENV: str(state)}):
            for version in ('first', 'second'):
                release = self.parent / 'releases' / version / 'payload'
                release.mkdir(parents=True)
                self.assertTrue(external_data_configured())
                self.assertEqual(data_dir(release), state)
                self.assertEqual(source_base(release), self.root)
                self.assertFalse((release / 'output_file').exists())

    def test_default_shared_root_is_independent_of_state_and_source_base_overrides(self):
        shared = self.central / 'shared'
        (shared / '原始销量').mkdir(parents=True)
        (shared / '订单汇总').mkdir()
        external_state = self.parent / 'private' / 'quicklook'
        configured_base = self.parent / 'unrelated' / 'source-base'
        for override in (
            {DATA_DIR_ENV: str(external_state)},
            {SOURCE_BASE_ENV: str(configured_base)},
            {DATA_DIR_ENV: str(external_state), SOURCE_BASE_ENV: str(configured_base)},
        ):
            with self.subTest(override=override), patch.dict(os.environ, override):
                self.assertEqual(shared_data_root(self.root), shared)

    def test_planhub_data_root_can_be_absolute_or_relative_to_project(self):
        central = self.parent / '自定义工作台数据'
        shared = central / 'shared'
        shared.mkdir(parents=True)
        for value in (str(central), '../自定义工作台数据', '~/自定义工作台数据'):
            with self.subTest(value=value), patch.dict(os.environ, {'PLANHUB_DATA_ROOT': value, 'HOME': str(self.parent), 'USERPROFILE': str(self.parent)}):
                self.assertEqual(shared_data_root(self.root), shared)
                self.assertEqual(data_dir(self.root), central / 'database' / 'quicklook')

    def test_explicit_shared_root_overrides_central_root_even_if_missing(self):
        (self.central / 'shared').mkdir(parents=True)
        explicit = self.parent / '外部共享数据'
        with patch.dict(os.environ, {'PLANHUB_DATA_ROOT': str(self.central), 'SHARED_DATA_ROOT': str(explicit)}):
            self.assertEqual(shared_data_root(self.root), explicit)
        self.assertFalse(explicit.exists())

    def test_explicit_relative_shared_root_uses_configured_source_base(self):
        state = self.parent / 'private' / 'quicklook'
        base = self.parent / 'source' / 'base'
        explicit = base.parent / '外部共享数据'
        with patch.dict(os.environ, {
            DATA_DIR_ENV: str(state), SOURCE_BASE_ENV: str(base),
            'SHARED_DATA_ROOT': '../外部共享数据',
        }):
            self.assertEqual(data_dir(self.root), state)
            self.assertEqual(source_base(self.root), base)
            self.assertEqual(shared_data_root(self.root), explicit)

    def test_legacy_warehouse_blocks_creation_of_an_empty_central_store(self):
        old_store = self.root / 'output_file'
        old_store.mkdir()
        (old_store / 'warehouse.db').touch()
        with self.assertRaisesRegex(RuntimeError, '旧持久数据尚未迁移'):
            data_dir(self.root)
        self.assertFalse(self.central.exists())


if __name__ == '__main__':
    unittest.main()
