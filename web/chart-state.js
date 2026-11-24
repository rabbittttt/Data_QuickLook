'use strict';
function chartUid(){return 'series-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);}
function normalizeSeriesIds(basket){const used=new Set();for(const s of basket){if(!s.uid||used.has(String(s.uid)))s.uid=chartUid();used.add(String(s.uid));}return basket;}
function previewChartSeries(basket,incoming,mode,editUid){
  if(!incoming.length)throw Error('请至少选择一个展示系列。');
  if(!['replace','append','update'].includes(mode))throw Error('请选择有效的应用方式。');
  const result=JSON.parse(JSON.stringify(basket)),next=JSON.parse(JSON.stringify(incoming));
  if(mode==='replace')return next;
  if(mode==='append')return result.concat(next);
  const index=result.findIndex(s=>String(s.uid)===String(editUid));
  if(index<0)throw Error('正在编辑的系列已被移除，请重新选择。');
  next[0].uid=result[index].uid;
  result.splice(index,1,...next);
  return result;
}
function commitChartSeries(basket,incoming,mode,editUid){
  if(!incoming.length)throw Error('请至少选择一个展示系列。');
  if(!['replace','append','update'].includes(mode))throw Error('请选择有效的应用方式。');
  const result=basket.map(s=>({...s}));
  if(mode==='update'){
    const index=result.findIndex(s=>String(s.uid)===String(editUid));
    if(index<0)throw Error('正在编辑的系列已被移除，请重新选择。');
    result.splice(index,1,...incoming.map((s,i)=>({...s,uid:i?chartUid():result[index].uid})));
  }else if(mode==='replace')return normalizeSeriesIds(incoming.map(s=>({...s,uid:chartUid()})));
  else result.push(...incoming.map(s=>({...s,uid:chartUid()})));
  return result;
}
function hierarchyChoices(rows,fields,chosen={}){
  let filtered=rows;const levels=[];
  for(const field of fields){
    const values=[...new Set(filtered.map(r=>String(r[field]??'')))];
    const value=values.includes(chosen[field])?chosen[field]:'';
    levels.push({field,values,value});
    if(value)filtered=filtered.filter(r=>String(r[field]??'')===value);
  }
  return {levels,rows:filtered};
}
function draftSeriesSpecs(draft,table){
  const fields=table.fields.map(f=>f.name);
  if(draft.rangeError)throw Error(draft.rangeError);
  if(draft.wide&&draft.operation==='总体比例')throw Error('总体比例仅适用于普通字段模式，请切换横轴或统计方式。');
  const periods=draft.periods||[];
  if(draft.wide){
    if(periods.some(p=>!fields.includes(p)))throw Error('时间列已更新，请重新选择有效时间范围。');
    const minimum=draft.axisMode?1:2;
    if(periods.length<minimum)throw Error(`请选择至少 ${minimum} 个横轴数据列。`);
    if(new Set(periods).size!==periods.length)throw Error('横轴数据列重复，请重新选择。');
    if(draft.axisMode!=='category'){const error=periodSelectionError(periods,{minPeriods:minimum});if(error)throw Error(error);}
  }
  const selectedMetrics=draft.wide?[draft.metric||periods[0]]:[...new Set(Array.isArray(draft.metrics)?draft.metrics:[draft.metric])];
  if(!draft.wide&&(!fields.includes(draft.dimension)||(draft.operation!=='总体比例'&&(!selectedMetrics.length||selectedMetrics.some(m=>!fields.includes(m))))))throw Error('请选择有效的横轴与数值指标。');
  if(draft.vehicleField&&!['__row_labels__','__row_index__'].includes(draft.vehicleField)&&!fields.includes(draft.vehicleField))throw Error('系列拆分字段已更新，请重新选择。');
  if(draft.vehicleField==='__row_labels__'&&(!(draft.seriesFields||[]).length||draft.seriesFields.some(f=>!fields.includes(f))))throw Error('请选择有效的行标签字段。');
  const missingFilter=(draft.filters||[]).find(f=>f.field&&!fields.includes(f.field));
  if(missingFilter)throw Error(`筛选字段“${missingFilter.field}”已不存在，请重新选择或明确移除此条件。`);
  if(draft.operation==='总体比例'&&(!fields.includes(draft.numerator)||!fields.includes(draft.denominator)))throw Error('总体比例需要选择分子和分母字段。');
  if(draft.operation==='总体比例'&&[draft.numerator,draft.denominator].some(name=>table.fields.find(f=>f.name===name)?.type!=='number'))throw Error('总体比例的分子和分母必须是数值字段。');
  const values=draft.vehicleField?draft.selectedValues||[]:[''];
  if(!values.length)throw Error('请至少勾选一个展示系列。');
  const metrics=draft.operation==='总体比例'?[draft.numerator]:selectedMetrics;
  return metrics.flatMap(metric=>values.map(value=>{
    const businessMetric=draft.operation==='总体比例'?`${draft.numerator} / ${draft.denominator}`:draft.wide?wideBusinessMetric(table,draft.vehicleField,value,draft.seriesFields):metric;
    const operation=draft.operation==='总体比例'?'总体比例':draft.autoOperation?(draft.wide?wideOperation(table,draft.vehicleField,value,draft.seriesFields):chartOperation(table.fields.find(f=>f.name===metric),table)):draft.operation;
    const baseLabel=(seriesValueLabel(value,draft)||table.sheet_name)+' · '+businessMetric+(draft.wide&&periodColumnGroups(table).find(g=>g.id===draft.periodGroupId)?.qualifier?' · '+periodColumnGroups(table).find(g=>g.id===draft.periodGroupId).qualifier:'');
    return {id:table.id,metric,dimension:draft.dimension,businessMetric,operation,
      vehicleField:draft.vehicleField||'',vehicleValue:value,seriesFields:[...(draft.seriesFields||[])],
      filters:(draft.filters||[]).filter(f=>f.field&&f.value!=='').map(f=>({...f})),filterField:'',filterValue:'',
      excludeTotals:draft.excludeTotals!==false,wide:!!draft.wide,periods:[...periods],periodGrain:draft.periodGrain,periodGroupId:draft.periodGroupId,axisMode:draft.axisMode,axisOrder:draft.axisOrder,
      numerator:draft.numerator,denominator:draft.denominator,
      customLabel:!!draft.label,
      label:draft.label?(values.length*metrics.length===1?draft.label:draft.label+' · '+baseLabel):baseLabel};
  }));
}
