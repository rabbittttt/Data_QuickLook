from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
import hashlib
import json
from typing import Any, Iterable
from datetime import date, datetime

import pandas as pd
from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

from runtime_paths import data_dir


SUPPORTED_SUFFIXES = {".xlsx", ".xlsm"}
def parser_revision(root=None):
    """Stable across relocation; changes with parsing/storage code and dependencies."""
    root = Path(root or Path(__file__).resolve().parent)
    digest = hashlib.sha256()
    for name in ('excel_parser.py', 'warehouse.py', 'runtime_paths.py', 'requirements.txt'):
        digest.update(name.encode('utf-8') + b'\0')
        digest.update(hashlib.sha256((root / name).read_bytes()).digest())
    return digest.hexdigest()


# Freeze the version with the imported parser. Restart loads new code and version together.
PARSER_VERSION = parser_revision()
OVERRIDES = data_dir(Path(__file__).resolve().parent) / 'recognition.json'


@dataclass
class ParsedTable:
    file_path: Path
    sheet_name: str
    table_name: str
    range_ref: str
    dataframe: pd.DataFrame
    header_row: int


def scan_excel_files(folder: str | Path) -> list[Path]:
    root = Path(folder).expanduser().resolve()
    if not root.exists() or not root.is_dir():
        raise ValueError(f"数据目录不存在：{root}")
    return sorted(
        path
        for path in root.rglob("*")
        if path.is_file()
        and path.suffix.lower() in SUPPORTED_SUFFIXES
        and not path.name.startswith("~$")
    )


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _clean(value: Any) -> Any:
    if isinstance(value, str):
        value = re.sub(r"\s+", " ", value).strip()
        return value or None
    return value


def _row_nonempty(row: list[Any]) -> int:
    return sum(not _blank(value) for value in row)


def _consecutive_bands(indices: Iterable[int]) -> Iterable[tuple[int, int]]:
    start = previous = None
    for index in sorted(indices):
        if previous is None or index != previous + 1:
            if start is not None:
                yield start, previous
            start = index
        previous = index
    if start is not None:
        yield start, previous


def _populated_rows(worksheet) -> dict[int, dict[int, Any]]:
    # Normal-mode openpyxl retains merges and has already loaded the stored
    # cells. iter_rows over max_row/max_column would instantiate every blank.
    rows: dict[int, dict[int, Any]] = {}
    for (row, column), cell in worksheet._cells.items():
        value = _clean(cell.value)
        if not _blank(value):
            rows.setdefault(row, {})[column] = value
    return rows


def _header_score(rows: list[list[Any]], candidate: int) -> float:
    row = rows[candidate]
    values = [value for value in row if not _blank(value)]
    if len(values) < 2:
        return -1
    strings = sum(isinstance(value, str) for value in values)
    unique = len({str(value).strip().lower() for value in values}) / len(values)
    below = rows[candidate + 1 : candidate + 5]
    data_rows = sum(_row_nonempty(item) >= 2 for item in below)
    if data_rows == 0:
        return -1
    string_ratio = strings / len(values)
    next_values = [value for item in below for value in item if not _blank(value)]
    next_string_ratio = (
        sum(isinstance(value, str) for value in next_values) / len(next_values)
        if next_values
        else 1
    )
    type_contrast = max(0.0, string_ratio - next_string_ratio)
    periods = sum(isinstance(v, (date, datetime)) or bool(re.fullmatch(
        r'(?:\d{4}[-/.年])?\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}月|\d{2,4}WK\d{1,2}|D\d+', str(v), re.I)) for v in values)
    return string_ratio * 3 + unique + type_contrast * 2 + min(data_rows, 3) * 0.4 + (5 if periods >= 2 else 0)


def _fill_merged_labels(worksheet, rows, first_row, header_row, left, right):
    """Fill only actual vertical merges below this header; ordinary blanks stay blank."""
    bottom = first_row + len(rows) - 1
    for merged in worksheet.merged_cells.ranges:
        if merged.min_col != merged.max_col or not (left <= merged.min_col <= right):
            continue
        if merged.min_row <= header_row or merged.min_row > bottom:
            continue
        column = merged.min_col - left
        value = rows[merged.min_row - first_row][column]
        for row in range(merged.min_row, min(merged.max_row, bottom) + 1):
            rows[row - first_row][column] = value


def _make_headers(values: Iterable[Any]) -> list[str]:
    headers: list[str] = []
    seen: dict[str, int] = {}
    for index, value in enumerate(values, start=1):
        base = str(value).strip() if not _blank(value) else f"字段{index}"
        base = re.sub(r"\s+", " ", base)
        candidate = base
        stem = base.lstrip('_') or f"字段{index}"
        count = 1
        while candidate.casefold() in seen or candidate.startswith('_'):
            count += 1
            candidate = f"{stem}_{count}"
        seen[candidate.casefold()] = 1
        headers.append(candidate)
    return headers


def _table_title(rows: list[list[Any]], header_index: int, fallback: str) -> str:
    for index in range(header_index - 1, -1, -1):
        values = [str(v).strip() for v in rows[index] if not _blank(v)]
        if 1 <= len(values) <= 3:
            title = " ".join(values)
            if len(title) <= 80:
                return title
    return fallback


def _discover_worksheet(file_path, worksheet):
    populated = _populated_rows(worksheet)
    for band_number, (top, bottom) in enumerate(_consecutive_bands(populated), start=1):
        if bottom == top:
            continue
        columns = {column for row in range(top, bottom + 1) for column in populated[row]}
        for left, right in _consecutive_bands(columns):
            if right == left:
                continue
            rows = [[populated[row].get(column) for column in range(left, right + 1)]
                    for row in range(top, bottom + 1)]
            search_limit = min(len(rows) - 1, 12)
            scores = [(_header_score(rows, idx), idx) for idx in range(search_limit)]
            score, header_idx = max(scores, key=lambda pair: (pair[0], -pair[1]), default=(-1, -1))
            if score < 0:
                continue
            header_row = top + header_idx
            _fill_merged_labels(worksheet, rows, top, header_row, left, right)
            headers = _make_headers(rows[header_idx])
            body = [row for row in rows[header_idx + 1:] if _row_nonempty(row)]
            frame = pd.DataFrame(body, columns=headers).dropna(axis=1, how="all").dropna(axis=0, how="all")
            if frame.empty or frame.shape[1] < 2:
                continue
            fallback = f"{worksheet.title} 表{band_number}"
            title = _table_title(rows, header_idx, fallback)
            if title == fallback:
                # A title may be separated from its header by blank rows.
                for prior in range(top - 1, max(0, top - 5), -1):
                    previous = populated.get(prior, {})
                    values = [previous[col] for col in sorted(previous) if left <= col <= right]
                    if not values:
                        continue
                    if len(values) == 1 and isinstance(values[0], str) and len(values[0]) <= 80:
                        title = values[0]
                    break
            range_ref = (f"{get_column_letter(left)}{header_row}:"
                         f"{get_column_letter(right)}{header_row + len(body)}")
            yield ParsedTable(file_path, worksheet.title, title, range_ref, frame.reset_index(drop=True), header_row)


def discover_tables(path: str | Path, rules=None, notices=None) -> list[ParsedTable]:
    file_path = Path(path).resolve()
    rules = rules if rules is not None else (json.loads(OVERRIDES.read_text(encoding='utf-8')) if OVERRIDES.exists() else {})
    relevant = [rule for rule in rules.values() if Path(rule['file']).resolve() == file_path]
    workbook = load_workbook(file_path, data_only=True, read_only=False)
    try:
        discovered = [table for sheet in workbook.worksheets for table in _discover_worksheet(file_path, sheet)]
        for rule in relevant:
            if rule['sheet'] not in workbook.sheetnames:
                message = f"手动识别规则的工作表“{rule['sheet']}”已不存在，已跳过该规则并识别当前工作表"
                if notices is not None:
                    notices.append(message)
                else:
                    import warnings
                    warnings.warn(message, UserWarning, stacklevel=2)
                continue
            from openpyxl.utils.cell import range_boundaries
            left, top, right, bottom = range_boundaries(rule['range'])
            sheet = workbook[rule['sheet']]
            if bottom > sheet.max_row or right > sheet.max_column:
                raise ValueError('指定区域超过工作表有效范围')
            values = [[_clean(v) for v in row] for row in sheet.iter_rows(
                min_row=top, max_row=bottom, min_col=left, max_col=right, values_only=True)]
            _fill_merged_labels(sheet, values, top, top, left, right)
            frame = pd.DataFrame(values[1:], columns=_make_headers(values[0]))
            if frame.empty:
                raise ValueError('指定区域没有数据')
            original = rule.get('original', rule['range']).split(':')[0]
            discovered = [t for t in discovered if not (t.sheet_name == rule['sheet'] and t.range_ref.split(':')[0] in (original, rule['range'].split(':')[0]))]
            discovered.append(ParsedTable(file_path, rule['sheet'], rule['name'], rule['range'], frame, top))
        return discovered
    finally:
        workbook.close()


def infer_series_type(series: pd.Series) -> str:
    values = series.dropna()
    if values.empty:
        return "empty"
    if pd.api.types.is_datetime64_any_dtype(values):
        return "date"
    numeric = pd.to_numeric(values, errors="coerce")
    if numeric.notna().mean() >= 0.8:
        return "number"
    header = str(series.name).lower()
    date_hint = any(word in header for word in ("日期", "时间", "年月", "date", "time", "month"))
    has_date_values = values.map(lambda value: isinstance(value, (date, datetime, pd.Timestamp))).any()
    if date_hint or has_date_values:
        # Date columns may mix Excel dates, ISO strings, and localized text dates.
        # ``format='mixed'`` keeps per-value inference explicit on pandas 2.2+
        # and avoids the warning about falling back to dateutil.
        parsed_dates = pd.to_datetime(values, format="mixed", errors="coerce")
        if parsed_dates.notna().mean() >= 0.8:
            return "date"
    return "text"
