import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { AuthService } from '../../apps/web/src/server/auth';
import { PgAuthStore } from '../../apps/web/src/server/auth-store';
import { createCustomerEmailActionHandler } from '../../apps/web/src/server/customer-email-actions';
import { CustomerEmailProofStore } from '../../packages/db/src/customer-email-proof';
import { auditPool, registerOwner, testOrigin, verificationLink } from '../fixtures/sufler-source-journey';
import { buildSync } from 'esbuild';
import path from 'node:path';

const origin = 'https://sufler.test';
let browser: Browser, bundle: string;

it('login password visibility works with Enter and Space without losing input or submitting', async () => {
  for (const mode of ['login', 'register']) {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    let posts = 0;
    page.on('request', request => { if (request.method() === 'POST') posts++; });
    try {
      await page.goto(origin + '/login' + (mode === 'register' ? '?mode=register' : ''));
      const password = page.getByLabel('Пароль', { exact: true });
      await password.fill('synthetic-password');
      await password.press('Tab');
      const show = page.getByRole('button', { name: 'Показать пароль', exact: true });
      expect(await show.evaluate(element => element === document.activeElement)).toBe(true);
      await show.press('Enter');
      const hide = page.getByRole('button', { name: 'Скрыть пароль', exact: true });
      expect(await password.getAttribute('type')).toBe('text');
      expect(await password.inputValue()).toBe('synthetic-password');
      expect(await hide.getAttribute('aria-pressed')).toBe('true');
      expect(await hide.evaluate(element => element === document.activeElement)).toBe(true);
      await hide.press('Space');
      expect(await password.getAttribute('type')).toBe('password');
      expect(await password.inputValue()).toBe('synthetic-password');
      expect(await show.getAttribute('aria-pressed')).toBe('false');
      expect(await show.evaluate(element => element === document.activeElement)).toBe(true);
      expect(posts).toBe(0);
      expect(await page.getByRole('link', { name: 'Забыли пароль?' }).count()).toBe(mode === 'login' ? 1 : 0);
    } finally { await page.close(); }
  }
});

beforeAll(async () => {
  bundle = buildSync({
    stdin: {
      contents: `
    import {createRoot} from 'react-dom/client';
    import {createElement} from 'react';
    import {CustomerRecoveryForm} from './apps/web/src/app/verify-email/CustomerRecoveryForm';
    import {AuthForm} from './apps/web/src/app/login/AuthForm';
    const mode=location.pathname.slice(1), docs={terms:{version:'v1',path:'/legal/terms'},consent:{version:'v1',path:'/legal/consent'}};
    const view=mode==='login' ? createElement(AuthForm,{documents:docs,initialMode:'login',next:'/dashboard?source=pdf'}) :
      createElement(CustomerRecoveryForm,{mode,authenticated:document.cookie.includes('signed=1'),verified:false,mailEnabled:true,next:'/dashboard?source=pdf'});
    createRoot(document.getElementById('root')).render(view);
  `, resolveDir: path.resolve('.')
    }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { 'next/navigation': path.resolve('tests/browser/next-navigation-shim.ts') },
    define: { 'process.env.NODE_ENV': '"production"' }
  }).outputFiles[0]!.text;
  browser = await chromium.launch();
});
afterAll(async () => { await browser?.close(); });
it('claim hint is bound to the response context and an invalid password keeps the fragment in memory', async () => {
  const second = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await second.newPage(), token = 'A'.repeat(43);
  const mutations: { path: string; body: Record<string, string> }[] = [];
  let resetAttempts = 0;
  await second.route(origin + '/**', async route => {
    const req = route.request(), pathname = new URL(req.url()).pathname;
    expect(req.url()).not.toContain(token);
    if (req.method() === 'POST') {
      mutations.push({ path: pathname, body: req.postDataJSON() });
      const invalid = pathname.endsWith('/reset') && ++resetAttempts === 1;
      await route.fulfill({
        status: invalid ? 422 : 200, json: invalid ? { error: { code: 'invalid_password', message: 'Исправьте пароль' } } :
          { data: { verified: true, ok: true, ...(pathname.endsWith('/login') ? { preview: 'claimed' } : {}) } },
        headers: { 'X-Sufler-Claim-Context': 'B'.repeat(43) }
      }); return;
    }
    if (pathname === '/bundle.js') { await route.fulfill({ contentType: 'application/javascript', body: bundle }); return; }
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width"><div id="root"></div><script src="/bundle.js"></script></html>' });
  });
  try {
    const letter = origin + '/verify-email?next=%2Fdashboard%3Fsource%3Dpdf#token=' + token;
    await page.goto(letter);
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    expect(mutations).toEqual([]);
    expect(await page.getByRole('link', { name: 'Войти', exact: true }).getAttribute('href')).toBe('/login');
    await page.getByRole('link', { name: 'Войти', exact: true }).click();
    await page.getByLabel('Почта', { exact: true }).fill('owner@example.test');
    await page.getByLabel('Пароль', { exact: true }).fill('password123');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await page.waitForURL(origin + '/dashboard?source=pdf');
    const slot = await page.evaluate(() => JSON.parse(sessionStorage.getItem('n6_preview_claim_notice_v1')!));
    expect(slot).toMatchObject({ context: 'B'.repeat(43), outcome: 'claimed' });
    expect(JSON.stringify(slot)).not.toContain(token);
    await second.addCookies([{ name: 'signed', value: '1', url: origin }]);
    await page.goto(letter);
    await page.getByRole('button', { name: 'Подтвердить почту', exact: true }).click();
    await expect.poll(() => mutations.at(-1)).toEqual({ path: '/api/auth/email/confirm', body: { token } });
    expect(await page.getByRole('link', { name: 'Продолжить с PDF' }).getAttribute('href')).toBe('/dashboard?source=pdf');
    await page.goto(origin + '/reset#token=' + token);
    const field = page.locator('input[name=password]');
    await field.fill('password123');
    expect(await field.getAttribute('type')).toBe('password');
    await page.getByRole('button', { name: 'Показать пароль', exact: true }).click();
    expect(await field.getAttribute('type')).toBe('text');
    await page.getByRole('button', { name: 'Сменить пароль', exact: true }).click();
    await expect.poll(() => page.getByRole('alert').textContent()).toContain('Исправьте пароль');
    await field.fill('another-pass');
    await page.getByRole('button', { name: 'Сменить пароль', exact: true }).click();
    await expect.poll(() => resetAttempts).toBe(2);
    expect(mutations.slice(-2).map(m => m.body.token)).toEqual([token, token]);
    expect(await page.getByRole('link', { name: 'Войти', exact: true }).getAttribute('href')).toBe('/login');
  } finally { await second.close(); }
});

it('recovery fragments are POST only and safe PDF continuation stays available', async () => {
  const base = testOrigin();
  const pool = auditPool(), proofs = new CustomerEmailProofStore(pool);
  const issuer = await browser.newContext({ ignoreHTTPSErrors: true });
  const second = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  try {
    const owner = await registerOwner(issuer);
    const page = await second.newPage();
    const first = await issuer.newPage();
    await first.goto(base + '/dashboard?source=pdf');
    await first.getByRole('heading', { name: 'Создайте бота для PDF' }).waitFor();
    const letter = await verificationLink(pool, issuer);
    const scanner = await second.request.get(letter);
    expect(scanner.status()).toBe(200);
    expect(scanner.headers()['referrer-policy']).toBe('no-referrer');
    expect(scanner.headers()['cache-control']).toContain('no-store');
    const reads = await pool.query('SELECT email_verified_at FROM account WHERE email=$1', [owner.email]);
    expect(reads.rows[0].email_verified_at).toBeNull();
    await page.goto(letter);
    const main = page.getByRole('main');
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    const login = main.getByRole('link', { name: 'Войти', exact: true });
    expect(await login.getAttribute('href')).toBe('/login');
    await login.click();
    await main.getByLabel('Почта', { exact: true }).fill(owner.email);
    await main.getByLabel('Пароль', { exact: true }).fill(owner.password);
    await main.getByRole('button', { name: 'Войти', exact: true }).click();
    await page.waitForURL(base + '/dashboard');
    await page.goto(letter);
    await main.getByRole('button', { name: 'Подтвердить почту' }).click();
    await main.getByRole('link', { name: 'Продолжить с PDF' }).click();
    await page.waitForURL(base + '/dashboard?source=pdf');
    await main.getByRole('heading', { name: 'Создайте бота для PDF' }).waitFor();
    expect((await pool.query('SELECT email_verified_at FROM account WHERE email=$1', [owner.email])).rows[0].email_verified_at).toBeInstanceOf(Date);
    expect((await pool.query('SELECT 1 FROM bot JOIN account ON account.id=bot.account_id WHERE account.email=$1', [owner.email])).rowCount).toBe(0);

    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error('Нужен тестовый SESSION_SECRET изолированного стенда');
    let resetURL = '';
    const forgot = createCustomerEmailActionHandler('forgot', {
      publicOrigin: base, secret, auth: new AuthService(new PgAuthStore(pool), secret), proofs,
      allowMutation: async () => true, allowIssue: async () => true,
      mail: {
        settings: { mode: 'resend', apiKey: 'test-only', from: 'mail@example.test' }, transport: {
          send: async message => {
            resetURL = message.text.split('\n\n')[1]!;
            return { status: 'accepted', providerId: 'local-test' };
          }
        }
      },
    });
    const requested = await forgot(new Request(base + '/api/auth/forgot', {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.10' }, body: JSON.stringify({ email: owner.email })
    }));
    expect(requested.status).toBe(202);
    await expect.poll(async () => (await pool.query("SELECT 1 FROM customer_email_proof WHERE email=$1 AND purpose='reset' AND active", [owner.email])).rowCount).toBe(1);
    const reset = new URLSearchParams(new URL(resetURL).hash.slice(1)).get('token')!;
    await page.goto(resetURL);
    const input = main.locator('input[name=password]');
    await input.fill('я'.repeat(37));
    await main.getByRole('button', { name: 'Сменить пароль' }).click();
    await expect.poll(() => main.getByRole('alert').textContent()).toContain('72 байт');
    await input.fill('заменённый-пароль');
    await main.getByRole('button', { name: 'Сменить пароль' }).click();
    await main.getByRole('link', { name: 'Войти', exact: true }).waitFor();
    await first.goto(base + '/dashboard');
    await first.waitForURL(base + '/login');
    await page.goto(resetURL);
    await input.fill('повторный-пароль');
    await main.getByRole('button', { name: 'Сменить пароль' }).click();
    expect(await main.getByRole('link', { name: 'Запросить новую ссылку' }).getAttribute('href')).toBe('/forgot');
    expect(await page.evaluate(() => [JSON.stringify(localStorage), JSON.stringify(sessionStorage), location.href].join(' '))).not.toContain(reset);
  } finally { await issuer.close(); await second.close(); await pool.end(); }
});

it('a changed legal edition requires a fresh check only for that document', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const payloads: Array<Record<string, unknown>> = [];
  await page.route(origin + '/**', async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      payloads.push(request.postDataJSON());
      return route.fulfill(payloads.length === 1 ? {
        status: 409, json: {
          error: { code: 'legal_version_changed', message: 'Условия изменились' },
          documents: { terms: { path: '/legal/terms', version: 'v2' }, consent: { path: '/legal/consent', version: 'v1' } }
        }
      }
        : { status: 200, json: { data: { ok: true } } });
    }
    if (new URL(request.url()).pathname === '/bundle.js') return route.fulfill({ contentType: 'application/javascript', body: bundle });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
  });
  try {
    await page.goto(origin + '/login');
    await page.getByRole('button', { name: 'Нет аккаунта? Зарегистрироваться' }).click();
    const terms = page.locator('[name=terms]'), consent = page.locator('[name=consent]');
    await page.getByLabel('Почта', { exact: true }).fill('user@example.test');
    await page.getByLabel('Пароль', { exact: true }).fill('пароль-длинный');
    await terms.check(); await consent.check();
    await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
    await expect.poll(() => page.getByRole('alert').textContent()).toBe('Условия изменились');
    expect(await terms.isChecked()).toBe(false);
    expect(await consent.isChecked()).toBe(true);
    expect(await page.getByLabel('Почта', { exact: true }).inputValue()).toBe('user@example.test');
    expect(await page.getByLabel('Пароль', { exact: true }).inputValue()).toBe('пароль-длинный');
    await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
    expect(payloads.length).toBe(1);
    await terms.check();
    await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
    await expect.poll(() => payloads.length).toBe(2);
    expect(payloads[1]).toMatchObject({ terms: { accepted: true, version: 'v2' }, consent: { accepted: true, version: 'v1' } });
  } finally { await page.close(); }
});

it('forgot acceptance and verify transport uncertainty remain distinguishable', async () => {
  const page = await browser.newPage();
  await page.context().addCookies([{ name: 'signed', value: '1', url: origin }]);
  await page.route(origin + '/**', route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/bundle.js') return route.fulfill({ contentType: 'application/javascript', body: bundle });
    if (pathname === '/api/auth/forgot') return route.fulfill({ status: 202, json: { data: { status: 'requested' } } });
    if (pathname === '/api/auth/email/send') return route.fulfill({ status: 503, json: { error: { code: 'delivery_unknown', message: 'Не удалось подтвердить отправку' } } });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/bundle.js"></script>' });
  });
  try {
    await page.goto(origin + '/forgot');
    await page.getByLabel('Почта').fill('owner@example.test');
    await page.getByRole('button', { name: 'Запросить письмо' }).click();
    await expect.poll(() => page.getByRole('status').textContent()).toContain('Запрос принят');
    expect(await page.getByText(/сервис принял письмо/i).count()).toBe(0);
    await page.goto(origin + '/verify-email');
    await page.getByRole('button', { name: 'Запросить письмо' }).click();
    await expect.poll(() => page.getByRole('alert').textContent()).toBe('Не удалось подтвердить отправку');
    expect(await page.getByText('Почта подтверждена.').count()).toBe(0);
  } finally { await page.close(); }
});
