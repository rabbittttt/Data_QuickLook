'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync('web/app.js','utf8');
const elements=new Map(),tables=new Map();
const state={basket:[],charts:[],cache:new Map(),chartType:'bar',limit:'全部',baseline:true};
let rendered,exported;
const c=vm.createContext({state,structuredClone,colors:['green','blue'],chartGrid:'#e5e7ed',tableById:id=>tables.get(id),
  $:id=>{if(!elements.has(id))elements.set(id,{style:{}});return elements.get(id);},
  grid:rows=>JSON.stringify(rows),exportCSV:rows=>{exported=rows;},chart:(_element,option)=>{rendered=option;}});
vm.runInContext(fs.readFileSync('web/chart-logic.js','utf8')+'\n'+
  app.slice(app.indexOf('const num='),app.indexOf('const fmt='))+
  app.slice(app.indexOf('function aggregateRows'),app.indexOf('async function home'))+
  app.slice(app.indexOf('function drawComparison'),app.indexOf('function views')),c);
const spec=(id,rows,settings)=>{tables.set(id,{id});state.cache.set(id,{rows});return {id,label:id,metric:'销量',businessMetric:'销量',operation:'求和',axisMode:'category',...settings};};
const draw=(...series)=>{state.basket=series;c.drawComparison();};

// Concrete category dimensions take precedence over coincidentally equal labels.
const projects=spec('projects',[{项目:'A',销量:10},{项目:'B',销量:20}],{dimension:'项目'});
const channels=spec('channels',[{渠道:'A',销量:30},{渠道:'B',销量:40}],{dimension:'渠道'});
draw(projects,channels);
assert.equal(Array.isArray(rendered.xAxis),true);
assert.deepEqual(Array.from(rendered.xAxis[0].data),['A','B']);
assert.deepEqual(Array.from(rendered.xAxis[1].data),['A','B']);
assert.match(elements.get('#recommendNote').textContent,/分类横轴.*强制独立分面/);
assert.equal(elements.get('#baseline').disabled,true);
assert.doesNotMatch(elements.get('#compareGrid').innerHTML,/差值|变化率/);
elements.get('#exportCompare').onclick();
assert.equal(exported.length,4);
assert.deepEqual(Object.keys(exported[0]),['系列','对比项','数值']);
state.axisSwapped=true;c.drawComparison();
assert.deepEqual(Array.from(rendered.yAxis[1].data),['A','B']);
assert.deepEqual(Array.from(rendered.series[1].data[0]),[30,'A']);
state.axisSwapped=false;

// Different files and label subsets may share a genuine category dimension.
const models=spec('models',[{车型:'M8',销量:10},{车型:'M9',销量:20}],{dimension:'车型'});
const otherModels=spec('otherModels',[{车型名称:'M9',销量:30},{车型名称:'M7',销量:40}],{dimension:'车型名称'});
draw(models,otherModels);
assert.equal(Array.isArray(rendered.xAxis),false);
assert.deepEqual(Array.from(rendered.xAxis.data),['M8','M9','M7']);
assert.equal(elements.get('#baseline').disabled,false);
assert.match(elements.get('#compareGrid').innerHTML,/差值/);
assert.equal(c.categoryAxesCompatible({...models,id:'one'},['M8'],{...channels,id:'one'},['M8']),false,'same source ID does not prove axis compatibility');

// Header axes can match record axes using actual labels rather than wide alone.
const modelHeaders=spec('modelHeaders',[{指标:'销量',M8:15,M9:25}],{wide:true,dimension:'指标',periods:['M8','M9']});
draw(models,modelHeaders);
assert.equal(Array.isArray(rendered.xAxis),false);
assert.deepEqual(Array.from(rendered.series[1].data),[15,25]);
assert.equal(elements.get('#baseline').disabled,false);
const regionHeaders=spec('regionHeaders',[{指标:'销量',华东:15,华南:25}],{wide:true,dimension:'指标',periods:['华东','华南']});
draw(models,regionHeaders);
assert.equal(Array.isArray(rendered.xAxis),true);
assert.deepEqual(Array.from(rendered.xAxis[1].data),['华东','华南']);
assert.equal(elements.get('#baseline').disabled,true);
assert.equal(c.categoryAxesCompatible({wide:true},['A','B'],{dimension:'型号'},['A','B']),false,'generic codes alone do not prove mixed-direction compatibility');
assert.equal(c.categoryAxesCompatible({wide:true},['M8'],{dimension:'车型'},['M8']),false,'a single shared category is insufficient evidence');
assert.equal(c.categoryAxesCompatible({wide:true},['M8','M9'],{wide:true},['M9','M7']),true,'shared literal headers remain comparable');
assert.equal(c.categoryAxesCompatible({wide:true},['M8','M9'],{wide:true},['华东','华南']),false);

// A time axis stays comparable across both reading directions and source names.
const dates=spec('dates',[{月份:'2026-01',销量:10},{月份:'2026-02',销量:20}],{dimension:'月份',axisMode:'auto'});
const dateHeaders=spec('dateHeaders',[{'2026年1月':15,'2026年2月':25}],{wide:true,dimension:'项目',periods:['2026年1月','2026年2月'],axisMode:'auto'});
draw(dates,dateHeaders);
assert.equal(Array.isArray(rendered.xAxis),false);
assert.deepEqual(Array.from(rendered.xAxis.data),['2026-01','2026-02']);
assert.equal(elements.get('#baseline').disabled,false);
assert.match(elements.get('#compareGrid').innerHTML,/差值/);
console.log('Mixed category axes, independent values and transposed time alignment: checks passed');
