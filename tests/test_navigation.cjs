const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const app=fs.readFileSync('web/app.js','utf8'),studio=fs.readFileSync('web/studio.js','utf8');
const calls=[];
const context=vm.createContext({state:{},location:{},renderToken:1,document:{querySelectorAll:()=>[]},
  $:()=>({querySelectorAll:()=>[],setAttribute:()=>{},focus:()=>{}}),render:async()=>{},toast:()=>{},
  rawPage:async()=>calls.push('raw'),health:()=>calls.push('health'),renderCatalog:()=>calls.push('catalog')});
vm.runInContext(app.slice(app.indexOf('function go('),app.indexOf('async function render(')),context);
vm.runInContext(studio.slice(studio.indexOf('async function dataPage('),studio.indexOf('async function chartStudio('))+'\nfunction decorateDataPage(){ }',context);
(async()=>{
  for(const route of ['raw','health']){context.go(route);assert.equal(context.state.page,'explore');assert.equal(context.location.hash,'explore');}
  for(const mode of ['raw','catalog','health']){context.state.dataView=mode;await context.dataPage(1);assert.equal(calls.pop(),'raw');}
  const html=fs.readFileSync('web/index.html','utf8');
  assert.equal((html.match(/data-page=/g)||[]).length,4);
  assert.match(html,/<header\b[^>]*id="workspaceSidebar"[^>]*class="workspace-header"/);
  assert.equal(html.includes('class="rail"'),false);
  assert.equal(html.includes('mobileSource')||app.includes('mobileSource'),false);
  assert.equal(html.includes('data-page="raw"'),false);
  assert.equal(html.includes('data-page="health"'),false);
  assert.equal(app.includes("api('raw?id="),false);
  assert.equal(html.includes('id="files"'),false);
  assert.equal(app.includes("$('#files')"),false);
  assert.equal(app.includes("$('#fileCount')"),false);
  assert.equal(studio.includes('data-data-view'),false);
  assert.equal(app.includes('function renderCatalog('),false);
  assert.equal(studio.includes('function inspectRegion('),true);
  console.log('Unified navigation: 20 checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
