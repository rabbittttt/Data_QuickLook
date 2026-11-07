// Regression fixtures for chart aggregation, draft rendering and independent axes.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=fs.readFileSync('web/app.js','utf8');
const numeric=source.slice(source.indexOf('const num='),source.indexOf('const fmt='));
const aggregation=source.slice(source.indexOf('function aggregateRows'),source.indexOf('async function home'));
const rendering=source.slice(source.indexOf('function drawComparison'),source.indexOf('function views'));
const elements=new Map();
const state={basket:[],charts:[],cache:new Map(),chartType:'auto',limit:'全部',baseline:false};
const tables=new Map();
let rendered,exported;
const context=vm.createContext({state,structuredClone,colors:['green','blue'],chartGrid:'#e5e7ed',tableById:id=>tables.get(id),
  $:id=>{if(!elements.has(id))elements.set(id,{style:{}});return elements.get(id);},
  grid:rows=>JSON.stringify(rows),exportCSV:(rows,columns)=>{exported={rows,columns};},chart:(_el,option)=>{rendered=option;}});
vm.runInContext(fs.readFileSync('web/chart-logic.js','utf8')+'\n'+numeric+aggregation+rendering+';this.aggregate=aggregateRows;this.draw=drawComparison;',context);

const totalData={columns:['门店','车型','销量','备注'],rows:[
  {门店:'上海',车型:'M8',销量:100,备注:'合计'},
  {门店:'上海',车型:'M9',销量:200,备注:'小计'},
  {门店:'上海',车型:'合计',销量:300,备注:''},
]};
const specification={dimension:'门店',metric:'销量',operation:'求和',excludeTotals:true};
assert.equal(context.aggregate(totalData,specification).get('上海'),300,'unselected model total is excluded but notes do not exclude details');
assert.equal(context.aggregate(totalData,{...specification,excludeTotals:false}).get('上海'),600);
tables.set('typed',{fields:[{name:'分组名称',type:'text'},{name:'门店',type:'text'},{name:'备注',type:'text'}]});
const typed={rows:[{门店:'上海',分组名称:'A',销量:1,备注:'合计'},{门店:'上海',分组名称:'合计',销量:1,备注:''}]};
assert.equal(context.aggregate(typed,{...specification,id:'typed'}).get('上海'),1,'catalog metadata provides dimensions when table API only has columns');
assert.equal(context.aggregate(totalData,{...specification,filters:[{field:'车型',value:'M9'},{field:'门店',value:'上海'}]}).get('上海'),200);
assert.equal(context.aggregate(totalData,{...specification,filterField:'门店',filterValue:'北京',filters:[{field:'车型',value:'M9'}]}).size,0,'legacy and new filters both apply');

assert.throws(()=>context.aggregate({rows:[{'2026-01(实际)':100,'2026-01(预测)':120}]},{wide:true,periods:['2026-01(实际)','2026-01(预测)'],operation:'求和'}),/时间|重复|口径|限定/);
assert.equal(context.aggregate({rows:[{'2026-01':100}]},{wide:true,periods:['2026-01'],operation:'求和'}).get('2026-01'),100,'saved single-period series remains readable');
const ratio={rows:[{门店:'A',成交:1,线索:2},{门店:'A',成交:9,线索:90},{门店:'B',成交:0,线索:0},{门店:'C',成交:null,线索:30}]};
const ratioSeries={dimension:'门店',operation:'总体比例',numerator:'成交',denominator:'线索'};
const ratios=context.aggregate(ratio,ratioSeries);
assert.equal(ratios.get('A'),10/92,'overall ratio is sum numerator / sum denominator, not average row rates');
assert.equal(ratios.get('B'),null);
assert.equal(ratios.get('C'),null);
assert.throws(()=>context.aggregate(ratio,{...ratioSeries,denominator:''}),/分子和分母/);

function put(id,rows,series){tables.set(id,{id});state.cache.set(id,{rows});return {id,label:id,operation:'求和',...series};}
const month=put('monthly',[{月份:'2026-01',销量:100},{月份:'2026-02',销量:null},{月份:'2026-03',销量:300}],{dimension:'月份',metric:'销量'});
const quarter=put('quarterly',[{季度:'2026Q1',销量:400},{季度:'2026Q2',销量:600}],{wide:true,periods:['2026Q1','2026Q2'],metric:'销量'});
state.cache.set('quarterly',{rows:[{'2026Q1':400,'2026Q2':600}]});
state.basket=[month,quarter];state.chartType='line';state.baseline=true;context.draw();
assert.equal(rendered.series.length,2);
assert.equal(rendered.series[0].type,'line');
assert.equal(rendered.series[1].type,'line','temporal facets preserve line representation');
assert.deepEqual(Array.from(rendered.xAxis[0].data),['2026-01','2026-02','2026-03']);
assert.deepEqual(Array.from(rendered.xAxis[1].data),['2026-Q1','2026-Q2']);
assert.deepEqual(Array.from(rendered.series[0].data),[100,null,300],'missing months remain null');
assert.equal(elements.get('#baseline').disabled,true);
assert.match(elements.get('#recommendNote').textContent,/强制独立分面/);
assert.doesNotMatch(elements.get('#compareGrid').innerHTML,/差值/);
state.axisSwapped=true;context.draw();
assert.deepEqual(Array.from(rendered.yAxis[1].data),['2026-Q1','2026-Q2']);
assert.deepEqual(Array.from(rendered.series[0].data[1]),[null,'2026-02']);

const cyclic=put('cyclic',[{'1月':9,'2月':10}],{wide:true,periods:['1月','2月'],metric:'销量'});
state.axisSwapped=false;state.basket=[month,cyclic];context.draw();
assert.equal(Array.isArray(rendered.xAxis),true,'absolute year months and yearless months cannot share one axis');
const mixed=put('mixed',[{月份:'2026-01',销量:10},{月份:'2026Q1',销量:30}],{dimension:'月份',metric:'销量'});
state.basket=[mixed];context.draw();
assert.equal(rendered.series.length,2,'a long-table series with internally mixed time grains is also split into independent facets');
assert.deepEqual(Array.from(rendered.xAxis[0].data),['2026-01']);
assert.deepEqual(Array.from(rendered.xAxis[1].data),['2026-Q1']);
state.basket=[month,cyclic];
state.chartPreview=[month];context.draw();
assert.equal(rendered.series.length,1);
assert.match(elements.get('#recommendNote').textContent,/草稿预览/);
assert.equal(state.basket.length,2,'draft rendering never persists or changes the applied basket');
state.chartPreview=[];context.draw();
assert.match(elements.get('#compareChart').innerHTML,/选择当前表格/,'an empty preview must not fall back to applied series');
state.chartPreview=null;state.basket=[{...month,wide:true,periods:['2026-01(实际)','2026-01(预测)']},cyclic];context.draw();
assert.match(elements.get('#recommendNote').textContent,/未绘制：第 1 组/);
assert.equal(rendered.series.length,1,'invalid saved settings do not crash the other valid charts');
// One source matrix supports literal header categories or dates without rotating Excel.
const wideSales={rows:[{地区:'华东','2026年3月':30,'2026年1月':10,'2026年2月':null}]};
const recordSales={rows:[{项目:'2026-03',销售:30},{项目:'2026-01',销售:10},{项目:'2026-02',销售:null},{项目:'',销售:999},{项目:null,销售:999}]};
const matrixSpec={wide:true,periods:['2026年3月','2026年1月','2026年2月'],operation:'求和'};
const recordSpec={dimension:'项目',metric:'销售',operation:'求和'};
assert.deepEqual(Array.from(context.aggregate(wideSales,matrixSpec)),Array.from(context.aggregate(recordSales,recordSpec)),'row-oriented and column-oriented dates produce equivalent aggregates');
assert.throws(()=>context.aggregate({rows:[{项目:'车型',销售:1}]},{...recordSpec,axisMode:'time'}),/时间横轴|无法识别/);
assert.equal(context.aggregate({rows:[{'2026-01(实际)':100,'2026-01(预测)':120}]},{wide:true,periods:['2026-01(实际)','2026-01(预测)'],operation:'求和',axisMode:'category'}).size,2,'explicit category mode retains qualified headers instead of merging their dates');
const ordinalData={rows:[{项目:'合计',华东:999,华西:999},{项目:'产品A',华东:10,华西:30},{项目:'产品A',华东:40,华西:60}]};
const ordinalSpec={wide:true,periods:['华东','华西'],vehicleField:'__row_index__',vehicleValue:'2',seriesFields:['项目'],excludeTotals:true,operation:'求和',axisMode:'category'};
assert.deepEqual(Array.from(context.aggregate(ordinalData,ordinalSpec),entry=>Array.from(entry)),[['华东',10],['华西',30]],'physical row identity is resolved before totals/filtering, including duplicate row labels');
assert.equal(context.aggregate(ordinalData,{...ordinalSpec,vehicleValue:'3',filters:[{field:'项目',value:'产品A'}]}).get('华东'),40);

const neutralDates=put('neutral',recordSales.rows,recordSpec);
state.chartPreview=null;state.axisSwapped=false;state.baseline=false;state.chartType='auto';state.basket=[neutralDates];context.draw();
assert.equal(rendered.series[0].type,'line','date values are recognized in a neutrally named row field');
assert.deepEqual(Array.from(rendered.xAxis.data),['2026-01','2026-02','2026-03']);
assert.deepEqual(Array.from(rendered.series[0].data),[10,null,30]);
state.basket=[{...neutralDates,axisOrder:'source'}];context.draw();
assert.deepEqual(Array.from(rendered.xAxis.data),['2026-03','2026-01','2026-02'],'explicit source order is independent of time recognition');
const categoryMatrix=put('categoryMatrix',[{项目:'产品A',华东:10,华西:30}],{...ordinalSpec,vehicleValue:'1',businessMetric:'销售'});
state.basket=[categoryMatrix];context.draw();
assert.equal(rendered.series[0].type,'bar','wide headers need not be time');
assert.deepEqual(Array.from(rendered.xAxis.data),['华东','华西'],'categories retain source field order by default, not implicit ranking');
state.basket=[{...categoryMatrix,axisOrder:'value'}];context.draw();
assert.deepEqual(Array.from(rendered.xAxis.data),['华西','华东'],'ranking is an explicit ordering choice');
const numericCategories=put('numericCategory',[{年份:'2026年3月',销售:1},{年份:'2026年1月',销售:2}],{dimension:'年份',metric:'销售',axisMode:'category'});
state.basket=[numericCategories];context.draw();
assert.equal(rendered.series[0].type,'bar');
assert.deepEqual(Array.from(rendered.xAxis.data),['2026年3月','2026年1月'],'explicit category mode prevents automatic normalization and sorting');
const categoryMixed=put('literalMixed',[{项目:'2026-01',销售:1},{项目:'2026Q1',销售:2},{项目:'其他',销售:3}],{dimension:'项目',metric:'销售',axisMode:'category'});
state.basket=[categoryMixed];context.draw();
assert.equal(Array.isArray(rendered.xAxis),false,'literal categories never force temporal facets');

// All selected series remain available; only independent facets are paged explicitly.
const many=Array.from({length:24},(_,i)=>put('many'+i,[{区域:'华东',销售:i+1}],{dimension:'区域',metric:'销售',businessMetric:'销售'}));
state.basket=many;state.chartType='auto';context.draw();
assert.equal(rendered.series.length,24,'shared-axis charts no longer have an eight-series cap');
assert.equal(elements.get('#facetControls').style.display,'none');
assert.match(elements.get('#recommendNote').textContent,/保留全部选择/);
elements.get('#exportCompare').onclick();
assert.equal(exported.columns.length,25,'CSV includes every selected series');
state.basket=many.slice(0,15).map((s,i)=>({...s,businessMetric:'指标'+i}));context.draw();
assert.equal(rendered.series.length,6,'independent facets use a bounded page rather than an unbounded canvas');
assert.match(elements.get('#facetControls').innerHTML,/1–6 \/ 15/);
assert.equal(elements.get('#compareChart').style.height,'1380px');
elements.get('#facetNext').onclick();
assert.equal(rendered.series.length,6);
assert.equal(rendered.series[0].name,'7. many6');
elements.get('#facetNext').onclick();
assert.equal(rendered.series.length,3);
assert.equal(rendered.series[2].name,'15. many14','the final selected facet remains reachable');
elements.get('#exportCompare').onclick();
assert.equal(exported.columns.length,16,'pagination never truncates numeric exports');
assert.match(elements.get('#compareGrid').innerHTML,/15\. many14/,'numeric data includes series outside the current facet page');
const fullTimeline=put('fullTimeline',Array.from({length:50},(_,i)=>({日序:'D'+(i+1),销量:i})),{dimension:'日序',metric:'销量',businessMetric:'销量'});
state.basket=[fullTimeline];state.limit='全部';context.draw();
assert.equal(rendered.xAxis.data.length,50,'all selected periods are drawn when displaying the complete range');
assert.equal(rendered.dataZoom[0].start,0);
assert.equal(rendered.dataZoom[0].end,100,'zoom starts with the full range, not an implicit truncation');
state.axisSwapped=true;context.draw();
assert.equal(rendered.dataZoom[0].yAxisIndex,0,'zoom follows the category axis after X/Y swap');
assert.equal(rendered.yAxis.data.length,50);
console.log('Chart safety: totals, filters, ratios, axis mappings, unlimited series, facet pagination, draft state and nulls passed');
