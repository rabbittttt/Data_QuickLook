import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from openpyxl import Workbook
from server import original_sheet, workbook_info


class OriginalSheetTests(unittest.TestCase):
    def test_only_selected_sheet_cells_are_decoded_and_dimensions_are_verified(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source.xlsx'
            book = Workbook()
            book.active['B3'] = '=6+7'
            book.active.merge_cells('B3:D3')
            book.active['BK101'] = 42
            hidden = book.create_sheet('隐藏表')
            hidden.sheet_state = 'veryHidden'
            hidden['A1'] = 789
            book.save(source)
            book.close()

            for dimension in (b'<dimension ref="A1:A1"/>', b''):
                with self.subTest(dimension=dimension):
                    path = root / 'preview.xlsx'
                    with ZipFile(source) as original, ZipFile(path, 'w') as fixture:
                        for name in original.namelist():
                            content = original.read(name)
                            if name == 'xl/worksheets/sheet1.xml':
                                content = content.replace(b'<dimension ref="B3:BK101"/>', dimension)
                                content = content.replace(b'<f>6+7</f><v></v>', b'<f>6+7</f><v>13</v>')
                            if name == 'xl/worksheets/sheet2.xml':
                                # The other sheet's header is usable, but decoding its cells fails.
                                content = content.replace(b'<v>789</v>', b'<v>broken-number</v>')
                            fixture.writestr(name, content)

                    before = path.read_bytes()
                    preview = original_sheet(path)
                    self.assertEqual(preview['sheets'], ['Sheet', '隐藏表'])
                    self.assertEqual(preview['rows'][2][1], 13)
                    self.assertEqual(preview['merges'], [[2, 3, 4, 3]])
                    self.assertEqual((preview['max_row'], preview['max_col']), (101, 63))
                    wide_page = original_sheet(path, page_columns=60)
                    self.assertEqual(len(wide_page['rows'][2]), 60)
                    self.assertEqual(wide_page['rows'][2][1], 13)
                    last = original_sheet(path, start=1000, column=1000)
                    self.assertEqual((last['start'], last['column'], last['rows']), (101, 63, [[42]]))
                    self.assertEqual(path.read_bytes(), before)

    def test_unrecognized_sheets_positions_and_paging(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'source.xlsx'
            book = Workbook()
            sheet = book.active
            sheet.title = '原表'
            sheet['B3'] = '标题'
            sheet.merge_cells('B3:D3')
            sheet['BK101'] = 42
            book.create_sheet('只有说明')['A1'] = '无需识别也能看见'
            book.save(path)
            before = path.read_bytes()
            first = original_sheet(path)
            self.assertEqual(first['rows'][2][1], '标题')
            self.assertEqual(first['merges'], [[2, 3, 4, 3]])
            self.assertIn('只有说明', first['sheets'])
            page = original_sheet(path, '原表', 101, 63)
            self.assertEqual(page['rows'], [[42]])
            self.assertEqual(original_sheet(path, '只有说明')['rows'][0][0], '无需识别也能看见')
            self.assertEqual(before, path.read_bytes())

    def test_missing_sheet_recovers_directory_without_reusing_old_region(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'changed.xlsx'
            book = Workbook()
            book.active.title = '汇总说明'
            book.active['A1'] = '当前版本'
            for index in range(1, 20):
                book.create_sheet(f'实际工作表{index}')
            book.save(path)
            before = path.read_bytes()
            result = original_sheet(path, '小转大进度', 500, 60)
            self.assertEqual(len(result['sheets']), 20)
            self.assertEqual(result['missing_sheet'], '小转大进度')
            self.assertEqual(result['sheet'], '汇总说明')
            self.assertEqual((result['start'], result['column']), (1, 1))
            self.assertEqual(result['rows'][0][0], '当前版本')
            self.assertIn('已不存在', result['warning'])
            self.assertEqual(workbook_info(path)['sheets'], result['sheets'])
            self.assertEqual(before, path.read_bytes())


if __name__ == '__main__':
    unittest.main()
