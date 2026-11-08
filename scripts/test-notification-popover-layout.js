const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const { readUiStyles } = require('./ui-style-fixture');
const root = path.resolve(__dirname, '..');
const pub = path.join(root, 'apps/mobile-web/public');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<link\b[^>]*>/gi, '');
function source(name) {
  const start = app.indexOf('function ' + name + '(');
  assert(start >= 0, name);
  return app.slice(start, app.indexOf('\n}\n', start) + 2);
}
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(file => file && fs.existsSync(file));

(async () => {
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    for (const viewport of [{width:1081,height:526},{width:1440,height:1000},{width:981,height:600},{width:884,height:817},{width:390,height:844},{width:320,height:568}]) {
      const page = await browser.newPage({viewport, reducedMotion:'reduce', hasTouch:viewport.width <= 980});
      await page.route('**/*', route => route.abort());
      await page.setContent(html);
      await page.addStyleTag({content:readUiStyles()});
      await page.addScriptTag({content:`
        const state = {messageNotificationOpen:false};
        const el = id => document.getElementById(id);
        const escapeHtml = value => String(value).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
        const formatTime = () => '9月14日 22:04';
        const truncatePreview = text => text;
        const renderConversationNav = () => {};
        let selected = null;
        const selectSession = async session => {selected=session;};
        let notifications = [{session:{hostId:'fixture',sessionId:'one',live:true},title:'Lifecycle Timeout Acceptance newtest4',hostLabel:'illuin Dev 8897',text:'消息布局测试 / preview text'}];
        const getUnreadMessageNotifications = () => notifications;
        ${source('renderMessageNotificationBell')}
        document.querySelector('.shell').classList.remove('navigator-collapsed');
        el('session-title').textContent='Lifecycle Timeout Acceptance newtest4';
        el('session-meta').textContent='illuin-dev-8897 | fixture session | running | D:/workspace/fixture';
        el('input-text').value='Keep my draft'; window.draftNode=el('input-text');
        el('session-log').innerHTML='<article class="message agent"><div class="bubble">Synthetic content only</div></article>';
        if(matchMedia('(max-width:980px), (pointer:coarse), (hover:none)').matches) document.body.appendChild(document.querySelector('.transcript-scroll-controls'));
        renderMessageNotificationBell();
      `});
      const eventStart=app.indexOf("el('message-notification-button')?.addEventListener('click'");
      await page.addScriptTag({content:app.slice(eventStart,app.indexOf('\n});',eventStart)+4)});
      for(const theme of ['minimal-light','dark-tech']) for(const navOpen of [true,false]) {
        await page.evaluate(({theme,navOpen})=>{document.documentElement.dataset.theme=theme;document.querySelector('.shell').classList.toggle('navigator-collapsed',!navOpen);state.messageNotificationOpen=false;renderMessageNotificationBell();window.scrollTo(0,0);},{theme,navOpen});
        // The mobile drawer can cover the bell itself: exercise an already-open
        // popover with that drawer, without pretending the hidden bell is clickable.
        if(viewport.width<=980&&navOpen) await page.evaluate(()=>el('message-notification-button').click());
        else await page.locator('#message-notification-button').click();
        const result=await page.evaluate(()=>{
          const panel=el('message-notification-panel'),r=panel.getBoundingClientRect(),main=document.querySelector('.main').getBoundingClientRect();
          const hits=[];
          for(const fx of [.03,.5,.97]) for(const fy of [.03,.5,.97]) {
            const x=r.left+r.width*fx,y=r.top+r.height*fy,hit=document.elementFromPoint(x,y);
            hits.push({covered:panel.contains(hit),hit:hit?.id||hit?.className,x,y});
          }
          return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,mainLeft:main.left,hits,overflow:panel.scrollWidth>panel.clientWidth+1};
        });
        assert(result.left>=8&&result.right<=viewport.width-8,JSON.stringify({viewport,theme,navOpen,result}));
        if(viewport.width>980&&navOpen) assert(result.left>=result.mainLeft,'desktop popover must stay out of the navigation rail: '+JSON.stringify(result));
        assert(result.top>=0&&result.bottom<=viewport.height,JSON.stringify({viewport,theme,navOpen,result}));
        assert(result.hits.every(hit=>hit.covered),JSON.stringify({viewport,theme,navOpen,result}));
        assert(!result.overflow,'no horizontal content overflow');
        assert.equal(await page.locator('.transcript-scroll-controls').evaluate(node=>getComputedStyle(node).visibility),'hidden');
        for(const id of ['settings-dialog','session-details-overlay']) {
          await page.evaluate(id=>{el(id).classList.remove('hidden');document.body.classList.add('modal-open');},id);
          assert(await page.evaluate(({id,x,y})=>el(id).contains(document.elementFromPoint(x,y)),{id,x:(result.left+result.right)/2,y:(result.top+result.bottom)/2}),id+' above popover');
          await page.evaluate(id=>{el(id).classList.add('hidden');document.body.classList.remove('modal-open');},id);
        }
        if(process.env.BELL_UI_SCREENSHOTS==='1'&&navOpen) {
          const out=path.join(root,'tmp/notification-popover');fs.mkdirSync(out,{recursive:true});
          await page.screenshot({path:path.join(out,theme+'-'+viewport.width+'.png')});
        }
        await page.locator('.message-notification-item').click();
        assert.equal(await page.evaluate(()=>selected.sessionId),'one');
        assert.equal(await page.locator('#message-notification-panel').isVisible(),false);
        assert.equal(await page.locator('.transcript-scroll-controls').evaluate(node=>getComputedStyle(node).visibility),'visible');
        assert(await page.evaluate(()=>draftNode===el('input-text')&&draftNode.value==='Keep my draft'));
        await page.evaluate(()=>{
          window.originalNotifications=notifications;
          notifications=Array.from({length:18},(_,i)=>({...originalNotifications[0],session:{hostId:'fixture',sessionId:'long-'+i,live:true},title:'LongUnbrokenTitle'.repeat(8),text:'preview'.repeat(80)}));
          state.messageNotificationOpen=true;renderMessageNotificationBell();
        });
        const longList=await page.locator('#message-notification-panel').evaluate(panel=>{
          const r=panel.getBoundingClientRect();
          return {scrolls:panel.scrollHeight>panel.clientHeight,noOverflow:panel.scrollWidth<=panel.clientWidth+1,visible:r.top>=0&&r.bottom<=innerHeight};
        });
        assert.deepEqual(longList,{scrolls:true,noOverflow:true,visible:true},JSON.stringify({viewport,theme,navOpen,longList}));
        await page.locator('.message-notification-item').last().click();
        assert.equal(await page.evaluate(()=>selected.sessionId),'long-17','last notification remains reachable by scrolling');
        await page.evaluate(()=>{notifications=[];state.messageNotificationOpen=true;renderMessageNotificationBell();});
        assert.equal(await page.locator('#message-notification-empty').isVisible(),true);
        assert.equal(await page.locator('#message-notification-count').isVisible(),false);
        await page.evaluate(()=>{notifications=originalNotifications;state.messageNotificationOpen=false;renderMessageNotificationBell();});
      }
      await page.close();
    }
  } finally { await browser.close(); }
  console.log('notification popover layout: 6 viewports x 2 themes x 2 navigation states; hit-testing, modal priority, item action and draft preservation passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
