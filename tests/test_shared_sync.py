import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from openpyxl import Workbook

from excel_parser import parser_revision
from shared_sync import SharedFileMonitor
from warehouse import Warehouse, discover_tables, file_signature, scan_source_files


class SharedSyncTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.shared = self.root / 'shared'
        self.shared.mkdir()
        self.path = self.shared / 'sales.xlsx'
        self.store = Warehouse(self.root / 'warehouse.db')
        self.now = 0
        self.monitor = SharedFileMonitor(lambda: [self.shared], self.store.file_versions, lambda: self.now)
        self.write(100)

    def write(self, value):
        book = Workbook()
        book.active.append(['Model', 'Sales'])
        book.active.append(['M8', value])
        book.active.append(['M9', 200])
        book.save(self.path)
        book.close()

    def check(self, now):
        self.now = now
        return self.monitor.check()

    def test_parser_upgrade_reimports_unchanged_shared_file_and_preserves_on_failure(self):
        self.store.sync_files([self.path])
        original=self.path.read_bytes()
        old_versions=self.store.file_versions()
        with patch('warehouse.PARSER_VERSION','new-parser-version'):
            self.assertEqual(self.check(0),({},60))
            ready,_=self.check(60)
            self.assertIn(self.path,ready)
            with patch('warehouse.discover_tables',side_effect=ValueError('new parser failed')):
                result=self.store.sync_files(list(ready),expected_signatures=ready)
            self.assertTrue(result.errors)
            self.assertEqual(self.store.file_versions(),old_versions)
            self.assertEqual(self.store.load(self.store.catalog().iloc[0].id).iloc[0]['Sales'],100)
            with patch('warehouse.discover_tables',wraps=discover_tables) as parse:
                self.assertFalse(self.store.sync_files([self.path]).errors)
                self.assertEqual(parse.call_count,1)
                self.store.sync_files([self.path])
                self.assertEqual(parse.call_count,1,'Same parser and input must reuse the successful import')
        self.assertEqual(self.path.read_bytes(),original)

    def test_parser_fingerprint_tracks_content_and_ignores_runtime_data(self):
        source=self.root/'source';source.mkdir()
        names=('excel_parser.py','warehouse.py','runtime_paths.py','requirements.txt')
        for name in names:(source/name).write_text('v1')
        original=parser_revision(source)
        (source/'warehouse.db').write_bytes(b'private fixture')
        self.assertEqual(parser_revision(source),original)
        import shutil
        moved=self.root/'moved';shutil.copytree(source,moved)
        self.assertEqual(parser_revision(moved),original)
        for name in names:
            (moved/name).write_text('v2')
            self.assertNotEqual(parser_revision(moved),original)
            (moved/name).write_text('v1')

    def test_five_minute_scan_and_one_minute_confirmation_are_separate(self):
        with patch('shared_sync.scan_source_files', wraps=scan_source_files) as scan:
            self.assertEqual(self.check(0), ({}, 60))
            self.assertEqual(self.check(59), ({}, 1))
            ready, delay = self.check(60)
            self.assertEqual(ready, {self.path: file_signature(self.path)})
            self.assertEqual(delay, 240)
            self.assertEqual(scan.call_count, 1)
            self.assertEqual(self.store.sync_files(list(ready), expected_signatures=ready).errors, [])
            self.assertEqual(self.check(300), ({}, 300))
            self.assertEqual(scan.call_count, 2)
            self.write(999)
            self.assertEqual(self.check(599), ({}, 1))
            self.assertEqual(scan.call_count, 2)
            self.assertEqual(self.check(600), ({}, 60))
            self.assertEqual(scan.call_count, 3)

    def test_continued_saves_restart_stability_timer(self):
        self.check(0)
        self.write(999)
        self.assertEqual(self.check(60), ({}, 60))
        self.assertEqual(self.check(119), ({}, 1))
        ready, _ = self.check(120)
        self.assertEqual(ready, {self.path: file_signature(self.path)})
        self.store.sync_files(list(ready), expected_signatures=ready)
        table = self.store.catalog().iloc[0]
        self.assertEqual(self.store.load(table.id).iloc[0]['Sales'], 999)

    def test_a_change_while_queued_or_parsing_preserves_previous_data(self):
        self.store.sync_files([self.path])
        self.write(300)
        self.check(0)
        ready, _ = self.check(60)
        self.write(999)
        result = self.store.sync_files(list(ready), expected_signatures=ready)
        self.assertTrue(result.errors)
        table = self.store.catalog().iloc[0]
        self.assertEqual(self.store.load(table.id).iloc[0]['Sales'], 100)

        expected = {self.path: file_signature(self.path)}
        def saving_during_parse(path, **kwargs):
            tables = discover_tables(path, **kwargs)
            self.write(500)
            return tables
        with patch('warehouse.discover_tables', side_effect=saving_during_parse):
            result = self.store.sync_files([self.path], expected_signatures=expected)
        self.assertTrue(result.errors)
        self.assertEqual(self.store.load(table.id).iloc[0]['Sales'], 100)

    def test_unavailable_shared_source_keeps_imported_data_and_recovers(self):
        self.store.sync_files([self.path])
        self.write(300)
        self.check(0)
        moved = self.root / 'offline'
        self.shared.rename(moved)
        self.assertEqual(self.check(60)[0], {})
        self.assertEqual(len(self.store.catalog()), 1)
        self.assertTrue(self.monitor.errors)
        moved.rename(self.shared)
        self.assertEqual(self.check(300), ({}, 60))
        ready, _ = self.check(360)
        self.assertIn(self.path, ready)

    def test_restart_observes_new_versions_again_and_ignores_other_local_folders(self):
        self.check(0)
        self.monitor = SharedFileMonitor(lambda: [self.shared], self.store.file_versions, lambda: self.now)
        self.assertEqual(self.check(50), ({}, 60))
        self.assertEqual(self.check(109)[0], {})
        self.assertEqual(list(self.check(110)[0]), [self.path])
        other = self.root / 'input_file'
        other.mkdir()
        (other / 'not-uploaded.xlsx').write_bytes(self.path.read_bytes())
        self.assertEqual(list(self.check(350)[0]), [])
        self.assertEqual(list(self.monitor.pending), [self.path])


if __name__ == '__main__':
    unittest.main()
