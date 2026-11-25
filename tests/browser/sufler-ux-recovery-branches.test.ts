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
const silentSdk = 'document.documentElement.dataset.vendorScriptLoaded="yes";';
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
hydrateRoot(document.querySelector('main'),createElement(components[screen.name],screen.props));
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
    if (url.pathname === '/peer' || url.pathname === '/support' && url.search === '?widget=1') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
    }
    const view: Screen = url.pathname === '/dashboard' ? { name: 'notice', props: { context: owner } } : screen;
    const body = documentFor(!first && view.name === 'notice' ? { ...view, seed: undefined } : view);
    first = false;
    return route.fulfill({ contentType: 'text/html', body });
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
