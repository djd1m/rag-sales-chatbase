import { request } from '/opt/audit/node_modules/playwright/index.mjs';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
const out='/artifacts/reference';await fs.mkdir(out,{recursive:true});
const picks=[['chatbase-first-agent','dashboard',/New AI Agent button/],['chatbase-first-agent','onboarding',/How would you like to train/],['chatbase-sources','files',/Add file panel/],['chatbase-sources','website',/Add website panel/],['chatbase-sources','source-states',/Fetched links tab/],['chatbase-playground','playground',/Playground previewing/],['chatbase-first-agent','deploy',/chat widget embed tab/],['chatbase-first-agent','embed-code',/JavaScript embed code/],['chatbase-first-agent','widget',/Live AI Agent Chat Bubble/]];
const context=await request.newContext({timeout:25000});const saved=[];
try{for(const [doc,name,pattern] of picks){
 const data=JSON.parse(await fs.readFile(`/artifacts/discovery/${doc}.json`,'utf8'));const image=data.images.find(i=>pattern.test(i.alt));if(!image)throw new Error('missing '+name);
 const u=new URL(image.src);if(u.hostname!=='mintcdn.com')throw new Error('unexpected image origin');u.search='';
 const r=await context.get(u.toString());if(!r.ok())throw new Error('image unavailable '+name);
 const bytes=await r.body();const mime=r.headers()['content-type'];const ext=mime.includes('webp')?'webp':mime.includes('jpeg')?'jpg':'png';
 const file=`chatbase-doc-${name}.${ext}`;await fs.writeFile(`${out}/${file}`,bytes);
 saved.push({name,file,kind:'official-documentation-illustration',doc:data.url,imageUrl:u.toString(),alt:image.alt,downloaded:'2026-11-25',screenshotDate:'not-specified-by-publisher',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),mime});
 console.log(name,r.status(),bytes.length);
}await fs.writeFile(`${out}/sources.json`,JSON.stringify(saved,null,2));}finally{await context.dispose()}
