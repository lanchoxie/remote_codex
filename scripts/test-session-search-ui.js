const assert=require('assert'),fs=require('fs'),path=require('path');
const {chromium}=require('@playwright/test');
const {readUiStyles}=require('./ui-style-fixture');
const root=path.resolve(__dirname,'..'),pub=path.join(root,'apps/mobile-web/public');
const app=fs.readFileSync(path.join(pub,'app.js'),'utf8'),html=fs.readFileSync(path.join(pub,'index.html'),'utf8');
function source(name){
  const m=new RegExp('(?:async )?function '+name+'\\(').exec(app);assert(m,name);
  return app.slice(m.index,app.indexOf('\n}\n',m.index)+2);
}
const names=['currentLocale','t','formatUiText','translateStaticText','shouldPruneLocalizationElement','applyStaticLocalization','renderLocaleLabels','escapeHtml','escapeRegExp','normalizeSearchTerms','highlightSearchSnippet','getSelectedCollection','getSessionSearchModeLabel','getSessionSortLabel','collectionDisplayName','renderMobileSelectMenu','renderHostSwitcher','renderCollectionTabs','renderConversationNav','getFullSessionSearchController','scheduleFullSessionSearch','runFullSessionSearch','setSessionSearchQuery','setSessionSearchMode','renderTranscriptSearchNavigator','renderConversationSearchHits'];
const bootstrap=[
"const state={ui:{locale:'zh-CN'},hosts:[{hostId:'fixture',label:'Keyword',platform:'win32',online:true}],selectedHostId:'fixture',selectedCollectionId:'default',sessionSearchQuery:'',sessionSearchMode:'keyword',sessionSortBy:'updatedAt',sessionSortDir:'desc',sessionSearchResults:[],sessionSearchLoading:false,sessionCollections:[{collectionId:'default',name:'Default',itemCount:56},{collectionId:'trash',name:'Trash',itemCount:0}],mobileMenus:{},transcriptSearchNavigator:{},collectionManagerOpen:false};",
"const UI_TEXT={en:{},'zh-CN':{}},DEFAULT_COLLECTION_ID='default',TRASH_COLLECTION_ID='trash';",
app.slice(app.indexOf('const ZH_STATIC_TEXT ='),app.indexOf('\n',app.indexOf('const EN_STATIC_TEXT ='))),
"const SESSION_SEARCH_MODE_LABELS={keyword:'Keyword',path:'Path',title:'Title'},SESSION_SORT_LABELS={updatedAt:'Recently updated',createdAt:'Created time',messageCount:'Message count'};",
"let fullSessionSearchController=null; const el=id=>document.getElementById(id),getHost=id=>state.hosts.find(h=>h.hostId===id);",
"const getConversationGroupsForCollection=()=>[],sortConversationGroups=x=>x,filterConversationGroupsWithSearch=x=>x,renderAll=()=>renderConversationNav();",
"const mergeSession=x=>(window.merged||=[]).push(x),getSessionKey=s=>s?s.hostId+'::'+s.sessionId:'',formatTime=()=> '12:00',openSearchResult=(...args)=>{window.opened=args;},reportError=e=>{throw e;};",
"const structuredThinkingText=value=>String(value??'');",
"const applyUiTheme=()=>{},persistUiSettings=()=>{};",
"const fetchJson=(url,options)=>{window.requestOptions=options;window.requestUrl=url;return new Promise((resolve,reject)=>{window.resolveSearch=resolve;window.rejectSearch=reject;});};",
names.map(source).join('\n'),
"document.querySelector('.shell').classList.remove('navigator-collapsed');renderConversationNav();",
].join('\n');
const executablePath=[process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p=>p&&fs.existsSync(p));
(async()=>{
 const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
 try{
  for(const viewport of [{width:1440,height:1000},{width:884,height:817},{width:390,height:844}]){
   const page=await browser.newPage({viewport,reducedMotion:'reduce',hasTouch:viewport.width<980});
   await page.route('**/*',r=>r.abort());
   await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,''));
   await page.addStyleTag({content:readUiStyles()});
   for(const f of ['ui/i18n.js','ui/session-search.js']) await page.addScriptTag({content:fs.readFileSync(path.join(pub,f),'utf8')});
   await page.addScriptTag({content:bootstrap});
   for(const marker of ["el('session-search-form').addEventListener('submit'","el('session-search-input').addEventListener('input'","el('clear-session-search-button').addEventListener('click'","el('toggle-language-button').addEventListener('click'"]){
    const start=app.indexOf(marker),end=app.indexOf('\n});',start);assert(start>=0&&end>start);
    await page.addScriptTag({content:app.slice(start,end+4)});
   }
   await page.evaluate(()=>{state.sessionSearchQuery='Keyword';renderTranscriptSearchNavigator({hostId:'fixture',sessionId:'found'},[{}],0);applyStaticLocalization();});
   assert.equal(await page.locator('.transcript-search-query').textContent(),'Keyword','language pass must not translate the actual query');
   assert.equal(await page.locator('#selected-host-title').textContent(),'Keyword','language pass must not translate a Host name');
   await page.evaluate(()=>document.getElementById('toggle-language-button').click());
   assert.equal(await page.locator('[data-transcript-search-nav="previous"]').textContent(),'Previous match');
   assert.equal(await page.locator('[data-transcript-search-nav="next"]').textContent(),'Next match');
   assert.equal(await page.locator('[data-transcript-search-nav="clear"]').getAttribute('aria-label'),'Clear search');
   assert.equal(await page.locator('.transcript-search-query').textContent(),'Keyword');
   await page.evaluate(()=>document.getElementById('toggle-language-button').click());
   assert.equal(await page.locator('[data-transcript-search-nav="next"]').textContent(),'下一个匹配');
   await page.evaluate(()=>{state.sessionSearchQuery='';renderConversationNav();});
   for(const theme of ['minimal-light','dark-tech']){
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    for(const locale of ['zh-CN','en','zh-CN']){
     await page.evaluate(locale=>{state.ui.locale=locale;renderConversationNav();},locale);
     const en=locale==='en';
     assert.equal(await page.locator('#session-sort-mode option:checked').textContent(),en?'Recently updated':'最近更新');
     assert.equal(await page.locator('#session-sort-mode-button').textContent(),en?'Recently updated':'最近更新');
     assert.equal(await page.locator('#session-sort-dir-button').textContent(),en?'Desc':'降序');
     assert.equal(await page.locator('#host-switcher option:checked').textContent(),en?'Keyword (online)':'Keyword (在线)');
     assert.equal(await page.locator('#session-collection-select option:checked').textContent(),en?'Default (56)':'默认收藏夹 (56)');
     assert(!(await page.locator('#session-search-summary').textContent()).includes('{total}'));
    }
    await page.locator('#session-search-input').fill('生肖');
    assert.equal(await page.locator('#session-search-summary').getAttribute('data-search-phase'),'pending');
    assert((await page.locator('#session-search-summary').textContent()).includes('正在准备搜索'));
    const bounds=await page.evaluate(()=>{
     const i=document.getElementById('session-search-input'),b=document.getElementById('clear-session-search-button'),a=i.getBoundingClientRect(),r=b.getBoundingClientRect();
     return {inside:r.top>=a.top&&r.bottom<=a.bottom&&r.left>=a.left&&r.right<=a.right,padding:parseFloat(getComputedStyle(i).paddingRight),width:r.width,delta:Math.abs((r.top+r.bottom-a.top-a.bottom)/2)};
    });
    assert(bounds.inside,JSON.stringify({viewport,theme,bounds}));assert(bounds.padding>=bounds.width+4);assert(bounds.delta<1);
    await page.locator('#session-search-input').press('Enter');
    assert((await page.locator('#session-search-summary').textContent()).includes('正在搜索完整历史'));
    assert.equal(await page.evaluate(()=>window.requestOptions.timeoutMs),65000);
    assert.equal(await page.evaluate(()=>new URL(window.requestUrl,'http://fixture').searchParams.get('q')),'生肖');
    await page.evaluate(()=>window.resolveSearch({results:[{hostId:'fixture',sessionId:'found'}],source:'host-agent'}));
    await page.waitForFunction(()=>document.getElementById('session-search-summary').dataset.searchPhase==='ready');
    assert((await page.locator('#session-search-summary').textContent()).includes('1 个完整历史匹配'));
    await page.evaluate(()=>document.getElementById('session-list').appendChild(renderConversationSearchHits({},[{hostId:'fixture',sessionId:'found',matches:[{speaker:'user',entryIndex:6,snippet:'生肖 Keyword <unsafe>'}]}])));
    assert.equal(await page.locator('.conversation-search-hit mark').textContent(),'生肖');
    assert.equal(await page.locator('.conversation-search-hit unsafe').count(),0);
    await page.locator('.conversation-search-hit').click();
    assert.equal(await page.evaluate(()=>window.opened[0].sessionId),'found');
    if(process.env.SEARCH_UI_SCREENSHOTS==='1'){
     const output=path.join(root,'tmp/search-ui');fs.mkdirSync(output,{recursive:true});
     await page.screenshot({path:path.join(output,theme+'-'+viewport.width+'-nav.png')});
    }
    await page.locator('#clear-session-search-button').click();
    assert.equal(await page.locator('#session-search-input').inputValue(),'');assert.equal(await page.locator('#clear-session-search-button').isVisible(),false);
    await page.locator('#session-search-input').fill('失败');await page.locator('#session-search-input').press('Enter');
    await page.evaluate(()=>window.rejectSearch(new Error('fixture offline')));
    await page.waitForFunction(()=>document.getElementById('session-search-summary').dataset.searchPhase==='error');
    assert((await page.locator('#session-search-summary').textContent()).includes('搜索失败'));
    await page.evaluate(()=>{
     document.querySelector('.shell').classList.add('navigator-collapsed');state.sessionSearchQuery='生肖';
     const filler='<p>long message filler</p>'.repeat(60);
     document.getElementById('session-log').innerHTML='<article class="message agent" id="focused-transcript-entry"><div class="bubble">'+filler+'<p><mark>生肖</mark> exact result</p>'+filler+'</div></article>';
     renderTranscriptSearchNavigator({hostId:'fixture',sessionId:'found'},[{}],0);
     window.beforeDraft=document.getElementById('input-text');beforeDraft.value='keep draft';
     const owner=matchMedia('(max-width:980px), (pointer:coarse)').matches?document.scrollingElement:document.getElementById('session-log');
     RemoteCodexSessionSearch.centerHighlight(document.getElementById('focused-transcript-entry'),owner);
    });
    const focus=await page.evaluate(()=>{
     const owner=matchMedia('(max-width:980px), (pointer:coarse)').matches?document.scrollingElement:document.getElementById('session-log'),r=document.querySelector('#focused-transcript-entry mark').getBoundingClientRect(),v=owner===document.scrollingElement?{top:0,bottom:innerHeight}:owner.getBoundingClientRect();
     return {delta:Math.abs((r.top+r.bottom-v.top-v.bottom)/2),draft:beforeDraft===document.getElementById('input-text')&&beforeDraft.value==='keep draft'};
    });
    assert(focus.delta<=2,JSON.stringify({viewport,theme,focus}));assert(focus.draft);
    if(process.env.SEARCH_UI_SCREENSHOTS==='1'){
     const output=path.join(root,'tmp/search-ui');await page.screenshot({path:path.join(output,theme+'-'+viewport.width+'-focus.png')});
    }
    await page.evaluate(()=>{getFullSessionSearchController().dispose();fullSessionSearchController=null;state.sessionSearchQuery='';document.querySelector('.shell').classList.remove('navigator-collapsed');renderConversationNav();});
   }
   await page.close();
  }
 }finally{await browser.close();}
 console.log('search UI: real handlers/renderers, language refresh, clear button containment, two-character search, errors and highlighted-word centering passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
