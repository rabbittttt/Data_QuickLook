"""Shared roots and local Excel folders are scanned without merging identities."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from openpyxl import Workbook

import warehouse
from warehouse import Warehouse, scan_source_files


def save_workbook(path, amount):
    path.parent.mkdir(parents=True, exist_ok=True)
    book = Workbook()
    book.active.append(['车型', '销量'])
    book.active.append(['M8', amount])
    book.active.append(['M9', amount + 1])
    try:
        book.save(path)
    finally:
        book.close()


class MultiSourceScanTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.shared = self.root / '共享数据'
        self.local = self.root / '数据速查' / 'input_file'
        self.local.mkdir(parents=True)
        self.store = Warehouse(self.root / 'test.db')

    def test_all_shared_categories_and_local_inputs_have_distinct_identities(self):
        sources = [self.shared / name for name in ['原始销量', '订单汇总', '车型信息', 'SOP计划']]
        sources.append(self.local)
        for index, source in enumerate(sources):
            # Equal basenames must remain separate sources, not overwrite rows.
            save_workbook(source / 'nested' / '经营数据.xlsx', 100 * (index + 1))
        result = self.store.sync(sources)
        self.assertEqual(result.files, 5)
        self.assertEqual(result.tables, 5)
        self.assertEqual(result.rows, 10)
        self.assertEqual(result.errors, [])
        catalog = self.store.catalog()
        self.assertEqual(len(set(catalog.id)), 5)
        self.assertEqual(len(set(catalog.file_path)), 5)
        self.assertEqual(sorted(self.store.load(row.id)['销量'].iloc[0] for row in catalog.itertuples()),
                         [100, 200, 300, 400, 500])

    def test_repeated_and_overlapping_roots_parse_each_resolved_file_once(self):
        orders = self.shared / '订单汇总'
        save_workbook(orders / 'first.xlsx', 100)
        save_workbook(self.shared / 'SOP计划' / 'second.xlsx', 200)
        original = warehouse.discover_tables
        with patch.object(warehouse, 'discover_tables', wraps=original) as discover:
            result = self.store.sync([self.shared, orders, self.shared / '.', str(orders)])
        self.assertEqual(result.files, 2)
        self.assertEqual(result.tables, 2)
        self.assertEqual(discover.call_count, 2)
        self.assertEqual(result.errors, [])

    def test_missing_and_unreadable_sources_do_not_block_healthy_sources(self):
        valid = self.shared / '订单汇总'
        inaccessible = self.shared / '不可访问'
        missing = self.shared / '未挂载'
        inaccessible.mkdir(parents=True)
        save_workbook(valid / 'current.xlsx', 100)
        original = warehouse.scan_excel_files

        def scan(path):
            if Path(path) == inaccessible.resolve():
                raise PermissionError('access denied')
            return original(path)

        with patch.object(warehouse, 'scan_excel_files', side_effect=scan):
            result = self.store.sync([missing, inaccessible, valid])
        self.assertEqual(result.files, 1)
        self.assertEqual(result.tables, 1)
        self.assertEqual(len(result.errors), 2)
        self.assertTrue(any(str(missing.resolve()) in error for error in result.errors))
        self.assertTrue(any(str(inaccessible.resolve()) in error and 'access denied' in error for error in result.errors))

    def test_source_updates_and_removals_keep_unrelated_and_historical_data(self):
        shared_file = self.shared / '订单汇总' / 'orders.xlsx'
        local_file = self.local / 'local.xlsx'
        save_workbook(shared_file, 100)
        save_workbook(local_file, 200)
        sources = [shared_file.parent, self.local]
        self.store.sync(sources)
        before = {row.file_name: row for row in self.store.catalog().itertuples()}
        save_workbook(shared_file, 999)
        self.store.sync(sources)
        after = {row.file_name: row for row in self.store.catalog().itertuples()}
        self.assertEqual(after['orders.xlsx'].id, before['orders.xlsx'].id)
        self.assertNotEqual(after['orders.xlsx'].scanned_at, before['orders.xlsx'].scanned_at)
        self.assertEqual(after['local.xlsx'].scanned_at, before['local.xlsx'].scanned_at)
        self.assertEqual(self.store.load(after['orders.xlsx'].id)['销量'].iloc[0], 999)
        shared_file.unlink()
        result = self.store.sync(sources)
        self.assertEqual(result.files, 1)
        self.assertEqual(result.tables, 2, 'a removed source remains historical data')
        self.assertEqual(self.store.load(after['orders.xlsx'].id)['销量'].iloc[0], 999)
        self.assertEqual(self.store.load(after['local.xlsx'].id)['销量'].iloc[0], 200)

    def test_rebuild_forces_all_sources_without_changing_dataset_ids(self):
        shared_file = self.shared / '订单汇总' / 'shared.xlsx'
        save_workbook(shared_file, 100)
        save_workbook(self.local / 'local.xlsx', 200)
        sources = [shared_file.parent, self.local]
        self.store.sync(sources)
        before = {row.id: row.scanned_at for row in self.store.catalog().itertuples()}
        result = self.store.rebuild(sources)
        after = {row.id: row.scanned_at for row in self.store.catalog().itertuples()}
        self.assertEqual(result.files, 2)
        self.assertEqual(set(before), set(after))
        self.assertTrue(all(after[key] != before[key] for key in before))

    def test_single_source_and_empty_multi_source_keep_clear_failure_contracts(self):
        missing = self.root / 'missing'
        with self.assertRaisesRegex(ValueError, '数据目录不存在'):
            self.store.sync(missing)
        result = self.store.sync([missing])
        self.assertEqual(result.files, 0)
        self.assertEqual(len(result.errors), 1)
        self.assertEqual(scan_source_files([]), ([], []))


if __name__ == '__main__':
    unittest.main()
