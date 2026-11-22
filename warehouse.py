from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import hashlib
import json
import math
import os
import sqlite3
import time
from contextlib import contextmanager, nullcontext
from typing import Iterable

import pandas as pd

from excel_parser import (ParsedTable, discover_tables, infer_series_type, scan_excel_files,
                          recognition_rules_snapshot, PARSER_VERSION)
from workspace_relocation import relocate_shared_sources


@dataclass
class ScanResult:
    files: int
    tables: int
    rows: int
    errors: list[str]


class DatasetNotFound(LookupError):
    """The requested imported dataset is no longer available."""


def file_signature(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_mtime_ns}:{stat.st_size}:{PARSER_VERSION}"


def scan_source_files(folder: str | Path | Iterable[str | Path]) -> tuple[list[Path], list[str]]:
    """Scan several roots once; an unavailable root does not hide healthy ones."""
    single_source = isinstance(folder, (str, Path))
    requested = [folder] if single_source else list(folder)
    roots, errors = [], []
    root_keys = set()
    for value in requested:
        try:
            root = Path(value).expanduser().resolve()
            key = os.path.normcase(str(root))
            if key not in root_keys:
                roots.append(root)
                root_keys.add(key)
        except (OSError, ValueError) as exc:
            if single_source:
                raise
            errors.append(f'{value}: {exc}')
    unique = {}
    for root in roots:
        try:
            candidates = scan_excel_files(root)
        except (OSError, ValueError) as exc:
            if single_source:
                raise
            errors.append(f'{root}: {exc}')
            continue
        for candidate in candidates:
            try:
                path = candidate.resolve()
                # Keep synchronization and original-file browsing within the
                # same configured roots, including when a file is a symlink.
                if any(path.is_relative_to(base) for base in roots):
                    unique.setdefault(os.path.normcase(str(path)), path)
            except OSError as exc:
                errors.append(f'{candidate}: {exc}')
    return sorted(unique.values(), key=lambda path: os.path.normcase(str(path))), errors


class Warehouse:
    def __init__(self, database_path: str | Path):
        self.path = Path(database_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def enable_concurrent_reads(self):
        # WAL lets requests read the last committed data during a workbook import.
        # Keep SQLite's existing mode for Windows network shares and mapped drives.
        if os.name == 'nt':
            from ctypes import windll
            drive = self.path.resolve().anchor
            if drive.startswith('\\\\') or windll.kernel32.GetDriveTypeW(drive) == 4:
                return
        with self.connect() as connection:
            connection.execute('PRAGMA journal_mode=WAL').fetchone()

    def _init_schema(self) -> None:
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS datasets (
                    id TEXT PRIMARY KEY,
                    sql_table TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    sheet_name TEXT NOT NULL,
                    table_name TEXT NOT NULL,
                    range_ref TEXT NOT NULL,
                    row_count INTEGER NOT NULL,
                    column_count INTEGER NOT NULL,
                    columns_json TEXT NOT NULL,
                    scanned_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_datasets_file ON datasets(file_name);
                CREATE TABLE IF NOT EXISTS file_versions (path TEXT PRIMARY KEY, signature TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS uploaded_files (path TEXT PRIMARY KEY);
                """
            )

    @staticmethod
    def _identity(table: ParsedTable) -> tuple[str, str]:
        raw = f"{table.file_path}|{table.sheet_name}|{table.range_ref.split(':')[0]}"
        digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]
        return digest, f"data_{digest}"

    def rebuild(self, folder: str | Path | Iterable[str | Path]) -> ScanResult:
        return self.sync(folder, force=True)

    def relocate_shared_sources(self, shared_root, *, active_sources=None, rules_path=None, dry_run=True):
        return relocate_shared_sources(self.path, shared_root, active_sources=active_sources,
                                       rules_path=rules_path, dry_run=dry_run)

    def sync(self, folder: str | Path | Iterable[str | Path], force: bool = False) -> ScanResult:
        files, errors = scan_source_files(folder)
        return self.sync_files(files, force=force, errors=errors)

    def register_upload(self, path: Path) -> None:
        with self.connect() as connection:
            connection.execute('INSERT OR IGNORE INTO uploaded_files VALUES (?)', (str(path.resolve()),))

    def uploaded_files(self) -> list[Path]:
        with self.connect() as connection:
            return [Path(row['path']) for row in connection.execute('SELECT path FROM uploaded_files ORDER BY path')]

    def _forget_missing_upload(self, path: Path) -> bool:
        try:
            path.stat()
        except FileNotFoundError:
            with self.connect() as connection:
                return connection.execute('DELETE FROM uploaded_files WHERE path=?', (str(path),)).rowcount > 0
        return False

    def file_versions(self) -> dict[str, str]:
        with self.connect() as connection:
            return dict(connection.execute('SELECT path, signature FROM file_versions'))

    def sync_files(self, files: list[Path], force: bool = False, errors=None, expected_signatures=None,
                   *, publish_lock=None) -> ScanResult:
        errors = list(errors or [])
        commit = publish_lock if publish_lock is not None else nullcontext()
        for file_path in files:
            try:
                try:
                    signature = file_signature(file_path)
                except FileNotFoundError:
                    # An upload may replace the missing path and register it
                    # again while this worker waits for the publication lock.
                    with commit:
                        if self._forget_missing_upload(file_path):
                            continue
                    raise
                if expected_signatures and file_path in expected_signatures and signature != expected_signatures[file_path]:
                    raise ValueError('文件在稳定检查后又发生变化，等待下一次检查')
                with self.connect() as connection:
                    previous = connection.execute('SELECT signature FROM file_versions WHERE path=?', (str(file_path),)).fetchone()
                if not force and previous and previous[0] == signature:
                    continue
                snapshot = recognition_rules_snapshot()
                rules = json.loads(snapshot) if snapshot is not None else {}
                notices = []
                tables = discover_tables(file_path, rules=rules, notices=notices)
                if not tables:
                    raise ValueError('未发现可识别表格，保留上次导入数据')
                with commit:
                    if signature != file_signature(file_path):
                        raise ValueError('文件正在保存，下次刷新重试')
                    if snapshot != recognition_rules_snapshot():
                        if self.file_versions().get(str(file_path)) == signature:
                            continue
                        raise ValueError('解析期间识别规则已更新，下次刷新重试')
                    self._replace_file(file_path, tables, signature)
                errors.extend(f"{file_path.name}: {notice}" for notice in notices)
            except Exception as exc:  # one damaged workbook must not stop the scan
                errors.append(f"{file_path.name}: {exc}")
        catalog = self.catalog()
        return ScanResult(len(files), len(catalog), int(catalog.row_count.sum()), errors)

    def _replace_file(self, file_path, tables, signature, *, before_commit=None):
        with self.connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            previous = connection.execute(
                'SELECT id, sql_table, sheet_name, range_ref FROM datasets WHERE file_path=?',
                (str(file_path),)).fetchall()
            identities = {(row['sheet_name'], row['range_ref'].split(':')[0]): (row['id'], row['sql_table'])
                          for row in previous}
            if len(identities) != len(previous):
                raise ValueError('已有数据区域起点重复，未覆盖原数据')
            old_tables = [row['sql_table'] for row in previous]
            for sql_table in old_tables:
                connection.execute(f'DROP TABLE IF EXISTS "{sql_table}"')
            connection.execute("DELETE FROM datasets WHERE file_path=?", (str(file_path),))
            # Keep successive imports distinct even when a file is saved twice in one second.
            now = datetime.now().isoformat(timespec="microseconds")
            for table in tables:
                dataset_id, sql_table = identities.get(
                    (table.sheet_name, table.range_ref.split(':')[0]), self._identity(table))
                frame = table.dataframe.copy()
                frame.columns = [str(column) for column in frame.columns]
                frame.insert(0, "_source_row", range(table.header_row + 1, table.header_row + 1 + len(frame)))
                quote = lambda name: '"' + str(name).replace('"', '""') + '"'
                connection.execute(f'CREATE TABLE "{sql_table}" ({", ".join(quote(c) for c in frame.columns)})')
                def scalar(value):
                    if pd.isna(value):
                        return None
                    if isinstance(value, (datetime, pd.Timestamp)):
                        return value.isoformat()
                    return value.item() if hasattr(value, 'item') else value
                connection.executemany(
                    f'INSERT INTO "{sql_table}" VALUES ({", ".join("?" for _ in frame.columns)})',
                    [tuple(scalar(v) for v in row) for row in frame.itertuples(index=False, name=None)],
                )
                column_info = [
                    {
                        "name": column,
                        "type": infer_series_type(table.dataframe[column]),
                        "non_null": int(table.dataframe[column].notna().sum()),
                    }
                    for column in table.dataframe.columns
                ]
                connection.execute(
                    """INSERT INTO datasets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        dataset_id,
                        sql_table,
                        str(table.file_path),
                        table.file_path.name,
                        table.sheet_name,
                        table.table_name,
                        table.range_ref,
                        len(table.dataframe),
                        len(table.dataframe.columns),
                        json.dumps(column_info, ensure_ascii=False),
                        now,
                    ),
                )
            connection.execute('INSERT OR REPLACE INTO file_versions VALUES (?, ?)', (str(file_path), signature))
            if before_commit is not None:
                before_commit()

    def catalog(self) -> pd.DataFrame:
        with self.connect() as connection:
            return pd.read_sql_query(
                """SELECT id, file_path, file_name, sheet_name, table_name, range_ref,
                          row_count, column_count, columns_json, scanned_at
                   FROM datasets ORDER BY file_name, sheet_name, table_name""",
                connection,
            )

    def load(self, dataset_id: str) -> pd.DataFrame:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT sql_table, file_name, sheet_name, table_name FROM datasets WHERE id = ?",
                (dataset_id,),
            ).fetchone()
            if row is None:
                raise DatasetNotFound(f"找不到数据表：{dataset_id}")
            frame = pd.read_sql_query(f'SELECT * FROM "{row["sql_table"]}"', connection)
            frame.insert(0, "_数据表", row["table_name"])
            frame.insert(0, "_Sheet", row["sheet_name"])
            frame.insert(0, "_文件", row["file_name"])
            return frame

    @staticmethod
    def _search_examples(connection, table, terms, limit, deadline=None):
        identifier = '"' + table['sql_table'].replace('"', '""') + '"'
        examples = []
        examined = 0
        cursor = connection.execute(f'SELECT * FROM {identifier} LIMIT ?', (limit,))
        try:
            for row in cursor:
                if deadline is not None and time.monotonic() >= deadline:
                    break
                examined += 1
                if terms:
                    content = ' '.join(str(value) for value in row if value is not None).casefold()
                    if not all(term in content for term in terms):
                        continue
                values = {key: None if isinstance(value, float) and not math.isfinite(value) else value
                          for key, value in dict(row).items()}
                examples.append({'_文件': table['file_name'], '_Sheet': table['sheet_name'],
                                 '_数据表': table['table_name'], **values})
                if len(examples) == 3:
                    break
        finally:
            cursor.close()
        return examples, examined

    def search(self, terms, *, result_limit, row_limit, table_row_limit, cell_limit, seconds):
        result = {'hits': [], 'found_count': 0, 'results_truncated': False, 'content_truncated': False}
        if not terms:
            return result

        hits = result['hits']
        with self.connect() as connection:
            connection.execute('BEGIN')  # Keep table metadata and samples on the same read snapshot.
            metadata_matches, candidates = [], []
            for record in connection.execute('SELECT * FROM datasets ORDER BY file_name, sheet_name, table_name'):
                table = dict(record)
                fields = json.loads(table['columns_json'])
                context = ' '.join((table['file_name'], table['sheet_name'], table['table_name'],
                                    *(field['name'] for field in fields))).casefold()
                missing = tuple(term for term in terms if term not in context)
                if missing:
                    candidates.append((table, missing))
                else:
                    metadata_matches.append(table)

            result['found_count'] = len(metadata_matches)
            result['results_truncated'] = len(metadata_matches) > result_limit
            for table in metadata_matches[:result_limit]:
                rows, _ = self._search_examples(connection, table, (), 3)
                hits.append({'table': table, 'rows': rows})

            deadline = time.monotonic() + seconds
            for table, missing in sorted(candidates, key=lambda item: len(item[1])):
                if len(hits) >= result_limit or row_limit <= 0 or time.monotonic() >= deadline:
                    result['content_truncated'] = True
                    break
                columns = max(1, table['column_count'] + 1)  # Include the source-row column.
                limit = min(row_limit, table_row_limit, cell_limit // columns, table['row_count'])
                if limit <= 0:
                    result['content_truncated'] |= table['row_count'] > 0
                    continue
                rows, examined = self._search_examples(connection, table, missing, limit, deadline)
                row_limit -= examined
                cell_limit -= examined * columns
                if len(rows) < 3 and examined < table['row_count']:
                    result['content_truncated'] = True
                if rows:
                    hits.append({'table': table, 'rows': rows})
                    result['found_count'] += 1

        for hit in hits:
            del hit['table']['sql_table']
        return result
