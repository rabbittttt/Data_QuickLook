"""Resolve shared Excel inputs without moving an application's own state."""

import os
from pathlib import Path

from runtime_paths import source_base


def resolve_source_path(root, value):
    path = Path(value).expanduser()
    return path if path.is_absolute() else (Path(root).resolve() / path).resolve()


def shared_data_root(root):
    root = Path(root)
    configured = os.environ.get("SHARED_DATA_ROOT", "").strip()
    if configured:
        return resolve_source_path(source_base(root), configured).resolve()
    data_root = os.environ.get("PLANHUB_DATA_ROOT", "").strip() or "../工作台数据"
    shared_root = resolve_source_path(root, data_root) / "shared"
    return shared_root if shared_root.is_dir() else None


def source_directories(settings):
    """Accept normalized multi-source settings and older single-folder settings."""
    values = settings['folders'] if 'folders' in settings else [settings.get('folder')]
    if not isinstance(values, list) or not values:
        raise ValueError('请至少配置一个数据源目录')
    result, seen = [], set()
    for value in values:
        if not isinstance(value, (str, Path)) or not str(value).strip():
            raise ValueError('数据源目录不能为空')
        path = Path(value).expanduser().resolve()
        key = os.path.normcase(str(path))
        if key not in seen:
            seen.add(key)
            result.append(path)
    return result
