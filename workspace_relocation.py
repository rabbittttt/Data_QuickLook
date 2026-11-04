"""Conservatively reconnect shared sources after an entire workspace moves."""
from collections import Counter
import json
import os
from pathlib import Path
import sqlite3
import tempfile

from excel_parser import PARSER_VERSION


def _key(path):
    return os.path.normcase(str(path))


def _signature(path):
    stat = path.stat()
    return f'{stat.st_mtime_ns}:{stat.st_size}:{PARSER_VERSION}'


def _rule_copies(rules, old_path, new_path):
    additions = {}
    for key, rule in rules.items():
        if not isinstance(rule, dict) or not isinstance(rule.get('file'), str):
            continue
        if _key(Path(rule['file']).resolve()) != _key(old_path):
            continue
        prefix, separator, suffix = key.partition('|')
        if not separator or _key(Path(prefix).resolve()) != _key(old_path):
            raise ValueError('invalid_rule_key')
        new_key = str(new_path) + '|' + suffix
        copied = {**rule, 'file': str(new_path)}
        if new_key in rules and rules[new_key] != copied:
            raise ValueError('rule_conflict')
        if new_key not in rules:
            additions[new_key] = copied
    return additions


def _save_rule_copies(path, original, rules):
    # Keep every old key. If the database transaction later fails, both source
    # paths still have their rules; no original rule has been removed.
    if path.read_bytes() != original:
        raise RuntimeError('识别规则在迁移检查后发生变化，请重试。')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix='.recognition-relocate-', suffix='.tmp', delete=False) as output:
            temporary = Path(output.name)
            json.dump(rules, output, ensure_ascii=False, indent=2)
            output.write('\n')
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def relocate_shared_sources(database_path, shared_root, *, active_sources=None,
                            rules_path=None, dry_run=True):
    """Return a migration plan; write only when explicitly passed dry_run=False.

    The shared directory keeps its name and relative contents. Its old parent
    workspace must no longer exist, and current file signatures must match.
    Existing IDs/SQL tables and private input history are never rewritten.
    """
    shared_root = Path(shared_root).resolve()
    result = {'mappings': [], 'skipped': [], 'files': 0, 'datasets': 0,
              'rules_added': 0, 'applied': False}
    if not shared_root.is_dir():
        return result
    allowed = [Path(path).resolve() for path in active_sources] if active_sources is not None else [shared_root]
    rules_path = Path(rules_path) if rules_path is not None else None
    original_rules = rules_path.read_bytes() if rules_path is not None and rules_path.exists() else None
    rules = json.loads(original_rules.decode('utf-8-sig')) if original_rules is not None else {}
    if not isinstance(rules, dict):
        raise ValueError('识别规则必须为对象，未迁移任何数据。')
    connection = sqlite3.connect(Path(database_path).resolve().as_uri() + ('?mode=ro' if dry_run else '?mode=rw'), uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute('BEGIN' if dry_run else 'BEGIN IMMEDIATE')
        versions = connection.execute('SELECT path, signature FROM file_versions').fetchall()
        dataset_paths = Counter(row[0] for row in connection.execute('SELECT file_path FROM datasets'))
        registered = {_key(Path(row['path'])) for row in versions} | {_key(Path(path)) for path in dataset_paths}
        candidates = []

        def skip(path, reason):
            result['skipped'].append({'path': str(path), 'reason': reason})

        for row in versions:
            old_path = Path(row['path'])
            anchors = [index for index, part in enumerate(old_path.parts)
                       if part.casefold() == shared_root.name.casefold()]
            if not old_path.is_absolute() or not anchors or old_path.is_relative_to(shared_root):
                continue
            if len(anchors) != 1:
                skip(old_path, 'ambiguous_shared_anchor')
                continue
            anchor = anchors[0]
            old_workspace = Path(*old_path.parts[:anchor])
            target = shared_root.joinpath(*old_path.parts[anchor + 1:]).resolve()
            if old_workspace.exists():
                skip(old_path, 'old_workspace_exists')
                continue
            if not target.is_relative_to(shared_root) or not any(target.is_relative_to(source) for source in allowed):
                skip(old_path, 'outside_active_sources')
                continue
            if _key(target) in registered:
                skip(old_path, 'target_registered')
                continue
            if not target.is_file():
                skip(old_path, 'target_missing')
                continue
            try:
                if _signature(target) != row['signature']:
                    skip(old_path, 'signature_mismatch')
                    continue
                additions = _rule_copies(rules, old_path, target)
            except (OSError, ValueError) as error:
                skip(old_path, str(error))
                continue
            candidates.append((old_path, target, row['signature'], additions))

        targets = Counter(_key(target) for _, target, _, _ in candidates)
        additions = {}
        for old_path, target, signature, copies in candidates:
            if targets[_key(target)] != 1:
                skip(old_path, 'ambiguous_target')
                continue
            # Recheck while holding the database transaction; a file may be
            # saved or an old workspace restored during the initial scan.
            anchor = next(index for index, part in enumerate(old_path.parts)
                          if part.casefold() == shared_root.name.casefold())
            try:
                stable = not Path(*old_path.parts[:anchor]).exists() and _signature(target) == signature
            except OSError:
                stable = False
            if not stable:
                skip(old_path, 'source_changed')
                continue
            count = dataset_paths[str(old_path)]
            result['mappings'].append({'old_path': str(old_path), 'new_path': str(target), 'datasets': count})
            additions.update(copies)

        result['files'] = len(result['mappings'])
        result['datasets'] = sum(item['datasets'] for item in result['mappings'])
        result['rules_added'] = len(additions)
        if not dry_run and result['mappings']:
            if additions:
                _save_rule_copies(rules_path, original_rules, {**rules, **additions})
            for item in result['mappings']:
                connection.execute('UPDATE datasets SET file_path=? WHERE file_path=?', (item['new_path'], item['old_path']))
                connection.execute('UPDATE file_versions SET path=? WHERE path=?', (item['new_path'], item['old_path']))
            connection.commit()
            result['applied'] = True
        else:
            connection.rollback()
        return result
    finally:
        connection.close()
