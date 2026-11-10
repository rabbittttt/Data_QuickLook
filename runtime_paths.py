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
    """Use the original output_file unless an explicit state directory is set."""
    return _configured_path(root, DATA_DIR_ENV) or Path(root) / 'output_file'


def source_base(root):
    """Anchor old relative paths to the original output_file parent by default."""
    return _configured_path(root, SOURCE_BASE_ENV) or data_dir(root).parent
