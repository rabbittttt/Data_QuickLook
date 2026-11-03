"""Resolve shared Excel inputs without moving an application's own state."""

import json
import os
from pathlib import Path


def default_source_directory(root):
    root = Path(root)
    configured = os.environ.get("SHARED_DATA_ROOT")
    if configured:
        return Path(configured).expanduser() / "订单汇总"
    shared_root = root.parent / "共享数据"
    if shared_root.is_dir():
        return shared_root / "订单汇总"
    return root / "input_file"


def source_config(root, config_file=None):
    root = Path(root)
    config_file = Path(config_file) if config_file is not None else root / "output_file" / "workspace.json"
    if config_file.exists():
        return json.loads(config_file.read_text(encoding="utf-8"))
    return {"folder": str(default_source_directory(root)), "auto": True}
