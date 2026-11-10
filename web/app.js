'use strict';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=v=>{if(v===null||v===undefined||v==='')return null;const s=String(v).trim().replace(/[,，]/g,'');if(!s)return null;const n=Number(s.replace(/%$/,''));return Number.isFinite(n)?n/(s.endsWith('%')?100:1):null;};
const fmt=n=>n===null||n===undefined?'—':typeof n==='number'?n.toLocaleString('zh-CN',{maximumFractionDigits:3}):String(n);
const colors=['#2859f5','#25804a','#b6661d','#7656c3','#197c92','#bb4770'];
const chartGrid='#e5e7ed';
const state={tables:[],page:'home',file:'',query:'',basket:[],cache:new Map(),charts:[],chartType:'auto',axisSwapped:false,limit:'全部',baseline:false};
const AUTO_REFRESH_INTERVAL=10*60*1000;
let renderToken=0, searchTimer, syncProgressTimer, pollBusy=false, lastStamp='';
function toast(message){$('#toast').textContent=message;$('#toast').style.display='block';if(typeof uiFeedback==='function')uiFeedback($('#toast'),'toast');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').style.display='none',4200);}
function apiUrl(path){
  const base=$('meta[name="quicklook-base"]')?.content || '';
  return base+'api/'+path;
}
async function api(path,body){const response=await fetch(apiUrl(path),body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error||'请求失败');return data;}
async function tableData(id){
  if(state.cache.has(id))return state.cache.get(id);
  const version=state.catalogVersion||0,data=await api('table?id='+encodeURIComponent(id));
  if(version!==(state.catalogVersion||0))return tableData(id);
  state.cache.set(id,data);return data;
}
function tableById(id){return state.tables.find(t=>t.id===id);}
function activeTables(){return state.tables.filter(t=>!t.archived);}
function configuredSourceFolders(config){return [...new Set((config?.folders?.length?config.folders:[config?.folder]).filter(Boolean))];}
function dispose(){state.charts.forEach(c=>c.dispose());state.charts=[];}
function chart(element,option){if(!element)return;const instance=echarts.init(element);instance.setOption({color:colors,textStyle:{color:'#606775',fontFamily:'Segoe UI, Microsoft YaHei'},animation:false,...option,tooltip:{borderColor:chartGrid,textStyle:{color:'#0b0d17'},...option.tooltip}});state.charts.push(instance);return instance;}
window.addEventListener('resize',()=>state.charts.forEach(c=>c.resize()));
if(typeof MutationObserver==='function')new MutationObserver(()=>{if($('#dialog').open&&typeof uiFeedback==='function')uiFeedback($('#dialog'),'dialog');}).observe($('#dialog'),{attributes:true,attributeFilter:['open']});
$('.brand').onclick=e=>{e.preventDefault();go('home');};
function header(eyebrow){return `<div class="pagehead"><h1>${esc(eyebrow.split(' / ').at(-1))}</h1></div>`;}
function options(values,selected){
  if(values.includes('有效数值计数')&&!values.includes('非空计数'))values=[...values,'非空计数'];
  const stale=selected!=null&&selected!==''&&!values.includes(selected)?`<option value="${esc(selected)}" selected>[已失效] ${esc(selected)}</option>`:'';
  return stale+values.map(v=>`<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(v)}</option>`).join('');
}
function empty(title,subtitle,button=''){return `<div class="panel empty"><h2>${title}</h2><p>${subtitle}</p>${button}</div>`;}
function grid(rows,columns){return `<div class="tablewrap"><table><thead><tr>${columns.map(c=>`<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(c=>`<td class="${typeof row[c]==='number'?'num':''}" title="${esc(fmt(row[c]))}">${esc(fmt(row[c]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;}
function exportCSV(rows,columns,name){const cell=value=>'"'+String(value??'').replace(/"/g,'""').replace(/^([=+@])/,'\t$1')+'"';const text='\ufeff'+[columns,...rows.map(r=>columns.map(c=>r[c]))].map(r=>r.map(cell).join(',')).join('\r\n');const url=URL.createObjectURL(new Blob([text],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function persistBasket(){try{localStorage.setItem('shujian-basket',JSON.stringify(state.basket));}catch{}$('#basketCount').textContent=state.basket.length;}
function catalogStamp(result){return JSON.stringify([result.tables.map(t=>[t.id,t.scanned_at,t.archived]),(result.files||[]).map(f=>[f.id,f.signature]),result.config?.folders||[result.config?.folder].filter(Boolean)]);}
function catalogStatus(result){
  state.status=result.status;
  $('#tableCount').textContent=activeTables().length;
  $('#syncStatus').textContent=state.catalogPending?'新数据待加载':result.status.busy?'正在同步…':result.status.errors.length?`${result.status.errors.length} 个文件需检查`:'已同步 · '+(result.status.last_sync?.slice(11)||'本地数据');
  $('#syncButton').disabled=result.status.busy;
  if(typeof renderCatalogUpdateNotice==='function')renderCatalogUpdateNotice();
}
function installCatalog(result){
  const stamp=catalogStamp(result),changed=stamp!==lastStamp;
  state.tables=result.tables;state.files=result.files||[];state.config=result.config;
  if(changed){state.cache.clear();state.catalogVersion=(state.catalogVersion||0)+1;}
  lastStamp=stamp;state.pendingCatalog=null;state.pendingCatalogPage=null;state.catalogPending=false;catalogStatus(result);
  return changed;
}
async function refreshCatalog({force=false}={}){
  const result=await api('catalog'),changed=catalogStamp(result)!==lastStamp;
  const protectedInput=!!$('#dialog')?.open||(state.page==='compare'&&typeof draft!=='undefined'&&!!draft.previewActive);
  const pendingOnPage=state.catalogPending&&state.pendingCatalogPage===state.page;
  if(changed&&lastStamp&&!force&&(pendingOnPage||protectedInput)){
    state.pendingCatalog=result;state.pendingCatalogPage=state.page;state.catalogPending=true;catalogStatus(result);return false;
  }
  if(!changed&&state.catalogPending){state.pendingCatalog=null;state.pendingCatalogPage=null;state.catalogPending=false;}
  return installCatalog(result);
}
function applyPendingCatalog(){
  if(!state.pendingCatalog)return Promise.resolve(false);
  if($('#dialog')?.open){toast('请先关闭当前弹窗，再加载新数据。');return Promise.resolve(false);}
  installCatalog(state.pendingCatalog);
  return go(state.page,{background:true}).then(()=>true);
}
function trackRequestedSync(){
  clearTimeout(syncProgressTimer);
  $('#syncButton').disabled=true;$('#syncStatus').textContent='正在同步…';
  syncProgressTimer=setTimeout(refreshSyncProgress,1000);
}
async function refreshSyncProgress(){
  syncProgressTimer=null;
  try{
    const changed=await refreshCatalog();
    if(changed)await go(state.page,{background:true});
    // Only a user-requested sync needs short-lived completion checks.
    if(state.status?.busy)syncProgressTimer=setTimeout(refreshSyncProgress,5000);
  }catch(e){
    $('#syncButton').disabled=false;
    $('#syncStatus').textContent='同步状态获取失败，请重试';toast(e.message);
  }
}
function go(page,{background=false}={}){
  if(page==='raw'||page==='health')page='explore';
  const moved=state.page!==page;state.page=page;location.hash=page;
  $('#nav').querySelectorAll('button').forEach(b=>{const active=b.dataset.page===page;b.classList.toggle('active',active);if(active)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  const rendering=render(),token=renderToken;
  return rendering.then(()=>{if(!background&&moved&&token===renderToken&&!$('#dialog')?.open){const main=$('#main');main.setAttribute('tabindex','-1');main.focus({preventScroll:true});}}).catch(e=>{if(token!==renderToken)return;console.error('页面加载失败',e);toast(e.message);$('#main').innerHTML=empty('页面暂时无法加载',esc(e.message),'<button onclick="location.reload()">重新加载</button>');});
}
function syncComparisonTableVisibility(){if(state.chartType==='table'){const details=$('.numeric-details');if(details)details.open=true;}}
async function render(){const token=++renderToken;dispose();const main=$('#main');if(state.page==='home')await home(token);else if(state.page==='explore')await dataPage(token);else if(state.page==='compare')await chartStudio(token);else if(state.page==='saved')saved();else if(state.page==='search')await search(token);else await home(token);if(token===renderToken){syncComparisonTableVisibility();if(typeof renderCatalogUpdateNotice==='function')renderCatalogUpdateNotice();}}
function metricScore(name){return (/销量|订单数|小订数|大定量|净大定|锁单|交付|销售额|金额|收入|当日退订/.test(name)?10:0)+(/率|占比|比例/.test(name)?3:0)-(/累计/.test(name)?2:0);}
function metricFields(t){return t.fields.filter(f=>f.type==='number'&&!/日期|时间|天数|年份|编码|序号|排名|小时/.test(f.name)).sort((a,b)=>metricScore(b.name)-metricScore(a.name));}
function chooseDimension(t){return t.fields.find(f=>/^(车型|版本|区域|门店|配置|地理区域)$/.test(f.name))?.name||t.fields.find(f=>/月份|日期|年月/.test(f.name)&&f.type!=='number')?.name||t.fields.find(f=>f.type==='text')?.name||t.fields[0]?.name;}
function recommend(){const candidates=activeTables().filter(t=>metricFields(t).length&&t.row_count>4&&t.fields.some(f=>f.type==='text'||f.type==='date'));const score=t=>metricScore(metricFields(t)[0].name)*3+(/^(车型|版本|区域|门店)$/.test(chooseDimension(t))?12:0)+(t.row_count>10?2:0)-(/说明|图表|预测/.test(t.sheet_name)?8:0)-t.issues.length*5;const seen=new Set();return candidates.sort((a,b)=>score(b)-score(a)).filter(t=>{const signature=t.file_path+'|'+t.table_name;if(seen.has(signature))return false;seen.add(signature);return true;}).slice(0,6);}
function aggregateRows(data,series){
  if(series.wide){
    if(!series.periods?.length)throw Error('请至少选择一个作为横轴的数值列');
    if(series.axisMode!=='category'){const error=periodSelectionError(series.periods,{minPeriods:1});if(error)throw Error(error);}
  }
  if(series.operation==='总体比例'&&(series.wide||!series.numerator||!series.denominator))throw Error('总体比例需要选择明细表中的分子和分母字段');
  const metadata=(typeof tableById==='function'?tableById(series.id)?.fields:null)||data.fields||[];
  const names=data.columns||Object.keys(data.rows[0]||{});
  const descriptive=name=>/备注|说明|注释|描述|note|remark|comment|description/i.test(name);
  const businessDimension=name=>/车型|车系|版本|区域|门店|配置|分类|类别|指标|项目|统计类型|渠道|部门|产品|省份|城市|品牌|model|store|region|category|version|channel|product|brand/i.test(name);
  const typedDimensions=metadata.filter(f=>typeof f==='object'&&f.type==='text'&&f.name!==series.metric).map(f=>f.name);
  const totalFields=[...new Set([series.dimension,series.vehicleField,series.filterField,...(series.seriesFields||[]),...(series.filters||[]).map(f=>f.field),...typedDimensions,...names.filter(businessDimension)].filter(f=>f&&!descriptive(f)&&!['__row_labels__','__row_index__'].includes(f)))];
  const matches=(row,field,value)=>!field||value===undefined||value===null||value===''||String(row[field]??'')===String(value);
  const rows=data.rows.filter((r,index)=>(!series.vehicleField||series.vehicleValue===undefined||series.vehicleValue===null||series.vehicleValue===''||seriesRowValue(r,series,index)===String(series.vehicleValue))&&matches(r,series.filterField,series.filterValue)&&(series.filters||[]).every(f=>matches(r,f.field,f.value))&&(!series.excludeTotals||!totalFields.some(field=>isTotalLabel(r[field]))));
  const groups=new Map();
  const push=(key,value)=>{
    if(key===null||key===undefined||key==='')return;
    key=chartAxisKey(key,series);if(key===null||key===undefined||key==='')return;
    if(!groups.has(key))groups.set(key,[]);
    const n=series.operation==='非空计数'?(value==null||value===''?null:1):num(value);
    if(n!==null)groups.get(key).push(n);
  };
  if(series.operation==='总体比例'){
    const totals=new Map();
    rows.forEach(row=>{const key=chartAxisKey(row[series.dimension],series);if(key==null||key==='')return;if(!totals.has(key))totals.set(key,{numerator:0,denominator:0,count:0});const n=num(row[series.numerator]),d=num(row[series.denominator]);if(n===null||d===null)return;const group=totals.get(key);group.numerator+=n;group.denominator+=d;group.count++;});
    return new Map([...totals].map(([key,g])=>[key,g.count&&g.denominator!==0?g.numerator/g.denominator:null]));
  }
  if(series.wide)rows.forEach(r=>(series.periods||[]).forEach(c=>push(c,r[c])));
  else rows.forEach(r=>push(r[series.dimension],r[series.metric]));
  const result=new Map();
  groups.forEach((values,key)=>{
    let value=null;
    if(values.length){
      if(series.operation==='平均值')value=values.reduce((a,b)=>a+b,0)/values.length;
      else if(series.operation==='最新值')value=values[values.length-1];
      else if(series.operation==='最大值')value=values.reduce((a,b)=>Math.max(a,b),-Infinity);
      else if(series.operation==='最小值')value=values.reduce((a,b)=>Math.min(a,b),Infinity);
      else value=values.reduce((a,b)=>a+b,0);
    }
    if(['有效数值计数','非空计数'].includes(series.operation))value=values.length;
    result.set(key,value);
  });
  return result;
}
async function home(token){
const tables=activeTables(),recommended=recommend();
const metrics=[
  ['数据文件',new Set(tables.map(t=>t.file_path)).size,'持续汇集的本地数据','M3 4h4l2 2h8v10H3z'],
  ['已识别区域',tables.length,'覆盖多个文件与工作表','M3 4h14v12H3zM3 8h14M8 8v8'],
  ['可选参数',tables.reduce((n,t)=>n+t.fields.length,0),'全部字段均可进入对比','M4 5h12M4 10h12M4 15h12M8 3v4M12 8v4M7 13v4'],
  ['已导入行',tables.reduce((n,t)=>n+t.row_count,0),'包含明细、汇总和辅助区','M4 15V9m4 6V5m4 10v-4m4 4V3'],
];
const cards=recommended.map((t,i)=>`<article class="card"><div class="cardtop"><h3>${esc(metricFields(t)[0].name)} · ${esc(chooseDimension(t))}</h3><span class="tag">${/日期|月份/.test(chooseDimension(t))?'趋势分析':'分类对比'}</span><p title="${esc(t.relative_path)}">${esc(t.file_name)} / ${esc(t.sheet_name)}</p></div><div class="mini-chart" id="mini${i}"></div><div class="cardfoot"><span>${t.row_count} 行 · ${esc(t.range_ref)}</span><button class="link" data-recommend="${t.id}">打开分析 ↗</button></div></article>`).join('');
$('#main').innerHTML=header('OVERVIEW / 数据概览')+`<div class="stats">${metrics.map(([label,value,sub,icon])=>`<div class="stat"><div class="stat-head"><span>${label}</span><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icon}"/></svg></div><b>${fmt(value)}</b><span>${sub}</span></div>`).join('')}</div><div class="sectionhead"><div><h2>推荐分析</h2><p>根据字段类型生成起点，可随时调整指标与口径</p></div></div><div class="cards overview-cards">${cards}</div>`+(tables.length?'':empty('连接你的第一份数据','打开数据源设置，填写本地 Excel 文件夹。','<button id="emptySource">连接文件夹</button>'));
const homeActions=document.createElement('div');
homeActions.className='home-actions';
homeActions.innerHTML='<button id="allData">浏览全部数据</button><button id="startCompare" class="primary">＋ 新建对比</button>';
$('#main .pagehead').append(homeActions);
$('#startCompare').onclick=()=>go('compare');$('#allData').onclick=()=>go('explore');$('#emptySource')?.addEventListener('click',sourceDialog);document.querySelectorAll('[data-recommend]').forEach(b=>b.onclick=async()=>{configureChart(b.dataset.recommend,metricFields(tableById(b.dataset.recommend))[0].name);});
await Promise.all(recommended.map(async(t,i)=>{
  const data=await tableData(t.id);if(token!==renderToken)return;
  const metric=metricFields(t)[0].name,dimension=chooseDimension(t),operation=/率|占比|比例/.test(metric)?'平均值':'求和';
  const temporal=/日期|月份|年月/.test(dimension);
  let values=[...aggregateRows(data,{dimension,metric,operation,excludeTotals:true})];
  values=temporal?values.sort((a,b)=>a[0].localeCompare(b[0],'zh-CN',{numeric:true})).slice(-14):values.filter(([,v])=>v!==null).sort((a,b)=>b[1]-a[1]).slice(0,5).reverse();
  chart($('#mini'+i),{tooltip:{trigger:'axis',confine:true},grid:{left:12,right:25,top:22,bottom:20,containLabel:true},
    xAxis:{type:temporal?'category':'value',data:temporal?values.map(v=>v[0]):undefined,splitLine:{lineStyle:{color:chartGrid,type:'dashed'}},axisLabel:{fontSize:11,hideOverlap:true}},
    yAxis:{type:temporal?'value':'category',data:temporal?undefined:values.map(v=>v[0]),splitLine:{lineStyle:{color:chartGrid,type:'dashed'}},axisTick:{show:false},axisLine:{show:false},axisLabel:{width:90,overflow:'truncate',fontSize:11}},
    series:[{type:temporal?'line':'bar',data:values.map(v=>v[1]),barMaxWidth:16,connectNulls:false,symbolSize:5,itemStyle:{borderRadius:[0,5,5,0],color:colors[0]},...(temporal?{lineStyle:{width:2},areaStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:'rgba(40,89,245,.18)'},{offset:1,color:'rgba(40,89,245,0)'}])}}:{})}]});
}));}
function bindTableActions(){document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>tableById(b.dataset.view)?.archived?viewTable(b.dataset.view):openOriginal(b.dataset.view));document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>configureChart(b.dataset.add,b.dataset.metric));}
async function viewTable(id){const t=tableById(id),data=await tableData(id);state.viewId=id;const fields=t.fields.map(f=>f.name);$('#dialogBody').innerHTML=`<div class="eyebrow">SOURCE / 数据浏览</div><h2>${esc(t.table_name)}</h2><p class="meta">${esc(t.relative_path)} / ${esc(t.sheet_name)} / ${esc(t.range_ref)}</p><div class="toolbar"><input id="rowSearch" placeholder="筛选当前表的内容"><button id="sourcePreview">查看原表</button><button id="rawButton">修正识别</button><button id="exportTable">导出 CSV</button></div><div class="toolbar"><select id="addMetric" aria-label="选择字段">${options(fields,metricFields(t)[0]?.name)}</select><button class="primary" id="addTableMetric">配置图表 →</button></div><div id="rows"></div><p class="meta" id="rowCount"></p>`;let shown=data.rows;const show=()=>{$('#rows').innerHTML=grid(shown.slice(0,200),['_source_row',...fields]);$('#rowCount').textContent=`共 ${shown.length} 行，预览前 200 行；_source_row 为 Excel 来源行。`;};show();$('#rowSearch').oninput=e=>{shown=data.rows.filter(r=>Object.values(r).some(v=>String(v??'').toLowerCase().includes(e.target.value.toLowerCase())));show();};$('#addTableMetric').onclick=()=>configureChart(id,$('#addMetric').value);$('#exportTable').onclick=()=>exportCSV(shown,fields,t.table_name+'.csv');$('#sourcePreview').onclick=()=>openOriginal(id);$('#rawButton').onclick=()=>rawDialog(id);if(!$('#dialog').open)$('#dialog').showModal();}
async function rawDialog(id){
const t=tableById(id);
$('#dialogBody').innerHTML=`<div class="eyebrow">RECOGNITION / 识别修正</div><h2>调整识别规则</h2><p class="meta">${esc(t.file_name)} / ${esc(t.sheet_name)}</p><button id="correctionSource">在数据管理中核对原表</button><div class="formgrid"><label>数据区域（第一行为表头）<input id="correctRange" value="${esc(t.range_ref)}"></label><label>表名<input id="correctName" value="${esc(t.table_name)}"></label><button class="primary" id="correctSave">保存识别规则并重新读取</button><p class="meta">规则单独保存，不修改原文件。离开弹窗前请先保存修改。</p></div>`;
$('#correctionSource').onclick=()=>openOriginal(id);
if(!$('#dialog').open)$('#dialog').showModal();
$('#correctSave').onclick=async()=>{try{$('#correctSave').disabled=true;await api('recognition',{id,range:$('#correctRange').value.trim().toUpperCase(),name:$('#correctName').value});$('#dialog').close();await refreshCatalog({force:true});go(state.page,{background:true});toast('规则已保存，原文件未修改');}catch(e){toast(e.message);}finally{if($('#correctSave'))$('#correctSave').disabled=false;}};
}
async function addSeries(id,metric){const t=tableById(id);if(!t)throw Error('数据表已更新，请重新选择');const data=await tableData(id);const periods=t.fields.map(f=>f.name).filter(c=>/^(\d{4}[-年/])?\d{1,2}(月|[-/]\d{1,2}|$)/.test(c));state.basket.push({id,metric,dimension:chooseDimension(t),operation:/率|占比|比例|%/.test(metric)?'平均值':'求和',label:metric+' · '+t.table_name,filterField:'',filterValue:'',excludeTotals:true,wide:false,periods,uid:Date.now()+Math.random()});persistBasket();toast('已加入对比 · '+metric);}
function picker(){const fields=state.tables.flatMap(t=>t.fields.map(f=>({t,f})));$('#dialogBody').innerHTML=`<div class="eyebrow">FIELD LIBRARY / 全部参数</div><h2>选择要对比的参数</h2><p class="meta">所有文件与数据表的全部字段。选择后可以分别设置筛选与对齐维度。</p><div class="toolbar"><input id="fieldSearch" type="search" placeholder="搜索参数、文件、工作表…" autofocus></div><div id="fieldResults"></div>`;const show=()=>{const words=$('#fieldSearch').value.toLowerCase().split(/\s+/).filter(Boolean);const found=fields.filter(({t,f})=>words.every(w=>(t.relative_path+' '+t.sheet_name+' '+t.table_name+' '+f.name).toLowerCase().includes(w)));$('#fieldResults').innerHTML=`<p class="meta">匹配 ${found.length} 个字段，显示前 80 个；输入关键词缩小范围。</p><div class="tablewrap"><table><thead><tr><th>参数</th><th>来源</th><th></th></tr></thead><tbody>${found.slice(0,80).map(({t,f})=>`<tr><td><b>${esc(f.name)}</b><span class="rowmeta">${f.type==='number'?'数值':f.type==='date'?'时间':'文本 / 可计数'}</span></td><td>${esc(t.table_name)}<span class="rowmeta">${esc(t.file_name)} / ${esc(t.sheet_name)} / ${esc(t.range_ref)}</span></td><td><button data-add="${t.id}" data-metric="${esc(f.name)}">加入 ＋</button></td></tr>`).join('')}</tbody></table></div>`;bindTableActions();};$('#fieldSearch').oninput=show;show();$('#dialog').showModal();$('#fieldSearch').focus();$('#dialog').addEventListener('close',()=>{if(state.page==='compare')go('compare');},{once:true});}
async function compare(token){
  if(state.chartType==='horizontal'){state.chartType='bar';state.axisSwapped=true;}
  $('#main').innerHTML=header('COMPARE / 对比分析','把关键差异，放在同一张图里','各系列独立聚合；时间粒度不同自动分面，缺失项保留为空。')+`<div class="split"><section><div id="seriesList"></div></section><section><div class="panel"><div class="charttools"><label>图表 <select id="chartType">${options(['auto','bar','line','facet','table'],state.chartType)}</select></label><label>显示 <select id="chartLimit">${options(['10','20','50','100','全部'],String(state.limit))}</select></label><button id="saveView">☆ 保存分析</button><button id="png">导出图表</button></div><p id="recommendNote" class="meta" role="status"></p><div id="facetControls" class="charttools" aria-label="分面图分页" style="display:none"></div><div id="compareChart" class="compare-chart"></div></div><div class="panel"><div class="sectionhead" style="margin-top:0"><h2>数值对比</h2><button id="exportCompare">导出 CSV</button></div><label class="meta"><input id="baseline" type="checkbox" ${state.baseline?'checked':''}> 口径与单位相同，计算相对第一组的差值和变化率</label><div id="compareGrid" style="margin-top:16px"></div><p class="meta">基准为 0 或缺失时，变化率留空。不同时间粒度不计算组间差值。</p></div></section></div>`;
  const chartNames={auto:'推荐默认',bar:'分组柱状',line:'趋势折线',facet:'独立分面',table:'仅表格'};
  Array.from($('#chartType').options).forEach(o=>o.textContent=chartNames[o.value]);
  await Promise.all((state.chartPreview||state.basket).map(s=>tableData(s.id).catch(()=>null)));if(token!==renderToken)return;
  $('#chartType').onchange=e=>{state.chartType=e.target.value;drawComparison();syncComparisonTableVisibility();};
  $('#chartLimit').onchange=e=>{state.limit=e.target.value;drawComparison();};
  $('#baseline').onchange=e=>{state.baseline=e.target.checked;drawComparison();};
  $('#saveView').onclick=()=>state.chartPreview?toast('请先应用草稿，再保存分析'):state.basket.length?saveView():toast('请先生成图表');
  $('#png').onclick=()=>{const c=state.charts.find(c=>c.getDom()?.id==='compareChart');if(!c)return toast('当前没有图表');const a=document.createElement('a');a.download='数据速查-对比分析.png';a.href=c.getDataURL({pixelRatio:2,backgroundColor:'#fff'});a.click();};
  drawComparison();
}
function drawComparison(){
  state.charts=state.charts.filter(c=>{if(c.getDom()?.id==='compareChart'){c.dispose();return false;}return true;});
  const entries=[],errors=[];
  (state.chartPreview||state.basket).forEach((s,i)=>{
    try{
      if(!tableById(s.id)||!state.cache.has(s.id))throw Error('来源不可用，请重新选择数据区域');
      const values=aggregateRows(state.cache.get(s.id),s),label=`${i+1}. ${s.label||s.businessMetric||s.metric}`;
      if(s.axisMode!=='category'&&chartAxisIsTime(s,[...values.keys()])&&temporalAxisSignature([...values.keys()]).startsWith('mixed:')){
        const axes=new Map();values.forEach((value,key)=>{const signature=temporalAxisSignature([key]);if(!axes.has(signature))axes.set(signature,new Map());axes.get(signature).set(key,value);});
        axes.forEach((part,signature)=>{const [,grain,scope]=signature.split(':');const detail=grain?periodGrainLabel(grain)+({absolute:' · 含年份',cyclic:' · 无年份',relative:' · 相对序号'}[scope]||''):'非时间标签';entries.push({series:s,values:part,label:label+' / '+detail});});
      }else entries.push({series:s,values,label});
    }
    catch(error){errors.push(`第 ${i+1} 组：${error.message}`);}
  });
  const valid=entries.map(e=>e.series),groups=entries.map(e=>e.values),labels=entries.map(e=>e.label);
  const temporalFlags=valid.map((s,i)=>chartAxisIsTime(s,[...groups[i].keys()]));
  const signatures=groups.map((g,i)=>g.size?(temporalFlags[i]?temporalAxisSignature([...g.keys()]):'category'):'empty');
  const temporal=valid.length>0&&temporalFlags.every(Boolean);
  const usedSignatures=signatures.filter(s=>s!=='empty');
  const incompatibleTime=temporalFlags.some(Boolean)&&(new Set(usedSignatures).size>1||usedSignatures.some(s=>s.startsWith('mixed:'))||temporalFlags.some(t=>!t));
  const categoryIndexes=valid.map((_,i)=>i).filter(i=>!temporalFlags[i]&&groups[i].size);
  const incompatibleCategory=categoryIndexes.some((left,index)=>categoryIndexes.slice(index+1).some(right=>!categoryAxesCompatible(valid[left],groups[left].keys(),valid[right],groups[right].keys())));
  const incompatibleAxes=incompatibleTime||incompatibleCategory;
  const metricKey=s=>(s.businessMetric||s.metric)+'|'+s.operation;
  const orderKeys=(keys,values,s,time)=>{
    const order=s?.axisOrder||'auto';
    if(order==='value')return [...keys].sort((a,b)=>(values?.get(b)??-Infinity)-(values?.get(a)??-Infinity));
    if(order==='time'||order==='auto'&&time)return orderedTemporalKeys([new Map(keys.map(k=>[k,values?.get(k)]))],order==='time');
    return keys;
  };
  const ownKeys=groups.map((g,i)=>orderKeys([...g.keys()],g,valid[i],temporalFlags[i]));
  const keys=incompatibleAxes?[]:orderKeys([...new Set(groups.flatMap(g=>[...g.keys()]))],groups[0],valid[0],temporal);
  const limitKeys=(values,time,s)=>state.limit==='全部'?values:time&&['auto','time'].includes(s?.axisOrder||'auto')?values.slice(-Number(state.limit)):values.slice(0,Number(state.limit));
  const shown=limitKeys(keys,temporal,valid[0]),ownShown=ownKeys.map((values,i)=>limitKeys(values,temporalFlags[i],valid[i]));
  const type=state.chartType==='table'?'table':incompatibleAxes?'facet':state.chartType==='auto'?(new Set(valid.map(metricKey)).size>1?'facet':temporal?'line':'bar'):state.chartType;
  const swapped=!!state.axisSwapped;
  const facetSize=6,facetPages=Math.max(1,Math.ceil(groups.length/facetSize));
  const facetSignature=JSON.stringify([type,labels]);
  if(state.facetSignature!==facetSignature){state.facetPage=0;state.facetSignature=facetSignature;}
  state.facetPage=Math.max(0,Math.min(Number(state.facetPage)||0,facetPages-1));
  const drawIndexes=groups.map((_,i)=>i).filter(i=>type!=='facet'||Math.floor(i/facetSize)===state.facetPage);
  const displayCount=type==='facet'?drawIndexes.reduce((n,i)=>n+ownShown[i].length,0):shown.length;
  const paging=type==='facet'&&facetPages>1;
  $('#facetControls').style.display=paging?'flex':'none';
  if(paging){
    $('#facetControls').innerHTML=`<button type="button" id="facetPrevious" ${state.facetPage===0?'disabled':''}>上一页</button><span class="meta" role="status">分面 ${state.facetPage*facetSize+1}–${Math.min((state.facetPage+1)*facetSize,groups.length)} / ${groups.length} · 第 ${state.facetPage+1} / ${facetPages} 页</span><button type="button" id="facetNext" ${state.facetPage===facetPages-1?'disabled':''}>下一页</button><span class="meta">图表导出为当前页；CSV 包含全部系列</span>`;
    $('#facetPrevious').onclick=()=>{state.facetPage--;drawComparison();};
    $('#facetNext').onclick=()=>{state.facetPage++;drawComparison();};
  }
  const orderMismatch=type!=='facet'&&new Set(valid.map(s=>s.axisOrder||'auto')).size>1;
  const axisReason=temporalFlags.some(Boolean)&&temporalFlags.some(value=>!value)?'时间与分类横轴不同':incompatibleTime?'时间粒度或年份口径不同':'分类横轴的维度不同，或无法确认类别含义一致';
  $('#recommendNote').textContent=(state.chartPreview?'草稿预览 · 尚未应用。':'已应用 · ')+(incompatibleAxes?axisReason+'，已强制独立分面；各组使用自己的横轴，不计算组间差值。':temporal?'推荐趋势折线；同粒度时间自动对齐，缺失值保留断点。':'推荐分类柱状图，多系列并排显示。')+` 共 ${valid.length} 条系列，${paging?'本页':'图中'}显示 ${displayCount} 个数据项。${swapped?' 已交换 X / Y 轴。':''}`+(valid.length>20?' 系列较多，可用图例筛选或切换分面查看；已保留全部选择。':'')+(orderMismatch?' 共用横轴按第一组的排序设置。':'')+(errors.length?' 未绘制：'+errors.join('；'):'');
  const rows=incompatibleAxes?groups.flatMap((g,i)=>ownKeys[i].map(k=>({'系列':labels[i],'对比项':k,'数值':g.get(k)??null}))):keys.map(k=>{const row={'对比项':k};groups.forEach((g,i)=>row[labels[i]]=g.get(k)??null);if(state.baseline&&groups.length>1){const base=groups[0].get(k);groups.slice(1).forEach((g,j)=>{const value=g.get(k);row[labels[j+1]+' 差值']=value==null||base==null?null:value-base;row[labels[j+1]+' 变化率%']=value==null||base==null||base===0?null:(value-base)/base*100;});}return row;});
  $('#baseline').disabled=incompatibleAxes;
  $('#compareGrid').innerHTML=rows.length?grid(rows.slice(0,300),Object.keys(rows[0]))+(rows.length>300?`<p class="meta">预览前 300 / ${rows.length} 行；导出 CSV 包含全部行和系列。</p>`:''):'<div class="empty">没有匹配的数据，请调整筛选或维度。</div>';
  $('#exportCompare').onclick=()=>exportCSV(rows,rows.length?Object.keys(rows[0]):['对比项'],'数据速查-数据对比.csv');
  $('#compareChart').style.display=type==='table'?'none':'block';
  if(type==='table'||!displayCount){$('#compareChart').innerHTML=type==='table'?'':'<div class="empty">'+(errors.length?'部分图表参数需要修正，请查看上方提示。':'选择当前表格与参数，在此预览图表。')+'</div>';return;}
  $('#compareChart').innerHTML='';
  const categoryAxis={type:'category',data:shown,axisLabel:{hideOverlap:true,width:110,overflow:'truncate'},inverse:swapped};
  const valueAxis={type:'value',splitLine:{lineStyle:{color:chartGrid,type:'dashed'}}};
  const series=drawIndexes.map(i=>{const g=groups[i],seriesKeys=type==='facet'?ownShown[i]:shown;return {name:labels[i],type:type==='line'||type==='facet'&&temporalFlags[i]?'line':'bar',data:swapped?seriesKeys.map(k=>[g.get(k)??null,k]):seriesKeys.map(k=>g.get(k)??null),connectNulls:false,barMaxWidth:26,symbolSize:6,lineStyle:{width:2,type:['solid','dashed','dotted'][i%3]},symbol:['circle','rect','triangle','diamond'][i%4]};});
  $('#compareChart').setAttribute?.('aria-label','本页图表系列：'+drawIndexes.map(i=>labels[i]).join('；')+'。全部系列的数值明细可在下方展开查看。');
  let option={tooltip:{trigger:'axis',confine:true},legend:{type:'scroll',top:0,textStyle:{fontSize:11},tooltip:{show:true},formatter:name=>name.length>36?name.slice(0,18)+'…'+name.slice(-16):name},grid:{left:20,right:24,top:50,bottom:38,containLabel:true},xAxis:swapped?valueAxis:categoryAxis,yAxis:swapped?categoryAxis:valueAxis,series};
  if(type==='facet'){
    const height=230;$('#compareChart').style.height=Math.max(450,drawIndexes.length*height)+'px';option.legend.show=false;
    option.grid=drawIndexes.map((_,pageIndex)=>({left:70,right:25,top:pageIndex*height+35,height:150}));
    option.xAxis=drawIndexes.map((i,pageIndex)=>({...structuredClone(swapped?valueAxis:{...categoryAxis,data:ownShown[i]}),gridIndex:pageIndex}));
    option.yAxis=drawIndexes.map((i,pageIndex)=>({...structuredClone(swapped?{...categoryAxis,data:ownShown[i]}:valueAxis),gridIndex:pageIndex}));
    option.title=drawIndexes.map((i,pageIndex)=>({text:labels[i],left:20,top:pageIndex*height+5,textStyle:{fontSize:12,color:colors[i%colors.length]}}));
    option.series.forEach((s,pageIndex)=>{s.xAxisIndex=pageIndex;s.yAxisIndex=pageIndex;s.itemStyle={color:colors[drawIndexes[pageIndex]%colors.length]};});
  }else {
    $('#compareChart').style.height='clamp(460px, 62vh, 760px)';
    if(shown.length>30){
      const axis=swapped?{yAxisIndex:0,orient:'vertical',right:2}:{xAxisIndex:0,bottom:0};
      option.dataZoom=[{type:'slider',start:0,end:100,filterMode:'none',...axis}];
      if(swapped)option.grid.right=65;else option.grid.bottom=70;
    }
  }
  const allPercent=valid.length>0&&valid.every(percentageSeries);
  if(type==='facet'){(swapped?option.xAxis:option.yAxis).forEach((axis,i)=>axis.axisLabel={...(axis.axisLabel||{}),formatter:v=>chartValue(v,percentageSeries(valid[drawIndexes[i]]))});}
  else {const axis=swapped?option.xAxis:option.yAxis;axis.axisLabel={...(axis.axisLabel||{}),formatter:v=>chartValue(v,allPercent)};}
  option.series.forEach((s,i)=>s.tooltip={valueFormatter:v=>chartValue(Array.isArray(v)?v[0]:v,percentageSeries(valid[drawIndexes[i]]))});
  chart($('#compareChart'),option);
}
function views(){try{return JSON.parse(localStorage.getItem('shujian-views')||'[]');}catch{return[];}}
function saveView(){$('#dialogBody').innerHTML='<div class="eyebrow">SAVE ANALYSIS</div><h2>保存这组对比</h2><div class="formgrid"><label>分析名称<input id="viewName" placeholder="例如：M8 与 M9 锁单对比"></label><button class="primary" id="confirmSave">保存</button></div>';$('#dialog').showModal();$('#confirmSave').onclick=()=>{const name=$('#viewName').value.trim();if(!name)return toast('请输入分析名称');const all=views();all.push({name,basket:structuredClone(state.basket),type:state.chartType,axisSwapped:state.axisSwapped,limit:state.limit,baseline:state.baseline,date:new Date().toLocaleDateString('zh-CN')});try{localStorage.setItem('shujian-views',JSON.stringify(all));$('#dialog').close();toast('已保存。同步数据后再次打开会使用最新数据。');}catch{toast('浏览器存储不可用，请导出分析数据');}};}
function saved(){
  const all=views();$('#main').innerHTML=header('COLLECTION / 收藏的分析','把常看的对比，留在手边','保存的是分析设置；打开时读取最新导入数据。')+(all.length?`<div class="cards">${all.map((v,i)=>`<article class="card saved-card"><span class="tag">${v.basket.length} 个系列</span><h3 style="margin-top:14px">${esc(v.name)}</h3><p>${esc(v.date)} · ${esc(v.basket.map(s=>s.businessMetric||s.metric).join(' / '))}</p><button class="primary" data-openview="${i}">打开分析 →</button> <button data-deleteview="${i}">移除收藏</button></article>`).join('')}</div>`:empty('还没有收藏的分析','在对比分析中选择「保存分析」，下次即可直接打开。'));
  document.querySelectorAll('[data-openview]').forEach(b=>b.onclick=()=>{
    const v=all[Number(b.dataset.openview)];state.basket=normalizeSeriesIds(structuredClone(v.basket));state.chartType=v.type||'auto';state.axisSwapped=!!v.axisSwapped;state.limit=v.limit??'全部';state.baseline=!!v.baseline;state.chartPreview=null;state.chartUndo=null;state.openBuilder=false;state.builderOpen=false;state.seriesManagerOpen=false;
    const first=state.basket[0];
    if(typeof loadChartDraftFromSeries==='function')loadChartDraftFromSeries(first);
    else if(typeof resetChartDraft==='function')resetChartDraft(first?.id||'',first?.metric||'');
    if(typeof draft!=='undefined'){draft.previewActive=false;delete draft.editUid;}
    persistBasket();go('compare');
  });
  document.querySelectorAll('[data-deleteview]').forEach(b=>b.onclick=()=>{all.splice(Number(b.dataset.deleteview),1);localStorage.setItem('shujian-views',JSON.stringify(all));saved();});
}
async function search(token){$('#main').innerHTML=header('SEARCH / 全局搜索','搜索「'+state.query+'」','同时查找文件、表名、字段以及单元格内容。')+'<div class="loading">正在搜索全部已导入数据…</div>';const result=await api('search?q='+encodeURIComponent(state.query));if(token!==renderToken)return;const resultSummary=`找到 ${result.hits.length} 个相关数据区域${result.hits.length>60?'，当前显示前 60 个；请缩小关键词查看其他结果。':'。'}每表展示最多 3 条示例。`;$('#main').innerHTML=header('SEARCH / 全局搜索','搜索「'+state.query+'」',resultSummary)+`<p class="search-summary" role="status">${resultSummary}</p><div class="results">${result.hits.slice(0,60).map(({table:t,rows})=>`<article class="panel"><div class="sectionhead" style="margin:0 0 12px"><div><h3>${esc(t.table_name)}</h3><p>${esc(t.relative_path)} / ${esc(t.sheet_name)} / ${esc(t.range_ref)}</p></div><button data-view="${t.id}">浏览数据 →</button></div><p class="meta">${t.fields.filter(f=>state.query.split(/\s+/).some(w=>f.name.includes(w))).slice(0,8).map(f=>`<button class="fieldchip" data-add="${t.id}" data-metric="${esc(f.name)}">${esc(f.name)} ＋</button>`).join('')}</p>${rows.map(row=>`<div class="resultrow"><span class="tag">行 ${esc(row._source_row)}</span> ${Object.entries(row).filter(([k])=>!k.startsWith('_')).slice(0,8).map(([k,v])=>`${esc(k)} <b>${esc(fmt(v))}</b>`).join(' · ')}</div>`).join('')}</article>`).join('')}</div>`+(result.hits.length?'':empty('没有找到匹配数据','尝试缩短关键词，或同步刚放入文件夹的新文件。'));bindTableActions();}
function sourceDialog(){
  const folders=configuredSourceFolders(state.config);
  $('#dialogBody').innerHTML=`<div class="source-settings"><h2>管理数据源</h2><p class="meta">同时读取多个目录及其子目录中的 .xlsx、.xlsm。新增文件和内容更新均参与同步。</p><div class="formgrid"><label>扫描目录（每行一条）<textarea id="folderPath" rows="5" spellcheck="false" aria-describedby="sourcePathHint">${esc(folders.join('\n'))}</textarea></label><p id="sourcePathHint" class="meta">支持本机目录、共享目录及相对路径。</p><label>默认导入目录<select id="defaultImportFolder">${options(folders,state.config.folder||folders[0])}</select></label><label class="inline"><input id="autoSync" type="checkbox" ${state.config.auto?'checked':''}> 服务运行期间，每 60 秒检查新增和变更文件</label><p id="sourceError" class="source-warning" role="alert" hidden></p><button class="primary" id="connectFolder">保存并同步</button><p class="meta">移除目录或移走文件后，已导入的数据保留为历史来源。</p></div></div>`;
  const paths=$('#folderPath'),destination=$('#defaultImportFolder'),save=$('#connectFolder'),error=$('#sourceError');
  const enteredFolders=()=>[...new Set(paths.value.split(/\r?\n/).map(path=>path.trim()).filter(Boolean))];
  const updateDestinations=()=>{
    const values=enteredFolders(),selected=values.includes(destination.value)?destination.value:values[0];
    destination.innerHTML=options(values,selected);destination.disabled=!values.length;save.disabled=!values.length;
  };
  paths.addEventListener('input',updateDestinations);updateDestinations();
  $('#dialog').showModal();
  save.onclick=async()=>{
    if(save.disabled)return;
    save.disabled=true;save.textContent='正在保存…';error.hidden=true;paths.disabled=true;destination.disabled=true;
    try{
      const saved={folders:enteredFolders(),folder:destination.value,auto:$('#autoSync').checked};
      await api('config',saved);state.config={...state.config,...saved};
      if($('#dialogBody').contains(save))$('#dialog').close();
      toast('已开始同步所有数据目录');trackRequestedSync();
    }catch(e){error.textContent=e.message;error.hidden=false;}
    finally{paths.disabled=false;destination.disabled=!enteredFolders().length;save.disabled=!enteredFolders().length;save.textContent='保存并同步';}
  };
}
$('#nav').onclick=e=>{const b=e.target.closest('[data-page]');if(b)go(b.dataset.page);};$('#sourceButton').onclick=sourceDialog;$('#syncButton').onclick=async()=>{try{$('#syncButton').disabled=true;await api('sync',{});toast('正在同步新增和变更文件');trackRequestedSync();}catch(e){$('#syncButton').disabled=false;toast(e.message);}};$('#search').oninput=e=>{clearTimeout(searchTimer);state.query=e.target.value.trim();searchTimer=setTimeout(()=>{if(state.query)go('search',{background:true});else go('home',{background:true});},450);};document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){e.preventDefault();$('#search').focus();}});
window.addEventListener('DOMContentLoaded',async()=>{try{await refreshCatalog();try{state.basket=JSON.parse(localStorage.getItem('shujian-basket')||'[]');}catch{}persistBasket();go(['home','raw','explore','compare','saved','health'].includes(location.hash.slice(1))?location.hash.slice(1):'home');setInterval(async()=>{if(pollBusy)return;pollBusy=true;try{const changed=await refreshCatalog();if(changed)go(state.page,{background:true});}catch(e){$('#syncStatus').textContent='连接中断，请检查本地服务';}finally{pollBusy=false;}},AUTO_REFRESH_INTERVAL);}catch(e){$('#main').innerHTML=empty('数据服务未连接',esc(e.message));}});
