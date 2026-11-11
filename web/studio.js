'use strict';
// Keep the existing aggregation / saved-analysis contract; change the primary workflow.
let builderVersion=0;
const draft={id:'',metric:'',dimension:'',vehicleField:'',vehicleValue:'',filterField:'',filterValue:'',wide:false,periodGrain:'',periods:[]};
const original={id:'',sheet:'',start:1,column:1};

function openOriginal(id){
  const t=tableById(id);if(!t)return toast('来源已更新，请重新选择');
  if(t.archived)return toast('原文件已移走，仍可查看已导入的数据');
  if($('#dialog').open)$('#dialog').close();
  original.path=t.file_path;original.sheet=t.sheet_name;original.regionId=id;
  original.start=Number(t.range_ref.match(/\d+/)?.[0])||1;original.column=1;
  go('raw');
}
function resetChartDraft(id,metric=''){
  for(const key of Object.keys(draft))delete draft[key];
  Object.assign(draft,{id,metric,filters:[],selectedValues:[],hierarchy:{},excludeTotals:true,autoOperation:true,readingMode:'auto',previewActive:true,commitMode:state.basket.length?'append':'replace'});
}
function loadChartDraftFromSeries(series,{editing=false}={}){
  resetChartDraft(series?.id||'',series?.metric||'');
  if(series)Object.assign(draft,structuredClone(series),{sourceId:series.id,metrics:[series.metric],label:series.customLabel===false?'':series.label,selectedValues:series.vehicleField?[series.vehicleValue]:[],filters:structuredClone(series.filters||[]),hierarchy:{},autoOperation:false,selectionTouched:true});
  if(series){
    draft.legacyRowSelection=!!series.wide;
    draft.splitField=series.wide?'':series.vehicleField||'';
    draft.splitValues=series.wide?[]:series.vehicleField?[series.vehicleValue]:[];
    draft.splitSelectionTouched=true;
    if(!series.wide){delete draft.periods;delete draft.seriesFields;}
  }
  if(series?.filterField&&series.filterValue)draft.filters.push({field:series.filterField,value:series.filterValue});
  draft.previewActive=editing;draft.commitMode=editing?'update':state.basket.length?'append':'replace';
  if(editing&&series)draft.editUid=series.uid;else delete draft.editUid;
}
function renderCatalogUpdateNotice(){
  const previous=$('#catalogUpdateNotice');
  if(!state.catalogPending){previous?.remove();return;}
  if(previous)return;
  const notice=document.createElement('section');notice.id='catalogUpdateNotice';notice.className='catalog-update notice';notice.setAttribute('role','status');
  notice.innerHTML='<div><strong>发现新的源数据</strong><p>当前图表和输入已保留。更新后会重新核对字段与筛选，不会自动改选其他数据。</p></div><button id="applyCatalogUpdate">载入更新并核对</button>';
  $('#main .pagehead')?.after(notice);
  $('#applyCatalogUpdate')?.addEventListener('click',async()=>{try{if(await applyPendingCatalog())toast('已载入更新，请核对图表参数');}catch(e){toast('更新失败：'+e.message);}});
}
function configureChart(id,metric=''){
  if(!tableById(id))return toast('数据表已更新，请重新选择');
  if($('#dialog').open)$('#dialog').close();
  resetChartDraft(id,metric);state.openBuilder=true;state.chartPreview=null;go('compare');
}
async function dataPage(token){await rawPage(token);}
function studioSelect(id,label,content){return '<label>'+esc(label)+'<select id="'+id+'">'+content+'</select></label>';}
// Pagination only limits DOM nodes, never the selection or chart data.
function studioPicker(id,title,open=false){return '<details class="mapping-picker" id="'+id+'Shell" '+(open?'open':'')+'><summary>'+esc(title)+' <span id="'+id+'Summary"></span></summary><div id="'+id+'" class="series-picker"></div></details>';}
function bindStudioPicker(id,items,selected,onChange){
  const root=$('#'+id),memory=draft.pickerState||(draft.pickerState={}),saved=memory[id]||(memory[id]={query:'',page:0});
  let chosen=[...selected];
  root.innerHTML='<div class="picker-tools"><input id="'+id+'Search" type="search" aria-label="搜索'+esc(id==='seriesChoices'?'展示系列':'字段')+'" placeholder="搜索…"><button data-action="all">全选</button><button data-action="clear">清空全部</button><span class="meta" data-count aria-live="polite"></span></div><div class="series-choices" data-list></div><div class="picker-pages"><button data-action="prev">上一页</button><span class="meta" data-page></span><button data-action="next">下一页</button></div>';
  const search=root.querySelector('input[type="search"]');search.value=saved.query;
  const matching=()=>items.filter(item=>item.label.toLowerCase().includes(saved.query.toLowerCase()));
  const emit=()=>{render();onChange([...chosen]);};
  const render=()=>{
    const list=root.querySelector('[data-list]'),focused=document.activeElement;
    const focusedChoice=focused?.type==='checkbox'&&focused.dataset?.choice!=null&&list.contains(focused)?focused.id:'';
    const filtered=matching(),pages=Math.max(1,Math.ceil(filtered.length/100));saved.page=Math.min(saved.page,pages-1);
    const shown=filtered.slice(saved.page*100,(saved.page+1)*100);
    list.innerHTML=shown.map(item=>'<label><input id="'+id+'Choice'+items.indexOf(item)+'" type="checkbox" data-choice="'+items.indexOf(item)+'" '+(chosen.includes(item.value)?'checked':'')+'><span>'+esc(item.label)+(item.detail?'<small class="metric-source">'+esc(item.detail)+'</small>':'')+'</span></label>').join('')||'<p class="meta">没有匹配项。</p>';
    root.querySelector('[data-count]').textContent='已选 '+chosen.length+' / '+items.length;
    $('#'+id+'Summary').textContent='已选 '+chosen.length+(chosen.length?' · '+chosen.slice(0,2).map(v=>items.find(i=>i.value===v)?.label||v).join('、')+(chosen.length>2?' 等':''):'');
    root.querySelector('[data-action="all"]').textContent=saved.query?'全选搜索结果（'+filtered.length+'）':'全选（'+items.length+'）';
    root.querySelector('[data-action="all"]').disabled=!filtered.length;
    root.querySelector('[data-action="clear"]').disabled=!chosen.length;
    root.querySelector('[data-action="prev"]').disabled=saved.page===0;
    root.querySelector('[data-action="next"]').disabled=saved.page>=pages-1;
    root.querySelector('[data-page]').textContent=(saved.page+1)+' / '+pages+' 页 · '+filtered.length+' 项；全选包含全部页';
    root.querySelector('.picker-pages').hidden=pages===1;
    root.querySelectorAll('[data-choice]').forEach(el=>el.onchange=()=>{const value=items[+el.dataset.choice].value;chosen=el.checked?[...new Set([...chosen,value])]:chosen.filter(v=>v!==value);emit();});
    if(focusedChoice)Array.from(root.querySelectorAll('[data-choice]')).find(el=>el.id===focusedChoice)?.focus({preventScroll:true});
  };
  search.oninput=()=>{saved.query=search.value;saved.page=0;render();};
  root.querySelector('[data-action="all"]').onclick=()=>{chosen=[...new Set([...chosen,...matching().map(i=>i.value)])];emit();};
  root.querySelector('[data-action="clear"]').onclick=()=>{chosen=[];emit();};
  root.querySelector('[data-action="prev"]').onclick=()=>{saved.page--;render();};
  root.querySelector('[data-action="next"]').onclick=()=>{saved.page++;render();};
  const shell=$('#'+id+'Shell');shell.ontoggle=()=>{saved.open=shell.open;};if(saved.open!=null)shell.open=saved.open;
  render();
}
async function chartStudio(token){
  normalizeSeriesIds(state.basket);
  state.chartPreview=null;
  await compare(token);if(token!==renderToken)return;
  $('#main .pagehead').outerHTML=header('CHART STUDIO / 图表展示','');
  const layout=$('#main .split');layout.className='studio-layout';layout.firstElementChild.remove();
  const settingsCard=document.createElement('section');settingsCard.className='panel studio-settings-card';settingsCard.setAttribute('aria-label','图表设置');
  const seriesToolbar=document.createElement('div');seriesToolbar.className='series-toolbar';seriesToolbar.innerHTML='<div>'+(state.chartUndo?'<button id="undoChartChange">撤销上次图表改动</button> ':'')+'<button id="studioNew">新建图表 / 对比 ＋</button><button id="studioRaw">查看原始表格</button></div>';settingsCard.append(seriesToolbar);
  seriesToolbar.querySelector('#studioRaw').onclick=()=>{
    if(!draft.id&&draft.sourcePath){Object.assign(original,{path:draft.sourcePath,sheet:draft.sourceSheet||'',regionId:'',start:1,column:1});return go('raw');}
    openOriginal(draft.id||state.basket[0]?.id);
  };
  const manager=document.createElement('details');manager.className='applied-series-manager';manager.open=!!state.seriesManagerOpen;
  manager.innerHTML='<summary>管理已应用系列 <span class="meta">编辑 / 移除 · '+state.basket.length+' 条</span></summary>';
  manager.ontoggle=()=>{state.seriesManagerOpen=manager.open;};
  const ribbon=document.createElement('div');ribbon.className='series-ribbon'+(state.basket.length>8?' many-series':'');ribbon.setAttribute('aria-label','已应用系列，较多时可滚动查看和编辑');
  ribbon.innerHTML=state.basket.map((s,i)=>'<div class="series-chip"><button class="series-edit" data-edit-uid="'+esc(s.uid)+'" style="border-left-color:'+colors[i%colors.length]+'">'+(i+1)+'. '+esc(s.label)+' · 编辑</button><button class="series-remove" data-remove-uid="'+esc(s.uid)+'" aria-label="移除第 '+(i+1)+' 组">×</button></div>').join('')||'<p class="meta">还没有已应用系列，请先选择数据生成图表。</p>';
  manager.append(ribbon);settingsCard.append(manager);
  const builder=document.createElement('details');builder.id='studioBuilderShell';builder.className='studio-builder studio-builder-primary';builder.open=!!state.openBuilder||!state.basket.length||!!draft.editUid||!!draft.previewActive||!!state.builderOpen;
  builder.ontoggle=()=>{state.builderOpen=builder.open;};
  builder.innerHTML='<summary class="studio-settings-heading"><strong>图表数据与对比参数</strong><small>统一编辑 · 预览不会改动已应用图表</small></summary><div id="studioBuilder"></div>';settingsCard.append(builder);state.openBuilder=false;
  $('#main .pagehead').after(settingsCard);
  $('#undoChartChange')?.addEventListener('click',()=>{state.basket=state.chartUndo;state.chartUndo=null;state.chartPreview=null;loadChartDraftFromSeries(state.basket[0]);persistBasket();go('compare');toast('已撤销上次图表改动');});
  ribbon.querySelectorAll('[data-edit-uid]').forEach(b=>b.onclick=()=>{
    const s=state.basket.find(s=>String(s.uid)===b.dataset.editUid);if(!s)return;
    loadChartDraftFromSeries(s,{editing:true});
    builder.open=true;mountBuilder(token);
  });
  ribbon.querySelectorAll('[data-remove-uid]').forEach(b=>b.onclick=()=>{
    state.chartUndo=structuredClone(state.basket);
    state.basket=state.basket.filter(s=>String(s.uid)!==b.dataset.removeUid);
    if(String(draft.editUid)===b.dataset.removeUid){delete draft.editUid;draft.previewActive=false;}
    state.chartPreview=null;persistBasket();go('compare');
  });
  $('#studioNew').onclick=()=>{resetChartDraft(draft.id||state.basket[0]?.id);builder.open=true;mountBuilder(token);};
  const chartHeading=document.createElement('div');chartHeading.className='chart-section-heading';chartHeading.innerHTML='<h2>图表画布</h2><span id="chartStage" class="preview-status" role="status"></span>';$('#chartType').closest('.charttools').before(chartHeading);
  const swap=document.createElement('button');swap.id='swapAxes';swap.textContent=state.axisSwapped?'恢复默认方向':'切换 X / Y';$('#saveView').before(swap);
  swap.onclick=()=>{state.axisSwapped=!state.axisSwapped;swap.textContent=state.axisSwapped?'恢复默认方向':'切换 X / Y';drawComparison();};
  const numericPanel=$('#compareGrid').closest('.panel'),fold=document.createElement('details');fold.className='numeric-details';fold.innerHTML='<summary>查看数值明细、差值与导出</summary>';numericPanel.before(fold);fold.append(numericPanel);
  if(!draft.id&&!draft.sourcePath){resetChartDraft(state.basket[0]?.id||recommend()[0]?.id||activeTables()[0]?.id);draft.previewActive=!state.basket.length;}
  await mountBuilder(token);if(token!==renderToken)return;state.charts.forEach(c=>c.resize());
  if(typeof uiFeedback==='function')uiFeedback($('#chartStage'),'status');
}
const workbookDirectoryCache=new Map();
function chartSourceFiles(){
  const files=(state.files||[]).map(f=>({...f,file_path:f.path,relative_path:f.name}));
  for(const t of state.tables)if(!files.some(f=>f.file_path===t.file_path))files.push({...t,archived:true});
  return files;
}
async function chartSourceContext(t){
  const files=chartSourceFiles(),path=draft.sourcePath||t?.file_path||files[0]?.file_path;
  const file=files.find(f=>f.file_path===path);
  let sheets=[],error='';
  if(file?.id&&!file.archived){
    const key=file.id+'|'+file.signature;
    try{
      let info=workbookDirectoryCache.get(key);
      if(!info){
        info=await api('workbook?id='+encodeURIComponent(file.id));
        for(const oldKey of workbookDirectoryCache.keys())if(oldKey.startsWith(file.id+'|'))workbookDirectoryCache.delete(oldKey);
        workbookDirectoryCache.set(key,info);
      }
      sheets=info.sheets;
    }catch(e){error='无法核对当前工作表目录：'+e.message;}
  }else sheets=[...new Set(state.tables.filter(x=>x.file_path===path).map(x=>x.sheet_name))];
  const sheet=draft.sourceSheet||t?.sheet_name||sheets[0]||'';
  const regions=state.tables.filter(x=>x.file_path===path&&x.sheet_name===sheet);
  const missing=!error&&!file?.archived&&!!sheet&&!sheets.includes(sheet);
  return {files,path,sheet,sheets,regions,error,missing};
}
function chartSourceMarkup(source,id){
  return '<div class="studio-fields compact-fields">'+
    studioSelect('studioFile','文件',source.files.map(f=>'<option value="'+esc(f.file_path)+'" '+(f.file_path===source.path?'selected':'')+'>'+esc(f.relative_path||f.file_name)+(f.archived?'（历史来源）':'')+'</option>').join(''))+
    studioSelect('studioSheet','工作表 / Sheet',options(source.sheets,source.sheet))+
    studioSelect('studioTable','数据区域（自动识别）',source.regions.length?source.regions.map(r=>'<option value="'+esc(r.id)+'" '+(r.id===id?'selected':'')+'>'+esc(r.table_name+' · '+r.range_ref)+'</option>').join(''):'<option value="">暂无已导入区域</option>')+'</div>'+
    (source.error||source.missing?'<p class="source-warning" role="alert">'+esc(source.error||'当前文件中已不存在“'+source.sheet+'”。旧图表未改动，请选择实际工作表，并同步更新数据。')+'</p>':'');
}
function bindChartSources(source,token){
  const select=(path,sheet,id)=>{
    const editUid=draft.editUid,commitMode=draft.commitMode;
    resetChartDraft(id||'');Object.assign(draft,{sourcePath:path,sourceSheet:sheet,editUid,commitMode});
    refreshStudioRecommendations(token,[],null,null);
    state.chartPreview=null;drawComparison();return mountBuilder(token);
  };
  $('#studioFile').onchange=e=>select(e.target.value,'','');
  $('#studioSheet').onchange=e=>select(source.path,e.target.value,'');
  $('#studioTable').onchange=e=>select(source.path,source.sheet,e.target.value);
  $('#studioTable').disabled=!source.regions.length||source.missing;
}
async function mountBuilder(token){
  const version=++builderVersion,root=$('#studioBuilder');
  if(!root)return;root.setAttribute('aria-busy','true');root.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);
  if(!root.querySelector('.builder-loading')){const loading=document.createElement('p');loading.className='builder-loading';loading.setAttribute('role','status');loading.innerHTML='<span class="ui-busy-indicator" aria-hidden="true"></span> 正在读取数据和核对字段…';root.prepend(loading);}
  let t=tableById(draft.id);
  if(!t&&draft.id){root.innerHTML='<p class="source-warning" role="alert">原数据区域已不可用，已保留草稿，未改选其他表格。</p><button id="reselectChartSource">重新选择数据</button>';root.removeAttribute('aria-busy');$('#reselectChartSource').onclick=()=>{const editUid=draft.editUid,commitMode=draft.commitMode;resetChartDraft(activeTables()[0]?.id||'');draft.editUid=editUid;draft.commitMode=commitMode;mountBuilder(token);};return;}
  if(!t&&!draft.sourcePath){t=activeTables()[0];if(t)resetChartDraft(t.id);}
  let source;
  try{source=await chartSourceContext(t);}catch(e){if(token!==renderToken||version!==builderVersion)return;root.innerHTML='<p class="source-warning" role="alert">'+esc(e.message)+'</p>';root.removeAttribute('aria-busy');return;}
  if(token!==renderToken||version!==builderVersion)return;
  if(!t&&!source.missing&&!source.error){t=source.regions[0];if(t)draft.id=t.id;}
  if(!t||source.missing||source.error){
    state.chartPreview=null;drawComparison();refreshStudioRecommendations(token,[],null,null);
    $('#chartStage').textContent='已应用图表已保留 · 当前来源待核对';$('#saveView').disabled=false;
    root.innerHTML=chartSourceMarkup(source,t?.id)+'<p class="meta" role="status">'+(source.error?'目录读取失败，可查看原表或重试同步。':source.missing?'不会用其他 Sheet 替代当前图表数据。':'此工作表尚无已导入数据区域。同步后重新识别；说明页或空表可能没有可画图的数据。')+'</p><div class="studio-actions"><button id="syncChartSource">同步并重新识别</button><button id="sourceOriginal">查看原始表格</button></div>';
    root.removeAttribute('aria-busy');bindChartSources(source,token);
    $('#sourceOriginal').onclick=()=>{Object.assign(original,{path:source.path,sheet:source.sheet,regionId:'',start:1,column:1});go('raw');};
    $('#syncChartSource').onclick=async()=>{
      const button=$('#syncChartSource');button.disabled=true;button.textContent='正在同步…';
      try{
        await api('sync',{});
        let result;
        for(let i=0;i<60;i++){await new Promise(resolve=>setTimeout(resolve,1000));if(token!==renderToken||version!==builderVersion)return;result=await api('catalog');if(!result.status.busy)break;}
        if(result.status.busy){toast('同步仍在进行，完成后可载入更新');return;}
        installCatalog(result);await mountBuilder(token);toast(result.status.errors.length?'同步完成，部分文件需检查':'已同步并核对当前工作表');
      }catch(e){toast('同步失败：'+e.message);}finally{if(button.isConnected){button.disabled=false;button.textContent='同步并重新识别';}}
    };
    return;
  }
  let data;try{data=await tableData(t.id);}catch(e){if(token!==renderToken||version!==builderVersion)return;root.innerHTML='<p class="source-warning" role="alert">读取失败：'+esc(e.message)+'</p><button id="retryBuilder">重试读取</button>';root.removeAttribute('aria-busy');$('#retryBuilder').onclick=()=>mountBuilder(token);return;}
  if(token!==renderToken||version!==builderVersion)return;
  const fields=t.fields.map(f=>f.name),groups=periodColumnGroups(t).filter(g=>g.columns.length>=2),defaults=chartDefaults(t);
  const inferred=inferChartMapping(t,data.rows,draft.metric);
  const useMapping=m=>{
    Object.assign(draft,m,{sourceId:t.id,dimension:m.wide?defaults.dimension:m.dimension,metric:m.metrics[0]||m.periods[0]||defaults.metric,metrics:[...m.metrics],operation:defaults.operation,vehicleField:'',selectedValues:[],splitField:'',splitValues:[],hierarchy:{},rangeError:'',label:'',autoOperation:true,selectionTouched:false,splitSelectionTouched:false,labelFieldsTouched:false,mappingReason:m.reason,axisOrder:'auto',readingMode:'auto'});
    delete draft.inputKeys;delete draft.legacyRowSelection;delete draft.rowMode;
    if(m.wide){draft.periods=[...m.periods];draft.seriesFields=[...m.seriesFields];}
    else {delete draft.periods;delete draft.seriesFields;}
    draft.periodGroupId=groups.find(g=>g.columns.join('|')===(draft.periods||[]).join('|'))?.id||'manual';
  };
  if(draft.sourceId!==t.id){useMapping(inferred);draft.filters=[];}
  draft.axisMode=draft.axisMode||'auto';draft.axisOrder=draft.axisOrder||'auto';
  if(draft.wide&&!fields.includes(draft.dimension))draft.dimension=defaults.dimension;
  draft.filters=draft.filters||[];
  const catalog=chartMetricCatalog(t,data.rows,draft);
  const hierarchy=hierarchyChoices(catalog.availableRows.map(item=>item.row),catalog.rowFields.slice(0,-1),draft.hierarchy||{});
  draft.hierarchy=Object.fromEntries(hierarchy.levels.map(level=>[level.field,level.value]));
  if(hierarchy.levels.some(level=>level.value)){
    const rowsByIdentity=new Map(data.rows.map((row,index)=>[row,index]));
    const allowed=new Set(hierarchy.rows.map(row=>chartRowInputKey(catalog.rowField,catalog.rowFields,seriesRowValue(row,{vehicleField:catalog.rowField,seriesFields:catalog.rowFields},rowsByIdentity.get(row)))));
    catalog.items=catalog.items.filter(item=>item.kind==='column'||allowed.has(item.value));
  }
  draft.inputKeys=chartMetricSelection(draft,catalog);
  draft.periods=[...catalog.rowPeriods];
  if(!draft.legacyRowSelection)draft.seriesFields=[...catalog.rowFields];
  const selectedItems=catalog.items.filter(item=>draft.inputKeys.includes(item.value));
  const hasRows=selectedItems.some(item=>item.kind==='row')||draft.readingMode==='matrix';
  const hasColumns=selectedItems.some(item=>item.kind==='column')||!hasRows;
  const missingItems=draft.inputKeys.filter(key=>!catalog.items.some(item=>item.value===key)).map(key=>({value:key,label:'已失效 · '+chartMetricInputLabel(key),detail:'请重新选择'}));
  const metricItems=[...catalog.items].sort((a,b)=>Number(b.kind===catalog.recommendedKind)-Number(a.kind===catalog.recommendedKind)).concat(missingItems);
  const baseRows=catalog.availableRows.map(item=>item.row);
  draft.splitField=draft.splitField||'';draft.splitValues=draft.splitValues||[];
  const splitCandidates=draft.splitField?[...new Set(baseRows.map(row=>String(row[draft.splitField]??'')).filter(Boolean))]:[];
  if(!draft.splitSelectionTouched&&draft.splitField&&!draft.splitValues.length&&splitCandidates.length)draft.splitValues=[splitCandidates[0]];
  const groupOptions=groups.map(g=>'<option value="'+esc(g.id)+'" '+(draft.periodGroupId===g.id?'selected':'')+'>'+esc(periodGrainLabel(g.grain)+(g.qualifier?' · '+g.qualifier:'')+'（'+g.columns.length+' 列）')+'</option>').join('');
  const numeric=t.fields.filter(f=>f.type==='number').map(f=>f.name);
  const ops=['求和','平均值','最新值','最大值','最小值','有效数值计数','非空计数',...(!hasRows?['总体比例']:[])];
  const editing=draft.editUid!=null;
  if(!draft.commitMode||draft.commitMode==='update'&&!editing)draft.commitMode=editing?'update':state.basket.length?'append':'replace';
  const modes=[...(editing?[['update','更新所选系列']]:[]),...(state.basket.length?[['append','加入已有对比（保留已有）']]:[]),['replace',state.basket.length?'替换当前图表':'生成主图']];
  if(!modes.some(([mode])=>mode===draft.commitMode))draft.commitMode='replace';
  root.innerHTML='<div class="preview-bar">'+studioSelect('studioIntent','本次操作',modes.map(([mode,label])=>'<option value="'+mode+'" '+(mode===draft.commitMode?'selected':'')+'>'+label+'</option>').join(''))+'<span class="preview-status" id="draftStatus" role="status"></span></div>'+chartSourceMarkup(source,t.id)+
    studioPicker('metricChoices','选择指标 / Y 轴',true)+
    (hierarchy.levels.length?'<details class="hierarchy-disclosure" '+(draft.hierarchyOpen?'open':'')+'><summary>按层级筛选行指标 <span class="meta">可选 · '+hierarchy.levels.length+' 个字段</span></summary><div class="studio-fields compact-fields hierarchy-fields">'+hierarchy.levels.map((level,i)=>studioSelect('hierarchy'+i,level.field,'<option value="">全部</option>'+options(level.values,level.value))).join('')+'</div></details>':'')+
    (draft.operation==='总体比例'?'<p class="meta">当前数值使用分子合计 ÷ 分母合计，可在高级设置调整。</p>':'')+
    (hasColumns?'<div class="studio-fields metric-axis-fields">'+studioSelect('studioDimension',hasRows?'列指标的横轴 / X':'横轴 / X',options(fields,draft.dimension))+
      studioSelect('studioSplit','拆分对比（可选）','<option value="">不拆分</option>'+options(fields,draft.splitField))+'</div>':'')+
    (hasRows?studioPicker('columnChoices',hasColumns?'行指标的横轴 / X':'横轴 / X',false):'')+
    (hasColumns&&draft.splitField?studioPicker('seriesChoices','选择对比项',true):'')+
    '<div class="metric-preview" id="mappingPreview" aria-live="polite"></div><p class="meta" id="mappingSummary" aria-live="polite"></p>'+
    '<details class="builder-more" '+(draft.advancedOpen?'open':'')+'><summary>高级设置 · 筛选、统计与数据识别</summary><div class="studio-fields">'+
    studioSelect('studioLayout','数据读取方式','<option value="auto" '+(!draft.readingMode||draft.readingMode==='auto'?'selected':'')+'>自动 · 行、列指标均可选</option><option value="records" '+(draft.readingMode==='records'?'selected':'')+'>只选择列指标</option><option value="matrix" '+(draft.readingMode==='matrix'?'selected':'')+'>只选择行指标</option>')+
    studioSelect('studioAxisMode','横轴含义','<option value="auto" '+(draft.axisMode==='auto'?'selected':'')+'>自动判断时间 / 分类</option><option value="time" '+(draft.axisMode==='time'?'selected':'')+'>按时间处理</option><option value="category" '+(draft.axisMode==='category'?'selected':'')+'>按普通分类（保留原标签）</option>')+
    studioSelect('studioOperation','统计方式','<option value="__auto__" '+(draft.autoOperation?'selected':'')+'>自动（各指标分别判断）</option>'+options(ops,draft.autoOperation?'':draft.operation))+
    studioSelect('studioAxisOrder','横轴排列','<option value="auto" '+(draft.axisOrder==='auto'?'selected':'')+'>自动（时间排序 / 分类原序）</option><option value="source" '+(draft.axisOrder==='source'?'selected':'')+'>保留原表顺序</option><option value="time" '+(draft.axisOrder==='time'?'selected':'')+'>按时间先后</option><option value="value" '+(draft.axisOrder==='value'?'selected':'')+'>按数值降序</option>')+
    '<label>系列名称（单系列时）<input id="studioLabel" value="'+esc(draft.label||'')+'" placeholder="留空自动命名"></label>'+
    (draft.operation==='总体比例'?studioSelect('studioNumerator','分子（合计）',options(['',...numeric],draft.numerator||''))+studioSelect('studioDenominator','分母（合计）',options(['',...numeric],draft.denominator||'')):'')+'</div>'+
    '<details class="row-recognition" '+(draft.rowRecognitionOpen?'open':'')+'><summary>修正行指标识别</summary><div class="studio-fields">'+studioSelect('studioRowMode','同名行如何处理','<option value="labels" '+(catalog.rowField!=='__row_index__'?'selected':'')+'>按标识字段组合（可多级）</option><option value="index" '+(catalog.rowField==='__row_index__'?'selected':'')+'>每个原始数据行独立展示</option>')+'</div>'+studioPicker('labelChoices','行标识字段',false)+'</details>'+
    '<div class="mapping-hint"><span class="meta">'+esc(draft.mappingReason||'已保留当前数据选择。')+'</span><button id="studioAuto" class="link">重新自动识别</button></div>'+
    '<div id="studioFilters">'+draft.filters.map((f,i)=>'<div class="filter-row">'+studioSelect('filterField'+i,'筛选字段',options(fields,f.field))+studioSelect('filterValue'+i,'保留值',options(['',...[...new Set(data.rows.map(r=>String(r[f.field]??'')))]],f.value))+'<button data-drop-filter="'+i+'" aria-label="移除筛选条件">移除</button></div>').join('')+'</div><button id="addFilter">添加筛选条件 ＋</button> <label class="inline"><input id="excludeTotals" type="checkbox" '+(draft.excludeTotals!==false?'checked':'')+'> 排除合计 / 小计行</label><p class="meta">同一横轴标签的多条记录按统计方式聚合；平均比例不等于总体比例。最新值取末行有效值，请核对原表顺序。</p></details>'+
    '<p id="builderError" class="source-warning" role="status" tabindex="-1"></p><div class="studio-actions">'+
    '<button class="primary" id="'+({update:'studioUpdate',append:'studioAppend',replace:'studioShow'})[draft.commitMode]+'">'+({update:'更新所选组',append:'添加到对比',replace:state.basket.length?'替换当前图表':'生成主图'})[draft.commitMode]+'</button>'+
    '<button id="studioCancel">取消预览</button><button class="link" id="checkRegion">核对原表</button><button class="link" id="fixRegion">修正区域</button><span class="meta">'+t.row_count+' 行 · '+fields.length+' 字段 · '+esc(t.range_ref)+'</span></div>';
  root.removeAttribute('aria-busy');
  const refresh=async()=>{draft.previewActive=true;const focused=document.activeElement?.id;await mountBuilder(token);if(focused)document.getElementById(focused)?.focus({preventScroll:true});};
  $('#studioIntent').onchange=e=>{draft.commitMode=e.target.value;refresh();};
  bindChartSources(source,token);
  $('#studioAuto').onclick=()=>{useMapping(inferred);refresh();};
  $('#studioLayout').onchange=e=>{
    draft.readingMode=e.target.value;draft.mappingReason='已手动调整可选指标来源；切换为自动可同时选择行、列指标。';refresh();
  };
  $('#studioDimension')?.addEventListener('change',e=>{draft.dimension=e.target.value;refresh();});
  $('#studioAxisMode').onchange=e=>{draft.axisMode=e.target.value;refresh();};
  const fieldItems=names=>names.map(name=>({value:name,label:name}));
  bindStudioPicker('metricChoices',metricItems,draft.inputKeys,values=>{draft.inputKeys=values;refresh();});
  $('#metricChoicesSearch').setAttribute('aria-label','搜索行名或列名');$('#metricChoicesSearch').placeholder='搜索指标、行名或列名…';
  if(hasRows){
    bindStudioPicker('columnChoices',fieldItems(fields),draft.periods,values=>{draft.periods=fields.filter(f=>values.includes(f));draft.periodGroupId='manual';draft.rangeError='';refresh();});
    const range=document.createElement('div');range.className='column-range studio-fields compact-fields';
    range.innerHTML=studioSelect('studioPeriodGroup','快捷时间范围','<option value="manual" '+(draft.periodGroupId==='manual'?'selected':'')+'>自选时间或分类</option>'+groupOptions)+studioSelect('studioPeriodStart','起列',options(fields,draft.periods[0]))+studioSelect('studioPeriodEnd','止列',options(fields,draft.periods.at(-1)))+'<button id="studioSelectRange">选中此区间</button>';
    $('#columnChoices').before(range);
    $('#studioPeriodGroup').onchange=e=>{const g=groups.find(g=>g.id===e.target.value);draft.periodGroupId=e.target.value;if(g){draft.periods=[...g.columns];draft.periodGrain=g.grain;}draft.rangeError='';refresh();};
    $('#studioSelectRange').onclick=()=>{
      const left=fields.indexOf($('#studioPeriodStart').value),right=fields.indexOf($('#studioPeriodEnd').value);
      if(left<0||right<left){draft.rangeError='止列不能位于起列之前。';draft.previewActive=true;updatePreview();return;}
      draft.periods=fields.slice(left,right+1);draft.rangeError='';draft.periodGroupId='manual';refresh();
    };
  }
  $('#studioRowMode').onchange=e=>{draft.rowMode=e.target.value;draft.seriesFields=[...catalog.rowFields];delete draft.legacyRowSelection;refresh();};
  bindStudioPicker('labelChoices',fieldItems(fields.filter(f=>!draft.periods.includes(f))),catalog.rowFields,values=>{draft.seriesFields=fields.filter(f=>values.includes(f));draft.labelFieldsTouched=true;draft.rowMode='labels';delete draft.legacyRowSelection;refresh();});
  $('#studioSplit')?.addEventListener('change',e=>{draft.splitField=e.target.value;draft.splitValues=[];draft.splitSelectionTouched=false;refresh();});
  hierarchy.levels.forEach((level,i)=>$('#hierarchy'+i).onchange=e=>{draft.hierarchy[level.field]=e.target.value;for(const next of hierarchy.levels.slice(i+1))delete draft.hierarchy[next.field];refresh();});
  $('.hierarchy-disclosure')?.addEventListener('toggle',e=>draft.hierarchyOpen=e.target.open);
  if(hasColumns&&draft.splitField)bindStudioPicker('seriesChoices',[...new Set([...splitCandidates,...draft.splitValues])].map(value=>({value,label:value+(splitCandidates.includes(value)?'':'（当前筛选下不可用）')})),draft.splitValues,values=>{draft.splitValues=values;draft.splitSelectionTouched=true;draft.previewActive=true;updatePreview();});
  $('.builder-more').ontoggle=e=>draft.advancedOpen=e.target.open;
  $('.row-recognition').ontoggle=e=>draft.rowRecognitionOpen=e.target.open;
  $('#studioOperation').onchange=e=>{draft.autoOperation=e.target.value==='__auto__';draft.operation=draft.autoOperation?defaults.operation:e.target.value;refresh();};
  $('#studioAxisOrder').onchange=e=>{draft.axisOrder=e.target.value;refresh();};
  // Capture every keystroke immediately; only the expensive redraw is debounced.
  let labelPreviewTimer;
  $('#studioLabel').oninput=e=>{draft.label=e.target.value;draft.previewActive=true;$('#draftStatus').textContent='未应用 · 正在更新预览';$('#saveView').disabled=true;clearTimeout(labelPreviewTimer);labelPreviewTimer=setTimeout(()=>{if(token===renderToken&&version===builderVersion)updatePreview();},160);};
  $('#studioLabel').onchange=()=>{clearTimeout(labelPreviewTimer);updatePreview();};
  $('#studioNumerator')?.addEventListener('change',e=>{draft.numerator=e.target.value;refresh();});$('#studioDenominator')?.addEventListener('change',e=>{draft.denominator=e.target.value;refresh();});
  draft.filters.forEach((f,i)=>{$('#filterField'+i).onchange=e=>{f.field=e.target.value;f.value='';refresh();};$('#filterValue'+i).onchange=e=>{f.value=e.target.value;refresh();};});
  root.querySelectorAll('[data-drop-filter]').forEach(b=>b.onclick=()=>{draft.filters.splice(+b.dataset.dropFilter,1);refresh();});
  $('#addFilter').onclick=()=>{draft.filters.push({field:fields[0],value:''});draft.advancedOpen=true;refresh();};
  $('#excludeTotals').onchange=e=>{draft.excludeTotals=e.target.checked;refresh();};
  $('#checkRegion').onclick=()=>openOriginal(t.id);$('#fixRegion').onclick=()=>rawDialog(t.id);
  $('#studioCancel').onclick=()=>{delete draft.editUid;draft.previewActive=false;state.chartPreview=null;drawComparison();mountBuilder(token);toast('预览已取消，已应用图表未改动。');};
  const validatedSpecs=()=>{
    if(draft.filters.some(f=>f.field&&!fields.includes(f.field)))throw Error('筛选字段已更新或移除，请在高级设置中重新选择；原筛选尚未删除。');
    const specs=unifiedChartSpecs(draft,t,catalog);if(draft.axisMode==='time')specs.forEach(s=>aggregateRows(data,s));return specs;
  };
  function updatePreview(){
    let specs=[];try{specs=validatedSpecs();$('#builderError').textContent=seriesWarning(specs);}catch(e){$('#builderError').textContent=e.message;}
    $('#mappingSummary').textContent=specs.length?'将生成 '+specs.length+' 条系列'+(specs.length>20?'；系列较多，可用图例隐藏不关注项或缩小筛选范围。':'。'):'';
    $('#mappingPreview').innerHTML=specs.slice(0,3).map(spec=>{const map=aggregateRows(data,spec),keys=spec.axisOrder==='source'?[...map.keys()]:orderedTemporalKeys([map],spec.axisOrder==='time');return '<div><strong>'+esc(spec.label)+'</strong><span>'+keys.slice(0,3).map(key=>esc(key)+' → '+esc(chartValue(map.get(key),percentageSeries(spec)))).join(' · ')+(keys.length>3?' …':'')+(keys.length?'':'暂无符合条件的数值')+'</span></div>';}).join('');
    for(const id of ['studioShow','studioUpdate','studioAppend'])if($('#'+id))$('#'+id).disabled=!specs.length;
    for(const id of ['studioPeriodStart','studioPeriodEnd'])if($('#'+id)){$('#'+id).setAttribute('aria-invalid',String(!!draft.rangeError));$('#'+id).setAttribute('aria-describedby','builderError');}
    if(draft.previewActive){state.chartPreview=[];if(specs.length){try{state.chartPreview=previewChartSeries(state.basket,specs,draft.commitMode,draft.editUid);}catch(e){$('#builderError').textContent=e.message;for(const id of ['studioShow','studioUpdate','studioAppend'])if($('#'+id))$('#'+id).disabled=true;}}drawComparison();}
    $('#draftStatus').textContent=draft.previewActive?'未应用 · 预览与本次操作一致':'正在查看已应用图表';
    $('#chartStage').textContent=state.chartPreview?'草稿预览 · 尚未应用':'已应用 · '+state.basket.length+' 条系列';
    $('#saveView').disabled=!!state.chartPreview;$('#saveView').title=state.chartPreview?'先应用草稿，再保存分析':'保存已应用分析';
    refreshStudioRecommendations(token,specs,t,data).catch(e=>{if(token===renderToken)$('#builderError').textContent='建议图暂不可用：'+e.message;});
  }
  const submit=mode=>{try{const specs=validatedSpecs(),next=commitChartSeries(state.basket,specs,mode,draft.editUid);state.chartUndo=structuredClone(state.basket);state.basket=next;delete draft.editUid;draft.previewActive=false;state.builderOpen=false;state.chartPreview=null;persistBasket();go('compare');toast('已应用 '+specs.length+' 条系列，可撤销');}catch(e){$('#builderError').textContent=e.message;$('#builderError').focus();}};
  $('#studioShow')?.addEventListener('click',()=>submit('replace'));$('#studioUpdate')?.addEventListener('click',()=>submit('update'));$('#studioAppend')?.addEventListener('click',()=>submit('append'));
  updatePreview();
}
async function refreshStudioRecommendations(token,specs,table,data){
  const section=$('#studioRecommendations');if(section){state.charts=state.charts.filter(c=>{if(c.getDom()?.closest('#studioRecommendations')){c.dispose();return false;}return true;});section.remove();}
  if(token!==renderToken||!table||!specs.length)return;
  const cards=[];
  // Suggestions reuse the selected region, filters and exact aggregation. No null points are dropped.
  const base=specs[0],map=aggregateRows(data,base),isTime=chartAxisIsTime(base,[...map.keys()]);
  // The main chart already splits incompatible axes; do not reconnect them in a suggestion.
  if(isTime&&temporalAxisSignature([...map.keys()]).startsWith('mixed:'))return;
  cards.push({title:isTime?'时间趋势':'分类对比',reason:(isTime?'保留全部时间点及缺失值 · ':'按当前维度比较数值 · ')+base.label,spec:base,type:isTime?'line':'bar',map});
  const sameMeasure=new Set(specs.map(s=>[s.businessMetric,s.operation,percentageSeries(s)].join('|'))).size===1;
  const sameAxis=specs.every(s=>s.wide&&s.axisMode!=='category'&&temporalAxisSignature([...aggregateRows(data,s).keys()])===temporalAxisSignature([...map.keys()]));
  if(base.wide&&isTime&&specs.length>1&&sameMeasure&&sameAxis){
    const latest=base.axisOrder==='source'?base.periods.at(-1):orderedTemporalKeys([map]).at(-1),rank=new Map(specs.map(s=>[seriesValueLabel(s.vehicleValue,s),aggregateRows(data,s).get(chartAxisKey(latest,base))??null]));
    cards.push({title:'末期分类排名',reason:latest+' · 比较已选系列，不跨月相加',map:rank,type:'bar'});
  }else if(!isTime&&map.size>1)cards.push({title:'TOP 排名',reason:'同一指标降序，最多显示 8 项',map:new Map([...map].sort((a,b)=>(b[1]??-Infinity)-(a[1]??-Infinity)).slice(0,8)),type:'bar'});
  const shares=cards.at(-1);
  if(shares.type==='bar'&&!percentageSeries(base)&&base.operation==='求和'&&shares.map.size>=2&&shares.map.size<=6&&[...shares.map.values()].every(v=>v!=null&&v>=0)&&[...shares.map.values()].some(v=>v>0))cards.push({title:'所选项数值构成',reason:'仅表示已选项占合计的比重；需确认各项互斥',map:shares.map,type:'pie'});
  const panel=document.createElement('section');panel.id='studioRecommendations';panel.innerHTML='<div class="sectionhead"><h2>本表分析建议</h2><span class="meta">'+esc(table.table_name+' · '+table.range_ref)+'</span></div><div class="recommend-grid">'+cards.map((c,i)=>'<article class="panel"><h3>'+esc(c.title)+'</h3><p class="meta">'+esc(c.reason)+'</p><div class="recommended-chart" id="studioRec'+i+'"></div></article>').join('')+'</div>';$('#main').append(panel);
  cards.forEach((c,i)=>{
    const time=c.type==='line',keys=time&&c.spec?.axisOrder!=='source'?orderedTemporalKeys([c.map],c.spec?.axisOrder==='time'):[...c.map.keys()],value=v=>chartValue(v,percentageSeries(base));
    if(c.type==='pie'){chart($('#studioRec'+i),{tooltip:{trigger:'item'},legend:{type:'scroll',bottom:0},series:[{type:'pie',radius:['25%','58%'],data:[...c.map].map(([name,value])=>({name,value})),label:{formatter:'{b}: {d}%'}}]});return;}
    chart($('#studioRec'+i),{tooltip:{trigger:'axis',confine:true,valueFormatter:value},grid:{left:12,right:12,top:12,bottom:35,containLabel:true},xAxis:{type:time?'category':'value',data:time?keys:undefined,axisLabel:time?{hideOverlap:true}:{formatter:value}},yAxis:{type:time?'value':'category',data:time?undefined:keys,inverse:!time,axisLabel:time?{formatter:value}:{width:85,overflow:'truncate'}},series:[{type:c.type,data:keys.map(k=>c.map.get(k)),connectNulls:false,barMaxWidth:22}]});
  });
}

const columnLetter=n=>{let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;};
function regionBounds(region){
  const match=region?.range_ref?.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if(!match)return null;
  const col=s=>[...s.toUpperCase()].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
  return {left:col(match[1]),top:Number(match[2]),right:col(match[3]),bottom:Number(match[4])};
}
async function inspectRegion(id,token){
  $('#regionInspector')?.remove();
  const panel=document.createElement('section');panel.id='regionInspector';panel.className='region-inspector';
  panel.textContent='正在读取所选区域…';$('#regionTools').after(panel);
  try{
    const t=tableById(id),data=await tableData(id);
    if(token!==renderToken||!panel.isConnected||$('#sourceRegion')?.value!==id)return;
    const fields=t.fields.map(f=>f.name);
    panel.innerHTML=`<div class="sectionhead"><h3>${esc(t.table_name)} · ${esc(t.range_ref)}</h3><button id="closeInspector">收起</button></div><p class="meta">${data.rows.length} 行 · ${fields.length} 个字段${t.issues.length?' · '+esc(t.issues.join('；')):''}</p><div class="toolbar"><label>筛选当前区域<input id="regionFilter" type="search" placeholder="输入内容，筛选匹配行"></label><button id="regionExport">导出当前区域 CSV</button></div><details><summary>查看全部字段</summary><p>${fields.map(f=>`<span class="tag">${esc(f)}</span>`).join(' ')}</p></details><div id="regionMatches"></div>`;
    let filtered=data.rows;
    $('#closeInspector').onclick=()=>panel.remove();
    $('#regionFilter').oninput=e=>{
      const words=e.target.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      filtered=data.rows.filter(r=>words.every(w=>fields.some(f=>String(r[f]??'').toLowerCase().includes(w))));
      $('#regionMatches').innerHTML=words.length?`<p class="meta">匹配 ${filtered.length} 行，预览前 200 行；导出包含全部匹配行。</p>`+grid(filtered.slice(0,200),['_source_row',...fields]):'';
      $('#regionExport').textContent=words.length?'导出筛选结果 CSV':'导出当前区域 CSV';
    };
    $('#regionExport').onclick=()=>exportCSV(filtered,fields,t.table_name+'.csv');
  }catch(e){if(panel.isConnected)panel.textContent='无法读取区域：'+e.message;}
}
async function rawPage(token){
  $('#main').innerHTML=header('DATA / 数据管理','数据管理','选择文件和 Sheet，查看或导出原表。')+'<div class="panel" id="originalBody">正在读取文件列表…</div>';
  if(state.status?.errors?.length)$('#main .pagehead').insertAdjacentHTML('afterend',`<details class="notice"><summary>${state.status.errors.length} 个文件同步异常</summary>${state.status.errors.map(e=>`<p>${esc(e)}</p>`).join('')}</details>`);
  const {files}=await api('workbooks');if(token!==renderToken)return;
  if(!files.length){$('#originalBody').innerHTML='<p>暂无已导入文件。</p>';return;}
  if(original.path){original.id=files.find(f=>f.path.toLowerCase()===original.path.toLowerCase())?.id||'';original.path='';}
  if(!files.some(f=>f.id===original.id)){original.id=files[0].id;original.sheet='';}
  $('#originalBody').innerHTML=`<div class="raw-toolbar"><label>Excel 文件<select id="originalFile">${files.map(f=>`<option value="${f.id}" ${f.id===original.id?'selected':''}>${esc(f.name)}</option>`).join('')}</select></label><button id="originalChart">使用此 Sheet 的数据画图 →</button></div><div class="sheet-tabs" id="sheetTabs" aria-label="工作表"></div><div id="originalGrid">正在读取工作表…</div><div class="pagination"><span id="originalStatus"></span><div><button id="rawLeft">前 30 列</button> <button id="rawRight">后 30 列</button> <button id="rawUp">上 80 行</button> <button id="rawDown">下 80 行</button></div></div><div class="toolbar"><label>跳转至行 <input id="jumpRow" type="number" min="1" value="1" style="width:100px"></label><label>列号 <input id="jumpColumn" type="number" min="1" value="1" style="width:100px"></label><button id="rawJump">跳转</button></div><p class="meta">展示单元格内容及合并布局，不渲染 Excel 内嵌图表、图片和完整样式。公式显示文件上次保存的计算结果。</p>`;
  let loadVersion=0;
  const load=async()=>{const version=++loadVersion;$('#originalGrid').textContent='正在读取工作表…';try{
    const selected=tableById(original.regionId),filePath=files.find(f=>f.id===original.id)?.path;
    let bounds=selected&&selected.file_path.toLowerCase()===filePath?.toLowerCase()&&selected.sheet_name===original.sheet?regionBounds(selected):null;
    if(bounds){original.start=Math.max(bounds.top,Math.min(bounds.bottom,original.start));original.column=Math.max(bounds.left,Math.min(bounds.right,original.column));}
    const raw=await api('sheet?'+new URLSearchParams({id:original.id,...(original.sheet?{sheet:original.sheet}:{}),start:original.start,column:original.column}));
    if(token!==renderToken||version!==loadVersion)return;
    if(raw.missing_sheet){bounds=null;original.regionId='';}
    let sourceWarning=$('#originalSourceWarning');
    if(!sourceWarning){sourceWarning=document.createElement('p');sourceWarning.id='originalSourceWarning';sourceWarning.className='source-warning';sourceWarning.setAttribute('role','status');$('#sheetTabs').before(sourceWarning);}
    sourceWarning.textContent=raw.warning||'';sourceWarning.hidden=!raw.warning;
    if(bounds)raw.rows=raw.rows.slice(0,bounds.bottom-raw.start+1).map(row=>row.slice(0,bounds.right-raw.column+1));
    Object.assign(original,{sheet:raw.sheet,start:raw.start,column:raw.column});
    state.file=files.find(f=>f.id===original.id)?.path||'';
    const regions=activeTables().filter(t=>t.file_path.toLowerCase()===state.file.toLowerCase()&&t.sheet_name===raw.sheet);
    let regionTools=$('#regionTools');
    if(!regionTools){regionTools=document.createElement('div');regionTools.id='regionTools';regionTools.className='toolbar';$('#sheetTabs').after(regionTools);}
    regionTools.innerHTML=regions.length?`<label>此 Sheet 已识别区域 <select id="sourceRegion"><option value="">整个 Sheet（原始表格）</option>${regions.map(t=>`<option value="${t.id}">${esc(t.table_name+' · '+t.range_ref)}</option>`).join('')}</select></label><button id="regionPreview">字段、筛选与导出</button><button id="regionCorrect">修正识别</button>`:'<p class="meta">此 Sheet 暂无已识别数据，仍可完整浏览原表。</p>';
    if(regions.length){
      if(regions.some(t=>t.id===original.regionId))$('#sourceRegion').value=original.regionId;
      original.regionId=$('#sourceRegion').value;
      $('#sourceRegion').onchange=()=>{original.regionId=$('#sourceRegion').value;original.start=original.column=1;$('#regionInspector')?.remove();load();};
      $('#regionPreview').disabled=$('#regionCorrect').disabled=!original.regionId;
    }
    $('#regionInspector')?.remove();
    $('#regionPreview')?.addEventListener('click',()=>inspectRegion($('#sourceRegion').value,token));
    $('#regionCorrect')?.addEventListener('click',()=>rawDialog($('#sourceRegion').value));
    $('#originalChart').disabled=!regions.length;
    $('#sheetTabs').innerHTML=raw.sheets.map(s=>`<button class="${s===raw.sheet?'selected':''}" data-sheet="${esc(s)}">${esc(s)}</button>`).join('');
    $('#sheetTabs').querySelectorAll('button').forEach(b=>b.onclick=()=>{original.sheet=b.dataset.sheet;original.regionId='';original.start=original.column=1;load();});
    const endRow=raw.start+raw.rows.length-1,endCol=raw.column+(raw.rows[0]?.length||1)-1;
    $('#originalGrid').innerHTML='<div class="tablewrap raw-grid"><table><thead><tr><th>行 / 列</th>'+Array.from({length:endCol-raw.column+1},(_,i)=>'<th>'+columnLetter(raw.column+i)+'</th>').join('')+'</tr></thead><tbody>'+raw.rows.map((row,i)=>{const r=raw.start+i;return '<tr><th>'+r+'</th>'+row.map((v,j)=>{const c=raw.column+j;const merge=raw.merges.find(([l,t,rr,b])=>c>=l&&c<=rr&&r>=t&&r<=b);if(merge){const [l,t,rr,b]=merge;if(r!==Math.max(t,raw.start)||c!==Math.max(l,raw.column))return '';return `<td rowspan="${Math.min(b,endRow)-r+1}" colspan="${Math.min(rr,endCol)-c+1}">${esc(v??'')}</td>`;}return '<td>'+esc(v??'')+'</td>';}).join('')+'</tr>';}).join('')+'</tbody></table></div>';
    $('#originalStatus').textContent=`${raw.sheet} · ${bounds?selected.table_name+' · '+selected.range_ref+' · 共 '+(bounds.bottom-bounds.top+1)+' 行 × '+(bounds.right-bounds.left+1)+' 列':'整个 Sheet · 共 '+raw.max_row+' 行 × '+raw.max_col+' 列'} · 当前 ${raw.start}–${endRow} 行 / ${columnLetter(raw.column)}–${columnLetter(endCol)} 列`;
    $('#jumpRow').value=raw.start;$('#jumpColumn').value=raw.column;
    for(const [id,key,delta,disabled] of [['rawLeft','column',-30,raw.column<=(bounds?.left||1)],['rawRight','column',30,endCol>=(bounds?.right||raw.max_col)],['rawUp','start',-80,raw.start<=(bounds?.top||1)],['rawDown','start',80,endRow>=(bounds?.bottom||raw.max_row)]]){const b=$('#'+id);b.disabled=disabled;b.onclick=()=>{original[key]=Math.max(1,original[key]+delta);load();};}
  }catch(e){if(token===renderToken&&version===loadVersion){$('#originalGrid').textContent='无法读取：'+e.message;$('#sheetTabs').innerHTML='';$('#regionTools')?.remove();$('#regionInspector')?.remove();$('#originalSourceWarning')?.remove();$('#originalChart').disabled=true;for(const id of ['rawLeft','rawRight','rawUp','rawDown'])$('#'+id).disabled=true;$('#originalStatus').textContent='读取失败，请重试或重新选择文件';}}};
  $('#originalFile').onchange=e=>{original.id=e.target.value;original.sheet='';original.regionId='';original.start=original.column=1;load();};
  $('#rawJump').onclick=()=>{original.start=Number($('#jumpRow').value)||1;original.column=Number($('#jumpColumn').value)||1;load();};
  $('#originalChart').onclick=()=>{const id=$('#sourceRegion')?.value||$('#sourceRegion option[value]:not([value=""])')?.value;if(id)configureChart(id);};
  await load();
}
window.addEventListener('hashchange',()=>{const page=location.hash.slice(1);if(['home','raw','compare','explore','saved','health'].includes(page)&&state.page!==page)go(page);});
