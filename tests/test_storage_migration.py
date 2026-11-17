from contextlib import closing
import importlib.util,sqlite3,tempfile,unittest,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('private_migration',Path(__file__).resolve().parents[1]/'scripts/migrate_storage.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class StorageMigrationTests(unittest.TestCase):
 def test_upload_paths_change_without_losing_rows_or_touching_originals(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp).resolve();stage=root/'stage';stage.mkdir();old=root/'old';new=root/'new'
   original=str(old/'uploads/book.xlsx')
   with closing(sqlite3.connect(stage/'warehouse.db')) as c, c:
    c.execute('create table datasets(id text,file_path text)');c.execute('insert into datasets values(?,?)',('stable-id',original))
    for table in ['file_versions','uploaded_files']:
     c.execute(f'create table {table}(path text primary key)');c.execute(f'insert into {table} values(?)',(original,))
   (stage/'recognition.json').write_text(json.dumps({original+'|Sheet':{'file':original}}))
   module.relocate(stage,old,new)
   with closing(sqlite3.connect(stage/'warehouse.db')) as c, c:self.assertEqual(c.execute('select * from datasets').fetchone(),('stable-id',str(new/'uploads/book.xlsx')))
   self.assertIn(str(new/'uploads/book.xlsx')+'|Sheet',json.loads((stage/'recognition.json').read_text()))
   self.assertFalse(old.exists());self.assertFalse(new.exists())
 def test_refuses_live_directory(self):
  with tempfile.TemporaryDirectory() as tmp:
   with self.assertRaises(ValueError):module.relocate(tmp,tmp,Path(tmp)/'new')
