import json
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import BoundedSemaphore, Thread
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

import pandas as pd

import server
from excel_parser import ParsedTable
from warehouse import Warehouse


class QuietHandler(server.Handler):
    def log_message(self, *_args):
        pass


class SearchHTTPTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.store = Warehouse(self.root / 'test.db')
        for key, value in {'STORE': self.store, 'DATA_DIR': self.root, 'ROOT': self.root,
                           'PUBLIC_PREFIX': '/quicklook/', 'SHARED_FILES': frozenset()}.items():
            environment = patch.object(server, key, value)
            environment.start()
            self.addCleanup(environment.stop)
        self.http = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        worker = Thread(target=self.http.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(worker.join, 5)
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)

    def add_table(self, file, title, values):
        path = self.root / 'uploads' / file
        path.parent.mkdir(exist_ok=True)
        path.touch()
        frame = pd.DataFrame({'备注': values, '数量': range(len(values))})
        self.store._replace_file(path, [ParsedTable(path, '明细', title, 'A1:B9', frame, 1)], 'fixture')

    def search(self, terms):
        connection = HTTPConnection('127.0.0.1', self.http.server_port, timeout=5)
        try:
            connection.request('GET', '/quicklook/api/search?' + urlencode({'q': terms}))
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_metadata_and_unicode_cell_terms_return_matching_example_rows(self):
        self.add_table('a.xlsx', 'Region', ['other', 'Berliner Straße'])
        self.add_table('b.xlsx', 'Other', ['Berliner Straße', 'Region'])
        self.add_table('z.xlsx', 'REGION Strasse', ['sample'] * 5)
        with (
            patch.object(self.store, 'load', side_effect=AssertionError('Search must not load a full DataFrame')),
            patch.object(self.store, 'uploaded_files', side_effect=AssertionError('Search must only stat matching files')),
        ):
            status, result = self.search('REGION STRASSE')
        self.assertEqual(status, 200)
        self.assertEqual(result['found_count'], 2)
        self.assertFalse(result['content_truncated'])
        self.assertEqual([hit['table']['file_name'] for hit in result['hits']], ['z.xlsx', 'a.xlsx'])
        self.assertEqual(len(result['hits'][0]['rows']), 3)
        self.assertEqual(result['hits'][1]['rows'], [{
            '_文件': 'a.xlsx', '_Sheet': '明细', '_数据表': 'Region',
            '_source_row': 3, '备注': 'Berliner Straße', '数量': 1,
        }])
        self.assertFalse(result['hits'][1]['table']['archived'])
        self.assertNotIn('sql_table', result['hits'][1]['table'])

    def test_cell_limits_are_reported_and_metadata_matches_never_depend_on_them(self):
        self.add_table('a.xlsx', 'First', ['other', 'needle'])
        self.add_table('b.xlsx', 'Second', ['needle'])
        self.add_table('z.xlsx', 'Needle', ['metadata only'])
        with patch.object(server, 'SEARCH_ROW_LIMIT', 1), patch.object(server, 'SEARCH_TABLE_ROW_LIMIT', 1):
            status, result = self.search('needle')
        self.assertEqual(status, 200)
        self.assertTrue(result['content_truncated'])
        self.assertFalse(result['results_truncated'])
        self.assertEqual([hit['table']['file_name'] for hit in result['hits']], ['z.xlsx'])

    def test_result_limit_discloses_total_known_metadata_matches(self):
        self.add_table('a.xlsx', 'needle', ['one'])
        self.add_table('b.xlsx', 'needle', ['two'])
        with patch.object(server, 'SEARCH_RESULT_LIMIT', 1):
            status, result = self.search('needle')
        self.assertEqual(status, 200)
        self.assertEqual(len(result['hits']), 1)
        self.assertEqual(result['found_count'], 2)
        self.assertTrue(result['results_truncated'])
        self.assertFalse(result['content_truncated'])

    def test_extra_requests_are_rejected_instead_of_queuing(self):
        slots = BoundedSemaphore(1)
        with patch.object(server, 'SEARCH_SLOTS', slots):
            with slots:
                status, result = self.search('needle')
                self.assertEqual(status, 429)
                self.assertIn('重试', result['error'])
            self.assertEqual(self.search('needle')[0], 200)
            self.assertEqual(self.search('x' * (server.SEARCH_QUERY_LIMIT + 1))[0], 400)


if __name__ == '__main__':
    unittest.main()
