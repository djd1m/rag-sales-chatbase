import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePreviewIntent, readPreviewSiteInput, previewLaunchKey, rememberPreviewRetry, readPreviewRetry, retireFailedPreview } from '../apps/web/src/lib/preview-intent';
import { consumePreviewClaimNotice, storePreviewClaimNotice } from '../apps/web/src/lib/preview-claim-notice';

const job = '00000000-0000-4000-8000-000000000001';
const context = 'a'.repeat(43);
let entries: Map<string, string>;
beforeEach(() => {
  entries = new Map();
  vi.stubGlobal('sessionStorage', {
    get length() { return entries.size; },
    key: (i: number) => [...entries.keys()][i] ?? null,
    getItem: (k: string) => entries.get(k) ?? null,
    setItem: (k: string, v: string) => entries.set(k, v),
    removeItem: (k: string) => entries.delete(k),
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('ворота запуска и изоляция вкладки', () => {
  it('только одиночный legacy url запускает чтение', () => {
    expect(parsePreviewIntent({ url: 'example.test' })).toEqual({ mode: 'site', legacy: true });
    for (const q of [{ url: ['a','b'] }, { source: 'pdf', url: 'a' }, { retry: '', url: 'a' }, { source: ['site','pdf'], url: 'a' }])
      expect(parsePreviewIntent(q)).not.toMatchObject({ legacy: true });
  });
  it.each(['https://private@site.test', 'ftp://site.test', 'javascript:alert(1)', '//site.test', 'https://@site.test', 'https://a.test\\@b.test'])('отклоняет адрес до хранения', value => {
    expect(readPreviewSiteInput(value)).toBeNull();
  });
  it('безопасный повтор использует прежний UUID и удаляет остальные старые ключи', async () => {
    const input = readPreviewSiteInput('example.test')!;
    entries.set('n6_preview_key:example.test', job);
    entries.set('n6_preview_key:https://example.test/private', 'secret');
    expect(await previewLaunchKey(input)).toBe(job);
    expect(await previewLaunchKey(readPreviewSiteInput('https://example.test/')!)).toBe(job);
    expect(JSON.stringify([...entries])).not.toMatch(/example|secret|private/);
  });
  it('only a confirmed failure retires its accepted key, including for tabs opened before the update', async () => {
    const input = readPreviewSiteInput('https://example.test')!;
    const first = await previewLaunchKey(input);
    rememberPreviewRetry(job, input.origin, first);
    expect(await previewLaunchKey(input)).toBe(first);
    // Old v2 launch records lacked the accepted job ID.
    const slot = 'n6_preview_launch_v2';
    const old = JSON.parse(entries.get(slot)!);
    delete old[0].acceptedJob;
    entries.set(slot, JSON.stringify(old));
    await retireFailedPreview(job);
    const second = await previewLaunchKey(input);
    expect(second).not.toBe(first);
    expect(readPreviewRetry(job)).toBe(input.origin);
    await retireFailedPreview(job);
    expect(await previewLaunchKey(input)).toBe(second);
    const nextJob = crypto.randomUUID();
    rememberPreviewRetry(nextJob, input.origin, second);
    await retireFailedPreview(job);
    expect(await previewLaunchKey(input)).toBe(second);
    await retireFailedPreview(nextJob);
    expect(await previewLaunchKey(input)).not.toBe(second);
  });
  it('URL с маркерами не появляется в ключах, значениях и новых ссылках', async () => {
    for (const tail of ['/private', '/?private', '/#private', '/private/..','/?','#']) {
      const input = readPreviewSiteInput('https://example.test' + tail)!;
      expect(input.origin).toBeNull();
      await previewLaunchKey(input);
      rememberPreviewRetry(job, input.origin);
      expect(readPreviewRetry(job)).toBe('');
    }
    expect(JSON.stringify([...entries])).not.toMatch(/private|example/);
  });
  it('вкладка с opener получает собственное пустое состояние, последующие действия сохраняются', () => {
    rememberPreviewRetry(job, 'https://example.test');
    storePreviewClaimNotice('claimed', context);
    entries.set('n6_preview_key:https://example.test', job);
    entries.set('unrelated', 'keep');
    vi.stubGlobal('window', { opener: {} });
    expect(readPreviewRetry(job)).toBe('');
    expect(consumePreviewClaimNotice(context)).toBeNull();
    expect(entries.has('n6_preview_key:https://example.test')).toBe(false);
    expect(entries.get('unrelated')).toBe('keep');
    rememberPreviewRetry(job, 'https://own.test');
    expect(readPreviewRetry(job)).toBe('https://own.test');
  });
  it('retry выбирает ровно своё задание, очищает просроченные и вытесняет старые', () => {
    vi.useFakeTimers();
    for (let i=1; i<=9; i++) {
      vi.advanceTimersByTime(1);
      rememberPreviewRetry(job.slice(0,-1) + i, 'https://example.test');
    }
    expect(readPreviewRetry(job)).toBe('');
    expect(readPreviewRetry(job.slice(0,-1)+'9')).toBe('https://example.test');
    vi.advanceTimersByTime(86400000);
    expect(readPreviewRetry(job.slice(0,-1)+'9')).toBe('');
  });
});

describe('одноразовый исход claim', () => {
  it('требует известный исход, проверенный контекст и совпавшую свежую сессию', () => {
    expect(storePreviewClaimNotice('claimed', null)).toBe(false);
    expect(storePreviewClaimNotice('bogus', context)).toBe(false);
    expect(storePreviewClaimNotice('claimed', context)).toBe(true);
    expect(consumePreviewClaimNotice('b'.repeat(43))).toBeNull();
    expect(consumePreviewClaimNotice(context)).toBeNull();
    expect(storePreviewClaimNotice('expired', context)).toBe(true);
    expect(consumePreviewClaimNotice(context)).toBe('expired');
    expect(consumePreviewClaimNotice(context)).toBeNull();
    vi.useFakeTimers();
    storePreviewClaimNotice('claimed', context);
    vi.advanceTimersByTime(120000);
    expect(consumePreviewClaimNotice(context)).toBeNull();
  });
  it('отказ хранилища сохраняет возможность продолжить без ложного уведомления', () => {
    vi.stubGlobal('sessionStorage', { getItem() { throw Error(); }, setItem() { throw Error(); } });
    expect(storePreviewClaimNotice('claimed', context)).toBe(false);
    expect(consumePreviewClaimNotice(context)).toBeNull();
  });
});

const runtime = vi.hoisted(() => ({
  token: undefined as string | undefined,
  authenticate: vi.fn(async (_token: string): Promise<{ account_id: string } | null> => null),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => runtime.token ? { value: runtime.token } : undefined }) }));
vi.mock('../apps/web/src/server/runtime', () => ({ getRuntime: () => ({
  auth: { authenticate: runtime.authenticate }, config: { sessionSecret: 'synthetic-ui-test-secret' },
}) }));
it('кабинет получает контекст только проверенного токена и сохраняет прежнюю проекцию accountId', async () => {
  const { currentAccountId, currentCabinetSession } = await import('../apps/web/src/server/cabinet-session');
  const { previewClaimContext } = await import('../apps/web/src/server/preview-claim-context');
  runtime.token = 'invalid';
  expect(await currentCabinetSession()).toBeNull();
  expect(runtime.authenticate).not.toHaveBeenCalled();
  runtime.token = 'a'.repeat(43);
  expect(await currentCabinetSession()).toBeNull();
  runtime.authenticate.mockResolvedValue({ account_id: 'owner-A' });
  const expected = previewClaimContext('synthetic-ui-test-secret', runtime.token);
  expect(await currentCabinetSession()).toEqual({ accountId: 'owner-A', context: expected });
  expect(await currentAccountId()).toBe('owner-A');
  runtime.token = 'b'.repeat(43);
  expect((await currentCabinetSession())?.context).not.toBe(expected);
});

it('повторная и одновременная подготовка одного безопасного старта возвращает один UUID', async () => {
  const input = readPreviewSiteInput('https://example.test')!;
  const keys = await Promise.all([previewLaunchKey(input), previewLaunchKey(input)]);
  expect(keys[0]).toBe(keys[1]);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
  vi.useFakeTimers(); vi.advanceTimersByTime(86400001);
  expect(await previewLaunchKey(input)).not.toBe(keys[0]);
});
