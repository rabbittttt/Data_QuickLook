"""Resolve persistent state and the base for existing relative source paths."""

import os
from pathlib import Path


DATA_DIR_ENV = 'DATA_QUICKLOOK_DATA_DIR'
SOURCE_BASE_ENV = 'DATA_QUICKLOOK_SOURCE_BASE'


def _configured_path(root, variable):
    value = os.environ.get(variable, '').strip()
    if not value:
        return None
    return (Path(root) / Path(value).expanduser()).resolve()


def external_data_configured():
    return bool(os.environ.get(DATA_DIR_ENV, '').strip())


def data_dir(root):
    """Use centralized persistent state unless explicitly overridden."""
    return _configured_path(root, DATA_DIR_ENV) or persistent_directory(root)


def source_base(root):
    """Anchor old relative paths to the original output_file parent by default."""
    return _configured_path(root, SOURCE_BASE_ENV) or (data_dir(root).parent if _configured_path(root, DATA_DIR_ENV) else Path(root).resolve())


def persistent_directory(root):
    root = Path(root).resolve()
    value = os.environ.get("PLANHUB_DATA_ROOT", "").strip()
    base = (root / value).resolve() if value else root.parent / "工作台数据"
    destination = base / "database" / "quicklook"
    if not destination.exists() and (root / "output_file" / "warehouse.db").exists():
        raise RuntimeError("旧持久数据尚未迁移，请先停止服务并运行门户的数据迁移工具；不会创建空库。")
    return destination
