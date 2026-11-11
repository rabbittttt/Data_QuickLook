"""HTTP upload and queued-sync coverage using disposable workbooks only."""
from contextlib import ExitStack
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode
from zipfile import ZipFile

from openpyxl import Workbook

import server
from warehouse import ScanResult, Warehouse
from source_paths import source_config


def workbook_bytes(value=100):
    book = Workbook()
    book.active.title = '销量'
    book.active.append(['车型', '销量'])
    book.active.append(['M8', value])
    book.active.append(['M9', 200])
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
    def log_message(self, *args):
        pass


class FileImportHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.folder = self.root / 'uploads'
        self.folder.mkdir()
        self.store = Warehouse(self.root / 'test.db')
        self.status = {'busy': False, 'errors': [], 'last_sync': None}
        self.stack = ExitStack()
        self.stack.enter_context(patch.object(server, 'STORE', self.store))
        self.stack.enter_context(patch.object(server, 'DATA_DIR', self.root))
        self.stack.enter_context(patch.object(server, 'STATUS', self.status))
        self.stack.enter_context(patch.object(server, 'LOCK', threading.RLock()))
        self.stack.enter_context(patch.object(server, 'SYNC_LOCK', threading.Lock()))
        self.stack.enter_context(patch.object(server, 'config', return_value={
            'folder': str(self.folder), 'auto': False,
        }))
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
        self.worker = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.worker.start()
        self.content = workbook_bytes()

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
        url = '/api/' + endpoint
        if params:
            url += '?' + urlencode(params)
        connection = HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=5)
        try:
            connection.request(method, url, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_config_endpoint_rejects_local_folder_configuration(self):
        code, result = self.request('config', method='POST', body=b'{"folder":"input_file"}',
                                    headers={'Content-Type': 'application/json'})
        self.assertEqual(code, 404, result)

    def upload(self, name='销量.xlsx', content=None, *, folder=None, headers=None,
               replace_version=None):
        payload = self.content if content is None else content
        request_headers = {
            'Content-Type': 'application/octet-stream',
            'Content-Length': str(len(payload)),
        }
        request_headers.update(headers or {})
        params = {'filename': name, 'folder': str(self.folder if folder is None else folder)}
        if replace_version is not None:
            params['replace_version'] = replace_version
        return self.request('import', method='POST', body=payload, headers=request_headers, **params)

    def test_upload_keeps_original_bytes_then_manual_sync_exposes_tables(self):
        for name in ['销量.xlsx', '宏数据.xlsm', 'UPPER.XLSX']:
            with self.subTest(name=name):
                code, result = self.upload(name)
                self.assertEqual(code, 201, result)
                self.assertEqual(result, {'saved': True, 'name': name, 'overwritten': False})
                self.assertEqual((self.folder / name).read_bytes(), self.content)
        wait_until(lambda: not self.status['busy'])
        self.assertEqual(len(self.store.catalog()), 3, 'upload starts processing without a second API call')

        code, started = self.request('sync', method='POST', body=b'{}',
                                     headers={'Content-Type': 'application/json'})
        self.assertEqual(code, 200)
        self.assertTrue(started['started'])
        wait_until(lambda: not self.status['busy'])
        code, catalog = self.request('catalog')
        self.assertEqual(code, 200)
        self.assertEqual(catalog['status']['errors'], [])
        self.assertEqual(len(catalog['tables']), 3)
        file = next(file for file in catalog['files'] if file['name'] == '销量.xlsx')
        code, sheet = self.request('sheet', id=file['id'], sheet='销量')
        self.assertEqual(code, 200)
        self.assertEqual(sheet['rows'], [['车型', '销量'], ['M8', 100], ['M9', 200]])
        table = next(table for table in catalog['tables'] if table['file_name'] == '销量.xlsx')
        code, data = self.request('table', id=table['id'])
        self.assertEqual(code, 200)
        self.assertEqual(data['rows'][0]['销量'], 100)
        self.assertEqual((self.folder / '销量.xlsx').read_bytes(), self.content,
                         'importing and parsing must not rewrite source bytes')

    def test_same_name_requires_confirmation_and_never_creates_numbered_copies(self):
        original = self.folder / '销量.xlsx'
        original.write_bytes(self.content)
        other = self.folder / '其他.xlsx'
        other_content = workbook_bytes(777)
        other.write_bytes(other_content)
        incoming = workbook_bytes(999)
        version = None
        for token in [None, None, 'not-the-confirmed-version']:
            code, result = self.upload(content=incoming, replace_version=token)
            self.assertEqual(code, 409, result)
            self.assertTrue(result['overwrite_required'])
            self.assertEqual(result['name'], original.name)
            self.assertEqual(result['size'], len(self.content))
            self.assertIsInstance(result['version'], str)
            self.assertTrue(result['version'])
            if version is not None:
                self.assertEqual(result['version'], version)
            version = result['version']
            self.assertEqual(original.read_bytes(), self.content)
            self.assertEqual(other.read_bytes(), other_content)
            self.assertEqual({path.name for path in self.folder.iterdir()},
                             {'销量.xlsx', '其他.xlsx'})

    def test_confirmed_replace_preserves_dataset_id_and_sync_reads_new_values(self):
        code, result = self.upload()
        self.assertEqual(code, 201, result)
        code, _ = self.request('sync', method='POST', body=b'{}',
                               headers={'Content-Type': 'application/json'})
        self.assertEqual(code, 200)
        wait_until(lambda: not self.status['busy'])
        code, before = self.request('catalog')
        self.assertEqual(code, 200)
        self.assertEqual(len(before['tables']), 1)
        table_id = before['tables'][0]['id']
        code, data = self.request('table', id=table_id)
        self.assertEqual(data['rows'][0]['销量'], 100)

        incoming = workbook_bytes(999)
        code, conflict = self.upload(content=incoming)
        self.assertEqual(code, 409, conflict)
        code, result = self.upload(content=incoming, replace_version=conflict['version'])
        self.assertEqual(code, 201, result)
        self.assertEqual(result, {'saved': True, 'name': '销量.xlsx', 'overwritten': True})
        self.assertEqual((self.folder / '销量.xlsx').read_bytes(), incoming)
        self.assertEqual([path.name for path in self.folder.iterdir()], ['销量.xlsx'])
        wait_until(lambda: not self.status['busy'])
        code, data = self.request('table', id=table_id)
        self.assertEqual(data['rows'][0]['销量'], 999, 'confirmed upload triggers processing automatically')

        code, _ = self.request('sync', method='POST', body=b'{}',
                               headers={'Content-Type': 'application/json'})
        self.assertEqual(code, 200)
        wait_until(lambda: not self.status['busy'])
        code, after = self.request('catalog')
        self.assertEqual(code, 200)
        self.assertEqual(after['status']['errors'], [])
        self.assertEqual([table['id'] for table in after['tables']], [table_id])
        code, data = self.request('table', id=table_id)
        self.assertEqual(code, 200)
        self.assertEqual(data['rows'][0]['销量'], 999)
        self.assertEqual((self.folder / '销量.xlsx').read_bytes(), incoming)

    def test_changed_existing_file_requires_new_confirmation(self):
        original = self.folder / '销量.xlsx'
        original.write_bytes(self.content)
        incoming = workbook_bytes(999)
        code, first = self.upload(content=incoming)
        self.assertEqual(code, 409, first)
        independently_updated = workbook_bytes(345)
        original.write_bytes(independently_updated)

        code, second = self.upload(content=incoming, replace_version=first['version'])
        self.assertEqual(code, 409, second)
        self.assertTrue(second['overwrite_required'])
        self.assertNotEqual(second['version'], first['version'])
        self.assertEqual(second['size'], len(independently_updated))
        self.assertEqual(original.read_bytes(), independently_updated)
        self.assertEqual([path.name for path in self.folder.iterdir()], ['销量.xlsx'])

        code, result = self.upload(content=incoming, replace_version=second['version'])
        self.assertEqual(code, 201, result)
        self.assertTrue(result['overwritten'])
        self.assertEqual(original.read_bytes(), incoming)

    def test_invalid_confirmed_upload_keeps_original_and_cleans_temporary_files(self):
        original = self.folder / '销量.xlsx'
        original.write_bytes(self.content)
        code, conflict = self.upload(content=workbook_bytes(999))
        self.assertEqual(code, 409, conflict)
        malformed_sheet = BytesIO()
        with ZipFile(BytesIO(self.content)) as incoming, ZipFile(malformed_sheet, 'w') as outgoing:
            for info in incoming.infolist():
                body = incoming.read(info.filename)
                if info.filename == 'xl/worksheets/sheet1.xml':
                    # Metadata loads lazily; only reading the worksheet exposes this error.
                    body = body.replace(b'</sheetData>', b'</sheetDataBROKEN>')
                outgoing.writestr(info, body)
        for content in [b'', b'not an Excel workbook', self.content[:100], malformed_sheet.getvalue()]:
            with self.subTest(size=len(content)):
                code, result = self.upload(content=content, replace_version=conflict['version'])
                self.assertEqual(code, 400, result)
                self.assertIn('error', result)
                self.assertEqual(original.read_bytes(), self.content)
                self.assertEqual([path.name for path in self.folder.iterdir()], ['销量.xlsx'])

    def test_replace_failure_keeps_original_bytes_and_removes_temporary_file(self):
        original = self.folder / '销量.xlsx'
        original.write_bytes(self.content)
        incoming = workbook_bytes(999)
        code, conflict = self.upload(content=incoming)
        self.assertEqual(code, 409, conflict)
        with patch.object(server.os, 'replace', side_effect=PermissionError('workbook is open')) as replace:
            code, result = self.upload(content=incoming, replace_version=conflict['version'])
        self.assertEqual(code, 400, result)
        replace.assert_called_once()
        self.assertIn('error', result)
        self.assertEqual(original.read_bytes(), self.content)
        self.assertEqual([path.name for path in self.folder.iterdir()], ['销量.xlsx'])

    def test_interrupted_confirmed_upload_does_not_touch_existing_file(self):
        original = self.folder / '销量.xlsx'
        original.write_bytes(self.content)
        code, conflict = self.upload(content=workbook_bytes(999))
        self.assertEqual(code, 409, conflict)
        connection = HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=5)
        url = '/api/import?' + urlencode({
            'filename': original.name, 'folder': str(self.folder),
            'replace_version': conflict['version'],
        })
        try:
            connection.request('POST', url, body=self.content[:100], headers={
                'Content-Type': 'application/octet-stream',
                'Content-Length': str(len(self.content)),
            })
            connection.sock.shutdown(socket.SHUT_WR)
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertIn('error', json.loads(response.read()))
        finally:
            connection.close()
        self.assertEqual(original.read_bytes(), self.content)
        self.assertEqual([path.name for path in self.folder.iterdir()], ['销量.xlsx'])

    def test_first_import_creates_managed_folder_without_client_path(self):
        self.folder.rmdir()
        code, result = self.request('import', method='POST', body=self.content,
            headers={'Content-Type': 'application/octet-stream'}, filename='销量.xlsx')
        self.assertEqual(code, 201, result)
        self.assertEqual((self.folder / '销量.xlsx').read_bytes(), self.content)

    def test_invalid_windows_names_and_unsupported_formats_leave_no_files(self):
        invalid_names = [
            '', '../outside.xlsx', '..\\outside.xlsx', 'C:\\outside.xlsx',
            'name:stream.xlsx', 'bad?.xlsx', 'bad*.xlsx', 'bad|.xlsx',
            'bad<.xlsx', 'bad>.xlsx', 'bad".xlsx', 'bad\n.xlsx',
            'CON.xlsx', 'nul.xlsx', 'COM1.xlsm', 'LPT9.xlsx',
            '~$临时.xlsx', 'trailing.xlsx ', 'trailing.xlsx.', 'legacy.xls', 'text.csv',
        ]
        for name in invalid_names:
            with self.subTest(name=name):
                code, result = self.upload(name)
                self.assertEqual(code, 400, result)
                self.assertIn('error', result)
                self.assertEqual(list(self.folder.iterdir()), [])
        self.assertFalse((self.root / 'outside.xlsx').exists())

    def test_empty_and_damaged_workbooks_are_rejected_and_temporary_files_removed(self):
        for content in [b'', b'not an Excel workbook', self.content[:100]]:
            with self.subTest(size=len(content)):
                code, result = self.upload(content=content)
                self.assertEqual(code, 400, result)
                self.assertIn('error', result)
                self.assertEqual(list(self.folder.iterdir()), [])

    def test_upload_requires_matching_destination_and_same_origin(self):
        other = self.root / 'other'
        other.mkdir()
        code, result = self.upload(folder=other)
        self.assertEqual(code, 400, result)
        self.assertEqual(list(other.iterdir()), [])
        code, result = self.upload(headers={'Origin': 'https://unrelated.invalid'})
        self.assertEqual(code, 403, result)
        self.assertEqual(list(self.folder.iterdir()), [])
        code, result = self.upload(headers={
            'Origin': f'http://127.0.0.1:{self.httpd.server_port}',
        })
        self.assertEqual(code, 201, result)

    def test_oversized_import_returns_413_without_creating_a_file(self):
        with patch.object(server, 'MAX_IMPORT_BYTES', len(self.content) - 1):
            code, result = self.upload()
        self.assertEqual(code, 413, result)
        self.assertIn('error', result)
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_disconnected_upload_does_not_publish_or_leave_a_partial_workbook(self):
        connection = HTTPConnection('127.0.0.1', self.httpd.server_port, timeout=5)
        url = '/api/import?' + urlencode({'filename': 'partial.xlsx', 'folder': str(self.folder)})
        try:
            connection.request('POST', url, body=self.content[:100], headers={
                'Content-Type': 'application/octet-stream',
                'Content-Length': str(len(self.content)),
            })
            connection.sock.shutdown(socket.SHUT_WR)
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertIn('error', json.loads(response.read()))
        finally:
            connection.close()
        self.assertEqual(list(self.folder.iterdir()), [])

    def test_request_while_busy_queues_a_second_scan_without_early_completion(self):
        entered = [threading.Event(), threading.Event()]
        release = [threading.Event(), threading.Event()]
        calls = []

        def controlled_sync(folder):
            index = len(calls)
            calls.append(folder)
            if index >= 2:
                raise AssertionError('Unexpected extra scan')
            entered[index].set()
            if not release[index].wait(5):
                raise AssertionError('Test did not release the scan')
            return ScanResult(files=index + 1, tables=index + 1, rows=2, errors=[])

        with patch.object(self.store, 'sync_files', side_effect=controlled_sync):
            try:
                server.request_sync()
                self.assertTrue(entered[0].wait(5))
                self.assertTrue(self.status['busy'])
                server.request_sync()
                self.assertTrue(self.status['busy'])
                release[0].set()
                self.assertTrue(entered[1].wait(5), 'the request during the first scan was lost')
                self.assertTrue(self.status['busy'], 'the second scan must not appear completed')
                release[1].set()
                wait_until(lambda: not self.status['busy'])
                self.assertEqual(calls, [[], []])
                self.assertEqual(self.status['errors'], [])
                self.assertEqual(self.status['files'], 2)
            finally:
                for event in release:
                    event.set()
                wait_until(lambda: not self.status['busy'])


if __name__ == '__main__':
    unittest.main()
