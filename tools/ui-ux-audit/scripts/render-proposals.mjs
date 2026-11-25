import {chromium} from '/opt/audit/node_modules/playwright/index.mjs';
import AxeBuilder from '/opt/audit/node_modules/@axe-core/playwright/dist/index.mjs';
import http from 'node:http';import path from 'node:path';import fs from 'node:fs/promises';
const root='/artifacts/proposals',out='/artifacts/proposed';await fs.mkdir(out,{recursive:true});
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');const file=path.resolve(root,'.'+decodeURIComponent(u.pathname));if(!file.startsWith(root+'/')){res.writeHead(403).end();return}const b=await fs.readFile(file);res.writeHead(200,{'Content-Type':file.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream'}).end(b)}catch{res.writeHead(404).end()}});await new Promise(r=>server.listen(4173,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,chromiumSandbox:false});const cases=[];
try{
 for(const screen of ['landing','sources','dashboard','login','pricing','processing','verify','install'])for(const theme of ['dark','light'])for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:width===1440?900:844},locale:'ru-RU',reducedMotion:'reduce',isMobile:width<600,hasTouch:width<600});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin==='http://127.0.0.1:4173'?route.continue():route.abort('blockedbyclient'));
  await page.goto(`http://127.0.0.1:4173/prototype.html?screen=${screen}&theme=${theme}${screen==='processing'?'&state=error':''}`,{waitUntil:'networkidle'});
  await page.screenshot({path:`${out}/proposed-${screen}-${theme}-${width}.png`,fullPage:false});
  if(width===390&&theme==='dark')await page.screenshot({path:`${out}/proposed-${screen}-${theme}-${width}-full.png`,fullPage:true});
  const a=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
  const data=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,heading:document.querySelector('h1')?.textContent,controls:[...document.querySelectorAll('input,button,a.button')].map(e=>{const r=e.getBoundingClientRect();return{text:e.innerText||e.getAttribute('aria-label'),tag:e.tagName,type:e.type,x:r.x,y:r.y,width:r.width,height:r.height}})}));
  const row={screen,theme,...data,errors,violations:a.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,nodes:v.nodes.map(n=>({target:n.target,summary:n.failureSummary}))}))};cases.push(row);console.log(JSON.stringify({screen,theme,width,overflow:row.scrollWidth>width+1,errors:errors.length,axe:row.violations.map(v=>v.id)}));await context.close();
 }
 const c=await browser.newContext({viewport:{width:320,height:568},isMobile:true,hasTouch:true});const p=await c.newPage();await p.goto('http://127.0.0.1:4173/prototype.html?screen=landing');await p.screenshot({path:`${out}/proposed-landing-dark-320x568.png`});const first=await p.getByRole('button',{name:'Попробовать бесплатно',exact:true}).boundingBox();cases.push({screen:'landing-short-mobile',width:320,height:568,cta:first,visible:!!first&&first.y+first.height<=568});await c.close();
 const ui=await browser.newContext({viewport:{width:1440,height:900}});const q=await ui.newPage();await q.goto('http://127.0.0.1:4173/prototype.html?screen=verify');
 await q.getByRole('button',{name:'Ответ верный',exact:true}).click();await q.getByRole('button',{name:'Ответ верный',exact:true}).click();if((await q.locator('#check-count').textContent())!=='1')throw new Error('Repeated scenario counted twice');
 await q.getByRole('button',{name:/2\. Нет информации/}).click();await q.getByRole('button',{name:'Поведение верное',exact:true}).click();if((await q.locator('#check-count').textContent())!=='2')throw new Error('Distinct scenario missing');
 await q.goto('http://127.0.0.1:4173/prototype.html?screen=login');await q.locator('#password').fill('demo-password-only');await q.getByRole('button',{name:'Показать',exact:true}).click();if(await q.locator('#password').getAttribute('type')!=='text')throw new Error('Password toggle failed');await q.getByRole('button',{name:'Скрыть',exact:true}).click();await ui.close();
 await fs.writeFile(`${out}/checks.json`,JSON.stringify({browser:browser.version(),cases,interactiveChecks:['distinct-scenario-counter','password-visibility'],serverMutations:0},null,2));
 if(cases.some(c=>c.errors?.length||c.violations?.length||c.scrollWidth>c.width+1||c.visible===false))process.exitCode=1;
}finally{await browser.close();await new Promise(r=>server.close(r));}
