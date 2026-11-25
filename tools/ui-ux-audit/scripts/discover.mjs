import { chromium } from '/opt/audit/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const out='/artifacts/discovery';await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,chromiumSandbox:false});
const targets=[['sufler','https://sufler.site/'],['chatbase','https://www.chatbase.co/'],['chatbase-first-agent','https://www.chatbase.co/docs/user-guides/quick-start/your-first-agent'],['chatbase-playground','https://www.chatbase.co/docs/user-guides/chatbot/playground'],['chatbase-sources','https://www.chatbase.co/docs/user-guides/chatbot/data-sources']];
const summary=[];
try{
 for(const [name,url] of targets){
  const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',reducedMotion:'reduce'});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  // Observation only: no user-data mutation or AI/source-indexing requests.
  await page.route('**/*',route=>['GET','HEAD','OPTIONS'].includes(route.request().method())?route.continue():route.abort('blockedbyclient'));
  try{
   const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(2000);await page.evaluate(()=>document.fonts.ready);
   const data=await page.evaluate(()=>({title:document.title,url:location.href,theme:document.documentElement.dataset.theme,
    text:document.body.innerText.slice(0,14000),links:[...document.querySelectorAll('a[href]')].map(a=>({text:(a.innerText||a.getAttribute('aria-label')||'').trim().slice(0,100),href:a.href})).filter(a=>a.text),
    controls:[...document.querySelectorAll('input,button,select,textarea')].map(e=>({tag:e.tagName,type:e.type,name:e.getAttribute('name'),text:e.innerText?.slice(0,100),label:e.getAttribute('aria-label'),placeholder:e.getAttribute('placeholder')})),
    images:[...document.images].map(i=>({alt:i.alt,src:i.currentSrc||i.src,width:i.naturalWidth,height:i.naturalHeight})).filter(i=>i.width>400),
    width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));
   await page.screenshot({path:`${out}/${name}.png`,fullPage:false});
   await fs.writeFile(`${out}/${name}.json`,JSON.stringify({...data,http:response?.status(),errors},null,2));
   summary.push({name,http:response?.status(),title:data.title,url:data.url,links:data.links.length,images:data.images.length});
  }catch(e){summary.push({name,error:e.name});}
  await context.close();
 }
 await fs.writeFile(`${out}/summary.json`,JSON.stringify({browser:browser.version(),playwright:'1.64.1',results:summary},null,2));
 console.log(JSON.stringify({browser:browser.version(),results:summary},null,2));
}finally{await browser.close();}
