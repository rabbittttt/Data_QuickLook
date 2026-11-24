'use strict';
function isTimeField(name){return /日期|月份|时间|年月|周序号|周次|星期|年度|年份|季度|^年$|^月$|\b(date|time|month|year|week|quarter)\b/i.test(name);}
function isRatioField(name){return /率|占比|比例|%/.test(name);}
function isTotalLabel(value){return /^(合计|总计|汇总|小计)$/.test(String(value??'').trim());}
function periodHeaderParts(name){
  let time=String(name??'').trim(),match;const qualifiers=[];
  while((match=time.match(/\s*[（(]([^（）()]*)[）)]\s*$/))){qualifiers.unshift(match[1].trim().replace(/\s+/g,' ').toLowerCase());time=time.slice(0,match.index).trim();}
  return {time,qualifier:qualifiers.filter(Boolean).join(' / ')};
}
function expandedPeriodYear(value){return String(value).length===2?`${Number(value)>=70?'19':'20'}${value}`:String(value);}
function normalizeTimeHeader(name){return periodHeaderParts(name).time.replace(/年\s*/g,'年').replace(/月份/g,'月').replace(/^((?:1[3-9]|[2-9]\d))[-/.年](0?[1-9]|1[0-2])月?$/,(_,y,m)=>`${expandedPeriodYear(y)}-${m}`).replace(/^(\d{4})年(\d{1,2})$/,'$1年$2月').replace(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})T00:00:00(?:\.000)?(?:Z)?$/,'$1-$2-$3').replace(/^(\d{4})(\d{2})(\d{2})$/,'$1-$2-$3').replace(/^(\d{4})年?第?([1-4])季度$/,'$1Q$2').replace(/^(?:第)?(\d+)天$/,'D$1');}
function canonicalPeriodLabel(value){
  const s=normalizeTimeHeader(value);let m;
  if((m=s.match(/^(?:(\d{2}|(?:19|20)\d{2})(?:年|[-/.])?)?(?:WK|W|第)\s*(0?[1-9]|[1-4]\d|5[0-3])周?$/i)))return `${m[1]?expandedPeriodYear(m[1])+'-':''}WK${Number(m[2])}`;
  if((m=s.match(/^D(\d+)$/i)))return `D${Number(m[1])}`;
  if((m=s.match(/^((?:19|20)\d{2})年(\d{1,2})月(\d{1,2})日$/)))return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  if((m=s.match(/^((?:19|20)\d{2})年(\d{1,2})月$/)))return `${m[1]}-${m[2].padStart(2,'0')}`;
  if((m=s.match(/^((?:19|20)\d{2})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:\s+00:00:00)?$/)))return `${m[1]}-${m[2].padStart(2,'0')}${m[3]?'-'+m[3].padStart(2,'0'):''}`;
  if((m=s.match(/^(0?[1-9]|1[0-2])(?:月|[-/.])(0?[1-9]|[12]\d|3[01])日?$/)))return `${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  if((m=s.match(/^(0?[1-9]|1[0-2])月$/)))return `${Number(m[1])}月`;
  if((m=s.match(/^((?:19|20)\d{2})-?Q([1-4])$/i)))return `${m[1]}-Q${m[2]}`;
  if((m=s.match(/^Q([1-4])$/i)))return `Q${m[1]}`;
  if((m=s.match(/^((?:19|20)\d{2})年?$/)))return m[1];
  return String(value??'').trim();
}
function periodAxisType(value){
  const s=canonicalPeriodLabel(value);
  if(/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(s))return 'time:day:absolute';
  if(/^(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(s))return 'time:day:cyclic';
  if(/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/.test(s))return 'time:month:absolute';
  if(/^(?:[1-9]|1[0-2])月$/.test(s))return 'time:month:cyclic';
  if(/^(?:19|20)\d{2}-WK(?:[1-9]|[1-4]\d|5[0-3])$/.test(s))return 'time:week:absolute';
  if(/^WK(?:[1-9]|[1-4]\d|5[0-3])$/.test(s))return 'time:week:cyclic';
  if(/^(?:19|20)\d{2}-Q[1-4]$/.test(s))return 'time:quarter:absolute';
  if(/^Q[1-4]$/.test(s))return 'time:quarter:cyclic';
  if(/^(?:19|20)\d{2}$/.test(s))return 'time:year:absolute';
  if(/^D\d+$/.test(s))return 'time:day-index:relative';
  return 'category';
}
function isPeriodColumn(name){return periodAxisType(name)!=='category';}
function periodGrain(name){return periodAxisType(name).split(':')[1]||'custom';}
function periodColumns(table){
  return periodColumnGroups(table)[0]?.columns||[];
}
function periodColumnGroups(table){
  const groups=new Map();
  (table?.fields||[]).forEach((field,index)=>{
    if(!isPeriodColumn(field.name))return;
    const grain=periodGrain(field.name),qualifier=periodHeaderParts(field.name).qualifier,id=qualifier?`${grain}|${qualifier}`:grain;
    if(!groups.has(id))groups.set(id,{id,grain,qualifier,columns:[],index});
    groups.get(id).columns.push(field.name);
  });
  return [...groups.values()].sort((a,b)=>b.columns.length-a.columns.length||a.index-b.index);
}
function periodGrainLabel(grain){return ({year:'年度',month:'月度',day:'日期',week:'周度',quarter:'季度','day-index':'日序号'})[grain]||'时间';}
function temporalAxisSignature(keys){const types=[...new Set(Array.from(keys||[],periodAxisType))].sort();return types.length===0?'empty':types.length===1?types[0]:`mixed:${types.join('|')}`;}
function periodSelectionError(periods,{minPeriods=2}={}){
  if(!Array.isArray(periods)||periods.length<minPeriods)return `请选择至少 ${minPeriods} 个时间列`;
  if(new Set(periods).size!==periods.length)return '时间列重复，请检查选择范围';
  const known=periods.filter(isPeriodColumn);
  if(new Set(known.map(canonicalPeriodLabel)).size!==known.length)return '同一时间包含多个数据列，请将实际、预测等口径拆成独立系列';
  if(new Set(known.map(p=>periodHeaderParts(p).qualifier)).size>1)return '时间列含有不同业务口径，请将实际、预测等分别生成系列';
  if(temporalAxisSignature(known).startsWith('mixed:'))return '时间列的粒度或年份范围不同，请分别选择同一种时间序列';
  return '';
}
function temporalSortValue(value){const s=canonicalPeriodLabel(value);let m;if((m=s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/)))return Number(m[1])*10000+Number(m[2])*100+Number(m[3]||0);if((m=s.match(/^(\d{4})-Q([1-4])$/)))return Number(m[1])*10+Number(m[2]);if((m=s.match(/^(?:(\d{4})-)?WK(\d+)$/i)))return Number(m[1]||0)*100+Number(m[2]);if((m=s.match(/^(\d{2})-(\d{2})$/)))return Number(m[1])*100+Number(m[2]);if((m=s.match(/^D(\d+)$/)))return Number(m[1]);if((m=s.match(/^Q([1-4])$/)))return Number(m[1]);if(/^(19|20)\d{2}$/.test(s))return Number(s);return null;}
function orderedTemporalKeys(groups,forceCalendarOrder=false){
  const keys=[...new Set(groups.flatMap(g=>[...g.keys()]))];
  const sortValue=value=>{const label=canonicalPeriodLabel(value);return forceCalendarOrder&&/^(?:[1-9]|1[0-2])月$/.test(label)?Number.parseInt(label,10):temporalSortValue(value);};
  return temporalAxisSignature(keys).startsWith('time:')&&keys.every(k=>sortValue(k)!==null)?keys.sort((a,b)=>sortValue(a)-sortValue(b)):keys;
}
function chartOperation(field,table){
  if(!field||field.type!=='number'||/编码|序号|\bID\b/i.test(field.name))return '非空计数';
  if(isPeriodColumn(field.name)&&/排名|占比|比例|转化率/.test(table?.table_name||''))return '平均值';
  if(/累计/.test(field.name))return '最新值';
  if(isRatioField(field.name)||/排名|价格|单价|平均|天数|时长|周期/.test(field.name))return '平均值';
  return '求和';
}
function rowLabelFields(table,periods=periodColumns(table)){
  const first=table.fields.findIndex(f=>periods.includes(f.name));
  return table.fields.filter((f,i)=>!periods.includes(f.name)&&!isPeriodColumn(f.name)&&!isTotalLabel(f.name)&&(i<first||f.type==='text')).map(f=>f.name);
}
function mappingRowLabelFields(table,columns=[]){
  return (table?.fields||[]).filter(f=>!columns.includes(f.name)&&!isPeriodColumn(f.name)&&!isTotalLabel(f.name)&&(f.type!=='number'||/编码|序号|\bID\b/i.test(f.name))).map(f=>f.name);
}
function seriesRowValue(row,series,index){
  if(series.vehicleField==='__row_index__')return String(index+1);
  return series.vehicleField==='__row_labels__'?JSON.stringify((series.seriesFields||[]).map(f=>row[f]??null)):String(row[series.vehicleField]??'');
}
function seriesValueLabel(value,series){if(series.vehicleField==='__row_index__')return `数据第 ${value} 行`;if(series.vehicleField!=='__row_labels__')return value;try{return JSON.parse(value).map((v,i)=>`${series.seriesFields[i]}：${v??'（空）'}`).join(' / ');}catch{return value;}}
function contextualPeriodLabel(value,series={}){
  const label=String(value??'').trim();
  return !series.wide&&/^(月份|月|month)$/i.test(String(series.dimension||'').trim())&&/^(?:0?[1-9]|1[0-2])$/.test(label)?`${Number(label)}月`:label;
}
function chartAxisKey(value,series={}){
  const label=String(value??'').trim();
  if(!label)return null;
  if(series.axisMode==='category')return label;
  const period=contextualPeriodLabel(value,series);
  if(series.axisMode==='time'&&!isPeriodColumn(period))throw Error(`时间横轴包含无法识别的值“${label.slice(0,60)}”，请检查数据或切换为分类横轴。`);
  if(series.axisMode!=='time'&&!series.wide&&!isTimeField(series.dimension||'')&&/^\d+$/.test(label))return label;
  return canonicalPeriodLabel(period);
}
function chartAxisIsTime(series={},keys=[]){
  if(series.axisMode==='category')return false;
  if(series.axisMode==='time')return true;
  const values=Array.from(keys).filter(v=>v!=null&&String(v).trim()!=='');
  // Bare numeric identifiers alone are not evidence of a vertical time axis.
  return values.some(value=>{const label=contextualPeriodLabel(value,series);return isPeriodColumn(label)&&(series.wide||isTimeField(series.dimension||'')||!/^\d+$/.test(label));});
}
function categoryAxisDimension(name=''){
  const key=String(name).trim().toLowerCase().replace(/\s+/g,'');
  const aliases=[['车型','车型名称','车辆型号','model'],['车系','车系名称'],['版本','版本名称','version'],['区域','地区','region'],['门店','门店名称','store'],['渠道','渠道名称','channel']];
  return aliases.find(group=>group.includes(key))?.[0]||key;
}
function categoryAxesCompatible(left,leftKeys,right,rightKeys){
  // A matrix's dimension identifies its rows, not its column-header axis.
  if(!left.wide&&!right.wide){
    const dimension=categoryAxisDimension(left.dimension);
    return !!dimension&&dimension===categoryAxisDimension(right.dimension);
  }
  const labels=keys=>[...new Set(Array.from(keys,String).map(value=>value.trim()).filter(value=>value&&!isTotalLabel(value)))];
  const a=labels(leftKeys),b=labels(rightKeys);
  if(!a.length||!b.length)return false;
  const shared=a.filter(value=>b.includes(value));
  // Both header axes refer to actual field names; overlapping fields can align.
  if(left.wide&&right.wide)return shared.length>0;
  // Across reading directions, require evidence from multiple literal categories.
  // A single common value or generic codes such as 0/1 and A/B are ambiguous.
  const meaningful=value=>!/^(?:[+-]?\d+(?:\.\d+)?|[a-z]|是|否|其他|其它|未知|未填写)$/i.test(value);
  return shared.filter(meaningful).length>=2&&shared.length===Math.min(a.length,b.length);
}
function inferChartMapping(table,rows=[],requestedMetric=''){
  const fields=table?.fields||[],defaults=chartDefaults({...(table||{}),fields});
  const nonempty=value=>value!=null&&String(value).trim()!==''&&!isTotalLabel(value);
  const dateFields=fields.map((field,index)=>{
    const values=rows.map(row=>row[field.name]).filter(nonempty).slice(0,200);
    const recognized=values.filter(value=>{
      const label=contextualPeriodLabel(value,{dimension:field.name});
      if(!isPeriodColumn(label))return false;
      if(/^\d+$/.test(label))return isTimeField(field.name)&&/^(?:19|20)\d{2}$/.test(label);
      return true;
    });
    const ratio=values.length?recognized.length/values.length:0;
    return {field,index,score:ratio>=.8?ratio*10+Number(field.type==='date')+Number(isTimeField(field.name)):0};
  }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score||a.index-b.index);
  const group=periodColumnGroups(table).filter(g=>g.columns.length>=2).find(g=>g.columns.includes(requestedMetric))||periodColumnGroups(table).find(g=>g.columns.length>=2);
  if(!dateFields.length&&group){
    return {wide:true,dimension:'日期',metrics:[group.columns[0]],periods:[...group.columns],seriesFields:mappingRowLabelFields(table,group.columns),axisMode:'auto',reason:`发现 ${group.columns.length} 个同口径${periodGrainLabel(group.grain)}表头，建议横轴读取列标题。`};
  }
  const dimension=dateFields[0]?.field.name||defaults.dimension;
  const numeric=fields.filter(f=>f.name!==dimension&&f.type==='number'&&!/编码|序号|\bID\b/i.test(f.name));
  const preferred=fields.find(f=>f.name===requestedMetric&&f.name!==dimension)||numeric.find(f=>f.name===defaults.metric)||numeric[0]||fields.find(f=>f.name!==dimension);
  return {wide:false,dimension,metrics:preferred?[preferred.name]:[],periods:[],seriesFields:[],axisMode:'auto',reason:dateFields.length?`“${dimension}”的单元格包含日期，建议横轴读取这一列的值。`:'建议按记录读取：用一列作为横轴，另选数值列；也可切换为读取列标题。'};
}
function wideBusinessMetric(table,seriesField='',seriesValue='',seriesFields=[]){
  if(seriesField==='__row_labels__'&&seriesValue){try{const values=JSON.parse(seriesValue);const names=seriesFields.map((f,i)=>/指标|项目|统计项|统计类型|单位/.test(f)?values[i]:null).filter(v=>v!=null&&v!=='');if(names.length)return names.join(' · ');}catch{}}
  return /指标|项目|统计项/.test(seriesField)&&seriesValue?seriesValue:(table?.table_name||'数值');
}
function wideOperation(table,seriesField='',seriesValue='',seriesFields=[]){return chartOperation({name:wideBusinessMetric(table,seriesField,seriesValue,seriesFields),type:'number'},table);}
function chartDefaults(table){
  const fields=table.fields;
  const numeric=fields.filter(f=>f.type==='number'&&!/编码|序号|日期|年份|小时|排名/.test(f.name));
  const metric=numeric.find(f=>/净大定|销量|订单量|交付|销售额/.test(f.name))||numeric[0]||fields[0];
  const dimension=fields.find(f=>isTimeField(f.name)&&f.name!==metric?.name)||fields.find(f=>f.type!=='number'&&f.name!==metric?.name)||fields.find(f=>f.name!==metric?.name)||fields[0];
  return {metric:metric?.name||'',dimension:dimension?.name||'',operation:chartOperation(metric,table),vehicleField:fields.find(f=>/^(车型|车系|车辆型号|产品型号)$/.test(f.name))?.name||'',vehicleValue:''};
}
function seriesWarning(series){
  const notes=[];
  const metric=s=>s.businessMetric||s.metric;
  if(series.some(s=>isRatioField(metric(s))&&s.operation==='求和'))notes.push('比例不宜求和，请核对统计口径');
  if(series.some(s=>s.operation==='平均值'&&isRatioField(metric(s))))notes.push('比例为算术平均，不等于总体转化率');
  if(series.some(s=>/累计/.test(metric(s))))notes.push('累计指标默认取最后一条有效值，请核对原表顺序');
  if(series.some(s=>s.dimension===s.metric))notes.push('横轴与指标相同，请确认是否需要数值分布');
  if(new Set(series.map(s=>s.dimension)).size>1)notes.push('横轴名称不同，请核对类别含义；不兼容时独立展示');
  if(new Set(series.map(s=>metric(s)+'|'+s.operation)).size>1)notes.push('指标或统计方式不同，推荐独立分面，避免误读单位');
  return notes.join('；');
}
function percentageSeries(s){return s.operation==='总体比例'||isRatioField(s.businessMetric||s.metric)&&!['非空计数','有效数值计数'].includes(s.operation);}
function chartValue(value,percentage){return value==null?'—':percentage?(Number(value)*100).toLocaleString('zh-CN',{maximumFractionDigits:2})+'%':Number(value).toLocaleString('zh-CN',{maximumFractionDigits:3});}
