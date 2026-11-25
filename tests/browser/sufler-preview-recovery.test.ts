// Эти проверки требуют собранный Next в изолированном HTTPS-контуре.
// Перехваты ниже подменяют только явно указанный ответ API, React и маршруты настоящие.
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { randomBytes, randomUUID } from 'node:crypto';
import { domRules } from '../../scripts/responsive/rules.mjs';
import { normalPdf } from '../fixtures/pdf-factory';
import { chmod, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from '../../packages/db/src/index';
import { attachDraft, auditPool, fillSignup, readVerified, registerOwner, testOrigin, verificationLink } from '../fixtures/sufler-source-journey';

let browser: Browser, context: BrowserContext, page: Page, origin: string;
let posts: string[];
let pool: Pool;
const job = randomUUID();
const read = `/api/preview/${job}`;
const running = { index_job_id: job, state: 'running', pages_done: 7, pages_total: 20, page_budget: 20, chunks_done: 14 };
const site = { host: 'example.test', title: 'Доставка', h1: 'Условия доставки', suggestions: ['Когда доставят заказ?'] };
beforeAll(async () => {
  origin = testOrigin();
  pool = auditPool();
  browser = await chromium.launch();
});
beforeEach(async () => {
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  page = await context.newPage();
  posts = [];
  page.on('request', req => { if (req.method() === 'POST') posts.push(new URL(req.url()).pathname); });
});
afterEach(async () => { await context?.close(); });
afterAll(async () => { await browser?.close(); await pool?.end(); });

it('terminal failure begins a new attempt while an unknown POST retains its key', async () => {
  // The database contains a previously accepted launch and its real quota charge.
  // A public numeric address lets CheckAddress run on the isolated stand without DNS.
  const address = 'https://93.184.216.34';
  const original = randomUUID();
  const failed = await attachDraft(pool, context, 'failed', {
    rootUrl: address + '/', key: original, browserToken: randomBytes(32).toString('base64url'),
  });
  await page.goto(origin + '/pricing');
  await page.evaluate(({ address, key }) => sessionStorage.setItem('n6_preview_key:' + address, key), { address, key: original });
  const receipts: { key: string; status: number; job?: string; code?: string; message?: string }[] = [];
  await page.route('**/api/preview', async route => {
    const response = await route.fetch();
    const body = await response.json();
    receipts.push({ key: route.request().headers()['idempotency-key']!, status: response.status(),
      job: body.data?.index_job_id, code: body.error?.code, message: body.error?.message });
    // Lose the response after actual server processing, once per launch attempt.
    if (receipts.length === 1 || receipts.length === 3) await route.abort();
    else await route.fulfill({ response });
  });
  await page.goto(origin + '/preview?url=' + encodeURIComponent(address));
  const form = page.locator('.url-form');
  const offline = form.getByRole('alert').filter({ hasText: 'Нет связи' });
  await offline.waitFor();
  const submit = form.getByRole('button', { name: 'Создать бота' });
  await submit.click();
  await page.getByRole('heading', { name: 'Бот не собрался' }).waitFor();
  expect(receipts.map(r => [r.status, r.job, r.key])).toEqual([[202, failed.jobId, original], [202, failed.jobId, original]]);
  await page.getByRole('link', { name: 'Указать другой адрес' }).click();
  await expect.poll(() => page.locator('#site-url').inputValue()).toBe(address);
  expect(receipts).toHaveLength(2);
  await submit.click();
  await offline.waitFor();
  await page.reload();
  await expect.poll(() => page.locator('#site-url').inputValue()).toBe(address);
  expect(receipts).toHaveLength(3);
  await submit.click();
  await expect.poll(() => receipts.length).toBe(4);
  const fresh = receipts[2]!, replay = receipts[3]!;
  expect(fresh.key).not.toBe(original);
  expect(replay).toEqual(fresh);
  if (replay.status === 429) {
    expect(replay.code).toBe('limit_preview');
    expect(replay.message).toBeTruthy();
    await form.getByRole('alert').filter({ hasText: replay.message! }).waitFor();
  } else {
    expect(replay.status).toBe(202);
    expect(replay.job).toBeTruthy();
    expect(replay.job).not.toBe(failed.jobId);
    await page.waitForURL(origin + '/preview/' + replay.job);
  }
  const rows = await pool.query('SELECT idempotency_key FROM preview WHERE idempotency_key = ANY($1::uuid[])', [[original, fresh.key]]);
  expect(rows.rows.map(r => r.idempotency_key).sort()).toEqual((replay.status === 429 ? [original] : [original, fresh.key]).sort());
});


it('claim failure is announced next to the save action', async () => {
  await page.setViewportSize({ width: 320, height: 568 });
  await registerOwner(context);
  const first = await attachDraft(pool, context, 'done');
  expect((await context.request.post(origin + '/api/preview/' + first.jobId + '/claim', { headers: { origin } })).status()).toBe(200);
  const draft = await attachDraft(pool, context, 'done');
  const path = '/api/preview/' + draft.jobId;
  let asks = 0;
  await page.route('**' + path + '/ask', route => {
    const index = ++asks;
    if (index > 4) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Вопрос временно недоступен' } } });
    const data = index % 2 === 0 ? { status: 'answered', text: 'Ответ по материалам. '.repeat(40), first_answer: index === 2,
      source: { title: 'Доставка', excerpt: 'Доставка стоит 350 ₽.', url: null } }
      : { status: 'unknown', text: 'Нет сведений.', contact: null };
    return route.fulfill({ json: { data } });
  });
  await page.goto(origin + '/preview/' + draft.jobId);
  const input = page.getByRole('textbox', { name: 'Ваш вопрос' });
  for (let i = 1; i <= 4; i++) {
    await input.fill('Вопрос ' + i); await input.press('Enter');
    await expect.poll(() => page.locator('.chat-question').count()).toBe(i);
  }
  expect(await page.locator('.chat-log').evaluate(el => el.clientHeight > 2 * innerHeight)).toBe(true);
  await input.fill('Мой черновик'); await input.press('Enter');
  const askError = page.locator('.chat-window').getByRole('alert').filter({ hasText: 'Вопрос временно недоступен' });
  await askError.waitFor();
  const controls = [
    page.locator('.aha').getByRole('button', { name: 'Сохранить бота и поставить на сайт' }),
    page.locator('.chat-log li').filter({ has: page.getByRole('button', { name: /Сохранить черновик/ }) }).first().getByRole('button'),
  ];
  for (const button of controls) {
    await button.evaluate(el => el.scrollIntoView({ block: 'end' }));
    await button.focus();
    const response = page.waitForResponse(r => new URL(r.url()).pathname === path + '/claim' && r.request().method() === 'POST');
    await button.press('Enter');
    const refused = await response;
    expect(refused.status()).toBe(403);
    const failure = (await refused.json()).error;
    expect(failure.code).toBe('plan_limit');
    const alert = page.getByRole('alert').filter({ hasText: failure.message });
    await alert.waitFor();
    expect(await alert.count()).toBe(1);
    expect(await alert.getByRole('link', { name: 'Сравнить планы' }).getAttribute('href')).toBe('/pricing');
    expect(await button.getAttribute('aria-describedby')).toBe(await alert.getAttribute('id'));
    await expect.poll(() => button.evaluate(el => {
      const feedback = document.getElementById(el.getAttribute('aria-describedby')!);
      if (!feedback || document.activeElement !== el) return false;
      const a = el.getBoundingClientRect(), b = feedback.getBoundingClientRect();
      return a.top >= 0 && b.bottom <= innerHeight && b.top >= a.bottom && b.top - a.bottom <= 16;
    })).toBe(true);
    expect(await askError.isVisible()).toBe(true);
    expect(await input.inputValue()).toBe('Мой черновик');
  }
  expect(await page.locator('.chat-question').count()).toBe(4);
  expect(posts.filter(p => p === path + '/claim')).toHaveLength(2);
  expect(await readVerified(pool, draft.botId)).toBe(false);
});


it('безопасный повтор использует прежний UUID после потери ответа без storage', async () => {
  await page.addInitScript(() => Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('disabled'); } }));
  const keys: string[] = [];
  const bodies: string[] = [];
  await page.route('**/api/preview', route => {
    keys.push(route.request().headers()['idempotency-key']!);
    bodies.push(route.request().postDataJSON().url);
    return keys.length === 1 ? route.abort() : route.fulfill({ status: 202, json: { data: { index_job_id: job } } });
  });
  await page.route('**' + read, route => route.fulfill({ status: 404 }));
  await page.goto(origin + '/preview');
  const raw = 'https://example.test/catalog?q=synthetic';
  await page.locator('#site-url').fill(raw);
  await page.locator('.url-form button').click();
  await page.locator('.url-form').getByRole('alert').filter({ hasText: 'Нет связи' }).waitFor();
  await page.locator('.url-form button').click();
  await page.getByRole('heading', { name: 'Предпросмотр недоступен' }).waitFor();
  expect(bodies).toEqual([raw,raw]); expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  await page.getByRole('link', { name: 'Указать другой адрес' }).click();
  expect(await page.locator('#site-url').inputValue()).toBe('');
});


it('первый unknown с контактом и без него — настройки своего бота', async () => {
  await registerOwner(context);
  const draft = await attachDraft(pool, context, 'done');
  expect((await context.request.post(origin + '/api/preview/' + draft.jobId + '/claim', { headers: { origin } })).status()).toBe(200);
  const endpoint = '/api/bots/' + draft.botId + '/ask';
  let contact: string | null = null;
  await page.route('**' + endpoint, route => route.fulfill({ json: { data: { status: 'unknown', text: 'Нет ответа в материалах.', contact } } }));
  await page.goto(origin + '/dashboard/bots/' + draft.botId);
  const ask = async () => { await page.locator('#owner-question').fill('Есть ли парковка?'); await page.locator('#owner-question').press('Enter'); };
  await ask();
  const settings = page.getByRole('link', { name: 'Указать контакт для клиента' });
  await settings.click();
  expect(new URL(page.url()).hash).toBe('#settings-title');
  contact = 'help@example.test'; await ask(); await page.getByText('Связь с компанией: help@example.test').waitFor();
  expect(await readVerified(pool, draft.botId)).toBe(false);
  expect(posts).toEqual([endpoint,endpoint]);
});
