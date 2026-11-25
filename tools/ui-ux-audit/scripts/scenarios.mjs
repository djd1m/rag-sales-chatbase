import {chromium} from '/opt/audit/node_modules/playwright/index.mjs';
import AxeBuilder from '/opt/audit/node_modules/@axe-core/playwright/dist/index.mjs';
import fs from 'node:fs/promises';
const out='/artifacts/scenarios';await fs.mkdir(out,{recursive:true});const results=[];
const browser=await chromium.launch({headless:true,chromiumSandbox:false});
async function context(options={}){return browser.newContext({viewport:{width:1440,height:900},locale:'ru-RU',reducedMotion:'reduce',...options});}
async function guard(page){await page.route('**/*',route=>{
 const r=route.request(),h=r.headers();return !['GET','HEAD','OPTIONS'].includes(r.method())||h['next-router-prefetch']==='1'||h.purpose==='prefetch'?route.abort('blockedbyclient'):route.continue();
});}
async function capture(page,key,mode='live'){
 await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(200);
 const d=await page.evaluate(()=>({title:document.title,url:location.href,text:document.body.innerText,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,theme:document.documentElement.dataset.theme,
 controls:[...document.querySelectorAll('input,button,summary,a[href]')].map(e=>{const r=e.getBoundingClientRect();return {tag:e.tagName,type:e.type,text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').slice(0,100),name:e.name,href:e.href,box:{x:r.x,y:r.y,width:r.width,height:r.height}}}).filter(e=>e.box.width>0&&e.box.height>0)}));
 await page.screenshot({path:`${out}/${key}.png`,fullPage:false});
 await fs.writeFile(`${out}/${key}.json`,JSON.stringify({...d,mode},null,2));results.push({key,mode,width:d.width,height:d.height,url:d.url,overflow:d.scrollWidth>d.width+1});return d;
}
try{
 // Live authenticated empty state. No account or bot creation, changes or deletion.
 for(const theme of ['dark','light'])for(const width of [320,390,768,1440]){
  const c=await context({storageState:'/artifacts/.private/sufler-state.json',viewport:{width,height:width===1440?900:844},isMobile:width<600,hasTouch:width<600});
  await c.addCookies([{name:'n6_theme',value:theme,url:'https://sufler.site'}]);const p=await c.newPage();await guard(p);await p.goto('https://sufler.site/dashboard',{waitUntil:'networkidle'});
  if(!(await p.locator('body').innerText()).includes('Ботов пока нет'))throw new Error('Use an empty audit account; private data must not be captured');
  const data=await capture(p,`sufler-dashboard-${theme}-${width}`);const a=await new AxeBuilder({page:p}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  await fs.writeFile(`${out}/sufler-dashboard-${theme}-${width}-axe.json`,JSON.stringify(a.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))})),null,2));
  if(!data.text.includes('Ботов пока нет'))throw new Error('Dashboard has unexpected personal data; stop publication');
  await c.close();
 }
 // Short/mobile first screens and keyboard navigation.
 for(const size of [{width:320,height:568},{width:375,height:667},{width:390,height:844}]){
  const c=await context({viewport:size,isMobile:true,hasTouch:true});const p=await c.newPage();await guard(p);await p.goto('https://sufler.site/',{waitUntil:'networkidle'});await capture(p,`sufler-mobile-${size.width}x${size.height}`);await c.close();
 }
 const c=await context();const p=await c.newPage();await guard(p);await p.goto('https://sufler.site/',{waitUntil:'networkidle'});
 const focus=[];for(let i=0;i<8;i++){await p.keyboard.press('Tab');focus.push(await p.evaluate(()=>{const e=document.activeElement,s=getComputedStyle(e);return{text:e.innerText?.slice(0,70),tag:e.tagName,id:e.id,outline:s.outline,outlineOffset:s.outlineOffset}}));}
 await fs.writeFile(`${out}/keyboard-focus.json`,JSON.stringify(focus,null,2));await p.screenshot({path:`${out}/sufler-keyboard-focus.png`});
 await p.goto('https://sufler.site/',{waitUntil:'networkidle'});const before=await p.locator('html').getAttribute('data-theme');await p.getByRole('button',{name:'Светлая тема'}).click();const toggled=await p.locator('html').getAttribute('data-theme');await p.reload();const persisted=await p.locator('html').getAttribute('data-theme');results.push({key:'theme-toggle',before,toggled,persisted,passed:before!==toggled&&toggled===persisted});
 await p.locator('details summary').first().click();results.push({key:'faq-expand',opened:await p.locator('details').first().getAttribute('open')!==null});
 await p.goto('https://sufler.site/preview',{waitUntil:'networkidle'});await p.getByRole('button',{name:'Создать бота',exact:true}).click();
 results.push({key:'empty-url-validation',validation:await p.locator('input[name=url]').evaluate(e=>e.validationMessage),focused:await p.locator('input[name=url]').evaluate(e=>document.activeElement===e)});
 // Simulated response ONLY in browser: visual loading/error states, no indexing/AI call.
 await p.route('https://sufler.site/api/preview',async route=>{await new Promise(r=>setTimeout(r,1200));await route.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:{code:'invalid_url',message:'Укажите адрес общедоступного сайта'}})});});
 await p.locator('input[name=url]').fill('not-a-url');await p.getByRole('button',{name:'Создать бота',exact:true}).click();await p.waitForTimeout(250);await capture(p,'sufler-preview-loading','browser-mocked-response');await p.getByRole('alert').waitFor();await capture(p,'sufler-preview-error','browser-mocked-response');
 await c.close();
 // Actual production frontend with deterministic mocked preview data. No server job or model call.
 const job='00000000-0000-4000-8000-000000000025';
 const site={host:'example.com',title:'Демонстрационная компания',h1:'Услуги для клиентов',suggestions:['Сколько стоит доставка?','Как с вами связаться?','Как оформить заказ?']};
 for(const width of [390,1440])for(const state of ['running','failed','done']){
  const c=await context({viewport:{width,height:width===1440?900:844},isMobile:width<600,hasTouch:width<600});const p=await c.newPage();await guard(p);
  await p.route(`https://sufler.site/api/preview/${job}`,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:{index_job_id:job,state,pages_done:state==='done'?12:7,pages_total:12,page_budget:20,chunks_done:28,reason:state==='failed'?'robots_disallowed':undefined,site,questions_left:7}})}));
  await p.route(`https://sufler.site/api/preview/${job}/ask`,async route=>{const q=route.request().postDataJSON()?.question||'';await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:q.includes('рассроч')?{status:'unknown',text:'Я отвечаю только по материалам компании и не нашёл информации о рассрочке. Напишите: contact@example.invalid'}:{status:'answered',text:'Доставка по городу — 350 ₽.',source:{title:'Условия доставки',url:'https://example.com/delivery',excerpt:'Доставка по городу стоит 350 ₽. Самовывоз бесплатный.'},first_answer:true}})});});
  await p.goto(`https://sufler.site/preview/${job}`,{waitUntil:'domcontentloaded'});await p.waitForTimeout(700);
  await capture(p,`sufler-preview-${state}-${width}`,'production-ui-browser-mocked-data');
  if(state==='done'){
   await p.locator('#preview-question').fill('Сколько стоит доставка?');await p.getByRole('button',{name:'Спросить',exact:true}).click();await p.getByText('Доставка по городу — 350 ₽.',{exact:true}).waitFor();
   await capture(p,`sufler-preview-answer-${width}`,'production-ui-browser-mocked-data');
   await p.locator('#preview-question').fill('Есть ли рассрочка?');await p.getByRole('button',{name:'Спросить',exact:true}).click();await p.getByText(/не нашёл информации о рассрочке/).waitFor();await capture(p,`sufler-preview-unknown-${width}`,'production-ui-browser-mocked-data');
  }
  await c.close();
 }
 // Chatbase public product/login pages: observed separately from publisher illustrations.
 for(const [name,path] of [['home','/'],['pricing','/pricing'],['login','/auth/signin']])for(const width of [390,1440]){
  const c=await context({viewport:{width,height:width===1440?900:844},isMobile:width<600,hasTouch:width<600});const p=await c.newPage();await guard(p);const r=await p.goto('https://www.chatbase.co'+path,{waitUntil:'domcontentloaded',timeout:45000});await p.waitForTimeout(1800);await capture(p,`chatbase-${name}-${width}`);results.push({key:`chatbase-${name}-${width}`,http:r.status()});await c.close();
 }
 await fs.writeFile(`${out}/summary.json`,JSON.stringify({browser:browser.version(),results},null,2));console.log(JSON.stringify({scenarios:results.length,mode:'UI-only',server_mutations:'login-session-only',paid_ai_calls:0}));
}finally{await browser.close()}
