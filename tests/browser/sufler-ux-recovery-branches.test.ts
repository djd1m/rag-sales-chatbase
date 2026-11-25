import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PreviewStart } from '../../apps/web/src/app/preview/PreviewStart';
import { PreviewScreen } from '../../apps/web/src/app/preview/[jobId]/PreviewScreen';
import { PreviewClaimNotice } from '../../apps/web/src/app/dashboard/PreviewClaimNotice';
import { CustomerSupportPanel } from '../../apps/web/src/app/support/CustomerSupportPanel';
import type { PreviewIntent } from '../../apps/web/src/lib/preview-intent';
import type { PreviewClaimOutcome } from '../../apps/web/src/lib/preview-claim-notice';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, replace() {} }) }));
const origin = 'https://recovery.example.test';
const jobId = 'ebd7a30e-22ef-402e-a048-42cbff85312a';
const owner = 'A'.repeat(43);
const api = '/api/preview/' + jobId;
const running = { index_job_id: jobId, state: 'running', pages_done: 7, chunks_done: 14, pages_total: 20, page_budget: 20 };
const done = { ...running, state: 'done', questions_left: 3, site: { host: 'docs.example.test', title: 'Доставка', h1: 'Сроки', suggestions: ['Когда доставка?'] } };
const cited = { status: 'answered', first_answer: true, text: 'Через два дня.', source: { title: 'Сроки', url: 'https://docs.example.test/delivery', excerpt: 'Доставка занимает два дня.' } };
// This inert vendor fixture has two modes: a silent load and a local identified conversation.
const silentSdk = `
document.documentElement.dataset.vendorScriptLoaded="yes";
if (parent.document.documentElement.dataset.vendorMode === 'conversation') {
  const desk = 'https://desk.example.test';
  const embed = document.createElement('iframe');
  embed.id = 'libredesk-widget-dedicated';
  embed.src = desk + '/frame';
  document.body.append(embed);
  const log = parent.document.querySelector('main');
  function record(action) { log.dataset.vendorActions = (log.dataset.vendorActions || '') + action + ' '; }
  document.cookie = 'session=first; Path=/';
  document.cookie = 'session=; Max-Age=0; Path=/';
  log.dataset.erased = String(!document.cookie);
  window.Libredesk = {
    setUser(jwt) { embed.contentWindow.postMessage({jwt},desk); },
    show() {record('show')}, hide() {record('hide')},
    logout() {record('logout')}, destroy() {record('destroy');embed.remove()}
  };
}
`;
const pin = 'sha384-' + createHash('sha384').update(silentSdk).digest('base64');
type Screen =
  | { name: 'start'; props: { intent?: PreviewIntent; signedIn?: boolean } }
  | { name: 'job'; props: { jobId: string; signedIn: boolean } }
  | { name: 'notice'; props: { context: string }; seed?: PreviewClaimOutcome }
  | { name: 'support'; props: { accountId: string } };
type Reply = (route: Route, url: URL) => Promise<void>;
const client = `
import {createElement} from 'react';
import {hydrateRoot} from 'react-dom/client';
import {PreviewStart} from './apps/web/src/app/preview/PreviewStart';
import {PreviewScreen} from './apps/web/src/app/preview/[jobId]/PreviewScreen';
import {PreviewClaimNotice} from './apps/web/src/app/dashboard/PreviewClaimNotice';
import {CustomerSupportPanel} from './apps/web/src/app/support/CustomerSupportPanel';
import {storePreviewClaimNotice} from './apps/web/src/lib/preview-claim-notice';
const screen=JSON.parse(document.getElementById('fixture').textContent);
if (screen.seed) storePreviewClaimNotice(screen.seed,screen.props.context);
const components={start:PreviewStart,job:PreviewScreen,notice:PreviewClaimNotice,support:CustomerSupportPanel};
const root=hydrateRoot(document.querySelector('main'),createElement(components[screen.name],screen.props));
window.addEventListener('fixture:leave',()=>root.unmount(),{once:true});
window.addEventListener('fixture:identity',event=>root.render(createElement(components[screen.name],{...screen.props,context:event.detail})));
`;
let browser: Browser, context: BrowserContext, page: Page, bundle: string;
beforeAll(async () => {
  const built = await build({
    stdin: { contents: client, resolveDir: path.resolve('.') }, bundle: true, write: false, outdir: 'out', format: 'iife', jsx: 'automatic',
    alias: { 'next/navigation': path.resolve('tests/browser/next-navigation-shim.ts') }, loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'inert-test-sdk', setup(builder) {
      builder.onLoad({ filter: /customer-support-sdk-integrity\.ts$/ }, () => ({
        contents: 'export const CUSTOMER_SUPPORT_SDK_INTEGRITY=' + JSON.stringify(pin), loader: 'ts',
      }));
    } }],
  });
  bundle = built.outputFiles.find(file => file.path.endsWith('.js'))!.text;
  browser = await chromium.launch();
});
beforeEach(async () => { context = await browser.newContext(); page = await context.newPage(); });
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); });

function markup(screen: Screen) {
  switch (screen.name) {
    case 'start': return renderToString(createElement(PreviewStart, screen.props));
    case 'job': return renderToString(createElement(PreviewScreen, screen.props));
    case 'notice': return renderToString(createElement(PreviewClaimNotice, screen.props));
    case 'support': return renderToString(createElement(CustomerSupportPanel, screen.props));
  }
}
function documentFor(screen: Screen) {
  return '<!doctype html><html lang="ru"><main>' + markup(screen) + '</main><script type="application/json" id="fixture">' +
    JSON.stringify(screen).replace(/</g, '\\u003c') + '</script><script src="/app.js"></script></html>';
}
async function mount(screen: Screen, respond?: Reply, location = '/fixture') {
  let first = true;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/app.js') return route.fulfill({ contentType: 'application/javascript', body: bundle });
    if (url.pathname.startsWith('/api/')) {
      if (respond) return respond(route, url);
      throw Error('Unexpected fixture API request: ' + url.pathname);
    }
    if (url.pathname === '/support' && url.search === '?widget=1') {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><body><h1>Чат поддержки</h1><script>
        if (parent.document.documentElement.dataset.vendorMode === 'restricted') {
          Object.defineProperty(document,'cookie',{configurable:false,get(){return ''}});
        }
      </script></body>` });
    }
    if (url.pathname === '/peer') {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><body></body>' });
    }
    const view: Screen = url.pathname === '/dashboard' ? { name: 'notice', props: { context: owner } } : screen;
    const body = documentFor(!first && view.name === 'notice' ? { ...view, seed: undefined } : view);
    first = false;
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  await page.goto(origin + location);
}
const job = (signedIn = true): Screen => ({ name: 'job', props: { jobId, signedIn } });
const posted = (route: Route) => expect(route.request().method()).toBe('POST');
const alert = () => page.getByRole('alert');
const button = (name: string | RegExp) => page.getByRole('button', { name });

it('rejects credentials locally, prevents duplicate submissions, and reuses the unresolved key when storage is blocked', async () => {
  await context.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Disabled', 'SecurityError'); } }));
  const requests: { key: string; url: string }[] = [];
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  await mount({ name: 'start', props: {} }, async (route, url) => {
    expect(url.pathname).toBe('/api/preview'); posted(route);
    requests.push({ key: route.request().headers()['idempotency-key']!, url: route.request().postDataJSON().url });
    if (requests.length === 1) { await hold; return route.fulfill({ status: 202, json: { data: {} } }); }
    if (requests.length === 2) return route.abort('failed');
    return route.fulfill({ status: 202, json: { data: { index_job_id: jobId } } });
  });
  const input = page.getByLabel('Адрес вашего сайта');
  await input.fill('https://login:password@docs.example.test/');
  await button('Создать бота').click();
  await expect.poll(() => alert().textContent()).toMatch(/без логина и пароля/);
  expect(requests).toHaveLength(0);
  await input.fill('https://docs.example.test');
  await button('Создать бота').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(await button('Запускаем…').isDisabled()).toBe(true);
  await page.locator('form').evaluate(form => (form as HTMLFormElement).requestSubmit());
  release();
  await expect.poll(() => alert().textContent()).toContain('Не удалось запустить');
  expect(requests).toHaveLength(1);
  await button('Создать бота').click();
  await expect.poll(() => alert().textContent()).toContain('Нет связи');
  await button('Создать бота').click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __nav?: string[] }).__nav)).toEqual(['/preview/' + jobId]);
  expect(requests).toHaveLength(3);
  expect(requests[0]!.key).toMatch(/^[\da-f-]{36}$/i);
  expect(requests.every(item => item.key === requests[0]!.key && item.url === 'https://docs.example.test')).toBe(true);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect.poll(() => button('Создать бота').isEnabled()).toBe(true);
});

it('removes a legacy URL from browser history and accepts the launch only after a valid job id', async () => {
  const urls: string[] = [];
  const raw = 'https://materials.example.test/article?note=private';
  await mount({ name: 'start', props: { intent: { mode: 'site', legacy: true } } }, async route => {
    posted(route); urls.push(route.request().postDataJSON().url);
    return route.fulfill({ status: 202, json: { data: { index_job_id: jobId } } });
  }, '/preview?url=' + encodeURIComponent(raw));
  await expect.poll(() => page.evaluate(() => (window as Window & { __nav?: string[] }).__nav)).toEqual(['/preview/' + jobId]);
  expect(urls).toEqual([raw]);
  expect(new URL(page.url()).search).toBe('');
  expect(await page.getByLabel('Адрес вашего сайта').inputValue()).toBe('');
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain('private');
});

it('retains the last progress after a failed poll and gives the visitor a recovery path for missing or malformed results', async () => {
  let reads = 0;
  await page.clock.install();
  await mount(job(), async (route, url) => {
    expect(url.pathname).toBe(api);
    reads++;
    if (reads === 1) return route.fulfill({ json: { data: running } });
    if (reads === 2) return route.abort('failed');
    if (reads === 3) return route.fulfill({ json: { data: { state: 'invalid' } } });
    if (reads === 4) return route.fulfill({ json: { data: { ...done, site: null } } });
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
  });
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.clock.fastForward(2100);
  await expect.poll(() => alert().textContent()).toContain('Нет связи');
  await page.getByText(/Последнее известное состояние:.*7.*14/).waitFor();
  await button('Проверить состояние').click();
  await expect.poll(() => alert().textContent()).toContain('не вернул состояние');
  await button('Проверить состояние').click();
  await page.getByRole('heading', { name: /Чтение завершено, но данные/ }).waitFor();
  await button('Проверить состояние').click();
  await page.getByRole('heading', { name: 'Предпросмотр недоступен' }).waitFor();
  expect(await page.getByRole('link', { name: 'Начать с PDF' }).getAttribute('href')).toBe('/preview?source=pdf');
  expect(await page.getByRole('link', { name: 'Мои боты' }).getAttribute('href')).toBe('/dashboard');
  expect(reads).toBe(5);
});

it('retains a failed question, renders its first verified citation and recovers from each claim outcome', async () => {
  const questions: string[] = [];
  const claims = [
    [401,'auth_required','Войдите повторно','Войти в аккаунт','/login?from=preview'],
    [409,'already_claimed','Уже сохранён','Мои боты','/dashboard'],
    [409,'plan_limit','Достигнут предел','Сравнить планы','/pricing'],
    [404,'not_found','Черновик истёк','Выбрать материал','/preview'],
  ] as const;
  let saves = 0;
  await mount(job(), async (route, url) => {
    if (url.pathname === api) return route.fulfill({ json: { data: done } });
    posted(route);
    if (url.pathname === api + '/ask') {
      questions.push(route.request().postDataJSON().question);
      if (questions.length === 1) return route.fulfill({ status: 502, body: 'offline' });
      if (questions.length === 2) return route.abort('failed');
      return route.fulfill({ json: { data: cited } });
    }
    expect(url.pathname).toBe(api + '/claim');
    const failure = claims[saves++];
    if (failure) return route.fulfill({ status: failure[0], json: { error: { code: failure[1], message: failure[2] } } });
    if (saves === 5) return route.abort('failed');
    return route.fulfill({ headers: { 'X-Sufler-Claim-Context': owner }, json: { data: { bot_id: 'fixture-bot' } } });
  });
  const input = page.getByLabel('Ваш вопрос');
  await input.fill(' Когда? ');
  await button('Спросить').click();
  await expect.poll(() => alert().textContent()).toContain('Не удалось получить');
  expect(await input.inputValue()).toBe(' Когда? ');
  await button('Спросить').click();
  await expect.poll(() => alert().textContent()).toContain('Нет связи');
  await button('Спросить').click();
  await page.getByText(cited.source.excerpt).waitFor();
  expect(questions).toEqual(['Когда?','Когда?','Когда?']);
  expect(await page.getByRole('link', { name: 'Открыть страницу ↗' }).getAttribute('href')).toBe(cited.source.url);
  expect(await input.inputValue()).toBe('');
  await page.getByText(/Осталось вопросов сегодня: 2/).waitFor();
  const save = button('Сохранить бота и поставить на сайт');
  for (const failure of claims) {
    await save.click();
    await expect.poll(() => alert().textContent()).toContain(failure[2]);
    expect(await alert().getByRole('link', { name: failure[3] }).getAttribute('href')).toBe(failure[4]);
  }
  await save.click();
  await expect.poll(() => alert().textContent()).toContain('Повторите сохранение');
  await save.click();
  await page.waitForURL(origin + '/dashboard');
  await page.getByRole('status').filter({ hasText: 'сохранён в вашем аккаунте' }).waitFor();
  expect(saves).toBe(6);
});

const noticeCases = [
  ['claimed','сохранён в вашем аккаунте','pagehide'],
  ['already_claimed','уже сохранили','pageshow'],
  ['expired','Срок предпросмотра истёк','storage'],
  ['not_found','Предпросмотр не найден','broadcast'],
  ['plan_limit','достигнут предел','reload'],
  ['unavailable','временно недоступен','storage-fallback'],
] as const;
for (const [outcome,message,signal] of noticeCases) it('retires the one-time ' + outcome + ' notice on ' + signal, async () => {
  if (signal === 'storage-fallback') await context.addInitScript(() => Object.defineProperty(window, 'BroadcastChannel', { value: undefined }));
  await mount({ name: 'notice', props: { context: owner }, seed: outcome });
  const notice = page.getByRole('status');
  await notice.filter({ hasText: message }).waitFor();
  if (outcome === 'plan_limit') expect(await notice.getByRole('link').getAttribute('href')).toBe('/pricing');
  if (outcome === 'expired' || outcome === 'not_found') expect(await notice.getByRole('link').getAttribute('href')).toBe('/preview');
  if (signal === 'reload') await page.reload();
  else if (signal === 'pagehide' || signal === 'pageshow') {
    await page.evaluate(type => dispatchEvent(new PageTransitionEvent(type, { persisted: true })), signal);
  } else {
    const peer = await context.newPage();
    await peer.goto(origin + '/peer');
    if (signal === 'broadcast') await peer.evaluate(() => {
      const channel = new BroadcastChannel('n6-auth'); channel.postMessage('changed'); channel.close();
    });
    else await peer.evaluate(() => localStorage.setItem('n6_auth_epoch', String(Date.now())));
  }
  await expect.poll(() => notice.count()).toBe(0);
});

it('removes the silent support frame on timeout, restores focus when cancelled and can retry after SDK failure', async () => {
  let signings = 0, scripts = 0;
  await page.clock.install();
  await mount({ name: 'support', props: { accountId: 'owner' } }, async (route, url) => {
    if (url.pathname === '/api/support/session') {
      posted(route); expect(route.request().postDataJSON()).toEqual({ account_id: 'owner' }); signings++;
      return route.fulfill({ json: { data: { authority: 'owner', baseURL: 'https://desk.example.test', inboxID: 'dedicated', jwt: 'test-only', exp: Math.ceil(Date.now()/1000)+600 } } });
    }
    if (url.pathname === '/api/support/authority') return route.fulfill({ json: { data: { authority: 'owner' } } });
    expect(url.pathname).toBe('/api/support/sdk');
    scripts++;
    return scripts === 2 ? route.abort('failed') : route.fulfill({ contentType: 'text/javascript', body: silentSdk });
  });
  const open = button('Открыть чат'), frames = page.locator('#support-conversation > iframe');
  await open.click();
  await expect.poll(() => scripts).toBe(1);
  expect(await frames.isHidden()).toBe(true);
  await page.clock.fastForward(8100);
  await alert().filter({ hasText: 'Чат недоступен' }).waitFor();
  expect(await frames.count()).toBe(0);
  await open.click();
  await expect.poll(() => scripts).toBe(2);
  await alert().filter({ hasText: 'Чат недоступен' }).waitFor();
  expect(await frames.count()).toBe(0);
  await open.click();
  await expect.poll(() => scripts).toBe(3);
  await button('Закрыть чат').click();
  await expect.poll(() => open.evaluate(el => el === document.activeElement)).toBe(true);
  expect(await frames.count()).toBe(0);
  expect(signings).toBe(3);
});

it('retires claim notices when the signed-in account changes and disposes the dashboard on leaving', async () => {
  await mount({ name: 'notice', props: { context: owner }, seed: 'claimed' });
  await page.getByRole('status').filter({ hasText: 'сохранён в вашем аккаунте' }).waitFor();
  const peer = await context.newPage();
  await peer.goto(origin + '/peer');
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect.poll(() => page.getByRole('status').count()).toBe(0);
  await page.evaluate(() => dispatchEvent(new CustomEvent('fixture:identity', { detail: 'B'.repeat(43) })));
  await peer.evaluate(() => { const channel = new BroadcastChannel('n6-auth'); channel.postMessage('changed'); channel.close(); });
  await page.evaluate(() => dispatchEvent(new CustomEvent('fixture:leave')));
  expect(await page.locator('main').innerHTML()).toBe('');
  await page.reload();
  expect(await page.getByRole('status').count()).toBe(0);
});

for (const signedIn of [true, false]) it('continues sharing after a failed metric with signedIn=' + signedIn, async () => {
  let claims = 0, shares = 0;
  await mount(job(signedIn), async (route, url) => {
    if (url.pathname === api) return route.fulfill({ json: { data: done } });
    posted(route);
    if (url.pathname === api + '/ask') return route.fulfill({ json: { data: cited } });
    if (url.pathname === api + '/share') { shares++; return route.abort('failed'); }
    expect(url.pathname).toBe(api + '/claim'); claims++;
    return route.fulfill({ status: 409, json: { error: { code: 'plan_limit', message: 'Этот план заполнен.' } } });
  });
  await button('Когда доставка?').click();
  await page.getByText(cited.source.excerpt).waitFor();
  await button('Поделиться ссылкой на бота').click();
  if (signedIn) {
    await alert().filter({ hasText: 'Этот план заполнен.' }).waitFor();
    expect(await alert().getByRole('link').getAttribute('href')).toBe('/pricing');
  } else {
    await expect.poll(() => page.evaluate(() => (window as Window & { __nav?: string[] }).__nav)).toEqual(['/login?mode=register&from=preview']);
  }
  expect([shares,claims]).toEqual([1,Number(signedIn)]);
});

it('shows conversational and unavailable answers, then keeps the exact daily-limit explanation', async () => {
  const responses = [
    { status: 'small_talk', text: 'Здравствуйте!' }, { status: 'unknown', text: 'Срок не указан.' },
  ];
  let attempts = 0;
  await mount(job(), async (route, url) => {
    if (url.pathname === api) return route.fulfill({ json: { data: done } });
    expect(url.pathname).toBe(api + '/ask'); posted(route);
    const response = responses[attempts++];
    return response ? route.fulfill({ json: { data: response } })
      : route.fulfill({ status: 429, json: { error: { code: 'limit_preview', message: 'Лимит предпросмотра исчерпан.' } } });
  });
  for (const answer of ['Здравствуйте!', 'Срок не указан.', 'Лимит предпросмотра исчерпан.']) {
    await page.getByLabel('Ваш вопрос').fill('Где узнать срок?');
    await button('Спросить').click();
    await page.locator('li.chat-answer').filter({ hasText: answer }).waitFor();
  }
  await page.getByText(/Осталось вопросов сегодня: 0/).waitFor();
  expect(await page.getByLabel('Ваш вопрос').inputValue()).toBe('');
  expect(attempts).toBe(3);
});

it('expires the isolated chat session on authority change and releases the SDK listeners when leaving', async () => {
  const desk = 'https://desk.example.test';
  let authority = 'owner', signings = 0, probes = 0;
  await page.route(desk + '/frame', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<script>
    addEventListener('message', event => {
      if(event.origin===${JSON.stringify(origin)} && event.data.jwt==='example-assertion') {
        document.documentElement.dataset.account='owner';
        parent.postMessage({type:'STORE_SESSION',token:'session-for-fixture'},${JSON.stringify(origin)});
      }
    });
  </script>` }));
  await mount({ name: 'support', props: { accountId: 'owner' } }, async (route, url) => {
    if (url.pathname === '/api/support/authority') { probes++; return route.fulfill({ json: { data: { authority } } }); }
    if (url.pathname === '/api/support/session') {
      posted(route); signings++;
      return route.fulfill({ json: { data: { authority: 'owner', baseURL: desk, inboxID: 'dedicated', jwt: 'example-assertion', exp: Date.now()/1000 + 600 } } });
    }
    expect(url.pathname).toBe('/api/support/sdk');
    return route.fulfill({ contentType: 'text/javascript', body: silentSdk });
  });
  await page.evaluate(() => { document.documentElement.dataset.vendorMode = 'conversation'; document.cookie = 'merchant=fixture; Path=/'; });
  const opener = button('Открыть чат'), outer = page.locator('#support-conversation > iframe');
  await opener.click();
  await expect.poll(() => page.frames().some(frame => frame.url() === desk + '/frame')).toBe(true);
  const frame = page.frames().find(frame => frame.url() === desk + '/frame')!;
  const tell = (type: string) => frame.evaluate(message => parent.postMessage({ type: message }, '*'), type);
  await tell('VUE_APP_READY');
  await expect.poll(() => frame.evaluate(() => document.documentElement.dataset.account)).toBe('owner');
  await tell('WIDGET_LOADED');
  await expect.poll(() => outer.isVisible()).toBe(true);
  const frameHeading = page.frameLocator('#support-conversation > iframe').locator('h1');
  expect(await frameHeading.textContent()).toBe('Чат поддержки');
  expect(await frameHeading.isHidden()).toBe(true);
  expect(await page.locator('main').getAttribute('data-erased')).toBe('true');
  expect(await page.evaluate(() => document.cookie)).toBe('merchant=fixture');
  await button('Закрыть чат').click();
  expect(await outer.isHidden()).toBe(true);
  await opener.click();
  await expect.poll(() => outer.isVisible()).toBe(true);
  expect(signings).toBe(1);
  authority = 'another-account';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await alert().waitFor();
  expect(await outer.count()).toBe(0);
  expect(await page.locator('main').getAttribute('data-vendor-actions')).toBe('show hide show logout destroy ');
  expect(frame.isDetached()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:leave')));
  const last = probes;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(probes).toBe(last);
  expect(await page.locator('main').innerHTML()).toBe('');
});

it('cancels an unresolved support session when the user returns to another document', async () => {
  let signing = false, scripts = 0;
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await mount({ name: 'support', props: { accountId: 'owner' } }, async (route, url) => {
    if (url.pathname === '/api/support/authority') return route.fulfill({ json: { data: { authority: 'owner' } } });
    if (url.pathname === '/api/support/session') {
      signing = true; await delayed;
      return route.fulfill({ json: { data: { authority: 'owner', baseURL: 'https://desk.example.test', inboxID: 'dedicated', jwt: 'obsolete', exp: Date.now()/1000 + 120 } } });
    }
    scripts++; return route.abort();
  });
  await button('Открыть чат').click();
  await expect.poll(() => signing).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  const delivered = page.waitForResponse(response => response.url() === origin + '/api/support/session');
  release(); await delivered;
  await expect.poll(() => button('Открыть чат').isEnabled()).toBe(true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  expect(scripts).toBe(0);
  expect(await page.locator('#support-conversation iframe').count()).toBe(0);
});

it('offers a retry without loading the SDK if browser privacy settings prevent session isolation', async () => {
  let requests = 0;
  await mount({ name: 'support', props: { accountId: 'owner' } }, async (route, url) => {
    if (url.pathname === '/api/support/authority') return route.fulfill({ json: { data: { authority: 'owner' } } });
    if (url.pathname === '/api/support/session') return route.fulfill({ json: { data: {
      authority: 'owner', baseURL: 'https://desk.example.test', inboxID: 'dedicated', jwt: 'example-session', exp: Date.now()/1000 + 60,
    } } });
    requests++; return route.abort();
  });
  await page.evaluate(() => { document.documentElement.dataset.vendorMode = 'restricted'; });
  await button('Открыть чат').click();
  await alert().filter({ hasText: 'Чат недоступен' }).waitFor();
  expect(await button('Открыть чат').isEnabled()).toBe(true);
  expect(await page.locator('#support-conversation iframe').count()).toBe(0);
  expect(requests).toBe(0);
});
