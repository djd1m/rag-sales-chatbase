import { chromium } from '/opt/audit/node_modules/playwright/index.mjs';
import AxeBuilder from '/opt/audit/node_modules/@axe-core/playwright/dist/index.mjs';
import fs from 'node:fs/promises';
const out='/artifacts/public';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,chromiumSandbox:false});const rows=[];
const definitions=[['home','/'],['pricing','/pricing'],['login','/login'],['register','/login?mode=register'],['preview','/preview']];
async function guard(page){await page.route('**/*',route=>{
 const r=route.request(),h=r.headers();
 if(!['GET','HEAD','OPTIONS'].includes(r.method())||h['next-router-prefetch']==='1'||h.purpose==='prefetch')return route.abort('blockedbyclient');
 return route.continue();
});}
async function metrics(page){return page.evaluate(()=>{
 const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'};
 const desc=e=>e.id?'#'+e.id:e.tagName.toLowerCase()+(e.className&&typeof e.className==='string'?'.'+e.className.trim().split(/\s+/).join('.'):'');
 const list=[...document.querySelectorAll('a,button,input,textarea,select,summary,[role=button]')].filter(visible).map(e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {selector:desc(e),text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.name||'').slice(0,130),tag:e.tagName,type:e.type,box:{x:r.x,y:r.y,width:r.width,height:r.height},fontSize:parseFloat(s.fontSize),outline:s.outline,invalid:e.getAttribute('aria-invalid')}});
 return {title:document.title,url:location.href,theme:document.documentElement.dataset.theme,width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,pageHeight:document.documentElement.scrollHeight,heading:document.querySelector('h1')?.innerText,controls:list,overflowElements:[...document.body.querySelectorAll('*')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.left< -1||r.right>innerWidth+1}).slice(0,15).map(desc)};
});}
try{
 for(const [name,path] of definitions)for(const theme of ['dark','light']){
  const context=await browser.newContext({viewport:{width:1440,height:900},locale:'ru-RU',reducedMotion:'reduce'});
  await context.addCookies([{name:'n6_theme',value:theme,url:'https://sufler.site'}]);
  const page=await context.newPage();await guard(page);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const width of [320,360,390,414,768,1024,1440]){
   await page.setViewportSize({width,height:width===1440?900:width===768?1024:844});
   const response=await page.goto('https://sufler.site'+path,{waitUntil:'domcontentloaded',timeout:25000});
   await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(650);
   const data=await metrics(page);const key=`sufler-${name}-${theme}-${width}`;
   if([320,390,1440].includes(width)){
    await page.screenshot({path:`${out}/${key}.png`,fullPage:false});
    if(width===1440||width===390)await page.screenshot({path:`${out}/${key}-full.png`,fullPage:true});
   }
   let axe=null;if([390,1440].includes(width)){
    try{const a=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();axe={violations:a.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,helpUrl:v.helpUrl,nodes:v.nodes.slice(0,12).map(n=>({target:n.target,summary:n.failureSummary}))})),incomplete:a.incomplete.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.length})),passes:a.passes.length};}catch(e){axe={error:e.name};}
   }
   const row={key,name,theme,width,http:response.status(),...data,errors:[...errors],axe};rows.push(row);await fs.writeFile(`${out}/${key}.json`,JSON.stringify(row,null,2));
   console.log(JSON.stringify({key,http:row.http,horizontalOverflow:row.scrollWidth>width+1,axe:axe?.violations?.map(v=>v.id)||[],height:row.pageHeight}));
  }
  await context.close();
 }
 await fs.writeFile(`${out}/summary.json`,JSON.stringify({browser:browser.version(),playwright:'1.64.1',cases:rows},null,2));
}finally{await browser.close();}
