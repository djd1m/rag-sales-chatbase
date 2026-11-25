import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { loadWebConfig } from '@n6/rag';
import { environment } from './fixtures/environment';
import * as runtime from '../apps/web/src/server/runtime';
import { authRoute } from '../apps/web/src/server/route';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool, type Pool } from '../packages/db/src/index';
import { migrate } from '../packages/db/src/migrate';
import { CustomerEmailProofStore } from '../packages/db/src/customer-email-proof';
import { applyVerifiedPayment, openVerifiedPaymentIntent, readPaymentIntent } from '../packages/db/src/payments';
import { ensureTestDatabase } from '../scripts/test-db.mjs';
import { AuthService } from '../apps/web/src/server/auth';
import { PgAuthStore } from '../apps/web/src/server/auth-store';
import { createCustomerEmailActionHandler } from '../apps/web/src/server/customer-email-actions';
import { createAuthHandler } from '../apps/web/src/server/auth-handler';
import { readTrustDocument } from '../apps/web/src/lib/trust-legal-catalog';
import type { CustomerMailTransport } from '../packages/notifications/src/index';

const origin = 'https://sufler.test';
const secret = randomBytes(32).toString('hex');
const url = process.env.DATABASE_URL;

it.skipIf(!url)('upgrading populated 015 to 017 preserves sessions and billing history', async () => {
  if (!url) throw new Error('Требуется отдельная тестовая БД');
  await ensureTestDatabase(url);
  const schema = 'trust_upgrade_' + randomBytes(8).toString('hex');
  const migrations = fileURLToPath(new URL('../packages/db/migrations/', import.meta.url));
  const staged = await mkdtemp(join(tmpdir(), 'trust-upgrade-'));
  const pool = createPool(url, schema);
  try {
    await pool.query('CREATE SCHEMA ' + schema);
    const files = (await readdir(migrations)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
    const legacy = files.filter(name => name.slice(0, 3) <= '015');
    const upgrade = files.filter(name => ['016', '017'].includes(name.slice(0, 3)));
    expect(legacy.map(name => Number(name.slice(0, 3)))).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(upgrade.map(name => name.slice(0, 3))).toEqual(['016', '017']);
    const stage = (names: string[]) => Promise.all(names.map(name => copyFile(join(migrations, name), join(staged, name))));
    const ledger = async () => (await pool.query('SELECT * FROM _schema_migration ORDER BY name')).rows;
    await stage(legacy);
    await migrate(pool, staged);
    const oldLedger = await ledger();
    expect(oldLedger.map(row => row.name)).toEqual(legacy);

    const auth = new AuthService(new PgAuthStore(pool), secret);
    const session = randomBytes(32).toString('base64url'), sessionHash = auth.tokenHash(session);
    const email = 'historical-owner@example.test', accountId = randomUUID(), intentId = randomUUID(), providerId = randomUUID();
    await pool.query(`INSERT INTO account(id,email,password_hash,plan,plan_source,plan_paid_until)
      VALUES($1,$2,'fixture-hash','nobadge','payment',now()+interval '25 days')`, [accountId, email]);
    await pool.query(`INSERT INTO session(account_id,token_hash,ip_prefix,expires_at)
      VALUES($1,$2,'192.0.2.0/24',now()+interval '3 days')`, [accountId, sessionHash]);
    await pool.query(`INSERT INTO payment_intent(id,account_id,plan,price_minor,idempotency_key,provider_payment_id,status)
      VALUES($1,$2,'nobadge',99000,'historical-checkout',$3,'succeeded')`, [intentId, accountId, providerId]);
    await pool.query(`INSERT INTO payment(intent_id,account_id,provider,provider_payment_id,plan,amount_minor,fee_minor,status,needs_review,review_reason,paid_at)
      VALUES($1,$2,'yookassa',$3,'nobadge',99000,750,'refunded',true,'refund',now()-interval '5 days')`, [intentId, accountId, providerId]);
    const history = async () => (await pool.query(`SELECT to_jsonb(a) AS account, to_jsonb(s) AS session,
        to_jsonb(i) AS intent, to_jsonb(p) AS payment
      FROM account a JOIN session s ON s.account_id=a.id JOIN payment_intent i ON i.account_id=a.id
      JOIN payment p ON p.intent_id=i.id WHERE s.token_hash=$1 AND i.id=$2`, [sessionHash, intentId])).rows;
    const [before] = await history();
    expect(before).toBeDefined();
    expect(await auth.authenticate(session)).toEqual({ account_id: accountId });

    await stage(upgrade);
    await migrate(pool, staged);
    const newLedger = await ledger();
    expect(newLedger.slice(0, 15)).toEqual(oldLedger);
    expect(newLedger.slice(15).map(row => row.name)).toEqual(upgrade);
    expect(await history()).toEqual([{
      ...before,
      account: { ...before.account, email_verified_at: null },
      intent: { ...before.intent, offer_version: null, offer_digest: null, offer_accepted_at: null,
        checkout_snapshot: null, first_post_at: null, applied_paid_until: null },
    }]);
    expect(await auth.authenticate(session)).toEqual({ account_id: accountId });
    const proofs = new CustomerEmailProofStore(pool);
    expect(await proofs.viewer(sessionHash)).toEqual({ account_id: accountId, email, verified: false });
    expect(await readPaymentIntent(pool, intentId, accountId)).toMatchObject({
      id: intentId, plan: 'nobadge', price_minor: 99000, status: 'succeeded', provider_payment_id: providerId,
      account_plan: 'nobadge', shop: null,
    });

    const offer = readTrustDocument('offer'), shop = 'test:123';
    const input = {
      accountId, sessionHash, plan: 'nobadge' as const, idempotencyKey: randomUUID(), offerVersion: offer.version, offer, shop,
      fiscal: { vat_code: 1, payment_subject: 'service', payment_mode: 'full_payment' as const },
      publicOrigin: origin, description: 'Суфлёр, Без бейджа',
    };
    expect(await openVerifiedPaymentIntent(pool, input)).toEqual({ kind: 'email_verification_required' });
    const digest = randomBytes(32).toString('hex');
    expect(await proofs.prepare('verify', email, digest, sessionHash)).toBe(true);
    expect(await proofs.activate('verify', digest)).toBe(true);
    expect(await proofs.confirm(digest, sessionHash)).toBe(true);
    const opened = await openVerifiedPaymentIntent(pool, input);
    if (opened.kind !== 'created') throw new Error('Checkout after migration: ' + opened.kind);
    expect(opened.intent.checkout_snapshot).toMatchObject({ email, shop, fiscal: input.fiscal });
    const paymentId = randomUUID();
    expect(await applyVerifiedPayment(pool, {
      provider: 'yookassa', eventKey: 'payment_succeeded:' + paymentId, payloadSha256: 'e'.repeat(64),
      payment: { id: paymentId, orderId: opened.intent.id, shop, amountMinor: opened.intent.price_minor, feeMinor: 750, paidAt: new Date().toISOString() },
    })).toMatchObject({ applied: true, plan: 'nobadge' });
    expect((await pool.query('SELECT intent_id,recipient FROM purchase_mail_delivery')).rows)
      .toEqual([{ intent_id: opened.intent.id, recipient: email }]);
  } finally {
    try { await pool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
    finally { await pool.end(); await rm(staged, { recursive: true, force: true }); }
  }
}, 30_000);

describe.skipIf(!url)('customer trust • identity', () => {
  const schema = 'customer_proof_' + randomBytes(8).toString('hex');
  let pool: Pool, auth: AuthService, proofs: CustomerEmailProofStore;
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith('_test')) throw new Error('Требуется отдельная тестовая БД');
    await ensureTestDatabase(url);
    pool = createPool(url, schema);
    await pool.query('CREATE SCHEMA ' + schema);
    await migrate(pool);
    auth = new AuthService(new PgAuthStore(pool), secret);
    proofs = new CustomerEmailProofStore(pool);
  });
  afterAll(async () => { if (pool) { await pool.query('DROP SCHEMA ' + schema + ' CASCADE'); await pool.end(); } });
  const password = 'надежный-пароль';
  const ip = '192.0.2.0/24';
  const request = (action: string, body: object, session?: string) => new Request(origin + '/api/auth/' + action, {
    method: 'POST', headers: { origin, 'x-forwarded-for': '192.0.2.1', 'content-type': 'application/json', ...(session ? { cookie: '__Host-n6_session=' + session } : {}) },
    body: JSON.stringify(body),
  });
  function setup() {
    let token = '';
    const send = vi.fn<CustomerMailTransport['send']>(async message => {
      token = /#token=([A-Za-z0-9_-]{43})/.exec(message.text)![1]!;
      return { status: 'accepted', providerId: 'fake' };
    });
    const deps = {
      auth, proofs, publicOrigin: origin, secret, allowMutation: async () => true, allowIssue: async () => true,
      mail: { settings: { mode: 'resend' as const, from: 'fake@example.test', apiKey: 'fake' }, transport: { send } }
    };
    return {
      deps, send, token: () => token, run: (action: 'send' | 'confirm' | 'forgot' | 'reset', body: object, session?: string) =>
        createCustomerEmailActionHandler(action, deps)(request(action, body, session))
    };
  }
  it('email verification is current-address bound and consumed exactly once', async () => {
    const h = setup(), email = 'verify@example.test';
    const issuer = await auth.register(email, password, ip), second = (await auth.login(email, password, ip))!;
    expect((await h.run('send', {}, issuer)).status).toBe(202);
    const token = h.token();
    const rows = (await pool.query('SELECT * FROM customer_email_proof')).rows;
    expect(rows.some(row => row.email === email && row.active)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(token);
    for (const status of ['unknown', 'permanent'] as const) {
      h.send.mockResolvedValueOnce({ status });
      expect((await h.run('send', {}, issuer)).status).toBe(503);
    }
    expect((await h.run('confirm', { token })).status).toBe(401);
    const other = await auth.register('other@example.test', password, ip);
    expect((await h.run('confirm', { token }, other)).status).toBe(422);
    const offlineConfirm = createCustomerEmailActionHandler('confirm', {
      ...h.deps,
      mail: { settings: { mode: 'disabled' }, transport: h.deps.mail.transport }
    });
    const attempts = await Promise.all([offlineConfirm(request('confirm', { token }, issuer)), h.run('confirm', { token }, second)]);
    expect(attempts.map(r => r.status).sort()).toEqual([200, 422]);
    await pool.query('UPDATE account SET email=$2 WHERE email=$1', [email, 'changed@example.test']);
    expect((await pool.query('SELECT email_verified_at FROM account WHERE email=$1', ['changed@example.test'])).rows[0].email_verified_at).toBeNull();
    await h.run('send', {}, issuer);
    const revoked = h.token();
    await auth.logout(issuer);
    expect((await h.run('confirm', { token: revoked }, second)).status).toBe(422);
    await h.run('send', {}, second);
    await pool.query("UPDATE customer_email_proof SET expires_at=now()-interval '1 minute' WHERE email=$1", ['changed@example.test']);
    expect((await h.run('confirm', { token: h.token() }, second)).status).toBe(422);
    await h.run('send', {}, second);
    await pool.query('UPDATE account SET email=$2 WHERE email=$1', ['changed@example.test', email]);
    expect((await h.run('confirm', { token: h.token() }, second)).status).toBe(422);
  });
  it('forgot responses are indistinguishable and reset revokes every session atomically', async () => {
    const h = setup(), email = 'reset@example.test';
    const first = await auth.register(email, password, ip), second = (await auth.login(email, password, ip))!;
    await h.run('send', {}, first);
    const verify = h.token();
    let accept!: () => void, entered!: () => void, reset = '';
    const sending = new Promise<void>(resolve => { entered = resolve; });
    h.send.mockImplementationOnce(async m => {
      reset = /#token=([A-Za-z0-9_-]{43})/.exec(m.text)![1]!;
      entered();
      await new Promise<void>(resolve => { accept = resolve; });
      return { status: 'accepted', providerId: 'fake' };
    });
    const known = await h.run('forgot', { email });
    await sending;
    const unknown = await h.run('forgot', { email: 'missing@example.test' });
    expect([known.status, unknown.status]).toEqual([202, 202]);
    expect(await known.json()).toEqual(await unknown.json());
    expect(h.send).toHaveBeenCalledTimes(2);
    accept();
    await vi.waitFor(async () => expect((await pool.query("SELECT 1 FROM customer_email_proof WHERE purpose='reset' AND active AND email=$1", [email])).rowCount).toBe(1));
    // An uncertain second send leaves the first reset valid. The rejected candidate never authorizes.
    let failedToken = '';
    h.send.mockImplementationOnce(async m => {
      failedToken = /#token=([A-Za-z0-9_-]{43})/.exec(m.text)![1]!;
      return { status: 'unknown' };
    });
    expect((await h.run('forgot', { email })).status).toBe(202);
    const next = 'новый-пароль';
    expect(failedToken).toHaveLength(43);
    expect((await h.run('reset', { token: failedToken, password: next })).status).toBe(422);
    expect((await h.run('reset', { token: verify, password: next })).status).toBe(422);
    expect((await (await h.run('reset', { token: reset, password: 'я'.repeat(37) })).json()).error.code).toBe('invalid_password');
    const attempts = await Promise.all([h.run('reset', { token: reset, password: next }), h.run('reset', { token: reset, password: next })]);
    expect(attempts.map(r => r.status).sort()).toEqual([200, 422]);
    expect(await auth.authenticate(first)).toBeNull();
    expect(await auth.authenticate(second)).toBeNull();
    expect((await pool.query('SELECT 1 FROM customer_email_proof WHERE email=$1', [email])).rowCount).toBe(0);
    expect(await auth.login(email, password, ip)).toBeNull();
    expect(await auth.login(email, next, ip)).toBeTruthy();
  });
  it('late delivery cannot publish a candidate after revocation or an address change', async () => {
    const h = setup(), email = 'late@example.test';
    const session = await auth.register(email, password, ip);
    let entered!: () => void, accept!: () => void, token = '';
    const sending = new Promise<void>(resolve => { entered = resolve; });
    h.send.mockImplementationOnce(async m => {
      token = /#token=([A-Za-z0-9_-]{43})/.exec(m.text)![1]!;
      entered();
      await new Promise<void>(resolve => { accept = resolve; });
      return { status: 'accepted', providerId: 'fake' };
    });
    const pending = h.run('send', {}, session);
    await sending;
    await auth.logout(session);
    accept();
    expect((await pending).status).toBe(422);
    const second = (await auth.login(email, password, ip))!;
    expect((await h.run('confirm', { token }, second)).status).toBe(422);
    await h.run('forgot', { email });
    await vi.waitFor(async () => expect((await pool.query("SELECT 1 FROM customer_email_proof WHERE email=$1 AND purpose='reset' AND active", [email])).rowCount).toBe(1));
    const recovery = h.token();
    await pool.query('UPDATE account SET email=$2 WHERE email=$1', [email, 'renamed-late@example.test']);
    expect((await h.run('reset', { token: recovery, password: 'отклонённый-пароль' })).status).toBe(422);
    expect(await auth.authenticate(second)).toBeTruthy();
  });
  it.skipIf(!process.env.REDIS_URL)('sliding issue limits share the hour across sessions and conceal forgot cooldown', async () => {
    const redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    const { deps, send } = setup();
    const email = 'limit@example.test';
    const session = await auth.register(email, password, ip);
    const config = loadWebConfig({ ...environment(), SESSION_SECRET: secret, N6_PUBLIC_ORIGIN: origin });
    const mock = vi.spyOn(runtime, 'getRuntime').mockReturnValue({
      config, pool, redis, auth, mail: deps.mail, payments: null,
      support: { mode: 'disabled', contactEmail: null, privacyEmail: null }
    });
    const issue = authRoute('send'), forgot = authRoute('forgot');
    const mailKey = (scope: string, identity: string) => 'n6:mail:' + scope + ':' + createHmac('sha256', secret).update(scope + '\0' + identity).digest('hex');
    const cooldown = mailKey('cooldown', 'verify:' + email);
    try {
      await redis.connect();
      const race = await Promise.all([issue(request('email/send', {}, session)), issue(request('email/send', {}, session))]);
      expect(race.map(r => r.status).sort()).toEqual([202, 429]);
      expect(await redis.pttl(cooldown)).toBeGreaterThan(0);
      expect(await redis.pttl(cooldown)).toBeLessThanOrEqual(60000);
      for (let i = 1; i < 5; i++) {
        // Advance just this user's one-minute cooldown without moving the hourly window.
        await redis.del(cooldown);
        expect((await issue(request('email/send', {}, session))).status).toBe(202);
      }
      await redis.del(cooldown);
      const second = (await auth.login(email, password, ip))!;
      expect((await issue(request('email/send', {}, second))).status).toBe(429); // same recipient
      await pool.query('UPDATE account SET email=$2 WHERE email=$1', [email, 'renamed-limit@example.test']);
      expect((await issue(request('email/send', {}, session))).status).toBe(429); // same issuer
      const quiet = await forgot(request('forgot', { email }));
      const missing = await forgot(request('forgot', { email: 'absent-limit@example.test' }));
      expect([quiet.status, missing.status]).toEqual([202, 202]);
      expect(await quiet.json()).toEqual(await missing.json());
      expect(send).toHaveBeenCalledTimes(5);
      const ipKey = mailKey('ip', ip);
      const used = await redis.zcard(ipKey);
      for (let i = used; i < 30; i++) expect((await forgot(request('forgot', { email: 'missing-' + i + '@example.test' }))).status).toBe(202);
      // Expire only the ordinary one-minute gate. The hourly /24 still denies issue.
      await redis.del('n6:mutation:rate:' + createHmac('sha256', secret).update('anonymous:' + ip).digest('hex'));
      expect((await forgot(request('forgot', { email: 'missing-final@example.test' }))).status).toBe(429);
      expect(await redis.pttl(ipKey)).toBeGreaterThan(60000);
      expect(await redis.pttl(ipKey)).toBeLessThanOrEqual(3600000);
    } finally { mock.mockRestore(); redis.disconnect(); }
  });
  it('mail disabled and duplicate registration preserve login and never issue mail', async () => {
    const h = setup(), email = 'duplicate@example.test';
    const signup = createAuthHandler('register', { auth, publicOrigin: origin, allowMutation: async () => true });
    const payload = {
      email, password, terms: { accepted: true, version: readTrustDocument('terms').version },
      consent: { accepted: true, version: readTrustDocument('consent').version }
    };
    const first = await signup(request('register', payload)), repeat = await signup(request('register', payload));
    expect(await first.json()).toEqual(await repeat.json());
    const session = (r: Response) => r.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    expect((await h.run('send', {}, session(repeat))).status).toBe(401);
    expect(await auth.authenticate(session(first))).toBeTruthy();
    const off = { ...h.deps, mail: { settings: { mode: 'disabled' as const }, transport: h.deps.mail.transport } };
    for (const action of ['send', 'forgot'] as const) {
      const res = await createCustomerEmailActionHandler(action, off)(request(action, action === 'send' ? {} : { email }, session(first)));
      expect((await res.json()).error.code).toBe('mail_unavailable');
    }
    expect(h.send).not.toHaveBeenCalled();
    expect((await pool.query('SELECT 1 FROM customer_email_proof WHERE email=$1', [email])).rowCount).toBe(0);
    expect(await auth.login(email, password, ip)).toBeTruthy();
  });
});
