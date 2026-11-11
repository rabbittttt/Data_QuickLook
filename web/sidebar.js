'use strict';

// Desktop controls sit above the content. On small screens the same controls
// open in a keyboard-accessible panel at the top of the screen.
(() => {
  const panel=document.querySelector('#workspaceSidebar');
  const toggle=document.querySelector('#menuToggle');
  const close=document.querySelector('#sidebarClose');
  const backdrop=document.querySelector('#sidebarBackdrop');
  const main=document.querySelector('.app');
  const search=document.querySelector('#search');
  const mobile=window.matchMedia('(max-width:760px)');
  let open=false;
  const modalOpen=()=>!!document.querySelector('dialog[open]');
  const focusMain=()=>document.querySelector('#main').focus({preventScroll:true});

  function setOpen(value,{restoreFocus=true,focusSearch=false}={}){
    open=mobile.matches&&value;
    document.body.classList.toggle('sidebar-open',open);
    toggle.setAttribute('aria-expanded',String(open));
    backdrop.hidden=!open;
    panel.inert=mobile.matches&&!open;
    main.inert=open;toggle.inert=open;
    if(open){
      panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');
      panel.scrollTop=0;
      (focusSearch?search:close).focus({preventScroll:true});
    }else{
      panel.removeAttribute('role');panel.removeAttribute('aria-modal');
      if(restoreFocus&&mobile.matches)toggle.focus({preventScroll:true});
    }
  }

  toggle.addEventListener('click',()=>setOpen(!open));
  close.addEventListener('click',()=>setOpen(false));
  backdrop.addEventListener('click',()=>setOpen(false));
  panel.addEventListener('click',event=>{
    if(!mobile.matches||!open)return;
    if(event.target.closest('[data-page],.brand,#allData,#startCompare')){
      setOpen(false,{restoreFocus:false});if(!modalOpen())focusMain();
    }else if(event.target.closest('#importButton')){
      // A native dialog now owns focus; don't return it to the menu toggle.
      setOpen(false,{restoreFocus:false});
    }
  });

  search.addEventListener('keydown',event=>{
    if(event.key!=='Enter'||event.isComposing)return;
    event.preventDefault();clearTimeout(searchTimer);
    state.query=search.value.trim();
    go(state.query?'search':'home',{background:true});
    if(mobile.matches){setOpen(false,{restoreFocus:false});focusMain();}
  });

  document.addEventListener('keydown',event=>{
    if(modalOpen()){
      // The existing global search shortcut must not take focus from a dialog.
      if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName))event.stopImmediatePropagation();
      return;
    }
    if(mobile.matches&&event.key==='/'&&!event.ctrlKey&&!event.metaKey&&!event.altKey
        &&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){
      event.preventDefault();event.stopImmediatePropagation();setOpen(true,{focusSearch:true});return;
    }
    if(!open)return;
    if(event.key==='Escape'){event.preventDefault();setOpen(false);return;}
    if(event.key!=='Tab')return;
    const targets=Array.from(panel.querySelectorAll('a[href],button,input,select,textarea,[tabindex]'))
      .filter(node=>!node.disabled&&node.tabIndex>=0&&node.getClientRects().length);
    const first=targets[0],last=targets.at(-1);
    if(!first)return;
    if(event.shiftKey&&(document.activeElement===first||!panel.contains(document.activeElement))){
      event.preventDefault();last.focus();
    }else if(!event.shiftKey&&(document.activeElement===last||!panel.contains(document.activeElement))){
      event.preventDefault();first.focus();
    }
  },true);

  document.addEventListener('close',event=>{
    if(!event.target.matches?.('dialog')||!mobile.matches||open||modalOpen())return;
    // Native dialogs cannot restore focus to a trigger inside a closed drawer.
    if(document.activeElement===document.body||panel.contains(document.activeElement)
        ||event.target.contains(document.activeElement))toggle.focus({preventScroll:true});
  },true);
  const modeChanged=()=>{
    const active=document.activeElement;
    setOpen(false,{restoreFocus:false});
    if(mobile.matches&&panel.contains(active))toggle.focus({preventScroll:true});
    else if(!mobile.matches&&(active===toggle||active===close))focusMain();
  };
  if(mobile.addEventListener)mobile.addEventListener('change',modeChanged);
  else mobile.addListener(modeChanged);
  setOpen(false,{restoreFocus:false});
})();
