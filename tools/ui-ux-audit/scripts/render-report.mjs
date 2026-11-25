import {chromium} from '/opt/audit/node_modules/playwright/index.mjs';
import http from 'node:http';import path from 'node:path';import fs from 'node:fs/promises';
const root='/artifacts/report';const mime={'.html':'text/html; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp','.md':'text/plain; charset=utf-8'};
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://local');const f=path.resolve(root,'.'+decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname));if(!f.startsWith(root+'/'))return res.writeHead(403).end();res.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream'}).end(await fs.readFile(f))}catch{res.writeHead(404).end()}});await new Promise(r=>server.listen(4173,'127.0.0.1',r));
const b=await chromium.launch({headless:true,chromiumSandbox:false});const report={};
try{
 const c=await b.newContext({viewport:{width:1700,height:1100}});const p=await c.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto('http://127.0.0.1:4173/index.html',{waitUntil:'networkidle'});
 if(await p.locator('.comparison').count()!==9)throw new Error('Expected 9 cards');
 await p.locator('[data-filter=P1]').click();report.p1Visible=await p.locator('.comparison:visible').count();if(report.p1Visible!==5)throw new Error('Priority filter failed');
 await p.locator('[data-filter=all]').click();await p.locator('[data-viewport=mobile]').click();const mobile=await p.locator('.frame img').first().getAttribute('src');if(!mobile.includes('390'))throw new Error('Viewport switch failed');await p.locator('[data-viewport=desktop]').click();
 await p.locator('[data-enlarge]').first().click();if(!await p.locator('dialog').evaluate(e=>e.open))throw new Error('Viewer failed');await p.keyboard.press('Escape');if(await p.locator('dialog').evaluate(e=>e.open))throw new Error('Viewer escape failed');
 await p.locator('[data-decision=U01]').selectOption('approve');await p.locator('[data-comment=U01]').fill('UI review test');await p.reload();if(await p.locator('[data-decision=U01]').inputValue()!=='approve')throw new Error('Local decision persistence failed');await p.locator('[data-decision=U01]').selectOption('pending');await p.locator('[data-comment=U01]').fill('');await p.evaluate(()=>localStorage.clear());
 await p.screenshot({path:'/artifacts/report-preview.png',fullPage:false});
 // Lazy images must all be decoded before print. Reviewer decisions are not embedded in PDF.
 await p.evaluate(async()=>{for(const img of document.images){img.loading='eager';if(img.decode)await img.decode().catch(()=>{})}});
 await p.pdf({path:'/artifacts/report/comparison.pdf',format:'A3',landscape:true,printBackground:true,preferCSSPageSize:true});
 report.images=await p.locator('.frame img').count();report.brokenImages=await p.locator('.frame img').evaluateAll(xs=>xs.filter(x=>!x.complete||x.naturalWidth===0).length);if(report.brokenImages)throw new Error('Broken image');
 await p.setViewportSize({width:390,height:844});await p.screenshot({path:'/artifacts/report-mobile-preview.png',fullPage:false});report.mobileOverflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);if(report.mobileOverflow)throw new Error('Gallery mobile overflow');
 report.jsErrors=errors;if(errors.length)throw new Error('Gallery JS errors');report.checks=['9-cards','priority-filter','viewport-switch','image-dialog-and-Escape','local-decision-persistence','all-images-decoded','mobile-layout'];
 await fs.writeFile('/artifacts/report/gallery-checks.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));await c.close();
}finally{await b.close();await new Promise(r=>server.close(r))}
