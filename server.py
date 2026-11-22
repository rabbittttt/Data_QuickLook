"""Local data workspace. Run: python server.py (http://127.0.0.1:9473)."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from http.client import HTTPConnection, HTTPException
from pathlib import Path
from urllib.parse import urlparse, urlsplit, parse_qs, parse_qsl, quote, urlencode, unquote
from xml.parsers.expat import ParserCreate
from dataclasses import asdict
from html import escape, unescape
from io import BytesIO
import json
import os
import hashlib
import re
import argparse
import socket
import sqlite3
import sys
from stat import S_ISREG
import threading
import time
import tempfile
import webbrowser
import pandas as pd
from openpyxl import load_workbook
from openpyxl.utils.cell import coordinate_to_tuple, range_boundaries
from openpyxl.xml.constants import SHEET_MAIN_NS
from warehouse import DatasetNotFound, Warehouse, file_signature
from source_paths import source_directories, shared_data_root
from runtime_paths import data_dir
from shared_sync import SharedFileMonitor


def public_prefix(value):
    parts = value.strip().strip('/').split('/')
    if parts == ['']:
        return '/'
    if any(not re.fullmatch(r'[A-Za-z0-9_-]+', part) for part in parts):
        raise ValueError('DATA_QUICKLOOK_PUBLIC_PREFIX 需要由字母、数字、下划线或连字符组成的路径')
    return '/' + '/'.join(parts) + '/'


def public_origin(value):
    if not value:
        return None
    url = urlsplit(value)
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username is not None
            or url.path not in ('', '/') or url.query or url.fragment
            or any(char.isspace() for char in value)):
        raise ValueError('DATA_QUICKLOOK_PUBLIC_ORIGIN 需要完整的 HTTP(S) 来源，不包含路径')
    url.port  # Validate an explicitly configured port.
    return f'{url.scheme}://{url.netloc}'

ROOT = Path(__file__).resolve().parent
PUBLIC_PREFIX = public_prefix(os.environ.get('DATA_QUICKLOOK_PUBLIC_PREFIX', '/'))
PUBLIC_ORIGIN = public_origin(os.environ.get('DATA_QUICKLOOK_PUBLIC_ORIGIN', ''))
DATA_DIR = data_dir(ROOT)
STORE = Warehouse(DATA_DIR / 'warehouse.db')
LOCK = threading.RLock()
SYNC_LOCK = threading.Lock()
SHARED_PENDING = {}
SHARED_FILES = frozenset()
STATUS = {'busy': False, 'errors': [], 'last_sync': None}
MAX_IMPORT_BYTES = 256 * 1024 * 1024
SEARCH_SLOTS = threading.BoundedSemaphore(2)
SEARCH_QUERY_LIMIT = 256
SEARCH_RESULT_LIMIT = 60
SEARCH_ROW_LIMIT = 20_000
SEARCH_TABLE_ROW_LIMIT = 2_000
SEARCH_CELL_LIMIT = 250_000
SEARCH_SECONDS = 3
IMPORT_SLOTS = threading.BoundedSemaphore(2)


def config():
    uploads = (DATA_DIR / 'uploads').resolve()
    return {
        'folder': str(uploads),
        'folders': [str(path) for path in dict.fromkeys([uploads, *shared_sources()])],
        'auto': False,
    }


def claim_sync(shared_versions=None):
    with SYNC_LOCK:
        SHARED_PENDING.update(shared_versions or {})
        if STATUS['busy']:
            STATUS['pending'] = True
            return False
        STATUS['busy'] = True
        return True


def sync_worker():
    while True:
        try:
            with SYNC_LOCK:
                shared_versions = dict(SHARED_PENDING)
                SHARED_PENDING.clear()
            files = list(dict.fromkeys([*STORE.uploaded_files(), *shared_versions]))
            result = STORE.sync_files(files, expected_signatures=shared_versions, publish_lock=LOCK)
            STATUS.update(asdict(result), last_sync=time.strftime('%Y-%m-%d %H:%M:%S'))
        except Exception as exc:
            STATUS['errors'] = [str(exc)]
        with SYNC_LOCK:
            # A request made during a scan must include files added after it began.
            if STATUS.pop('pending', False):
                continue
            STATUS['busy'] = False
            return


def sync():
    if claim_sync():
        sync_worker()


def request_sync(shared_versions=None):
    if claim_sync(shared_versions):
        threading.Thread(target=sync_worker, daemon=True).start()


def shared_sources():
    root = shared_data_root(ROOT)
    return [root] if root is not None else []


def watch_shared(stop):
    global SHARED_FILES
    monitor = SharedFileMonitor(shared_sources, STORE.file_versions)
    while not stop.is_set():
        try:
            ready, delay = monitor.check()
            SHARED_FILES = frozenset(monitor.stable_files)
            STATUS['shared_errors'] = list(monitor.errors)
            if ready:
                request_sync(ready)
        except Exception as exc:
            STATUS['shared_errors'] = [str(exc)]
            delay = 60
        stop.wait(delay)


class ImportConflict(ValueError):
    def __init__(self, path, changed=False):
        # Bind the confirmation to the current file, not every future file with
        # this name. A concurrent import/edit requires another confirmation.
        stat = path.stat()
        signature = f'{stat.st_dev}:{stat.st_ino}:{stat.st_size}:{stat.st_mtime_ns}:{stat.st_ctime_ns}'
        self.payload = {
            'error': '同名文件已发生变化，请再次确认覆盖' if changed else '已存在同名文件，请确认是否覆盖',
            'overwrite_required': True, 'name': path.name, 'size': stat.st_size,
            'version': hashlib.sha256(signature.encode()).hexdigest(),
        }
        super().__init__(self.payload['error'])


def import_workbook(stream, name, size, expected_folder='', replace_version=''):
    """Store the original bytes; incomplete uploads never become scanned workbooks."""
    if (not name or len(name) > 240 or name.endswith((' ', '.'))
            or re.search(r'[<>:"/\\|?*\x00-\x1f]', name)
            or name.startswith('~$')
            or re.fullmatch(r'CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]', name.split('.')[0], re.I)):
        raise ValueError('文件名无效，请去掉路径、特殊字符或 Excel 临时文件前缀')
    if Path(name).suffix.lower() not in {'.xlsx', '.xlsm'}:
        raise ValueError('仅支持 .xlsx 和 .xlsm；旧版 .xls 请先另存为 .xlsx')
    if size <= 0:
        raise ValueError('文件为空或缺少文件长度')
    folder = (DATA_DIR / 'uploads').resolve()
    if expected_folder and Path(expected_folder).resolve() != folder:
        raise ValueError('文件统一由系统保存，请刷新页面后重新导入')
    folder.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=folder, prefix='.import-', suffix='.part', delete=False) as output:
            temporary = Path(output.name)
            remaining = size
            while remaining:
                chunk = stream.read(min(1024 * 1024, remaining))
                if not chunk:
                    raise ValueError('上传中断，文件未保存，请重新选择后导入')
                output.write(chunk)
                remaining -= len(chunk)
        try:
            with temporary.open('rb') as source:
                book = load_workbook(source, read_only=True, data_only=True)
                try:
                    # Read-only loading is lazy: broken cell XML can otherwise
                    # survive validation and replace a good original workbook.
                    for sheet in book.worksheets:
                        sheet.reset_dimensions()
                        for _ in sheet.iter_rows(values_only=True):
                            pass
                finally:
                    book.close()
        except Exception as exc:
            raise ValueError('无法读取此 Excel，文件可能损坏或已加密，请用 Excel 打开后另存再导入') from exc
        with LOCK:
            destination = folder / name
            if destination.is_symlink() or destination.exists() and not destination.is_file():
                raise ValueError('同名目标不是普通文件，请先在数据源文件夹中检查')
            overwritten = destination.exists()
            if overwritten:
                conflict = ImportConflict(destination, changed=bool(replace_version))
                if replace_version != conflict.payload['version']:
                    raise conflict
                try:
                    # Publish only a complete, validated workbook. Failed replace
                    # leaves the existing file intact (e.g. it is open in Excel).
                    os.replace(temporary, destination)
                except PermissionError as exc:
                    raise ValueError('无法覆盖，文件可能正在被 Excel 使用或目录无写入权限。请关闭文件后重试；原文件已保留') from exc
            else:
                try:
                    # Exclusive publication prevents an unconfirmed overwrite if
                    # a file with this name appeared after the existence check.
                    if os.name == 'nt':
                        temporary.rename(destination)
                    else:
                        os.link(temporary, destination)
                except FileExistsError:
                    raise ImportConflict(destination)
            STORE.register_upload(destination)
        request_sync()
        return {'saved': True, 'name': destination.name, 'overwritten': overwritten}
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def catalog(records=None, *, sources=None, files=None):
    if records is None:
        records = STORE.catalog().to_dict('records')
    if sources is None:
        sources = source_directories(config())
    if files is None:
        files = workbook_stats((row['file_path'] for row in records), sources)
    for row in records:
        row['fields'] = json.loads(row.pop('columns_json'))
        path = Path(row['file_path'])
        source = containing_source(path, sources)
        row['relative_path'] = source_file_label(path, source, sources) if source else str(path)
        row['source_folder'] = str(source) if source else None
        row['archived'] = source is None or path not in files
        row['issues'] = []
        if any(f['name'].startswith('字段') for f in row['fields']):
            row['issues'].append('存在未命名字段，建议核对表头')
        if any(f['non_null'] < row['row_count']*.5 for f in row['fields']):
            row['issues'].append('部分字段缺失超过一半')
        if row['row_count'] <= 4:
            row['issues'].append('小型数据区域，可能是图表辅助区')
    return records


def data(dataset_id):
    frame = STORE.load(dataset_id)
    # JSON serializer preserves nulls and ISO dates; no NaN reaches the browser.
    return {'columns': list(frame.columns), 'rows': json.loads(frame.to_json(orient='records', date_format='iso', force_ascii=False))}


def search_catalog(text):
    terms = tuple(dict.fromkeys(text.casefold().split()))
    result = STORE.search(terms, result_limit=SEARCH_RESULT_LIMIT, row_limit=SEARCH_ROW_LIMIT,
                          table_row_limit=SEARCH_TABLE_ROW_LIMIT, cell_limit=SEARCH_CELL_LIMIT,
                          seconds=SEARCH_SECONDS)
    if result['hits']:
        records = [hit['table'] for hit in result['hits']]
        sources = source_directories(config())
        files = workbook_stats((row['file_path'] for row in records), sources, include_unindexed=False)
        catalog(records, sources=sources, files=files)
    return result


def containing_source(path, sources):
    return next((source for source in sorted(sources, key=lambda p: len(p.parts), reverse=True)
                 if path.is_relative_to(source)), None)


def source_file_label(path, source, sources):
    relative = str(path.relative_to(source))
    if len(sources) == 1:
        return relative
    label = source.name if sum(p.name.casefold() == source.name.casefold() for p in sources) == 1 else str(source)
    return str(Path(label) / relative)


def workbook_stats(indexed_paths, sources, *, include_unindexed=True):
    # One filesystem check per workbook, even when many tables share it.
    paths = {Path(path) for path in indexed_paths}
    if include_unindexed:
        paths.update(STORE.uploaded_files(), SHARED_FILES)
    files = {}
    for path in paths:
        if containing_source(path, sources) is None:
            continue
        try:
            info = path.stat()
        except OSError:
            continue
        if S_ISREG(info.st_mode):
            files[path] = info
    return files


def workbook_id(path):
    return hashlib.sha256(str(path).encode()).hexdigest()[:24]


def workbook_files():
    sources = source_directories(config())
    return {workbook_id(path): path for path in workbook_stats(STORE.catalog().file_path, sources)}


def workbook_list(*, sources=None, stats=None):
    if sources is None:
        sources = source_directories(config())
    if stats is None:
        stats = workbook_stats(STORE.catalog().file_path, sources)
    files = []
    for path, stat in sorted(stats.items(), key=lambda item: str(item[0])):
        source = containing_source(path, sources)
        files.append(dict(id=workbook_id(path), name=source_file_label(path, source, sources) if source else str(path), path=str(path), source_folder=str(source) if source else None,
                          signature=f'{stat.st_mtime_ns}:{stat.st_size}'))
    return files


def workbook_info(path):
    book = load_workbook(path, read_only=True, data_only=True)
    try:
        return {'sheets': [sheet.title for sheet in book.worksheets]}
    finally:
        book.close()


def save_recognition(table, range_ref, name):
    from excel_parser import discover_tables, OVERRIDES, recognition_rules_snapshot

    if table['archived']:
        raise ValueError('原文件不可用，无法修正识别区域')
    if name is not None and not isinstance(name, str):
        raise ValueError('表名必须是文本')
    if not isinstance(range_ref, str):
        raise ValueError('区域必须是单元格范围，例如 A2:F80')
    left, top, right, bottom = range_boundaries(range_ref)
    if not all([left, top, right, bottom]) or bottom <= top or right < left:
        raise ValueError('区域需包含一行表头及至少一行数据，例如 A2:F80')

    source = Path(table['file_path'])
    signature = file_signature(source)
    snapshot = recognition_rules_snapshot()
    rules = json.loads(snapshot) if snapshot is not None else {}
    key = table['file_path'] + '|' + table['sheet_name'] + '|' + table['range_ref'].split(':')[0]
    rules[key] = {'file': table['file_path'], 'sheet': table['sheet_name'], 'range': range_ref,
                  'name': (name or '').strip() or table['table_name'], 'original': table['range_ref']}
    parsed = discover_tables(source, rules=rules)
    if not any(area.sheet_name == table['sheet_name'] and area.range_ref == range_ref for area in parsed):
        raise ValueError('原工作表或区域已变更，请同步后重新选择')

    # Stage both versions on the same volume so publishing and recovery use
    # atomic replacements, including when the database commit fails.
    with tempfile.TemporaryDirectory(dir=OVERRIDES.parent, prefix='.recognition-') as temp:
        staged = Path(temp) / 'next.json'
        staged.write_text(json.dumps(rules, ensure_ascii=False, indent=2), encoding='utf-8')
        previous = Path(temp) / 'previous.json'
        if snapshot is not None:
            previous.write_bytes(snapshot)
        published = False

        def publish():
            nonlocal published
            os.replace(staged, OVERRIDES)
            published = True

        with LOCK:
            if signature != file_signature(source):
                raise ValueError('工作簿在解析期间已变化，请同步后重新选择')
            if snapshot != recognition_rules_snapshot():
                raise ValueError('识别规则在解析期间已变化，请重新提交')
            try:
                STORE._replace_file(source, parsed, signature, before_commit=publish)
            except Exception:
                if published:
                    if snapshot is None:
                        OVERRIDES.unlink()
                    else:
                        os.replace(previous, OVERRIDES)
                raise


def sheet_layout(sheet):
    """Stream only the selected sheet's cell coordinates and merge ranges."""
    row_tag, cell_tag, merge_tag = (f'{SHEET_MAIN_NS} {name}' for name in ('row', 'c', 'mergeCell'))
    max_row = max_col = 1
    row = column = 0
    merges = []

    def start_element(tag, attributes):
        nonlocal row, column, max_row, max_col
        if tag == row_tag:
            row = int(attributes.get('r', row + 1))
            column = 0
        elif tag == cell_tag:
            coordinate = attributes.get('r')
            cell_row, column = coordinate_to_tuple(coordinate) if coordinate else (row, column + 1)
            max_row, max_col = max(max_row, cell_row), max(max_col, column)
        elif tag == merge_tag:
            bounds = range_boundaries(attributes['ref'])
            merges.append(list(bounds))
            max_row, max_col = max(max_row, bounds[3]), max(max_col, bounds[2])

    def reject_doctype(*_):
        raise ValueError('工作表 XML 不支持文档类型声明')

    # The dimension element can be wrong or absent. SAX keeps the layout scan
    # bounded in memory even when the selected sheet has many populated rows.
    parser = ParserCreate(namespace_separator=' ')
    parser.StartElementHandler = start_element
    parser.StartDoctypeDeclHandler = reject_doctype
    with sheet._get_source() as source:
        parser.ParseFile(source)
    return max_row, max_col, merges


def original_sheet(path, sheet_name=None, start=1, column=1, *, page_columns=30):
    """Read source cells independently of inferred tables. Never save the workbook."""
    book = load_workbook(path, read_only=True, data_only=True, keep_links=False)
    try:
        sheets = [sheet.title for sheet in book.worksheets]
        missing_sheet = sheet_name if sheet_name and sheet_name not in sheets else None
        if not sheets:
            raise ValueError('此文件没有可读取的单元格工作表')
        sheet = book[sheet_name] if sheet_name and not missing_sheet else book.worksheets[0]
        if missing_sheet:
            start = column = 1
        max_row, max_col, ranges = sheet_layout(sheet)
        start = min(max(1, start), max_row)
        column = min(max(1, column), max_col)
        bottom, right = min(start+79, max_row), min(column+page_columns-1, max_col)
        rows = [list(row) for row in sheet.iter_rows(
            min_row=start, max_row=bottom, min_col=column, max_col=right, values_only=True)]
        while len(rows) < bottom - start + 1:
            rows.append([None] * (right - column + 1))
        merges = [bounds for bounds in ranges if bounds[1] <= bottom and bounds[3] >= start
                  and bounds[0] <= right and bounds[2] >= column]
        return dict(sheets=sheets, sheet=sheet.title, rows=rows, merges=merges,
                    start=start, column=column, max_row=max_row, max_col=max_col,
                    missing_sheet=missing_sheet,
                    warning=f'原工作表“{missing_sheet}”已不存在，已显示“{sheet.title}”。请重新选择当前工作表；旧图表未改动。' if missing_sheet else '')
    finally:
        book.close()


def find_dataset(dataset_id):
    if not isinstance(dataset_id, str) or not dataset_id:
        raise ValueError('数据表编号无效')
    table = next((table for table in catalog() if table['id'] == dataset_id), None)
    if table is None:
        raise DatasetNotFound('数据表已变更，请重新选择')
    return table


def is_local_host(host):
    match = re.fullmatch(r'(?:localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?', host, re.IGNORECASE)
    return bool(match and (match[1] is None or 1 <= int(match[1]) <= 65535))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / 'web'), **kwargs)

    def redirect_path(self, path, query):
        self.send_response(307)
        self.send_header('Location', path + ('?' + query if query else ''))
        self.send_header('Content-Length', '0')
        self.end_headers()

    def parse_request(self):
        if not super().parse_request():
            return False
        hosts = self.headers.get_all('Host', [])
        public_host = urlsplit(PUBLIC_ORIGIN).netloc.casefold() if PUBLIC_ORIGIN else None
        if len(hosts) != 1 or not (is_local_host(hosts[0]) or hosts[0].casefold() == public_host):
            self.close_connection = True
            self.send_json({'error': '访问地址不匹配'}, 403)
            return False
        # The same handler serves both a prefix-preserving proxy and a proxy
        # which has already removed the public mount point.
        if PUBLIC_PREFIX != '/':
            url = urlsplit(self.path)
            mount = PUBLIC_PREFIX.rstrip('/')
            if url.path == mount:
                self.redirect_path(PUBLIC_PREFIX, url.query)
                return False
            if url.path.startswith(PUBLIC_PREFIX):
                self.path = url.path[len(mount):] + ('?' + url.query if url.query else '')
        return True

    def versioned_html(self, path, body):
        root = (ROOT / 'web').resolve()
        versions = {}

        def version_asset(match):
            url = urlparse(unescape(match['url']))
            if url.scheme or url.netloc or not url.path:
                return match[0]
            base = root if url.path.startswith('/') else path.parent
            resource_path = url.path
            if PUBLIC_PREFIX != '/' and resource_path.startswith(PUBLIC_PREFIX):
                resource_path = '/' + resource_path.removeprefix(PUBLIC_PREFIX)
            asset = (base / unquote(resource_path).lstrip('/')).resolve()
            if not asset.is_relative_to(root) or not asset.is_file():
                return match[0]
            if asset not in versions:
                versions[asset] = hashlib.sha256(asset.read_bytes()).hexdigest()[:16]
            query = [(key, value) for key, value in parse_qsl(url.query) if key != 'v']
            query.append(('v', versions[asset]))
            if PUBLIC_PREFIX != '/':
                resource_path = PUBLIC_PREFIX + quote(asset.relative_to(root).as_posix(), safe='/')
            versioned = url._replace(path=resource_path, query=urlencode(query)).geturl()
            return match['prefix'] + escape(versioned, quote=True) + match['quote']

        html = re.sub(r'(?P<prefix>\b(?:src|href)=(?P<quote>[\"\x27]))(?P<url>[^\"\x27]+)(?P=quote)',
                      version_asset, body.decode('utf-8'))
        if PUBLIC_PREFIX != '/':
            html = re.sub(r'<head\b[^>]*>', lambda match: match[0] +
                          f'\n<meta name="quicklook-base" content="{PUBLIC_PREFIX}">',
                          html, count=1, flags=re.IGNORECASE)
        return html.encode('utf-8')

    def send_head(self):
        path = Path(self.translate_path(self.path))
        if path.is_dir():
            url = urlsplit(self.path)
            if not url.path.endswith('/'):
                self.redirect_path(PUBLIC_PREFIX + url.path.lstrip('/') + '/', url.query)
                return None
            path = path / 'index.html'
        if not path.is_file():
            return super().send_head()
        try:
            body = path.read_bytes()
            if path.suffix.lower() == '.html':
                body = self.versioned_html(path, body)
        except OSError:
            self.send_error(404, 'File not found')
            return None
        # Content validators stay correct after Git pulls even when timestamps match.
        # Deliberately ignore If-Modified-Since; it cannot validate changed bytes.
        etag = '"' + hashlib.sha256(body).hexdigest() + '"'
        candidates = [value.strip().removeprefix('W/')
                      for value in self.headers.get('If-None-Match', '').split(',')]
        unchanged = etag in candidates or '*' in candidates
        self.send_response(304 if unchanged else 200)
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('ETag', etag)
        if not unchanged:
            content_type = self.guess_type(str(path))
            if content_type == 'text/html':
                content_type += '; charset=utf-8'
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        return None if unchanged else BytesIO(body)

    def send_json(self, payload, code=200):
        body = json.dumps(payload, ensure_ascii=False, default=str).encode('utf-8')
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if getattr(self, 'command', None) != 'HEAD':
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # The client is gone; do not send another response on this socket.
            self.close_connection = True

    def send_api_error(self, path, exc):
        if isinstance(exc, DatasetNotFound):
            return self.send_json({'error': str(exc)}, 404)
        if isinstance(exc, KeyError) and exc.args in (('id',), ('range',)):
            return self.send_json({'error': f'缺少必要参数：{exc.args[0]}'}, 400)
        if isinstance(exc, ValueError) and not isinstance(exc, (json.JSONDecodeError, UnicodeError)):
            return self.send_json({'error': str(exc)}, 400)
        self.log_error('%s failed (%s): %s', path, type(exc).__name__, exc)
        return self.send_json({'error': '数据服务处理失败，请稍后重试'}, 500)

    def do_GET(self):
        parts = urlparse(self.path)
        query = parse_qs(parts.query)
        started = time.monotonic()
        try:
            if parts.path == '/healthz':
                return self.send_json({'ok': True, 'app': 'quicklook'})
            if parts.path == '/api/catalog':
                status = {**STATUS, 'errors': STATUS['errors'] + STATUS.get('shared_errors', [])}
                settings = config()
                sources = source_directories(settings)
                records = STORE.catalog().to_dict('records')
                stats = workbook_stats((row['file_path'] for row in records), sources)
                return self.send_json({'tables': catalog(records, sources=sources, files=stats),
                                       'files': workbook_list(sources=sources, stats=stats),
                                       'status': status, 'config': settings})
            if parts.path == '/api/table':
                return self.send_json(data(query['id'][0]))
            if parts.path == '/api/workbooks':
                return self.send_json({'files': workbook_list()})
            if parts.path == '/api/workbook':
                path = workbook_files().get(query['id'][0])
                if path is None:
                    raise ValueError('文件已移走，请重新选择数据文件')
                return self.send_json(workbook_info(path))
            if parts.path == '/api/sheet':
                path = workbook_files().get(query['id'][0])
                if path is None:
                    raise ValueError('文件已移走，请重新选择数据文件')
                return self.send_json(original_sheet(path, query.get('sheet', [None])[0],
                                      int(query.get('start', ['1'])[0]), int(query.get('column', ['1'])[0])))
            if parts.path == '/api/search':
                text = query.get('q', [''])[0].strip()
                if len(text) > SEARCH_QUERY_LIMIT:
                    return self.send_json({'error': f'搜索词最多 {SEARCH_QUERY_LIMIT} 个字符'}, 400)
                if not SEARCH_SLOTS.acquire(blocking=False):
                    return self.send_json({'error': '同时搜索的请求较多，请稍候重试'}, 429)
                try:
                    return self.send_json(search_catalog(text))
                finally:
                    SEARCH_SLOTS.release()
            if parts.path == '/api/raw':
                table = find_dataset(query['id'][0])
                if table['archived']:
                    raise ValueError('原文件不可用，仍可查看已入库数据')
                start = max(1, int(query.get('start', ['1'])[0]))
                page = original_sheet(table['file_path'], table['sheet_name'], start, page_columns=60)
                if page['missing_sheet']:
                    raise ValueError('原工作表已变更，请同步后重新选择')
                return self.send_json({'rows': page['rows'] if start <= page['max_row'] else [],
                                       'start': start, 'max_row': page['max_row'], 'max_col': page['max_col']})
            if parts.path.startswith('/api/'):
                return self.send_json({'error': '接口不存在'}, 404)
            return super().do_GET()
        except Exception as exc:
            self.send_api_error(parts.path, exc)
        finally:
            elapsed = time.monotonic() - started
            if elapsed >= 2:
                self.log_message('%s finished in %.2fs', parts.path, elapsed)

    def do_POST(self):
        # Do not derive an allowed origin from an arbitrary proxy Host.
        origin = self.headers.get('Origin')
        host = self.headers.get('Host', '')
        local_origin = 'http://' + host if is_local_host(host) else None
        if origin and origin not in (local_origin, PUBLIC_ORIGIN):
            return self.send_json({'error': '来源不匹配'}, 403)
        if urlparse(self.path).path == '/api/import':
            slots = IMPORT_SLOTS
            if not slots.acquire(blocking=False):
                self.close_connection = True
                return self.send_json({'error': '导入任务较多，请稍后重试'}, 429)
            try:
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/octet-stream':
                    raise ValueError('需要文件二进制请求')
                if self.headers.get('Transfer-Encoding'):
                    raise ValueError('需要明确的文件长度')
                size = int(self.headers.get('Content-Length', 0))
                if size > MAX_IMPORT_BYTES:
                    return self.send_json({'error': '单个文件不能超过 256 MB'}, 413)
                query = parse_qs(urlparse(self.path).query)
                self.connection.settimeout(120)
                return self.send_json(import_workbook(self.rfile, query.get('filename', [''])[0], size,
                                                      query.get('folder', [''])[0],
                                                      query.get('replace_version', [''])[0]), 201)
            except ImportConflict as exc:
                return self.send_json(exc.payload, 409)
            except (TimeoutError, ConnectionError):
                return self.send_json({'error': '上传中断或超时，请检查连接后重新导入'}, 400)
            except Exception as exc:
                return self.send_api_error('/api/import', exc)
            finally:
                slots.release()
        if 'application/json' not in self.headers.get('Content-Type', ''):
            return self.send_json({'error': '需要 JSON 请求'}, 400)
        try:
            size = int(self.headers.get('Content-Length', 0))
            if size < 0:
                raise ValueError('请求长度无效')
            if size > 65536:
                return self.send_json({'error': '请求内容不能超过 64 KiB'}, 413)
            try:
                payload = json.loads(self.rfile.read(size) or b'{}')
            except (json.JSONDecodeError, UnicodeDecodeError):
                return self.send_json({'error': '请求内容不是有效的 JSON'}, 400)
            if not isinstance(payload, dict):
                raise ValueError('请求内容必须是 JSON 对象')
            if self.path == '/api/sync':
                request_sync()
                return self.send_json({'started': True})
            if self.path == '/api/recognition':
                table = find_dataset(payload['id'])
                save_recognition(table, payload['range'], payload.get('name'))
                return self.send_json({'saved': True})
            self.send_json({'error': '接口不存在'}, 404)
        except Exception as exc:
            self.send_api_error(self.path, exc)


DEFAULT_PORT = 9473
APP_TITLE = '数据速查'


class WorkbenchHTTPServer(ThreadingHTTPServer):
    request_queue_size = 32

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            # Windows must not let a second launcher share the same listening port.
            self.allow_reuse_address = False
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def open_workbench(url):
    try:
        if webbrowser.open(url, new=2):
            return
    except webbrowser.Error:
        pass
    print(f'未能自动打开浏览器，请手动访问 {url}', flush=True)


def workbench_running(port=DEFAULT_PORT):
    connection = HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        connection.request('GET', PUBLIC_PREFIX)
        response = connection.getresponse()
        page = response.read(16384)
        titles = (APP_TITLE, '数据速查 · Data QuickLook', 'Excel 数据查询与图表分析', '数见 · 经营数据工作台')
        return response.status == 200 and any(f'<title>{title}</title>'.encode('utf-8') in page for title in titles)
    except (OSError, HTTPException):
        return False
    finally:
        connection.close()


def run_server(open_browser=False, port=DEFAULT_PORT):
    url = f'http://127.0.0.1:{port}{PUBLIC_PREFIX}'
    try:
        httpd = WorkbenchHTTPServer(('127.0.0.1', port), Handler)
    except OSError:
        if open_browser and workbench_running(port):
            print('数据速查已经运行，正在打开现有页面。', flush=True)
            open_workbench(url)
            return
        raise
    with httpd:
        try:
            STORE.enable_concurrent_reads()
        except sqlite3.Error as exc:
            print(f'数据库并发读取模式未启用：{exc}', file=sys.stderr)
        stop = threading.Event()
        threading.Thread(target=watch_shared, args=(stop,), daemon=True).start()
        request_sync()  # Recheck persisted uploads with this parser version on every startup.
        print(f'{APP_TITLE}: {url}', flush=True)
        if open_browser:
            # The listening socket is ready before the browser can request the page.
            threading.Thread(target=open_workbench, args=(url,), daemon=True).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            stop.set()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=APP_TITLE)
    parser.add_argument('--open-browser', action='store_true', help='服务启动后自动打开浏览器')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT, help='本地监听端口，默认 %(default)s')
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('--port 必须在 1–65535 之间')
    run_server(open_browser=args.open_browser, port=args.port)
