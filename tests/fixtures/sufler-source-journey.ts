import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import { completeIndexJob, createPool, createPreview, failIndexJob, leaseIndexJob, recordProgress, type Pool } from '../../packages/db/src/index';
import { loadCeilings } from '../../packages/rag/src/index';
import { PREVIEW_JOB_BUDGET } from '../../packages/queue/src/constants';
import { tokenHash } from '../../apps/web/src/server/preview-session';
import { readTrustDocument } from '../../apps/web/src/lib/trust-legal-catalog';
import { environment } from './environment';

// Источники адресов передаёт только отдельный стенд. Пустой адрес — явный отказ теста.
export function testOrigin(name = 'SUFLER_UI_TEST_ORIGIN') {
  const value = process.env[name];
  if (!value) throw new Error(`Укажите ${name} выделенного HTTPS-стенда`);
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.test') || url.origin !== value) throw new Error(`Ожидается HTTPS origin в ${name}`);
  return url.origin;
}

export function auditPool() {
  const value = process.env.DATABASE_URL;
  if (!value || !new URL(value).pathname.endsWith('_test')) throw new Error('Нужна изолированная PostgreSQL *_test');
  return createPool(value);
}
export async function registerOwner(context: BrowserContext) {
  const credentials = { email: `ui-${randomUUID()}@example.test`, password: randomUUID() };
  const response = await context.request.post(testOrigin() + '/api/auth/register', { headers: { origin: testOrigin() }, data: {
    ...credentials, terms: { accepted: true, version: readTrustDocument('terms').version },
    consent: { accepted: true, version: readTrustDocument('consent').version },
  } });
  if (response.status() !== 200) throw new Error(`Регистрация тестового владельца: HTTP ${response.status()}`);
  return credentials;
}
export async function attachDraft(pool: Pool, context: BrowserContext, state: 'done' | 'failed' | 'running',
  launch?: { rootUrl: string; key: string; browserToken: string }) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('Нужен общий синтетический SESSION_SECRET изолированного стенда');
  const token = randomBytes(32).toString('base64url');
  const rootUrl = launch?.rootUrl ?? 'https://materials.example.test/';
  const company = `Мастерская ${randomUUID().slice(0,8)}`;
  const created = await createPreview(pool, loadCeilings(environment()), {
    browserSession: tokenHash(secret, 'browser', launch?.browserToken ?? randomUUID()), tokenHash: tokenHash(secret, 'preview', token),
    idempotencyKey: launch?.key ?? randomUUID(), rootUrl, publicKey: randomBytes(16).toString('base64url'), companyName: company,
    ipPrefix: `192.${randomBytes(1)[0]}.${randomBytes(1)[0]}.0/24`, budget: PREVIEW_JOB_BUDGET,
  });
  if (created.kind !== 'created') throw new Error('Квота тестовых данных исчерпана');
  const lease = await leaseIndexJob(pool, { generation: 0, index_job_id: created.indexJobId });
  if (!lease) throw new Error('Не удалось получить тестовое задание');
  if (state === 'failed') await failIndexJob(pool, lease, 'no_text');
  if (state === 'running') await recordProgress(pool, lease, { pagesDone: 7, pagesTotal: 20, chunksDone: 14 });
  if (state === 'done') {
    const price = 'Условия доставки: доставка стоит 350 ₽.';
    const id = (await pool.query<{ id: string }>(`INSERT INTO page (source_id,bot_id,url_or_page,title,content_hash)
      VALUES ($1,$2,$3,'Условия доставки',$4) RETURNING id`, [lease.sourceId, created.botId, rootUrl, createHash('sha256').update(price).digest('hex')])).rows[0]!.id;
    await pool.query(`INSERT INTO chunk (source_id,bot_id,page_id,ordinal,text,context_path,token_count,embedding)
      VALUES ($1,$2,$3,0,$4,'Мастерская › Условия доставки',10,$5::vector)`,
      [lease.sourceId, created.botId, id, price, '[' + [1,...Array(1535).fill(0)].join(',') + ']']);
    await recordProgress(pool, lease, { pagesDone: 1, pagesTotal: 1, chunksDone: 1 });
    await completeIndexJob(pool, lease);
  }
  await context.addCookies([{ name: '__Host-n6_preview', value: token, url: testOrigin(), secure: true, httpOnly: true, sameSite: 'Lax' }]);
  if (launch) await context.addCookies([{ name: '__Host-n6_browser', value: launch.browserToken, url: testOrigin(), secure: true, httpOnly: true, sameSite: 'Lax' }]);
  return { jobId: created.indexJobId, botId: created.botId, company };
}
export async function readVerified(pool: Pool, id: string) {
  const row = (await pool.query<{ answers_verified: boolean }>('SELECT answers_verified_at IS NOT NULL AS answers_verified FROM bot WHERE id=$1', [id])).rows[0];
  if (!row) throw new Error('Нет тестового бота');
  return row.answers_verified;
}
export async function fillSignup(page: Page) {
  await page.locator('[name=email]').fill(`ui-${randomUUID()}@example.test`);
  await page.locator('[name=password]').fill(randomUUID());
  const agreements = page.locator('#auth input[type=checkbox]');
  if (await agreements.count() !== 2) throw new Error('Ожидались отдельные подтверждения условий и согласия');
  await agreements.nth(0).check(); await agreements.nth(1).check();
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
}

// Реальный proof выпускает штатный handler, письмо принимает только callback в памяти теста.
export async function verificationLink(pool: Pool, context: BrowserContext) {
  const { AuthService } = await import('../../apps/web/src/server/auth');
  const { PgAuthStore } = await import('../../apps/web/src/server/auth-store');
  const { CustomerEmailProofStore } = await import('../../packages/db/src/customer-email-proof');
  const { createCustomerEmailActionHandler } = await import('../../apps/web/src/server/customer-email-actions');
  const origin = testOrigin();
  const secret = process.env.SESSION_SECRET;
  const session = (await context.cookies(origin)).find(c => c.name === '__Host-n6_session');
  if (!secret || !session) throw new Error('Не найдена сессия тестового владельца');
  let link: string | undefined;
  const send = createCustomerEmailActionHandler('send', {
    auth: new AuthService(new PgAuthStore(pool), secret), proofs: new CustomerEmailProofStore(pool),
    publicOrigin: origin, secret, allowMutation: async () => true, allowIssue: async () => true,
    mail: { settings: { mode: 'resend', from: 'qa@example.test', apiKey: 'local-fake' }, transport: { send: async message => {
      link = message.text.split(/\s+/).find(word => word.startsWith(origin + '/verify-email?'));
      return { status: 'accepted', providerId: 'local-ui-fixture' };
    } } },
  });
  const result = await send(new Request(origin + '/api/auth/email/send', {
    method: 'POST', headers: { origin, 'x-forwarded-for': '192.0.2.8', 'content-type': 'application/json', cookie: session.name + '=' + session.value },
    body: JSON.stringify({ next: '/dashboard?source=pdf' }),
  }));
  if (result.status !== 202 || !link) throw new Error('Оснастка не получила тестовое письмо');
  return link;
}

// Изолированная интерактивная проверка двух представлений. Запросов к API здесь нет.
export async function mountOwnerChat(page: Page, kind: 'cabinet' | 'preview') {
  const { build } = await import('esbuild');
  const result = await build({ bundle: true, write: false, jsx: 'automatic', format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"' }, stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client';
      import { useState } from 'react';
      import { OwnerChat } from './apps/web/src/app/dashboard/CabinetViews';
      import { PreviewChat } from './apps/web/src/app/preview/PreviewViews';
      function Chat() {
        const [draft,onDraft] = useState('');
        const [messages,setMessages] = useState([]);
        const onAsk = () => {
          const i = messages.filter(m => m.kind === 'answered').length + 1;
          const source = { title: 'Материал '+i, excerpt:'Фрагмент '+i, url:i===3?'data:text/plain,x':'https://example.test/'+i };
          setMessages([...messages,{kind:'question',text:draft},{kind:'answered',text:'Ответ '+i,source,firstAnswer:i===1}]);
          onDraft('');
        };
        const p = {draft,onDraft,messages,onAsk,busy:false,error:''};
        return ${kind === 'cabinet'
          ? '<OwnerChat {...p} companyName="Мастерская" ready />'
          : '<PreviewChat {...p} signedIn={false} saving={false} onSave={()=>{}} questionsLeft={5} site={{host:"example.test",title:"Условия",h1:"Доставка",suggestions:[]}} />'};
      }
      function Harness() {
        const [id,change] = useState(0);
        return <><Chat key={id}/><button onClick={()=>change(id+1)}>Другой бот</button></>;
      }
      const main=document.querySelector('main'); main.replaceChildren();
      createRoot(main).render(<Harness />);
    ` } });
  await page.addScriptTag({ content: result.outputFiles[0]!.text });
}
export async function selectPreviousAnswer(page: Page, id: string) {
  const { expect } = await import('vitest');
  const input = page.locator(id);
  for (let i = 1; i <= 3; i++) {
    await input.fill('Вопрос ' + i); await input.press('Enter');
    await page.getByText('Фрагмент ' + i, { exact: true }).waitFor();
    expect(await page.locator('.source-quote').count()).toBe(1);
    expect(await page.locator('.source-quote a').count()).toBe(i === 3 ? 0 : 1);
  }
  await input.fill('Черновик');
  const button = page.getByRole('button', { name: 'Источник · Материал 1' });
  await button.focus(); await button.press('Space');
  await page.getByText('Фрагмент 1', { exact: true }).waitFor();
  expect(await page.locator('.source-quote a').getAttribute('href')).toBe('https://example.test/1');
  expect(await input.inputValue()).toBe('Черновик');
  expect(await button.evaluate(el => document.activeElement === el)).toBe(true);
  expect(await page.locator('.chat-question').allTextContents()).toEqual(['Вопрос 1','Вопрос 2','Вопрос 3']);
}
