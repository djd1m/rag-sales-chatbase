import { afterEach, expect, it, vi } from 'vitest';
import { createCustomerMailTransport, readCustomerMailSettings, renderAccountAccessMessage, renderPurchaseConfirmation } from '../packages/notifications/src/index';

const settings = readCustomerMailSettings({ N6_MAIL_MODE: 'resend', N6_MAIL_FROM: 'mail@example.test', N6_RESEND_API_KEY: 'fake-key' });
const message = renderAccountAccessMessage({ from: 'mail@example.test', to: 'owner@example.test', purpose: 'verify', link: 'https://sufler.test/verify-email#token=secret' });
afterEach(() => vi.useRealTimers());
it('mail transport bounds time and response bytes without exposing secrets', async () => {
  vi.useFakeTimers();
  const slow = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) =>
    init!.signal!.addEventListener('abort', () => reject(new Error(message.text)), { once: true })));
  const transport = createCustomerMailTransport(settings, { fetchImpl: slow });
  const pending = [transport.send(message), transport.send(message)];
  expect(await createCustomerMailTransport(settings, { fetchImpl: slow }).send(message)).toEqual({ status: 'retryable' });
  expect(slow).toHaveBeenCalledTimes(2);
  expect(slow.mock.calls[0]?.[0]).toBe('https://api.resend.com/emails');
  expect(slow.mock.calls[0]?.[1]?.redirect).toBe('error');
  await vi.advanceTimersByTimeAsync(5000);
  expect(await Promise.all(pending)).toEqual([{ status: 'unknown' }, { status: 'unknown' }]);
  const stalledBody = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([123])); } }));
  const pendingBody = createCustomerMailTransport(settings, { fetchImpl: async () => stalledBody }).send(message);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pendingBody).toEqual({ status: 'unknown' });
  for (const [res, status] of [
    [new Response('x'.repeat(16385)), 'unknown'], [new Response('{}'), 'unknown'],
    [new Response(null, { status: 429 }), 'retryable'], [new Response(null, { status: 422 }), 'permanent'],
    [new Response('{"id":"fake-123"}'), 'accepted'],
  ] as const) {
    const fake = vi.fn<typeof fetch>(async () => res);
    const result = await createCustomerMailTransport(settings, { fetchImpl: fake }).send(message, { idempotencyKey: 'fixture' });
    expect(result.status).toBe(status);
    expect(JSON.stringify(result)).not.toContain(message.to);
    expect(new Headers(fake.mock.calls[0]?.[1]?.headers).get('Idempotency-Key')).toBe('fixture');
  }
});
it('disabled mail performs no I/O and purchase rendering is deterministic', async () => {
  expect(() => readCustomerMailSettings({ N6_MAIL_MODE: '' })).toThrow();
  const fake = vi.fn<typeof fetch>();
  await createCustomerMailTransport(readCustomerMailSettings({}), { fetchImpl: fake }).send(message);
  expect(fake).not.toHaveBeenCalled();
  const input = { from: message.from, to: message.to, plan: 'studio' as const, amountMinor: 490000, paidUntil: '2026-12-25T10:00:00Z', publicOrigin: 'https://sufler.test' };
  const purchase = renderPurchaseConfirmation(input);
  expect(purchase).toEqual(renderPurchaseConfirmation(input));
  expect(purchase.text).toContain('https://sufler.test/dashboard');
  expect(purchase.text).toContain('Студия');
  expect(purchase.text).not.toContain('#token');
  expect(purchase.html).toContain('https://sufler.test/support');
  expect(message.html).not.toContain('<img');
  expect(message.html).toContain('Подтвердить почту');
  expect(() => renderAccountAccessMessage({ from: message.from, to: message.to, purpose: 'verify', link: 'javascript:alert(1)' })).toThrow();
  const escaped = renderAccountAccessMessage({ from: message.from, to: message.to, purpose: 'reset', link: 'https://sufler.test/reset?a=1&b=2#token=test' });
  expect(escaped.html).toContain('a=1&amp;b=2');
});

it('only a same-origin bounded request for the session address may create a verify link', async () => {
  const { createCustomerEmailActionHandler } = await import('../apps/web/src/server/customer-email-actions');
  const origin = 'https://sufler.test', session = 'S'.repeat(43);
  const auth = { tokenHash: () => 'digest', authenticate: async () => ({ account_id: 'owner' }) };
  const proofs = {
    viewer: vi.fn(async () => ({ account_id: 'owner', email: 'owner@example.test', verified: false })),
    prepare: vi.fn(async () => true), activate: vi.fn(async () => true), canReset: vi.fn(async () => false),
    confirm: vi.fn(async () => false), reset: vi.fn(async () => false)
  };
  const send = vi.fn(async () => ({ status: 'accepted' as const, providerId: 'fake' }));
  const deps = {
    auth, proofs, publicOrigin: origin, secret: 'test-secret', allowMutation: async () => true, allowIssue: async () => true,
    mail: { settings, transport: { send } }
  };
  const issue = createCustomerEmailActionHandler('send', deps);
  const request = (body: object, header: string | null = origin, cookie = true) => new Request(origin + '/api/auth/email/send', {
    method: 'POST', headers: {
      'content-type': 'application/json', 'x-forwarded-for': '192.0.2.1',
      ...(header ? { origin: header } : {}), ...(cookie ? { cookie: '__Host-n6_session=' + session } : {})
    }, body: JSON.stringify(body)
  });
  for (const [input, expected] of [
    [request({}, null), 403], [request({}, 'https://other.test'), 403], [request({}, origin, false), 401],
    [request({ email: 'someone@example.test' }), 422], [request({ extra: 'x'.repeat(4100) }), 413],
  ] as const) {
    const response = await issue(input);
    expect(response.status).toBe(expected);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(proofs.prepare).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  for (const next of ['/dashboard?source=pdf', '/upgrade?plan=studio', '/invite/' + 'i'.repeat(43), '//example.test', '/dashboard?source=pdf#extra']) {
    const captured: typeof message[] = [];
    const handler = createCustomerEmailActionHandler('send', {
      ...deps, mail: {
        settings, transport: {
          send: async m => { captured.push(m); return { status: 'accepted', providerId: 'fake' }; },
        }
      }
    });
    const response = await handler(request({ next }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ data: { status: 'accepted' } });
    expect(captured[0]!.to).toBe('owner@example.test');
    const link = new URL(captured[0]!.text.split('\n\n')[1]!);
    expect(link.origin + link.pathname).toBe(origin + '/verify-email');
    expect(link.searchParams.get('next')).toBe(['/dashboard?source=pdf', '/upgrade?plan=studio'].includes(next) ? next : null);
    expect(link.hash).toMatch(/^#token=[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(proofs.prepare.mock.calls)).not.toContain(link.hash.slice(7));
  }
});

it('the published edition identifies the exact document accepted by signup or checkout', async () => {
  const { readTrustDocument } = await import('../apps/web/src/lib/trust-legal-catalog');
  // An intentional revision adds a new edition. Old digests remain attributable.
  const edition = {
    terms: 'e6d614e251fb8ff9d3525a2172418524734232596d60c8303c119c5202905219',
    offer: '4342640704aea1d39b37bb25d8ecfad6f9a826abb507d8d9499202fb34f4feef',
    consent: 'd1d0c5c3a5667c05c9e8beffea173449c2f17c4cff58082403bab42e2cb5aeb7'
  };
  for (const kind of ['terms', 'offer', 'consent'] as const) {
    const doc = readTrustDocument(kind);
    expect([doc.version, doc.digest]).toEqual(['2026-11-25.1', edition[kind]]);
  }
});
