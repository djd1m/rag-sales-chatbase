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

it('завершённое задание без данных сайта и восстановление первого опроса', async () => {
  const states = [503, { ...running, state: 'done', site: null }, running, { ...running, state: 'done', site }];
  let count = 0;
  await page.route(`**${read}`, route => {
    const next = states[count++];
    return route.fulfill(typeof next === 'number' ? { status: next } : { json: { data: next } });
  });
  await page.goto(origin + '/preview/' + job);
  const retry = page.getByRole('button', { name: 'Проверить состояние' });
  await retry.waitFor();
  await retry.click();
  await page.getByText('Чтение завершено, но данные предпросмотра недоступны').waitFor();
  await page.waitForTimeout(2200);
  expect(count).toBe(2);
  await retry.click();
  await page.locator('[role=progressbar][aria-valuenow="7"]').waitFor();
  await page.getByRole('button', { name: site.suggestions[0] }).waitFor();
  expect(count).toBe(4);
  expect(posts).toEqual([]);
});

it('сбой опроса и переход к PDF из результата', async () => {
  let count = 0;
  await page.route(`**${read}`, route => ++count === 1 ? route.fulfill({ json: { data: running } })
    : count === 2 ? route.abort() : route.fulfill({ status: 404 }));
  await page.goto(origin + '/preview/' + job);
  await page.getByText(/Последнее известное/).waitFor();
  await page.getByRole('button', { name: 'Проверить состояние' }).click();
  await page.getByRole('heading', { name: 'Предпросмотр недоступен' }).waitFor();
  await page.waitForTimeout(2200);
  expect(count).toBe(3);
  await page.getByRole('link', { name: 'Начать с PDF' }).click();
  await page.getByRole('link', { name: 'Войти для загрузки PDF' }).waitFor();
  expect(posts).toEqual([]);
});

it.each([390, 1440])('цитата владельца видна до первого нажатия, ширина %i', async width => {
  await page.setViewportSize({ width, height: 900 });
  await page.route(`**${read}`, route => route.fulfill({ json: { data: { ...running, state: 'done', site } } }));
  let asks = 0;
  await page.route(`**${read}/ask`, route => {
    const i = ++asks;
    return route.fulfill({ json: { data: { status: 'answered', text: `Ответ ${i}`, first_answer: i === 1,
      source: { title: `Раздел ${i}`, excerpt: `Цитата ${i}`, url: `https://example.test/${i}` } } } });
  });
  await page.goto(origin + '/preview/' + job);
  const draft = page.locator('#preview-question');
  for (const i of [1, 2]) {
    await draft.fill(`Вопрос ${i}`); await draft.press('Enter');
    await page.getByText(`Цитата ${i}`, { exact: true }).waitFor();
    expect(await page.locator('.source-quote a').count()).toBe(1);
  }
  await draft.fill('Мой черновик');
  const first = page.getByRole('button', { name: /Источник.*Раздел 1/ });
  await first.focus(); await first.press('Enter');
  await page.getByText('Цитата 1', { exact: true }).waitFor();
  expect(await first.evaluate(el => el === document.activeElement)).toBe(true);
  expect(await draft.inputValue()).toBe('Мой черновик');
  expect(await page.locator('.source-quote a').getAttribute('href')).toBe('https://example.test/1');
  expect(posts).toEqual([read + '/ask', read + '/ask']);
});

it.each([true,false])('первый unknown с контактом и без него — гость, контакт %s', async contact => {
  await page.route(`**${read}`, route => route.fulfill({ json: { data: { ...running, state: 'done', site } } }));
  await page.route(`**${read}/ask`, route => route.fulfill({ json: { data: {
    status: 'unknown', text: 'В материалах нет ответа.', contact: contact ? 'office@example.test' : null,
  } } }));
  await page.goto(origin + '/preview/' + job);
  await page.getByRole('button', { name: site.suggestions[0] }).click();
  if (contact) await page.getByText(/office@example.test/).waitFor();
  else await page.getByRole('link', { name: /Войти.*контакт/ }).waitFor();
  expect(await page.locator('.aha').count()).toBe(0);
  expect(posts).toEqual([read + '/ask']);
});

it('ворота запуска сайта и восстановление адреса задачи', async () => {
  const launches: string[] = [];
  await page.route('**/api/preview', route => {
    launches.push(route.request().headers()['idempotency-key']!);
    return route.fulfill({ status: 202, json: { data: { index_job_id: job } } });
  });
  await page.route(`**${read}`, route => route.fulfill({ json: { data: { ...running, state: 'failed', reason: 'robots_disallowed' } } }));
  await page.goto(origin + '/preview?source=pdf&url=ignored.test');
  await page.getByRole('link', { name: 'Войти для загрузки PDF' }).waitFor();
  await expect.poll(() => new URL(page.url()).searchParams.has('url')).toBe(false);
  await page.goto(origin + `/preview?retry=${job}&url=ignored.test`);
  await page.locator('#site-url').waitFor(); expect(await page.locator('#site-url').inputValue()).toBe('');
  expect(launches).toEqual([]);
  await page.goto(origin + '/preview?url=example.test');
  const retry = page.getByRole('link', { name: 'Указать другой адрес' });
  await retry.waitFor();
  expect(launches).toHaveLength(1);
  await retry.click(); await expect.poll(() => page.locator('#site-url').inputValue()).toBe('https://example.test');
  expect(launches).toHaveLength(1);
  const separate = await context.newPage();
  await separate.goto(origin + `/preview?retry=${job}`);
  expect(await separate.locator('#site-url').inputValue()).toBe('');
  expect(launches).toHaveLength(1);
  await separate.close();
});

it('URL с маркерами не появляется в ключах, значениях и новых ссылках', async () => {
  const marker = 'synthetic-private-part';
  const raw = 'https://example.test/path-' + marker + '?q=' + marker + '#' + marker;
  const launched: string[] = [];
  await page.route('**/api/preview', route => {
    launched.push(route.request().postDataJSON().url);
    return route.fulfill({ status: 202, json: { data: { index_job_id: job } } });
  });
  await page.route(`**${read}`, route => route.fulfill({ json: { data: { ...running, state: 'failed', reason: 'no_text' } } }));
  await page.goto(origin + '/');
  await page.evaluate(value => sessionStorage.setItem('n6_preview_key:' + value, 'legacy'), raw);
  await page.goto(origin + '/preview?url=' + encodeURIComponent('https://' + marker + '@example.test'));
  await page.locator('.url-form').getByRole('alert').filter({ hasText: 'без логина и пароля' }).waitFor();
  expect(launched).toEqual([]);
  await page.locator('#site-url').fill(raw);
  await page.locator('.url-form button').click(); await page.getByRole('link', { name: 'Указать другой адрес' }).waitFor();
  expect(launched).toEqual([raw]);
  const leaked = await page.evaluate(value => {
    const items = [...Object.entries(sessionStorage).flat(), location.href, ...Array.from(document.links, a => a.href)];
    return items.some(item => item.includes(value));
  }, marker);
  expect(leaked).toBe(false);
  await page.getByRole('link', { name: 'Указать другой адрес' }).click();
  expect(await page.locator('#site-url').inputValue()).toBe('');
  expect(launched).toHaveLength(1);
});

it('исход claim и фактическая готовность разделены — PDF после входа, автосохранения и предела плана', async () => {
  const draft = await attachDraft(pool, context, 'failed');
  await page.goto(origin + '/preview/' + draft.jobId);
  await page.getByText('На сайте не нашлось текста.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Начать с PDF' }).click();
  await page.getByRole('link', { name: 'Войти для загрузки PDF' }).click();
  await page.getByRole('button', { name: /Зарегистрироваться/ }).click();
  await fillSignup(page);
  await page.waitForURL(origin + '/dashboard?source=pdf');
  await page.getByText('Бот из предпросмотра сохранён в вашем аккаунте.', { exact: true }).waitFor();
  expect(await page.locator('.bot-card').count()).toBe(1);
  expect(await page.locator('.bot-card').textContent()).toContain('готово 0 · с отказом 1');
  expect(await page.locator('.limit-notice').isVisible()).toBe(true);
  expect(await page.locator('.bot-form').count()).toBe(0);
  expect(await readVerified(pool, draft.botId)).toBe(false);
  await page.getByRole('link', { name: /Загрузить PDF для/ }).click();
  await page.waitForURL(origin + '/dashboard/bots/' + draft.botId + '#source-pdf');
  expect(await page.locator('#source-pdf').isEnabled()).toBe(true);
  expect(posts).toEqual(['/api/auth/register']);
});

it('первый unknown с контактом и без него — вошедший владелец сохраняет черновик явно', async () => {
  await registerOwner(context);
  const draft = await attachDraft(pool, context, 'done');
  const path = '/api/preview/' + draft.jobId;
  await page.route('**' + path + '/ask', route => route.fulfill({ json: { data: { status: 'unknown', text: 'Нет сведений.', contact: null } } }));
  await page.goto(origin + '/preview/' + draft.jobId);
  await page.getByRole('button', { name: 'Как работает доставка?' }).click();
  const save = page.getByRole('button', { name: 'Сохранить черновик для настройки контакта' });
  await save.waitFor();
  expect(await page.locator('.aha').count()).toBe(0);
  expect(posts).toEqual([path + '/ask']);
  await save.click(); await page.waitForURL(origin + '/dashboard');
  await page.getByText('Бот из предпросмотра сохранён в вашем аккаунте.', { exact: true }).waitFor();
  expect(posts).toEqual([path + '/ask', path + '/claim']);
});

it('прямой saved URL, replay и смена аккаунта не доказывают claim', async () => {
  await registerOwner(context);
  const draft = await attachDraft(pool, context, 'done');
  const claimed = await context.request.post(origin + '/api/preview/' + draft.jobId + '/claim', { headers: { origin } });
  expect(claimed.status()).toBe(200);
  const header = claimed.headers()['x-sufler-claim-context'];
  expect(typeof header === 'string' && header.length === 43).toBe(true);
  await page.goto(origin + '/dashboard?saved=1&preview=claimed');
  const banner = page.locator('.cabinet-notice');
  expect(await banner.count()).toBe(0);
  const setSlot = (ttl: number) => page.evaluate(({ ttl, ctx }) => {
    sessionStorage.setItem('n6_preview_claim_notice_v1', JSON.stringify({ outcome: 'claimed', context: ctx, expiresAt: Date.now() + ttl }));
  }, { ttl, ctx: header });
  await setSlot(100000); await page.reload(); await banner.waitFor();
  await page.goto(origin + '/pricing'); await page.goBack();
  expect(await banner.count()).toBe(0);
  await setSlot(-1); await page.reload(); expect(await banner.count()).toBe(0);
  await setSlot(100000);
  await registerOwner(context); // independent account B, same tab and browser storage
  await page.reload(); await page.getByRole('heading', { name: 'Ботов пока нет' }).waitFor();
  expect(await banner.count()).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem('n6_preview_claim_notice_v1') === null)).toBe(true);
});

it('реальный маршрут различает право чтения, исход claim и локальную проверку', async () => {
  await registerOwner(context);
  const draft = await attachDraft(pool, context, 'running');
  const path = '/api/preview/' + draft.jobId;
  await page.goto(origin + '/preview/' + draft.jobId);
  await page.locator('[role=progressbar][aria-valuenow="7"]').waitFor();
  const stranger = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    expect((await stranger.request.get(origin + path)).status()).toBe(404);
    await registerOwner(stranger);
    expect((await stranger.request.get(origin + '/dashboard/bots/' + draft.botId + '/install')).status()).toBe(404);
    const claimed = await context.request.post(origin + path + '/claim', { headers: { origin } });
    expect(claimed.status()).toBe(200);
    expect((await stranger.request.get(origin + '/dashboard/bots/' + draft.botId)).status()).toBe(404);
    await page.goto(origin + '/dashboard/bots/' + draft.botId);
    for (const name of ['Обычный вопрос','Нет сведений','Связь с компанией']) await page.getByRole('checkbox', { name }).check();
    await page.getByRole('checkbox', { name: 'Обычный вопрос' }).check();
    await page.getByText('Отмечено на этом экране: 3 из 3').waitFor();
    expect(await readVerified(pool, draft.botId)).toBe(false);
    expect(posts).toEqual([]);
    const second = await attachDraft(pool, context, 'done');
    const limit = await context.request.post(origin + '/api/preview/' + second.jobId + '/claim', { headers: { origin } });
    expect(limit.status()).toBe(403); expect((await limit.json()).error.code).toBe('plan_limit');
  } finally { await stranger.close(); }
});

it('подтверждение сохраняет проверенное намерение PDF', async () => {
  await registerOwner(context);
  const link = await verificationLink(pool, context);
  await page.goto(link);
  await page.getByRole('button', { name: 'Подтвердить почту' }).click();
  await page.getByRole('link', { name: 'Продолжить с PDF' }).click();
  await page.waitForURL(origin + '/dashboard?source=pdf');
  await page.getByRole('heading', { name: 'Создайте бота для PDF' }).waitFor();
  expect(posts).toEqual(['/api/auth/email/confirm']);
  const name = page.locator('[name=company_name]');
  await name.fill('Мои документы');
  await page.getByRole('button', { name: 'Создать бота' }).click();
  await page.waitForURL(/\/dashboard\/bots\/[\w-]+#source-pdf$/);
  expect(await page.locator('#source-pdf').isEnabled()).toBe(true);
  expect(posts).toEqual(['/api/auth/email/confirm', '/api/bots']);
});

it('отказ claim и готовность бота показаны отдельно', async () => {
  await registerOwner(context);
  const first = await attachDraft(pool, context, 'done');
  const saved = await context.request.post(origin + '/api/preview/' + first.jobId + '/claim', { headers: { origin } });
  expect(saved.status()).toBe(200);
  const next = await attachDraft(pool, context, 'done');
  const path = '/api/preview/' + next.jobId;
  await page.route('**' + path + '/ask', route => route.fulfill({ json: { data: { status: 'unknown', text: 'Нет сведений.', contact: null } } }));
  await page.goto(origin + '/preview/' + next.jobId);
  await page.getByRole('button', { name: 'Как работает доставка?' }).click();
  await page.getByRole('button', { name: /Сохранить черновик/ }).click();
  await page.getByRole('alert').filter({ hasText: 'На плане free' }).waitFor();
  expect(new URL(page.url()).pathname).toBe('/preview/' + next.jobId);
  expect(await page.locator('.aha').count()).toBe(0);
  expect(await readVerified(pool, next.botId)).toBe(false);
});

it('отказ автосохранения при недоступном storage сохраняет явное продолжение PDF', async () => {
  const owner = await registerOwner(context);
  const first = await attachDraft(pool, context, 'done');
  expect((await context.request.post(origin + '/api/preview/' + first.jobId + '/claim', { headers: { origin } })).status()).toBe(200);
  await context.clearCookies();
  await attachDraft(pool, context, 'failed');
  await page.addInitScript(() => {
    Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Unavailable','SecurityError'); } });
  });
  await page.goto(origin + '/login?next=%2Fdashboard%3Fsource%3Dpdf');
  await page.locator('[name=email]').fill(owner.email); await page.locator('[name=password]').fill(owner.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Предел' }).waitFor();
  await page.getByRole('link', { name: 'Продолжить' }).click();
  await page.waitForURL(origin + '/dashboard?source=pdf');
  await page.getByRole('link', { name: /Загрузить PDF для/ }).waitFor();
  expect(await page.locator('.bot-card').count()).toBe(1);
  expect(await page.locator('.cabinet-notice').count()).toBe(0);
});

it('выбор бота и PDF требуют отдельных действий, чужая загрузка недоступна', async () => {
  const owner = await registerOwner(context);
  await pool.query("UPDATE account SET plan='studio' WHERE email=$1", [owner.email]);
  const ids: string[] = [];
  for (const name of ['Первая мастерская', 'Вторая мастерская']) {
    const res = await context.request.post(origin + '/api/bots', { headers: { origin }, data: { company_name: name, contact: '', greeting: '' } });
    expect(res.status()).toBe(201);
    ids.push((await res.json()).data.bot_id);
  }
  await page.goto(origin + '/dashboard?source=pdf');
  await page.getByRole('link', { name: 'Загрузить PDF для «Вторая мастерская»' }).click();
  await page.waitForURL(origin + '/dashboard/bots/' + ids[1] + '#source-pdf');
  const upload = page.locator('#source-pdf');
  expect(await upload.isEnabled()).toBe(true);
  expect(posts).toEqual([]);
  // Штатный endpoint выполняет синхронную проверку сигнатуры перед постановкой. Передаём PDF fixture.
  const file = { name: 'materials.pdf', mimeType: 'application/pdf', buffer: normalPdf() };
  const stranger = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await registerOwner(stranger);
    const forbidden = await stranger.request.post(origin + '/api/bots/' + ids[1] + '/sources', {
      headers: { origin, 'Idempotency-Key': randomUUID() }, multipart: { file },
    });
    expect(forbidden.status()).toBe(404);
    const accepted = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/bots/' + ids[1] + '/sources');
    await upload.setInputFiles(file); expect((await accepted).status()).toBe(202);
    expect(posts).toEqual(['/api/bots/' + ids[1] + '/sources']);
  } finally { await stranger.close(); }
});

it('заполненная установка и отдельный внешний origin дают наблюдаемую квитанцию', async () => {
  const external = testOrigin('SUFLER_UI_EXTERNAL_ORIGIN');
  const publicDir = process.env.SUFLER_UI_EXTERNAL_DIR;
  if (external === origin || !publicDir) throw new Error('Нужны отдельный разрешаемый origin и его каталог HTML');
  const artifact = process.env.SUFLER_UI_ARTIFACT_DIR;
  if (!artifact) throw new Error('Нужен каталог квитанции U09');
  await mkdir(artifact, { recursive: true });
  await registerOwner(context);
  const draft = await attachDraft(pool, context, 'done');
  const claimed = await context.request.post(origin + `/api/preview/${draft.jobId}/claim`, { headers: { origin } });
  expect(claimed.status()).toBe(200);
  const installPath = '/dashboard/bots/' + draft.botId + '/install';
  const events = async () => (await pool.query<{ origin: string; config: boolean; answer: boolean }>(
    'SELECT origin, first_config_at IS NOT NULL AS config, first_answer_at IS NOT NULL AS answer FROM widget_install WHERE bot_id=$1', [draft.botId])).rows;
  const foreign = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    await registerOwner(foreign);
    expect((await foreign.request.get(origin + installPath)).status()).toBe(404);
  } finally { await foreign.close(); }
  await page.goto(origin + installPath);
  await page.locator('#install-contact').waitFor();
  expect(await page.locator('.snippet').count()).toBe(0);
  await page.locator('#install-contact').fill('office@example.test');
  await page.getByRole('button', { name: 'Сохранить и показать код' }).click();
  await page.locator('.snippet code').waitFor();
  const instructions = page.locator('details.howto');
  expect(await instructions.locator('summary').allTextContents()).toEqual(['Tilda','WordPress','Обычный HTML']);
  await instructions.last().locator('summary').click();
  await context.grantPermissions(['clipboard-read','clipboard-write'], { origin });
  await page.getByRole('button', { name: 'Скопировать код' }).click();
  await page.getByText('Скопировано', { exact: true }).waitFor();
  const tag = await page.evaluate(() => navigator.clipboard.readText());
  expect(tag).toBe(await page.locator('.snippet code').textContent());
  expect(await events()).toEqual([]);
  const filename = `sufler-u09-${randomUUID()}.html`;
  const target = path.join(publicDir, filename);
  const directives = await page.locator('.csp-list code').allTextContents();
  expect(directives).toEqual([`script-src ${origin}`, `connect-src ${origin}`, `img-src ${origin} data:`]);
  await writeFile(target, `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${directives.join('; ')}"><title>Мастерская</title></head><body><h1>Доставка мастерской</h1>${tag}</body></html>`, { flag: 'wx' });
  try {
    await chmod(target, 0o644);
    const visitor = await context.newPage();
    const violations: string[] = [];
    await visitor.exposeFunction('recordUiCsp', (directive: string) => violations.push(directive));
    await visitor.addInitScript(() => document.addEventListener('securitypolicyviolation', e =>
      (window as unknown as { recordUiCsp: (name: string) => void }).recordUiCsp(e.effectiveDirective)));
    const externalPage = external + '/' + filename;
    // До allowlist сервер отвергает внешний origin. В Chromium ответ без ACAO может быть скрыт от страницы.
    const publicKey = /data-bot="([\w-]+)"/.exec(tag)![1];
    const configURL = origin + '/w/v1/config?bot=' + publicKey;
    const denied = await context.request.get(configURL, { headers: { Origin: external } });
    expect(denied.status()).toBe(403); expect(denied.headers()['access-control-allow-origin']).toBeUndefined();
    await visitor.goto(externalPage);
    expect(await events()).toEqual([]);
    await page.locator('#origin-domain').fill(external);
    await page.getByRole('button', { name: 'Добавить домен' }).click();
    await page.locator('.origin-list code').filter({ hasText: external }).waitFor();
    const config = visitor.waitForResponse(r => new URL(r.url()).pathname === '/w/v1/config');
    await visitor.reload();
    const loaded = await config;
    expect(loaded.status()).toBe(200); expect(loaded.headers()['access-control-allow-origin']).toBe(external);
    const badge = visitor.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/w/v1/event');
    await visitor.locator('n6-sufler .bubble').click();
    expect((await badge).status()).toBe(204);
    const sendQuestion = async () => {
      await visitor.locator('n6-sufler .input').fill('Сколько стоит доставка?');
      const [request] = await Promise.all([
        visitor.waitForRequest(r => new URL(r.url()).pathname === '/w/v1/ask' && r.method() === 'POST', { timeout: 10000 }),
        visitor.locator('n6-sufler .send').click(),
      ]);
      const res = await request.response();
      if (!res) throw new Error('Внешний виджет: ' + (request.failure()?.errorText ?? 'нет HTTP-ответа'));
      expect(res.status()).toBe(200);
      expect(res.headers()['access-control-allow-origin']).toBe(external);
      return (await res.json()).data;
    };
    const stub = await sendQuestion(); expect(stub.reason).toBe('not_verified');
    expect(await events()).toEqual([{ origin: external, config: true, answer: false }]);
    await page.getByRole('button', { name: 'Я проверил ответы бота' }).click();
    await expect.poll(() => readVerified(pool, draft.botId)).toBe(true);
    const answer = await sendQuestion();
    expect(answer.status).toBe('answered'); expect(answer.text).toContain('350');
    await visitor.locator('n6-sufler .msg.bot').filter({ hasText: '350' }).waitFor();
    const ownPage = await context.newPage();
    await ownPage.goto(origin + '/dashboard/bots/' + draft.botId);
    await ownPage.getByRole('button', { name: 'Опубликовать страницу' }).click();
    const demo = await ownPage.locator('section[aria-labelledby="publish-title"] a').getAttribute('href');
    if (!demo || new URL(demo).origin !== origin) throw new Error('Нет локальной демо-страницы');
    const ownBadge = ownPage.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/w/v1/event');
    const ownConfig = ownPage.waitForResponse(r => new URL(r.url()).pathname === '/w/v1/config');
    await ownPage.goto(demo);
    expect((await ownConfig).status()).toBe(200);
    await ownPage.locator('n6-sufler .panel:not([hidden])').waitFor();
    expect((await ownBadge).status()).toBe(204);
    await ownPage.locator('n6-sufler .input').fill('Сколько стоит доставка?');
    await ownPage.locator('n6-sufler .send').click();
    await ownPage.locator('n6-sufler .msg.bot').filter({ hasText: '350' }).waitFor();
    const signals = await events();
    expect(signals).toEqual([{ origin: external, config: true, answer: true }]);
    expect(violations).toEqual([]);
    await page.screenshot({ path: path.join(artifact, 'install.png'), fullPage: true });
    await visitor.screenshot({ path: path.join(artifact, 'widget.png') });
    await writeFile(path.join(artifact,'observation.json'), JSON.stringify({
      observedAt: new Date().toISOString(), revision: process.env.SUFLER_UI_REVISION ?? null, engine: 'Chromium', version: browser.version(),
      viewport: page.viewportSize(), theme: await page.locator('html').getAttribute('data-theme'), origin, external, installPath, externalPage,
      clipboardMatched: true, ownOriginEvents: signals.filter(e => e.origin === origin).length, deniedStatus: denied.status(),
      stub: stub.reason, config: loaded.status(), acao: loaded.headers()['access-control-allow-origin'], cspViolations: violations,
      answer: answer.status, model: 'in-process synthetic transport', sources: 'seeded text/page/chunk in test PostgreSQL', signals,
    }, null, 2));
  } finally { await rm(target, { force: true }); }
});

it('маршруты в обеих темах и пяти размерах сохраняют поле, действие и навигацию', async () => {
  await registerOwner(context);
  const draft = await attachDraft(pool, context, 'done');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const routes = ['/', '/preview', '/preview?source=pdf', '/preview/' + draft.jobId, '/login', '/dashboard', '/pricing'];
  for (const theme of ['dark','light']) {
    await page.goto(origin + '/');
    if ((await page.locator('html').getAttribute('data-theme')) !== theme) await page.getByRole('button', { name: 'Светлая тема' }).click();
    await page.reload();
    for (const route of routes) {
      await page.goto(origin + route);
      if (route === '/preview/' + draft.jobId) await page.locator('#preview-question').waitFor();
      expect(await page.locator('html').getAttribute('data-theme')).toBe(theme);
      for (const [width,height] of [[320,568],[375,667],[390,844],[768,1024],[1440,900]] as const) {
        await page.setViewportSize({ width,height }); await page.evaluate(() => document.fonts.ready);
        const errors = (await domRules(page, ['R1','R2','R5'])).filter((f: { severity: string }) => f.severity === 'error');
        expect(errors, `${route} ${theme} ${width}×${height}`).toEqual([]);
        if (route === '/preview?source=pdf' && width === 320) {
          const nav = page.getByRole('navigation', { name: 'Основная навигация' });
          for (const name of ['Тарифы', 'Войти']) {
            const lines = await nav.getByRole('link', { name, exact: true }).evaluate(el => {
              const range = document.createRange();
              range.selectNodeContents(el);
              return new Set(Array.from(range.getClientRects(), r => r.top)).size;
            });
            expect(lines, name).toBe(1);
          }
        }
        if (route === '/') {
          for (const selector of ['#site-url','.url-form button', ...(width === 1440 ? ['.answer-card'] : [])]) {
            const visible = await page.locator(selector).evaluate(el => {
              const r = el.getBoundingClientRect(); return scrollY === 0 && r.top >= 0 && r.bottom <= innerHeight;
            });
            expect(visible, `${selector} ${theme} ${width}×${height}`).toBe(true);
          }
        }
      }
    }
  }
  expect(posts).toEqual([]);
}, 90000);
