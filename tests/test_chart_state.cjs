'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const c=vm.createContext({});
for(const file of ['web/chart-logic.js','web/chart-state.js'])vm.runInContext(fs.readFileSync(file,'utf8'),c,{filename:file});
const plain=value=>JSON.parse(JSON.stringify(value));
const tests=[];
const test=(name,run)=>tests.push({name,run});
const baseBasket=()=>[
  {uid:'series-a',id:'table-a',label:'第一组',metric:'销量'},
  {uid:'series-b',id:'table-b',label:'第二组',metric:'销量'},
  {uid:'series-c',id:'table-c',label:'第三组',metric:'销量'},
];
const wideTable={id:'wide-table',sheet_name:'月度指标',table_name:'经营指标',fields:[
  {name:'指标',type:'text'},{name:'统计类型',type:'text'},{name:'分类',type:'text'},
  {name:'2026-01',type:'number'},{name:'2026-02',type:'number'},
]};
const rowFields=['指标','统计类型','分类'];
const wideDraft=()=>({wide:true,metric:'2026-01',dimension:'日期',operation:'平均值',autoOperation:true,
  vehicleField:'__row_labels__',seriesFields:[...rowFields],periods:['2026-01','2026-02'],
  periodGrain:'month',periodGroupId:'month',excludeTotals:true,
  selectedValues:[JSON.stringify(['动力','占比','增程']),JSON.stringify(['动力','占比','纯电'])],
  filters:[{field:'指标',value:'动力'},{field:'',value:'忽略'},{field:'统计类型',value:''}]});
const longTable={id:'long-table',sheet_name:'门店转化',table_name:'门店经营',fields:[
  {name:'门店',type:'text'},{name:'访客',type:'number'},{name:'成交',type:'number'},
]};
const ratioDraft=()=>({wide:false,dimension:'门店',metric:'成交',operation:'总体比例',
  numerator:'成交',denominator:'访客',vehicleField:'',selectedValues:[]});

test('stable ID updates the same series after an earlier series is deleted',()=>{
  const basket=baseBasket().slice(1),before=plain(basket);
  const result=c.commitChartSeries(basket,[{label:'第二组修改',metric:'订单'}],'update','series-b');
  assert.equal(result.length,2);
  assert.equal(result[0].uid,'series-b');
  assert.equal(result[0].label,'第二组修改');
  assert.equal(result[1].uid,'series-c');
  assert.equal(result[1].label,'第三组');
  assert.deepEqual(basket,before,'committing returns a new basket rather than mutating the old one');
});

test('an edit target deleted elsewhere cannot overwrite its neighbour',()=>{
  const basket=baseBasket().filter(s=>s.uid!=='series-b'),before=plain(basket);
  assert.throws(()=>c.commitChartSeries(basket,[{label:'无效修改'}],'update','series-b'),/已被移除/);
  assert.deepEqual(basket,before);
});

test('normalization repairs missing and duplicate IDs without changing series data',()=>{
  const basket=[{uid:'same',label:'A'},{uid:'same',label:'B'},{label:'C'},{uid:17,label:'D'},{uid:'17',label:'E'}];
  c.normalizeSeriesIds(basket);
  assert.equal(new Set(basket.map(s=>String(s.uid))).size,5);
  assert.ok(basket.every(s=>s.uid));
  assert.equal(basket[0].uid,'same');
  assert.deepEqual(basket.map(s=>s.label),['A','B','C','D','E']);
});

test('append and replacement allocate independent IDs and preserve input objects',()=>{
  const basket=baseBasket(),incoming=[{uid:'series-a',label:'新系列'}];
  const before=plain({basket,incoming});
  const appended=c.commitChartSeries(basket,incoming,'append');
  const replaced=c.commitChartSeries(basket,incoming,'replace');
  assert.equal(appended.length,4);
  assert.equal(replaced.length,1);
  assert.notEqual(appended[3].uid,'series-a');
  assert.notEqual(replaced[0].uid,'series-a');
  assert.deepEqual({basket,incoming},before);
});

test('batch update preserves the first ID and gives additional series fresh IDs',()=>{
  const result=c.commitChartSeries(baseBasket(),[{label:'B1'},{label:'B2'}],'update','series-b');
  assert.deepEqual(Array.from(result,s=>s.label),['第一组','B1','B2','第三组']);
  assert.equal(result[1].uid,'series-b');
  assert.equal(new Set(result.map(s=>s.uid)).size,4);
});

for(const mode of ['append','replace','update'])test(`${mode} accepts more than eight series without mutating inputs`,()=>{
  const basket=baseBasket(),incoming=Array.from({length:9},(_,i)=>({label:`新增${i}`}));
  const before=plain({basket,incoming});
  const result=c.commitChartSeries(basket,incoming,mode,'series-b');
  assert.equal(result.length,mode==='replace'?9:mode==='update'?11:12);
  assert.equal(new Set(result.map(s=>s.uid)).size,result.length);
  assert.deepEqual({basket,incoming},before,'batch commits must leave caller data untouched');
});

test('exactly eight series are allowed and an empty commit is rejected',()=>{
  assert.equal(c.commitChartSeries(baseBasket(),Array.from({length:5},(_,i)=>({label:String(i)})),'append').length,8);
  assert.equal(c.commitChartSeries(baseBasket(),Array.from({length:8},(_,i)=>({label:String(i)})),'replace').length,8);
  assert.throws(()=>c.commitChartSeries(baseBasket(),[],'replace'),/至少/);
});

test('time columns reject duplicate periods and colliding actual and forecast dates',()=>{
  for(const periods of [['2026-01','2026年1月'],['2026-01(实际)','2026-01(预测)']]){
    assert.ok(c.periodSelectionError(periods,{minPeriods:1}));
  }
});

test('hierarchy choices cascade and clear invalid downstream selections',()=>{
  const rows=[
    {指标:'动力',统计类型:'占比',分类:'增程'},
    {指标:'动力',统计类型:'占比',分类:'纯电'},
    {指标:'动力',统计类型:'数量',分类:'增程'},
    {指标:'座椅',统计类型:'数量',分类:'五座'},
  ];
  const before=plain(rows);
  const result=c.hierarchyChoices(rows,rowFields,{指标:'动力',统计类型:'占比'});
  assert.deepEqual(plain(result.levels[0].values),['动力','座椅']);
  assert.deepEqual(plain(result.levels[1].values),['占比','数量']);
  assert.deepEqual(plain(result.levels[2].values),['增程','纯电']);
  assert.equal(result.rows.length,2);
  const changed=c.hierarchyChoices(rows,rowFields,{指标:'座椅',统计类型:'占比',分类:'纯电'});
  assert.equal(changed.levels[1].value,'');
  assert.equal(changed.levels[2].value,'');
  assert.deepEqual(plain(changed.levels[2].values),['五座']);
  assert.deepEqual(rows,before);
});

test('batch specs keep full hierarchy labels, selected rows and independent arrays',()=>{
  const draft=wideDraft(),before=plain(draft),specs=c.draftSeriesSpecs(draft,wideTable);
  assert.equal(specs.length,2);
  assert.deepEqual(Array.from(specs,s=>s.vehicleValue),draft.selectedValues);
  for(const s of specs){
    assert.equal(s.id,wideTable.id);
    assert.equal(s.businessMetric,'动力 · 占比');
    assert.equal(s.operation,'平均值');
    assert.deepEqual(plain(s.seriesFields),rowFields);
    assert.deepEqual(plain(s.filters),[{field:'指标',value:'动力'}]);
    assert.equal(s.excludeTotals,true);
  }
  assert.match(specs[0].label,/指标：动力.*统计类型：占比.*分类：增程/);
  assert.match(specs[1].label,/分类：纯电/);
  specs[0].periods.push('2026-03');
  specs[0].seriesFields.push('额外层级');
  assert.equal(specs[1].periods.length,2);
  assert.equal(specs[1].seriesFields.length,3);
  assert.deepEqual(draft,before);
});

test('draft validation and discarding a preview never mutate the saved basket',()=>{
  const basket=baseBasket(),before=plain(basket);
  c.draftSeriesSpecs(wideDraft(),wideTable); // Preview may be discarded without a commit (cancel).
  assert.deepEqual(basket,before);
  for(const draft of [
    {...wideDraft(),rangeError:'时间范围无效'},
    {...wideDraft(),periods:['2026-01']},
    {...wideDraft(),selectedValues:[]},
    {...ratioDraft(),operation:'求和',metric:'不存在'},
    {...ratioDraft(),dimension:'不存在'},
  ]){
    assert.throws(()=>c.draftSeriesSpecs(draft,draft.wide?wideTable:longTable));
    assert.deepEqual(basket,before);
  }
});

test('overall ratio requires existing numerator and denominator fields',()=>{
  for(const patch of [{numerator:''},{denominator:''},{numerator:'未知'},{denominator:'未知'}]){
    assert.throws(()=>c.draftSeriesSpecs({...ratioDraft(),...patch},longTable),/分子和分母/);
  }
  const [spec]=c.draftSeriesSpecs(ratioDraft(),longTable);
  assert.equal(spec.operation,'总体比例');
  assert.equal(spec.numerator,'成交');
  assert.equal(spec.denominator,'访客');
  assert.equal(spec.businessMetric,'成交 / 访客');
});

test('overall ratio is rejected for a wide time-series draft',()=>{
  const draft={...wideDraft(),operation:'总体比例',numerator:'2026-01',denominator:'2026-02'};
  assert.throws(()=>c.draftSeriesSpecs(draft,wideTable),/总体比例仅适用于普通字段模式/);
});

test('a wide draft cannot save time columns removed from current metadata',()=>{
  const rescannedTable={...wideTable,fields:wideTable.fields.filter(f=>f.name!=='2026-02')};
  const draft=wideDraft(),before=plain(draft);
  assert.throws(()=>c.draftSeriesSpecs(draft,rescannedTable),/时间列已更新/);
  assert.deepEqual(draft,before);
});

test('spec filters are copied independently from draft and sibling series',()=>{
  const draft=wideDraft(),before=plain(draft),specs=c.draftSeriesSpecs(draft,wideTable);
  specs[0].filters[0].value='座椅';
  specs[0].filters.push({field:'分类',value:'五座'});
  assert.deepEqual(draft,before);
  assert.deepEqual(plain(specs[1].filters),[{field:'指标',value:'动力'}]);
});

let failures=0;
for(const {name,run} of tests){
  try{run();console.log(`PASS ${name}`);}
  catch(error){failures++;console.error(`FAIL ${name}\n${error.stack}`);}
}
console.log(`Chart state: ${tests.length-failures}/${tests.length} checks passed`);
if(failures)process.exitCode=1;
