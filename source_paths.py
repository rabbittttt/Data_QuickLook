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


def source_config(root, config_file=None):
    root = Path(root)
    config_file = resolve_source_path(root, config_file) if config_file is not None else root / "output_file" / "workspace.json"
    if config_file.exists():
        saved = json.loads(config_file.read_text(encoding="utf-8"))
        return {**saved, "folder": str(resolve_source_path(root, saved["folder"]))}
    return {"folder": str(default_source_directory(root)), "auto": True}


def portable_source_config(root, folder, auto=True):
    """Store workspace-local sources relative to this project; keep external paths."""
    root = Path(root).resolve()
    folder = resolve_source_path(root, folder).resolve()
    saved = (Path(os.path.relpath(folder, root)).as_posix()
             if folder.is_relative_to(root.parent) else str(folder))
    return {"folder": saved, "auto": bool(auto)}
