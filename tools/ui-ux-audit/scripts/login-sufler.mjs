import {chromium} from '/opt/audit/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
const credentials=JSON.parse(await fs.readFile('/artifacts/.private/access.json','utf8')).sufler;
const browser=await chromium.launch({headless:true,chromiumSandbox:false});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'ru-RU',reducedMotion:'reduce'});
 const page=await context.newPage();
 await page.route('**/*',route=>{
  const r=route.request(),u=new URL(r.url());
  if(r.method()==='POST'&&u.origin==='https://sufler.site'&&u.pathname==='/api/auth/login')return route.continue();
  if(['GET','HEAD','OPTIONS'].includes(r.method()))return route.continue();
  return route.abort('blockedbyclient');
 });
 await page.goto('https://sufler.site/login',{waitUntil:'networkidle'});
 await page.locator('input[name=email]').fill(credentials.email);
 await page.locator('input[name=password]').fill(credentials.password);
 await Promise.all([page.waitForURL('**/dashboard**',{timeout:20000}),page.getByRole('button',{name:'Войти',exact:true}).click()]);
 await page.waitForTimeout(800);
 await context.storageState({path:'/artifacts/.private/sufler-state.json'});await fs.chmod('/artifacts/.private/sufler-state.json',0o600);
 const data=await page.evaluate(()=>({title:document.title,url:location.href,text:document.body.innerText,links:[...document.querySelectorAll('a[href]')].map(a=>({text:a.innerText,href:a.href})),controls:[...document.querySelectorAll('input,button,textarea,select')].map(e=>({tag:e.tagName,name:e.name,type:e.type,text:e.innerText||'',label:e.getAttribute('aria-label')}))}));
 await fs.writeFile('/artifacts/.private/dashboard-discovery.json',JSON.stringify(data,null,2),{mode:0o600});
 console.log(JSON.stringify({login:'success',page:new URL(page.url()).pathname,links:data.links.length,controls:data.controls.length,botLinks:data.links.filter(l=>new URL(l.href).pathname.startsWith('/dashboard/bots/')).length}));
 await context.close();
}catch(e){console.log(JSON.stringify({login:'not-completed',error:e.name}));process.exitCode=1;}finally{await browser.close()}
