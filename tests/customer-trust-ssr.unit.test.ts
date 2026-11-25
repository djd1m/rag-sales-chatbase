import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup as html } from 'react-dom/server';
import type { ComponentProps } from 'react';

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push() {}, refresh() {} }), useSearchParams: () => new URLSearchParams(),
  redirect: (url: string) => { throw new Error('redirect:' + url); }, notFound: () => { throw new Error('not-found'); } }));
vi.mock('next/font/local', () => ({ default: (options: { variable: string }) => ({ variable: options.variable }) }));

import { PreviewStart } from '../apps/web/src/app/preview/PreviewStart';
import { PreviewScreen } from '../apps/web/src/app/preview/[jobId]/PreviewScreen';
import { PreviewProgress } from '../apps/web/src/app/preview/PreviewViews';
import { CabinetEmpty } from '../apps/web/src/app/dashboard/CabinetEmpty';
import { BotListScreen } from '../apps/web/src/app/dashboard/BotListScreen';
import { BotScreen } from '../apps/web/src/app/dashboard/bots/[botId]/BotScreen';
import { InstallScreen } from '../apps/web/src/app/dashboard/bots/[botId]/install/InstallScreen';
import { PreviewClaimNotice } from '../apps/web/src/app/dashboard/PreviewClaimNotice';
import { LogoutButton } from '../apps/web/src/app/dashboard/LogoutButton';
import { CustomerRecoveryForm } from '../apps/web/src/app/verify-email/CustomerRecoveryForm';
import { CustomerSupportPanel } from '../apps/web/src/app/support/CustomerSupportPanel';
import { UpgradeScreen } from '../apps/web/src/app/upgrade/UpgradeScreen';
import { ReturnScreen, ReturnView } from '../apps/web/src/app/upgrade/return/ReturnScreen';
import { AccountDeletionForm } from '../apps/web/src/app/dashboard/account/AccountScreen';
import { ErasureStatus } from '../apps/web/src/app/account/erased/ErasureStatus';
import { OwnerAnswerSource } from '../apps/web/src/app/OwnerAnswerSource';

const origin = 'https://ssr.sufler.invalid';
const id = 'c277ff38-86d6-47b8-be15-25a512008d2e';
const globals = globalThis as unknown as Record<string, unknown>;
let saved: unknown;
const outbound = vi.fn(async () => { throw new Error('SSR must not send requests'); });
beforeEach(() => {
  saved = globals.n6Runtime;
  globals.n6Runtime = { config: { publicOrigin: origin, sessionSecret: 'fixture-'.repeat(6) },
    mail: { settings: { mode: 'disabled' } }, support: { mode: 'disabled' },
    auth: { authenticate: async () => null }, pool: { query: async () => { throw new Error('Anonymous SSR must not query private data'); } } };
  vi.stubGlobal('fetch', outbound); outbound.mockClear();
});
afterEach(() => { if (saved === undefined) delete globals.n6Runtime; else globals.n6Runtime = saved; vi.unstubAllGlobals(); });

it('server-rendered preview and recovery surfaces do not disclose private state', () => {
  for (const signedIn of [false, true]) {
    const start = html(h(PreviewStart, { signedIn }));
    expect(start).toContain('Адрес вашего сайта'); expect(start).toContain('method="post"');
    expect(start).not.toContain('fixture-');
    const pdf = html(h(PreviewStart, { signedIn, intent: { mode: 'pdf' } }));
    expect(pdf).toContain(signedIn ? 'Выбрать бота' : 'Войти для загрузки PDF');
    expect(pdf).toContain(signedIn ? '/dashboard?source=pdf' : '/login?next=%2Fdashboard%3Fsource%3Dpdf');
    const screen = html(h(PreviewScreen, { jobId: id, signedIn }));
    expect(screen).toContain('Загружаем'); expect(screen).not.toContain(id);
  }
  for (const mode of ['verify-email', 'forgot', 'reset'] as const) {
    const form = html(h(CustomerRecoveryForm, { mode, authenticated: false, mailEnabled: false }));
    expect(form).toContain('Проверяем ссылку'); expect(form).not.toContain('token=');
  }
  expect(html(h(PreviewClaimNotice, { context: 'private-context-marker' }))).toBe('');
  expect(html(h(CustomerSupportPanel, { accountId: id }))).not.toContain(id);
  expect(outbound).not.toHaveBeenCalled();
});

it('server-rendered cabinet keeps PDF and missing bundle states distinct without optimistic installation', () => {
  const site = html(h(CabinetEmpty));
  const pdf = html(h<{ pdf?: boolean }>(CabinetEmpty, { pdf: true }));
  expect(site).toContain('Создать бота вручную'); expect(pdf).toContain('Создайте бота для PDF');
  expect(pdf).not.toContain('Адрес вашего сайта');
  const list = html(h(BotListScreen, { list: { plan: 'free', limit: 1, bots: [] }, pdf: true }));
  expect(list).toContain('Создать бота');
  const install = html(h(InstallScreen, { botId: id, companyName: '<script>unsafe</script>', origins: [],
    snippet: { kind: 'bundle_missing', directives: [] }, gate: { verified: false, ready: false, resetAt: null, stubVisitors: 0 } }));
  expect(install).toContain('Виджет ещё не собран'); expect(install).toContain('&lt;script&gt;');
  expect(install).not.toContain('<script>unsafe');
  expect(html(h(LogoutButton))).toContain('Выйти');
  expect(html(h(AccountDeletionForm))).toContain('Удалить'); expect(outbound).not.toHaveBeenCalled();
});

it('server-rendered source progress and citations distinguish failure from a ready answer', () => {
  const base = { index_job_id: id, pages_done: 0, pages_total: null, page_budget: 20, chunks_done: 0 };
  const pending = html(h(PreviewProgress, { host: 'example.invalid', view: { ...base, state: 'running' } }));
  const failed = html(h(PreviewProgress, { host: 'example.invalid', view: { ...base, state: 'failed', reason: 'no_text' } }));
  expect(pending).toContain('progressbar'); expect(failed).toContain('На сайте не нашлось текста');
  for (const url of ['javascript:alert(1)', 'https://user:secret@example.invalid']) {
    const quote = html(h(OwnerAnswerSource, { messages: [{ kind: 'answered', text: 'Ответ', source: { title: '<bad>', excerpt: 'Факт', url } }], onMissingContact: null }));
    expect(quote).toContain('Факт'); expect(quote).toContain('&lt;bad&gt;'); expect(quote).not.toContain('href=');
  }
  const bot: ComponentProps<typeof BotScreen> = { botId: id, companyName: 'Ромашка', contact: '', greeting: '', sources: [],
    answersVerified: false, verification: { verifiedAt: null, events: [] }, gate: { resetAt: null, stubVisitors: 0 },
    monthAnswers: { used: 0, limit: 300 }, summary: null, publicPage: { enabled: false, indexable: false, slug: null, url: null } };
  expect(html(h(BotScreen, bot))).toContain('Ромашка'); expect(outbound).not.toHaveBeenCalled();
});

it('server-rendered payment and erasure views preserve the actual state boundary', () => {
  const upgrade = html(h(UpgradeScreen, { plan: 'nobadge', title: 'Без бейджа', price: '990', offerVersion: '2026-11-25',
    paymentsOn: false, verified: false, current: { plan: 'free', plan_source: 'none', plan_paid_until: null } }));
  expect(upgrade).not.toContain('yookassa.ru');
  expect(html(h(ReturnScreen, { intentId: id }))).toContain('Ждём подтверждения');
  const review = html(h(ReturnView, { state: { kind: 'reconciliation_required' } }));
  expect(review).toContain('Повторно оплачивать её не нужно');
  const unknown = html(h(ErasureStatus, { state: null }));
  const erased = html(h(ErasureStatus, { state: { status: 'deleted', deadline: '2026-12-01T00:00:00Z', overdue: false } }));
  expect(unknown).toContain('нет квитанции'); expect(erased).toContain('Завершено локальное стирание'); expect(erased).toContain('могут сохраниться');
  expect(outbound).not.toHaveBeenCalled();
});

it('anonymous server pages preserve access controls and publish usable legal and recovery routes', async () => {
  const login = await import('../apps/web/src/app/login/page');
  const forgot = await import('../apps/web/src/app/forgot/page');
  const reset = await import('../apps/web/src/app/reset/page');
  const verify = await import('../apps/web/src/app/verify-email/page');
  const support = await import('../apps/web/src/app/support/page');
  const dashboard = await import('../apps/web/src/app/dashboard/page');
  const preview = await import('../apps/web/src/app/preview/page');
  const upgrade = await import('../apps/web/src/app/upgrade/page');
  const returned = await import('../apps/web/src/app/upgrade/return/page');
  // Next's package-root declarations augment ProcessEnv globally. Product types are checked by the app build;
  // load the framework metadata entry at runtime so unrelated worker test types keep their own environment.
  const layoutPath = '../apps/web/src/app/layout';
  const layout = await import(/* @vite-ignore */ layoutPath);
  const loginMarkup = html(await login.default({ searchParams: Promise.resolve({ mode: 'register', next: 'https://foreign.invalid' }) }));
  expect(loginMarkup).toContain('type="password"'); expect(loginMarkup).not.toContain('https://foreign.invalid');
  for (const element of [await forgot.default(), await reset.default(), await verify.default({ searchParams: Promise.resolve({ next: '/dashboard?source=pdf' }) })])
    expect(html(element)).toContain('Проверяем ссылку');
  expect(html(await support.default({ searchParams: Promise.resolve({}) }))).toContain('Чат поддержки пока не подключён');
  expect(html(await dashboard.default({ searchParams: Promise.resolve({ source: 'pdf' }) }))).toContain('/dashboard?source=pdf');
  expect(html(await preview.default({ searchParams: Promise.resolve({ source: 'pdf' }) }))).toContain('PDF');
  await expect(upgrade.default({ searchParams: Promise.resolve({ plan: 'nobadge' }) })).rejects.toThrow('redirect:/login?next=');
  await expect(upgrade.default({ searchParams: Promise.resolve({ plan: 'unsafe' }) })).rejects.toThrow('not-found');
  await expect(returned.default({ searchParams: Promise.resolve({ intent: id }) })).rejects.toThrow('redirect:/login');
  const legal = await Promise.all([import('../apps/web/src/app/legal/terms/page'), import('../apps/web/src/app/legal/consent/page'),
    import('../apps/web/src/app/legal/privacy/page'), import('../apps/web/src/app/legal/offer/page'), import('../apps/web/src/app/legal/cookies/page')]);
  for (const page of legal) expect(html(await page.default())).toContain('<h1');
  expect(html(await layout.default({ children: h('main', null, 'SSR child') }))).toContain('lang="ru"');
  expect(outbound).not.toHaveBeenCalled();
});


it('recovery headers prevent caching and referrer leaks while support keeps a fixed script boundary', async () => {
  const configPath = '../apps/web/next.config';
  const config = (await import(/* @vite-ignore */ configPath)).default as { headers(): Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
  const rules = await config.headers!();
  for (const source of ['/verify-email', '/reset']) {
    const rule = rules.find(item => item.source === source)!;
    expect(rule.headers).toEqual(expect.arrayContaining([
      { key: 'Cache-Control', value: 'no-store, max-age=0' }, { key: 'Referrer-Policy', value: 'no-referrer' },
    ]));
  }
  const csp = rules.find(item => item.source === '/support')!.headers.find(item => item.key === 'Content-Security-Policy')!.value;
  expect(csp).toContain("script-src 'self' 'unsafe-inline';"); expect(csp).toContain("frame-ancestors 'self'");
  expect(csp).not.toMatch(/script-src[^;]*https:/); expect(outbound).not.toHaveBeenCalled();
});

it('widget capability checks fail closed without a DOM and retain the bot disclosure', async () => {
  const { intro } = await import('../apps/widget/src/chat-window');
  const { adoptStyles } = await import('../apps/widget/src/styles');
  const config = { greeting: 'Здравствуйте' } as Parameters<typeof intro>[0];
  expect(intro(config)).toContain('Я бот, отвечаю по материалам сайта.');
  const root = { adoptedStyleSheets: [] } as unknown as ShadowRoot;
  expect(adoptStyles(root)).toBe(false); expect(root.adoptedStyleSheets).toEqual([]);
  expect(outbound).not.toHaveBeenCalled();
});

it('importing the worker does not start jobs or project web authentication credentials', async () => {
  vi.stubEnv('SESSION_SECRET', 'fixture-auth-credential-not-for-worker');
  vi.stubEnv('YOOKASSA_SECRET_KEY', 'fixture-payment-credential-not-for-worker');
  try {
    const environment = (await import('../apps/worker/src/environment')).readEnvironment();
    expect(environment).not.toHaveProperty('SESSION_SECRET'); expect(environment).not.toHaveProperty('YOOKASSA_SECRET_KEY');
    const worker = await import('../apps/worker/src/index');
    expect(worker.HEARTBEAT_INTERVAL_MS).toBeGreaterThan(1000);
    expect(outbound).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

it('disabled customer services allow preflight without provider credentials before the configured model probe', async () => {
  const models = { fixture: true }, probe = vi.fn(async () => {});
  vi.stubEnv('N6_PAYMENTS_MODE', 'off'); vi.stubEnv('N6_MAIL_MODE', 'disabled'); vi.stubEnv('N6_SUPPORT_MODE', 'disabled');
  vi.doMock('@n6/rag', async importOriginal => ({ ...(await importOriginal<object>()), loadWebConfig: () => ({ models, spendLog: 'fixture.ndjson' }) }));
  vi.doMock('../apps/web/src/answer-probe', () => ({ answerProbe: probe }));
  try {
    await import('../apps/web/src/preflight');
    await expect.poll(() => probe.mock.calls.length).toBe(1);
    expect(probe).toHaveBeenCalledWith(models, 'fixture.ndjson'); expect(outbound).not.toHaveBeenCalled();
  } finally { vi.doUnmock('@n6/rag'); vi.doUnmock('../apps/web/src/answer-probe'); vi.unstubAllEnvs(); }
});
