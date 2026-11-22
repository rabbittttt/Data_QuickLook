// Exercise the actual browser aggregation implementation without a DOM.
const fs=require('node:fs');
const vm=require('node:vm');
const assert=require('node:assert/strict');
const source=fs.readFileSync('web/app.js','utf8');
const numeric=source.slice(source.indexOf('const num='),source.indexOf('const fmt='));
const aggregation=source.slice(source.indexOf('function aggregateRows'),source.indexOf('async function home'));
const context=vm.createContext({});
vm.runInContext(fs.readFileSync('web/chart-logic.js','utf8')+'\n'+numeric+aggregation+';this.aggregate=aggregateRows;this.number=num;',context);
assert.equal(context.number('40%'),.4);
assert.equal(context.number('1,200'),1200);
assert.equal(context.number(''),null);
assert.equal(context.number('错误'),null);
const escapeText=source.slice(source.indexOf('const esc='),source.indexOf('const num='));
const emptyTemplate=source.slice(source.indexOf('function empty('),source.indexOf('function grid('));
const csvCell=source.slice(source.indexOf('function csvCell('),source.indexOf('function exportCSV('));
vm.runInContext(escapeText+emptyTemplate+csvCell,context);
assert.equal(context.empty('A < B','A & B','<button>重试</button>'),
  '<div class="panel empty"><h2>A &lt; B</h2><p>A &amp; B</p><button>重试</button></div>');
for(const value of ['-说明','  +标记','\t等候',' \r\n@标签','\uFEFF＝备注']){
  assert.equal(context.csvCell(value),'"\t'+value+'"');
}
for(const value of [-12.5,'-1,200.50','-12%','+1.2e-3','%收入','|类别']){
  assert.equal(context.csvCell(value),'"'+value+'"');
}
assert.equal(context.csvCell('门店"甲",北京'),'"门店""甲"",北京"');
const data={rows:[{model:'M8',sales:100},{model:'M8',sales:200},{model:'M9',sales:null},{model:'合计',sales:300}]};
const specification={dimension:'model',metric:'sales',operation:'求和',excludeTotals:true};
let result=context.aggregate(data,specification);
assert.equal(result.get('M8'),300);
assert.equal(result.get('M9'),null);
assert.equal(result.has('合计'),false);
result=context.aggregate(data,{...specification,filterField:'model',filterValue:'M8'});
assert.equal(result.size,1);
result=context.aggregate({rows:[{model:'M8','1月':100,'2月':200}]},{...specification,wide:true,periods:['1月','2月']});
assert.equal(result.get('2月'),200);
result=context.aggregate(data,{...specification,metric:'model',operation:'非空计数'});
assert.equal(result.get('M8'),2);
result=context.aggregate(data,{...specification,vehicleField:'model',vehicleValue:'M8'});
assert.equal(result.get('M8'),300);
assert.equal(result.has('M9'),false);
result=context.aggregate(data,{...specification,vehicleField:'model',vehicleValue:'M8',filterField:'sales',filterValue:'100'});
assert.equal(result.get('M8'),100);
result=context.aggregate({rows:[{月份:'2026年1月',sales:100},{月份:'2026/1',sales:200}]},{...specification,dimension:'月份'});
assert.equal(result.get('2026-01'),300);
result=context.aggregate({rows:[{model:'M8',note:'合计',sales:100}]},{...specification});
assert.equal(result.get('M8'),100);
result=context.aggregate({rows:[{model:'M8',sales:100},{model:'M8',sales:80}]},{...specification,operation:'最新值'});
assert.equal(result.get('M8'),80);
console.log('Frontend aggregation and time alignment: checks passed');
const hierarchy={rows:[{指标:'动力',统计类型:'占比',分类:'增程','26-03':.4,'26-04':.5},{指标:'动力',统计类型:'占比',分类:'纯电','26-03':.6,'26-04':.5}]};
const hs={wide:true,periods:['26-03','26-04'],vehicleField:'__row_labels__',seriesFields:['指标','统计类型','分类'],vehicleValue:JSON.stringify(['动力','占比','纯电']),operation:'平均值',excludeTotals:true};
const hr=context.aggregate(hierarchy,hs);
assert.equal(hr.get('2026-03'),.6);
assert.equal(hr.get('2026-04'),.5);
assert.equal(hr.size,2);
assert.equal(context.wideBusinessMetric({table_name:'选配'},hs.vehicleField,hs.vehicleValue,hs.seriesFields),'动力 · 占比');
assert.equal(context.percentageSeries({...hs,businessMetric:'动力 · 占比'}),true);
