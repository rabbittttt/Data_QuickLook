'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('web/sidebar.js','utf8');
const tests=[];
const test=(name,run)=>tests.push({name,run});

// A small DOM/event fixture models focus, capture/bubbling, native dialogs and
// responsive changes. Tests exercise the complete script rather than snippets.
function setup({mobile=true}={}){
  const nodes=new Map(),routes=[],timers=new Set([37]),legacyShortcuts=[];
  let document;
  class Node{
    constructor(tag,id='',parent=null){
      this.tagName=tag.toUpperCase();this.id=id;this.parentNode=parent;
      this.children=[];parent?.children?.push(this);this.listeners=new Map();
      this.attributes={};this.classes=new Set();this.hidden=false;this.disabled=false;
      this.inert=false;this.open=false;this.visible=true;this.value='';this.scrollTop=80;
      this.tabIndex=['BUTTON','INPUT','SELECT','TEXTAREA','A'].includes(this.tagName)?0:-1;
      this.classList={toggle:(name,value)=>{const add=value??!this.classes.has(name);if(add)this.classes.add(name);else this.classes.delete(name);return add;},contains:name=>this.classes.has(name)};
      if(id)nodes.set('#'+id,this);
    }
    addEventListener(type,callback,options=false){
      if(!this.listeners.has(type))this.listeners.set(type,[]);
      this.listeners.get(type).push({callback,capture:typeof options==='boolean'?options:!!options.capture});
    }
    setAttribute(name,value){this.attributes[name]=String(value);}
    getAttribute(name){return this.attributes[name]??null;}
    removeAttribute(name){delete this.attributes[name];}
    matches(selector){
      return selector.split(',').some(part=>{
        part=part.trim();
        if(part.startsWith('#'))return this.id===part.slice(1);
        if(part.startsWith('.'))return this.classes.has(part.slice(1));
        if(part==='[data-page]')return this.getAttribute('data-page')!==null;
        if(part==='[tabindex]')return this.getAttribute('tabindex')!==null;
        if(part==='a[href]')return this.tagName==='A'&&this.getAttribute('href')!==null;
        return this.tagName===part.toUpperCase();
      });
    }
    closest(selector){for(let node=this;node&&node!==document;node=node.parentNode)if(node.matches(selector))return node;return null;}
    contains(node){for(;node;node=node.parentNode)if(node===this)return true;return false;}
    querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
    getClientRects(){for(let node=this;node&&node!==document;node=node.parentNode)if(node.hidden||!node.visible)return[];return[{}];}
    focus(){
      for(let node=this;node&&node!==document;node=node.parentNode)if(node.inert||node.hidden||!node.visible)return;
      if(!this.disabled)document.activeElement=this;
    }
  }
  document=new Node('document');
  const body=new Node('body','',document);document.body=body;document.activeElement=body;
  const toggle=new Node('button','menuToggle',body),backdrop=new Node('button','sidebarBackdrop',body);
  const panel=new Node('aside','workspaceSidebar',body),close=new Node('button','sidebarClose',panel);
  const brand=new Node('a','brand',panel);brand.classes.add('brand');brand.setAttribute('href','#home');
  const search=new Node('input','search',panel),nav=new Node('nav','nav',panel);
  const home=new Node('button','home',nav);home.setAttribute('data-page','home');
  const homeText=new Node('span','homeText',home);
  const compare=new Node('button','compare',nav);compare.setAttribute('data-page','compare');
  const sourceButton=new Node('button','sourceButton',panel),importButton=new Node('button','importButton',panel);
  const disabled=new Node('button','disabledAction',panel);disabled.disabled=true;
  const hidden=new Node('button','hiddenAction',panel);hidden.hidden=true;
  const negative=new Node('button','negativeAction',panel);negative.tabIndex=-1;
  const app=new Node('div','app',body);app.classes.add('app');
  const main=new Node('main','main',app);main.setAttribute('tabindex','-1');
  const dialog=new Node('dialog','dialog',body),modalButton=new Node('button','modalButton',dialog);
  const importDialog=new Node('dialog','importDialog',body),importDone=new Node('button','importDone',importDialog);
  document.querySelector=selector=>selector==='dialog[open]'?[dialog,importDialog].find(node=>node.open)||null:
    selector==='.app'?app:nodes.get(selector)||null;
  const media={matches:mobile,listeners:[],addEventListener(type,callback){if(type==='change')this.listeners.push(callback);}};
  const go=(page,options)=>{routes.push({page,background:!!options?.background});context.state.page=page;return Promise.resolve();};
  const context=vm.createContext({document,window:{matchMedia:()=>media},state:{page:'home',query:''},searchTimer:37,
    clearTimeout:id=>timers.delete(id),go,console});
  // This is the existing app shortcut, registered before sidebar capture hooks.
  document.addEventListener('keydown',event=>{
    if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){
      legacyShortcuts.push('/');event.preventDefault();search.focus();
    }
  });
  nav.addEventListener('click',event=>{const target=event.target.closest('[data-page]');if(target)go(target.getAttribute('data-page'));});
  sourceButton.addEventListener('click',()=>{dialog.open=true;modalButton.focus();});
  importButton.addEventListener('click',()=>{importDialog.open=true;importDone.focus();});
  vm.runInContext(source,context,{filename:'web/sidebar.js'});

  function emit(type,target,details={}){
    const event={type,target,key:'',shiftKey:false,ctrlKey:false,metaKey:false,altKey:false,isComposing:false,
      defaultPrevented:false,stopped:false,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;},...details};
    const path=[];for(let node=target;node;node=node.parentNode)path.push(node);
    const call=(node,capture)=>{for(const listener of node.listeners.get(type)||[]){if(listener.capture===capture)listener.callback(event);if(event.stopped)break;}};
    for(const node of [...path].reverse()){call(node,true);if(event.stopped)return event;}
    for(const node of path){call(node,false);if(event.stopped)break;}
    return event;
  }
  const click=node=>{node.focus();return emit('click',node);};
  const key=(value,details={})=>emit('keydown',document.activeElement,{key:value,...details});
  const resize=matches=>{media.matches=matches;media.listeners.forEach(callback=>callback({matches}));};
  const closeDialog=(node,{retainFocus=false}={})=>{node.open=false;if(!retainFocus)document.activeElement=body;emit('close',node);};
  return {document,body,toggle,backdrop,panel,close,brand,search,home,homeText,compare,sourceButton,importButton,app,main,
    dialog,modalButton,importDialog,importDone,media,routes,timers,legacyShortcuts,context,click,key,resize,closeDialog};
}

test('mobile starts with an inert closed drawer and usable main content',()=>{
  const ui=setup();
  assert.equal(ui.toggle.getAttribute('aria-expanded'),'false');assert.equal(ui.panel.inert,true);
  assert.equal(ui.app.inert,false);assert.equal(ui.toggle.inert,false);assert.equal(ui.backdrop.hidden,true);
  assert.equal(ui.panel.getAttribute('role'),null);assert.equal(ui.document.activeElement,ui.body);
});

test('opening exposes a modal drawer and focuses its close control',()=>{
  const ui=setup();ui.click(ui.toggle);
  assert.equal(ui.toggle.getAttribute('aria-expanded'),'true');assert.equal(ui.panel.inert,false);
  assert.equal(ui.panel.getAttribute('role'),'dialog');assert.equal(ui.panel.getAttribute('aria-modal'),'true');
  assert.equal(ui.app.inert,true);assert.equal(ui.toggle.inert,true);assert.equal(ui.backdrop.hidden,false);
  assert.equal(ui.body.classList.contains('sidebar-open'),true);assert.equal(ui.document.activeElement,ui.close);
});

test('Escape, backdrop and close action hide the drawer and return focus',()=>{
  for(const action of ['escape','backdrop','close']){
    const ui=setup();ui.click(ui.toggle);
    if(action==='escape')assert.equal(ui.key('Escape').defaultPrevented,true);
    else ui.click(ui[action]);
    assert.equal(ui.panel.inert,true,action);assert.equal(ui.app.inert,false,action);
    assert.equal(ui.document.activeElement,ui.toggle,action);assert.equal(ui.backdrop.hidden,true,action);
  }
});

test('Tab and Shift+Tab wrap around enabled visible drawer controls',()=>{
  const ui=setup();ui.click(ui.toggle);
  ui.importButton.focus();assert.equal(ui.key('Tab').defaultPrevented,true);assert.equal(ui.document.activeElement,ui.close);
  assert.equal(ui.key('Tab',{shiftKey:true}).defaultPrevented,true);assert.equal(ui.document.activeElement,ui.importButton);
  ui.search.focus();assert.equal(ui.key('Tab').defaultPrevented,false,'ordinary interior navigation follows browser order');
});

test('navigation and the current route close the drawer and focus main',()=>{
  for(const name of ['compare','homeText','brand']){
    const ui=setup();ui.click(ui.toggle);ui.click(ui[name]);
    assert.equal(ui.panel.inert,true,name);assert.equal(ui.app.inert,false,name);
    assert.equal(ui.document.activeElement,ui.main,name);
    if(name==='compare')assert.equal(ui.context.state.page,'compare');
    if(name==='homeText')assert.equal(ui.context.state.page,'home','the currently active route still closes');
  }
});

test('source and import dialogs own focus after the drawer closes',()=>{
  for(const [entry,dialog,button] of [['sourceButton','dialog','modalButton'],['importButton','importDialog','importDone']]){
    const ui=setup();ui.click(ui.toggle);ui.click(ui[entry]);
    assert.equal(ui.panel.inert,true,entry);assert.equal(ui[dialog].open,true,entry);
    assert.equal(ui.document.activeElement,ui[button],entry);
    ui.closeDialog(ui[dialog]);assert.equal(ui.document.activeElement,ui.toggle,entry);
  }
});

test('a dialog that retains focus on its hidden close button returns to the menu',()=>{
  const ui=setup();ui.click(ui.toggle);ui.click(ui.importButton);
  assert.equal(ui.document.activeElement,ui.importDone);
  ui.closeDialog(ui.importDialog,{retainFocus:true});
  assert.equal(ui.document.activeElement,ui.toggle);
});

test('mobile search shortcut opens the drawer and reaches the search input',()=>{
  const ui=setup();ui.main.focus();const event=ui.key('/');
  assert.equal(event.defaultPrevented,true);assert.equal(ui.panel.inert,false);
  assert.equal(ui.document.activeElement,ui.search);assert.equal(ui.legacyShortcuts.length,0);
  ui.search.value='销量';assert.equal(ui.key('/').defaultPrevented,false,'typing slash inside input remains ordinary input');
});

test('a native modal keeps slash and Escape away from drawer shortcuts',()=>{
  const ui=setup();ui.click(ui.toggle);ui.click(ui.sourceButton);
  const slash=ui.key('/');assert.equal(slash.defaultPrevented,false);
  assert.equal(ui.legacyShortcuts.length,0);assert.equal(ui.document.activeElement,ui.modalButton);
  assert.equal(ui.key('Escape').defaultPrevented,false,'native dialog owns Escape');
  assert.equal(ui.document.activeElement,ui.modalButton);assert.equal(ui.panel.inert,true);
});

test('Enter searches immediately, cancels debounce and closes the mobile drawer',()=>{
  for(const [value,page,query] of [['  M8 销量  ','search','M8 销量'],['   ','home','']]){
    const ui=setup();ui.main.focus();ui.key('/');ui.search.value=value;
    assert.equal(ui.key('Enter').defaultPrevented,true);assert.equal(ui.timers.has(37),false);
    assert.equal(ui.context.state.query,query);assert.deepEqual(ui.routes,[{page,background:true}]);
    assert.equal(ui.panel.inert,true);assert.equal(ui.document.activeElement,ui.main);
  }
});

test('Chinese input composition does not submit an unfinished query',()=>{
  const ui=setup();ui.main.focus();ui.key('/');ui.search.value='销量';
  assert.equal(ui.key('Enter',{isComposing:true}).defaultPrevented,false);
  assert.equal(ui.routes.length,0);assert.equal(ui.timers.has(37),true);
  assert.equal(ui.document.activeElement,ui.search);assert.equal(ui.panel.inert,false);
});

test('desktop resize restores the rail and removes mobile modal state',()=>{
  const ui=setup();ui.click(ui.toggle);ui.resize(false);
  assert.equal(ui.panel.inert,false);assert.equal(ui.app.inert,false);assert.equal(ui.toggle.inert,false);
  assert.equal(ui.panel.getAttribute('role'),null);assert.equal(ui.panel.getAttribute('aria-modal'),null);
  assert.equal(ui.backdrop.hidden,true);assert.equal(ui.body.classList.contains('sidebar-open'),false);
  assert.equal(ui.document.activeElement,ui.main);
  ui.search.focus();ui.resize(true);assert.equal(ui.panel.inert,true);assert.equal(ui.document.activeElement,ui.toggle);
});

let failed=0;
for(const {name,run} of tests){
  try{run();console.log('PASS '+name);}catch(error){failed++;console.error('FAIL '+name);console.error(error);}
}
console.log(`Sidebar behavior: ${tests.length-failed}/${tests.length} checks passed`);
if(failed)process.exitCode=1;
