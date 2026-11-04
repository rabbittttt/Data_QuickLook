"""Resolve shared Excel inputs without moving an application's own state."""

import json
import os
from pathlib import Path


def resolve_source_path(root, value):
    path = Path(value).expanduser()
    return path if path.is_absolute() else (Path(root).resolve() / path).resolve()


def default_source_directory(root):
    root = Path(root)
    configured = os.environ.get("SHARED_DATA_ROOT")
    if configured:
        return resolve_source_path(root, configured) / "订单汇总"
    shared_root = root.parent / "共享数据"
    if shared_root.is_dir():
        return shared_root / "订单汇总"
    return root / "input_file"


def default_source_directories(root):
    root = Path(root)
    primary = default_source_directory(root)
    if primary == root / 'input_file':
        return [primary]
    return [primary, *[primary.parent / name for name in ('原始销量', '车型信息', 'SOP计划')],
            root / 'input_file']


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


def source_config(root, config_file=None):
    root = Path(root)
    config_file = resolve_source_path(root, config_file) if config_file is not None else root / "output_file" / "workspace.json"
    if config_file.exists():
        saved = json.loads(config_file.read_text(encoding="utf-8"))
        if 'folders' in saved:
            if not isinstance(saved['folders'], list) or not saved['folders']:
                raise ValueError('请至少配置一个数据源目录')
            folders = source_directories({'folders': [resolve_source_path(root, p) for p in saved['folders']],
                                          'folder': saved.get('folder', saved['folders'][0])})
            primary = resolve_source_path(root, saved.get('folder', folders[0])).resolve()
            if primary not in folders:
                primary = folders[0]
            return {**saved, 'folder': str(primary), 'folders': [str(p) for p in folders]}
        return {**saved, "folder": str(resolve_source_path(root, saved["folder"]))}
    folders = default_source_directories(root)
    settings = {"folder": str(folders[0]), "auto": True}
    if len(folders) > 1:
        settings['folders'] = [str(p) for p in folders]
    return settings


def portable_source_config(root, folder, auto=True, folders=None):
    """Store workspace-local sources relative to this project; keep external paths."""
    root = Path(root).resolve()
    folder = resolve_source_path(root, folder).resolve()
    saved = (Path(os.path.relpath(folder, root)).as_posix()
             if folder.is_relative_to(root.parent) else str(folder))
    settings = {"folder": saved, "auto": bool(auto)}
    if folders is not None:
        paths = source_directories({'folder': folder, 'folders': [resolve_source_path(root, p) for p in folders]})
        if folder not in paths:
            raise ValueError('默认导入目录必须是已配置的数据源之一')
        settings['folders'] = [portable_source_config(root, path)['folder'] for path in paths]
    return settings
