"""Moving a workspace preserves shared-source identities without merging history."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

from openpyxl import Workbook

import excel_parser
import warehouse
from warehouse import Warehouse


def save_workbook(path, amount=10):
    path.parent.mkdir(parents=True, exist_ok=True)
    book = Workbook()
    book.active.append(['车型', '销量'])
    book.active.append(['M8', amount])
    book.active.append(['M9', amount + 1])
    try:
        book.save(path)
    finally:
        book.close()


class WorkspaceRelocationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='lookup-relocation-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.old_root = self.root / 'old-workspace'
        self.new_root = self.root / 'moved-workspace'
        self.shared = self.new_root / '共享数据'
        self.rules_path = self.root / 'recognition.json'
        overrides = patch.object(excel_parser, 'OVERRIDES', self.rules_path)
        overrides.start()
        self.addCleanup(overrides.stop)
        self.store = Warehouse(self.root / 'warehouse.db')

    def metadata(self):
        with self.store.connect() as connection:
            datasets = [dict(row) for row in connection.execute('SELECT * FROM datasets ORDER BY id')]
            versions = [dict(row) for row in connection.execute('SELECT * FROM file_versions ORDER BY path')]
        return datasets, versions

    def moved_source(self, relative=Path('订单汇总') / 'nested' / 'orders.xlsx'):
        old_file = self.old_root / '共享数据' / relative
        save_workbook(old_file)
        result = self.store.sync(old_file.parent)
        self.assertEqual((result.files, result.tables, result.errors), (1, 1, []))
        original = self.metadata()[0][0]
        # Both workspaces are children of this test's isolated temporary root.
        self.assertEqual(self.old_root.parent, self.root)
        self.assertEqual(self.new_root.parent, self.root)
        self.old_root.rename(self.new_root)
        return old_file, self.shared / relative, original

    @staticmethod
    def rule(path, name='fixture'):
        return {'file': str(path), 'sheet': 'Sheet', 'range': 'A1:B3',
                'name': name, 'original': 'A1:B3'}

    @staticmethod
    def rule_key(path):
        return str(path) + '|Sheet|A1'

    def write_rules(self, rules):
        self.rules_path.write_text(json.dumps(rules, ensure_ascii=False), encoding='utf-8')

    def assert_skipped_without_changes(self, old_file, **options):
        before = self.metadata()
        database_before = self.store.path.read_bytes()
        rules_before = self.rules_path.read_bytes() if self.rules_path.exists() else None
        result = self.store.relocate_shared_sources(self.shared, dry_run=False, **options)
        self.assertEqual((result['files'], result['datasets']), (0, 0))
        self.assertEqual(result['mappings'], [])
        self.assertTrue(any(item['path'] == str(old_file) and item['reason']
                            for item in result['skipped']), result)
        self.assertEqual(self.metadata(), before)
        self.assertEqual(self.store.path.read_bytes(), database_before)
        if rules_before is not None:
            self.assertEqual(self.rules_path.read_bytes(), rules_before)
        return result

    def test_dry_run_is_default_and_never_writes_metadata_or_rules(self):
        old_file, new_file, original = self.moved_source()
        self.write_rules({self.rule_key(old_file): self.rule(old_file)})
        before = self.metadata()
        database_before = self.store.path.read_bytes()
        rules_before = self.rules_path.read_bytes()
        result = self.store.relocate_shared_sources(self.shared, rules_path=self.rules_path)
        self.assertEqual(result['mappings'], [
            {'old_path': str(old_file), 'new_path': str(new_file), 'datasets': 1},
        ])
        self.assertEqual((result['files'], result['datasets'], result['rules_added']), (1, 1, 1))
        self.assertFalse(result['applied'])
        self.assertEqual(self.metadata(), before)
        self.assertEqual(self.store.path.read_bytes(), database_before)
        self.assertEqual(self.rules_path.read_bytes(), rules_before)
        self.assertEqual(self.store.load(original['id'])['销量'].iloc[0], 10)

    def test_move_and_later_file_update_preserve_dataset_and_sql_table_ids(self):
        old_file, new_file, original = self.moved_source()
        result = self.store.relocate_shared_sources(self.shared, dry_run=False)
        self.assertTrue(result['applied'])
        self.assertEqual((result['files'], result['datasets']), (1, 1))
        migrated, versions = self.metadata()
        self.assertEqual(len(migrated), 1)
        self.assertEqual(migrated[0]['file_path'], str(new_file))
        self.assertEqual(migrated[0]['id'], original['id'])
        self.assertEqual(migrated[0]['sql_table'], original['sql_table'])
        self.assertEqual([item['path'] for item in versions], [str(new_file)])
        stat = new_file.stat()
        save_workbook(new_file, 999)
        os.utime(new_file, ns=(stat.st_atime_ns, stat.st_mtime_ns + 2_000_000_000))
        updated = self.store.sync(self.shared)
        self.assertEqual((updated.files, updated.tables, updated.errors), (1, 1, []))
        current = self.metadata()[0][0]
        self.assertEqual((current['id'], current['sql_table']),
                         (original['id'], original['sql_table']))
        self.assertEqual(self.store.load(original['id'])['销量'].iloc[0], 999)
        with self.store.connect() as connection:
            tables = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'data_*'").fetchall()
        self.assertEqual([row[0] for row in tables], [original['sql_table']])
        self.assertFalse(old_file.exists())

    def test_repeated_migration_and_sync_are_idempotent_without_reimport(self):
        _, _, original = self.moved_source()
        self.store.relocate_shared_sources(self.shared, dry_run=False)
        before = self.metadata()
        result = self.store.relocate_shared_sources(self.shared, dry_run=False)
        self.assertEqual((result['files'], result['datasets'], result['rules_added']), (0, 0, 0))
        with patch.object(warehouse, 'discover_tables', side_effect=AssertionError('unchanged file was reparsed')):
            synced = self.store.sync(self.shared)
        self.assertEqual((synced.files, synced.tables, synced.errors), (1, 1, []))
        self.assertEqual(self.metadata(), before)
        self.assertEqual(self.store.load(original['id'])['销量'].iloc[0], 10)

    def test_private_input_history_is_not_rebound_to_same_named_shared_file(self):
        old_file = self.old_root / '数据速查' / 'input_file' / 'orders.xlsx'
        save_workbook(old_file, 500)
        self.store.sync(old_file.parent)
        self.old_root.rename(self.new_root)
        save_workbook(self.shared / '订单汇总' / 'orders.xlsx', 500)
        before = self.metadata()
        result = self.store.relocate_shared_sources(self.shared, dry_run=False)
        self.assertEqual((result['files'], result['datasets']), (0, 0))
        self.assertEqual(self.metadata(), before)
        self.assertEqual(self.metadata()[0][0]['file_path'], str(old_file))

    def test_missing_source_is_not_a_workspace_move_when_old_root_still_exists(self):
        old_file, _, _ = self.moved_source()
        self.old_root.mkdir()
        self.assertFalse(old_file.exists())
        self.assert_skipped_without_changes(old_file)

    def test_destination_outside_active_sources_is_not_migrated(self):
        old_file, _, _ = self.moved_source()
        allowed = self.shared / 'SOP计划'
        allowed.mkdir()
        self.assert_skipped_without_changes(old_file, active_sources=[allowed])

    def test_ambiguous_shared_anchor_is_not_migrated(self):
        old_file, _, _ = self.moved_source(Path('订单汇总') / '共享数据' / 'orders.xlsx')
        self.assert_skipped_without_changes(old_file)

    def test_any_signature_difference_including_parser_version_is_rejected(self):
        old_file, new_file, _ = self.moved_source()
        stat = new_file.stat()
        signatures = [f'{stat.st_mtime_ns + 1}:{stat.st_size}:{excel_parser.PARSER_VERSION}',
                      f'{stat.st_mtime_ns}:{stat.st_size + 1}:{excel_parser.PARSER_VERSION}',
                      f'{stat.st_mtime_ns}:{stat.st_size}:older-parser', 'malformed']
        for signature in signatures:
            with self.subTest(signature=signature):
                with self.store.connect() as connection:
                    connection.execute('UPDATE file_versions SET signature=? WHERE path=?',
                                       (signature, str(old_file)))
                self.assert_skipped_without_changes(old_file)

    def test_existing_destination_version_is_not_merged(self):
        old_file, new_file, _ = self.moved_source()
        with self.store.connect() as connection:
            connection.execute('INSERT INTO file_versions SELECT ?, signature FROM file_versions WHERE path=?',
                               (str(new_file), str(old_file)))
        self.assert_skipped_without_changes(old_file)

    def test_existing_destination_dataset_is_not_merged_even_without_version(self):
        old_file, new_file, _ = self.moved_source()
        self.store.sync(self.shared)
        with self.store.connect() as connection:
            connection.execute('DELETE FROM file_versions WHERE path=?', (str(new_file),))
        self.assertEqual(len(self.metadata()[0]), 2)
        self.assert_skipped_without_changes(old_file)

    def test_two_missing_workspaces_mapping_to_one_destination_are_both_skipped(self):
        relative = Path('共享数据') / '订单汇总' / 'orders.xlsx'
        first = self.old_root / relative
        second_root = self.root / 'another-old-workspace'
        second = second_root / relative
        save_workbook(first)
        second.parent.mkdir(parents=True)
        shutil.copy2(first, second)
        self.store.sync([first.parent, second.parent])
        self.old_root.rename(self.new_root)
        second_root.rename(self.root / 'unrelated-copy')
        result = self.assert_skipped_without_changes(first)
        self.assertTrue(any(item['path'] == str(second) and item['reason'] for item in result['skipped']))
        self.assertEqual(len(self.metadata()[0]), 2)

    def test_rules_are_copied_for_new_path_while_old_rules_remain(self):
        old_file, new_file, _ = self.moved_source()
        original = {self.rule_key(old_file): self.rule(old_file),
                    'unrelated': {'file': str(self.root / 'external.xlsx'), 'name': 'untouched'}}
        self.write_rules(original)
        result = self.store.relocate_shared_sources(self.shared, rules_path=self.rules_path, dry_run=False)
        self.assertEqual(result['rules_added'], 1)
        saved = json.loads(self.rules_path.read_text(encoding='utf-8'))
        self.assertEqual(saved, {**original, self.rule_key(new_file): self.rule(new_file)})
        rules_before = self.rules_path.read_bytes()
        second = self.store.relocate_shared_sources(self.shared, rules_path=self.rules_path, dry_run=False)
        self.assertEqual(second['rules_added'], 0)
        self.assertEqual(self.rules_path.read_bytes(), rules_before)

    def test_conflicting_destination_rule_skips_entire_file_without_changes(self):
        old_file, new_file, _ = self.moved_source()
        self.write_rules({self.rule_key(old_file): self.rule(old_file),
                          self.rule_key(new_file): self.rule(new_file, name='different-existing-rule')})
        self.assert_skipped_without_changes(old_file, rules_path=self.rules_path)

    def check_server_startup_in_isolated_copy(self, bind_fails):
        project = self.root / 'server-copy'
        project.mkdir()
        for source in Path(__file__).resolve().parents[1].glob('*.py'):
            shutil.copy2(source, project / source.name)
        shared = self.root / '共享数据'
        shared.mkdir()
        script = textwrap.dedent('''
            import sys
            from pathlib import Path
            from unittest.mock import patch
            import server

            # Import constructs a Warehouse, so import only the disposable copy.
            assert server.ROOT == Path.cwd().resolve()
            assert server.STORE.path.is_relative_to(server.ROOT)
            bind_fails = sys.argv[1] == 'fail'
            shared = server.ROOT.parent / '共享数据'
            expected_sources = [shared / name for name in ('订单汇总', '原始销量', '车型信息', 'SOP计划')]
            expected_sources.append(server.ROOT / 'input_file')
            events = []

            class FakeServer:
                def __init__(self, address, handler):
                    events.append('bind')
                    assert address == ('127.0.0.1', 8765)
                    assert handler is server.Handler
                    if bind_fails:
                        raise OSError('fixture port unavailable')
                def __enter__(self):
                    return self
                def __exit__(self, *args):
                    pass
                def serve_forever(self):
                    events.append('serve')

            class FakeThread:
                def __init__(self, *, target, daemon):
                    assert target is server.watch and daemon is True
                    events.append('thread-created')
                def start(self):
                    events.append('watch-start')

            def relocate(root, **options):
                events.append('relocate')
                assert root == shared
                assert options == {'active_sources': expected_sources,
                                   'rules_path': server.ROOT / 'output_file' / 'recognition.json',
                                   'dry_run': False}, options
                return {'files': 0, 'datasets': 0, 'applied': False}

            with patch.object(server, 'WorkbenchHTTPServer', FakeServer), \\
                 patch.object(server.threading, 'Thread', FakeThread), \\
                 patch.object(server.STORE, 'relocate_shared_sources', side_effect=relocate) as migration, \\
                 patch('builtins.print'):
                if bind_fails:
                    try:
                        server.run_server()
                    except OSError as error:
                        assert str(error) == 'fixture port unavailable'
                    else:
                        raise AssertionError('bind failure must propagate')
                    migration.assert_not_called()
                    assert events == ['bind'], events
                else:
                    server.run_server()
                    migration.assert_called_once()
                    assert events == ['bind', 'relocate', 'thread-created', 'watch-start', 'serve'], events
        ''')
        environment = {**os.environ, 'PYTHONPATH': '', 'SHARED_DATA_ROOT': '../共享数据',
                       'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONUTF8': '1'}
        result = subprocess.run([sys.executable, '-B', '-c', script, 'fail' if bind_fails else 'success'],
                                cwd=project, env=environment, capture_output=True,
                                text=True, encoding='utf-8', timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_server_migrates_after_binding_and_before_starting_watch(self):
        self.check_server_startup_in_isolated_copy(bind_fails=False)

    def test_server_binding_failure_does_not_migrate_or_start_watch(self):
        self.check_server_startup_in_isolated_copy(bind_fails=True)


if __name__ == '__main__':
    unittest.main()
