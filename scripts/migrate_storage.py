from contextlib import closing
"""Relocate saved source or upload references in a staged QuickLook store only."""
import argparse,json,os,sqlite3
from pathlib import Path

def relocate(staged, old, new, source_base=None):
    staged,old,new=Path(staged).resolve(),Path(old).resolve(),Path(new).resolve()
    source_base = Path(source_base).resolve() if source_base is not None else None
    if staged==old or staged==new:raise ValueError('Only modify a separate staged copy')
    def replace(value):
        if isinstance(value,str):
            filename,separator,suffix=value.partition('|')
            candidate=Path(filename)
            was_absolute = candidate.is_absolute()
            if not was_absolute and source_base is not None:
                candidate = Path(source_base) / candidate
            if candidate.is_absolute():
                try:relative=candidate.resolve().relative_to(old)
                except ValueError:pass
                else:
                    target = new / relative
                    value = str(target) if was_absolute else Path(os.path.relpath(target, source_base)).as_posix()
                    return value + (separator+suffix if separator else '')
            return value
        if isinstance(value,list):return [replace(x) for x in value]
        if isinstance(value,dict):return {replace(k):replace(v) for k,v in value.items()}
        return value
    db=staged/'warehouse.db'
    if db.exists():
        with closing(sqlite3.connect(db)) as connection, connection:
            for table,column in [('datasets','file_path'),('file_versions','path'),('uploaded_files','path')]:
                for (value,) in connection.execute(f'SELECT DISTINCT {column} FROM {table}').fetchall():
                    updated=replace(value)
                    if updated!=value:connection.execute(f'UPDATE {table} SET {column}=? WHERE {column}=?',(updated,value))
            if connection.execute('PRAGMA quick_check').fetchone()[0]!='ok':raise ValueError('Invalid migrated database')
    for file in staged.glob('*.json'):
        value=json.loads(file.read_text(encoding='utf-8-sig'))
        updated=replace(value)
        if updated!=value:file.write_text(json.dumps(updated,ensure_ascii=False,indent=2),encoding='utf-8')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--staged',required=True);p.add_argument('--old',required=True);p.add_argument('--new',required=True);p.add_argument('--source-base');a=p.parse_args()
    relocate(a.staged,a.old,a.new,a.source_base)
