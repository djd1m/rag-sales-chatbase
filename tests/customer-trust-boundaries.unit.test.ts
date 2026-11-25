import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

const origin = 'https://sufler.boundary.invalid';
const account = '27eaef61-72c0-4d6e-b54c-17fffcf02f89';
const cookie = 'A'.repeat(43);
const globals = globalThis as unknown as Record<string, unknown>;
let saved: Map<string, unknown>;
const calls: string[] = [];
const query = vi.fn(async (_sql: string, _args?: unknown[]) => { throw new Error('Unexpected persistence'); });
const outbound = vi.fn(async () => { throw new Error('Unexpected external request'); });
const redis = { status: 'ready', eval: vi.fn(async () => { calls.push('limit'); return 1; }) };
const authenticate = vi.fn(async (_token: string) => null as { account_id: string } | null);
const tokenHash = vi.fn((token: string) => createHash('sha256').update(token).digest('hex'));
let runtime: Record<string, unknown>;
function request(path: string, payload: unknown = {}, source = origin, authenticated = false) {
  return new Request(origin + path, { method: 'POST', headers: { origin: source,
    'x-forwarded-for': '198.51.100.7', 'content-type': 'application/json',
    ...(authenticated ? { cookie: '__Host-n6_session=' + cookie } : {}) }, body: JSON.stringify(payload) });
}
beforeEach(() => {
  saved = new Map(['n6Runtime', 'n6Billing'].map(key => [key, globals[key]]));
  calls.length = 0; vi.clearAllMocks();
  redis.eval.mockImplementation(async () => { calls.push('limit'); return 1; });
  authenticate.mockResolvedValue(null);
  query.mockRejectedValue(new Error('Unexpected persistence'));
  runtime = { config: { publicOrigin: origin, sessionSecret: 'fixture-'.repeat(6) },
    pool: { query }, redis, auth: { authenticate, tokenHash }, payments: null,
    mail: { settings: { mode: 'disabled' }, transport: { send: outbound } },
    support: { mode: 'disabled' } };
  globals.n6Runtime = runtime; delete globals.n6Billing;
  vi.stubGlobal('fetch', outbound); vi.stubEnv('N6_SUPPORT_MODE', 'disabled');
});
afterEach(() => {
  for (const [key, value] of saved) { if (value === undefined) delete globals[key]; else globals[key] = value; }
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

it('anonymous customer routes reject foreign origins before account or provider access', async () => {
  const routes = await Promise.all([
    import('../apps/web/src/app/api/auth/email/confirm/route'),
    import('../apps/web/src/app/api/auth/email/send/route'),
    import('../apps/web/src/app/api/auth/forgot/route'),
    import('../apps/web/src/app/api/auth/reset/route'),
    import('../apps/web/src/app/api/checkout/route'),
    import('../apps/web/src/app/api/support/session/route'),
  ]);
  for (const route of routes) {
    calls.length = 0;
    const response = await route.POST(request('/api/control', {}, 'https://foreign.invalid'));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'origin_not_allowed' } });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(calls).toEqual(['limit']);
  }
  expect(authenticate).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled(); expect(outbound).not.toHaveBeenCalled();
});

it('anonymous proof and checkout adapters refuse requests without issuing mail or payment', async () => {
  const confirm = await import('../apps/web/src/app/api/auth/email/confirm/route');
  const send = await import('../apps/web/src/app/api/auth/email/send/route');
  const forgot = await import('../apps/web/src/app/api/auth/forgot/route');
  const reset = await import('../apps/web/src/app/api/auth/reset/route');
  const checkout = await import('../apps/web/src/app/api/checkout/route');
  const status = await import('../apps/web/src/app/api/checkout/[intentId]/route');
  for (const [handler, expected] of [[confirm.POST, 401], [send.POST, 401], [forgot.POST, 422], [reset.POST, 422], [checkout.POST, 401]] as const) {
    const response = await handler(request('/api/control'));
    expect(response.status).toBe(expected);
    expect(await response.text()).not.toContain('fixture-');
  }
  const response = await status.GET(new Request(origin + '/api/checkout/' + account), { params: Promise.resolve({ intentId: account }) });
  expect(response.status).toBe(401); expect(query).not.toHaveBeenCalled(); expect(outbound).not.toHaveBeenCalled();
});

it('default support wiring binds authority to the current proof-store viewer and refuses foreign authority reads', async () => {
  const authority = await import('../apps/web/src/app/api/support/authority/route');
  const session = await import('../apps/web/src/app/api/support/session/route');
  runtime.support = { mode: 'libredesk', baseURL: 'https://support.clipmkr.ru', inboxID: account, jwtSecret: 'fixture-'.repeat(6) };
  query.mockImplementation(async (sql, args) => {
    expect(sql).toContain('FROM session s JOIN account a'); expect(args).toEqual([tokenHash(cookie)]);
    return { rows: [{ account_id: account, email: 'viewer@example.invalid', verified: true }], rowCount: 1 } as never;
  });
  const foreign = await authority.GET(new Request(origin + '/api/support/authority', { headers: { origin: 'https://foreign.invalid' } }));
  expect(foreign.status).toBe(403); expect(query).not.toHaveBeenCalled();
  const get = await authority.GET(new Request(origin + '/api/support/authority', { headers: { cookie: '__Host-n6_session=' + cookie } }));
  const data = (await get.json()).data;
  expect(get.status).toBe(200); expect(data.authority).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(JSON.stringify(data)).not.toContain('viewer@example.invalid');
  const signed = await session.POST(request('/api/support/session', { account_id: account }, origin, true));
  expect(signed.status).toBe(200); expect((await signed.json()).data.authority).toBe(data.authority);
  const invalid = await session.POST(request('/api/support/session', { account_id: 17 }, origin, true));
  expect(invalid.status).toBe(400); expect(outbound).not.toHaveBeenCalled();
});

it('disabled support SDK stays unavailable without fetching any vendor bytes', async () => {
  const sdk = await import('../apps/web/src/app/api/support/sdk/route');
  const result = await sdk.GET(new Request(origin + '/api/support/sdk'));
  expect(result.status).toBe(503); expect(await result.text()).toBe('');
  expect(result.headers.get('cache-control')).toBe('no-store'); expect(outbound).not.toHaveBeenCalled();
});

it('provider failure responses preserve the existing intent and never manufacture a successful payment', async () => {
  const { getBillingDependencies } = await import('../apps/web/src/server/billing-runtime');
  const { createCheckoutHandler } = await import('../apps/web/src/server/billing-handler');
  const { PaymentProviderUnavailable, PaymentVerificationError } = await import('../apps/web/src/server/payments/provider');
  const { readTrustDocument } = await import('../apps/web/src/lib/trust-legal-catalog');
  const fiscal = { vat_code: 1, payment_mode: 'full_payment' as const, payment_subject: 'service' };
  const intent = { id: account, plan: 'nobadge' as const, price_minor: 99000, status: 'created' as const,
    provider_payment_id: null, first_post_at: new Date(), checkout_snapshot: { serializedBody: '{}',
      email: 'buyer@example.invalid', shop: '900001', fiscal, description: 'План', publicOrigin: origin } };
  for (const [error, status, code] of [
    [new PaymentProviderUnavailable('timeout'), 503, 'payment_provider_unavailable'],
    [new PaymentProviderUnavailable('idempotency_window_elapsed'), 409, 'payment_reconciliation_required'],
    [new PaymentVerificationError('fixture-private-provider-detail'), 503, 'payment_provider_failed'],
    [new Error('fixture-private-internal-detail'), 503, 'unavailable'],
  ] as const) {
    const deps = getBillingDependencies();
    deps.log = () => {}; deps.authenticate = async () => ({ account_id: account });
    deps.provider = { name: 'fake', shop: '900001', fiscal,
      createPayment: async () => { throw error; }, getPayment: async () => { throw error; }, verifyNotification: async () => { throw error; } };
    deps.createIntent = async () => ({ kind: 'existing', intent }); deps.setIntentPayment = vi.fn(async () => true);
    const response = await createCheckoutHandler(deps)(request('/api/checkout', {
      plan: 'nobadge', idempotency_key: 'fixture-same-attempt', offer_version: readTrustDocument('offer').version,
    }, origin, true));
    const result = await response.json();
    expect([response.status, result.error.code]).toEqual([status, code]);
    if (code === 'payment_provider_unavailable' || code === 'payment_reconciliation_required') expect(result.error.intent_id).toBe(account);
    expect(JSON.stringify(result)).not.toContain('fixture-private');
    expect(deps.setIntentPayment).not.toHaveBeenCalled(); expect(intent.provider_payment_id).toBeNull();
  }
  expect(outbound).not.toHaveBeenCalled();
});

it('status reconciliation distinguishes a rejected provider object from temporary provider unavailability', async () => {
  const { getBillingDependencies } = await import('../apps/web/src/server/billing-runtime');
  const { createCheckoutStatusHandler } = await import('../apps/web/src/server/billing-handler');
  const { PaymentProviderUnavailable, PaymentVerificationError } = await import('../apps/web/src/server/payments/provider');
  for (const [error, expected] of [[new PaymentVerificationError('wrong order'), 'reconciliation_required'], [new PaymentProviderUnavailable('timeout'), 'pending']] as const) {
    const deps = getBillingDependencies(); deps.log = () => {};
    deps.authenticate = async () => ({ account_id: account });
    deps.readIntent = async () => ({ id: account, plan: 'nobadge', price_minor: 99000, status: 'created', provider_payment_id: account,
      shop: '900001', account_plan: 'free', plan_paid_until: null });
    deps.provider = { name: 'fake', shop: '900001', createPayment: async () => { throw error; }, getPayment: async () => { throw error; }, verifyNotification: async () => { throw error; } };
    const response = await createCheckoutStatusHandler(deps)(new Request(origin + '/api/checkout/' + account, { headers: { cookie: '__Host-n6_session=' + cookie } }), account);
    expect(response.status).toBe(200); expect((await response.json()).data).toMatchObject({ intent_id: account, status: expected, account_plan: 'free' });
  }
  expect(outbound).not.toHaveBeenCalled();
});
