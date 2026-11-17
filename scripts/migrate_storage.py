from contextlib import closing
"""Relocate private upload references in a staged QuickLook store only."""
import argparse,json,os,sqlite3
from pathlib import Path

def relocate(staged, old, new):
    staged,old,new=Path(staged).resolve(),Path(old).resolve(),Path(new).resolve()
    if staged==old or staged==new:raise ValueError('Only modify a separate staged copy')
    def replace(value):
        if isinstance(value,str):
            filename,separator,suffix=value.partition('|')
            candidate=Path(filename)
            if candidate.is_absolute():
                try:relative=candidate.resolve().relative_to(old)
                except ValueError:pass
                else:return str(new/relative)+(separator+suffix if separator else '')
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
    p=argparse.ArgumentParser();p.add_argument('--staged',required=True);p.add_argument('--old',required=True);p.add_argument('--new',required=True);a=p.parse_args()
    relocate(a.staged,a.old,a.new)
