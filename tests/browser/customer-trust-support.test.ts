import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { chromium, type Frame } from 'playwright';
import { expect, it } from 'vitest';
import path from 'node:path';

const app = 'https://sufler.invalid', desk = 'https://desk.invalid', wrong = 'https://other.invalid';
const fakeSdk = `
          const frame=document.createElement('iframe');
          frame.src='${desk}/frame'; frame.id='libredesk-widget-dedicated';document.body.append(frame);
          for(const url of ['${desk}/decoy','${wrong}/frame']) {
            const other=document.createElement('iframe');other.src=url;document.body.append(other);
          }
          window.Libredesk={setUser:jwt=>frame.contentWindow.postMessage({jwt},'${desk}'),
            show(){},hide(){},logout(){},destroy(){frame.remove()}};
`;
const fakeIntegrity = 'sha384-' + createHash('sha384').update(fakeSdk).digest('base64');
const bundle = async () => (await build({
  stdin: {
    contents: `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {CustomerSupportPanel} from './apps/web/src/app/support/CustomerSupportPanel';
  createRoot(document.querySelector('main')).render(React.createElement(CustomerSupportPanel,{accountId:'owner'}));
`, resolveDir: path.resolve('.')
  }, bundle: true, write: false, outdir: 'out', format: 'iife', jsx: 'automatic',
  plugins: [{name:'test-sdk-pin',setup(build) {build.onLoad({filter:/customer-support-sdk-integrity\.ts$/},()=>({contents:'export const CUSTOMER_SUPPORT_SDK_INTEGRITY='+JSON.stringify(fakeIntegrity),loader:'ts'}));}}],
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' }
})).outputFiles[0]!.text;

it('Libredesk readiness and identity transitions never reveal the previous conversation', async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let signed = 0, scripts = 0, viewer = 'owner', rejectSdk = false, probes = 0;
  const history: string[] = [];
  const js = await bundle();
  try {
    await context.route('**/*', async route => {
      const u = new URL(route.request().url());
      if (u.origin === app && u.pathname === '/api/support/sdk') {
        scripts++;
        return route.fulfill({
          contentType: 'application/javascript', body: rejectSdk ? fakeSdk + ';window.mutated=true' : fakeSdk});
      }
      if (u.origin === app) {
        if (u.pathname === '/support' && !u.search) return route.fulfill({ contentType: 'text/html', body: '<html lang="ru"><main></main><script src="/app.js"></script></html>' });
        if (u.pathname === '/app.js') return route.fulfill({ contentType: 'application/javascript', body: js });
        if (u.pathname === '/api/support/session') {
          signed++;
          if (route.request().postDataJSON().account_id !== viewer) return route.fulfill({ status: 403, json: {} });
          return route.fulfill({ json: { data: { baseURL: desk, inboxID: 'dedicated', jwt: 'signed-owner', authority: viewer, exp: Date.now() / 1000 + 60 } } });
        }
        if (u.pathname === '/api/support/authority') {
          probes++;
          return route.fulfill({ status: viewer ? 200 : 401, json: { data: { authority: viewer } } });
        }
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
      }
      if (u.origin === desk && u.pathname === '/history') {
        history.push(u.searchParams.get('user')!);
        return route.fulfill({ json: [] });
      }
      if ([desk, wrong].includes(u.origin)) return route.fulfill({
        contentType: 'text/html', body: `<script>
        addEventListener('message',async e=>{
          if(e.data.jwt==='signed-owner'){
            await fetch('/history?user=owner');
            document.documentElement.dataset.identified='yes'; parent.postMessage({type:'STORE_SESSION',token:'fake-session'},'${app}');
          }
        });
      </script>`});
      throw Error('unexpected request');
    });
    const page = await context.newPage();
    await page.clock.install();
    const other = await context.newPage();
    await other.goto(app + '/account');
    await page.goto(app + '/support');
    await page.getByRole('button', { name: 'Открыть чат' }).waitFor();
    expect([scripts, signed, history.length]).toEqual([0, 0, 0]);
    const outer = page.locator('#support-conversation > iframe');
    const open = async () => {
      await page.getByRole('button', { name: 'Открыть чат' }).click();
      await expect.poll(() => page.frames().some(f => f.url() === desk + '/decoy')).toBe(true);
      return page.frames().find(f => f.url() === desk + '/frame')!;
    };
    const tell = (frame: Frame, type: string) => frame.evaluate(type => window.parent.postMessage({ type }, '*'), type);
    let frame = await open();
    for (const url of [wrong + '/frame', desk + '/decoy']) {
      await tell(page.frames().find(f => f.url() === url)!, 'WIDGET_LOADED');
      expect(await outer.isVisible()).toBe(false);
    }
    await tell(frame, 'VUE_APP_READY');
    await expect.poll(() => history.length).toBe(1);
    await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.identified)).toBe('yes');
    await tell(frame, 'WIDGET_LOADED');
    await expect.poll(() => outer.isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Закрыть чат' }).click();
    await expect.poll(() => page.getByRole('button', { name: 'Открыть чат' }).evaluate(b => b === document.activeElement)).toBe(true);
    await page.getByRole('button', { name: 'Открыть чат' }).click();
    await expect.poll(() => outer.isVisible()).toBe(true);
    expect([signed, scripts, history.length]).toEqual([1, 1, 1]);
    viewer = 'second-account';
    await other.evaluate(() => { const c = new BroadcastChannel('n6-auth'); c.postMessage('changed'); c.close(); });
    await expect.poll(() => outer.count()).toBe(0);
    await page.getByRole('button', { name: 'Открыть чат' }).click();
    await page.getByRole('alert').waitFor();
    expect(scripts).toBe(1);
    for (const signal of ['focus', 'pageshow', 'storage']) {
      viewer = 'owner'; frame = await open();
      const before = probes;
      viewer = '';
      if (signal === 'storage') await other.evaluate(() => localStorage.setItem('n6_auth_epoch', String(Date.now())));
      else await page.evaluate(type => window.dispatchEvent(type === 'pageshow' ? new PageTransitionEvent(type, { persisted: true }) : new Event(type)), signal);
      await expect.poll(() => probes).toBeGreaterThan(before);
      await expect.poll(() => outer.count()).toBe(0);
      expect(frame.isDetached()).toBe(true);
      expect(history).toEqual(['owner']);
    }
    viewer = 'owner'; frame = await open();
    await tell(frame, 'WIDGET_LOADED'); // readiness after failed JWT exchange
    await page.getByRole('alert').waitFor();
    expect(await outer.count()).toBe(0);
    viewer = 'owner';
    frame = await open();
    await tell(frame, 'VUE_APP_READY');
    await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.identified)).toBe('yes');
    await tell(frame, 'WIDGET_LOADED');
    await expect.poll(() => outer.isVisible()).toBe(true);
    viewer = '';
    await page.clock.fastForward(15_001);
    await expect.poll(() => outer.count()).toBe(0);
    viewer = 'owner';
    rejectSdk = true;
    await page.getByRole('button', { name: 'Открыть чат' }).click();
    await page.getByRole('alert').waitFor();
    expect(await outer.count()).toBe(0);
  } finally { await context.close(); await browser.close(); }
}, 45000);
