'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const c=vm.createContext({});
for(const file of ['web/chart-logic.js','web/chart-state.js','web/chart-inputs.js'])vm.runInContext(fs.readFileSync(file,'utf8'),c,{filename:file});
const app=fs.readFileSync('web/app.js','utf8');
vm.runInContext(app.slice(app.indexOf('const num='),app.indexOf('const fmt='))+app.slice(app.indexOf('function aggregateRows'),app.indexOf('async function home')),c);
const plain=value=>JSON.parse(JSON.stringify(value));
const table=fields=>({id:'source',sheet_name:'数据',table_name:'经营指标',fields:fields.map(([name,type])=>({name,type}))});
const records=table([['月份','text'],['车型','text'],['销量','number'],['库存','number']]);
const recordRows=[{月份:'2026-01',车型:'M8',销量:100,库存:12},{月份:'2026-01',车型:'M8',销量:20,库存:3},{月份:'2026-02',车型:'M8',销量:150,库存:10},{月份:'2026-01',车型:'M9',销量:90,库存:6}];
const matrix=table([['指标','text'],['1月','number'],['2月','number']]);
const matrixRows=[{指标:'销量','1月':100,'2月':120},{指标:'库存','1月':50,'2月':40}];
const tests=[];const test=(name,run)=>tests.push({name,run});
const column=name=>c.chartColumnInputKey(name);
function compile(source,rows,draft){const catalog=c.chartMetricCatalog(source,rows,draft);return {catalog,specs:c.unifiedChartSpecs(draft,source,catalog)};}
function values(source,rows,spec){return plain([...c.aggregateRows({rows,fields:source.fields,columns:source.fields.map(f=>f.name)},spec)]);}

vm.runInContext(app.slice(app.indexOf('function metricScore'),app.indexOf('function chooseDimension')),c);
test('overview and reopened series keep the same metric, time direction and values',()=>{
  const cumulative=table([['车型','text'],['累计销量','number']]);
  const rows=[100,200,300,400,500].map(n=>({车型:'M8',累计销量:n}));
  const spec=c.overviewSeries(cumulative,rows);
  assert.equal(spec.operation,'最新值');
  assert.deepEqual(values(cumulative,rows,spec),[['M8',500]]);
  const months=['2026年1月','2026年2月','2026年3月'];
  const wide=table([['车型','text'],['指标','text'],...months.map(m=>[m,'number'])]);
  const wideRows=[{车型:'M8',指标:'销量',[months[0]]:100,[months[1]]:120,[months[2]]:140}];
  const tall=table([['月份','text'],['销量','number']]);
  const tallRows=months.map(m=>({月份:m,销量:wideRows[0][m]}));
  assert.deepEqual(values(wide,wideRows,c.overviewSeries(wide,wideRows)),values(tall,tallRows,c.overviewSeries(tall,tallRows)));
});

test('vertical metrics select actual cell values and retain each statistic',()=>{
  const draft={dimension:'月份',inputKeys:[column('销量'),column('库存')],filters:[{field:'车型',value:'M8'}],autoOperation:true};
  const {specs}=compile(records,recordRows,draft);
  assert.equal(specs.length,2);assert.equal(specs[0].wide,false);
  assert.deepEqual(values(records,recordRows,specs[0]),[['2026-01',120],['2026-02',150]]);
  assert.deepEqual(values(records,recordRows,specs[1]),[['2026-01',15],['2026-02',10]]);
});
test('transposed sales and inventory are selectable by their row labels',()=>{
  const catalog=c.chartMetricCatalog(matrix,matrixRows,{}),rows=catalog.items.filter(item=>item.kind==='row');
  assert.deepEqual(rows.map(item=>item.label),['销量','库存']);
  assert.equal(rows.some(item=>item.label==='100'),false);
  assert.deepEqual(plain(c.chartMetricSelection({},catalog)),[rows[0].value]);
  const specs=c.unifiedChartSpecs({inputKeys:rows.map(item=>item.value)},matrix,catalog);
  assert.deepEqual(values(matrix,matrixRows,specs[0]),[['1月',100],['2月',120]]);
  assert.deepEqual(values(matrix,matrixRows,specs[1]),[['1月',50],['2月',40]]);
  assert.equal(specs[0].businessMetric,'销量');
});
test('category matrices use their header labels without requiring dates',()=>{
  const source=table([['项目','text'],['线上','number'],['线下','number']]),rows=[{项目:'销量',线上:4,线下:7},{项目:'库存',线上:2,线下:3}];
  const catalog=c.chartMetricCatalog(source,rows,{}),item=catalog.items.find(item=>item.kind==='row');
  const [spec]=c.unifiedChartSpecs({inputKeys:[item.value]},source,catalog);
  assert.equal(spec.axisMode,'category');
  assert.deepEqual(values(source,rows,spec),[['线上',4],['线下',7]]);
  assert.throws(()=>c.unifiedChartSpecs({inputKeys:[item.value],axisMode:'time'},source,catalog),/时间横轴.*无法识别/);
});
test('mixed row and column choices compile to independent compatible series',()=>{
  const draft={dimension:'指标'},catalog=c.chartMetricCatalog(matrix,matrixRows,draft);
  draft.inputKeys=[column('1月'),catalog.items.find(item=>item.kind==='row'&&item.label==='库存').value];
  const specs=c.unifiedChartSpecs(draft,matrix,catalog);
  assert.deepEqual(plain(specs.map(spec=>spec.wide)),[false,true]);
  assert.deepEqual(values(matrix,matrixRows,specs[0]),[['销量',100],['库存',50]]);
  assert.deepEqual(values(matrix,matrixRows,specs[1]),[['1月',50],['2月',40]]);
});
test('all category levels are retained, and repeated complete labels aggregate',()=>{
  const source=table([['车型','text'],['版本','text'],['指标','text'],['1月','number'],['2月','number']]);
  const rows=[{车型:'M8',版本:'Pro',指标:'销量','1月':10,'2月':11},{车型:'M8',版本:'Max',指标:'销量','1月':20,'2月':21},{车型:'M8',版本:'Pro',指标:'销量','1月':5,'2月':6}];
  const catalog=c.chartMetricCatalog(source,rows,{}),items=catalog.items.filter(item=>item.kind==='row');
  assert.equal(items.length,2);assert.deepEqual(plain(catalog.rowFields),['车型','版本','指标']);
  assert.equal(items[0].label,'M8 / Pro / 销量');
  const specs=c.unifiedChartSpecs({inputKeys:items.map(item=>item.value)},source,catalog);
  assert.deepEqual(values(source,rows,specs[0]),[['1月',15],['2月',17]]);
  assert.deepEqual(values(source,rows,specs[1]),[['1月',20],['2月',21]]);
});
test('unlabelled row indices keep original positions after filters and totals',()=>{
  const source=table([['类别','text'],['1月','number'],['2月','number']]);
  const rows=[{类别:'合计','1月':99,'2月':99},{类别:'甲','1月':1,'2月':2},{类别:'乙','1月':3,'2月':4}];
  const draft={rowMode:'index',filters:[{field:'类别',value:'乙'}]},catalog=c.chartMetricCatalog(source,rows,draft),item=catalog.items.find(item=>item.kind==='row');
  assert.equal(item.label,'数据第 3 行');assert.equal(item.rowValue,'3');
  const [spec]=c.unifiedChartSpecs({...draft,inputKeys:[item.value]},source,catalog);
  assert.deepEqual(values(source,rows,spec),[['1月',3],['2月',4]]);
});
test('numeric data cells never become row label candidates',()=>{
  const source=table([['1月','number'],['2月','number']]),rows=[{'1月':10,'2月':20},{'1月':30,'2月':40}];
  const catalog=c.chartMetricCatalog(source,rows,{});
  assert.equal(catalog.rowField,'__row_index__');
  assert.deepEqual(catalog.items.filter(item=>item.kind==='row').map(item=>item.label),['数据第 1 行','数据第 2 行']);
});
test('explicit empty metric/axis/label selections are not refilled',()=>{
  const catalog=c.chartMetricCatalog(matrix,matrixRows,{});
  assert.deepEqual(plain(c.chartMetricSelection({inputKeys:[]},catalog)),[]);
  assert.throws(()=>c.unifiedChartSpecs({inputKeys:[]},matrix,catalog),/至少选择一个数值指标/);
  const emptyAxis=c.chartMetricCatalog(matrix,matrixRows,{periods:[]});
  assert.deepEqual(plain(emptyAxis.rowPeriods),[]);
  const row=emptyAxis.items.find(item=>item.kind==='row');assert.ok(row);
  assert.throws(()=>c.unifiedChartSpecs({inputKeys:[row.value]},matrix,emptyAxis),/至少 1 个横轴数据列/);
  const emptyLabels=c.chartMetricCatalog(matrix,matrixRows,{seriesFields:[],labelFieldsTouched:true});
  assert.equal(emptyLabels.rowField,'__row_index__');assert.deepEqual(plain(emptyLabels.rowFields),[]);
});
test('removed metrics and filtered-out rows stay invalid until corrected',()=>{
  const draft={inputKeys:[column('已删除')]},catalog=c.chartMetricCatalog(matrix,matrixRows,draft);
  assert.deepEqual(plain(c.chartMetricSelection(draft,catalog)),draft.inputKeys);
  assert.throws(()=>c.unifiedChartSpecs(draft,matrix,catalog),/已删除.*不可用/);
  const original=c.chartMetricCatalog(matrix,matrixRows,{}),sales=original.items.find(item=>item.label==='销量');
  const filtered={inputKeys:[sales.value],filters:[{field:'指标',value:'库存'}]},next=c.chartMetricCatalog(matrix,matrixRows,filtered);
  assert.throws(()=>c.unifiedChartSpecs(filtered,matrix,next),/销量.*不可用/);
  assert.throws(()=>compile(matrix,matrixRows,{dimension:'指标',inputKeys:[column('1月')],filters:[{field:'不存在',value:'a'}]}),/筛选字段.*不存在/);
});
test('filters and subtotal exclusion match aggregation row visibility',()=>{
  const rows=[...matrixRows,{指标:'合计','1月':150,'2月':160}];
  const catalog=c.chartMetricCatalog(matrix,rows,{});
  assert.equal(catalog.items.filter(item=>item.kind==='row').length,2);
  const inclusive=c.chartMetricCatalog(matrix,rows,{excludeTotals:false});
  const item=inclusive.items.find(item=>item.label==='合计'),[spec]=c.unifiedChartSpecs({inputKeys:[item.value],excludeTotals:false},matrix,inclusive);
  assert.deepEqual(values(matrix,rows,spec),[['1月',150],['2月',160]]);
});
test('editing a legacy vehicle-only matrix keeps aggregating all versions',()=>{
  const source=table([['车型','text'],['版本','text'],['1月','number'],['2月','number']]),rows=[{车型:'M8',版本:'Pro','1月':1,'2月':2},{车型:'M8',版本:'Max','1月':3,'2月':4},{车型:'M9',版本:'Max','1月':9,'2月':9}];
  const draft={wide:true,legacyRowSelection:true,sourceId:source.id,vehicleField:'车型',selectedValues:['M8'],selectionTouched:true,seriesFields:[],periods:['1月','2月'],operation:'求和',axisMode:'auto'};
  const {catalog,specs}=compile(source,rows,draft);
  assert.deepEqual(plain(catalog.rowFields),['车型']);assert.equal(specs[0].vehicleField,'车型');
  assert.deepEqual(values(source,rows,specs[0]),[['1月',4],['2月',6]]);
  const invalid={...draft,selectedValues:['已消失']};
  assert.throws(()=>compile(source,rows,invalid),/已消失.*不可用/);
});
test('legacy whole-table matrix series preserve whole-table aggregation',()=>{
  const draft={wide:true,legacyRowSelection:true,sourceId:matrix.id,vehicleField:'',selectedValues:[],selectionTouched:true,periods:['1月','2月'],operation:'求和'};
  const {specs}=compile(matrix,matrixRows,draft);
  assert.equal(specs[0].vehicleField,'');
  assert.deepEqual(values(matrix,matrixRows,specs[0]),[['1月',150],['2月',160]]);
});
test('legacy tuple/index edits and unlimited selection preserve source identity',()=>{
  const source=table([['车型','text'],['版本','text'],['1月','number'],['2月','number']]),rows=Array.from({length:40},(_,i)=>({车型:'M8',版本:'V'+i,'1月':i,'2月':i+1}));
  for(const vehicleField of ['__row_labels__','__row_index__']){
    const selected=vehicleField==='__row_labels__'?JSON.stringify(['M8','V18']):'19';
    const draft={wide:true,legacyRowSelection:true,vehicleField,seriesFields:['车型','版本'],selectedValues:[selected],selectionTouched:true,periods:['1月','2月'],operation:'求和'};
    const {specs}=compile(source,rows,draft);assert.equal(specs[0].vehicleField,vehicleField);
    assert.deepEqual(values(source,rows,specs[0]),[['1月',18],['2月',19]]);
  }
  const catalog=c.chartMetricCatalog(source,rows,{}),all=catalog.items.filter(item=>item.kind==='row').map(item=>item.value);
  assert.equal(c.unifiedChartSpecs({inputKeys:all},source,catalog).length,40);
});
test('legacy vertical split and new split fields remain equivalent',()=>{
  const legacy={wide:false,dimension:'月份',metrics:['销量'],vehicleField:'车型',selectedValues:['M8'],operation:'求和'};
  const modern={dimension:'月份',inputKeys:[column('销量')],splitField:'车型',splitValues:['M8'],operation:'求和'};
  const oldSpecs=compile(records,recordRows,legacy).specs,newSpecs=compile(records,recordRows,modern).specs;
  assert.deepEqual(plain(oldSpecs),plain(newSpecs));
  assert.throws(()=>compile(records,recordRows,{...modern,splitValues:['不存在']}),/对比项.*不可用/);
  assert.throws(()=>compile(records,recordRows,{...modern,splitValues:[]}),/至少勾选一个/);
});
test('empty scalar row labels are represented without accidentally selecting all rows',()=>{
  const rows=[{指标:'','1月':1,'2月':2},...matrixRows],catalog=c.chartMetricCatalog(matrix,rows,{});
  const item=catalog.items.find(item=>item.kind==='row'&&item.label==='（空）');
  const [spec]=c.unifiedChartSpecs({inputKeys:[item.value]},matrix,catalog);
  assert.equal(spec.vehicleField,'__row_labels__');
  assert.deepEqual(values(matrix,rows,spec),[['1月',1],['2月',2]]);
});
test('explicit source-row mode remains independent even when labels are empty',()=>{
  const rows=[{指标:'','1月':1,'2月':2},{指标:'','1月':10,'2月':20}];
  const draft={rowMode:'index'},catalog=c.chartMetricCatalog(matrix,rows,draft),items=catalog.items.filter(item=>item.kind==='row');
  assert.equal(catalog.rowField,'__row_index__');assert.equal(items.length,2);
  const [spec]=c.unifiedChartSpecs({...draft,inputKeys:[items[1].value]},matrix,catalog);
  assert.deepEqual(values(matrix,rows,spec),[['1月',10],['2月',20]]);
});
test('saved single-field tuple selections can be reopened without changing identity',()=>{
  const rows=[{指标:'','1月':1,'2月':2},...matrixRows];
  const draft={wide:true,legacyRowSelection:true,vehicleField:'__row_labels__',seriesFields:['指标'],selectedValues:['["销量"]'],selectionTouched:true,periods:['1月','2月'],operation:'求和'};
  const {catalog,specs}=compile(matrix,rows,draft);
  assert.equal(catalog.rowField,'__row_labels__');assert.equal(specs[0].vehicleValue,'["销量"]');
  assert.deepEqual(values(matrix,rows,specs[0]),[['1月',100],['2月',120]]);
});
test('manual reading mode narrows candidates without replacing invalid selections',()=>{
  const base=c.chartMetricCatalog(matrix,matrixRows,{}),row=base.items.find(item=>item.kind==='row');
  const columnOnly=c.chartMetricCatalog(matrix,matrixRows,{readingMode:'records'});
  assert.equal(columnOnly.items.every(item=>item.kind==='column'),true);
  assert.throws(()=>c.unifiedChartSpecs({inputKeys:[row.value]},matrix,columnOnly),/不可用/);
  assert.equal(c.chartMetricCatalog(matrix,matrixRows,{readingMode:'matrix'}).items.every(item=>item.kind==='row'),true);
});
test('text columns default to count while ratios retain shared ratio semantics',()=>{
  const counted=compile(records,recordRows,{dimension:'月份',inputKeys:[column('车型')]}).specs;
  assert.equal(counted[0].operation,'非空计数');
  assert.deepEqual(values(records,recordRows,counted[0]),[['2026-01',3],['2026-02',1]]);
  const draft={dimension:'月份',inputKeys:[column('销量'),column('库存')],operation:'总体比例',numerator:'库存',denominator:'销量'};
  const {specs}=compile(records,recordRows,draft);
  assert.equal(specs.length,1);assert.equal(values(records,recordRows,specs[0])[0][1],21/210);
  const catalog=c.chartMetricCatalog(matrix,matrixRows,{}),row=catalog.items.find(item=>item.kind==='row');
  assert.throws(()=>c.unifiedChartSpecs({...draft,inputKeys:[row.value]},matrix,catalog),/总体比例仅适用于列指标/);
});
test('explicit time rejects unparseable vertical values',()=>{
  const rows=[{月份:'待定',车型:'M8',销量:1,库存:2}];
  assert.throws(()=>compile(records,rows,{dimension:'月份',inputKeys:[column('销量')],axisMode:'time'}),/时间横轴.*无法识别/);
});
test('an unused invalid row interval cannot block column-only metrics',()=>{
  const {specs}=compile(records,recordRows,{dimension:'月份',inputKeys:[column('销量')],rangeError:'止列不能位于起列之前。'});
  assert.equal(specs.length,1);assert.equal(specs[0].wide,false);
});
test('preview and commit receive the same pure specs and preserve saved schema',()=>{
  const draft={dimension:'月份',inputKeys:[column('销量'),column('库存')],label:'M8经营',operation:'求和',axisOrder:'source',filters:[{field:'车型',value:'M8'}]};
  const before=plain(draft),{specs}=compile(records,recordRows,draft),basket=[{uid:'stable',id:records.id,label:'旧系列'}];
  assert.deepEqual(plain(draft),before);
  assert.notEqual(specs[0].label,specs[1].label);
  const preview=c.previewChartSeries(basket,specs,'update','stable'),committed=c.commitChartSeries(basket,specs,'update','stable');
  const withoutIds=series=>plain(series).map(({uid,...spec})=>spec);
  assert.deepEqual(withoutIds(preview),withoutIds(committed));
  assert.equal(committed[0].uid,'stable');assert.deepEqual(plain(basket),[{uid:'stable',id:records.id,label:'旧系列'}]);
  assert.equal(specs.every(spec=>spec.id===records.id&&spec.axisOrder==='source'&&spec.customLabel===true),true);
});

let failures=0;
for(const {name,run} of tests){try{run();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name+'\n'+error.stack);}}
if(failures)process.exitCode=1;else console.log(`Unified chart inputs: ${tests.length} checks passed`);
