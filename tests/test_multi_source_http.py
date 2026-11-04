"""Exercise multi-source browsing and imports against disposable local sources."""
from contextlib import ExitStack
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from io import BytesIO
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from openpyxl import Workbook

import server
from warehouse import Warehouse


def workbook_bytes(value):
    book = Workbook()
    book.active.title = '销量'
    book.active.append(['车型', '销量'])
    book.active.append(['M8', value])
    book.active.append(['M9', value + 1])
    output = BytesIO()
    try:
        book.save(output)
        return output.getvalue()
    finally:
        book.close()
        output.close()


def wait_until(predicate, timeout=5):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError('Timed out waiting for background sync')
        time.sleep(0.01)


class QuietHandler(server.Handler):
    def log_message(self, *_args):
        pass


class MultiSourceHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.parent = Path(self.temporary.name).resolve()
        self.project = self.parent / '数据速查'
        self.local = self.project / 'input_file'
        self.shared = self.parent / '共享数据' / '订单汇总'
        self.outside = self.parent / '未接入目录'
        for folder in (self.local, self.shared, self.outside):
            folder.mkdir(parents=True)
        self.local_content = workbook_bytes(100)
        self.shared_content = workbook_bytes(200)
        (self.local / '同名.xlsx').write_bytes(self.local_content)
        (self.shared / '同名.xlsx').write_bytes(self.shared_content)
        self.config_file = self.project / 'output_file' / 'workspace.json'
        self.config_file.parent.mkdir(parents=True)
        self.config_file.write_text(json.dumps({
            'folder': 'input_file', 'folders': ['input_file', '../共享数据/订单汇总'],
            'auto': False,
        }, ensure_ascii=False), encoding='utf-8')
        self.store = Warehouse(self.config_file.parent / 'test.db')
        self.status = {'busy': False, 'errors': [], 'last_sync': None}
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(server, 'ROOT', self.project))
        self.stack.enter_context(patch.object(server, 'CONFIG', self.config_file))
        self.stack.enter_context(patch.object(server, 'STORE', self.store))
        self.stack.enter_context(patch.object(server, 'STATUS', self.status))
        self.stack.enter_context(patch.object(server, 'LOCK', threading.RLock()))
        self.stack.enter_context(patch.object(server, 'SYNC_LOCK', threading.Lock()))
        self.stack.enter_context(patch.dict(os.environ, {'SHARED_DATA_ROOT': ''}))
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.worker = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.worker.start()

    def tearDown(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
            self.worker.join(timeout=5)
            wait_until(lambda: not self.status['busy'])
        finally:
            self.stack.close()
            self.temporary.cleanup()

    def request(self, endpoint, *, method='GET', body=None, headers=None, **params):
        path = '/api/' + endpoint
        if params:
            path += '?' + urlencode(params)
        connection = HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def post_json(self, endpoint, payload):
        return self.request(endpoint, method='POST',
                            body=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                            headers={'Content-Type': 'application/json'})

    def sync(self):
        code, result = self.post_json('sync', {})
        self.assertEqual(code, 200, result)
        wait_until(lambda: not self.status['busy'])
        code, catalog = self.request('catalog')
        self.assertEqual(code, 200, catalog)
        return catalog

    def upload(self, folder, value=999, name='同名.xlsx', replace_version=None):
        content = workbook_bytes(value)
        params = {'filename': name, 'folder': str(folder)}
        if replace_version is not None:
            params['replace_version'] = replace_version
        return self.request('import', method='POST', body=content, headers={
            'Content-Type': 'application/octet-stream', 'Content-Length': str(len(content)),
        }, **params)

    def test_catalog_and_original_sheets_resolve_same_name_files_in_each_source(self):
        catalog = self.sync()
        self.assertEqual(catalog['status']['errors'], [])
        files = catalog['files']
        self.assertEqual(len(files), 2)
        self.assertEqual(len({file['id'] for file in files}), 2)
        self.assertEqual(len({file['name'] for file in files}), 2,
                         'same basenames must carry distinguishable source labels')
        self.assertEqual({Path(file['path']) for file in files},
                         {self.local / '同名.xlsx', self.shared / '同名.xlsx'})
        expected_values = {self.local: 100, self.shared: 200}
        for file in files:
            with self.subTest(path=file['path']):
                code, info = self.request('workbook', id=file['id'])
                self.assertEqual(code, 200, info)
                self.assertEqual(info['sheets'], ['销量'])
                code, sheet = self.request('sheet', id=file['id'], sheet='销量')
                self.assertEqual(code, 200, sheet)
                self.assertEqual(sheet['rows'][1][1], expected_values[Path(file['path']).parent])
        tables = catalog['tables']
        self.assertEqual(len(tables), 2)
        self.assertFalse(any(table['archived'] for table in tables))
        self.assertEqual(len({table['relative_path'] for table in tables}), 2)
        for table in tables:
            code, data = self.request('table', id=table['id'])
            self.assertEqual(code, 200, data)
            self.assertEqual(data['rows'][0]['销量'],
                             expected_values[Path(table['file_path']).parent])

    def test_config_saves_portable_multi_sources_and_selected_import_destination(self):
        code, result = self.post_json('config', {
            'folder': '../共享数据/订单汇总',
            'folders': ['input_file', '../共享数据/订单汇总'], 'auto': False,
        })
        self.assertEqual(code, 200, result)
        wait_until(lambda: not self.status['busy'])
        saved = json.loads(self.config_file.read_text(encoding='utf-8'))
        self.assertEqual(saved['folder'], '../共享数据/订单汇总')
        self.assertEqual(set(saved['folders']), {'input_file', '../共享数据/订单汇总'})
        self.assertFalse(saved['auto'])
        code, catalog = self.request('catalog')
        self.assertEqual(code, 200, catalog)
        self.assertEqual(catalog['config']['folder'], str(self.shared))
        self.assertEqual(set(catalog['config']['folders']), {str(self.local), str(self.shared)})
        self.assertEqual(len(catalog['files']), 2)

    def test_invalid_config_cannot_save_missing_source_or_unlisted_import_destination(self):
        before = self.config_file.read_bytes()
        invalid = [
            {'folders': [], 'folder': str(self.local)},
            {'folders': [str(self.local), str(self.parent / '不存在')], 'folder': str(self.local)},
            {'folders': [str(self.local)], 'folder': str(self.outside)},
        ]
        for payload in invalid:
            with self.subTest(payload=payload):
                code, result = self.post_json('config', payload)
                self.assertEqual(code, 400, result)
                self.assertIn('error', result)
                self.assertEqual(self.config_file.read_bytes(), before)

    def test_import_only_overwrites_the_selected_source_after_confirmation(self):
        before = self.sync()
        shared_table = next(table for table in before['tables']
                            if Path(table['file_path']).parent == self.shared)
        code, conflict = self.upload(self.shared)
        self.assertEqual(code, 409, conflict)
        self.assertTrue(conflict['overwrite_required'])
        self.assertEqual((self.shared / '同名.xlsx').read_bytes(), self.shared_content)
        code, result = self.upload(self.shared, replace_version=conflict['version'])
        self.assertEqual(code, 201, result)
        self.assertTrue(result['overwritten'])
        self.assertEqual((self.local / '同名.xlsx').read_bytes(), self.local_content)
        after = self.sync()
        self.assertEqual(after['status']['errors'], [])
        self.assertEqual(len(after['files']), 2)
        code, data = self.request('table', id=shared_table['id'])
        self.assertEqual(code, 200, data)
        self.assertEqual(data['rows'][0]['销量'], 999)
        self.assertEqual((self.local / '同名.xlsx').read_bytes(), self.local_content)

    def test_import_rejects_unconfigured_folder_without_touching_files(self):
        code, result = self.upload(self.outside, name='不应保存.xlsx')
        self.assertEqual(code, 400, result)
        self.assertIn('error', result)
        self.assertEqual(list(self.outside.iterdir()), [])
        self.assertEqual((self.local / '同名.xlsx').read_bytes(), self.local_content)
        self.assertEqual((self.shared / '同名.xlsx').read_bytes(), self.shared_content)

    def test_removing_one_source_archives_only_its_history_and_preserves_other_source(self):
        before = self.sync()
        code, result = self.post_json('config', {'folder': str(self.local), 'auto': False})
        self.assertEqual(code, 200, result)
        wait_until(lambda: not self.status['busy'])
        code, after = self.request('catalog')
        self.assertEqual(code, 200, after)
        self.assertEqual(len(after['files']), 1)
        self.assertEqual(Path(after['files'][0]['path']).parent, self.local)
        self.assertEqual({table['id'] for table in after['tables']},
                         {table['id'] for table in before['tables']})
        for table in after['tables']:
            self.assertEqual(table['archived'], Path(table['file_path']).parent == self.shared)
        old_file = next(file for file in before['files'] if Path(file['path']).parent == self.shared)
        code, result = self.request('workbook', id=old_file['id'])
        self.assertEqual(code, 400, result)
        self.assertEqual((self.shared / '同名.xlsx').read_bytes(), self.shared_content)


if __name__ == '__main__':
    unittest.main()
