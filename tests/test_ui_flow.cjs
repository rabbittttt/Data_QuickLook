'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync('web/app.js','utf8'),studio=fs.readFileSync('web/studio.js','utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const tests=[];const test=(name,run)=>tests.push({name,run});
const snippet=(start,end)=>app.slice(app.indexOf(start),app.indexOf(end));
function nodes(){
  const map=new Map();
  return selector=>{if(!map.has(selector))map.set(selector,{textContent:'',innerHTML:'',disabled:false,open:false,focusCount:0,attributes:{},querySelectorAll:()=>[],setAttribute(name,value){this.attributes[name]=value;},removeAttribute(name){delete this.attributes[name];},focus(){this.focusCount++;}});return map.get(selector);};
}
function catalogContext(){
  const $=nodes(),calls=[];
  const initial={tables:[{id:'A',scanned_at:'v1',archived:false}],status:{busy:false,errors:[],last_sync:'2026-09-22 12:00'},config:{folder:'current'}};
  let current=initial;
  const c=vm.createContext({structuredClone,console,$,state:{tables:[],cache:new Map(),page:'compare',basket:[]},draft:{previewActive:false},lastStamp:'',configuredSourceFolders:config=>config?.folders||[config?.folder].filter(Boolean),activeTables:()=>c.state.tables.filter(t=>!t.archived),api:async()=>current,renderCatalogUpdateNotice:()=>calls.push('notice'),toast:message=>calls.push(message),go:async(page,options)=>calls.push({page,options})});
  vm.runInContext(snippet('function catalogStamp(', 'function go('),c);
  return {c,$,calls,initial,setResult:result=>current=result,next:version=>({...initial,tables:[{id:'A',scanned_at:version,archived:false}]})};
}

test('idle catalog checks run every ten minutes with an initial load',async()=>{
  const $=nodes(),intervals=[];let ready,refreshes=0;
  const c=vm.createContext({$,state:{basket:[],page:'home'},location:{hash:''},localStorage:{getItem:()=>null},window:{addEventListener:(_event,callback)=>{ready=callback;}},refreshCatalog:async()=>{refreshes++;return true;},persistBasket:()=>{},go:()=>{},pollBusy:false,setInterval:(callback,delay)=>intervals.push({callback,delay}),empty:()=>''});
  vm.runInContext(app.match(/^const AUTO_REFRESH_INTERVAL=.*$/m)[0]+'\n'+app.slice(app.indexOf("window.addEventListener('DOMContentLoaded',")),c);
  await ready();assert.equal(refreshes,1);assert.equal(intervals.length,1);assert.equal(intervals[0].delay,600000);
  await intervals[0].callback();assert.equal(refreshes,2);assert.equal(c.pollBusy,false);
});

test('requested sync checks completion promptly and stops once it finishes',async()=>{
  const $=nodes(),timers=new Map(),routes=[];let nextTimer=0,checks=0;
  const c=vm.createContext({$,state:{page:'explore',status:{busy:false}},syncProgressTimer:null,setTimeout:(callback,delay)=>{timers.set(++nextTimer,{callback,delay});return nextTimer;},clearTimeout:id=>timers.delete(id),refreshCatalog:async()=>{checks++;c.state.status.busy=checks===1;$('#syncButton').disabled=c.state.status.busy;return checks===2;},go:async(page,options)=>routes.push({page,options}),toast:()=>{}});
  vm.runInContext(snippet('function trackRequestedSync(', 'function go('),c);
  c.trackRequestedSync();assert.equal($('#syncButton').disabled,true);assert.match($('#syncStatus').textContent,/正在同步/);assert.equal(timers.get(1).delay,1000);
  const first=timers.get(1);timers.delete(1);await first.callback();assert.equal(timers.get(2).delay,5000);
  const second=timers.get(2);timers.delete(2);await second.callback();
  assert.equal(checks,2);assert.equal(timers.size,0);assert.equal(c.syncProgressTimer,null);assert.equal($('#syncButton').disabled,false);
  assert.deepEqual(plain(routes),[{page:'explore',options:{background:true}}]);
});

test('sync status errors stop completion checks and allow retry',async()=>{
  const $=nodes(),messages=[];
  const c=vm.createContext({$,state:{page:'explore'},syncProgressTimer:1,refreshCatalog:async()=>{throw Error('connection lost');},setTimeout:()=>{throw Error('must not keep polling after failure');},toast:message=>messages.push(message)});
  $('#syncButton').disabled=true;vm.runInContext(snippet('function trackRequestedSync(', 'function go('),c);
  await c.refreshSyncProgress();assert.equal(c.syncProgressTimer,null);assert.equal($('#syncButton').disabled,false);assert.match($('#syncStatus').textContent,/请重试/);assert.deepEqual(messages,['connection lost']);
});

test('catalog changes during a modal keep live data until explicit acceptance',async()=>{
  const {c,$,calls,setResult,next}=catalogContext();
  assert.equal(await c.refreshCatalog(),true);c.state.cache.set('A',{rows:[{销量:10}]});const stamp=c.lastStamp;
  $('#dialog').open=true;setResult(next('v2'));
  assert.equal(await c.refreshCatalog(),false);assert.equal(c.state.catalogPending,true);
  assert.equal(c.state.cache.get('A').rows[0].销量,10);assert.equal(c.state.tables[0].scanned_at,'v1');assert.equal(c.lastStamp,stamp);
  assert.equal(await c.applyPendingCatalog(),false,'cannot reload under a modal');
  $('#dialog').open=false;
  assert.equal(await c.refreshCatalog(),false,'closing modal does not silently consume pending changes');
  assert.equal(await c.applyPendingCatalog(),true);assert.equal(c.state.tables[0].scanned_at,'v2');assert.equal(c.state.cache.size,0);assert.equal(c.state.catalogPending,false);
  assert.deepEqual(plain(calls.find(item=>item&&item.page)),{page:'compare',options:{background:true}});
});

test('source changes and archive changes refresh metadata without file edits',async()=>{
  const {c,initial,setResult}=catalogContext();
  await c.refreshCatalog();c.state.cache.set('A',{rows:[{销量:10}]});
  setResult({...initial,config:{folder:'orders',folders:['orders','plans']}});
  assert.equal(await c.refreshCatalog(),true,'changing roots refreshes source labels even when workbook bytes did not change');
  assert.equal(c.state.cache.size,0);
  setResult({...initial,config:{folder:'orders',folders:['orders','plans']},tables:[{...initial.tables[0],archived:true}]});
  assert.equal(await c.refreshCatalog(),true,'removed/moved sources refresh their history state');
  assert.equal(c.state.tables[0].archived,true);
});
test('active chart draft defers changes and keeps the most recent pending version',async()=>{
  const {c,setResult,next}=catalogContext();await c.refreshCatalog();c.state.cache.set('A',{rows:[{销量:10}]});
  c.draft={id:'A',previewActive:true,selectedValues:['M9'],filters:[{field:'区域',value:'华东'}]};const before=plain(c.draft);
  setResult(next('v2'));assert.equal(await c.refreshCatalog(),false);
  setResult(next('v3'));assert.equal(await c.refreshCatalog(),false);assert.equal(c.state.pendingCatalog.tables[0].scanned_at,'v3');
  assert.equal(c.state.tables[0].scanned_at,'v1');assert.deepEqual(c.draft,before);
  await c.applyPendingCatalog();assert.equal(c.state.tables[0].scanned_at,'v3');assert.deepEqual(c.draft,before,'refresh preserves fields for visible stale-selection validation');
});
test('unchanged polling never clears cached rows and explicit correction can force install',async()=>{
  const {c,setResult,next}=catalogContext();await c.refreshCatalog();c.state.cache.set('A',{rows:[]});
  assert.equal(await c.refreshCatalog(),false);assert.equal(c.state.cache.size,1);
  c.draft.previewActive=true;setResult(next('v2'));
  assert.equal(await c.refreshCatalog({force:true}),true);assert.equal(c.state.catalogPending,false);assert.equal(c.state.tables[0].scanned_at,'v2');
});
test('an inactive chart draft cannot block original-sheet refresh',async()=>{
  const {c,setResult,next}=catalogContext();await c.refreshCatalog();
  c.draft={id:'A',previewActive:true,selectedValues:['M9'],filters:[{field:'区域',value:'华东'}]};
  const before=plain(c.draft);c.state.page='explore';
  setResult(next('v2'));assert.equal(await c.refreshCatalog(),true);
  assert.equal(c.state.tables[0].scanned_at,'v2');assert.equal(c.state.catalogPending,false);
  assert.deepEqual(c.draft,before,'background refresh does not discard the inactive draft');
});
test('leaving the protected page consumes current data without a sticky pending notice',async()=>{
  const {c,setResult,next}=catalogContext();await c.refreshCatalog();
  c.draft={id:'A',previewActive:true,selectedValues:['M9']};const before=plain(c.draft);
  setResult(next('v2'));assert.equal(await c.refreshCatalog(),false);
  assert.equal(c.state.pendingCatalogPage,'compare');
  c.state.page='explore';assert.equal(await c.refreshCatalog(),true);
  assert.equal(c.state.tables[0].scanned_at,'v2');assert.equal(c.state.pendingCatalog,null);
  assert.equal(c.state.pendingCatalogPage,null);assert.deepEqual(c.draft,before);
});
test('raw file changes refresh original data before import, then imported changes invalidate rows',async()=>{
  const {c,setResult,initial}=catalogContext();
  c.state.page='explore';
  const version={...initial,files:[{id:'source',signature:'v1'}]};setResult(version);await c.refreshCatalog();
  c.state.cache.set('A',{rows:[{value:'old'}]});
  setResult({...version,files:[{id:'source',signature:'v2'}]});
  assert.equal(await c.refreshCatalog(),true);assert.equal(c.state.cache.size,0);
  c.state.cache.set('A',{rows:[{value:'previous import'}]});
  setResult({...version,files:[{id:'source',signature:'v2'}],tables:[{id:'A',scanned_at:'v2',archived:false}]});
  assert.equal(await c.refreshCatalog(),true);assert.equal(c.state.cache.size,0);
});
test('late responses from an old catalog cannot poison the new cache',async()=>{
  let resolveOld,count=0;
  const c=vm.createContext({state:{cache:new Map(),catalogVersion:1},api:async()=>++count===1?new Promise(resolve=>resolveOld=resolve):{rows:[{value:'new'}]}});
  vm.runInContext(snippet('async function tableData(', 'function tableById('),c);
  const response=c.tableData('A');c.state.catalogVersion=2;resolveOld({rows:[{value:'old'}]});
  assert.equal((await response).rows[0].value,'new');assert.equal(c.state.cache.get('A').rows[0].value,'new');assert.equal(count,2);
});
test('saved analysis resets its source, parameters and inactive preview through the shared helper',()=>{
  const $=nodes(),open={dataset:{openview:'0'}},loaded=[],saved=[{name:'B',type:'line',limit:'全部',basket:[{id:'B',uid:'B1',metric:'销量',dimension:'日期',label:'B'}]}];
  const c=vm.createContext({structuredClone,$,state:{basket:[{id:'A'}],chartPreview:[{id:'A'}],chartUndo:[{id:'unrelated'}]},draft:{id:'A',sourceId:'A',previewActive:true,editUid:'A1'},views:()=>saved,header:()=>'',empty:()=>'',esc:String,normalizeSeriesIds:basket=>basket,document:{querySelectorAll:selector=>selector==='[data-openview]'?[open]:[]},persistBasket:()=>{},go:()=>{}});
  vm.runInContext(studio.slice(studio.indexOf('function resetChartDraft('),studio.indexOf('function renderCatalogUpdateNotice(')),c);
  const load=c.loadChartDraftFromSeries;c.loadChartDraftFromSeries=first=>{loaded.push(first);load(first);};
  vm.runInContext(snippet('function saved(){','async function search('),c);c.saved();open.onclick();
  assert.equal(loaded.length,1);assert.equal(c.state.basket[0].id,'B');assert.equal(c.draft.id,'B');assert.equal(c.draft.sourceId,'B');assert.equal(c.state.chartPreview,null);assert.equal(c.draft.previewActive,false);assert.equal(c.draft.editUid,undefined);
  assert.equal(c.state.chartUndo,null,'the previous analysis undo history must not leak into this saved analysis');
  assert.equal(c.state.builderOpen,false,'opening saved analysis should put its chart first');
  assert.equal(c.state.seriesManagerOpen,false,'long series labels should not push a saved chart below the fold');
  c.state.basket[0].label='changed';assert.equal(saved[0].basket[0].label,'B','loading cannot mutate the saved view');
});
test('preview and commit have identical append/replace/update content without allocating preview IDs',()=>{
  const c=vm.createContext({});vm.runInContext(fs.readFileSync('web/chart-logic.js','utf8')+'\n'+fs.readFileSync('web/chart-state.js','utf8'),c);
  const basket=[{id:'A',uid:'one',label:'A',filters:[{field:'区域',value:'华东'}]},{id:'B',uid:'two',label:'B'}],incoming=[{id:'C',label:'C',filters:[{field:'车型',value:'M9'}]},{id:'D',label:'D'}],before=plain({basket,incoming});
  const strip=items=>plain(items).map(({uid,...rest})=>rest);
  for(const mode of ['replace','append','update']){
    const preview=c.previewChartSeries(basket,incoming,mode,'two'),commit=c.commitChartSeries(basket,incoming,mode,'two');
    assert.deepEqual(strip(preview),strip(commit),mode);if(mode==='update')assert.equal(preview[1].uid,'two');
  }
  vm.runInContext("chartUid=()=>{throw Error('preview must not allocate IDs')}",c);
  const preview=c.previewChartSeries(basket,incoming,'append');preview[0].filters[0].value='changed';preview[2].filters[0].value='changed';
  assert.deepEqual({basket,incoming},before);
  assert.throws(()=>c.previewChartSeries(basket,incoming,'update','deleted'),/已被移除/);
});
test('a deleted filter field remains an error instead of silently broadening the chart',()=>{
  const c=vm.createContext({});vm.runInContext(fs.readFileSync('web/chart-logic.js','utf8')+'\n'+fs.readFileSync('web/chart-state.js','utf8'),c);
  const draft={wide:false,dimension:'日期',metrics:['销量'],operation:'求和',filters:[{field:'区域',value:'华东'}]},before=plain(draft);
  assert.throws(()=>c.draftSeriesSpecs(draft,{id:'A',fields:[{name:'日期',type:'text'},{name:'销量',type:'number'}]}),/筛选字段.*已不存在/);
  assert.deepEqual(draft,before);
});
test('table-only mode reveals the numeric panel and does not collapse it on other types',()=>{
  const $=nodes(),c=vm.createContext({$,state:{chartType:'table'}});
  vm.runInContext(snippet('function syncComparisonTableVisibility(', 'async function render('),c);
  c.syncComparisonTableVisibility();assert.equal($('.numeric-details').open,true);
  c.state.chartType='line';c.syncComparisonTableVisibility();assert.equal($('.numeric-details').open,true);
});
test('navigation exposes active page and focuses changed routes, never background refresh',async()=>{
  const $=nodes(),buttons=['home','compare'].map(page=>({dataset:{page},classList:{toggle(){}},attributes:{},setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];}}));
  $('#nav').querySelectorAll=()=>buttons;
  const c=vm.createContext({$,state:{page:'home'},location:{},renderToken:0,render:async()=>{c.renderToken++;},toast:()=>{},esc:String,empty:()=>''});
  vm.runInContext(snippet('function go(', 'function syncComparisonTableVisibility('),c);
  await c.go('compare');assert.equal(buttons[1].attributes['aria-current'],'page');assert.equal(buttons[0].attributes['aria-current'],undefined);assert.equal($('#main').focusCount,1);
  await c.go('compare',{background:true});assert.equal($('#main').focusCount,1);
  await c.go('home',{background:true});assert.equal($('#main').focusCount,1);
});
test('live search and clearing the query keep focus in the search input',async()=>{
  const $=nodes();let scheduled;
  const c=vm.createContext({$,state:{page:'home',query:''},location:{},renderToken:0,searchTimer:null,render:async()=>{c.renderToken++;},clearTimeout:()=>{},setTimeout:callback=>{scheduled=callback;return 1;},toast:()=>{},esc:String,empty:()=>''});
  vm.runInContext(snippet('function go(', 'function syncComparisonTableVisibility('),c);
  const start=app.indexOf("$('#search').oninput=");
  vm.runInContext(app.slice(start,app.indexOf(';document.addEventListener',start))+';',c);
  for(const [query,page] of [['SKU','search'],['','home']]){
    $('#search').oninput({target:{value:query}});scheduled();await Promise.resolve();await Promise.resolve();
    assert.equal(c.state.page,page);assert.equal($('#main').focusCount,0,'search updates must not invoke route focus');
  }
});
test('truncated search results disclose the shown count and a way to narrow results',async()=>{
  const $=nodes(),headings=[];let count=77;
  const c=vm.createContext({$,state:{query:'SKU'},renderToken:1,header:(_eyebrow,_title,subtitle)=>{headings.push(subtitle);return subtitle;},api:async()=>({hits:Array.from({length:count},(_,id)=>({table:{id,table_name:'SKU',relative_path:'source.xlsx',sheet_name:'Sheet1',range_ref:'A1:B3',fields:[]},rows:[]}))}),esc:String,fmt:String,empty:()=>'',bindTableActions:()=>{}});
  vm.runInContext(snippet('async function search(', 'function sourceDialog('),c);
  await c.search(1);assert.match(headings.at(-1),/77.*当前显示前 60.*缩小关键词/);assert.equal(($('#main').innerHTML.match(/<article /g)||[]).length,60);
  count=2;await c.search(1);assert.doesNotMatch(headings.at(-1),/前 60/);assert.equal(($('#main').innerHTML.match(/<article /g)||[]).length,2);
});
test('visible page heading retains one route name without introductory copy',()=>{
  const c=vm.createContext({esc:String});vm.runInContext(snippet('function header(', 'function options('),c);
  const rendered=c.header('CHART STUDIO / 图表展示','','选表、选参数');
  assert.match(rendered,/<h1>图表展示<\/h1>/);
  assert.doesNotMatch(rendered,/CHART STUDIO|选表、选参数/);
  assert.match(c.header('OVERVIEW / 工作台','从分散的表格，到清晰的比较'),/<h1>工作台<\/h1>/);
});
test('missing selected options remain visible instead of appearing to choose the first valid field',()=>{
  const c=vm.createContext({esc:String});vm.runInContext(snippet('function options(', 'function empty('),c);
  assert.match(c.options(['日期','车型'],'旧字段'),/<option value="旧字段" selected>\[已失效\] 旧字段<\/option>/);
  assert.doesNotMatch(c.options(['求和','平均值'],''),/已失效/);
  assert.match(c.options(['日期','车型'],'车型'),/<option value="车型" selected>车型<\/option>/);
});

(async()=>{let failures=0;for(const {name,run} of tests){try{await run();console.log(`PASS ${name}`);}catch(error){failures++;console.error(`FAIL ${name}\n${error.stack}`);}}console.log(`UI flow: ${tests.length-failures}/${tests.length} checks passed`);if(failures)process.exitCode=1;})();
