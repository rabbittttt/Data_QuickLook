import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote

import server


class PortalPrefixTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        web = root / 'web'
        web.mkdir()
        (web / 'index.html').write_text(
            '<head><link href="style.css" rel="stylesheet"></head>', encoding='utf-8')
        (web / 'style.css').write_bytes(b'body{}')
        self.patch_value('ROOT', root)
        self.patch_value('PUBLIC_PREFIX', '/quicklook/')
        self.patch_value('PUBLIC_ORIGIN', 'https://planhub.example')
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        self.port = httpd.server_port

    def patch_value(self, name, value):
        setting = patch.object(server, name, value)
        setting.start()
        self.addCleanup(setting.stop)

    def request(self, path, *, origin=None, host='backend.example', method='GET', headers=None):
        request_headers = {'Host': host, **(headers or {})}
        body = None
        if origin is not None:
            request_headers['Origin'] = origin
        if method == 'POST':
            request_headers['Content-Type'] = 'application/json'
            body = '{}'
        connection = HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_prefixed_and_stripped_requests_share_versioned_assets(self):
        status, headers, _ = self.request('/quicklook?mode=test')
        self.assertEqual((status, headers['Location']), (307, '/quicklook/?mode=test'))
        status, headers, page = self.request('/quicklook/')
        self.assertEqual(status, 200)
        self.assertIn(b'<meta name="quicklook-base" content="/quicklook/">', page)
        self.assertIn(b'href="/quicklook/style.css?v=', page)
        self.assertEqual(self.request('/')[2], page)
        self.assertEqual(self.request('/quicklook/', headers={'If-None-Match': headers['ETag']})[0], 304)
        for path in ('/quicklook/style.css', '/style.css'):
            self.assertEqual(self.request(path)[2], b'body{}')

    def test_generic_api_mount_preserves_query_and_supports_health(self):
        self.patch_value('data', lambda dataset_id: {'id': dataset_id})
        for mount in ('', '/quicklook'):
            status, _, body = self.request(mount + '/api/table?id=' + quote('订单&1'))
            self.assertEqual((status, json.loads(body)), (200, {'id': '订单&1'}))
            status, _, body = self.request(mount + '/healthz')
            self.assertEqual((status, json.loads(body)), (200, {'ok': True, 'app': 'quicklook'}))
            self.assertEqual(self.request(mount + '/api/not-registered')[0], 404)

    def test_post_preserves_origin_check_at_both_mounts(self):
        self.patch_value('request_sync', lambda: None)
        for mount in ('', '/quicklook'):
            endpoint = mount + '/api/sync'
            self.assertEqual(self.request(endpoint, method='POST', origin='http://backend.example')[0], 200)
            self.assertEqual(self.request(endpoint, method='POST', origin='https://planhub.example')[0], 200)
            self.assertEqual(self.request(endpoint, method='POST', origin='https://other.example',
                                          headers={'X-Forwarded-Host': 'other.example',
                                                   'X-Forwarded-Proto': 'https'})[0], 403)
