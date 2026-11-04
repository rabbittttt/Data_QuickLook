const fs=require('node:fs');
const assert=require('node:assert/strict');
const css=fs.readFileSync('web/ux.css','utf8');
const app=fs.readFileSync('web/app.js','utf8');
const html=fs.readFileSync('web/index.html','utf8');

function luminance(hex){
  const [r,g,b]=hex.replace('#','').match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4);
  return r*0.2126+g*0.7152+b*0.0722;
}
function contrast(a,b='#ffffff'){
  const values=[luminance(a),luminance(b)].sort((a,b)=>b-a);
  return (values[0]+0.05)/(values[1]+0.05);
}
const token=name=>css.match(new RegExp('--'+name+':(#[0-9a-f]{6})'))?.[1];
assert.ok(contrast(token('focus'))>=3,'keyboard focus meets non-text contrast');
assert.ok(contrast(token('control-border'))>=3,'form boundaries remain visible against white');
assert.ok(contrast(token('text-secondary'))>=4.5,'secondary body text remains readable');
const chartPalette=app.match(/const colors=\[([^\]]+)\]/)[1].match(/#[0-9a-f]{6}/g);
assert.equal(chartPalette.length,6,'the established six-color chart identity remains intact');
chartPalette.forEach(color=>assert.ok(contrast(color)>=3,`chart stroke ${color} meets non-text contrast on white`));
assert.match(css,/button:focus-visible,a:focus-visible,summary:focus-visible,input:focus,select:focus/);
assert.match(css,/\.studio-builder>summary:focus-visible[^}]*outline:3px solid var\(--focus\)/);
assert.match(css,/\.pagehead\.pagehead-compact\{height:0;min-height:0;margin:0;padding:0;border:0\}/,'page heading no longer occupies visible space');
assert.match(css,/\.visually-hidden\{[^}]*clip:rect\(0,0,0,0\)/,'route heading remains available to assistive technology');
assert.match(css,/\.series-toolbar\{[^}]*flex-wrap:wrap/,'new-series action has a wrapping toolbar outside the manager');
assert.match(css,/\.applied-series-manager \.series-ribbon\{[^}]*overflow-y:auto/,'applied series have an explicit local scroll region');
assert.match(css,/\.series-ribbon \.series-remove\{position:static/,'delete action no longer overlays the edit target');
assert.match(css,/\.series-ribbon \.series-edit\{[^}]*overflow-wrap:anywhere/,'long source labels wrap rather than escape their chips');
assert.match(css,/\.tablewrap\{[^}]*max-width:100%/,'table overflow stays inside its container');
assert.match(css,/\.studio-builder>summary[^}]*justify-content:flex-start/,'disclosure indicator and label stay grouped');

const mobile=css.slice(css.indexOf('@media(max-width:760px)'));
assert.match(css,/--workspace-sidebar-width:196px/,'desktop navigation uses a compact, predictable width');
assert.match(css,/\.workspace-header\{[^}]*position:fixed[^}]*flex-direction:column[^}]*width:var\(--workspace-sidebar-width\)[^}]*height:100dvh[^}]*overflow-y:auto/,'the sidebar stays fixed and scrolls its own controls on short screens');
assert.match(css,/#nav\{[^}]*display:grid[^}]*grid-template-columns:minmax\(0,1fr\)/,'all four destinations form one vertical navigation list');
assert.match(css,/\.app\{margin-left:var\(--workspace-sidebar-width\)\}/,'desktop content clears the fixed sidebar');
assert.match(css,/main\{max-width:none\}/,'the plotting area uses the available width beside the sidebar');
assert.match(mobile,/\.app\{margin-left:0\}/,'closed mobile navigation does not reserve a left column');
assert.match(mobile,/\.workspace-header\{[^}]*visibility:hidden[^}]*transform:translateX\(-100%\)/,'the closed mobile drawer is hidden outside the viewport');
assert.match(mobile,/body\.sidebar-open \.workspace-header\{visibility:visible;transform:translateX\(0\)/,'opening the menu makes the mobile drawer visible');
assert.match(mobile,/body\.sidebar-open\{overflow:hidden\}/,'the modal drawer prevents background scrolling while it is open');
assert.match(mobile,/\.sidebar-toggle\{[^}]*min-height:44px/,'the mobile menu opener remains touch-sized');
assert.match(mobile,/\.sidebar-close\{[^}]*width:44px;min-height:44px/,'the mobile close action remains touch-sized');
assert.match(css,/\.sidebar-backdrop\[hidden\]\{display:none\}/,'closing the drawer removes its backdrop from hit testing');
assert.match(mobile,/#nav button,\.workspace-header \.top-actions button,\.workspace-tools button\{min-height:44px/,'navigation and data actions retain touch-sized targets in the drawer');
assert.match(mobile,/main\{padding:60px 12px calc\(24px \+ env\(safe-area-inset-bottom\)\)/,'mobile content clears the menu button and keeps its bottom safe area');
assert.match(mobile,/padding:12px max\(12px,env\(safe-area-inset-right\)\) calc\(16px \+ env\(safe-area-inset-bottom\)\) max\(12px,env\(safe-area-inset-left\)\)/,'drawer controls respect device safe areas');

const sidebar=html.match(/<aside\b[^>]*\bid="workspaceSidebar"[^>]*>([\s\S]*?)<\/aside>/)?.[1];
assert.ok(sidebar,'navigation and data operations have one semantic sidebar');
for(const id of ['nav','search','syncStatus','importButton','syncButton','sourceButton','tableCount','basketCount']){
  assert.match(sidebar,new RegExp('\\bid="'+id+'"'),`${id} remains inside the sidebar`);
  assert.equal((html.match(new RegExp('\\bid="'+id+'"','g'))||[]).length,1,`${id} has one entry point`);
}
assert.equal((sidebar.match(/\bdata-page="/g)||[]).length,4,'all four destinations remain available');
assert.match(html,/<button\b[^>]*id="menuToggle"[^>]*aria-controls="workspaceSidebar"[^>]*aria-expanded="false"/,'the mobile opener exposes its controlled region and collapsed state');
assert.match(sidebar,/<button\b[^>]*id="sidebarClose"[^>]*aria-label="关闭菜单"/,'the drawer has an explicitly named close action');
assert.match(html,/<button\b[^>]*id="sidebarBackdrop"[^>]*hidden/,'the mobile backdrop starts inactive');
assert.doesNotMatch(html,/<header\b[^>]*class="[^"]*\btopbar\b/,'the old top action bar does not duplicate sidebar controls');
assert.match(mobile,/\.series-ribbon \.series-remove\{width:44px;height:44px;min-height:44px/,'mobile delete target is fully touch-sized');
assert.match(mobile,/\.series-choices label,\.mapping-picker \.series-choices label\{min-height:44px/);
assert.match(mobile,/input:not\(\[type=checkbox\]\):not\(\[type=radio\]\),select[^}]*font-size:16px/,'mobile fields avoid small text and focus zoom');
const sidebarSearch=css.match(/\.workspace-header \.search\{([^}]+)\}/)?.[1];
const sidebarSearchFocus=css.match(/\.workspace-header \.search:focus-within\{([^}]+)\}/)?.[1];
assert.match(sidebarSearchFocus||'',/outline:3px solid #[0-9a-f]{6}/,'search wrapper supplies visible focus when its inner input outline is suppressed');
assert.ok(contrast(sidebarSearchFocus.match(/outline:3px solid (#[0-9a-f]{6})/)[1],sidebarSearch.match(/background:(#[0-9a-f]{6})/)[1])>=3,'search focus remains visible against the dark sidebar surface');
assert.match(mobile,/\.series-toolbar>div\{[^}]*justify-content:flex-end/,'mobile chart actions remain together on one row when room permits');
assert.match(mobile,/\.series-toolbar>\.series-ribbon-label\{width:auto;flex:0 1 auto/,'applied-series count no longer forces a whole toolbar row');
assert.match(mobile,/#studioNew\{order:-1\}/,'new-series action remains first even when undo is available');
assert.match(mobile,/\.charttools\{display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/,'mobile chart tools fit selectors and actions into two rows');
assert.match(mobile,/\.charttools label\{grid-column:span 3/,'each chart selector occupies half the available width');
assert.match(mobile,/\.charttools>button\{grid-column:span 2;min-height:44px[^}]*overflow-wrap:anywhere/,'three actions retain touch targets and wrap without clipping');
assert.match(mobile,/#png\{grid-column:span 2\}/,'export no longer forces an additional mobile toolbar row');
assert.match(css,/\.builder-loading\{display:flex;align-items:center;gap:8px[^}]*background:#f3f8f3/,'loading feedback aligns text and spinner on a quiet surface');
assert.match(css,/\.builder-loading \.ui-busy-indicator\{flex-shrink:0\}/,'loading spinner retains its dimensions beside wrapped text');
assert.equal((css.match(/{/g)||[]).length,(css.match(/}/g)||[]).length,'all CSS blocks close');
assert.doesNotMatch(css,/overflow-x\s*:\s*hidden/,'responsive layout does not conceal horizontal overflow globally');

// The visual layer does not silently change chart data or limit series counts.
assert.match(app,/CSV 包含全部系列/);
console.log('UI styles: contrast, focus, compact sidebar, unique data actions, long labels, local overflow and mobile drawer/target checks passed');
